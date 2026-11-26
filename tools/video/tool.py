#!/usr/bin/env python3
"""openNova video tools: Ark and Spark generation with local FFmpeg editing."""
import argparse
import base64
import fcntl
import hashlib
from fractions import Fraction
from http.client import HTTPException
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
import uuid
if __package__:
    from . import aesthetic_edit, spark_h3, spark_veda
else:
    import aesthetic_edit
    import spark_h3
    import spark_veda
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlparse

API_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
TASKS = '/contents/generations/tasks'
ASSET_FRAME = re.compile(r'asset://asset-[A-Za-z0-9_-]+\Z')


class VideoError(Exception):
    pass


class RetryableVideoError(VideoError):
    """A known task can be queried or downloaded again after this failure."""


def safe_message(value, key=''):
    message = str(value)
    if key:
        message = message.replace(key, '[REDACTED]')
    # Input media URLs can contain short-lived storage credentials.
    message = re.sub(r'https?://[^\s\'"<>]+\?[^\s\'"<>]+', '[SIGNED_URL_REDACTED]', message)
    message = re.sub(r'data:image/[\w.+-]+;base64,[A-Za-z0-9+/=]+', '[IMAGE_DATA_REDACTED]', message)
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
        errtype = RetryableVideoError if error.code in (408, 429) or error.code >= 500 else VideoError
        raise errtype(f'HTTP {error.code}: {safe_message(detail, key)}') from None
    except (URLError, TimeoutError, ValueError) as error:
        raise RetryableVideoError(f'API request interrupted: {safe_message(error, key)}. '
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
    allowed = {'model', 'prompt', 'duration', 'ratio', 'resolution', 'generate_audio',
               'reference_images', 'reference_videos', 'omni_reference_task_type',
               'first_frame', 'first_frame_path', 'watermark', 'return_last_frame'}
    if set(config) - allowed:
        raise VideoError('Unsupported generation config fields; credentials belong in ARK_API_KEY.')
    prompt = config.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 30000:
        raise VideoError('prompt must contain 1–30000 characters.')
    duration = number(config.get('duration', 10), 4, 30, 'duration')
    if int(duration) != duration:
        raise VideoError('duration must be a whole number of seconds.')
    has_first_frame = 'first_frame' in config or 'first_frame_path' in config
    ratio = config.get('ratio', 'adaptive' if has_first_frame else '9:16')
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
    for field in ('watermark', 'return_last_frame'):
        if field in config and not isinstance(config[field], bool):
            raise VideoError(f'{field} must be boolean.')
    images = config.get('reference_images', [])
    if not isinstance(images, list) or len(images) > 30 or not all(isinstance(x, str) and x for x in images):
        raise VideoError('reference_images must contain at most 30 local image paths.')
    videos = config.get('reference_videos', [])
    if not isinstance(videos, list) or len(videos) > 10 or not all(isinstance(x, str) and x for x in videos):
        raise VideoError('reference_videos must contain at most 10 local video paths.')
    if 'omni_reference_task_type' in config and config['omni_reference_task_type'] != 'reference':
        raise VideoError('Only omni_reference_task_type=reference is supported.')
    if has_first_frame:
        if 'first_frame' in config:
            frame = config['first_frame']
            if not isinstance(frame, str) or len(frame) > 256 or not ASSET_FRAME.fullmatch(frame):
                raise VideoError('first_frame must be an asset://asset-... URI for an approved image asset.')
            if not isinstance(config.get('model'), str) or not config['model'].strip():
                raise VideoError('first_frame requires an explicit enabled model or endpoint ID.')
            if 'first_frame_path' in config:
                raise VideoError('Supply a single first frame, either an asset or a local image.')
        else:
            name = config['first_frame_path']
            if not isinstance(name, str) or not name or '://' in name:
                raise VideoError('first_frame_path requires a local PNG or JPEG image.')
            path = (directory / name).resolve()
            if not path.is_file() or not 0 < path.stat().st_size <= 30 * 1024 * 1024:
                raise VideoError('First frame is missing, empty or larger than 30 MiB.')
            image = path.read_bytes()
            if image.startswith(b'\x89PNG\r\n\x1a\n'):
                media = 'image/png'
            elif image.startswith(b'\xff\xd8\xff'):
                media = 'image/jpeg'
            else:
                raise VideoError('first_frame_path requires PNG or JPEG data.')
            frame = f'data:{media};base64,{base64.b64encode(image).decode("ascii")}'
        if images or videos or 'omni_reference_task_type' in config:
            raise VideoError('first_frame cannot be combined with reference_images, reference_videos or omni_reference_task_type.')
        if model.startswith('doubao-seedance-2-0-') and duration > 15:
            raise VideoError('Seedance 2.0 first-frame duration must be between 4 and 15 seconds.')
        if model.startswith('doubao-seedance-2-0-fast-') and resolution == '1080p':
            raise VideoError('Seedance 2.0 Fast first-frame resolution must be 480p or 720p.')
        if model.startswith('doubao-seedance-2-5-') and ratio != 'adaptive':
            raise VideoError('Seedance 2.5 first-frame ratio must be adaptive.')
    if videos and not (model.startswith('doubao-seedance-2-5-') or model.startswith('ep-')):
        raise VideoError('Video references require Seedance 2.5 or a compatible endpoint ID.')
    payload = {'model': model, 'duration': int(duration), 'ratio': ratio,
               'resolution': resolution, 'generate_audio': audio,
               'content': [{'type': 'text', 'text': prompt}]}
    for field in ('watermark', 'return_last_frame'):
        if field in config:
            payload[field] = config[field]
    if has_first_frame:
        payload['content'].append({'type': 'image_url', 'role': 'first_frame',
                                   'image_url': {'url': frame}})
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
    total_duration = 0
    for name in videos:
        path = (directory / name).resolve()
        if path.suffix.lower() not in ('.mp4', '.mov'):
            raise VideoError(f'Unsupported reference video format: {path.name}')
        if not path.is_file() or not 0 < path.stat().st_size <= 200 * 1024 * 1024:
            raise VideoError(f'Video missing, empty or exceeds 200 MB: {path.name}')
        metadata = probe_video(path)
        number(metadata['duration'], 2, 30, 'reference video duration')
        width, height = metadata['width'], metadata['height']
        number(width, 300, 6000, 'reference video width')
        number(height, 300, 6000, 'reference video height')
        number(width / height, 0.4, 2.5, 'reference video aspect ratio')
        number(width * height, 407696, 8295044, 'reference video pixels')
        number(metadata['fps'], 24, 60, 'reference video FPS')
        total_duration += metadata['duration']
        # A local-only marker, resolved to a temporary Files API URL at submit.
        payload['content'].append({'type': 'video_url', 'role': 'reference_video',
                                   'video_url': {'url': path.as_uri()}})
    if total_duration > 30:
        raise VideoError('Reference videos total duration exceeds 30 seconds.')
    if videos or 'omni_reference_task_type' in config:
        payload['omni_reference_task_type'] = 'reference'
    if len(json.dumps(payload).encode()) >= 64 * 1024 * 1024:
        raise VideoError('Request exceeds 64 MB.')
    return payload


def upload_reference_video(path, key):
    """Upload only to official Ark Files; the signed download URL stays in memory."""
    boundary = 'openNova-' + uuid.uuid4().hex
    parts = []
    for name, value in (('purpose', 'agent'), ('expire_at', str(int(time.time()) + 86520))):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    media = 'video/mp4' if path.suffix.lower() == '.mp4' else 'video/quicktime'
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                  f'filename="reference{path.suffix.lower()}"\r\nContent-Type: {media}\r\n\r\n').encode())
    parts.extend((path.read_bytes(), f'\r\n--{boundary}--\r\n'.encode()))
    request = Request(API_BASE + '/files', data=b''.join(parts), method='POST', headers={
        'Authorization': f'Bearer {key}', 'Content-Type': f'multipart/form-data; boundary={boundary}'})
    try:
        with urlopen(request, timeout=120) as response:
            result = json.load(response)
    except HTTPError as error:
        raise VideoError(f'Files upload HTTP {error.code}: {safe_message(error.read().decode("utf-8", errors="replace"), key)}') from None
    except (URLError, TimeoutError, ValueError) as error:
        raise VideoError(f'Files upload interrupted: {safe_message(error, key)}') from None
    file_id, url = result.get('id'), result.get('download_url')
    if not isinstance(file_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', file_id):
        raise VideoError('Files upload did not return a file ID.')
    deadline = time.monotonic() + 30
    # A file can already be active before its original-file URL is populated.
    # Poll the same file ID for the URL regardless of nonfailed status.
    while not result.get('download_url') and result.get('status') != 'failed' and time.monotonic() < deadline:
        time.sleep(2)
        result = request_json('GET', '/files/' + file_id, key)
    if result.get('status') == 'failed':
        raise VideoError(f'Files upload {file_id} failed.')
    url = result.get('download_url')
    if not isinstance(url, str) or urlparse(url).scheme != 'https' or not urlparse(url).netloc:
        raise VideoError(f'Files upload {file_id} did not return an HTTPS download URL.')
    try:
        # Verify the original video is anonymously readable. Never send the Ark
        # credential to storage, and read only a small header even if Range is ignored.
        with urlopen(Request(url, headers={'Range': 'bytes=0-63'}), timeout=30) as response:
            header = response.read(64)
        if len(header) < 8 or header[4:8] not in (b'ftyp', b'moov', b'mdat', b'wide', b'free'):
            raise VideoError(f'Files upload {file_id} download is not recognizable MP4/MOV data.')
    except (HTTPError, URLError, TimeoutError, ValueError) as error:
        raise VideoError(f'Files upload {file_id} download is not readable: {safe_message(error, key)}') from None
    return {'id': file_id, 'download_url': url, 'expire_at': result.get('expire_at')}


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


def spark_provider(model):
    if model == spark_h3.MODEL:
        return spark_h3
    if model == spark_veda.MODEL:
        return spark_veda
    return None


def query_task(task_id, key, directory, spark=None):
    if spark:
        remote = spark.status(spark_h3.host(), task_id)
        status = spark_h3.STATES.get(remote.get('status'))
        if remote.get('id') != task_id or status is None:
            raise VideoError('Unexpected job ID or status from Spark H3.')
        task = {name: remote[name] for name in ('id', 'model', 'created_at', 'completed_at',
                'inference_time_s', 'stage_durations', 'peak_memory_mb', 'error', 'request_id',
                'first_frame_sha256', 'image_id', 'veda_runs', 'sha256') if name in remote}
        task.update(provider=spark.MODEL, host=spark_h3.host(), status=status)
        save_json(directory / 'task.json', task)
        return {'task_id': task_id, 'status': status, 'task': task, 'output_dir': str(directory),
                **({'error': safe_message(task['error'])} if task.get('error') else {})}
    task = request_json('GET', f'{TASKS}/{task_id}', key)
    task['id'] = task_id
    if isinstance(task.get('error'), dict):
        task['error'] = {name: safe_message(value, key) if isinstance(value, str) else value
                         for name, value in task['error'].items()}
    elif task.get('error') is not None:
        task['error'] = safe_message(task['error'], key)
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
        try:
            with urlopen(url, timeout=120) as response, temporary.open('wb') as file:
                expected = response.headers.get('Content-Length')
                while chunk := response.read(1024 * 1024):
                    file.write(chunk)
        except HTTPException as error:
            raise RetryableVideoError('Video download interrupted; retry download for the same task.') from error
        size = temporary.stat().st_size
        if not size or (expected is not None and size != int(expected)):
            raise RetryableVideoError('Video download incomplete; retry download for the same task.')
        publish(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def binary(name):
    found = os.environ.get(name.upper() + '_BIN') or shutil.which(name)
    if not found:
        raise VideoError(f'{name} is required; install FFmpeg or set {name.upper()}_BIN.')
    return found


def probe_video(path, *, still=False):
    probe_input = ['-f', 'image2', '-pattern_type', 'none'] if still else []
    result = subprocess.run([binary('ffprobe'), '-v', 'error', '-show_streams', '-show_format',
                             '-of', 'json', *probe_input, str(path)], capture_output=True, text=True)
    if result.returncode:
        raise VideoError(f'Cannot inspect video: {path.name}: {result.stderr[:500]}')
    metadata = json.loads(result.stdout)
    stream = next((s for s in metadata['streams'] if s['codec_type'] == 'video'), None)
    if not stream:
        raise VideoError(f'No video stream: {path.name}')
    if still:
        if stream.get('codec_name') not in ('png', 'mjpeg') or not (stream.get('width') and stream.get('height')):
            raise VideoError(f'Expected a PNG or JPEG still: {path.name}')
        return {'width': stream['width'], 'height': stream['height']}
    try:
        fps = float(Fraction(stream.get('r_frame_rate', '0')))
    except (ValueError, ZeroDivisionError):
        raise VideoError(f'Invalid video frame rate: {path.name}') from None
    return {'duration': float(stream.get('duration', metadata['format']['duration'])),
            'width': stream['width'], 'height': stream['height'],
            'fps': fps,
            'has_audio': any(s['codec_type'] == 'audio' for s in metadata['streams'])}


def plan_edit(config, directory):
    fields = {'clips', 'aesthetic_timeline', 'output', 'width', 'height', 'fps', 'crf', 'show_ai_badge'}
    if not isinstance(config, dict) or set(config) - fields:
        raise VideoError('Unsupported edit configuration.')
    if ('clips' in config) == ('aesthetic_timeline' in config):
        raise VideoError('Supply exactly one of clips and aesthetic_timeline.')
    if not isinstance(config.get('output'), str) or not config['output'].strip():
        raise VideoError('output must be a file path.')
    output = (directory / config['output']).resolve()
    if output.exists():
        raise VideoError('Output already exists; choose a new output path.')
    badge = config.get('show_ai_badge', False)
    if not isinstance(badge, bool):
        raise VideoError('show_ai_badge must be boolean.')
    if 'aesthetic_timeline' in config:
        if any(config.get(key, size) != size for key, size in [('width', 720), ('height', 1280), ('fps', 30)]):
            raise VideoError('aesthetic_timeline exports 720x1280 at 30 fps.')
        crf = number(config.get('crf', 17), 0, 51, 'crf')
        try:
            timeline = aesthetic_edit.prepare(config['aesthetic_timeline'], directory, probe_video)
        except ValueError as error:
            raise VideoError(str(error)) from error
        return {'aesthetic_timeline': timeline, 'output': str(output), 'width': 720,
                'height': 1280, 'fps': 30, 'duration': 13.5, 'crf': crf, 'show_ai_badge': badge}
    clips = config['clips']
    if not isinstance(clips, list) or not clips:
        raise VideoError('clips must be a nonempty ordered list.')
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
            'fps': fps, 'crf': crf, 'show_ai_badge': badge, 'duration': sum(c['duration'] for c in prepared)}


def concat_command(plan, executable, destination):
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
    video = '[v]'
    if plan.get('show_ai_badge', False):
        filters.append('[v]ass=filename=overlay.ass[marked]')
        video = '[marked]'
    command += ['-filter_complex', ';'.join(filters), '-map', video, '-map', '[a]',
                '-r', str(fps), '-c:v', 'libx264', '-preset', 'fast', '-crf', str(plan['crf']),
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
                str(destination)]
    return command


def edit_video(plan):
    output = Path(plan['output'])
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='.edit-') as directory:
        temporary = Path(directory) / 'export.mp4'
        aesthetic = 'aesthetic_timeline' in plan
        if aesthetic or plan.get('show_ai_badge', False):
            (Path(directory) / 'overlay.ass').write_text(aesthetic_edit.subtitles(plan), encoding='utf-8')
        build = aesthetic_edit.command if aesthetic else concat_command
        command = build(plan, binary('ffmpeg'), temporary)
        result = subprocess.run(command, cwd=directory, capture_output=True, text=True)
        if result.returncode:
            raise VideoError(f'FFmpeg failed: {result.stderr[:1500]}')
        metadata = probe_video(temporary)
        tolerance = 0.001 if aesthetic else max(0.1, len(plan['clips']) / plan['fps'])
        if abs(metadata['duration'] - plan['duration']) > tolerance:
            raise VideoError('Export duration differs from planned timeline.')
        publish(temporary, output)
        return {'status': 'completed', 'path': str(output), 'metadata': metadata,
                'size_bytes': output.stat().st_size}


