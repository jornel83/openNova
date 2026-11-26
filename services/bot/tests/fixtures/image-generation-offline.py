"""Narrow, test-process-only replacement for the Ark transport."""
import base64
from functools import partial
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import sys

from PIL import Image

def deny_network(*_args, **_kwargs):
    raise AssertionError('provider fixture forbids network access')

socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
socket.create_connection = deny_network

assert sys.argv[1:3] == ['-I', '-B'] and Path(sys.argv[3]).parts[-3:] == ('tools', 'image', 'tool.py')
root = Path(sys.argv[3]).resolve(strict=True).parents[2]
sys.path.insert(0, str(root))
from tools.image.providers import ark_provider as ark
from tools.image import gif_generation, tool

key_file = os.environ.get('OPENNOVA_IMAGE_ARK_KEY_FILE')
fixture_home = Path(key_file).parent if key_file else None
task_id = 'offline-seedance-task'
fixture_url = 'https://fixture.test/private-offline-video'


def log_video_event(event, value):
    with (fixture_home / 'video-events.jsonl').open('a') as log:
        log.write(json.dumps([event, value]) + '\n')


def image(self, payload):
    assert self._credential.secret == 'test-only-offline-key', 'attempted to read a non-fixture key'
    assert payload['model'] == ark.IMAGE_MODEL
    edited = payload['prompt'] == '换白色圆领无帽卫衣'
    if edited:
        reference = payload['image'].split(',', 1)[1]
        with Image.open(io.BytesIO(base64.b64decode(reference, validate=True))) as im:
            assert im.convert('RGB').getpixel((0, 0)) == (61, 99, 137)
        color = (240, 243, 238)
    else:
        assert payload['prompt'] == '元气满满' and 'image' not in payload
        color = (61, 99, 137)
    w, h = (1536, 768) if edited else (1024, 1024)
    with (fixture_home / 'image-events.jsonl').open('a') as log:
        log.write(json.dumps(['post', 'edit' if edited else 'create']) + '\n')
    with io.BytesIO() as stream:
        Image.new('RGB', (w, h), color).save(stream, 'PNG')
        data = base64.b64encode(stream.getvalue()).decode('ascii')
    return ark.APIResponse({'data': [{'b64_json': data}], 'usage': {'generated_images': 1}},
                           'offline-edit' if edited else 'offline-create', 200)


def create_video(self, payload):
    assert self._credential.secret == 'test-only-offline-key'
    assert payload['model'] == ark.VIDEO_MODEL
    assert payload['duration'] == 4 and payload['ratio'] == 'adaptive'
    reference = payload['content'][1]
    assert reference['role'] == 'first_frame'
    raw = base64.b64decode(reference['image_url']['url'].split(',', 1)[1], validate=True)
    log_video_event('post', hashlib.sha256(raw).hexdigest())
    return ark.APIResponse({'id': task_id}, 'offline-video-create', 200)


def get_video(self, requested_id):
    assert requested_id == task_id
    log_video_event('query', requested_id)
    if (fixture_home / 'video-ready').exists():
        body = {'id': task_id, 'status': 'succeeded', 'content': {'video_url': fixture_url}}
    else:
        body = {'id': task_id, 'status': 'running'}
    return ark.APIResponse(body, 'offline-video-query', 200)


def download_video(self, url, target):
    assert url == fixture_url
    log_video_event('download', task_id)
    shutil.copyfile(fixture_home / 'video-fixture.mp4', target)


ark.ArkClient.create_image = image
ark.ArkClient.create_video = create_video
ark.ArkClient.get_video = get_video
ark.ArkClient.download_video = download_video
gif_generation.run_gif = partial(gif_generation.run_gif, wait_seconds=0)
# Preserve normal arguments and import the actual worker chosen by the host.
sys.argv = [sys.argv[3], *sys.argv[4:]]
raise SystemExit(tool.main())
