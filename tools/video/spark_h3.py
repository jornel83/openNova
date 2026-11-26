"""MiniMax H3 FL2VA on the Spark's loopback-only vLLM-Omni P2 service."""
import json
import os
import re
import shlex
import subprocess
import uuid

MODEL = 'minimax-h3-spark'
STATES = {'queued': 'queued', 'in_progress': 'running', 'completed': 'succeeded', 'failed': 'failed'}
LORA = {'name': 'h3-turbo-v1.0', 'path': '/models/Minimax-H3-Turbo/minimax_h3_fl2v_turbo_4step_v1.0_768p_bf16.safetensors',
        'scale': 1.0}


def first_frame_settings(config, directory, max_duration, profile, *, optional_frame=False):
    allowed = {'model', 'prompt', 'first_frame_path', 'duration', 'ratio', 'seed'}
    if set(config) - allowed:
        raise ValueError('Spark H3 accepts model, prompt, first_frame_path, duration, ratio and seed.')
    prompt = config.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 30000:
        raise ValueError('prompt must contain 1–30000 characters.')
    duration = config.get('duration', 4)
    seed = config.get('seed', 1101)
    if type(duration) is not int or not 4 <= duration <= max_duration or config.get('ratio', '9:16') != '9:16':
        raise ValueError(f'The Spark {profile} profile requires 9:16 and an integer duration from 4 to {max_duration} seconds.')
    if type(seed) is not int or not 0 <= seed <= 2147483647:
        raise ValueError('seed must be a nonnegative 32-bit signed integer.')
    if optional_frame and 'first_frame_path' not in config:
        return None, prompt, duration, seed
    name = config.get('first_frame_path')
    if not isinstance(name, str) or not name or '://' in name:
        raise ValueError('Spark H3 requires a local PNG/JPEG first_frame_path.')
    frame = (directory / name).resolve()
    if not frame.is_file() or not 0 < frame.stat().st_size <= 30 * 1024 * 1024:
        raise ValueError('Spark first frame is missing, empty or larger than 30 MiB.')
    with frame.open('rb') as file:
        signature = file.read(8)
    if not (signature == b'\x89PNG\r\n\x1a\n' or signature.startswith(b'\xff\xd8\xff')):
        raise ValueError('Spark first frame must be a PNG or JPEG image.')
    return frame, prompt, duration, seed


def prepare(config, directory):
    frame, prompt, duration, seed = first_frame_settings(config, directory, max_duration=6, profile='P2')
    fields = {'prompt': prompt, 'seconds': str(duration), 'fps': 24, 'width': 768, 'height': 1344,
              'num_inference_steps': 5, 'flow_shift': 6, 'seed': seed, 'lora': LORA,
              'extra_params': {'task': 'fl2va', 'duration': float(duration), 'audio_flow_shift': 3.0}}
    return frame, fields


def host():
    alias = os.environ.get('OPENNOVA_SPARK_SSH_HOST', 'agent-gpu')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9@._-]{0,250}', alias):
        raise ValueError('Invalid OPENNOVA_SPARK_SSH_HOST.')
    return alias


def request(hostname, path, *, body=None, boundary=None, output=None):
    # Only the executor selects the SSH target. No model-supplied command or URL.
    command = ['curl', '--disable', '--noproxy', '*', '--fail', '--silent', '--show-error',
               '--connect-timeout', '5', '--max-time', '90']
    if body is not None:
        command += ['--header', f'Content-Type: multipart/form-data; boundary={boundary}', '--data-binary', '@-']
    command.append('http://127.0.0.1:8000/v1/videos' + path)
    return run_ssh(hostname, shlex.join(command), body=body, output=output)


def run_ssh(hostname, command, *, body=None, output=None):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9@._-]{0,250}', hostname):
        raise ValueError('Invalid Spark SSH host in task record.')
    try:
        result = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', hostname,
                                 command], input=body or b'', stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=105)
    except subprocess.TimeoutExpired as error:
        raise OSError('Spark SSH request timed out; check the existing job before retrying.') from error
    if result.returncode:
        raise OSError('Spark H3 request failed: ' + result.stderr.decode(errors='replace')[-500:])
    if output is None:
        return json.loads(result.stdout)


def status(hostname, task_id):
    return request(hostname, '/' + task_id)


def download(hostname, task_id, output):
    request(hostname, '/' + task_id + '/content', output=output)


def submit(hostname, frame, fields):
    boundary = uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{text}\r\n'.encode())
    parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="input_reference"; filename="frame"\r\n'
                  'Content-Type: application/octet-stream\r\n\r\n'.encode(), frame.read_bytes(),
                  f'\r\n--{boundary}--\r\n'.encode()])
    return request(hostname, '', body=b''.join(parts), boundary=boundary)