def run(request, base_dir=None):
    """Synchronous dispatch; submit returns immediately; wait is bounded.

    Relative request paths resolve from base_dir (CLI: request JSON's directory).
    Relative reference/clip paths resolve from the selected config JSON's directory.
    """
    if not isinstance(request, dict):
        raise VideoError('Request must be a JSON object.')
    directory = Path(base_dir or Path.cwd()).resolve()
    action = request.get('action')
    if action == 'generate':
        return generate_video(request, directory)
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
    spark = None
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
        spark = spark_provider(config.get('model')) if isinstance(config, dict) else None
        if spark:
            frame, fields = spark.prepare(config, config_dir)
            if action == 'validate':
                return {'status': 'validated', 'generation_mode': 'first_frame' if frame else 'text',
                        **({'first_frame': str(frame)} if frame else {}),
                        'reference_count': 0, 'video_reference_count': 0,
                        'settings': {**{k: v for k, v in fields.items() if k != 'prompt'},
                                     'model': spark.MODEL}}
        else:
            payload = build_payload(config, config_dir)
        if action == 'validate':
            return {'status': 'validated', 'settings': {k: v for k, v in payload.items() if k != 'content'},
                    'reference_count': len(config.get('reference_images', [])),
                    'video_reference_count': len(config.get('reference_videos', [])),
                    'generation_mode': 'first_frame' if 'first_frame' in config or 'first_frame_path' in config else
                                       'reference' if config.get('reference_images') or config.get('reference_videos') else 'text',
                    **({'first_frame': config['first_frame'], 'asset_validation': 'not_checked'}
                       if 'first_frame' in config else
                       {'first_frame': str((config_dir/config['first_frame_path']).resolve())}
                       if 'first_frame_path' in config else {})}
    output = (directory / request['output_dir']).resolve()
    output.mkdir(parents=True, exist_ok=True)
    state = output / 'task.json'
    if action != 'submit' and state.exists():
        record = json.loads(state.read_text())
        spark = spark_provider(record.get('provider'))
        if spark and record.get('host') != spark_h3.host():
            raise VideoError('Use the same Spark SSH host that accepted this task.')
    if not spark and action != 'submit' and str(request.get('task_id', '')).startswith('veda_'):
        raise VideoError('Use the output_dir containing the saved Spark Veda task record.')
    key = '' if spark else credential()
    if action == 'submit':
        origin = {'provider': spark.MODEL, 'host': spark_h3.host()} if spark else {}
        if spark is spark_veda:
            # The ID is chosen before the SSH handoff so even a lost acknowledgement can be reconciled.
            origin['id'] = 'veda_' + uuid.uuid4().hex
        try:
            with state.open('x') as file:
                json.dump({**origin, 'status': 'submitting'}, file)
        except FileExistsError:
            raise VideoError('Task record already exists; query or resume it instead of submitting again.') from None
        try:
            if spark:
                save_json(output / 'config.json', {**config, **({'first_frame_path': str(frame)} if frame else {})})
                save_json(output / 'request.json', {**fields, **({'input_reference': str(frame)} if frame else {})})
                if spark is spark_veda:
                    task_id = origin['id']
                    if spark.submit(origin['host'], task_id, frame, fields).get('id') != task_id:
                        raise VideoError('Spark Veda returned an unexpected job ID.')
                else:
                    task_id = spark.submit(origin['host'], frame, fields).get('id')
                    if not isinstance(task_id, str) or not re.fullmatch(r'video_gen_[a-fA-F0-9]{32}', task_id):
                        raise VideoError('Unconfirmed Spark task ID; check existing Spark jobs before resubmitting.')
                save_json(state, {**origin, 'id': task_id, 'status': 'submitted'})
                return {'task_id': task_id, 'status': 'submitted', 'output_dir': str(output)}
            saved_config = dict(config)
            if 'first_frame_path' in config:
                saved_config['first_frame_path'] = str((config_dir/config['first_frame_path']).resolve())
            saved_config['reference_images'] = [str((config_dir / p).resolve()) for p in config.get('reference_images', [])]
            if 'reference_videos' in config:
                saved_config['reference_videos'] = [str((config_dir / p).resolve()) for p in config['reference_videos']]
            save_json(output / 'config.json', json.loads(safe_message_json(saved_config, key)))
            if 'first_frame' in config:
                # This mode has text plus an opaque asset URI, no signed URLs or
                # embedded image bytes. Persist the exact API contract before POST.
                save_json(output / 'request.json', json.loads(safe_message_json(payload, key)))
            uploaded = []
            for item, name in zip((c for c in payload['content'] if c['type'] == 'video_url'),
                                  config.get('reference_videos', [])):
                path = (config_dir / name).resolve()
                media = upload_reference_video(path, key)
                # Persist identifiers for recovery, never temporary signed URLs.
                uploaded.append({'id': media['id'], 'path': str(path), 'expire_at': media.get('expire_at')})
                save_json(output / 'reference_uploads.json', uploaded)
                item['video_url']['url'] = media['download_url']
            task = request_json('POST', TASKS, key, payload)
            task_id = task.get('id')
            if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', task_id):
                raise VideoError('No valid task ID; check Ark task history before trying again.')
        except Exception as error:
            save_json(state, {**origin, 'status': 'submission_not_confirmed', 'error': safe_message(error, key)})
            raise
        save_json(state, {'id': task_id, 'status': 'submitted'})
        return {'task_id': task_id, 'status': 'submitted', 'output_dir': str(output)}
    task_id = resolve_task(request, output)
    if action == 'wait':
        poll = number(request.get('poll_seconds', 15), 1, 60, 'poll_seconds')
        timeout = number(request.get('timeout_seconds', 60), 0, 3600, 'timeout_seconds')
        deadline = time.monotonic() + timeout
        while True:
            result = query_task(task_id, key, output, spark=spark)
            if result['status'] not in ('queued', 'running', 'pending', 'submitted'):
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                result['timed_out'] = True
                return result
            time.sleep(min(poll, remaining))
    result = query_task(task_id, key, output, spark=spark)
    if action == 'download':
        if result['status'] != 'succeeded':
            raise VideoError(f'Task is {result["status"]}; download requires succeeded.')
        filename = request.get('filename', 'video.mp4')
        if not isinstance(filename, str) or Path(filename).name != filename or not filename.endswith('.mp4'):
            raise VideoError('filename must be an MP4 basename.')
        destination = output / filename
        fetch_clip(result, destination, spark)
        result.update(path=str(destination), size_bytes=destination.stat().st_size)
    return result

