"""Run one guarded square generation or portrait edit against the installed Spark deployment."""
from contextlib import ExitStack
import fcntl
import hashlib
import json
from math import floor
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time

from PIL import Image

# This isolated job uses the deployed runner and its original locks, PSI monitor, and image digest.
# Refuse to mix this specialized geometry with other deployment revisions.
INSTALLED = Path.home() / "h3-image-deploy" / "build"
BASE_SHA256 = {
    'fa4_2k_probe.py': '0f04482fb3ca40700172c06ac8adaa8ea71bfde43514147adc2230b6005293d5',
    'run_window_2k_fa4.py': '8f03583bc4e064ae8b95b183ec57292984b719d4303f75b37c98839dc31e068b',
    'run_window_2k_custom.py': 'd60f3dddfb5b2983389d594d9b544d5526d681c003c8581d469813cdcfd606a9',
    'run_window_2k_edit.py': 'ac11bc788ab2d16ccfb53ce4d40f4303428de615062b0b01296b845a3ecec480',
    'run_window_2k_edit_stage.py': '309b51836ddd49f384e4bd4fd459bf87a126d8720f9a122ee4b8c3ff0b05a060',
    'fa4_2k_edit_probe.py': 'a8867a59b804c786508b234897a5acb3f9b35f77650b673544426893699ca67c',
    'run_window_2k_dit_fa4.py': '2509038652c78f43c9bfb74e1f9075a02fcfb751029058ab9b7b7879f132cf79',
    'h3_image_psi_confirm.py': '6bf0188d46db41554ed650247fe5c77fd43fda61dcdb4c03d64c9f74c1b25014',
    'inspect_digest.py': '459870bc9cf0fd034bb6d052b98cb3a08450a29e1ca1bfb66c3b91fdd8a0c4c2',
}
for name, expected in BASE_SHA256.items():
    if hashlib.sha256((INSTALLED / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError("deployed source revision changed: " + name)
sys.path.insert(1, str(INSTALLED))
HERE = Path(__file__).resolve().parent

import run_window_2k_custom as square
import run_window_2k_edit as square_edit
import run_window_2k_dit_fa4 as image_runner
import portrait_stage as edit_runner
from run_window_2k_dit_fa4 import IMAGE, LOCKS, PROBE, ROOT, command, gpu_processes, p2_state

MODEL = "/models/MiniMax-H3-Image"
EDIT_PROBE = edit_runner.EDIT_PROBE
IMAGE_LABEL = "org.h3-image.run"
RUN_SECONDS = 900
RELEASE_SECONDS = 120


def prepare_geometry(run_id, out, prompt, reference, deadline):
    """Read locked model metadata and tokenize a prompt in a bounded CPU container."""
    model_root = ROOT / "models" / "MiniMax-H3-Image"
    (out / "sampling.json").write_text(json.dumps({"prompt": prompt, "width": 864, "height": 1536, "min_generation_area": 864 * 1536}, ensure_ascii=False), encoding="utf-8")
    args = [
        "docker", "create", "--name", run_id, "--network", "none", "--runtime", "runc",
        "--restart", "no", "--label", f"{IMAGE_LABEL}={run_id}", "--pids-limit", "2048",
        "--memory", "5g", "--memory-swap", "5g", "--cpus", "4",
        "-e", "CUDA_VISIBLE_DEVICES=", "-e", "HF_HUB_OFFLINE=1", "-e", "PYTHONDONTWRITEBYTECODE=1",
        "-v", f"{ROOT}/build/fa4_2k_probe.py:{PROBE}:ro",
        "-v", f"{HERE}/edit_probe.py:{EDIT_PROBE}:ro",
        "-v", f"{HERE}/portrait_pipeline.json:/portrait_pipeline.json:ro",
        "-v", f"{reference}:/reference.png:ro", "-v", f"{out}:/run-output",
        "-v", f"{ROOT}/models/MiniMax-H3/text_encoder/config.json:/models/MiniMax-H3/text_encoder/config.json:ro",
    ]
    for entry in ("tokenizer", "processor", "model_index.json", "transformer/config.json"):
        source = model_root / entry
        if not source.exists():
            raise RuntimeError(f"missing model metadata: {source}")
        args += ["-v", f"{source}:{MODEL}/{entry}:ro"]
    args += [
        "--entrypoint", "python3", IMAGE, EDIT_PROBE, "geometry", "--model-root", MODEL,
        "--sampling", "/run-output/sampling.json", "--reference", "/reference.png",
        "--output", "/run-output/fa4-geometry.json",
    ]
    (out / "request.json").write_text(json.dumps({"args": args}, indent=2))
    cid = command(*args, timeout=45)
    if not re.fullmatch(r"[0-9a-f]{64}", cid):
        raise RuntimeError("invalid CPU geometry container identity")
    (out / "cid").write_text(cid)
    cutoff = run_id + "-cutoff"
    try:
        seconds = floor(deadline - time.monotonic())
        if seconds < 1:
            raise RuntimeError("shared window exhausted before tokenization")
        command("systemd-run", "--user", "--collect", f"--unit={cutoff}", f"--on-active={seconds}s",
                "--timer-property=AccuracySec=1s", "/usr/bin/docker", "stop", "-t", "8", cid)
        command("systemctl", "--user", "is-active", cutoff + ".timer")
        command("docker", "start", cid, timeout=45)
        code = command("docker", "wait", cid, timeout=max(1, deadline - time.monotonic()) + 10)
        if code != "0":
            raise RuntimeError(f"CPU geometry container exit {code}")
    finally:
        if command("docker", "inspect", "-f", "{{.State.Running}}", cid) == "true":
            command("docker", "stop", "-t", "8", cid, timeout=25)
        with (out / "container.log").open("w") as log:
            subprocess.run(["docker", "logs", cid], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=25)
        (out / "exit.json").write_text(command("docker", "inspect", "-f", "{{json .State}}", cid))
        command("docker", "rm", cid)
        subprocess.run(["systemctl", "--user", "stop", cutoff + ".timer"], capture_output=True, timeout=10)
    geometry = out / "fa4-geometry.json"
    payload = json.loads(geometry.read_text())
    if payload["prompt_sha256"] != hashlib.sha256(prompt.encode("utf-8")).hexdigest():
        raise RuntimeError("CPU geometry prompt differs from the generation request")
    return geometry


def run(run_id, prompt, reference_path, on_running):
    if socket.gethostname() != "spark-469e":
        raise RuntimeError("this entry point must run on Spark")
    out = ROOT / "runs" / run_id
    out.mkdir(exist_ok=False)
    with ExitStack() as stack:
        for index, name in enumerate(LOCKS):
            fd = os.open(Path.home() / "h3-deploy" / name, os.O_RDONLY | os.O_NOFOLLOW)
            stack.callback(os.close, fd)
            # The first lock is shared with OpenNova video jobs. Wait there once,
            # then respect any independent maintenance reservation on the other locks.
            fcntl.flock(fd, fcntl.LOCK_EX if index == 0 else fcntl.LOCK_EX | fcntl.LOCK_NB)
        on_running()
        start = time.monotonic()
        deadline = start + RUN_SECONDS
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        admission = (boot, p2_state())
        if gpu_processes() or command("docker", "ps", "-q") or image_runner.available_memory() < 106:
            raise RuntimeError("Spark is busy or below the 106 GiB startup threshold")
        (out / "window.json").write_text(json.dumps({
            "boot": boot, "p2_finished_at": admission[1], "start_monotonic_seconds": start,
            "cutoff_monotonic_seconds": deadline, "exclusive_seconds": RUN_SECONDS + RELEASE_SECONDS,
            "image": IMAGE,
        }))
        cpu = out / "geometry"
        cpu.mkdir()
        if reference_path is None:
            geometry = square.prepare_geometry(run_id + "-geometry", cpu, prompt, deadline)
            warm_stage = square.warm_runner.run
            warm_mode = "fa4-warm"
            final_stage = image_runner.run
            extra = {}
        else:
            reference = out / "reference.png"
            shutil.copyfile(reference_path, reference)
            with Image.open(reference) as image:
                is_square = image.size == (1024, 1024)
                if not is_square and image.size != (720, 1280):
                    raise ValueError("unexpected Spark edit reference size")
            geometry_stage = square_edit.prepare_geometry if is_square else prepare_geometry
            stages = square_edit.edit_runner if is_square else edit_runner
            geometry = geometry_stage(run_id + "-geometry", cpu, prompt, reference, deadline)
            if json.loads(geometry.read_text())["reference_sha256"] != hashlib.sha256(reference.read_bytes()).hexdigest():
                raise RuntimeError("CPU geometry reference differs from the staged reference")
            warm_stage = stages.run
            warm_mode = "warm"
            final_stage = stages.run
            extra = {"reference": reference}
        geometry_payload = json.loads(geometry.read_text())
        cache = out / "fa4-cache"
        cache.mkdir()
        warm = out / "warm"
        warm.mkdir()
        warm_stage(warm_mode, run_id + "-warm", warm, prompt,
                        admission=admission, deadline=deadline, geometry=geometry, cache=cache)
        (warm / "passed").touch(exist_ok=False)
        proof = (warm / "fa4-warm.json").read_bytes()
        receipt = json.loads(proof)
        if receipt["geometry"] != geometry_payload:
            raise RuntimeError("FA4 warmup receipt differs from CPU geometry")
        objects = receipt["objects"]
        if not objects:
            raise RuntimeError("FA4 warmup did not export an object")
        for name, metadata in objects.items():
            obj = cache / name
            if not obj.resolve(strict=True).is_relative_to(cache) or obj.is_symlink():
                raise RuntimeError("invalid FA4 cache object path")
            with obj.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if obj.stat().st_size != metadata["bytes"] or digest != metadata["sha256"]:
                raise RuntimeError("FA4 cache object differs from its warmup receipt")
        result = out / "image"
        result.mkdir()
        (result / "fa4-warm.json").write_bytes(proof)
        final_stage("image", run_id + "-image", result, prompt,
                        admission=admission, deadline=deadline, cache=cache, **extra)
        log = (result / "container.log").read_text()
        hits = set(re.findall(r"FA4_CACHE phase=image event=disk-hit object=(\S+)", log))
        if hits != objects.keys():
            raise RuntimeError("generation did not verify all warmed FA4 objects")
        (out / "passed").touch(exist_ok=False)
    return out / "image" / "smoke.png"
