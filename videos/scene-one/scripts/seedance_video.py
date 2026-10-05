#!/usr/bin/env python3
"""Generate or resume one Seedance sample using the official China Ark API.

Credentials: ARK_API_KEY environment variable, or a hidden interactive prompt.
Only Python's standard library is required. Submission is never retried.
"""
import argparse
import base64
import getpass
import json
import mimetypes
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
ROOT = Path(__file__).resolve().parents[1]
TASKS = '/contents/generations/tasks'


class VideoError(Exception):
    pass


def safe_message(value, key=''):
    message = str(value)
    if key:
        message = message.replace(key, '[REDACTED]')
    return message[:1500]


def save_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def build_payload(config, directory):
    payload = {field: config[field] for field in
               ('model', 'duration', 'ratio', 'resolution', 'generate_audio')}
    payload['content'] = [{'type': 'text', 'text': config['prompt']}]
    for name in config['reference_images']:
        path = (directory / name).resolve()
        media_type = mimetypes.guess_type(path.name)[0]
        if media_type not in ('image/png', 'image/jpeg', 'image/webp'):
            raise VideoError(f'Unsupported reference image format: {path.name}')
        if path.stat().st_size >= 30 * 1024 * 1024:
            raise VideoError(f'Reference image must be smaller than 30 MB: {path.name}')
        data = base64.b64encode(path.read_bytes()).decode('ascii')
        payload['content'].append({
            'type': 'image_url', 'role': 'reference_image',
            'image_url': {'url': f'data:{media_type};base64,{data}'}})
    if len(json.dumps(payload).encode()) >= 64 * 1024 * 1024:
        raise VideoError('Request exceeds the 64 MB limit.')
    return payload


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


def wait_for_task(task_id, key, output, poll_seconds, wait_seconds):
    deadline = time.monotonic() + wait_seconds
    previous = None
    while True:
        task = request_json('GET', f'{TASKS}/{task_id}', key)
        # Persist the ID even if a provider error payload omits it.
        task['id'] = task_id
        task = json.loads(safe_message_json(task, key))
        save_json(output / 'task.json', task)
        status = task.get('status', 'unknown')
        if status != previous:
            print(f'Task {task_id}: {status}', flush=True)
            previous = status
        if status == 'succeeded':
            if not task.get('content', {}).get('video_url'):
                raise VideoError('Task succeeded but did not return a video URL.')
            return task
        if status in ('failed', 'cancelled', 'canceled', 'expired'):
            raise VideoError(f'Generation {status}: '
                             f'{safe_message(task.get("error", task), key)}')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise VideoError(f'Task is still {status}. Resume with --resume {task_id}; '
                             'do not submit another task.')
        time.sleep(min(poll_seconds, remaining))


def safe_message_json(value, key):
    serialized = json.dumps(value, ensure_ascii=False)
    return serialized.replace(key, '[REDACTED]') if key else serialized


def download_video(url, destination):
    if not url.startswith('https://'):
        raise VideoError('Provider returned a non-HTTPS video URL.')
    temporary = destination.with_suffix('.mp4.part')
    try:
        # Never forward the Ark API key to the video storage endpoint.
        with urlopen(url, timeout=120) as response, temporary.open('wb') as output:
            expected_size = response.headers.get('Content-Length')
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if expected_size is not None and temporary.stat().st_size != int(expected_size):
            raise VideoError('Video download incomplete; use --resume to download again.')
        if temporary.stat().st_size == 0:
            raise VideoError('Downloaded video was empty.')
        temporary.replace(destination)
    except (URLError, TimeoutError):
        raise VideoError('Video download interrupted; use --resume to try downloading again.') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true', help='Validate locally; no API call or charge')
    mode.add_argument('--submit', action='store_true', help='Submit exactly one billable generation')
    mode.add_argument('--resume', nargs='?', const='', metavar='TASK_ID',
                      help='Query/download an existing task; defaults to saved ID')
    parser.add_argument('--config', type=Path, default=ROOT / 'seedance-sample-v07.json')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'out' / 'seedance-2-5-sample-v07')
    parser.add_argument('--model', help='Override with an enabled Ark model ID or endpoint ID')
    parser.add_argument('--poll-seconds', type=float, default=15)
    parser.add_argument('--wait-seconds', type=float, default=900)
    args = parser.parse_args()
    if args.poll_seconds <= 0 or args.wait_seconds <= 0:
        parser.error('Polling and wait durations must be positive.')
    key = ''
    try:
        state_path = args.output_dir / 'task.json'
        payload = None
        if args.submit or args.dry_run:
            config = json.loads(args.config.read_text())
            if args.model:
                config['model'] = args.model
            payload = build_payload(config, args.config.resolve().parent)
            summary = {k: v for k, v in payload.items() if k != 'content'}
            summary['reference_images'] = config['reference_images']
            print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
            if args.dry_run:
                print('Dry run passed. No API request was sent.')
                return 0
            if state_path.exists():
                raise VideoError('Output directory already contains a task record. '
                                 'Use --resume to continue; a new sample needs a different --output-dir.')
        else:
            task_id = args.resume or json.loads(state_path.read_text()).get('id', '')
            if not re.fullmatch(r'[A-Za-z0-9_-]+', task_id):
                raise VideoError('No valid task ID. Check task history in the Ark console before resubmitting.')

        key = os.environ.get('ARK_API_KEY', '').strip()
        if not key and sys.stdin.isatty():
            key = getpass.getpass('ARK_API_KEY (hidden): ').strip()
        if not key:
            raise VideoError('Set ARK_API_KEY, or run interactively to enter it privately.')
        args.output_dir.mkdir(parents=True, exist_ok=True)
        if args.submit:
            # Exclusive creation guards both repeat runs and concurrent submissions.
            with state_path.open('x') as record:
                json.dump({'status': 'submitting', 'model': payload['model']}, record)
            save_json(args.output_dir / 'config.json', config)
            try:
                submitted = request_json('POST', TASKS, key, payload)
                task_id = submitted.get('id')
                if not task_id:
                    raise VideoError('API returned no task ID; check Ark task history before trying again.')
            except VideoError as error:
                save_json(state_path, {'status': 'submission_not_confirmed',
                                      'error': safe_message(error, key)})
                raise
            save_json(state_path, {'id': task_id, 'status': 'submitted', 'model': payload['model']})
            print(f'Submitted task: {task_id}', flush=True)
        task = wait_for_task(task_id, key, args.output_dir, args.poll_seconds, args.wait_seconds)
        destination = args.output_dir / 'waterdrop-seedance.mp4'
        download_video(task['content']['video_url'], destination)
        print(f'Video saved: {destination.resolve()}', flush=True)
        return 0
    except (VideoError, OSError, ValueError, KeyError) as error:
        print(f'Error: {safe_message(error, key)}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('\nStopped waiting. The remote task may continue; use --resume.', file=sys.stderr)
        return 130


if __name__ == '__main__':
    sys.exit(main())