def fetch_clip(result, destination, spark):
    if spark is None:
        download_video(result['task'].get('content', {}).get('video_url'), destination)
        return
    if destination.exists():
        raise VideoError('Video output already exists; choose another filename.')
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix='.mp4') as temp:
        spark.download(spark_h3.host(), result['task_id'], temp)
        temp.flush()
        if spark is spark_veda and digest_file(Path(temp.name)) != result['task'].get('sha256'):
            raise RetryableVideoError('Spark Veda download digest mismatch; retry download for the same task.')
        result['metadata'] = probe_video(Path(temp.name))
        os.link(temp.name, destination)


def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def generate_input(request, directory):
    if 'config_path' in request:
        config_path = (directory / request['config_path']).resolve()
        config = json.loads(config_path.read_text())
        directory = config_path.parent
    else:
        config = request['config']
    if not isinstance(config, dict):
        raise VideoError('config must be an object.')
    config = dict(config)
    # Include file content in operation identity: replacing a frame at the same
    # path must not return an earlier clip as if it had used the replacement.
    hashes = {}
    for field in ('reference_images', 'reference_videos', 'first_frame_path'):
        if field not in config:
            continue
        names = [config[field]] if field == 'first_frame_path' else config[field]
        if not isinstance(names, list) or not all(isinstance(n, str) and n and '://' not in n for n in names):
            raise VideoError(f'Invalid local media in {field}.')
        paths = [(directory / n).resolve() for n in names]
        size_limit = 200 if field == 'reference_videos' else 30
        for path in paths:
            if not path.is_file() or not 0 < path.stat().st_size <= size_limit * 1024 * 1024:
                raise VideoError(f'Missing, empty or oversized reference file: {path.name}')
            hashes[str(path)] = digest_file(path)
        config[field] = str(paths[0]) if field == 'first_frame_path' else list(map(str, paths))
    identity = json.dumps([config, hashes], sort_keys=True, ensure_ascii=False).encode()
    return config, hashlib.sha256(identity).hexdigest()


