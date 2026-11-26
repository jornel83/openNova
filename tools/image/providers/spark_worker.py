"""Spark-side detached supervisor for one OpenNova Minimax H3 Image job."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import traceback


STATE = Path("state.json")


def write_state(job, status, **details):
    state = {**job, "status": status, **details}
    tmp = STATE.with_suffix(".next")
    with tmp.open("w") as output:
        json.dump(state, output)
        output.flush()
        os.fsync(output.fileno())
    tmp.replace(STATE)
    parent = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    return state


def start(job):
    with open("supervisor.lock", "x") as lease, open("worker.log", "xb") as log:
        fcntl.flock(lease, fcntl.LOCK_EX)
        queued = write_state(job, "queued")
        try:
            subprocess.Popen([sys.executable, "-B", __file__, "run"], stdin=subprocess.DEVNULL,
                             stdout=log, stderr=log, start_new_session=True, pass_fds=(lease.fileno(),))
        except OSError:
            return write_state(job, "failed", reason="spark_image_worker_start_failed")
        return queued


def status(job):
    with open("supervisor.lock", "r") as lease:
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return json.loads(STATE.read_text())
        state = json.loads(STATE.read_text())
        if state["status"] in ("queued", "running"):
            return write_state(job, "failed", reason="spark_image_worker_interrupted")
        return state


def run(job):
    try:
        sys.path.insert(0, str(Path("profile").resolve()))
        import generate as profile
        prompt = Path("prompt.txt").read_bytes()
        ref = Path("reference.png").resolve() if job["mode"] == "edit" else None
        if (hashlib.sha256(prompt).hexdigest() != job["promptSha256"] or
                (ref and hashlib.sha256(ref.read_bytes()).hexdigest() != job["referenceSha256"])):
            raise ValueError("Spark input digest mismatch")
        image = profile.run(job["id"], prompt.decode("utf-8"), ref, lambda: write_state(job, "running"))
        # The profile releases its GPU locks after validating the PNG and FA4 execution.
        target = Path("output.png")
        os.link(image, target)
        with target.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
            os.fsync(stream.fileno())
        return write_state(job, "succeeded", bytes=target.stat().st_size, sha256=digest)
    except Exception as error:
        traceback.print_exc()
        if isinstance(error, BlockingIOError):
            reason = "spark_image_gpu_reserved"
        elif isinstance(error, FileNotFoundError) or "source revision changed:" in str(error):
            reason = "spark_image_deployment_unavailable"
        elif "PSI" in str(error) or "GiB startup threshold" in str(error):
            reason = "spark_image_memory_pressure"
        else:
            reason = "spark_image_generation_failed"
        return write_state(job, "failed", reason=reason)


if __name__ == "__main__":
    job = json.loads(Path("job.json").read_text())
    if (not re.fullmatch(r"h3-image-[0-9a-f]{32}", job["id"]) or
            job["id"] != Path.cwd().name or job["mode"] not in ("edit", "create")):
        raise ValueError("Invalid Spark image job")
    result = {"start": start, "status": status, "run": run}[sys.argv[1]](job)
    print(json.dumps(result), flush=True)
