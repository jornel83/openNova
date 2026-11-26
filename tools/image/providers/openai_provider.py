"""One-request OpenAI adapter. Importing this module never contacts a service.

Only API keys are accepted; Codex/ChatGPT subscription credentials are not read.
The caller owns the durable budget reservation and must reserve before ``send``.
"""

from __future__ import annotations

import hashlib
import inspect
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

OFFICIAL_BASE_URL = "https://api.openai.com/v1"
FEATURES = ("static_edit", "native_gif")
GIF_EXTRA_FIELDS = frozenset({"output_format", "frame_count", "frame_duration_ms"})


class ConfigurationError(ValueError):
    """A safe, fixed diagnostic that never includes credential material."""


@dataclass(frozen=True)
class Credential:
    secret: str = field(repr=False)
    source: str

    @property
    def scope(self) -> str:
        # This identifies a credential, not an independently verified account ID.
        return "key-sha256:" + hashlib.sha256(self.secret.encode()).hexdigest()[:24]


def resolve_credential(
    *, repo_root: Path, key_file: str | Path | None = None,
    environ: Mapping[str, str] | None = None,
    additional_roots: tuple[Path, ...] = (),
) -> Credential | None:
    """Resolve only explicitly configured sources, with no discovery or fallback.

    Precedence: explicit file, OPENNOVA_OPENAI_KEY_FILE, OPENAI_API_KEY.
    Key files must be outside the repository, non-symlink, owned by this user,
    regular, and inaccessible to group/others. Their path is never reported.
    """
    env = os.environ if environ is None else environ
    configured_file = key_file or env.get("OPENNOVA_OPENAI_KEY_FILE")
    if configured_file:
        source = "explicit_key_file" if key_file else "OPENNOVA_OPENAI_KEY_FILE"
        path = Path(configured_file).expanduser()
        try:
            resolved = path.resolve(strict=True)
            roots = (Path(root).resolve() for root in (repo_root, *additional_roots))
            if any(resolved == root or root in resolved.parents for root in roots):
                raise ConfigurationError("credential_file_must_be_outside_repository")
            if path.is_symlink():
                raise ConfigurationError("credential_file_must_not_be_symlink")
            if not stat.S_ISREG(path.stat().st_mode):
                raise ConfigurationError("credential_file_must_be_regular")
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ConfigurationError("credential_file_must_be_regular")
                if info.st_mode & 0o077 or info.st_uid != os.getuid():
                    raise ConfigurationError("credential_file_must_be_private_and_owned")
                raw = stream.read(16_385)
                if len(raw) > 16_384:
                    raise ConfigurationError("credential_file_too_large")
            secret = raw.decode("utf-8").strip()
        except ConfigurationError:
            raise
        except (OSError, UnicodeError, ValueError):
            raise ConfigurationError("credential_file_unreadable") from None
    else:
        secret = env.get("OPENAI_API_KEY", "").strip()
        source = "OPENAI_API_KEY"
        if not secret:
            return None
    if not secret or any(char.isspace() for char in secret):
        raise ConfigurationError("credential_must_be_one_nonempty_token")
    return Credential(secret, source)


def create_client(credential: Credential, client_factory: Callable[..., Any] | None = None) -> Any:
    """Disable SDK retries and pin the official endpoint, including for tests."""
    options = {
        "api_key": credential.secret,
        "base_url": OFFICIAL_BASE_URL,
        "max_retries": 0,
        "timeout": 120.0,
    }
    if client_factory is not None:
        return client_factory(**options)
    try:
        from openai import DefaultHttpxClient, OpenAI
    except ImportError:
        raise ConfigurationError("openai_sdk_not_installed") from None
    # Do not allow a redirected endpoint to receive the request or credential.
    return OpenAI(**options, http_client=DefaultHttpxClient(follow_redirects=False))


