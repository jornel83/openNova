#!/usr/bin/env python3
"""openNova video tools: standard-library Ark client and local FFmpeg editing."""
import argparse
import base64
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
TASKS = '/contents/generations/tasks'


class VideoError(Exception):
    pass


def safe_message(value, key=''):
    message = str(value)
    if key:
        message = message.replace(key, '[REDACTED]')
    return message[:1500]


def request_json(method, path, key, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    request = Request(API_BASE + path, data=body, method=method, headers={
        'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=90) as response:
            return json.load(response)
    except HTTPError as error:
        raw = error.read().decode('utf-8', errors='replace')
        try:
            detail = json.loads(raw).get('error', raw)
        except ValueError:
            detail = raw
        raise VideoError(f'HTTP {error.code}: {safe_message(detail, key)}') from None
    except (URLError, TimeoutError, ValueError) as error:
        raise VideoError(f'API request interrupted: {safe_message(error, key)}. '
                         'Submission is not automatically retried.') from None


def safe_message_json(value, key):
    serialized = json.dumps(value, ensure_ascii=False)
    return serialized.replace(key, '[REDACTED]') if key else serialized


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                     suffix='.tmp', delete=False) as file:
        temporary = Path(file.name)
        json.dump(value, file, ensure_ascii=False, indent=2)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def number(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise VideoError(f'{name} must be a number between {low} and {high}.')
    return value


def build_payload(config, directory):
    if not isinstance(config, dict):
        raise VideoError('config must be an object.')
    allowed = {'model', 'prompt', 'duration', 'ratio', 'resolution', 'generate_audio', 'reference_images'}
    if set(config) - allowed:
        raise VideoError('Unsupported generation config fields; credentials belong in ARK_API_KEY.')
    prompt = config.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 30000:
        raise VideoError('prompt must contain 1–30000 characters.')
    duration = number(config.get('duration', 10), 4, 30, 'duration')
    if int(duration) != duration:
        raise VideoError('duration must be a whole number of seconds.')
    ratio = config.get('ratio', '9:16')
    resolution = config.get('resolution', '720p')
    if ratio not in ('21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'):
        raise VideoError('Unsupported ratio.')
    if resolution not in ('480p', '720p', '1080p'):
        raise VideoError('Unsupported resolution.')
    audio = config.get('generate_audio', True)
    if not isinstance(audio, bool):
        raise VideoError('generate_audio must be boolean.')
    model = config.get('model', 'doubao-seedance-2-5-260628')
    if not isinstance(model, str) or not model:
        raise VideoError('model must be an enabled Ark model or endpoint ID.')
    images = config.get('reference_images', [])
    if not isinstance(images, list) or len(images) > 30 or not all(isinstance(x, str) and x for x in images):
        raise VideoError('reference_images must contain at most 30 local image paths.')
    payload = {'model': model, 'duration': int(duration), 'ratio': ratio,
               'resolution': resolution, 'generate_audio': audio,
               'content': [{'type': 'text', 'text': prompt}]}
    for name in images:
        path = (directory / name).resolve()
        media = mimetypes.guess_type(path.name)[0]
        if media not in ('image/png', 'image/jpeg', 'image/webp'):
            raise VideoError(f'Unsupported image format: {path.name}')
        if not path.is_file() or not 0 < path.stat().st_size < 30 * 1024 * 1024:
            raise VideoError(f'Image missing, empty or exceeds 30 MB: {path.name}')
        data = base64.b64encode(path.read_bytes()).decode('ascii')
        payload['content'].append({'type': 'image_url', 'role': 'reference_image',
                                   'image_url': {'url': f'data:{media};base64,{data}'}})
    if len(json.dumps(payload).encode()) >= 64 * 1024 * 1024:
        raise VideoError('Request exceeds 64 MB.')
    return payload


def credential():
    key = os.environ.get('ARK_API_KEY', '').strip()
    if not key:
        raise VideoError('Set ARK_API_KEY in the tool executor environment.')
    return key


def resolve_task(request, directory):
    task_id = request.get('task_id')
    state = directory / 'task.json'
    saved = json.loads(state.read_text()) if state.exists() else {}
    if task_id and saved.get('id') and task_id != saved['id']:
        raise VideoError('task_id differs from the saved task; use its own output_dir.')
    task_id = task_id or saved.get('id')
    if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', task_id):
        raise VideoError('No valid task ID; check Ark task history before submitting again.')
    return task_id


def query_task(task_id, key, directory):
    task = request_json('GET', f'{TASKS}/{task_id}', key)
    task['id'] = task_id
    task = json.loads(safe_message_json(task, key))
    save_json(directory / 'task.json', task)
    return {'task_id': task_id, 'status': task.get('status', 'unknown'),
            'task': task, 'output_dir': str(directory)}


def publish(temporary, destination):
    # Same-filesystem hard link publishes atomically and never replaces an existing file.
    os.link(temporary, destination)
    temporary.unlink()


def download_video(url, destination):
    if not isinstance(url, str) or not url.startswith('https://'):
        raise VideoError('Task did not return an HTTPS video URL.')
    if destination.exists():
        raise VideoError('Video output already exists; choose another filename.')
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix='.mp4.part', delete=False) as file:
        temporary = Path(file.name)
    try:
        # API credentials are never sent to storage endpoints.
        with urlopen(url, timeout=120) as response, temporary.open('wb') as file:
            expected = response.headers.get('Content-Length')
            while chunk := response.read(1024 * 1024):
                file.write(chunk)
        size = temporary.stat().st_size
        if not size or (expected is not None and size != int(expected)):
            raise VideoError('Video download incomplete; retry download for the same task.')
        publish(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def binary(name):
    found = os.environ.get(name.upper() + '_BIN') or shutil.which(name)
    if not found:
        raise VideoError(f'{name} is required; install FFmpeg or set {name.upper()}_BIN.')
    return found


def probe_video(path):
    result = subprocess.run([binary('ffprobe'), '-v', 'error', '-show_streams', '-show_format',
                             '-of', 'json', str(path)], capture_output=True, text=True)
    if result.returncode:
        raise VideoError(f'Cannot inspect video: {path.name}: {result.stderr[:500]}')
    metadata = json.loads(result.stdout)
    stream = next((s for s in metadata['streams'] if s['codec_type'] == 'video'), None)
    if not stream:
        raise VideoError(f'No video stream: {path.name}')
    return {'duration': float(stream.get('duration', metadata['format']['duration'])),
            'width': stream['width'], 'height': stream['height'],
            'has_audio': any(s['codec_type'] == 'audio' for s in metadata['streams'])}


def plan_edit(config, directory):
    if not isinstance(config, dict) or set(config) - {'clips', 'output', 'width', 'height', 'fps', 'crf'}:
        raise VideoError('Unsupported edit configuration.')
    clips = config.get('clips')
    if not isinstance(clips, list) or not clips:
        raise VideoError('clips must be a nonempty ordered list.')
    output = (directory / config['output']).resolve()
    if output.exists():
        raise VideoError('Output already exists; choose a new output path.')
    width = config.get('width', 720)
    height = config.get('height', 1280)
    for value, label in ((width, 'width'), (height, 'height')):
        number(value, 2, 3840, label)
        if int(value) != value or value % 2:
            raise VideoError(f'{label} must be an even integer.')
    fps = number(config.get('fps', 24), 1, 60, 'fps')
    crf = number(config.get('crf', 18), 0, 51, 'crf')
    prepared = []
    for clip in clips:
        path = (directory / clip['path']).resolve()
        if not path.is_file():
            raise VideoError(f'Clip missing: {path}')
        metadata = probe_video(path)
        start = number(clip.get('start', 0), 0, metadata['duration'], 'start')
        duration = number(clip.get('duration', metadata['duration'] - start), 0.001,
                          metadata['duration'] - start, 'duration')
        # Express trims in output frames so video/audio share exact boundaries.
        duration = round(duration * fps) / fps
        if duration <= 0 or start + duration > metadata['duration'] + 1 / fps:
            raise VideoError('Clip trim is shorter than one output frame or exceeds source.')
        prepared.append({**metadata, 'path': str(path), 'start': start, 'duration': duration})
    return {'clips': prepared, 'output': str(output), 'width': int(width), 'height': int(height),
            'fps': fps, 'crf': crf, 'duration': sum(c['duration'] for c in prepared)}


def edit_video(plan):
    executable = binary('ffmpeg')
    output = Path(plan['output'])
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix='.mp4', delete=False) as file:
        temporary = Path(file.name)
    command = [executable, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
    for clip in plan['clips']:
        command += ['-i', clip['path']]
    filters = []
    width, height, fps = plan['width'], plan['height'], plan['fps']
    for i, clip in enumerate(plan['clips']):
        start, duration = clip['start'], clip['duration']
        filters.append(f'[{i}:v]trim=start={start}:duration={duration},setpts=PTS-STARTPTS,'
                       f'fps={fps},scale={width}:{height}:force_original_aspect_ratio=decrease,'
                       f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{i}]')
        if clip['has_audio']:
            source = f'[{i}:a]atrim=start={start}:duration={duration},asetpts=PTS-STARTPTS,'
        else:
            source = f'anullsrc=r=48000:cl=stereo,atrim=duration={duration},'
        filters.append(source + 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,'
                       f'apad,atrim=duration={duration},afade=t=in:st=0:d=0.025,'
                       f'afade=t=out:st={max(0, duration-0.025)}:d=0.025[a{i}]')
    filters.append(''.join(f'[v{i}][a{i}]' for i in range(len(plan['clips']))) +
                   f'concat=n={len(plan["clips"])}:v=1:a=1[v][a]')
    command += ['-filter_complex', ';'.join(filters), '-map', '[v]', '-map', '[a]',
                '-r', str(fps), '-c:v', 'libx264', '-preset', 'fast', '-crf', str(plan['crf']),
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
                str(temporary)]
    try:
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode:
            raise VideoError(f'FFmpeg failed: {result.stderr[:1500]}')
        metadata = probe_video(temporary)
        if abs(metadata['duration'] - plan['duration']) > max(0.1, len(plan['clips']) / fps):
            raise VideoError('Export duration differs from planned timeline.')
        publish(temporary, output)
        return {'status': 'completed', 'path': str(output), 'metadata': metadata,
                'size_bytes': output.stat().st_size}
    finally:
        temporary.unlink(missing_ok=True)


def run(request, base_dir=None):
    """Synchronous dispatch; submit returns immediately; wait is bounded.

    Relative request paths resolve from base_dir (CLI: request JSON's directory).
    Relative reference/clip paths resolve from the selected config JSON's directory.
    """
    if not isinstance(request, dict):
        raise VideoError('Request must be a JSON object.')
    directory = Path(base_dir or Path.cwd()).resolve()
    action = request.get('action')
    if action not in ('validate', 'submit', 'status', 'wait', 'download', 'edit'):
        raise VideoError('Unknown action.')
    fields = {
        'validate': {'config', 'config_path'},
        'submit': {'config', 'config_path', 'output_dir'},
        'status': {'task_id', 'output_dir'},
        'wait': {'task_id', 'output_dir', 'poll_seconds', 'timeout_seconds'},
        'download': {'task_id', 'output_dir', 'filename'},
        'edit': {'config', 'config_path', 'dry_run'},
    }
    if set(request) - (fields[action] | {'action'}):
        raise VideoError('Unsupported request fields; credentials belong in the executor environment.')
    if action == 'edit' and not isinstance(request.get('dry_run', False), bool):
        raise VideoError('dry_run must be boolean.')
    if action not in ('validate', 'edit') and not isinstance(request.get('output_dir'), str):
        raise VideoError('output_dir is required.')
    if action in ('validate', 'submit', 'edit'):
        if ('config' in request) == ('config_path' in request):
            raise VideoError('Supply exactly one of config and config_path.')
        if 'config_path' in request:
            config_path = (directory / request['config_path']).resolve()
            config = json.loads(config_path.read_text())
            config_dir = config_path.parent
        else:
            config = request['config']
            config_dir = directory
        if action == 'edit':
            plan = plan_edit(config, config_dir)
            return {'status': 'validated', 'plan': plan} if request.get('dry_run', False) else edit_video(plan)
        payload = build_payload(config, config_dir)
        if action == 'validate':
            return {'status': 'validated', 'settings': {k: v for k, v in payload.items() if k != 'content'},
                    'reference_count': len(payload['content']) - 1}
    output = (directory / request['output_dir']).resolve()
    output.mkdir(parents=True, exist_ok=True)
    state = output / 'task.json'
    key = credential()
    if action == 'submit':
        try:
            with state.open('x') as file:
                json.dump({'status': 'submitting'}, file)
        except FileExistsError:
            raise VideoError('Task record already exists; query or resume it instead of submitting again.') from None
        try:
            saved_config = dict(config)
            saved_config['reference_images'] = [str((config_dir / p).resolve()) for p in config.get('reference_images', [])]
            save_json(output / 'config.json', json.loads(safe_message_json(saved_config, key)))
            task = request_json('POST', TASKS, key, payload)
            task_id = task.get('id')
            if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', task_id):
                raise VideoError('No valid task ID; check Ark task history before trying again.')
        except Exception as error:
            save_json(state, {'status': 'submission_not_confirmed', 'error': safe_message(error, key)})
            raise
        save_json(state, {'id': task_id, 'status': 'submitted'})
        return {'task_id': task_id, 'status': 'submitted', 'output_dir': str(output)}
    task_id = resolve_task(request, output)
    if action == 'wait':
        poll = number(request.get('poll_seconds', 15), 1, 60, 'poll_seconds')
        timeout = number(request.get('timeout_seconds', 60), 1, 3600, 'timeout_seconds')
        deadline = time.monotonic() + timeout
        while True:
            result = query_task(task_id, key, output)
            if result['status'] not in ('queued', 'running', 'pending', 'submitted'):
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                result['timed_out'] = True
                return result
            time.sleep(min(poll, remaining))
    result = query_task(task_id, key, output)
    if action == 'download':
        if result['status'] != 'succeeded':
            raise VideoError(f'Task is {result["status"]}; download requires succeeded.')
        filename = request.get('filename', 'video.mp4')
        if not isinstance(filename, str) or Path(filename).name != filename or not filename.endswith('.mp4'):
            raise VideoError('filename must be an MP4 basename.')
        destination = output / filename
        download_video(result['task'].get('content', {}).get('video_url'), destination)
        result['path'] = str(destination)
        result['size_bytes'] = destination.stat().st_size
    return result


def invoke(name, arguments, base_dir=None):
    """Named tool boundary; gateway authorizes name/arguments before calling."""
    names = {f'video_{action}': action for action in
             ('validate', 'submit', 'status', 'wait', 'download', 'edit')}
    if name not in names or not isinstance(arguments, dict) or 'action' in arguments:
        raise VideoError('Unknown tool name or forbidden action override.')
    return run({'action': names[name], **arguments}, base_dir)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--request', help='JSON request file, or - for stdin')
    mode.add_argument('--catalog', action='store_true', help='Print tool definitions')
    args = parser.parse_args()
    try:
        if args.catalog:
            print(Path(__file__).with_name('tool-definitions.json').read_text())
            return 0
        if args.request == '-':
            request, base = json.load(sys.stdin), Path.cwd()
        else:
            path = Path(args.request).resolve()
            request, base = json.loads(path.read_text()), path.parent
        result = run(request, base)
        print(safe_message_json({'ok': True, 'result': result}, os.environ.get('ARK_API_KEY', '')))
        return 0
    except (VideoError, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'ok': False, 'error': safe_message(error, os.environ.get('ARK_API_KEY', ''))}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
