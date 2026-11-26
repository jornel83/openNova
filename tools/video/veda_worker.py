"""Spark-side launcher and in-container runner for a single OpenNova Veda job."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

IMAGE = 'sha256:21e9f227ef218a667d34689c508b97fc39cfc191f8461eb1dd0ec74b0a5d84e6'
STATE = Path('state.json')
CLIP = Path('output/clip_00001_.mp4')


def write_state(job, status, **extra):
    value = {**job, 'status': status, **extra}
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(value))
    tmp.replace(STATE)
    return value


def start(job):
    # Hand off the same locked open-file description to the detached supervisor.
    # Status readers can distinguish a queued job from a worker lost on restart.
    with open('supervisor.lock', 'x') as lease, open('runner.log', 'xb') as log:
        fcntl.flock(lease, fcntl.LOCK_EX)
        write_state(job, 'queued')
        try:
            subprocess.Popen([sys.executable, __file__, 'run'], stdin=subprocess.DEVNULL,
                             stdout=log, stderr=log, start_new_session=True, pass_fds=(lease.fileno(),))
        except OSError as error:
            write_state(job, 'failed', error=str(error))
            raise
    return {'id': job['id']}


def status(job):
    # Re-read under the lease if the worker exited between the first read and the lock.
    value = json.loads(STATE.read_text())
    if value['status'] in ('queued', 'in_progress'):
        with open('supervisor.lock') as lease:
            try:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return value
            value = json.loads(STATE.read_text())
            if value['status'] in ('queued', 'in_progress'):
                return write_state(job, 'failed', error='The Spark supervisor stopped before recording completion.')
    return value


def docker_command(job):
    home, work = Path.home(), Path.cwd()
    uid, gid = os.getuid(), os.getgid()
    command = ['docker', 'run', '--name', 'nova-' + job['id'], '--rm', '--init', '--gpus', 'all',
               '--network', 'none', '--user', f'{uid}:{gid}', '--cap-drop', 'ALL',
               '--security-opt', 'no-new-privileges', '--read-only', '--memory', '48g', '--memory-swap', '48g',
               '--cpus', '8', '--pids-limit', '4096', '--shm-size', '1g',
               '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777',
               '--tmpfs', f'/run/veda-jit:rw,exec,nosuid,nodev,size=2g,mode=700,uid={uid},gid={gid}']
    # CUDA and Triton compile into the same per-job mount. Reserve space for
    # Triton kernels when the CUDA driver cache grows during longer clips.
    for setting in ['HOME=/run/job/user', 'XDG_CACHE_HOME=/run/job/user/cache',
                    'PYTHONDONTWRITEBYTECODE=1', 'PYTHONUNBUFFERED=1', 'PYTORCH_NO_CUDA_MEMORY_CACHING=0',
                    'PYTORCH_CUDA_ALLOC_CONF=backend:native,expandable_segments:False',
                    'PYTORCH_ALLOC_CONF=backend:native,expandable_segments:False',
                    'TRITON_CACHE_DIR=/run/veda-jit/triton', 'TRITON_OVERRIDE_DIR=/run/veda-jit/triton-override',
                    'TRITON_DUMP_DIR=/run/veda-jit/triton-dump', 'CUDA_CACHE_PATH=/run/veda-jit/cuda',
                    'CUDA_CACHE_MAXSIZE=536870912',
                    'TORCHINDUCTOR_CACHE_DIR=/run/veda-jit/torchinductor']:
        command.extend(['-e', setting])
    for source, dest in [(home/'h3-veda/data/models', '/opt/ComfyUI/models:ro'),
                         (home/'h3-veda/control-t6-s90-20261122a', '/opt/veda_profile:ro'),
                         (work, '/run/job')]:
        if not source.is_dir():
            raise FileNotFoundError(f'Spark Veda directory missing: {source}')
        command.extend(['-v', f'{source}:{dest}'])
    return command + ['--entrypoint', 'python3', IMAGE, '/run/job/worker.py', 'generate']


def run(job):
    try:
        # Share the scheduler lock used by the deployed Spark P2/Veda experiments.
        with (Path.home()/'h3-deploy/.generate-douyin.lock').open('a') as gpu:
            fcntl.flock(gpu, fcntl.LOCK_EX)
            if subprocess.check_output(['nvidia-smi', '--query-compute-apps=pid', '--format=csv,noheader']).strip():
                raise RuntimeError('The Spark GPU is occupied by another application.')
            write_state(job, 'in_progress')
            with open('generation.log', 'xb') as log:
                process = subprocess.run(docker_command(job), stdout=log, stderr=subprocess.STDOUT,
                                         pass_fds=(gpu.fileno(),))
            if process.returncode:
                # The last lines contain ComfyUI's exception or Docker's startup error.
                detail = Path('generation.log').read_bytes()[-1200:].decode(errors='replace')
                raise RuntimeError(f'Spark Veda exited {process.returncode}: {detail}')
        receipt = json.loads(Path('output/receipt.json').read_text())
        if receipt.get('first_frame_sha256') != job.get('first_frame_sha256') or not CLIP.stat().st_size:
            raise RuntimeError('Veda output does not match the job.')
        write_state(job, 'completed', **receipt, sha256=hashlib.sha256(CLIP.read_bytes()).hexdigest())
    except Exception as error:
        write_state(job, 'failed', error=str(error)[-1500:])


def install_clip_summary(registry, request_id, conditioning):
    """Check this job's sampler output before decoding either video or audio."""
    # The pinned benchmark summary only accepts four experiment geometries.
    # Keep its node interface and evidence format, using the production shot's
    # requested frame count for the joint video/audio latent checks.
    base = registry['H3BenchmarkSummary']
    benchmark = sys.modules[base.__module__]

    class OpenNovaClipSummary(base):
        def save(self, samples, report, width, height, frames, expected_evaluations, mode):
            value = json.loads(report)
            if (benchmark.canonical_request_id(value['request_id']) != request_id or
                    mode != 'ON' or value.get('mode') != mode or expected_evaluations != 4 or
                    value.get('evaluations') != expected_evaluations or value.get('finite_model_outputs') is not True):
                raise ValueError('Mismatched or failed Veda sampler report.')
            if ((width, height, frames) != (conditioning['width'], conditioning['height'], conditioning['length'])
                    or frames % 17 != 5):
                raise ValueError('Summary geometry differs from the requested H3 clip.')
            video_t = ((frames - 5) // 17) * 5 + 2
            expected = ((1, 24, video_t, height // 16, width // 16), (1, 32, 2, round(frames / 24 * 40)))
            nested = samples['samples']
            tensors = tuple(nested.unbind()) if nested.is_nested else ()
            if tuple(tuple(t.shape) for t in tensors) != expected:
                raise ValueError('Joint audio/video latent shape differs from the requested clip.')
            if not all(benchmark._torch_finite(t) for t in tensors):
                raise ValueError('Nonfinite Veda latent output.')
            value.update(latent_shapes=expected, finite_latents=True,
                         output_status='latent_checked_not_media_or_cleanup_verified')
            filename = f'{request_id}.result.json'
            benchmark._write_exclusive(benchmark._output_directory() / filename, value)
            return {'ui': {'text': [f'veda-benchmark/{filename}']}, 'result': (samples,)}

    registry['OpenNovaClipSummary'] = OpenNovaClipSummary


def generate():
    # This branch runs inside the same pinned ComfyUI image as the verified FL2VA profile.
    import asyncio
    import logging
    base = Path('/run/job')
    sys.path[:0] = ['/opt/ComfyUI', '/opt/veda_profile']
    import short_resources as resources
    sys.argv = [sys.argv[0], *resources.COMFY_FLAGS]
    import comfy.options
    comfy.options.enable_args_parsing()
    from comfy.cli_args import args
    import cuda_malloc  # initializes ComfyUI's configured allocator
    import torch
    resources.bind(torch)
    import comfy.memory_management
    import comfy.model_management
    resources.validate_comfy(args, comfy.memory_management, os.environ)
    resources.install_free_memory_bound(torch, comfy.model_management)
    import folder_paths
    import nodes
    import server
    import execution
    from app.assets.manager import default_asset_manager
    from veda_runtime_binding import RuntimeBinding

    logging.basicConfig(level=logging.INFO)
    for name in ('input', 'output', 'user', 'temp'):
        getattr(folder_paths, 'set_' + name + '_directory')(str(base/name))
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    ps = server.PromptServer(loop, default_asset_manager())
    loop.run_until_complete(nodes.init_extra_nodes(init_custom_nodes=True, init_api_nodes=False))
    patch = RuntimeBinding(nodes.NODE_CLASS_MAPPINGS).verify().patch.VedaPatch
    cleanup = patch.on_cleanup
    runs = []

    def collect(instance):
        runs.append({'evaluations': instance.run.evaluations, 'calls': dict(instance.run.calls),
                     'failed': instance.run.failed,
                     'backends': [engine.backend.name for engine in instance._engines.values() if engine is not None]})
        return cleanup(instance)

    patch.on_cleanup = collect
    graph = json.loads((base/'workflow.json').read_text())
    job = json.loads((base/'job.json').read_text())
    request_id = graph['sample']['inputs']['request_id']
    install_clip_summary(nodes.NODE_CLASS_MAPPINGS, request_id, graph['conditioning']['inputs'])
    if 'first_frame_sha256' in job:
        frame = (base/'input') / graph['first_frame']['inputs']['image']
        if hashlib.sha256(frame.read_bytes()).hexdigest() != job['first_frame_sha256']:
            raise ValueError('Veda first-frame digest mismatch.')
    elif 'first_frame' in graph or 'first_frame' in graph['conditioning']['inputs']:
        raise ValueError('Unexpected first frame in a text-only workflow.')
    valid = loop.run_until_complete(execution.validate_prompt(request_id, graph, None))
    if not valid[0] or valid[3]:
        raise ValueError(str(valid))
    executor = execution.PromptExecutor(ps, cache_type=execution.CacheType.CLASSIC, cache_args={'ram': 0, 'ram_inactive': 0})
    ps.send_sync = lambda *args, **kwargs: None  # no HTTP client for this private execution
    start_time = time.time()
    loop.run_until_complete(executor.execute_async(graph, request_id, {'client_id': request_id}, valid[2]))
    if not executor.success:
        raise RuntimeError([v.get('exception_message') for event, v in executor.status_messages if event == 'execution_error'])
    if not any(r['evaluations'] == 4 and r['calls'].get('sparse') == 200 and 'triton-int8' in r['backends']
               and not r['failed'] for r in runs):
        raise RuntimeError('Expected four-step Triton INT8 Veda sparse attention was not executed.')
    (base/'output/receipt.json').write_text(json.dumps({**job, 'request_id': request_id,
        'image_id': IMAGE, 'inference_time_s': time.time() - start_time, 'veda_runs': runs}))


if __name__ == '__main__':
    action = sys.argv[1]
    if action == 'generate':
        generate()
    else:
        job = json.loads(Path('job.json').read_text())
        if action == 'run':
            run(job)
        elif action == 'status':
            print(json.dumps(status(job)))
        elif action == 'start':
            print(json.dumps(start(job)))
        else:
            raise SystemExit('Unknown Spark worker action.')
