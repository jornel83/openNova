"""Offline contracts: fake credentials and real SDK over local mock transport only."""

import base64
from contextlib import contextmanager, redirect_stdout
from email import policy
from email.parser import BytesParser
import io
import json
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from tools.image.probe import environment_report, main, run_probe
from tools.image.providers.openai_provider import (
    ConfigurationError, Credential, OFFICIAL_BASE_URL, build_edit_request,
    classify_error, create_client, resolve_credential,
)

FAKE_KEY = "sk-offline-test-only-never-valid"
ENV = {"OPENAI_API_KEY": FAKE_KEY}
MODEL = "gpt-image-2.6-flare"


def response(fmt="png", *, animated=True, usage=None):
    image = Image.new("RGB", (32, 32), "orange")
    output = io.BytesIO()
    options = {}
    if fmt == "gif" and animated:
        options = {"save_all": True, "append_images": [Image.new("RGB", (32, 32), "blue")], "duration": 200, "loop": 0}
    image.save(output, format=fmt.upper(), **options)
    return SimpleNamespace(data=[SimpleNamespace(b64_json=base64.b64encode(output.getvalue()).decode())],
                           _request_id="req_offline_example", usage=usage)


class APIError(Exception):
    def __init__(self, status=None, code=None, param=None, message="safe failure"):
        super().__init__(message)
        self.status_code = status
        self.code = code
        self.param = param
        self.request_id = "req_offline_failure"
        self.body = {"error": {"code": code, "param": param, "message": message}}


