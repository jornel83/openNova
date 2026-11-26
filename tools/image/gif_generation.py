"""Durable Seedance task and local delivery for the foreground GIF tool."""
import base64
from contextlib import closing, contextmanager
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time
from uuid import uuid4

from tools.image import export, video_gif
from tools.image.bundle import run_gif_bundle
from tools.image.generation import ROOT, _expected_hashes, _freeze_reference, _project_path
from tools.image.operations import (
    MAX_INPUT_BYTES, MAX_TOTAL_BYTES, OperationError, atomic_json, executor_runtime,
    fsync_directory, result_for, sha, validate_snapshot, verify_artifact,
)
from tools.image.providers import ark_provider as ark
from tools.image.schema import ContractError, FORMATS, normalize


FILES = {'video': 'source.mp4', 'gif': 'animation.gif', 'firstFrame': 'first-frame.png'}
INPUTS = ('sourcePath', 'motionReferencePath', 'fixedOverlayPath')
TERMINAL = {'completed', 'failed', 'cancelled', 'unknown'}
DIRECTORY_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY


def _result(record):
    return {**result_for(record), **{key: record[key] for key in
            ('artifacts', 'firstFrameValidation', 'terminalStatus', 'bookkeepingPending') if key in record}}


def _runtime():
    return {**executor_runtime(video=True), 'generationRevision': sha(__file__),
            'providerRevision': sha(ark.__file__)}


def _request(arguments, workspace):
    request = normalize('gif_generate', arguments, workspace)
    if not request['motion'].strip():
        raise OperationError('empty_gif_motion')
    request.update(mode='video', model=ark.VIDEO_MODEL)
    for field, value in (('durationSeconds', 4), ('videoResolution', '480p'), ('fps', 10), ('loop', 0),
                         ('maxBytes', MAX_INPUT_BYTES)):
        request.setdefault(field, value)
    if 'width' in request and (
            request['width'] * request['height'] * request['durationSeconds'] * request['fps'] > video_gif.MAX_PIXELS):
        raise OperationError('output_pixel_limit_exceeded')
    return request


