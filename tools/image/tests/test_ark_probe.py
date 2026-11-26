"""Offline Ark contracts: fake API/CDN traffic, no real key or generation calls."""
import base64
import hashlib
import io
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from PIL import Image

from tools.image import ark_probe
from tools.image.providers import ark_provider as provider

KEY = "ark-offline-fake-secret"
ENV = {"ARK_API_KEY": KEY}
CDN = "ark-content-generation-cn-beijing.tos-cn-beijing.volces.com"
URL = "https://" + CDN + "/video.mp4?signature=never-store-this-signature"


def image_response():
    stream = io.BytesIO()
    Image.new("RGB", (1024, 1024), "orange").save(stream, "PNG")
    return provider.APIResponse({"data": [{"b64_json": base64.b64encode(stream.getvalue()).decode()}]}, "request_image", 200)


def video_metadata(path):
    data = path.read_bytes()
    return {"format": "mp4", "duration_seconds": 4, "width": 640, "height": 640, "frame_count": 96,
            "fps": 24, "byte_count": len(data), "sha256": hashlib.sha256(data).hexdigest(), "fully_decoded": True}


class FakeArk:
    def __init__(self):
        self.posts, self.gets, self.downloads = [], [], []
        self.closed = 0
        self.image_callback = None
        self.video_callback = None
        self.poll_error = None
        self.download_error = None
        self.state = "succeeded"
        self.error = None

    def create_image(self, payload):
        self.posts.append(("image", payload))
        return self.image_callback(payload) if self.image_callback else image_response()

    def create_video(self, payload):
        self.posts.append(("video", payload))
        return self.video_callback(payload) if self.video_callback else provider.APIResponse({"id": "cgt_offline"}, "request_video", 200)

    def get_video(self, task_id):
        self.gets.append(task_id)
        if self.poll_error:
            raise self.poll_error
        return provider.APIResponse({"id": task_id, "status": self.state, "content": {"video_url": URL},
                                     "error": self.error, "usage": {"completion_tokens": 123, "total_tokens": 123}}, "request_status", 200)

    def download_video(self, url, destination):
        self.downloads.append(url)
        if self.download_error:
            raise self.download_error
        with destination.open("xb") as stream:
            stream.write(b"offline-video-fixture")
        info = destination.stat()
        return info.st_dev, info.st_ino

    def close(self):
        self.closed += 1


class ArkProbeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.session = self.root / "session"
        self.client = FakeArk()
        self.enterContext(patch.multiple(provider, IMAGE_GIF_KEY_FILE=self.root / "image-gif.key",
                                         DEFAULT_KEY_FILE=self.root / "host.key"))
        for target in ("socket.create_connection", "socket.getaddrinfo", "socket.socket.connect"):
            guard = patch(target, side_effect=AssertionError("network forbidden"))
            guard.start()
            self.addCleanup(guard.stop)

    def run_probe(self, **kwargs):
        options = dict(session_dir=self.session, repo_root=self.repo, environ=ENV, live=True,
                       client_factory=lambda credential: self.client, video_validator=video_metadata)
        options.update(kwargs)
        return ark_probe.run_probe(**options)

    def test_offline_and_missing_credentials_do_not_request_or_claim_support(self):
        result = self.run_probe(live=False)
        self.assertEqual(result["live_requests_sent"], 0)
        self.assertFalse(self.client.posts)
        self.assertFalse(self.session.exists())
        result = self.run_probe(environ={})
        self.assertEqual(result["stop_reason"], "credentials_missing")
        self.assertEqual(result["capabilities"]["seedream_edit"], "unverified")
        self.assertFalse(result["native_gif_documented"])
        self.assertNotIn(KEY, json.dumps(result))

    def test_reserves_before_each_post_and_uses_reviewed_parameters(self):
        def image_callback(payload):
            record = json.loads((self.session / "operations/seedream_edit.json").read_text())
            self.assertEqual(record["status"], "unknown")
            self.assertIsNone(record["usage"])
            return image_response()
        def video_callback(payload):
            record = json.loads((self.session / "operations/seedance_video.json").read_text())
            self.assertEqual(record["status"], "unknown")
            return provider.APIResponse({"id": "cgt_offline"}, "request_video", 200)
        self.client.image_callback, self.client.video_callback = image_callback, video_callback
        result = self.run_probe()
        self.assertEqual(result["budget_used"], 2)
        self.assertEqual(result["live_requests_sent"], 2)
        self.assertEqual(len(self.client.posts), 2)
        image, video = self.client.posts[0][1], self.client.posts[1][1]
        self.assertEqual(image["size"], "1024x1024")
        self.assertEqual(image["response_format"], "b64_json")
        self.assertNotIn("sequential_image_generation", image)
        self.assertNotIn("n", image)
        self.assertEqual((video["duration"], video["resolution"], video["ratio"]), (4, "480p", "adaptive"))
        self.assertFalse(video["generate_audio"])
        self.assertEqual(video["content"][1]["role"], "first_frame")
        self.assertEqual(result["operations"][1]["task_id"], "cgt_offline")
        self.assertEqual(result["operations"][1]["status"], "pending")
        self.assertFalse(self.client.gets)
        self.assertEqual(self.client.closed, 1)

    def test_poll_resumes_same_task_and_never_submits(self):
        self.run_probe()
        pending = self.run_probe()
        self.assertEqual(pending["live_requests_sent"], 0)
        result = self.run_probe(poll=True)
        self.assertEqual(len(self.client.posts), 2)
        self.assertEqual(self.client.gets, ["cgt_offline"])
        self.assertEqual(result["status_requests_this_run"], 1)
        self.assertEqual(result["downloads_this_run"], 1)
        self.assertEqual(result["capabilities"]["seedance_video"], "supported")
        self.assertEqual(result["capabilities"]["video_to_gif"], "unverified")
        self.assertEqual(result["operations"][1]["usage"]["total_tokens"], 123)
        serialized = json.dumps(result) + "".join(path.read_text() for path in (self.session / "operations").glob("*.json"))
        for secret in (KEY, URL, "never-store-this-signature", "data:image/png;base64,"):
            self.assertNotIn(secret, serialized)
        again = self.run_probe(poll=True)
        self.assertEqual(again["status_requests_this_run"], 0)
        self.assertEqual(len(self.client.posts), 2)

    def test_poll_with_no_task_never_creates_one(self):
        result = self.run_probe(poll=True)
        self.assertEqual(result["stop_reason"], "no_saved_session_to_poll")
        self.assertFalse(self.client.posts)

    def test_get_timeout_remains_resumable_without_post(self):
        self.run_probe()
        self.client.poll_error = provider.ProviderError("ark_transport_interrupted", outcome_unknown=True)
        result = self.run_probe(poll=True)
        self.assertEqual(result["operations"][1]["status"], "pending")
        self.assertEqual(result["operations"][1]["task_id"], "cgt_offline")
        self.client.poll_error = None
        self.assertEqual(self.run_probe(poll=True)["capabilities"]["seedance_video"], "supported")
        self.assertEqual(len(self.client.posts), 2)
        self.assertEqual(self.client.gets, ["cgt_offline", "cgt_offline"])

    def test_download_failure_can_resume_without_leaking_signed_url(self):
        self.run_probe()
        self.client.download_error = ValueError(URL + KEY)
        failed = self.run_probe(poll=True)
        self.assertEqual(failed["operations"][1]["status"], "pending_download")
        self.assertNotIn(URL, json.dumps(failed))
        self.assertNotIn(KEY, json.dumps(failed))
        self.client.download_error = None
        result = self.run_probe(poll=True)
        self.assertEqual(result["capabilities"]["seedance_video"], "supported")
        self.assertEqual(len(self.client.posts), 2)

    def test_unknown_post_or_keyboard_interrupt_never_repeats(self):
        for failure in (TimeoutError(KEY), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory(dir=self.root) as session:
                def callback(payload):
                    raise failure
                self.client.image_callback = callback
                before = len(self.client.posts)
                if isinstance(failure, KeyboardInterrupt):
                    with self.assertRaises(KeyboardInterrupt):
                        self.run_probe(session_dir=session)
                else:
                    self.run_probe(session_dir=session)
                result = self.run_probe(session_dir=session)
                self.assertEqual(len(self.client.posts), before + 1)
                self.assertEqual(result["operations"][0]["status"], "unknown")
                self.assertEqual(result["budget_used"], 1)
                self.assertNotIn(KEY, json.dumps(result))

    def test_failed_post_stops_next_feature_and_cannot_raise_budget(self):
        self.client.image_callback = lambda payload: (_ for _ in ()).throw(provider.ProviderError("ark_request_rejected", category="permission", status_code=403))
        result = self.run_probe(max_requests=1)
        self.assertEqual(result["capabilities"]["seedream_edit"], "unverified")
        self.assertEqual(result["operations"][0]["category"], "permission")
        self.assertEqual(self.run_probe(max_requests=1)["live_requests_sent"], 0)
        self.assertEqual(self.run_probe(max_requests=2)["stop_reason"], "session_identity_or_budget_mismatch")
        self.assertEqual(len(self.client.posts), 1)

    def test_network_receipt_covers_rejected_post_and_one_status_get(self):
        rejection = provider.error_from_response(404, {"error": {"code": "ModelNotOpen"}})
        self.client.image_callback = lambda payload: (_ for _ in ()).throw(rejection)
        failed = self.run_probe()
        self.assertEqual(failed["network"], "attempted")
        self.assertEqual(failed["network_scope"], "current_invocation")
        self.assertEqual(failed["live_requests_sent"], 1)
        self.assertEqual(failed["operations"][0]["http_status"], 404)
        self.assertEqual(self.run_probe()["network"], "not_attempted")

        with tempfile.TemporaryDirectory(dir=self.root) as video_session:
            self.run_probe(session_dir=video_session, features=("seedance_video",))
            self.client.state = "running"
            polled = self.run_probe(session_dir=video_session, poll=True)
            self.assertEqual(polled["network"], "attempted")
            self.assertEqual(polled["live_requests_sent"], 0)
            self.assertEqual(polled["status_requests_this_run"], 1)
            self.assertEqual(polled["downloads_this_run"], 0)
            self.assertEqual(self.client.gets, ["cgt_offline"])

            self.client.poll_error = provider.ProviderError("ark_transport_interrupted", outcome_unknown=True)
            interrupted = self.run_probe(session_dir=video_session, poll=True)
            self.assertEqual(interrupted["network"], "attempted")
            self.assertEqual(interrupted["live_requests_sent"], 0)
            self.assertEqual(interrupted["status_requests_this_run"], 1)

    def test_missing_task_id_is_unknown_and_no_resubmit(self):
        self.client.video_callback = lambda payload: provider.APIResponse({}, "request_lost", 200)
        result = self.run_probe(features=("seedance_video",))
        self.assertEqual(result["operations"][0]["status"], "unknown")
        self.assertEqual(self.run_probe(poll=True)["stop_reason"], "no_saved_task_id_no_resubmit")
        self.run_probe()
        self.assertEqual(len(self.client.posts), 1)

    def test_terminal_task_failure_does_not_resubmit_or_claim_supported(self):
        self.run_probe()
        self.client.state = "failed"
        self.client.error = {"code": "ContentPolicyViolation", "message": KEY + URL}
        result = self.run_probe(poll=True)
        self.assertEqual(result["operations"][1]["category"], "moderation")
        self.assertEqual(result["capabilities"]["seedance_video"], "unverified")
        self.assertNotIn(KEY, json.dumps(result))
        self.run_probe(poll=True)
        self.assertEqual(len(self.client.gets), 1)
        self.assertEqual(len(self.client.posts), 2)

    def test_existing_destination_is_not_overwritten(self):
        self.run_probe()
        target = self.session / "artifacts/seedance_video.mp4"
        target.write_bytes(b"foreign")
        result = self.run_probe(poll=True)
        self.assertEqual(target.read_bytes(), b"foreign")
        self.assertEqual(result["operations"][1]["status"], "pending_download")
        self.assertEqual(len(self.client.posts), 2)

    def test_replay_detects_deleted_or_modified_artifacts(self):
        self.run_probe()
        self.run_probe(poll=True)
        (self.session / "artifacts/seedance_video.mp4").write_bytes(b"changed")
        result = self.run_probe()
        self.assertEqual(result["capabilities"]["seedance_video"], "unverified")
        self.assertEqual(result["stop_reason"], "saved_artifact_missing_or_changed")
        self.assertEqual(len(self.client.posts), 2)

    def test_concurrent_session_is_blocked(self):
        attempts = []
        def callback(payload):
            attempts.append(self.run_probe())
            return image_response()
        self.client.image_callback = callback
        self.run_probe()
        self.assertEqual(attempts[0]["stop_reason"], "session_in_use_no_requests_sent")
        self.assertEqual(len(self.client.posts), 2)

    def test_changed_key_and_corrupt_ledger_fail_closed(self):
        self.run_probe()
        self.assertEqual(self.run_probe(environ={"ARK_API_KEY": "other-fake-key"})["stop_reason"], "session_identity_or_budget_mismatch")
        (self.session / "operations/seedance_video.json").write_text("{")
        self.assertEqual(self.run_probe()["stop_reason"], "session_record_unreadable_no_requests_sent")
        self.assertEqual(len(self.client.posts), 2)


class HTTPResponse:
    def __init__(self, body, status=200, headers=None):
        self.stream = io.BytesIO(json.dumps(body).encode())
        self.status = status
        self.headers = headers or {"x-tt-logid": "offline_log_id"}
        self.closed = False
    def read(self, size):
        return self.stream.read(size)
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.closed = True


class JsonTransportTests(unittest.TestCase):
    def response(self, wire, **headers):
        r = HTTPResponse(None, headers={"x-tt-logid": "req-test", **headers})
        r.stream = io.BytesIO(wire)
        return r

    def test_gzipped_nonstream_json_decodes_with_a_hard_expansion_limit(self):
        import gzip
        wire = gzip.compress(b'{"data":[]}')
        response = self.response(wire, **{"Content-Type":"application/json", "Content-Encoding":"gzip"})
        self.assertEqual(provider._read_json_response(response, KEY).body, {"data":[]})
        with patch.object(provider, 'MAX_JSON_BYTES', 1024):
            response = self.response(gzip.compress(b' ' * 4096), **{"Content-Encoding":"gzip"})
            with self.assertRaisesRegex(provider.ProviderError, 'ark_response_too_large'):
                provider._read_json_response(response, KEY)

    def test_unreadable_and_incomplete_responses_preserve_safe_context(self):
        for headers, reason in [
            ({"Content-Type":"text/html; secret=sensitive"}, "ark_response_invalid_json"),
            ({"Content-Length":"512"}, "ark_response_incomplete"),
            ({"Content-Type":"application/private-sensitive"}, "ark_response_invalid_json"),
        ]:
            with self.subTest(reason=reason):
                response = self.response(b"<private-sensitive>", **headers)
                with self.assertRaises(provider.ProviderError) as raised:
                    provider._read_json_response(response, KEY)
                error = raised.exception
                self.assertEqual((error.reason, error.status_code, error.request_id), (reason,200,"req-test"))
                self.assertTrue(error.outcome_unknown)
                self.assertEqual(error.response_metadata["receivedBytes"], len(b"<private-sensitive>"))
                self.assertNotIn('sensitive', json.dumps(error.response_metadata))


class CDNResponse:
    def __init__(self, body=b"video", status=200, read_callback=None):
        self.stream = io.BytesIO(body)
        self.length = str(len(body))
        self.status = status
        self.read_callback = read_callback
    def getheader(self, name):
        return self.length if name == "Content-Length" else None
    def read(self, size):
        return self.read_callback() if self.read_callback else self.stream.read(size)


class Connection:
    def __init__(self, response):
        self.response, self.requests, self.closed = response, [], False
    def request(self, *args, **kwargs):
        self.requests.append((args, kwargs))
    def getresponse(self):
        return self.response
    def close(self):
        self.closed = True


def public_dns(*args, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]


class ArkProviderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.credential = provider.Credential(KEY, "test")
        self.enterContext(patch.multiple(provider, IMAGE_GIF_KEY_FILE=self.root / "image-gif.key",
                                         DEFAULT_KEY_FILE=self.root / "host.key"))

    def test_image_gif_key_precedence(self):
        image_default = provider.IMAGE_GIF_KEY_FILE
        image_configured = self.root / "configured.key"
        explicit = self.root / "explicit.key"
        for path in (image_default, image_configured, explicit, provider.DEFAULT_KEY_FILE):
            path.write_text("fake-" + path.stem)
            path.chmod(0o600)
        legacy_env = {**ENV, "OPENNOVA_ARK_KEY_FILE": str(provider.DEFAULT_KEY_FILE)}
        image_env = {**legacy_env, "OPENNOVA_IMAGE_ARK_KEY_FILE": str(image_configured)}
        for environ, key_file, expected_path, expected_source in (
            (legacy_env, None, image_default, "opennova_image_gif_ark_default"),
            (image_env, None, image_configured, "OPENNOVA_IMAGE_ARK_KEY_FILE"),
            (image_env, explicit, explicit, "explicit_key_file"),
        ):
            with self.subTest(source=expected_source):
                credential = provider.resolve_credential(repo_root=self.repo, key_file=key_file, environ=environ)
                self.assertEqual(credential.secret, "fake-" + expected_path.stem)
                self.assertEqual(credential.source, expected_source)

    def test_invalid_image_gif_configuration_stops_before_legacy_credentials(self):
        image_default = provider.IMAGE_GIF_KEY_FILE
        image_default.write_text(KEY)
        image_default.chmod(0o600)
        with self.assertRaises(provider.ConfigurationError):
            provider.resolve_credential(repo_root=self.repo, environ={
                **ENV, "OPENNOVA_IMAGE_ARK_KEY_FILE": str(self.root / "missing.key")})
        image_default.chmod(0o644)
        with self.assertRaises(provider.ConfigurationError):
            provider.resolve_credential(repo_root=self.repo, environ=ENV)
        image_default.unlink()
        image_default.symlink_to(self.root / "missing.key")
        with self.assertRaises(provider.ConfigurationError):
            provider.resolve_credential(repo_root=self.repo, environ=ENV)

    def test_key_sources_permissions_and_no_fallback(self):
        key_file = provider.DEFAULT_KEY_FILE
        key_file.write_text(KEY)
        key_file.chmod(0o600)
        credential = provider.resolve_credential(repo_root=self.repo, environ={})
        self.assertEqual(credential.source, "opennova_ark_default")
        self.assertNotIn(KEY, repr(credential))
        self.assertEqual(provider.resolve_credential(repo_root=self.repo, environ=ENV).source, "ARK_API_KEY")
        self.assertEqual(provider.resolve_credential(repo_root=self.repo, environ={"OPENNOVA_ARK_KEY_FILE": str(key_file)}).source, "OPENNOVA_ARK_KEY_FILE")
        key_file.chmod(0o644)
        with self.assertRaises(provider.ConfigurationError):
            provider.resolve_credential(repo_root=self.repo, key_file=key_file, environ=ENV)
        with self.assertRaises(provider.ConfigurationError):
            provider.resolve_credential(repo_root=self.repo, key_file=self.repo / "key", environ=ENV)
        report = ark_probe.environment_report(self.repo, environ={})
        self.assertEqual(report["credentials"]["status"], "invalid")
        self.assertNotIn(str(key_file), json.dumps(report))

    def test_detached_archive_does_not_allow_credential_inside_original_checkout(self):
        key_file = self.repo / 'private.key'
        key_file.write_text(KEY)
        key_file.chmod(0o600)
        archive = self.root / 'archive'
        archive.mkdir()
        with self.assertRaisesRegex(provider.ConfigurationError, 'credential_file_must_be_outside_repository'):
            provider.resolve_credential(repo_root=archive, key_file=key_file,
                                        environ={'OPENNOVA_IMAGE_REPOSITORY_ROOT': str(self.repo)})

    def test_official_endpoint_json_and_bounded_timeouts(self):
        replies = [HTTPResponse({"id": "cgt_fake"}), HTTPResponse({"status": "running"})]
        opener = Mock()
        opener.open.side_effect = replies
        client = provider.ArkClient(self.credential, opener=opener)
        response = client.create_video({"model": provider.VIDEO_MODEL})
        client.get_video("cgt_fake")
        self.assertEqual(response.request_id, "offline_log_id")
        first, second = opener.open.call_args_list
        self.assertEqual(first.args[0].full_url, provider.API_BASE + provider.TASKS_PATH)
        self.assertEqual(first.args[0].get_header("Authorization"), "Bearer " + KEY)
        self.assertEqual(first.kwargs["timeout"], 120)
        self.assertEqual(second.kwargs["timeout"], 20)
        self.assertTrue(all(reply.closed for reply in replies))

    def test_post_failure_is_once_and_redacted_including_redirects(self):
        for status in (307, 403, 429, 500):
            error = HTTPError(provider.API_BASE, status, KEY, {"location": "http://127.0.0.1/"},
                              io.BytesIO(json.dumps({"error": {"code": KEY, "message": KEY}}).encode()))
            opener = Mock()
            opener.open.side_effect = error
            with self.subTest(status=status), self.assertRaises(provider.ProviderError) as caught:
                provider.ArkClient(self.credential, opener=opener).create_image({})
            self.assertEqual(opener.open.call_count, 1)
            self.assertNotIn(KEY, str(caught.exception))
            self.assertIsNone(caught.exception.error_code)
        self.assertIsNone(provider._NoRedirect().redirect_request(None, None, 307, None, {}, "http://127.0.0.1/"))

    def test_classifies_known_ark_failures_conservatively(self):
        for status, code, category in [(403, "AccessDenied", "permission"), (404, "ModelNotFound", "permission"),
                                      (429, "InsufficientBalance", "quota"), (429, "RateLimitExceeded", "transient"),
                                      (400, "ContentPolicyViolation", "moderation"), (400, "InvalidParameter", "invalid_request"),
                                      (400, "UnsupportedFeature", "unsupported")]:
            with self.subTest(code=code):
                self.assertEqual(provider.error_from_response(status, {"error": {"code": code}}).category, category)

    def test_download_requires_exact_ark_cdn_host(self):
        for host in (CDN, "ark-acg-cn-beijing.tos-cn-beijing.volces.com"):
            with self.subTest(host=host):
                url = f"https://{host}/video.mp4?signature=fixture"
                self.assertEqual(provider.validate_download_url(url, public_dns),
                                 (host, "8.8.8.8", "/video.mp4?signature=fixture"))
            for other in (f"sub.{host}", f"{host}.example.com", f"lookalike-{host}"):
                with self.subTest(other=other), self.assertRaisesRegex(provider.ProviderError, "download_url_not_allowed"):
                    provider.validate_download_url(f"https://{other}/video.mp4", public_dns)

    def test_download_allowlist_public_dns_and_dns_pinning(self):
        self.assertEqual(provider.validate_download_url(URL, public_dns), (CDN, "8.8.8.8", "/video.mp4?signature=never-store-this-signature"))
        bad_urls = ["http://" + CDN + "/x", "https://evil.invalid/x", "https://" + CDN + ".evil.invalid/x",
                    "https://user:pass@" + CDN + "/x", "https://" + CDN + ":444/x", "https://" + CDN + "/x\tsecret"]
        for url in bad_urls:
            with self.subTest(url=url), self.assertRaises(provider.ProviderError):
                provider.validate_download_url(url, public_dns)
        for address in ("127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "224.0.0.1"):
            with self.subTest(address=address), self.assertRaises(provider.ProviderError):
                provider.validate_download_url(URL, lambda *a, **k: [(0, 0, 0, "", (address, 443))])
        connection = provider._PinnedHTTPSConnection(CDN, "8.8.8.8")
        raw_socket = Mock()
        context = SimpleNamespace(wrap_socket=Mock(return_value=raw_socket))
        connection._context = context
        with patch.object(provider.socket, "create_connection", return_value=raw_socket) as connect:
            connection.connect()
        self.assertEqual(connect.call_args.args[0], ("8.8.8.8", 443))
        self.assertEqual(context.wrap_socket.call_args.kwargs["server_hostname"], CDN)
        connection.close()

    def test_download_has_no_auth_or_redirects_and_closes_connection(self):
        connection = Connection(CDNResponse())
        factory = Mock(return_value=connection)
        client = provider.ArkClient(self.credential, resolver=public_dns, connection_factory=factory)
        target = self.root / "video.mp4"
        owner = client.download_video(URL, target)
        self.assertEqual(target.read_bytes(), b"video")
        self.assertEqual(owner, (target.stat().st_dev, target.stat().st_ino))
        self.assertNotIn("Authorization", connection.requests[0][1]["headers"])
        self.assertEqual(factory.call_args.args, (CDN, "8.8.8.8"))
        self.assertTrue(connection.closed)
        connection = Connection(CDNResponse(status=307))
        client = provider.ArkClient(self.credential, resolver=public_dns, connection_factory=lambda *a, **k: connection)
        with self.assertRaisesRegex(provider.ProviderError, "redirect"):
            client.download_video(URL, self.root / "redirect.mp4")
        self.assertEqual(len(connection.requests), 1)
        self.assertTrue(connection.closed)

    def test_image_origins_and_transient_retry_use_only_same_credentialless_get(self):
        for host in provider.IMAGE_CDN_HOSTS:
            with self.subTest(host=host):
                url = "https://" + host + "/image.png?signed=fixture"
                incomplete = CDNResponse(body=b"short")
                incomplete.length = "10"
                connections = [Connection(incomplete), Connection(CDNResponse(body=b"pixels"))]
                factory = Mock(side_effect=connections)
                client = provider.ArkClient(self.credential, resolver=public_dns, connection_factory=factory)
                self.assertEqual(client.download_image(url, max_bytes=10), b"pixels")
                self.assertEqual(factory.call_count, 2)
                for connection in connections:
                    self.assertEqual(connection.requests,
                        [(("GET", "/image.png?signed=fixture"), {"headers": {"Accept": "image/png,application/octet-stream"}})])
                    self.assertTrue(connection.closed)

    def test_image_download_rejects_foreign_origins_redirects_and_oversized_body(self):
        for host in (CDN, "ark-acg-cn-beijing.tos-cn-beijing.volces.com.example.org"):
            factory = Mock()
            client = provider.ArkClient(self.credential, resolver=public_dns, connection_factory=factory)
            with self.assertRaisesRegex(provider.ProviderError, "download_url_not_allowed"):
                client.download_image("https://" + host + "/image.png", max_bytes=4)
            factory.assert_not_called()
        url = "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/image.png?signed=private"
        chunked = CDNResponse(body=b"12345")
        chunked.length = None
        for response, reason in ((CDNResponse(status=302), "redirect"), (chunked, "size"),
                                 (CDNResponse(body=b"12345"), "size")):
            factory = Mock(return_value=Connection(response))
            client = provider.ArkClient(self.credential, resolver=public_dns, connection_factory=factory)
            with self.assertRaisesRegex(provider.ProviderError, reason) as error:
                client.download_image(url, max_bytes=4)
            factory.assert_called_once()
            self.assertNotIn("signed=private", str(error.exception))

    def test_download_does_not_replace_or_delete_foreign_files(self):
        target = self.root / "video.mp4"
        target.write_bytes(b"foreign")
        connection = Connection(CDNResponse())
        client = provider.ArkClient(self.credential, resolver=public_dns, connection_factory=lambda *a, **k: connection)
        with self.assertRaises(FileExistsError):
            client.download_video(URL, target)
        self.assertEqual(target.read_bytes(), b"foreign")
        target.unlink()
        def replace_then_fail():
            foreign = self.root / "replacement"
            foreign.write_bytes(b"foreign replacement")
            foreign.replace(target)
            raise TimeoutError("offline interruption")
        connection = Connection(CDNResponse(read_callback=replace_then_fail))
        client = provider.ArkClient(self.credential, resolver=public_dns, connection_factory=lambda *a, **k: connection)
        with self.assertRaises(TimeoutError):
            client.download_video(URL, target)
        self.assertEqual(target.read_bytes(), b"foreign replacement")
        self.assertTrue(connection.closed)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "local FFmpeg required")
    def test_actual_video_is_fully_decoded_and_invalid_mp4_rejected(self):
        target = self.root / "generated-offline.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24",
                        "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(target)], check=True, timeout=15)
        result = ark_probe.validate_video(target)
        self.assertEqual(result["frame_count"], 96)
        self.assertEqual(result["duration_seconds"], 4)
        self.assertTrue(result["fully_decoded"])
        target.write_bytes(b"\x00\x00\x00\x18ftypinvalid")
        with self.assertRaises(provider.ConfigurationError):
            ark_probe.validate_video(target)


if __name__ == "__main__":
    unittest.main()