class FakeClient:
    def __init__(self, callback=None):
        self.calls = []
        self.images = self
        self.callback = callback
        self.closed = False

    def edit(self, **kwargs):
        self.calls.append(kwargs)
        if self.callback:
            return self.callback(kwargs)
        return response(kwargs["output_format"])

    def close(self):
        self.closed = True


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.session = self.root / "session"
        self.client = FakeClient()
        self.factory_options = []

    def factory(self, **kwargs):
        self.factory_options.append(kwargs)
        return self.client

    def run_probe(self, **kwargs):
        options = dict(session_dir=self.session, repo_root=self.repo, model=MODEL,
                       max_requests=2, live=True, environ=ENV, client_factory=self.factory)
        options.update(kwargs)
        return run_probe(**options)

    def test_check_never_constructs_client_or_exposes_values(self):
        with patch("socket.socket", side_effect=AssertionError("network forbidden")):
            result = environment_report(self.repo, environ={**ENV, "OPENAI_BASE_URL": "https://secret.invalid"})
            offline = self.run_probe(live=False)
        self.assertEqual(result["credentials"]["status"], "configured")
        self.assertEqual(result["capabilities"], {"static_edit": "unverified", "native_gif": "unverified"})
        self.assertEqual(offline["live_requests_sent"], 0)
        self.assertFalse(self.factory_options)
        self.assertFalse(self.session.exists())
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        self.assertNotIn("secret.invalid", json.dumps(result))

    def test_missing_credentials_are_unverified_and_do_not_consume_budget(self):
        result = self.run_probe(environ={})
        self.assertEqual(result["stop_reason"], "credentials_missing")
        self.assertEqual(result["capabilities"]["native_gif"], "unverified")
        self.assertFalse(self.session.exists())
        self.assertFalse(self.client.calls)

    def test_environment_reports_platform_and_bounded_ffmpeg_version(self):
        completed = SimpleNamespace(returncode=0, stdout="ffmpeg version 8.0 example-build\nconfiguration: hidden\n")
        with patch("tools.image.probe.shutil.which", return_value="/offline/ffmpeg"), \
             patch("tools.image.probe.subprocess.run", return_value=completed) as command:
            result = environment_report(self.repo, environ=ENV)
        self.assertTrue(result["ffmpeg_available"])
        self.assertEqual(result["ffmpeg_version"], "ffmpeg version 8.0 example-build")
        self.assertEqual(result["ffmpeg_status"], "available")
        self.assertEqual(set(result["platform"]), {"system", "release", "machine", "python_implementation"})
        self.assertEqual(command.call_args.args[0], ["/offline/ffmpeg", "-version"])
        self.assertEqual(command.call_args.kwargs["timeout"], 2)
        self.assertNotIn("OPENAI_API_KEY", command.call_args.kwargs["env"])
        self.assertNotIn("configuration: hidden", json.dumps(result))

    def test_absent_ffmpeg_does_not_block_pillow_based_probes(self):
        with patch("tools.image.probe.shutil.which", return_value=None), \
             patch("tools.image.probe.subprocess.run", side_effect=AssertionError("must not execute")):
            result = self.run_probe(max_requests=1)
        self.assertFalse(result["ffmpeg_available"])
        self.assertIsNone(result["ffmpeg_version"])
        self.assertEqual(result["ffmpeg_status"], "not_configured")
        self.assertEqual(result["capabilities"]["static_edit"], "supported")

    def test_ffmpeg_timeout_and_failure_remain_local_and_redacted(self):
        failures = [subprocess.TimeoutExpired("ffmpeg", 2, output=FAKE_KEY),
                    OSError(FAKE_KEY), SimpleNamespace(returncode=1, stdout=FAKE_KEY)]
        for failure in failures:
            options = {"side_effect": failure} if isinstance(failure, Exception) else {"return_value": failure}
            with self.subTest(failure=type(failure).__name__), \
                 patch("tools.image.probe.shutil.which", return_value="/offline/ffmpeg"), \
                 patch("tools.image.probe.subprocess.run", **options):
                result = environment_report(self.repo, environ=ENV)
            self.assertEqual(result["ffmpeg_status"], "version_check_failed")
            self.assertIsNone(result["ffmpeg_version"])
            self.assertNotIn(FAKE_KEY, json.dumps(result))

    def test_private_key_file_precedence_and_redaction(self):
        key_file = self.root / "private-key"
        key_file.write_text(FAKE_KEY + "\n")
        key_file.chmod(0o600)
        credential = resolve_credential(repo_root=self.repo, key_file=key_file, environ={"OPENAI_API_KEY": "other"})
        self.assertEqual(credential.secret, FAKE_KEY)
        self.assertNotIn(FAKE_KEY, repr(credential))
        self.assertEqual(credential.scope, Credential(FAKE_KEY, "different-source").scope)
        result = environment_report(self.repo, key_file, environ={})
        self.assertEqual(result["credentials"]["status"], "configured")
        self.assertNotIn(str(key_file), json.dumps(result))
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        self.assertEqual(resolve_credential(repo_root=self.repo, environ={"OPENNOVA_OPENAI_KEY_FILE": str(key_file)}).secret, FAKE_KEY)

    def test_rejects_public_in_repo_symlink_and_nonregular_key_files(self):
        key_file = self.root / "key"
        key_file.write_text(FAKE_KEY)
        key_file.chmod(0o644)
        with self.assertRaisesRegex(ConfigurationError, "private"):
            resolve_credential(repo_root=self.repo, key_file=key_file, environ=ENV)
        key_file.chmod(0o600)
        link = self.root / "link"
        link.symlink_to(key_file)
        with self.assertRaisesRegex(ConfigurationError, "symlink"):
            resolve_credential(repo_root=self.repo, key_file=link, environ={})
        in_repo = self.repo / "key"
        in_repo.write_text(FAKE_KEY)
        in_repo.chmod(0o600)
        with self.assertRaisesRegex(ConfigurationError, "outside"):
            resolve_credential(repo_root=self.repo, key_file=in_repo, environ={})
        fifo = self.root / "fifo"
        os.mkfifo(fifo, 0o600)
        with self.assertRaisesRegex(ConfigurationError, "regular"):
            resolve_credential(repo_root=self.repo, key_file=fifo, environ={})

    def test_invalid_configured_file_does_not_fall_back_to_env_key(self):
        result = self.run_probe(key_file=self.root / "missing")
        self.assertEqual(result["stop_reason"], "credentials_invalid")
        self.assertFalse(self.client.calls)

    def test_reservation_precedes_send_and_success_records_metadata(self):
        def callback(kwargs):
            feature = "native_gif" if kwargs["output_format"] == "gif" else "static_edit"
            record = json.loads((self.session / "operations" / (feature + ".json")).read_text())
            self.assertEqual(record["status"], "unknown")
            self.assertIsNone(record["finished_at"])
            self.assertTrue(record["request_may_have_been_sent"])
            return response(kwargs["output_format"], usage={"input_tokens": 10, "output_tokens": 20, "total_tokens": 30})
        self.client.callback = callback
        result = self.run_probe()
        self.assertEqual(result["stop_reason"], "completed")
        self.assertEqual(result["budget_used"], 2)
        self.assertEqual(result["capabilities"], {"static_edit": "supported", "native_gif": "supported"})
        self.assertEqual(len(self.client.calls), 2)
        self.assertEqual(self.factory_options[0]["max_retries"], 0)
        self.assertEqual(self.factory_options[0]["base_url"], OFFICIAL_BASE_URL)
        self.assertEqual(result["operations"][1]["result_metadata"]["frame_count"], 2)
        self.assertEqual(result["operations"][1]["result_metadata"]["frame_durations_ms"], [200, 200])
        self.assertEqual(result["operations"][0]["usage"]["total_tokens"], 30)
        self.assertTrue(self.client.closed)
        for record in result["operations"]:
            self.assertEqual(record["request_id"], "req_offline_example")
            self.assertTrue((self.session / record["result_metadata"]["artifact"]).is_file())
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        self.assertNotIn(FAKE_KEY, (self.session / "session.json").read_text())

    def test_no_duplicate_request_on_repeated_success(self):
        self.run_probe()
        again = self.run_probe()
        self.assertEqual(len(self.client.calls), 2)
        self.assertEqual(again["live_requests_sent"], 0)
        self.assertEqual(again["stop_reason"], "already_recorded_no_retry")

    def test_one_request_budget_counts_failure_and_cannot_be_raised(self):
        self.client.callback = lambda kwargs: (_ for _ in ()).throw(APIError(429, "insufficient_quota"))
        result = self.run_probe(max_requests=1)
        again = self.run_probe(max_requests=1)
        raised = self.run_probe(max_requests=2)
        self.assertEqual(result["budget_used"], 1)
        self.assertEqual(result["operations"][0]["category"], "quota")
        self.assertEqual(again["live_requests_sent"], 0)
        self.assertEqual(raised["stop_reason"], "session_identity_or_budget_mismatch")
        self.assertEqual(len(self.client.calls), 1)

    def test_one_request_budget_never_sends_second_feature(self):
        result = self.run_probe(max_requests=1)
        self.assertEqual(result["stop_reason"], "request_budget_exhausted")
        self.assertEqual(result["capabilities"]["native_gif"], "unverified")
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(self.run_probe(max_requests=1)["live_requests_sent"], 0)

    def test_timeout_is_unknown_and_never_retried(self):
        self.client.callback = lambda kwargs: (_ for _ in ()).throw(TimeoutError(FAKE_KEY))
        result = self.run_probe()
        record = result["operations"][0]
        self.assertEqual(record["status"], "unknown")
        self.assertEqual(record["category"], "transient")
        self.assertEqual(record["capability"], "unverified")
        self.assertIsNone(record["usage"])
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        self.run_probe()
        self.assertEqual(len(self.client.calls), 1)

    def test_process_interruption_leaves_durable_unknown_record(self):
        self.client.callback = lambda kwargs: (_ for _ in ()).throw(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            self.run_probe()
        reserved = json.loads((self.session / "operations/static_edit.json").read_text())
        self.assertEqual(reserved["status"], "unknown")
        self.assertIsNone(reserved["finished_at"])
        self.client.callback = None
        result = self.run_probe()
        self.assertEqual(result["budget_used"], 1)
        self.assertEqual(result["live_requests_sent"], 0)
        self.assertEqual(len(self.client.calls), 1)

    def test_corrupt_ledger_fails_closed(self):
        self.run_probe(max_requests=1)
        (self.session / "operations/static_edit.json").write_text("{")
        result = self.run_probe(max_requests=1)
        self.assertEqual(result["stop_reason"], "session_record_unreadable_no_requests_sent")
        self.assertEqual(result["live_requests_sent"], 0)
        self.assertEqual(result["budget_used"], 1)
        self.assertEqual(len(self.client.calls), 1)

    def test_concurrent_invocation_cannot_claim_same_budget(self):
        blocked = []
        def callback(kwargs):
            blocked.append(self.run_probe())
            return response(kwargs["output_format"])
        self.client.callback = callback
        result = self.run_probe()
        self.assertEqual(result["budget_used"], 2)
        self.assertEqual(len(self.client.calls), 2)
        for attempt in blocked:
            self.assertEqual(attempt["stop_reason"], "session_in_use_no_requests_sent")
            self.assertEqual(attempt["live_requests_sent"], 0)

    def test_local_sdk_incompatibility_does_not_reserve_or_send(self):
        class Incompatible:
            def edit(self, *, image, model, prompt, n, quality, extra_body=None):
                raise AssertionError("must not be called")
        client = SimpleNamespace(images=Incompatible())
        result = self.run_probe(client_factory=lambda **kwargs: client)
        self.assertEqual(result["stop_reason"], "installed_sdk_cannot_encode_probe")
        self.assertEqual(result["budget_used"], 0)
        self.assertEqual(list((self.session / "operations").iterdir()), [])

    def test_local_sdk_setup_error_is_redacted_without_retry(self):
        def factory(**kwargs):
            raise RuntimeError(FAKE_KEY)
        result = self.run_probe(client_factory=factory)
        self.assertEqual(result["stop_reason"], "local_probe_error_no_retry")
        self.assertEqual(result["budget_used"], 0)
        self.assertNotIn(FAKE_KEY, json.dumps(result))

    def test_change_of_key_or_model_cannot_reuse_session(self):
        self.run_probe(max_requests=1)
        for kwargs in ({"environ": {"OPENAI_API_KEY": "sk-other-test"}}, {"model": "gpt-image-2.6-sunburst"}):
            result = self.run_probe(max_requests=1, **kwargs)
            self.assertEqual(result["stop_reason"], "session_identity_or_budget_mismatch")
        self.assertEqual(len(self.client.calls), 1)

    def test_invalid_gif_does_not_claim_support_or_download_url(self):
        for payload in (response("gif", animated=False), response("png"), SimpleNamespace(data=[{"url": "https://do-not-fetch.invalid"}])):
            with tempfile.TemporaryDirectory(dir=self.root) as session:
                self.client.callback = lambda kwargs: payload
                result = self.run_probe(session_dir=session, features=("native_gif",))
                self.assertEqual(result["operations"][0]["status"], "unknown")
                self.assertEqual(result["capabilities"]["native_gif"], "unverified")
                self.assertIsNone(result["operations"][0]["result_metadata"])

    def test_unknown_usage_is_null(self):
        result = self.run_probe(max_requests=1)
        self.assertIsNone(result["operations"][0]["usage"])

    def test_budget_and_feature_validation(self):
        for value in (0, 3, True, 1.0):
            with self.assertRaises(ConfigurationError):
                self.run_probe(max_requests=value)
        with self.assertRaises(ConfigurationError):
            self.run_probe(features=("native_gif", "native_gif"))
        self.assertFalse(self.client.calls)

    def test_cli_requires_all_explicit_live_controls(self):
        with redirect_stdout(io.StringIO()), patch("sys.stderr", io.StringIO()):
            for args in (["--live"], ["--live", "--max-requests", "2"], ["--live", "--max-requests", "3"]):
                with self.assertRaises(SystemExit) as caught:
                    main(args)
                self.assertEqual(caught.exception.code, 2)


class ProviderTests(unittest.TestCase):
    def test_documented_fields_use_native_signature(self):
        def modern(*, image, model, prompt, n, size, quality, output_format, frame_count=None, frame_duration_ms=None):
            pass
        request = build_edit_request(modern, model=MODEL, feature="native_gif", image=b"fixture")
        self.assertNotIn("extra_body", request)
        self.assertEqual(request["frame_count"], 2)

    def test_only_documented_missing_fields_use_extra_body(self):
        def legacy(*, image, model, prompt, n, size, quality, output_format, extra_body=None):
            pass
        request = build_edit_request(legacy, model=MODEL, feature="native_gif", image=b"fixture")
        self.assertEqual(request["extra_body"], {"frame_count": 2, "frame_duration_ms": 200})
        self.assertEqual(request["output_format"], "gif")
        def unsuitable(*, image, model, prompt, n, quality, extra_body=None):
            pass
        with self.assertRaises(ConfigurationError):
            build_edit_request(unsuitable, model=MODEL, feature="native_gif", image=b"fixture")

    def test_error_classification_never_conflates_access_or_failure_with_unsupported(self):
        examples = [
            (APIError(403, "permission_denied"), "permission", "unverified"),
            (APIError(404, "model_not_found"), "permission", "unverified"),
            (APIError(400, "invalid_request_error", message="GIF preview access is not enabled"), "permission", "unverified"),
            (APIError(429, "insufficient_quota"), "quota", "unverified"),
            (APIError(429, "rate_limit_exceeded"), "transient", "unverified"),
            (APIError(400, "moderation_blocked"), "moderation", "unverified"),
            (APIError(400, "invalid_request_error"), "invalid_request", "unverified"),
            (APIError(500, "server_error"), "transient", "unverified"),
            (APIError(400, "unsupported_parameter", "frame_count"), "unsupported", "unsupported"),
            (APIError(400, "unsupported_parameter", "size"), "invalid_request", "unverified"),
            (APIError(400, "unsupported_feature"), "unsupported", "unsupported"),
        ]
        for error, category, capability in examples:
            with self.subTest(category=category, code=error.code):
                result = classify_error(error)
                self.assertEqual(result["category"], category)
                self.assertEqual(result["capability"], capability)

    def test_server_error_content_and_unknown_usage_are_not_echoed(self):
        result = classify_error(APIError(400, FAKE_KEY, message=FAKE_KEY))
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        self.assertIsNone(result["error_code"])

    def test_client_pins_official_endpoint_and_zero_retries(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": "https://example.invalid"}):
            options = create_client(Credential(FAKE_KEY, "test"), lambda **kwargs: kwargs)
        self.assertEqual(options["base_url"], OFFICIAL_BASE_URL)
        self.assertEqual(options["max_retries"], 0)


class LockedSDKContractTests(unittest.TestCase):
    """Exercise the installed SDK and multipart encoder with zero network access.

    These tests explicitly skip when the SDK is absent. In the pinned image-tool
    environment they must execute, including actual HTTP transport exceptions.
    """

    @classmethod
    def setUpClass(cls):
        try:
            import openai
            import httpx2
        except ImportError:
            raise unittest.SkipTest("locked SDK contracts require tools/image/requirements.txt (openai + httpx2)") from None
        cls.sdk = openai
        cls.httpx = httpx2
        cls.http_client_type = openai.DefaultHttpxClient

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.session = self.root / "session"
        # A broken mock setup must fail locally, never attempt DNS or a socket.
        for target in ("socket.create_connection", "socket.getaddrinfo", "socket.socket.connect", "socket.socket.connect_ex"):
            guard = patch(target, side_effect=AssertionError("network forbidden in SDK contract tests"))
            guard.start()
            self.addCleanup(guard.stop)
        env = patch.dict(os.environ, {"OPENAI_BASE_URL": "https://must-not-use.invalid"}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    @contextmanager
    def transport(self, handler):
        clients = []
        def http_factory(**kwargs):
            client = self.http_client_type(transport=self.httpx.MockTransport(handler), **kwargs)
            clients.append(client)
            return client
        with patch.object(self.sdk, "DefaultHttpxClient", side_effect=http_factory):
            yield clients
        for client in clients:
            client.close()

    def run_probe(self, **kwargs):
        options = dict(session_dir=self.session, repo_root=self.repo, model=MODEL,
                       max_requests=2, live=True, environ=ENV)
        options.update(kwargs)
        return run_probe(**options)

    @staticmethod
    def multipart(request):
        message = BytesParser(policy=policy.default).parsebytes(
            ("Content-Type: " + request.headers["content-type"] + "\r\nMIME-Version: 1.0\r\n\r\n").encode()
            + request.read()
        )
        return {part.get_param("name", header="content-disposition"): {
                    "data": part.get_payload(decode=True),
                    "filename": part.get_filename(), "type": part.get_content_type(),
                } for part in message.iter_parts()}

    def test_real_sdk_constructor_pins_endpoint_timeout_retries_and_redirects(self):
        self.assertEqual(self.sdk.__version__, "3.54.0", "run contracts in the pinned image-tool environment")
        requests = []
        with self.transport(lambda request: requests.append(request)) as http_clients:
            client = create_client(Credential(FAKE_KEY, "offline_test"))
            self.assertIsInstance(client, self.sdk.OpenAI)
            self.assertEqual(str(client.base_url), OFFICIAL_BASE_URL + "/")
            self.assertEqual(client.max_retries, 0)
            self.assertEqual(client.timeout, 120.0)
            self.assertFalse(http_clients[0].follow_redirects)
            client.close()
            self.assertTrue(client.is_closed())
            self.assertTrue(http_clients[0].is_closed)
        self.assertEqual(requests, [])

    def test_real_sdk_serializes_static_and_gif_multipart(self):
        requests = []
        def handler(request):
            fields = self.multipart(request)
            requests.append((request, fields))
            fmt = fields["output_format"]["data"].decode()
            generated = response(fmt)
            return self.httpx.Response(200, headers={"x-request-id": "req_sdk_contract"}, json={
                "created": 0, "data": [{"b64_json": generated.data[0].b64_json}],
                "usage": {"input_tokens": 10, "input_tokens_details": {"image_tokens": 8, "text_tokens": 2},
                          "output_tokens": 20, "total_tokens": 30},
            })
        with self.transport(handler) as clients:
            result = self.run_probe()
            self.assertEqual(result["stop_reason"], "completed")
            self.assertEqual(len(requests), 2)
            self.assertTrue(clients[0].is_closed)
        for index, (request, fields) in enumerate(requests):
            gif = index == 1
            self.assertEqual(request.method, "POST")
            self.assertEqual(str(request.url), OFFICIAL_BASE_URL + "/images/edits")
            self.assertTrue(request.headers["content-type"].startswith("multipart/form-data; boundary="))
            expected = {"image", "model", "prompt", "n", "size", "quality", "output_format"}
            if gif:
                expected.update({"frame_count", "frame_duration_ms"})
            self.assertEqual(set(fields), expected)
            self.assertEqual(fields["model"]["data"], MODEL.encode())
            self.assertEqual(fields["n"]["data"], b"1")
            self.assertEqual(fields["quality"]["data"], b"low")
            self.assertEqual(fields["output_format"]["data"], b"gif" if gif else b"png")
            self.assertEqual(fields["size"]["data"], b"512x512" if gif else b"1024x1024")
            self.assertEqual(fields["image"]["filename"], "probe-input.png")
            self.assertEqual(fields["image"]["type"], "image/png")
            self.assertTrue(fields["image"]["data"].startswith(b"\x89PNG\r\n\x1a\n"))
            if gif:
                self.assertEqual(fields["frame_count"]["data"], b"2")
                self.assertEqual(fields["frame_duration_ms"]["data"], b"200")
            self.assertEqual(request.extensions["timeout"], {"connect": 120.0, "read": 120.0, "write": 120.0, "pool": 120.0})
            record = result["operations"][index]
            self.assertEqual(record["request_id"], "req_sdk_contract")
            self.assertEqual(record["usage"]["total_tokens"], 30)
            self.assertEqual(record["request_metadata"]["sdk_extra_body_fields"], [])

    def test_real_sdk_timeout_is_unknown_one_attempt_and_closes_client(self):
        requests = []
        def handler(request):
            requests.append(request)
            raise self.httpx.ReadTimeout("offline simulated timeout", request=request)
        with self.transport(handler) as clients:
            result = self.run_probe()
            self.assertTrue(clients[0].is_closed)
            again = self.run_probe()
            self.assertEqual(len(clients), 1)
        self.assertEqual(len(requests), 1)
        record = result["operations"][0]
        self.assertEqual(record["status"], "unknown")
        self.assertEqual(record["category"], "transient")
        self.assertEqual(record["capability"], "unverified")
        self.assertIsNone(record["request_id"])
        self.assertIsNone(record["usage"])
        self.assertEqual(again["live_requests_sent"], 0)
        self.assertEqual(again["budget_used"], 1)

    def test_real_sdk_http_errors_preserve_classification_without_retry(self):
        examples = [
            (403, "permission_denied", None, "permission", "failed", "unverified"),
            (429, "insufficient_quota", None, "quota", "failed", "unverified"),
            (400, "moderation_blocked", None, "moderation", "failed", "unverified"),
            (400, "unsupported_parameter", "frame_count", "unsupported", "failed", "unsupported"),
            (500, "server_error", None, "transient", "unknown", "unverified"),
        ]
        for status, code, param, category, state, capability in examples:
            with self.subTest(code=code), tempfile.TemporaryDirectory(dir=self.root) as session:
                requests = []
                def handler(request):
                    requests.append(request)
                    return self.httpx.Response(status, headers={"x-request-id": "req_sdk_error"}, json={
                        "error": {"code": code, "type": "invalid_request_error", "param": param, "message": "offline simulated error"},
                    })
                with self.transport(handler) as clients:
                    result = self.run_probe(session_dir=session, features=("native_gif",))
                    self.assertTrue(clients[0].is_closed)
                    again = self.run_probe(session_dir=session, features=("native_gif",))
                    self.assertEqual(len(clients), 1)
                record = result["operations"][0]
                self.assertEqual((record["category"], record["status"], record["capability"]), (category, state, capability))
                self.assertEqual(record["request_id"], "req_sdk_error")
                self.assertIsNone(record["usage"])
                self.assertEqual(len(requests), 1)
                self.assertEqual(again["live_requests_sent"], 0)

    def test_real_sdk_does_not_follow_redirects(self):
        requests = []
        def handler(request):
            requests.append(request)
            return self.httpx.Response(307, headers={"location": "https://redirect-must-not-follow.invalid/images/edits"})
        with self.transport(handler) as clients:
            result = self.run_probe()
            self.assertTrue(clients[0].is_closed)
        self.assertEqual(len(requests), 1)
        self.assertEqual(str(requests[0].url), OFFICIAL_BASE_URL + "/images/edits")
        self.assertEqual(result["capabilities"]["static_edit"], "unverified")
        self.assertEqual(result["operations"][0]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
