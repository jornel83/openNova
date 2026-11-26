"""SSH transport for durable Spark Minimax H3 Image operations."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

from PIL import Image, ImageOps
from tools.image.operations import MAX_INPUT_BYTES, OperationError, sha

HERE = Path(__file__).resolve().parent
PROFILE = ("generate.py", "portrait_stage.py", "edit_probe.py", "portrait_pipeline.json")
SQUARE = "2048x2048"
PORTRAIT = "864x1536"
NATIVE_SIZES = {SQUARE: (2048, 2048), PORTRAIT: (864, 1536)}


def host():
    return _hostname(os.environ.get("OPENNOVA_SPARK_SSH_HOST", "agent-gpu"))


def _hostname(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9@._-]{0,250}", value):
        raise OperationError("invalid_spark_image_host")
    return value


def _directory(task_id):
    if not isinstance(task_id, str) or not re.fullmatch(r"h3-image-[0-9a-f]{32}", task_id):
        raise OperationError("invalid_spark_image_task")
    return "opennova-image/" + task_id


def revision():
    parts = [HERE / "spark_worker.py", *(HERE / "spark_profile" / name for name in PROFILE)]
    return hashlib.sha256("".join(sha(p) for p in (Path(__file__), *parts)).encode()).hexdigest()


def prepare_reference(snapshot, requested_size):
    """Select a deployed edit geometry and normalize a single frozen reference to its input size."""
    with Image.open(snapshot) as source:
        upright = ImageOps.exif_transpose(source)
        width, height = upright.size
        tolerance = max(1, 0.005 * width)
        if abs(width - height * 9 / 16) <= tolerance:
            native, input_size = PORTRAIT, (720, 1280)
        elif abs(width - height) <= tolerance:
            native, input_size = SQUARE, (1024, 1024)
        else:
            raise OperationError("unsupported_spark_reference_aspect_ratio")
        if requested_size not in (None, native):
            raise OperationError("spark_reference_size_mismatch")
        if upright.size == input_size and source.format == "PNG" and source.getexif().get(274, 1) == 1:
            return Path(snapshot).read_bytes(), native
        image = upright.convert("RGB").resize(input_size, Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, "PNG")
        return buffer.getvalue(), native


def _ssh(hostname, command, body=b"", *, output=None):
    try:
        proc = subprocess.run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                               "--", _hostname(hostname), command], input=body, timeout=60,
                              stdout=output if output is not None else subprocess.PIPE,
                              stderr=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        raise OSError("Spark image SSH unavailable") from None
    if proc.returncode:
        raise OSError("Spark image SSH unsuccessful")
    if output is None:
        try:
            response = json.loads(proc.stdout)
        except (UnicodeDecodeError, ValueError):
            raise OSError("Invalid Spark image response") from None
        if not isinstance(response, dict):
            raise OSError("Invalid Spark image response")
        return response


def submit(hostname, task_id, mode, prompt, reference):
    directory = _directory(task_id)
    encoded = prompt.encode("utf-8")
    job = dict(id=task_id, mode=mode, promptSha256=hashlib.sha256(encoded).hexdigest(),
               referenceSha256=hashlib.sha256(reference).hexdigest() if reference is not None else None)
    files = {"worker.py": (HERE / "spark_worker.py").read_bytes(), "job.json": json.dumps(job).encode(),
             "prompt.txt": encoded}
    files.update({"profile/" + name: (HERE / "spark_profile" / name).read_bytes() for name in PROFILE})
    if reference is not None:
        files["reference.png"] = reference
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as tar:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode = len(data), 0o600
            tar.addfile(entry, io.BytesIO(data))
    # Serialize start and status. Only this host-created task ID enters the command;
    # user data, paths and the prompt are passed as file contents.
    cmd = (f"umask 077 && mkdir -p opennova-image && mkdir {directory} && cd {directory} && "
           "exec 9>dispatch.lock && flock -x 9 && mkdir profile && tar -xf - && python3 -B worker.py start")
    return _ssh(hostname, cmd, archive.getvalue())


def status(hostname, task_id):
    directory = _directory(task_id)
    # A visible directory may still be uploading/downloading the submitted archive.
    queued = json.dumps({"id": task_id, "status": "submitting"})
    missing = json.dumps({"id": task_id, "status": "missing"})
    cmd = (f"if [ ! -d {directory} ]; then echo '{missing}'; else cd {directory} && "
           f"if [ -f dispatch.lock ] && ! flock -n dispatch.lock true; then echo '{queued}'; "
           f"elif [ -f state.json ]; then python3 -B worker.py status; else echo '{missing}'; fi; fi")
    return _ssh(hostname, cmd)


def download(hostname, task_id, destination, expected_bytes):
    directory = _directory(task_id)
    if type(expected_bytes) is not int or not 0 < expected_bytes <= MAX_INPUT_BYTES:
        raise OperationError("invalid_generated_image")
    with destination.open("wb") as output:
        _ssh(hostname, f"cd {directory} && test $(wc -c < output.png) -eq {expected_bytes} && "
                       f"head -c {expected_bytes} output.png", output=output)
        output.flush()
        os.fsync(output.fileno())