@contextmanager
def _directory(workspace, path):
    fd = os.open(workspace, DIRECTORY_FLAGS)
    try:
        for component in path.relative_to(workspace).parts:
            child = os.open(component, DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _identity(info):
    return [info.st_dev, info.st_ino]


@contextmanager
def _output(record, workspace, state_dir):
    target = _project_path(record['request']['outputDir'], workspace, state_dir)
    with _directory(workspace, target) as fd:
        if _identity(os.fstat(fd)) != record['parentIdentity']:
            raise OperationError('target_parent_changed')
        yield target, fd


def _prepare(record, directory, workspace, state_dir):
    request = record['request']
    tools = record['runtime']['videoTools']
    if any(tool['status'] != 'available' for tool in tools.values()):
        raise OperationError('video_dependency_missing')
    inputs = directory / 'inputs'
    inputs.mkdir(mode=0o700, exist_ok=True)
    frozen = []
    for key in INPUTS:
        if key not in request:
            continue
        path = _project_path(request[key], workspace, state_dir)
        extension = path.suffix.lower()
        if FORMATS.get(extension) not in ('png', 'jpeg', 'webp'):
            raise OperationError('unsupported_gif_reference_format')
        snapshot = inputs / (key + extension)
        if snapshot.is_file() and not snapshot.is_symlink():
            snapshot.unlink()
        data = _freeze_reference(path, workspace, snapshot)
        expected = record['expectedReferenceHashes'].get(str(path))
        if expected and expected != data['sha256']:
            raise OperationError('reference_version_changed', {'field': key})
        if sum(item['bytes'] for item in frozen) + data['bytes'] > MAX_TOTAL_BYTES:
            raise OperationError('inputs_too_large')
        if key == 'fixedOverlayPath':
            export.load_fixed_overlay(snapshot, (request['width'], request['height']))
        meta = export.inspect_media(snapshot)
        if meta['frames'] != 1:
            raise OperationError('invalid_gif_reference', {'field': key})
        frozen.append({**data, 'role': key, 'format': meta['format']})
    target = _project_path(request['outputDir'], workspace, state_dir)
    with _directory(workspace, target.parent) as parent:
        try:
            os.mkdir(target.name, mode=0o700, dir_fd=parent)
        except FileExistsError:
            raise OperationError('media_target_exists') from None
        with _directory(workspace, target) as child:
            record.update(stage='prepared', parentIdentity=_identity(os.fstat(child)), inputs=frozen)
        os.fsync(parent)


def _payload(record):
    request = record['request']
    validate_snapshot(record)
    sources = {source['role']: source for source in record['inputs']}
    source = sources.get('motionReferencePath', sources['sourcePath'])
    raw = Path(source['snapshotPath']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != source['sha256']:
        raise OperationError('input_snapshot_changed')
    reference = f"data:image/{source['format']};base64," + base64.b64encode(raw).decode('ascii')
    return {'model': ark.VIDEO_MODEL, 'content': [
        {'type': 'text', 'text': request['motion']},
        {'type': 'image_url', 'role': 'first_frame', 'image_url': {'url': reference}}],
        'duration': request['durationSeconds'], 'resolution': request['videoResolution'],
        'ratio': 'adaptive', 'generate_audio': False, 'output_format': 'mp4', 'watermark': True}


def _save(record, path):
    atomic_json(path, record)
    return _result(record)


def _stop(record, path, status, code, details=None):
    record.update(status='partial' if record['artifacts'] else status, stage='stopped', finishedAt=time.time(),
                  error={'code': code, 'details': details or {}})
    if record['artifacts']:
        record['terminalStatus'] = status
    return _save(record, path)


def _provider_diagnostic(error):
    return {'category': error.category, 'httpStatus': error.status_code, 'errorCode': error.error_code,
            'requestId': error.request_id, 'reason': error.reason, 'responseMetadata': error.response_metadata}


def _credential():
    try:
        value = ark.resolve_credential(repo_root=ROOT)
    except ark.ConfigurationError:
        raise OperationError('gif_credential_invalid') from None
    if value is None:
        raise OperationError('gif_credential_missing')
    return value


def _submit(record, path, client, secret, hook):
    payload = _payload(record)
    generation = record['generation']
    record['stage'] = 'submitting'
    generation.update(status='submitting', remoteCalls=1)
    _save(record, path)
    if hook:
        hook('before_submit')
    try:
        response = client.create_video(payload)
    except ark.ProviderError as error:
        generation.update(_provider_diagnostic(error))
        generation['status'] = 'unknown' if error.outcome_unknown else 'rejected'
        return _stop(record, path, 'unknown' if error.outcome_unknown else 'failed',
                     'gif_submission_unknown' if error.outcome_unknown else error.reason)
    task_id = ark.request_id({'x-request-id': response.body.get('id')}, secret)
    generation.update(requestId=ark.request_id({'x-request-id': response.request_id}, secret),
                      httpStatus=response.status_code)
    if not task_id:
        generation['status'] = 'unknown'
        return _stop(record, path, 'unknown', 'gif_submission_unknown')
    generation.update(status='submitted', taskId=task_id)
    record.update(status='pending', stage='submitted')
    receipt = _save(record, path)
    if hook:
        hook('after_submit')
    return receipt


def _video_info(path, cancel_check):
    info = path.stat()
    if path.is_symlink() or not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_INPUT_BYTES:
        raise OperationError('downloaded_video_invalid')
    with path.open('rb') as reader:
        if reader.read(8)[4:8] != b'ftyp':
            raise OperationError('downloaded_video_invalid')
    ffprobe = shutil.which('ffprobe')
    if not ffprobe:
        raise OperationError('video_dependency_missing')
    video = video_gif._probe(ffprobe, path, cancel_check)
    return {'path': str(path), 'bytes': info.st_size, 'sha256': sha(path), 'format': 'mp4',
            'width': video['width'], 'height': video['height'], 'durationMs': float(video['durationMs'])}


def _download(record, path, client, body, cancel_check, hook):
    content = body.get('content')
    url = content.get('video_url') if isinstance(content, dict) else None
    target = path.with_name('provider.mp4')
    if target.is_symlink():
        raise OperationError('invalid_video_staging_path')
    target.unlink(missing_ok=True)
    try:
        client.download_video(url, target)
    except (ark.ProviderError, OSError, http.client.HTTPException) as error:
        details = {'reason': error.reason, 'httpStatus': error.status_code} if isinstance(error, ark.ProviderError) else {}
        record['error'] = {'code': 'gif_download_pending', 'details': details}
        return _save(record, path)
    fsync_directory(target.parent)
    record['generation']['sourceArtifact'] = _video_info(target, cancel_check)
    record['stage'] = 'downloaded'
    record.pop('error', None)
    _save(record, path)
    if hook:
        hook('after_download')
    return None


def _poll(record, path, client, secret, cancel_check, hook, wait_seconds):
    deadline = time.monotonic() + wait_seconds
    generation = record['generation']
    while True:
        if cancel_check and cancel_check():
            raise OperationError('media_cancelled')
        try:
            reply = client.get_video(generation['taskId'])
        except ark.ProviderError as error:
            record['error'] = {'code': 'gif_status_query_pending', 'details': _provider_diagnostic(error)}
            return _save(record, path)
        body = reply.body
        state = body.get('status')
        generation['statusRequestId'] = ark.request_id({'x-request-id': reply.request_id}, secret)
        if body.get('id') not in (None, generation['taskId']) or state not in (
                'queued', 'running', 'failed', 'cancelled', 'expired', 'succeeded'):
            record['error'] = {'code': 'gif_status_response_invalid'}
            return _save(record, path)
        generation['providerStatus'] = state
        record.pop('error', None)
        if state in ('failed', 'cancelled', 'expired'):
            failure = ark.error_from_response(400, body)
            generation.update(status=state, category=failure.category,
                              errorCode=failure.error_code if failure.error_code and secret not in failure.error_code else None)
            return _stop(record, path, 'cancelled' if state == 'cancelled' else 'failed', 'gif_task_' + state)
        if state == 'succeeded':
            generation['status'] = 'succeeded'
            _save(record, path)
            return _download(record, path, client, body, cancel_check, hook)
        _save(record, path)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return _result(record)
        time.sleep(min(2, remaining))


def _publish_video(record, path, target, fd, hook):
    source = record['generation']['sourceArtifact']
    video = target / FILES['video']
    if record['stage'] == 'downloaded':
        verify_artifact(source)
        temporary = '.source-' + uuid4().hex + '.part'
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        with os.fdopen(os.open(temporary, flags, 0o600, dir_fd=fd), 'wb') as output:
            with Path(source['path']).open('rb') as input_stream:
                shutil.copyfileobj(input_stream, output)
            output.flush()
            os.fsync(output.fileno())
            copy = _identity(os.fstat(output.fileno()))
        verify_artifact({**source, 'path': target / temporary})
        os.fsync(fd)
        record.update(stage='publishing_video', videoPublication={'name': temporary, 'identity': copy})
        _save(record, path)
    publication = record['videoPublication']
    try:
        published = os.stat(video.name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        copy = os.stat(publication['name'], dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(copy.st_mode) or _identity(copy) != publication['identity']:
            raise OperationError('publication_copy_changed')
        verify_artifact({**source, 'path': target / publication['name']})
        try:
            os.link(publication['name'], video.name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        except FileExistsError:
            pass
        published = os.stat(video.name, dir_fd=fd, follow_symlinks=False)
    if _identity(published) != publication['identity']:
        raise OperationError('media_target_exists')
    artifact = {**source, 'path': str(video)}
    verify_artifact(artifact)
    os.fsync(fd)
    if hook:
        hook('after_video_link')
    record['artifacts']['video'] = artifact
    record.update(stage='exporting', status='partial')
    _save(record, path)


def _deliver(record, path, directory, workspace, state_dir, cancel_check, hook):
    with _output(record, workspace, state_dir) as (target, fd):
        if record['stage'] in ('downloaded', 'publishing_video'):
            _publish_video(record, path, target, fd, hook)
        publication = record['videoPublication']
        try:
            if _identity(os.stat(publication['name'], dir_fd=fd, follow_symlinks=False)) == publication['identity']:
                os.unlink(publication['name'], dir_fd=fd)
        except FileNotFoundError:
            pass
        exported_video = record['artifacts']['video']
        source_video = record['generation']['sourceArtifact']
        verify_artifact(exported_video)
        verify_artifact(source_video)
        request = record['request']
        spec = {field: request[field] for field in ('width', 'height', 'fps', 'loop', 'maxBytes') if field in request}
        spec.update(action='video_to_gif', sourcePath=source_video['path'],
                    outputPath=str(target / FILES['gif']), durationMs=request['durationSeconds'] * 1000)
        overlay = next((source for source in record['inputs'] if source['role'] == 'fixedOverlayPath'), None)
        if overlay:
            verify_artifact({**overlay, 'path': overlay['snapshotPath']})
            spec['fixedOverlayPath'] = overlay['snapshotPath']
        bundle = run_gif_bundle(spec, target / FILES['firstFrame'], base_dir=workspace, state_dir=directory / 'local',
                                operation_id='publish', binding=record['binding'], cancel_check=cancel_check,
                                expected_parent_identity=record['parentIdentity'])
        record['artifacts'].update(bundle['artifacts'])
        if bundle['status'] == 'completed':
            gif = bundle['childOperations']['gif']
            if gif['inputs'][0]['sha256'] != source_video['sha256']:
                raise OperationError('exported_video_source_changed')
            if overlay and gif['artifact']['fixedOverlay']['sourceSha256'] != overlay['sha256']:
                raise OperationError('exported_fixed_overlay_changed')
            verify_artifact(exported_video)
            record.update(artifact=record['artifacts']['gif'], firstFrameValidation=bundle['firstFrameValidation'],
                          fileValidation={'status': 'passed', 'checks': ['sha256', 'gif_decode', 'exact_decoded_first_frame']},
                          animationValidation=gif['animationValidation'],
                          status='completed', stage='committed', finishedAt=time.time())
            record.pop('error', None)
            try:
                return _save(record, path)
            except OSError:
                return {**_result(record), 'bookkeepingPending': True}
        if bundle.get('terminalStatus') or bundle['status'] in ('failed', 'cancelled'):
            diagnostic = bundle['error']
            return _stop(record, path, bundle.get('terminalStatus', bundle['status']),
                         diagnostic['code'], diagnostic.get('details'))
        return _save(record, path)


def _run(record, path, directory, workspace, state_dir, factory, cancel_check, hook, recover_only, wait_seconds):
    stage = record['stage']
    if stage == 'submitting':
        record['generation']['status'] = 'unknown'
        return _stop(record, path, 'unknown', 'gif_submission_unknown')
    if stage in ('created', 'prepared') and recover_only:
        raise OperationError('gif_recovery_not_submitted')
    if stage in ('submitted', 'downloaded', 'publishing_video', 'exporting'):
        # The host freezes executable source separately. Keep the environment
        # tied to this job, while retaining recovery compatibility for M3 jobs
        # that predate immutable skill archives.
        active_runtime = _runtime()
        if any(record['runtime'].get(key) != active_runtime[key] for key in ('python', 'pillow', 'videoTools')):
            raise OperationError('media_runtime_changed')
    try:
        if cancel_check and cancel_check():
            raise OperationError('media_cancelled')
        if stage == 'created':
            _prepare(record, directory, workspace, state_dir)
            _save(record, path)
        if record['stage'] == 'prepared':
            if record['runtime'] != _runtime():
                raise OperationError('media_runtime_changed')
            with _output(record, workspace, state_dir):
                credential = _credential()
                record['generation']['credentialScope'] = credential.scope
                with closing(factory(credential)) as client:
                    return _submit(record, path, client, credential.secret, hook)
        if stage == 'submitted':
            try:
                credential = _credential()
            except OperationError as error:
                record['error'] = {'code': error.code}
                return _save(record, path)
            with _output(record, workspace, state_dir), closing(factory(credential)) as client:
                receipt = _poll(record, path, client, credential.secret, cancel_check, hook, wait_seconds)
                if receipt:
                    return receipt
        return _deliver(record, path, directory, workspace, state_dir, cancel_check, hook)
    except (OSError, ContractError, export.MediaExportError, ark.ConfigurationError) as error:
        code = getattr(error, 'code', 'gif_operation_io_error')
        if record['stage'] == 'submitting':
            record['generation']['status'] = 'unknown'
            return _stop(record, path, 'unknown', 'gif_submission_unknown')
        return _stop(record, path, 'cancelled' if code in ('media_cancelled', 'cancelled') else 'failed',
                     code, getattr(error, 'details', {}))


def run_gif(arguments, *, base_dir, state_dir, operation_id, binding=None, cancel_check=None,
            hook=None, client_factory=None, expected_reference_hashes=None, recover_only=False, wait_seconds=40):
    if not isinstance(operation_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', operation_id):
        raise OperationError('invalid_operation_id')
    workspace = Path(base_dir).resolve(strict=True)
    request = _request(arguments, workspace)
    expected = _expected_hashes(expected_reference_hashes, [request[key] for key in INPUTS if key in request], workspace)
    binding = binding or {}
    if (not isinstance(binding, dict) or set(binding) - {'projectId', 'requestId', 'taskId', 'runId'} or
            any(not isinstance(value, str) or len(value) > 200 for value in binding.values())):
        raise OperationError('invalid_host_binding')
    fingerprint = hashlib.sha256(json.dumps([request, str(workspace), binding], sort_keys=True).encode()).hexdigest()
    root = Path(state_dir).absolute()
    if root.is_symlink():
        raise OperationError('invalid_state_directory')
    if not recover_only:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root = root.resolve()
    directory = root / operation_id
    created = False
    if not recover_only:
        try:
            directory.mkdir(mode=0o700)
            fsync_directory(root)
            created = True
        except FileExistsError:
            pass
    if directory.is_symlink() or not directory.is_dir():
        raise OperationError('gif_operation_state_missing')
    path = directory / 'operation.json'
    lock_flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(directory / '.lock', lock_flags, 0o600), 'a+b') as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise OperationError('invalid_operation_directory')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise OperationError('operation_in_progress') from None
        if created:
            record = dict(schemaVersion=1, operationId=operation_id, tool='gif_generate', status='running',
                          stage='created', createdAt=time.time(), binding=binding, fingerprint=fingerprint,
                          request=request, expectedReferenceHashes=expected, runtime=_runtime(),
                          visualReview={'status': 'not_checked'}, artifacts={},
                          generation={'provider': 'ark', 'model': ark.VIDEO_MODEL, 'mode': 'video',
                                      'status': 'not_submitted', 'remoteCalls': 0})
            _save(record, path)
        else:
            if path.is_symlink() or not path.is_file():
                raise OperationError('gif_operation_state_missing')
            record = json.loads(path.read_text())
            if (record.get('tool') != 'gif_generate' or record.get('fingerprint') != fingerprint or
                    record.get('expectedReferenceHashes', {}) != expected):
                raise OperationError('operation_id_conflict')
            if record['status'] == 'completed':
                with _output(record, workspace, root):
                    for artifact in record['artifacts'].values():
                        verify_artifact(artifact)
            if record['status'] in TERMINAL or record.get('terminalStatus'):
                return _result(record)
        return _run(record, path, directory, workspace, root, client_factory or ark.ArkClient, cancel_check,
                    hook, recover_only, wait_seconds)
