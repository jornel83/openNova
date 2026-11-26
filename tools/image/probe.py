"""M0 capability probe: offline by default, at most two opt-in requests per session.

Run ``python -m tools.image.probe --check`` for a network-free environment report.
Live probes require --live, --model, --session-dir, and --max-requests (1 or 2).
Reuse the same session directory after interruption. Its original budget cannot
be raised. Every exclusive operation record consumes one slot, even on failure.
Never delete a record to retry an uncertain or failed request.
"""

from __future__ import annotations

import argparse
import base64
import binascii
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from typing import Any, Callable, Mapping, Sequence
import uuid

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.image.providers.openai_provider import (
    ConfigurationError, FEATURES, OFFICIAL_BASE_URL, build_edit_request,
    classify_error, create_client, resolve_credential, safe_request_id,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_VERSION = 1
MAX_RESULT_BYTES = 32 * 1024 * 1024


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _ffmpeg_environment() -> dict[str, Any]:
    executable = shutil.which("ffmpeg")
    result = {"ffmpeg_available": executable is not None, "ffmpeg_version": None,
              "ffmpeg_status": "version_check_failed" if executable else "not_configured"}
    if executable is None:
        return result
    try:
        process = subprocess.run(
            [executable, "-version"], capture_output=True, text=True, timeout=2,
            check=False, env={"PATH": os.defpath, "LC_ALL": "C"},
        )
        first_line = process.stdout.splitlines()[0] if process.stdout else ""
        if process.returncode == 0 and first_line.startswith("ffmpeg version "):
            result.update(ffmpeg_version=first_line[:256], ffmpeg_status="available")
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        pass
    return result


def environment_report(
    repo_root: str | Path | None = None, key_file: str | Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Inspect explicitly configured local state without client construction/network.

    No environment values, credential paths, raw errors, tokens, or headers are
    returned. The optional key fingerprint scopes evidence only to this key.
    """
    packages: dict[str, str | None] = {}
    for package in ("openai", "Pillow"):
        try:
            packages[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            packages[package] = None
    try:
        credential = resolve_credential(repo_root=Path(repo_root or REPO_ROOT), key_file=key_file, environ=environ)
        auth = {"status": "configured" if credential else "missing", "source": credential.source if credential else None,
                "scope": credential.scope if credential else None, "error": None}
    except ConfigurationError as error:
        auth = {"status": "invalid", "source": None, "scope": None, "error": str(error)}
    return {
        "schema_version": SCHEMA_VERSION,
        "checked_at": now(),
        "network": "not_attempted",
        "python": ".".join(map(str, sys.version_info[:3])),
        "platform": {"system": platform.system(), "release": platform.release(),
                     "machine": platform.machine(), "python_implementation": platform.python_implementation()},
        "dependencies": packages,
        **_ffmpeg_environment(),
        "credentials": auth,
        "endpoint": OFFICIAL_BASE_URL + "/images/edits",
        "capabilities": {feature: "unverified" for feature in FEATURES},
        "scope_semantics": "credential_fingerprint; not a verified account identifier",
        "gif_requires_model_preview_access": True,
        "live_requests_sent": 0,
    }


def _directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ConfigurationError("session_directory_must_be_regular_directory")


def _sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _exclusive_bytes(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    _sync_directory(path.parent)


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()


def _replace_json(path: Path, value: Any) -> None:
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    try:
        _exclusive_bytes(temporary, _json_bytes(value))
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        if path.is_symlink() or path.stat().st_size > 256_000:
            raise ValueError
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise ValueError
        return data
    except (OSError, ValueError):
        raise ConfigurationError("session_record_unreadable_no_requests_sent") from None


@contextmanager
def _session_lock(path: Path):
    fd = os.open(path / ".lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ConfigurationError("session_in_use_no_requests_sent") from None
        yield
    finally:
        os.close(fd)


def _fixture() -> bytes:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        raise ConfigurationError("pillow_not_installed") from None
    image = Image.new("RGB", (256, 256), "white")
    ImageDraw.Draw(image).ellipse((64, 64, 192, 192), fill=(45, 100, 220))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _field(obj: Any, name: str) -> Any:
    return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)


def _number(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _usage(response: Any) -> dict[str, Any] | None:
    usage = _field(response, "usage")
    if usage is None:
        return None
    result = {key: _number(_field(usage, key)) for key in ("input_tokens", "output_tokens", "total_tokens")}
    for name in ("input_tokens_details", "output_tokens_details"):
        details = _field(usage, name)
        result[name] = None if details is None else {
            key: _number(_field(details, key)) for key in ("image_tokens", "text_tokens")
        }
    return result


def _result(response: Any, *, feature: str, directory: Path) -> dict[str, Any]:
    from PIL import Image

    data = _field(response, "data")
    if not isinstance(data, (list, tuple)) or len(data) != 1:
        raise ConfigurationError("unexpected_result_count")
    encoded = _field(data[0], "b64_json")
    if not isinstance(encoded, str) or len(encoded) > (MAX_RESULT_BYTES * 4 // 3 + 4):
        raise ConfigurationError("missing_or_oversized_base64_result")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ConfigurationError("invalid_base64_result") from None
    try:
        with Image.open(io.BytesIO(decoded)) as image:
            frames = getattr(image, "n_frames", 1)
            if feature == "native_gif" and (image.format != "GIF" or not 2 <= frames <= 16):
                raise ConfigurationError("response_is_not_animated_gif")
            if feature == "static_edit" and (image.format != "PNG" or frames != 1):
                raise ConfigurationError("response_is_not_static_png")
            durations = []
            for frame in range(frames):
                image.seek(frame)
                image.load()
                durations.append(_number(image.info.get("duration")))
            if feature == "native_gif" and any(not duration for duration in durations):
                raise ConfigurationError("gif_has_invalid_frame_timing")
            metadata = {"format": image.format.lower(), "width": image.width, "height": image.height,
                        "frame_count": frames, "frame_durations_ms": durations if frames > 1 else None,
                        "byte_count": len(decoded), "sha256": hashlib.sha256(decoded).hexdigest()}
    except ConfigurationError:
        raise
    except Exception:
        raise ConfigurationError("unreadable_image_result") from None
    artifact = Path("artifacts") / (feature + "." + metadata["format"])
    _exclusive_bytes(directory / artifact, decoded)
    return {**metadata, "artifact": str(artifact)}


def run_probe(
    *, session_dir: str | Path, model: str, max_requests: int,
    features: Sequence[str] = FEATURES, live: bool = False,
    repo_root: str | Path | None = None, key_file: str | Path | None = None,
    environ: Mapping[str, str] | None = None,
    client_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Execute only explicitly authorized probes, with an injectable offline client.

    Failure or uncertainty stops the current run. A repeated invocation returns
    durable evidence and never repeats an existing feature, even after failure.
    ``max_requests`` caps attempted requests, not successful results or dollars.
    """
    if type(max_requests) is not int or max_requests not in (1, 2):
        raise ConfigurationError("max_requests_must_be_1_or_2")
    selected = tuple(features)
    if not selected or len(set(selected)) != len(selected) or any(item not in FEATURES for item in selected):
        raise ConfigurationError("select_each_known_feature_at_most_once")
    report = environment_report(repo_root, key_file, environ)
    report.update(mode="live" if live else "check", model=model, operations=[], budget_limit=max_requests,
                  budget_used=0, stop_reason=None)
    if not live:
        report["stop_reason"] = "live_opt_in_required"
        return report
    if report["credentials"]["status"] != "configured":
        report["stop_reason"] = "credentials_" + report["credentials"]["status"]
        return report
    credential = resolve_credential(repo_root=Path(repo_root or REPO_ROOT), key_file=key_file, environ=environ)
    assert credential is not None
    directory = Path(session_dir).expanduser().absolute()
    client = None
    try:
        _directory(directory)
        with _session_lock(directory):
            _directory(directory / "operations")
            _directory(directory / "artifacts")
            session_file = directory / "session.json"
            identity = {"schema_version": SCHEMA_VERSION, "credential_scope": credential.scope,
                        "model": model, "max_requests": max_requests, "endpoint": OFFICIAL_BASE_URL + "/images/edits"}
            if session_file.exists():
                session = _read_json(session_file)
                if any(session.get(key) != value for key, value in identity.items()):
                    raise ConfigurationError("session_identity_or_budget_mismatch")
            else:
                if any((directory / "operations").iterdir()):
                    raise ConfigurationError("operations_without_session_no_requests_sent")
                _exclusive_bytes(session_file, _json_bytes({**identity, "created_at": now()}))
            existing = {}
            operation_paths = sorted((directory / "operations").iterdir())
            # A corrupt reservation still consumes a slot; never report it as 0.
            report["budget_used"] = len(operation_paths)
            for path in operation_paths:
                if path.name not in {feature + ".json" for feature in FEATURES}:
                    raise ConfigurationError("unexpected_operation_record_no_requests_sent")
                record = _read_json(path)
                feature = path.stem
                if record.get("feature") != feature or record.get("credential_scope") != credential.scope or record.get("model") != model:
                    raise ConfigurationError("operation_identity_mismatch_no_requests_sent")
                if record.get("status") not in {"succeeded", "failed", "unknown"}:
                    raise ConfigurationError("operation_state_invalid_no_requests_sent")
                existing[feature] = record
            report["operations"] = list(existing.values())
            report["budget_used"] = len(existing)
            for feature, record in existing.items():
                report["capabilities"][feature] = record.get("capability", "unverified")
            if any(record["status"] != "succeeded" for record in existing.values()):
                report["stop_reason"] = "prior_failure_or_unknown_requires_review_no_retry"
                return report
            pending = [feature for feature in selected if feature not in existing]
            if not pending:
                report["stop_reason"] = "already_recorded_no_retry"
                return report
            if len(existing) >= max_requests:
                report["stop_reason"] = "request_budget_exhausted"
                return report
            # Complete local validation before reserving a billable operation.
            fixture = _fixture()
            client = create_client(credential, client_factory)
            requests = {feature: build_edit_request(client.images.edit, model=model, feature=feature, image=fixture)
                        for feature in pending[:max_requests - len(existing)]}
            for feature, request in requests.items():
                started = now()
                record = {
                    "schema_version": SCHEMA_VERSION, "feature": feature, "model": model,
                    "credential_scope": credential.scope, "endpoint": identity["endpoint"],
                    "created_at": started, "send_started_at": started, "finished_at": None,
                    "status": "unknown", "capability": "unverified", "category": None,
                    "request_id": None, "http_status": None, "error_code": None,
                    "reason": "reserved_before_send_completion_unknown", "usage": None,
                    "result_metadata": None, "request_may_have_been_sent": True,
                    "request_metadata": {"n": 1, "size": request["size"], "quality": "low",
                                         "output_format": "gif" if feature == "native_gif" else "png",
                                         "frame_count": 2 if feature == "native_gif" else None,
                                         "frame_duration_ms": 200 if feature == "native_gif" else None,
                                         "input_sha256": hashlib.sha256(fixture).hexdigest(),
                                         "sdk_extra_body_fields": sorted(request.get("extra_body", {}))},
                }
                path = directory / "operations" / (feature + ".json")
                # Exclusive, durable reservation BEFORE the one SDK invocation.
                _exclusive_bytes(path, _json_bytes(record))
                report["budget_used"] += 1
                report["live_requests_sent"] += 1
                try:
                    response = client.images.edit(**request)
                except Exception as error:
                    record.update(classify_error(error))
                    record["reason"] = "request_failed_no_retry" if record["status"] == "failed" else "completion_unknown_no_retry"
                else:
                    record["request_id"] = safe_request_id(_field(response, "_request_id"))
                    record["usage"] = _usage(response)
                    try:
                        record["result_metadata"] = _result(response, feature=feature, directory=directory)
                        record.update(status="succeeded", capability="supported", category=None, reason="validated_output")
                    except Exception as error:
                        record.update(status="unknown", capability="unverified", category="invalid_response",
                                      reason=str(error) if isinstance(error, ConfigurationError) else "result_not_saved_no_retry")
                record["finished_at"] = now()
                _replace_json(path, record)
                report["operations"].append(record)
                report["capabilities"][feature] = record["capability"]
                if record["status"] != "succeeded":
                    report["stop_reason"] = "request_failure_or_unknown_no_retry"
                    break
            if report["stop_reason"] is None:
                report["stop_reason"] = "completed" if all(feature in {op["feature"] for op in report["operations"]} for feature in selected) else "request_budget_exhausted"
    except ConfigurationError as error:
        report["stop_reason"] = str(error)
    except OSError:
        report["stop_reason"] = "local_io_failure_no_retry"
    except Exception:
        # SDK setup or an unexpected local failure must not expose exception
        # payloads, try a fallback, or bypass a reservation already on disk.
        report["stop_reason"] = "local_probe_error_no_retry"
    finally:
        if client is not None:
            close = getattr(client, "close", None)
            if close:
                try:
                    close()
                except Exception:
                    pass
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="inspect local configuration only (default)")
    mode.add_argument("--live", action="store_true", help="explicitly allow billable probe requests")
    parser.add_argument("--max-requests", "--maxRequests", type=int, choices=(1, 2))
    parser.add_argument("--session-dir", type=Path)
    parser.add_argument("--model", help="explicit GPT Image model; no automatic fallback")
    parser.add_argument("--feature", choices=FEATURES, action="append")
    parser.add_argument("--key-file", type=Path, help="private API-key file outside the repository")
    args = parser.parse_args(argv)
    if args.live and (args.max_requests is None or args.session_dir is None or args.model is None):
        parser.error("--live requires --max-requests, --session-dir, and --model")
    if not args.live:
        report = environment_report(key_file=args.key_file)
    else:
        try:
            report = run_probe(session_dir=args.session_dir, model=args.model, max_requests=args.max_requests,
                               features=args.feature or FEATURES, live=True, key_file=args.key_file)
        except ConfigurationError as error:
            report = {"capabilities": {feature: "unverified" for feature in FEATURES}, "stop_reason": str(error), "live_requests_sent": 0}
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if not args.live or report.get("stop_reason") in {"completed", "already_recorded_no_retry", "request_budget_exhausted"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
