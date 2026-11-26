"""Submit Spark ComfyUI text or first-frame generation without a public server."""
import hashlib
import io
import json
from pathlib import Path
import re
import shlex
import tarfile
import uuid

if __package__:
    from . import spark_h3
else:
    import spark_h3

MODEL = 'minimax-h3-veda'
ROOT = Path(__file__).resolve().parent


def prepare(config, directory):
    frame, prompt, duration, seed = spark_h3.first_frame_settings(
        config, directory, max_duration=15, profile='Veda', optional_frame=True)
    target_frames = duration * 24
    # The H3 conditioning node needs frame counts on its 17k+5 grid.
    native_frames = target_frames + (5 - target_frames) % 17
    return frame, {'prompt': prompt, 'seconds': duration, 'seed': seed, 'width': 576, 'height': 1024,
                   'fps': 24, 'frames': native_frames, 'steps': 4,
                   'generated_sparsity': '90%', 'reference_sparsity': '90%'}


def job_directory(task_id):
    if not re.fullmatch(r'veda_[a-f0-9]{32}', task_id):
        raise ValueError('Invalid Veda job ID.')
    return 'opennova-video/' + task_id


def submit(hostname, task_id, frame, fields):
    directory = job_directory(task_id)
    graph = json.loads((ROOT / 'veda_workflow.json').read_text())
    conditioning = graph['conditioning']['inputs']
    conditioning.update(prompt=fields['prompt'], length=fields['frames'])
    graph['summary']['inputs']['frames'] = fields['frames']
    graph['noise']['inputs']['noise_seed'] = fields['seed']
    graph['sample']['inputs']['request_id'] = str(uuid.UUID(task_id[5:]))
    job = {'id': task_id}
    files = [('worker.py', (ROOT / 'veda_worker.py').read_bytes())]
    if frame is None:
        # The deployed T6 text workflow uses this node with its optional image disconnected.
        del graph['first_frame'], conditioning['first_frame']
    else:
        image = frame.read_bytes()
        name = 'frame.png' if image.startswith(b'\x89PNG') else 'frame.jpg'
        graph['first_frame']['inputs']['image'] = name
        job['first_frame_sha256'] = hashlib.sha256(image).hexdigest()
        files.append(('input/' + name, image))
    files.extend([('job.json', json.dumps(job).encode()),
                  ('workflow.json', json.dumps(graph, ensure_ascii=False).encode())])
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode='w') as archive:
        for key, data in files:
            header = tarfile.TarInfo(key)
            header.size = len(data)
            header.mode = 0o600
            archive.addfile(header, io.BytesIO(data))
    # Only the validated job ID is interpolated in a shell command. Prompt and image are archive data.
    command = (f'umask 077 && mkdir -p opennova-video && mkdir {directory} && cd {directory} && '
               'exec 9>dispatch.lock && flock -x 9 && mkdir input output user temp && '
               'tar -xf - && python3 worker.py start')
    return spark_h3.run_ssh(hostname, command, body=payload.getvalue())


def status(hostname, task_id):
    directory = job_directory(task_id)
    pending = shlex.quote(json.dumps({'id': task_id, 'status': 'queued'}))
    missing = shlex.quote(json.dumps({'id': task_id, 'status': 'failed',
        'error': 'Spark has no accepted job for this ID. Check the recorded submission before starting a new task.'}))
    # A connection can be lost before, during, or after the upload. A live uploader owns
    # dispatch.lock until start() has persisted the job and transferred the supervisor lease.
    command = (f'if [ ! -d {directory} ]; then echo {missing}; else cd {directory} && '
               f'if [ ! -f state.json ] && [ -f dispatch.lock ] && ! flock -n dispatch.lock true; then echo {pending}; '
               f'elif [ -f state.json ]; then python3 worker.py status; else echo {missing}; fi; fi')
    return spark_h3.run_ssh(hostname, command)


def download(hostname, task_id, output):
    spark_h3.run_ssh(hostname, f'cd {job_directory(task_id)} && cat output/clip_00001_.mp4', output=output)