def replay_clip(record, destination, task_id):
    if not destination.exists() and not destination.is_symlink():
        return None
    artifact = record.get('artifact', {})
    if (destination.is_symlink() or not destination.is_file() or artifact.get('task_id') != task_id
            or destination.stat().st_size != artifact.get('size_bytes') or digest_file(destination) != artifact.get('sha256')):
        raise VideoError('Destination already exists or changed; cannot overwrite or replay it.')
    return {**artifact, 'status': 'succeeded', 'output_dir': str(destination.parent), 'path': str(destination)}


def generate_video(request, directory):
    allowed = {'action', 'config', 'config_path', 'task_id', 'output_dir', 'filename', 'timeout_seconds', 'poll_seconds'}
    if set(request) - allowed or sum(k in request for k in ('config', 'config_path', 'task_id')) != 1:
        raise VideoError('Supply config or config_path to generate, or task_id to resume.')
    if not isinstance(request.get('output_dir'), str) or not request['output_dir'].strip():
        raise VideoError('output_dir is required.')
    filename = request.get('filename', 'video.mp4')
    if (not isinstance(filename, str) or Path(filename).name != filename or '\\' in filename
            or not filename.endswith('.mp4') or len(filename) <= 4):
        raise VideoError('filename must be an MP4 basename.')
    timeout = number(request.get('timeout_seconds', 900), 0, 3600, 'timeout_seconds')
    poll = number(request.get('poll_seconds', 15), 1, 60, 'poll_seconds')
    config, fingerprint = (None, None) if 'task_id' in request else generate_input(request, directory)
    output = (directory / request['output_dir']).resolve()
    if 'task_id' in request and not output.is_dir():
        raise VideoError('Resume requires the output_dir and task_id of the original task.')
    output.mkdir(parents=True, exist_ok=True)
    journal, state, destination = output/'generate.json', output/'task.json', output/filename
    with (output/'.generate.lock').open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if 'task_id' in request:
            if (not isinstance(request['task_id'], str) or not request['task_id'] or not state.is_file()
                    or json.loads(state.read_text()).get('id') != request['task_id']):
                raise VideoError('Resume requires the output_dir and task_id of the original task.')
        if journal.exists():
            record = json.loads(journal.read_text())
            if record['filename'] != filename or fingerprint and record['fingerprint'] != fingerprint:
                raise VideoError('Existing video generation has a different configuration or filename.')
            if not state.is_file():
                raise VideoError('The recorded submission is missing its task state. Check the original job before retrying.')
        else:
            if fingerprint and state.exists():
                raise VideoError('This directory already has a task; resume it by its task_id.')
            if destination.exists() or destination.is_symlink():
                raise VideoError('Destination already exists; choose another output path.')
            if config is not None:
                run({'action': 'validate', 'config': config}, directory)
                if not spark_provider(config.get('model')):
                    credential()
            record = {'filename': filename, 'fingerprint': fingerprint}
            save_json(journal, record)
        if not state.exists():
            if config is None:
                raise VideoError('Cannot create a new video task from a resume request.')
            try:
                run({'action': 'submit', 'config': config, 'output_dir': str(output)}, directory)
            except (VideoError, OSError):
                # Spark assigns the job ID before dispatch. Reconcile a lost SSH reply;
                # Ark POST without a returned ID remains unconfirmed and cannot be replayed.
                if not state.exists() or not json.loads(state.read_text()).get('id'):
                    raise
        task_id = resolve_task(request, output)
        if record.get('task_id') and record['task_id'] != task_id:
            raise VideoError('Task record no longer matches the original generation.')
        if 'task_id' not in record:
            record['task_id'] = task_id
            save_json(journal, record)
        replayed = replay_clip(record, destination, task_id)
        if replayed:
            return replayed
    args = {'task_id': task_id, 'output_dir': str(output)}
    query = {**args, 'action': 'status'}
    if timeout:
        query.update(action='wait', poll_seconds=poll, timeout_seconds=timeout)
    try:
        result = run(query, directory)
    except (RetryableVideoError, OSError) as error:
        return {**args, 'status': 'running', 'phase': 'polling', 'error': safe_message(error)}
    status = result['status']
    if status != 'succeeded':
        detail = result.get('error') or result['task'].get('error')
        return {**args, 'status': status, **({'timed_out': True} if result.get('timed_out') else {}),
                **({'error': safe_message(detail)} if detail else {})}
    with (output/'.generate.lock').open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = json.loads(journal.read_text())
        replayed = replay_clip(record, destination, task_id)
        if replayed:
            return replayed
        with tempfile.TemporaryDirectory(dir=output, prefix='.download-') as tmp:
            clip = Path(tmp)/'raw.mp4'
            spark = spark_provider(result['task'].get('provider'))
            try:
                fetch_clip(result, clip, spark)
            except (RetryableVideoError, OSError) as error:
                return {**args, 'status': 'running', 'phase': 'downloading', 'error': safe_message(error)}
            metadata = result.get('metadata') or probe_video(clip)
            if spark:
                # Native H3 emits extra tail frames. The public artifact has the
                # requested playback duration; video_download still returns the raw clip.
                seconds = json.loads((output/'config.json').read_text()).get('duration', 4)
                if metadata['duration'] < seconds - 0.001:
                    raise VideoError('Spark output is shorter than the requested duration.')
                if metadata['duration'] > seconds + 0.001:
                    trimmed = Path(tmp)/'delivery.mp4'
                    command = [binary('ffmpeg'), '-nostdin', '-v', 'error', '-i', str(clip),
                               '-t', str(seconds), '-c:v', 'libx264', '-crf', '17', '-pix_fmt', 'yuv420p',
                               '-c:a', 'aac', '-movflags', '+faststart', str(trimmed)]
                    encoded = subprocess.run(command, capture_output=True, text=True)
                    if encoded.returncode:
                        raise VideoError('FFmpeg could not trim the Spark clip: ' + encoded.stderr[:500])
                    clip = trimmed
                    metadata = probe_video(clip)
                    if abs(metadata['duration'] - seconds) > 0.001:
                        raise VideoError('Trimmed Spark output differs from the requested duration.')
            artifact = {'task_id': task_id, 'metadata': metadata, 'sha256': digest_file(clip),
                        'size_bytes': clip.stat().st_size}
            # Save proof before publishing. A crash on either side of link() can be
            # recovered without trusting some other pre-existing MP4.
            save_json(journal, {**record, 'artifact': artifact})
            publish(clip, destination)
        return {**args, **artifact, 'status': 'succeeded', 'path': str(destination)}


def invoke(name, arguments, base_dir=None):
    """Named tool boundary; gateway authorizes name/arguments before calling."""
    names = {f'video_{action}': action for action in
             ('validate', 'submit', 'status', 'wait', 'download', 'edit', 'generate')}
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
