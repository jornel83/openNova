"""Official Beijing Ark HTTP adapter, with no POST retries or redirects.

Documented contracts checked 2026-11-18:
https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api
https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api
https://ark.volcengine.com/region:cn-beijing/docs/get-video-generation-task-api
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
from dataclasses import dataclass, field
import http.client
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import zlib
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from tools.image.schema import SEEDANCE_MODEL as VIDEO_MODEL, SEEDREAM_MODEL as IMAGE_MODEL
from .openai_provider import ConfigurationError, Credential, resolve_credential as _file_credential

API_BASE = "https://ark.cn-beijing.volces.com/api/v3"
TASKS_PATH = "/contents/generations/tasks"
IMAGE_GIF_KEY_FILE = Path.home() / ".config/opennova/ark-image-gif.key"
DEFAULT_KEY_FILE = Path.home() / ".config/opennova/ark.key"
FEATURES = ("seedream_edit", "seedance_video")
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = 48 * 1024 * 1024
CDN_HOSTS = frozenset({
    "ark-content-generation-cn-beijing.tos-cn-beijing.volces.com",
    "ark-acg-cn-beijing.tos-cn-beijing.volces.com",
})
# Official preset TOS origins for Seedream and the shared Seedream/Seedance bucket:
# https://docs.volcengine.com/docs/station-wide-acceleration/accelerate-large-model-generated-content-download
IMAGE_CDN_HOSTS = frozenset({
    "ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com",
    "ark-acg-cn-beijing.tos-cn-beijing.volces.com",
})


def _key_file_present(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        raise ConfigurationError("credential_file_unreadable") from None
    return True


def resolve_credential(*, repo_root: Path, key_file: str | Path | None = None,
                       environ: Mapping[str, str] | None = None) -> Credential | None:
    """Resolve the CLI override, then image/GIF configuration, then shared Ark settings."""
    env = os.environ if environ is None else environ
    if key_file:
        path, source = key_file, "explicit_key_file"
    elif env.get("OPENNOVA_IMAGE_ARK_KEY_FILE"):
        path, source = env["OPENNOVA_IMAGE_ARK_KEY_FILE"], "OPENNOVA_IMAGE_ARK_KEY_FILE"
    elif _key_file_present(IMAGE_GIF_KEY_FILE):
        path, source = IMAGE_GIF_KEY_FILE, "opennova_image_gif_ark_default"
    elif env.get("OPENNOVA_ARK_KEY_FILE"):
        path, source = env["OPENNOVA_ARK_KEY_FILE"], "OPENNOVA_ARK_KEY_FILE"
    elif key := env.get("ARK_API_KEY", "").strip():
        if any(char.isspace() for char in key):
            raise ConfigurationError("credential_must_be_one_nonempty_token")
        return Credential(key, "ARK_API_KEY")
    elif _key_file_present(DEFAULT_KEY_FILE):
        path, source = DEFAULT_KEY_FILE, "opennova_ark_default"
    else:
        return None
    # A detached skill version is outside the checkout. Keep the checkout as a
    # second forbidden key-file boundary; this value is supplied by the host.
    host_root = env.get('OPENNOVA_IMAGE_REPOSITORY_ROOT')
    credential = _file_credential(repo_root=repo_root, key_file=path, environ={},
                                  additional_roots=(Path(host_root),) if host_root else ())
    assert credential is not None
    return Credential(credential.secret, source)


class ProviderError(Exception):
    """A fixed public diagnostic; the raw body, URL, and credentials are omitted."""
    def __init__(self, reason: str, *, category="transient", status_code=None,
                 error_code=None, request_id=None, outcome_unknown=False, response_metadata=None):
        super().__init__(reason)
        self.reason = reason
        self.category = category
        self.status_code = status_code
        self.error_code = error_code
        self.request_id = request_id
        self.outcome_unknown = outcome_unknown
        self.response_metadata = response_metadata or {}


@dataclass
class APIResponse:
    body: dict[str, Any] = field(repr=False)
    request_id: str | None = None
    status_code: int | None = None


def request_id(headers: Any, secret: str = "") -> str | None:
    value = headers.get("x-request-id") or headers.get("x-tt-logid")
    if not isinstance(value, str) or (secret and secret in value):
        return None
    return value if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) else None


def _read_json_response(response, secret):
    identifier = request_id(response.headers, secret)
    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    encoding = response.headers.get("Content-Encoding", "identity").strip().lower()
    length = response.headers.get("Content-Length", "")
    declared = int(length) if re.fullmatch(r"[0-9]{1,12}", length) else None
    meta = {
        "contentType": content_type if content_type in (
            "application/json", "application/octet-stream", "text/html", "text/plain", "text/event-stream"
        ) else ("other" if content_type else "absent"),
        "contentEncoding": encoding if encoding in ("gzip", "identity", "deflate", "br") else "other",
        "declaredBytes": min(declared, MAX_JSON_BYTES + 1) if declared is not None else None,
        "receivedBytes": 0,
    }

    def invalid(reason):
        return ProviderError(reason, request_id=identifier, status_code=response.status,
                             outcome_unknown=True, response_metadata=meta)

    if declared is not None and declared > MAX_JSON_BYTES:
        raise invalid("ark_response_too_large")
    raw = bytearray()
    try:
        while len(raw) <= MAX_JSON_BYTES:
            chunk = response.read(min(128 * 1024, MAX_JSON_BYTES + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
            meta["receivedBytes"] = len(raw)
    except http.client.IncompleteRead as error:
        meta["receivedBytes"] = min(len(raw) + len(error.partial), MAX_JSON_BYTES + 1)
        raise invalid("ark_response_incomplete") from None
    except (OSError, http.client.HTTPException):
        raise invalid("ark_response_read_interrupted") from None
    if len(raw) > MAX_JSON_BYTES:
        raise invalid("ark_response_too_large")
    if declared is not None and len(raw) != declared:
        raise invalid("ark_response_incomplete")
    if encoding == "gzip" or (encoding == "identity" and raw.startswith(b"\x1f\x8b")):
        meta["compressionDetected"] = "gzip"
        inflater = zlib.decompressobj(zlib.MAX_WBITS | 16)
    elif encoding == "deflate":
        inflater = zlib.decompressobj()
    elif encoding in ("", "identity"):
        inflater = None
    else:
        raise invalid("ark_response_unknown_encoding")
    if inflater:
        try:
            raw = inflater.decompress(raw, MAX_JSON_BYTES + 1)
        except zlib.error:
            raise invalid("ark_response_invalid_compression") from None
        if len(raw) > MAX_JSON_BYTES or inflater.unconsumed_tail:
            raise invalid("ark_response_too_large")
        if not inflater.eof or inflater.unused_data:
            raise invalid("ark_response_invalid_compression")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeError):
        raise invalid("ark_response_invalid_json") from None
    if not isinstance(body, dict):
        raise invalid("ark_response_invalid_shape")
    return APIResponse(body, identifier, response.status)


def error_from_response(status: int, body: Any, *, identifier=None) -> ProviderError:
    details = body.get("error", {}) if isinstance(body, dict) else {}
    details = details if isinstance(details, dict) else {}
    code = details.get("code")
    code = code if isinstance(code, str) else ""
    lowered = code.lower()
    message = details.get("message", "")
    message = message.lower() if isinstance(message, str) else ""
    known_prefixes = ("Authentication", "InvalidApiKey", "Unauthorized", "AccessDenied", "PermissionDenied",
                      "ModelNotOpen", "ModelNotFound", "ResourceNotFound", "InsufficientBalance", "AccountOverdue",
                      "QuotaExceeded", "InsufficientQuota", "ContentPolicyViolation", "InputImageSensitiveContentDetected",
                      "OutputImageSensitiveContentDetected", "SensitiveContent", "UnsupportedFeature",
                      "UnsupportedOperation", "InvalidParameter", "RateLimit", "ServerError", "InternalError")
    safe_code = code if len(code) <= 100 and re.fullmatch(r"[A-Za-z0-9_.]+", code) and code.startswith(known_prefixes) else None
    if any(word in lowered for word in ("sensitive", "moderation", "contentpolicy")):
        category = "moderation"
    elif any(word in lowered for word in ("insufficientbalance", "accountoverdue", "quotaexceeded", "insufficientquota")):
        category = "quota"
    elif status in (401, 403, 404) or any(word in lowered for word in ("accessdenied", "permission", "modelnotopen", "authentication")) or any(word in message for word in ("not activated", "not enabled", "no access", "未开通")):
        category = "permission"
    elif code in {"UnsupportedFeature", "UnsupportedOperation"}:
        category = "unsupported"
    elif status in (408, 409, 429) or status >= 500:
        category = "transient"
    else:
        category = "invalid_request"
    return ProviderError("ark_request_rejected", category=category, status_code=status,
                         error_code=safe_code, request_id=identifier,
                         outcome_unknown=status in (408, 409) or status >= 500)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        return None


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """TLS uses the CDN hostname, while the TCP destination is already validated."""
    def __init__(self, host: str, address: str, timeout=120):
        super().__init__(host, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        self.sock = socket.create_connection((self.address, self.port), self.timeout, self.source_address)
        try:
            self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)
        except BaseException:
            self.sock.close()
            raise


def validate_download_url(url: Any, resolver=None, *, hosts=CDN_HOSTS) -> tuple[str, str, str]:
    """Allow only an exact public HTTPS product origin, with DNS pinning."""
    try:
        parsed = urlsplit(url) if isinstance(url, str) else None
        if (parsed is None or parsed.scheme != "https" or parsed.hostname not in hosts
                or parsed.username is not None or parsed.password is not None
                or parsed.port not in (None, 443) or parsed.fragment or any(ord(char) < 32 for char in url)):
            raise ValueError
        addresses = (resolver or socket.getaddrinfo)(parsed.hostname, 443, type=socket.SOCK_STREAM)
        public = []
        for entry in addresses:
            address = entry[4][0]
            ip = ipaddress.ip_address(address)
            if not ip.is_global or ip.is_multicast or ip.is_unspecified:
                raise ValueError
            public.append(str(ip))
        if not public:
            raise ValueError
    except socket.gaierror as error:
        if error.errno == socket.EAI_AGAIN:
            raise ProviderError("download_dns_interrupted", category="download") from None
        raise ProviderError("download_url_not_allowed", category="download") from None
    except (ValueError, TypeError, OSError):
        raise ProviderError("download_url_not_allowed", category="download") from None
    target = (parsed.path or "/") + (("?" + parsed.query) if parsed.query else "")
    return parsed.hostname, public[0], target


def unlink_owned(path: Path, identity):
    """Do not delete a file another actor replaced at our staging pathname."""
    if identity is None:
        return
    try:
        info = path.lstat()
        if stat.S_ISREG(info.st_mode) and (info.st_dev, info.st_ino) == identity:
            path.unlink()
    except FileNotFoundError:
        pass


class ArkClient:
    def __init__(self, credential: Credential, *, opener=None, resolver=None, connection_factory=None):
        self._credential = credential
        self._opener = opener or build_opener(_NoRedirect())
        self._resolver = resolver
        self._connection_factory = connection_factory or _PinnedHTTPSConnection

    def close(self):
        # Responses and CDN connections are individually closed by their owners.
        pass

    def _json(self, method: str, path: str, payload=None) -> APIResponse:
        allowed = (method == "POST" and path in {"/images/generations", TASKS_PATH}) or (
            method == "GET" and re.fullmatch(re.escape(TASKS_PATH) + r"/[A-Za-z0-9_-]{1,128}", path))
        if not allowed:
            raise ConfigurationError("ark_route_not_allowed")
        request = Request(API_BASE + path, method=method,
                          data=json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None,
                          headers={"Authorization": "Bearer " + self._credential.secret, "Content-Type": "application/json",
                                   "Accept": "application/json", "Accept-Encoding": "identity"})
        try:
            with self._opener.open(request, timeout=20 if method == "GET" else 120) as response:
                return _read_json_response(response, self._credential.secret)
        except HTTPError as error:
            try:
                body = json.loads(error.read(64 * 1024))
            except (ValueError, UnicodeError):
                body = {}
            finally:
                error.close()
            failure = error_from_response(error.code, body, identifier=request_id(error.headers, self._credential.secret))
            if failure.error_code and self._credential.secret in failure.error_code:
                failure.error_code = None
            raise failure from None
        except (URLError, TimeoutError, OSError, http.client.HTTPException):
            raise ProviderError("ark_transport_interrupted", outcome_unknown=True) from None

    def create_image(self, payload):
        return self._json("POST", "/images/generations", payload)

    def create_video(self, payload):
        return self._json("POST", TASKS_PATH, payload)

    def get_video(self, task_id):
        if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
            raise ConfigurationError("invalid_saved_task_id")
        return self._json("GET", TASKS_PATH + "/" + task_id)

    def download_video(self, url, destination: Path):
        identity = None
        try:
            with self._download(url, CDN_HOSTS, "video/mp4,application/octet-stream", MAX_DOWNLOAD_BYTES) as (response, length):
                fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                info = os.fstat(fd)
                identity = (info.st_dev, info.st_ino)
                with os.fdopen(fd, "wb") as output:
                    self._copy_download(response, length, output, MAX_DOWNLOAD_BYTES)
                    output.flush()
                    os.fsync(output.fileno())
            return identity
        except BaseException:
            unlink_owned(destination, identity)
            raise

    def download_image(self, url, *, max_bytes):
        """Retry a transient GET once while the signed URL is still in memory."""
        for attempt in range(2):
            try:
                with self._download(url, IMAGE_CDN_HOSTS, "image/png,application/octet-stream", max_bytes) as (response, length):
                    output = io.BytesIO()
                    self._copy_download(response, length, output, max_bytes)
                    return output.getvalue()
            except ProviderError as error:
                transient = (error.reason in {"download_incomplete", "download_dns_interrupted"}
                             or error.status_code in (408, 429, 500, 502, 503, 504))
                if not transient or attempt:
                    raise
            except (ssl.SSLError, UnicodeError, http.client.InvalidURL):
                raise ProviderError("download_connection_rejected", category="download") from None
            except (OSError, http.client.HTTPException):
                if attempt:
                    raise ProviderError("download_transport_interrupted", category="download") from None

    @contextmanager
    def _download(self, url, hosts, accept, max_bytes):
        host, address, target = validate_download_url(url, self._resolver, hosts=hosts)
        connection = self._connection_factory(host, address, timeout=120)
        try:
            # No Authorization, cookie, API key, redirect following, or proxy.
            connection.request("GET", target, headers={"Accept": accept})
            response = connection.getresponse()
            if 300 <= response.status < 400:
                raise ProviderError("download_redirect_rejected", category="download")
            if response.status != 200:
                raise ProviderError("download_http_error", category="download", status_code=response.status)
            length = response.getheader("Content-Length")
            if length is not None:
                if not re.fullmatch(r"[0-9]{1,12}", length) or not 0 < int(length) <= max_bytes:
                    raise ProviderError("download_size_not_allowed", category="download")
                length = int(length)
            yield response, length
        finally:
            connection.close()

    @staticmethod
    def _copy_download(response, length, output, limit):
        total = 0
        while True:
            chunk = response.read(min(1024 * 1024, limit - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ProviderError("download_size_not_allowed", category="download")
            output.write(chunk)
        if not total or (length is not None and total != length):
            raise ProviderError("download_incomplete", category="download")


def fixture_requests(image: bytes, *, image_model=IMAGE_MODEL, video_model=VIDEO_MODEL):
    if image_model != IMAGE_MODEL or video_model != VIDEO_MODEL:
        raise ConfigurationError("model_not_in_reviewed_m0_contract")
    data_url = "data:image/png;base64," + base64.b64encode(image).decode("ascii")
    return {
        "seedream_edit": {"model": image_model, "prompt": "将蓝色圆形改为橙色，保持白色背景、圆形形状和居中构图。",
                          "image": data_url, "size": "1024x1024", "output_format": "png",
                          "response_format": "b64_json", "background": "opaque", "watermark": True},
        "seedance_video": {"model": video_model, "content": [
            {"type": "text", "text": "固定镜头。蓝色圆形轻轻左右移动后回到原位，保持白色背景和圆形形状，形成平滑循环动作。"},
            {"type": "image_url", "image_url": {"url": data_url}, "role": "first_frame"}],
            "duration": 4, "resolution": "480p", "ratio": "adaptive", "generate_audio": False,
            "output_format": "mp4", "watermark": True},
    }
