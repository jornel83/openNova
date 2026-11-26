"""Ark M0: one image edit and one 4-second video, offline unless --live.

--poll performs one GET of the saved video task and never submits a generation.
Reuse the original session directory and budget. Unknown or failed POSTs cannot
be retried. GIF encoding is a separate local export, not a native model feature.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any, Mapping, Sequence
import uuid

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.image.probe import (
    REPO_ROOT, _directory, _exclusive_bytes, _json_bytes, _read_json, _replace_json,
    _session_lock, _sync_directory, environment_report as _local_environment, now,
)
from tools.image.providers.ark_provider import (
    API_BASE, FEATURES, IMAGE_MODEL, VIDEO_MODEL, ArkClient, ConfigurationError,
    ProviderError, error_from_response, fixture_requests, request_id, resolve_credential, unlink_owned,
)


def environment_report(repo_root=None, key_file=None, environ: Mapping[str, str] | None = None):
    report = _local_environment(environ={})
    report["dependencies"].pop("openai", None)
    report.update(provider="volcengine_ark", endpoint=API_BASE, http_client="python_stdlib",
                  capabilities={"seedream_edit": "unverified", "seedance_video": "unverified", "video_to_gif": "unverified"},
                  gif_route="seedance_video_then_local_export", native_gif_documented=False)
    report.pop("gif_requires_model_preview_access", None)
    try:
        credential = resolve_credential(repo_root=Path(repo_root or REPO_ROOT), key_file=key_file, environ=environ)
        report["credentials"] = {"status": "configured" if credential else "missing",
                                 "source": credential.source if credential else None,
                                 "scope": credential.scope if credential else None, "error": None}
    except ConfigurationError as error:
        report["credentials"] = {"status": "invalid", "source": None, "scope": None, "error": str(error)}
    return report


def _fixture():
    from PIL import Image, ImageDraw
    image = Image.new("RGB", (512, 512), "white")
    ImageDraw.Draw(image).ellipse((128, 128, 384, 384), fill=(45, 100, 220))
    stream = io.BytesIO()
    image.save(stream, "PNG")
    return stream.getvalue()


def _usage(body):
    value = body.get("usage")
    if not isinstance(value, dict):
        return None
    return {name: item if type(item) is int and item >= 0 else None
            for name in ("input_tokens", "output_tokens", "completion_tokens", "total_tokens", "generated_images")
            for item in (value.get(name),)}


def _image_result(body, directory):
    from PIL import Image
    data = body.get("data")
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        raise ConfigurationError("invalid_image_result_count")
    encoded = data[0].get("b64_json")
    if not isinstance(encoded, str) or len(encoded) > 44 * 1024 * 1024:
        raise ConfigurationError("invalid_image_base64_result")
    try:
        content = base64.b64decode(encoded, validate=True)
        with Image.open(io.BytesIO(content)) as image:
            image.verify()
        with Image.open(io.BytesIO(content)) as image:
            image.load()
            if image.format != "PNG" or image.size != (1024, 1024) or getattr(image, "n_frames", 1) != 1:
                raise ValueError
    except Exception:
        raise ConfigurationError("image_output_validation_failed") from None
    artifact = "artifacts/seedream_edit.png"
    _exclusive_bytes(directory / artifact, content)
    return {"artifact": artifact, "format": "png", "width": 1024, "height": 1024, "frame_count": 1,
            "byte_count": len(content), "sha256": hashlib.sha256(content).hexdigest(), "fully_decoded": True}


def validate_video(path: Path):
    """Read metadata and decode the whole downloaded video before claiming support."""
    ffprobe, ffmpeg = shutil.which("ffprobe"), shutil.which("ffmpeg")
    if not ffprobe or not ffmpeg:
        raise ConfigurationError("ffmpeg_and_ffprobe_required_for_video_validation")
    env = {"PATH": os.defpath, "LC_ALL": "C"}
    local_input = ["-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0"]
    try:
        with path.open("rb") as file:
            if file.read(8)[4:8] != b"ftyp":
                raise ValueError
        probe = subprocess.run([ffprobe, "-v", "error", *local_input, "-show_streams", "-show_format", "-of", "json", str(path)],
                               capture_output=True, text=True, timeout=15, check=False, env=env)
        if probe.returncode:
            raise ValueError
        details = json.loads(probe.stdout)
        streams = [item for item in details.get("streams", []) if item.get("codec_type") == "video"]
        if len(streams) != 1:
            raise ValueError
        stream = streams[0]
        width, height = int(stream["width"]), int(stream["height"])
        duration = float(details["format"]["duration"])
        if not (0 < width <= 4096 and 0 < height <= 4096 and math.isfinite(duration) and 3.5 <= duration <= 5.1):
            raise ValueError
        decoded = subprocess.run([ffmpeg, "-v", "error", "-xerror", "-nostdin", *local_input, "-i", str(path), "-f", "null", "-"],
                                 capture_output=True, timeout=60, check=False, env=env)
        if decoded.returncode:
            raise ValueError
        numerator, denominator = stream.get("avg_frame_rate", "0/1").split("/")
        fps = int(numerator) / int(denominator)
        if not math.isfinite(fps) or fps <= 0:
            raise ValueError
        frames = stream.get("nb_frames")
        frames = int(frames) if isinstance(frames, str) and frames.isdigit() else None
        return {"format": "mp4", "width": width, "height": height, "duration_seconds": duration,
                "frame_count": frames, "fps": fps, "byte_count": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "fully_decoded": True}
    except (OSError, ValueError, TypeError, KeyError, ZeroDivisionError, subprocess.TimeoutExpired):
        raise ConfigurationError("video_output_validation_failed") from None


def _verify_saved_artifact(record, directory, video_validator):
    metadata = record.get("result_metadata")
    expected = "artifacts/seedream_edit.png" if record["feature"] == "seedream_edit" else "artifacts/seedance_video.mp4"
    if not isinstance(metadata, dict) or metadata.get("artifact") != expected:
        raise ConfigurationError("saved_artifact_metadata_invalid")
    path = directory / expected
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size != metadata.get("byte_count"):
            raise ValueError
        if hashlib.sha256(path.read_bytes()).hexdigest() != metadata.get("sha256"):
            raise ValueError
        if record["feature"] == "seedance_video":
            video_validator(path)
        else:
            from PIL import Image
            with Image.open(path) as image:
                image.load()
                if image.format != "PNG" or image.size != (1024, 1024) or getattr(image, "n_frames", 1) != 1:
                    raise ValueError
    except Exception:
        raise ConfigurationError("saved_artifact_missing_or_changed") from None


def _failure(record, error):
    if isinstance(error, ProviderError):
        record.update(status="unknown" if error.outcome_unknown else "failed", category=error.category,
                      capability="unsupported" if error.category == "unsupported" else "unverified",
                      reason=error.reason, http_status=error.status_code, error_code=error.error_code,
                      request_id=error.request_id)
    elif isinstance(error, ConfigurationError):
        record.update(status="unknown", category="invalid_response", capability="unverified", reason=str(error))
    else:
        record.update(status="unknown", category="transient", capability="unverified", reason="completion_unknown_no_retry")
    record["finished_at"] = now()


def _poll_video(client, record, record_path, directory, report, video_validator, secret):
    """One status GET at most. Failed downloads can resume the same task only."""
    destination = directory / "artifacts/seedance_video.mp4"
    expected = record.get("result_metadata")
    if destination.exists() and isinstance(expected, dict):
        actual = video_validator(destination)
        if actual["sha256"] != expected.get("sha256") or actual["byte_count"] != expected.get("byte_count"):
            raise ConfigurationError("saved_video_artifact_changed")
        record.update(status="succeeded", capability="supported", category=None, reason="recovered_verified_video", finished_at=now())
        _replace_json(record_path, record)
        return
    report["status_requests_this_run"] += 1
    report["network"] = "attempted"
    try:
        response = client.get_video(record["task_id"])
    except Exception as error:
        # The task ID is durable: GET failures do not make another POST safe.
        record.update(category=error.category if isinstance(error, ProviderError) else "transient",
                      reason="status_query_failed_resume_same_task", last_polled_at=now())
        _replace_json(record_path, record)
        return
    body = response.body
    state = body.get("status")
    record.update(last_polled_at=now(), last_status_request_id=request_id({"x-request-id": response.request_id}, secret))
    if body.get("id") not in (None, record["task_id"]):
        record.update(reason="status_task_identity_mismatch", category="invalid_response")
    elif state in {"queued", "running"}:
        record.update(status="pending", provider_status=state, reason="video_pending_poll_required", category=None)
    elif state in {"failed", "cancelled", "expired"}:
        failure = error_from_response(400, body, identifier=response.request_id)
        if failure.error_code and secret in failure.error_code:
            failure.error_code = None
        record.update(status="failed", provider_status=state, category=failure.category, error_code=failure.error_code,
                      reason="video_task_" + state, capability="unverified", finished_at=now(), usage=_usage(body))
    elif state == "succeeded":
        record.update(status="pending_download", provider_status="succeeded", usage=_usage(body),
                      reason="video_download_pending", category=None)
        _replace_json(record_path, record)
        content = body.get("content")
        url = content.get("video_url") if isinstance(content, dict) else None
        temporary = directory / "artifacts" / (".seedance_video-" + uuid.uuid4().hex + ".mp4")
        owner = None
        try:
            report["downloads_this_run"] += 1
            owner = client.download_video(url, temporary)
            if owner is None:  # Injectable test adapters may not return ownership.
                info = temporary.lstat()
                owner = (info.st_dev, info.st_ino)
            metadata = {**video_validator(temporary), "artifact": "artifacts/seedance_video.mp4"}
            # Save the verified hash before publishing so a crash is recoverable.
            record["result_metadata"] = metadata
            _replace_json(record_path, record)
            info = temporary.lstat()
            if temporary.is_symlink() or (info.st_dev, info.st_ino) != owner:
                raise ConfigurationError("video_staging_artifact_changed")
            os.link(temporary, destination)  # Never replaces a user file.
            _sync_directory(destination.parent)
            record.update(status="succeeded", capability="supported", category=None,
                          reason="validated_video_local_gif_export_pending", finished_at=now())
        except Exception as error:
            record.update(status="pending_download", capability="unverified", category="download",
                          reason=error.reason if isinstance(error, ProviderError) else (
                              str(error) if isinstance(error, ConfigurationError) else "video_download_or_publish_failed"))
        finally:
            unlink_owned(temporary, owner)
    else:
        record.update(reason="unknown_provider_task_status", category="invalid_response")
    _replace_json(record_path, record)


def run_probe(*, session_dir, image_model=IMAGE_MODEL, video_model=VIDEO_MODEL, max_requests=2,
              features: Sequence[str] = FEATURES, live=False, poll=False, repo_root=None, key_file=None,
              environ=None, client_factory=None, video_validator=validate_video):
    if type(max_requests) is not int or max_requests not in (1, 2):
        raise ConfigurationError("max_requests_must_be_1_or_2")
    selected = tuple(features)
    if not selected or len(set(selected)) != len(selected) or any(item not in FEATURES for item in selected):
        raise ConfigurationError("select_each_known_feature_at_most_once")
    report = environment_report(repo_root, key_file, environ)
    report.update(mode="poll" if poll else ("live" if live else "check"), image_model=image_model,
                  video_model=video_model, operations=[], budget_limit=max_requests, budget_used=0,
                  status_requests_this_run=0, downloads_this_run=0, stop_reason=None,
                  network_scope="current_invocation")
    if not live:
        report["stop_reason"] = "live_opt_in_required"
        return report
    if report["credentials"]["status"] != "configured":
        report["stop_reason"] = "credentials_" + report["credentials"]["status"]
        return report
    credential = resolve_credential(repo_root=Path(repo_root or REPO_ROOT), key_file=key_file, environ=environ)
    directory = Path(session_dir).expanduser().absolute()
    client = None
    try:
        if poll and not (directory / "session.json").exists():
            report["stop_reason"] = "no_saved_session_to_poll"
            return report
        fixture = _fixture()
        requests = fixture_requests(fixture, image_model=image_model, video_model=video_model)
        _directory(directory)
        with _session_lock(directory):
            for name in ("operations", "inputs", "artifacts"):
                _directory(directory / name)
            identity = {"schema_version": 1, "provider": "volcengine_ark", "credential_scope": credential.scope,
                        "image_model": image_model, "video_model": video_model, "max_requests": max_requests, "endpoint": API_BASE}
            session_file = directory / "session.json"
            if session_file.exists():
                session = _read_json(session_file)
                if any(session.get(key) != value for key, value in identity.items()):
                    raise ConfigurationError("session_identity_or_budget_mismatch")
            else:
                if any((directory / "operations").iterdir()):
                    raise ConfigurationError("operations_without_session_no_requests_sent")
                _exclusive_bytes(session_file, _json_bytes({**identity, "created_at": now()}))
            fixture_path = directory / "inputs/fixture.png"
            if fixture_path.exists():
                if fixture_path.is_symlink() or fixture_path.read_bytes() != fixture:
                    raise ConfigurationError("saved_fixture_changed")
            else:
                _exclusive_bytes(fixture_path, fixture)
            existing = {}
            paths = sorted((directory / "operations").iterdir(),
                           key=lambda path: FEATURES.index(path.stem) if path.stem in FEATURES else len(FEATURES))
            report["budget_used"] = len(paths)
            for path in paths:
                if path.name not in {item + ".json" for item in FEATURES}:
                    raise ConfigurationError("unexpected_operation_record_no_requests_sent")
                record = _read_json(path)
                if (record.get("feature") != path.stem or record.get("credential_scope") != credential.scope
                        or record.get("model") != requests[path.stem]["model"]
                        or record.get("status") not in {"unknown", "failed", "pending", "pending_download", "succeeded"}):
                    raise ConfigurationError("operation_identity_or_state_invalid")
                existing[path.stem] = record
                report["operations"].append(record)
                if record["status"] == "succeeded":
                    try:
                        _verify_saved_artifact(record, directory, video_validator)
                    except ConfigurationError as error:
                        record.update(status="unknown", capability="unverified", category="artifact",
                                      reason=str(error), artifact_integrity="failed")
                        _replace_json(path, record)
                        raise
            if poll:
                record = existing.get("seedance_video")
                if record is None or not record.get("task_id"):
                    report["stop_reason"] = "no_saved_task_id_no_resubmit"
                elif record["status"] in {"pending", "pending_download"}:
                    client = (client_factory or ArkClient)(credential)
                    _poll_video(client, record, directory / "operations/seedance_video.json", directory, report, video_validator, credential.secret)
                    report["stop_reason"] = "completed" if record["status"] == "succeeded" else record["reason"]
                else:
                    report["stop_reason"] = "terminal_task_no_resubmit"
            elif any(record["status"] in {"failed", "unknown"} for record in existing.values()):
                report["stop_reason"] = "prior_failure_or_unknown_no_retry"
            elif any(record["status"] in {"pending", "pending_download"} for record in existing.values()):
                report["stop_reason"] = "video_pending_poll_required"
            else:
                pending = [feature for feature in selected if feature not in existing]
                if not pending:
                    report["stop_reason"] = "already_recorded_no_retry"
                for feature in pending:
                    if report["budget_used"] >= max_requests:
                        report["stop_reason"] = "request_budget_exhausted"
                        break
                    if feature == "seedance_video" and video_validator is validate_video and (not shutil.which("ffmpeg") or not shutil.which("ffprobe")):
                        raise ConfigurationError("ffmpeg_and_ffprobe_required_before_video_post")
                    if client is None:
                        client = (client_factory or ArkClient)(credential)
                    record = {"schema_version": 1, "provider": "volcengine_ark", "feature": feature,
                              "model": requests[feature]["model"], "credential_scope": credential.scope,
                              "status": "unknown", "capability": "unverified", "category": None,
                              "reason": "reserved_before_post_completion_unknown", "created_at": now(),
                              "post_started_at": now(), "finished_at": None, "last_polled_at": None,
                              "request_id": None, "http_status": None, "error_code": None,
                              "task_id": None, "provider_status": None, "usage": None, "result_metadata": None,
                              "request_may_have_been_sent": True,
                              "request_metadata": {"input_sha256": hashlib.sha256(fixture).hexdigest(),
                                  "input_artifact": "inputs/fixture.png", "output_format": "png" if feature == "seedream_edit" else "mp4",
                                  "size": "1024x1024" if feature == "seedream_edit" else None,
                                  "duration": 4 if feature == "seedance_video" else None,
                                  "resolution": "480p" if feature == "seedance_video" else None,
                                  "role": "first_frame" if feature == "seedance_video" else None,
                                  "ratio": "adaptive" if feature == "seedance_video" else None,
                                  "generate_audio": False if feature == "seedance_video" else None}}
                    path = directory / "operations" / (feature + ".json")
                    _exclusive_bytes(path, _json_bytes(record))
                    report["operations"].append(record)
                    report["budget_used"] += 1
                    report["live_requests_sent"] += 1
                    # This records the attempt even if HTTP rejects the request,
                    # the connection fails, or the response cannot be decoded.
                    report["network"] = "attempted"
                    try:
                        method = client.create_image if feature == "seedream_edit" else client.create_video
                        response = method(requests[feature])
                        record.update(request_id=request_id({"x-request-id": response.request_id}, credential.secret),
                                      http_status=response.status_code, usage=_usage(response.body))
                        if feature == "seedream_edit":
                            record["result_metadata"] = _image_result(response.body, directory)
                            record.update(status="succeeded", capability="supported", reason="validated_image", finished_at=now())
                        else:
                            task_id = response.body.get("id")
                            if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id) or credential.secret in task_id:
                                raise ConfigurationError("video_post_missing_task_id_no_retry")
                            record.update(status="pending", task_id=task_id, reason="video_pending_poll_required")
                    except Exception as error:
                        _failure(record, error)
                    _replace_json(path, record)
                    if record["status"] != "succeeded":
                        report["stop_reason"] = record["reason"]
                        break
                if report["stop_reason"] is None:
                    report["stop_reason"] = "completed"
    except ConfigurationError as error:
        report["stop_reason"] = str(error)
    except OSError:
        report["stop_reason"] = "local_io_failure_no_retry"
    except Exception:
        report["stop_reason"] = "local_probe_error_no_retry"
    finally:
        for record in report["operations"]:
            report["capabilities"][record["feature"]] = record.get("capability", "unverified")
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--live", action="store_true")
    parser.add_argument("--poll", action="store_true", help="query the saved video task once; never submit")
    parser.add_argument("--session-dir", type=Path)
    parser.add_argument("--image-model")
    parser.add_argument("--video-model")
    parser.add_argument("--max-requests", "--maxRequests", type=int, choices=(1, 2))
    parser.add_argument("--feature", choices=FEATURES, action="append")
    parser.add_argument("--key-file", type=Path)
    args = parser.parse_args(argv)
    if args.live and any(value is None for value in (args.session_dir, args.image_model, args.video_model, args.max_requests)):
        parser.error("--live requires --session-dir, --image-model, --video-model, and --max-requests")
    if args.poll and not args.live:
        parser.error("--poll requires --live to enable the status GET")
    if not args.live:
        report = environment_report(key_file=args.key_file)
    else:
        try:
            report = run_probe(session_dir=args.session_dir, image_model=args.image_model, video_model=args.video_model,
                               max_requests=args.max_requests, features=args.feature or FEATURES,
                               live=True, poll=args.poll, key_file=args.key_file)
        except ConfigurationError as error:
            report = {"stop_reason": str(error), "live_requests_sent": 0}
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 2 if report.get("stop_reason") in {"credentials_missing", "credentials_invalid", "local_probe_error_no_retry"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