def build_edit_request(edit: Callable[..., Any], *, model: str, feature: str, image: bytes) -> dict[str, Any]:
    """Build a fixed small probe; only documented GIF fields may use extra_body.

    Typed SDK kwargs are preferred. No TypeError retry or alternative route is
    attempted: signature compatibility is determined before budget reservation.
    """
    if feature not in FEATURES:
        raise ConfigurationError("unknown_probe_feature")
    if not re.fullmatch(r"gpt-image-[a-z0-9][a-z0-9._-]{0,79}", model):
        raise ConfigurationError("explicit_gpt_image_model_required")
    gif = feature == "native_gif"
    request: dict[str, Any] = {
        "image": ("probe-input.png", image, "image/png"),
        "model": model,
        "prompt": (
            "Animate this simple blue circle moving slightly left and right on the "
            "white background. Keep its shape and color. Keep the camera fixed. "
            "Return to the starting position in a smooth loop."
            if gif else
            "Change only the blue circle to orange. Keep the white background, "
            "circle shape, and composition unchanged."
        ),
        "n": 1,
        "size": "512x512" if gif else "1024x1024",
        "quality": "low",
        "output_format": "gif" if gif else "png",
    }
    if gif:
        request.update(frame_count=2, frame_duration_ms=200)
    parameters = inspect.signature(edit).parameters
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in parameters.values()):
        return request
    extra: dict[str, Any] = {}
    for name in tuple(request):
        if name not in parameters:
            if name not in GIF_EXTRA_FIELDS or "extra_body" not in parameters:
                raise ConfigurationError("installed_sdk_cannot_encode_probe")
            extra[name] = request.pop(name)
    if extra:
        request["extra_body"] = extra
    return request


def safe_request_id(value: Any) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"req_[A-Za-z0-9_-]{1,120}", value) else None


def classify_error(error: Exception) -> dict[str, Any]:
    """Classify response evidence conservatively; never serialize an exception.

    A missing model may mean no project access. A generic 400/404, moderation,
    quota failure, or connectivity problem is never evidence of unsupported GIF.
    """
    body = getattr(error, "body", None)
    body = body if isinstance(body, dict) else {}
    details = body.get("error", body)
    details = details if isinstance(details, dict) else {}
    code = getattr(error, "code", None) or details.get("code")
    param = getattr(error, "param", None) or details.get("param")
    code = code if isinstance(code, str) else None
    param = param if isinstance(param, str) else None
    status = getattr(error, "status_code", None)
    status = status if isinstance(status, int) and not isinstance(status, bool) else None
    message = details.get("message", "")
    message = message.lower() if isinstance(message, str) else ""
    known_codes = {
        "moderation_blocked", "content_policy_violation", "safety_violations",
        "insufficient_quota", "billing_hard_limit_reached", "billing_not_active",
        "invalid_api_key", "permission_denied", "access_denied", "model_not_found",
        "feature_not_enabled", "preview_access_required", "organization_verification_required",
        "unsupported_feature", "unsupported_output_format", "gif_not_supported",
        "unsupported_parameter", "unsupported_value", "rate_limit_exceeded",
        "invalid_request_error", "server_error",
    }
    safe_code = code if isinstance(code, str) and code in known_codes else None
    if code in {"moderation_blocked", "content_policy_violation", "safety_violations"}:
        category = "moderation"
    elif code in {"insufficient_quota", "billing_hard_limit_reached", "billing_not_active"}:
        category = "quota"
    elif status in (401, 403, 404) or code in {
        "invalid_api_key", "permission_denied", "access_denied", "model_not_found",
        "feature_not_enabled", "preview_access_required", "organization_verification_required",
    } or any(term in message for term in ("do not have access", "not enabled", "preview access", "must be verified")):
        category = "permission"
    elif code in {"unsupported_feature", "unsupported_output_format", "gif_not_supported"} or (
        code in {"unsupported_parameter", "unsupported_value"} and param in GIF_EXTRA_FIELDS
    ):
        category = "unsupported"
    elif status is None or status in (408, 409, 429) or status >= 500:
        category = "transient"
    else:
        category = "invalid_request"
    return {
        "category": category,
        "capability": "unsupported" if category == "unsupported" else "unverified",
        "status": "unknown" if status is None or status in (408, 409) or status >= 500 else "failed",
        "http_status": status,
        "error_code": safe_code,
        "request_id": safe_request_id(getattr(error, "request_id", None)),
    }
