"""Guarded no-weight warmup and native generation stages for native 864x1536 H3 Image editing."""
import json
from math import floor
from pathlib import Path
import re
import socket
import subprocess
import time

from h3_image_psi_confirm import PressureGuard, parse_psi
from run_window_2k_dit_fa4 import (
    IMAGE, P2, PROBE, ROOT, available_memory, command, gpu_processes, memory, p2_state,
)

EDIT_PROBE = "/portrait_edit_probe.py"
HERE = Path(__file__).resolve().parent


def run(mode, run_id, out, prompt, *, admission, deadline, cache, reference=None, geometry=None):
    if socket.gethostname() != "spark-469e":
        raise RuntimeError("unexpected host")
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    prior = p2_state()
    if admission != (boot, prior):
        raise RuntimeError("batch host or P2 state changed")
    available, _ = memory()
    if available < 106 or gpu_processes() or command("docker", "ps", "-q"):
        raise RuntimeError("Spark is busy or below the 106 GiB startup threshold")
    args = ["docker", "create", "--name", run_id, "--network", "none", "--restart", "no",
            "--label", "org.h3-image.run=" + run_id, "--pids-limit", "2048",
            "--gpus", "all", "--memory", "104g", "--memory-swap", "104g", "--shm-size", "8g",
            "--cpus", "12", "-v", f"{out}:/run-output",
            "-v", f"{ROOT}/build/fa4_2k_probe.py:{PROBE}:ro",
            "-v", f"{cache}:/fa4-cache", "-e", "SGLANG_CUTE_AOT_CACHE_DIR=/fa4-cache",
            "-e", "HF_HUB_OFFLINE=1", "-e", "PYTHONDONTWRITEBYTECODE=1"]
    if mode == "warm":
        if geometry is None:
            raise RuntimeError("missing edit geometry")
        args += ["-v", f"{HERE}/edit_probe.py:{EDIT_PROBE}:ro",
                 "-v", f"{geometry}:/fa4-geometry.json:ro", "--entrypoint", "python3",
                 IMAGE, EDIT_PROBE, "warm", "--geometry", "/fa4-geometry.json",
                 "--output", "/run-output/fa4-warm.json"]
    elif mode == "image":
        if reference is None or not reference.is_file():
            raise RuntimeError("missing reference image")
        (out / "sampling.json").write_text(json.dumps({"prompt": prompt, "width": 864, "height": 1536, "min_generation_area": 864 * 1536}, ensure_ascii=False), encoding="utf-8")
        args += ["-v", f"{ROOT}/models:/models:ro", "-v", f"{ROOT}/cache:/root/.cache",
                 "-v", f"{out}/fa4-warm.json:/fa4-warm.json:ro",
                 "-v", f"{reference}:/reference.png:ro",
                 "-v", f"{HERE}/portrait_pipeline.json:/portrait_pipeline.json:ro",
                 "--entrypoint", "python3", IMAGE, PROBE, "image", "--",
                 "--model-path", "/models/MiniMax-H3-Image", "--text-encoder-path",
                 "/models/MiniMax-H3/text_encoder", "--config", "/run-output/sampling.json",
                 "--image-path", "/reference.png",
                 "--pipeline-config-path", "/portrait_pipeline.json", "--width", "864", "--height", "1536", "--seed", "42", "--num-inference-steps", "6",
                 "--save-output", "--output-path", "/run-output", "--output-file-name", "smoke.png",
                 "--component-residency", "text_encoder=layerwise-offload,transformer=layerwise-offload"]
    else:
        raise ValueError(f"unknown image stage: {mode}")
    (out/"request.json").write_text(json.dumps(dict(boot=boot,mode=mode,args=args,available_gib=available),indent=2))
    cid = command(*args, timeout=45)
    if not re.fullmatch("[0-9a-f]{64}", cid):
        raise RuntimeError("invalid container identity")
    (out/"cid").write_text(cid)
    unit = run_id + "-cutoff"
    try:
        limit = floor(deadline - time.monotonic())
        if limit < 1:
            raise RuntimeError("shared window is at its cutoff")
        command("systemd-run", "--user", "--collect", "--unit="+unit,
                "--on-active="+str(limit)+"s", "--timer-property=AccuracySec=1s",
                "/usr/bin/docker", "stop", "-t", "8", cid)
        command("systemctl", "--user", "is-active", unit+".timer")
        if p2_state() != prior or gpu_processes() or memory()[0] < 106 or command("docker", "ps", "-q"):
            raise RuntimeError("admission changed")
        start = time.monotonic()
        command("docker", "start", cid, timeout=45)
        _, baseline = memory()
        baseline_time = time.monotonic()
        pressure_guard = PressureGuard(baseline_time, baseline)
        (out / "psi-baseline.json").write_text(json.dumps({
            "monotonic_seconds": baseline_time, "total_us": baseline,
        }))
        with (out/"samples.jsonl").open("w", buffering=1) as samples:
            while True:
                info = json.loads(command("docker", "inspect", cid))[0]["State"]
                if info["Status"] != "running":
                    break
                time.sleep(2)
                available, psi = memory()
                now = time.monotonic()
                pressure = pressure_guard.observe(now, psi)
                rec = dict(elapsed=round(now-start, 2), available_gib=available,
                           psi_monotonic_seconds=now, psi_total_us=psi, **pressure)
                counters = ("pgmajfault", "compact_stall", "compact_success", "compact_fail",
                            "pgscan_direct", "pgsteal_direct", "workingset_refault_file")
                rec["vmstat"] = {k: int(v) for k, v in (line.split() for line in Path("/proc/vmstat").read_text().splitlines())
                                 if k in counters or k.startswith("allocstall_")}
                rec["host_mem_kib"] = {line.split(":")[0]: int(line.split()[1])
                                       for line in Path("/proc/meminfo").read_text().splitlines()
                                       if line.split(":")[0] in ("MemFree","Cached","Dirty","SwapFree")}
                procfile = Path(f"/proc/{info['Pid']}/cgroup")
                if procfile.exists():
                    try:
                        group = Path("/sys/fs/cgroup") / procfile.read_text().split("0::",1)[1].strip().lstrip("/")
                        rec["memory_current"] = int((group/"memory.current").read_text())
                        rec["memory_events"] = (group/"memory.events").read_text()
                        memstat_keys = {
                            "anon", "file", "kernel", "slab", "pagetables", "shmem",
                            "pgscan_direct", "pgsteal_direct", "pgmajfault", "workingset_refault_file",
                        }
                        rec["memory_stat"] = {
                            k: int(v) for k, v in
                            (line.split() for line in (group/"memory.stat").read_text().splitlines())
                            if k in memstat_keys
                        }
                        rec["cgroup_psi_total_us"] = parse_psi((group/"memory.pressure").read_text())
                    except FileNotFoundError:
                        if command("docker","inspect","-f","{{.State.Running}}",cid)=="true":
                            raise
                rec["temperature_and_throttle"] = command("nvidia-smi","--query-gpu=temperature.gpu,clocks_event_reasons.active","--format=csv,noheader")
                rec["gpu_pids"] = gpu_processes()
                samples.write(json.dumps(rec)+"\n")
                events = dict(line.split() for line in rec.get("memory_events", "").splitlines())
                if any(int(events.get(k, 0)) for k in ("oom","oom_kill")):
                    raise RuntimeError("container memory event")
                for pid in rec["gpu_pids"].splitlines():
                    path = Path("/proc")/str(int(pid))/"cgroup"
                    try:
                        membership = path.read_text()
                    except FileNotFoundError:
                        continue
                    if cid not in membership:
                        raise RuntimeError("GPU process outside the image container")
                if available < 16 or p2_state() != prior:
                    raise RuntimeError("resource or P2 guard stopped request")
                if now > deadline:
                    raise RuntimeError("deadline exceeded")
                if pressure["psi_state"] == "warning":
                    print(f"PSI warning at {now-start:.2f}s: some={pressure['psi_some_pct']:.2f}%; "
                          "confirming with subsequent memory pressure samples", flush=True)
                if pressure["psi_state"] == "recovered":
                    print(f"PSI warning cleared at {now-start:.2f}s", flush=True)
                if pressure["psi_state"] == "stop":
                    raise RuntimeError(f"memory PSI stopped request: {pressure['psi_stop_reason']}")
        if info["OOMKilled"] or info["ExitCode"] != 0:
            raise RuntimeError(f"container exit {info['ExitCode']}, OOM={info['OOMKilled']}")
        if pressure_guard.pending:
            raise RuntimeError("output completed with a pending memory PSI confirmation")
        if mode == "warm" and not (out / "fa4-warm.json").is_file():
            raise RuntimeError("missing edit FA4 warmup proof")
        if mode == "image":
            from PIL import Image
            with Image.open(out/"smoke.png") as output:
                output.load()
                if output.format != "PNG" or output.size != (864,1536):
                    raise RuntimeError("invalid PNG")
    finally:
        if command("docker","inspect","-f","{{.State.Running}}",cid)=="true":
            command("docker","stop","-t","8",cid,timeout=25)
        with (out/"container.log").open("w") as log:
            subprocess.run(["docker","logs",cid],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=25)
        (out/"exit.json").write_text(command("docker","inspect","-f","{{json .State}}",cid))
        command("docker","rm",cid)
        subprocess.run(["systemctl","--user","stop",unit+".timer"],capture_output=True,timeout=10)
        if command("docker","ps","-aq","--no-trunc","--filter","id="+cid) or p2_state()!=prior:
            raise RuntimeError("cleanup or P2 identity mismatch")
        if gpu_processes():
            raise RuntimeError("GPU process remains after cleanup")
        (out/"cleanup.json").write_text(json.dumps({"boot":boot,"cid":cid,"available_gib":available_memory(),"p2":P2}))
