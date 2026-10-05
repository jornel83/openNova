#!/usr/bin/env python3
"""Generate one original Ark portrait, or download its saved response without regenerating."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from seedance_video import API_BASE, ROOT, VideoError, safe_message, save_json


def download_original(url, destination):
    if not url.startswith('https://'):
        raise VideoError('Expected an HTTPS image URL.')
    temporary = destination.with_suffix('.png.part')
    # The provider download endpoint never receives the Ark API key.
    with urlopen(url, timeout=120) as response, temporary.open('wb') as output:
        expected = response.headers.get('Content-Length')
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    if expected is not None and temporary.stat().st_size != int(expected):
        raise VideoError('Incomplete download; use --download-saved, not --submit.')
    with temporary.open('rb') as image:
        if image.read(8) != b'\x89PNG\r\n\x1a\n':
            raise VideoError('Expected a PNG original; downloaded file was not published.')
    temporary.replace(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--submit', action='store_true')
    mode.add_argument('--download-saved', action='store_true')
    parser.add_argument('--config', type=Path, default=ROOT / 'seedream-character-v01.json')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'out' / 'seedream-character-v01')
    args = parser.parse_args()
    key = ''
    state = None
    try:
        if args.dry_run or args.submit:
            config = json.loads(args.config.read_text())
            if 'image' in config or config.get('output_format') != 'png' or config.get('response_format') != 'url':
                raise VideoError('This workflow requires text-only input and a PNG original URL.')
            print(json.dumps(config, ensure_ascii=False, indent=2), flush=True)
            if args.dry_run:
                print('Dry run passed. No request sent.')
                return 0
            if (args.output_dir / 'state.json').exists():
                raise VideoError('Existing request record: do not resubmit. Use --download-saved if a response exists.')
            key = os.environ.get('ARK_API_KEY', '').strip()
            if not key and sys.stdin.isatty():
                key = getpass.getpass('ARK_API_KEY (hidden): ').strip()
            if not key:
                raise VideoError('Set ARK_API_KEY or enter it at the hidden interactive prompt.')
            args.output_dir.mkdir(parents=True, exist_ok=True)
            state = args.output_dir / 'state.json'
            with state.open('x') as record:
                json.dump({'status': 'submitting'}, record)
            save_json(args.output_dir / 'config.json', config)
            request = Request(API_BASE + '/images/generations',
                              data=json.dumps(config).encode(), method='POST',
                              headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
            # Exactly one POST. An uncertain outcome is never automatically retried.
            with urlopen(request, timeout=300) as response:
                request_id = response.headers.get('x-request-id')
                result = json.load(response)
            save_json(args.output_dir / 'response.json', result)
            save_json(state, {'status': 'response_saved', 'request_id': request_id})
        else:
            result = json.loads((args.output_dir / 'response.json').read_text())
        images = result.get('data', [])
        if len(images) != 1 or not images[0].get('url'):
            raise VideoError('Expected one image URL. Inspect saved response; do not resubmit blindly.')
        destination = args.output_dir / 'character.png'
        download_original(images[0]['url'], destination)
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        save_json(args.output_dir / 'original.json', {
            'file': destination.name, 'sha256': digest,
            'model': result.get('model'), 'created': result.get('created'),
            'size': images[0].get('size'), 'modified': False})
        save_json(args.output_dir / 'state.json', {'status': 'saved', 'file': destination.name})
        print(f'Original image saved: {destination.resolve()}', flush=True)
        return 0
    except (OSError, ValueError, KeyError, VideoError) as error:
        detail = error.read().decode('utf-8', errors='replace') if isinstance(error, HTTPError) else str(error)
        message = safe_message(detail, key)
        if state:
            save_json(state, {'status': 'error', 'error': message})
        print(f'Error: {message}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
