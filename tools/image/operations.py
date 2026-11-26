"""Local media transactions: frozen inputs, durable intent and no-overwrite publish."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import tempfile
import time

from tools.image.schema import ContractError, normalize

MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024


class OperationError(ContractError):
    pass


def _video_tool_identity(name):
    # Match video_gif's PATH lookup. Inspect metadata only: no executable is run,
    # and missing FFmpeg never affects unrelated static-image operations.
    executable = shutil.which(name)
    if executable is None:
        return {'status': 'missing'}
    try:
        path = Path(executable).resolve(strict=True)
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):
            return {'status': 'unavailable'}
        return {'status': 'available', 'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
                'bytes': info.st_size, 'modifiedNs': info.st_mtime_ns, 'changedNs': info.st_ctime_ns}
    except OSError:
        return {'status': 'unavailable'}


def executor_runtime(*, video=False):
    import PIL
    digest = hashlib.sha256()
    for name in ('schema.py', 'export.py', 'operations.py', 'video_gif.py'):
        digest.update(name.encode() + b'\0')
        source = Path(__file__).with_name(name)
        if name == 'video_gif.py' and not source.exists():
            digest.update(b'<not-installed>')
        else:
            digest.update(source.read_bytes())
        digest.update(b'\0')
    result = {'python': platform.python_version(), 'pillow': PIL.__version__, 'executorRevision': digest.hexdigest()}
    if video:
        result['videoTools'] = {name: _video_tool_identity(name) for name in ('ffmpeg', 'ffprobe')}
    return result


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path, value):
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode()
    fd, tmp = tempfile.mkstemp(prefix='.record-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        fsync_directory(path.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def identity(path):
    value = Path(path).stat()
    return [value.st_dev, value.st_ino]


def freeze(path, destination, *, source_fd=None):
    # Opening a FIFO normally waits for a writer before we can inspect its type.
    # Open nonblocking, validate the descriptor itself, and only then read it.
    fd = source_fd if source_fd is not None else os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_INPUT_BYTES:
            raise OperationError('invalid_source_size_or_type')
        source = os.fdopen(fd, 'rb')
    except BaseException:
        os.close(fd)
        raise
    with source:
        with destination.open('xb') as target:
            os.chmod(destination, 0o600)
            count = 0
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                count += len(chunk)
                if count > MAX_INPUT_BYTES:
                    raise OperationError('source_too_large')
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        after = os.fstat(source.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise OperationError('source_changed_during_capture')
    return {'originalPath': str(path), 'snapshotPath': str(destination), 'bytes': count, 'sha256': sha(destination)}


def validate_snapshot(record):
    for source in record['inputs']:
        path = Path(source['snapshotPath'])
        if not path.is_file() or path.is_symlink() or path.stat().st_size != source['bytes'] or sha(path) != source['sha256']:
            raise OperationError('input_snapshot_changed')


def verify_artifact(artifact):
    path = Path(artifact['path'])
    if not path.is_file() or path.is_symlink():
        raise OperationError('committed_artifact_missing')
    if path.stat().st_size != artifact['bytes'] or sha(path) != artifact['sha256']:
        raise OperationError('committed_artifact_changed')


def result_for(record):
    return {key: record[key] for key in ('schemaVersion', 'operationId', 'tool', 'status', 'stage', 'binding', 'artifact',
             'inputs', 'runtime', 'fileValidation', 'animationValidation', 'visualReview', 'generation', 'error') if key in record}


def run_export(arguments, *, base_dir, state_dir, operation_id, binding=None, cancel_check=None, hook=None,
               expected_parent_identity=None, expected_reference_hashes=None):
    """Called with trusted host context; replay never rereads modified original input."""
    from tools.image.export import render_export, MediaExportError
    if not isinstance(operation_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', operation_id):
        raise OperationError('invalid_operation_id')
    base_dir = Path(base_dir).resolve(strict=True)
    request = normalize('media_export', arguments, base_dir)
    binding = dict(binding or {})
    if set(binding) - {'projectId', 'requestId', 'taskId', 'runId'} or any(not isinstance(v, str) or len(v) > 200 for v in binding.values()):
        raise OperationError('invalid_host_binding')
    paths = [f['path'] for f in request['frames']] if 'frames' in request else [request['sourcePath']]
    if 'fixedOverlayPath' in request:
        paths.append(request['fixedOverlayPath'])
    expected = expected_reference_hashes
    if expected is not None and (not isinstance(expected, dict) or set(expected) != set(paths) or
                                 any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value) for value in expected.values())):
        raise OperationError('invalid_host_context')
    frozen_identity = {} if expected is None else {'expectedReferenceHashes': expected}
    # Explicit export host policy participates in the immutable operation identity.
    # Child operations of older image/GIF workers already retain their own parent identity.
    if expected_parent_identity is not None and expected_reference_hashes is not None:
        frozen_identity['expectedOutputParentIdentity'] = expected_parent_identity
    fingerprint = hashlib.sha256(json.dumps({'request': request, 'workspace': str(base_dir), 'binding': binding,
                                              **frozen_identity}, sort_keys=True).encode()).hexdigest()
    root = Path(state_dir).absolute()
    if root.is_symlink():
        raise OperationError('invalid_state_directory')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = root / operation_id
    if directory.is_symlink():
        raise OperationError('invalid_operation_directory')
    directory.mkdir(exist_ok=True, mode=0o700)
    record_path = directory / 'operation.json'

    def notify(phase):
        if hook:
            hook(phase)

    def cancelled():
        return bool(cancel_check and cancel_check())

    with (directory / '.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise OperationError('operation_in_progress') from error
        if record_path.exists():
            record = json.loads(record_path.read_text())
            if record.get('fingerprint') != fingerprint:
                raise OperationError('operation_id_conflict')
            if record['status'] == 'completed':
                verify_artifact(record['artifact'])
                cleanup_publication(record)
                return result_for(record)
            if record['status'] in ('failed', 'cancelled') and not (
                    record['stage'] == 'committed' and publication_complete(record)):
                return result_for(record)
        else:
            record = {'schemaVersion': 1, 'operationId': operation_id, 'tool': 'media_export', 'status': 'running',
                      'stage': 'created', 'fingerprint': fingerprint, 'request': request, 'binding': binding,
                      'runtime': executor_runtime(video=request['action'] == 'video_to_gif'),
                      'createdAt': time.time(), 'generation': {'status': 'not_applicable', 'remoteCalls': 0},
                      'visualReview': {'status': 'not_checked'}}
            atomic_json(record_path, record)
        try:
            # A link already made by this operation wins over a late cancellation.
            if record['stage'] in ('publishing', 'committed') and publication_complete(record):
                record.update(status='completed', stage='committed', finishedAt=time.time())
                record.pop('error', None)
                atomic_json(record_path, record)
                cleanup_publication(record)
                return result_for(record)
            if cancelled():
                raise OperationError('media_cancelled')
            if record['stage'] == 'created':
                if Path(request['outputPath']).exists() or Path(request['outputPath']).is_symlink():
                    raise OperationError('media_target_exists')
                snapshots = directory / 'inputs'
                snapshots.mkdir(exist_ok=True)
                # This stage has never dispatched remote work and can safely recapture.
                for old in snapshots.iterdir():
                    if old.is_file() and not old.is_symlink():
                        old.unlink()
                    else:
                        raise OperationError('invalid_snapshot_directory')
                spec = dict(request)
                inputs = []
                for i, path in enumerate(paths):
                    snap = snapshots / f'{i:03d}{Path(path).suffix.lower()}'
                    item = freeze(path, snap)
                    if expected is not None and item['sha256'] != expected[path]:
                        raise OperationError('input_reference_changed')
                    inputs.append(item)
                    if sum(v['bytes'] for v in inputs) > MAX_TOTAL_BYTES:
                        raise OperationError('inputs_too_large')
                if 'frames' in request:
                    spec['frames'] = [{**frame, 'path': source['snapshotPath']} for frame, source in zip(request['frames'], inputs)]
                else:
                    spec['sourcePath'] = inputs[0]['snapshotPath']
                    if 'fixedOverlayPath' in request:
                        spec['fixedOverlayPath'] = inputs[1]['snapshotPath']
                target = Path(request['outputPath'])
                if expected_parent_identity is None:
                    target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    parent = target.parent.resolve(strict=True)
                    if expected_parent_identity is not None and parent != target.parent:
                        raise OperationError('target_parent_changed')
                except FileNotFoundError as error:
                    raise OperationError('target_parent_changed') from error
                target = parent / target.name
                parent_identity = identity(parent)
                if expected_parent_identity is not None and parent_identity != expected_parent_identity:
                    raise OperationError('target_parent_changed')
                record.update(stage='prepared', inputs=inputs, frozenSpec=spec, outputPath=str(target),
                              parentIdentity=parent_identity, parentPath=str(parent))
                atomic_json(record_path, record)
                notify('after_prepare')
            validate_snapshot(record)
            if record['stage'] == 'prepared':
                current_runtime = executor_runtime(video=request['action'] == 'video_to_gif')
                runtime_keys = ('pillow', 'executorRevision') + (('videoTools',) if request['action'] == 'video_to_gif' else ())
                if any(record.get('runtime', {}).get(key) != current_runtime[key]
                       for key in runtime_keys):
                    raise OperationError('media_runtime_changed',
                                         {'recorded': record.get('runtime'), 'current': current_runtime})
                stage = directory / ('rendered.' + request['outputFormat'])
                if stage.exists():
                    stage.unlink()  # Uncommitted partial local render, not provider output.
                spec = {k: v for k, v in record['frozenSpec'].items() if k not in ('outputPath', 'expectedTarget')}
                metadata = render_export(spec, stage, cancel_check=cancel_check)
                with stage.open('rb') as handle:
                    os.fsync(handle.fileno())
                metadata['sha256'] = sha(stage)
                metadata['bytes'] = stage.stat().st_size
                record.update(stage='rendered', renderedPath=str(stage), artifact={**metadata, 'path': record['outputPath']},
                              fileValidation={'status': 'passed', 'checks': ['full_decode', 'format', 'dimensions', 'sha256']},
                              animationValidation={'status': 'passed' if metadata.get('frames', 1) > 1 else 'not_applicable',
                                                   'scope': 'decoded_structure_and_timing_not_visual_motion'})
                atomic_json(record_path, record)
                notify('after_render')
            target = Path(record['outputPath'])
            parent = Path(record['parentPath'])
            if identity(parent) != record['parentIdentity'] or Path(request['outputPath']).parent.resolve() != parent:
                raise OperationError('target_parent_changed')
            verify_artifact({**record['artifact'], 'path': record['renderedPath']})
            if cancelled():
                raise OperationError('media_cancelled')
            if record['stage'] == 'rendered':
                fd, temporary = tempfile.mkstemp(prefix='.opennova-media-', dir=parent)
                with os.fdopen(fd, 'wb') as dst, Path(record['renderedPath']).open('rb') as src:
                    shutil.copyfileobj(src, dst)
                    dst.flush()
                    os.fsync(dst.fileno())
                if sha(temporary) != record['artifact']['sha256']:
                    raise OperationError('publication_copy_changed')
                record.update(stage='publishing', publicationPath=temporary, publicationIdentity=identity(temporary))
                atomic_json(record_path, record)
            temporary = Path(record['publicationPath'])
            if temporary.is_symlink() or identity(temporary) != record['publicationIdentity'] or sha(temporary) != record['artifact']['sha256']:
                raise OperationError('publication_copy_changed')
            notify('before_publish')
            if cancelled():
                raise OperationError('media_cancelled')
            if identity(parent) != record['parentIdentity'] or Path(request['outputPath']).parent.resolve() != parent:
                raise OperationError('target_parent_changed')
            # Recheck after the callback/cancellation boundary. In particular, a
            # replacement with identical bytes must not acquire this operation's
            # identity or allow us to claim another writer's existing target.
            if temporary.is_symlink() or identity(temporary) != record['publicationIdentity'] or sha(temporary) != record['artifact']['sha256']:
                raise OperationError('publication_copy_changed')
            if expected_parent_identity is not None:
                # A rename cannot redirect the final link to a different directory.
                fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    info = os.fstat(fd)
                    if [info.st_dev, info.st_ino] != record['parentIdentity']:
                        raise OperationError('target_parent_changed')
                    owner = os.stat(temporary.name, dir_fd=fd, follow_symlinks=False)
                    if not stat.S_ISREG(owner.st_mode) or [owner.st_dev, owner.st_ino] != record['publicationIdentity']:
                        raise OperationError('publication_copy_changed')
                    os.link(temporary.name, target.name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                    os.fsync(fd)
                except FileExistsError as error:
                    raise OperationError('media_target_exists') from error
                finally:
                    os.close(fd)
            else:
                try:
                    os.link(temporary, target)
                except FileExistsError as error:
                    raise OperationError('media_target_exists') from error
                fsync_directory(parent)
            notify('after_publish')
            # The source pathname can also be replaced between its check and
            # link(). Verify the published inode and bytes before claiming it.
            # Never remove an unexpected target: another writer may own it.
            if not publication_complete(record):
                raise OperationError('publication_copy_changed')
            record.update(status='completed', stage='committed', finishedAt=time.time())
            atomic_json(record_path, record)
            cleanup_publication(record)
            return result_for(record)
        except (ContractError, MediaExportError, OSError, ValueError) as error:
            # A successful publish must never become a failed operation due to bookkeeping.
            published = record.get('stage') in ('publishing', 'committed') and publication_complete(record)
            if published:
                record.update(status='completed', stage='committed', finishedAt=time.time())
                record.pop('error', None)
            else:
                code = getattr(error, 'code', 'media_io_error')
                record.update(status='cancelled' if code in ('media_cancelled', 'cancelled') else 'failed',
                              error={'code': code, 'details': getattr(error, 'details', {})}, finishedAt=time.time())
            try:
                atomic_json(record_path, record)
            except OSError:
                if not published:
                    raise
                # The durable publishing intent plus the target inode/hash is
                # sufficient to recover without rendering again. Keep its link
                # and report the saved file, even while bookkeeping is unavailable.
                return {**result_for(record), 'bookkeepingPending': True}
            cleanup_publication(record)
            return result_for(record)


def publication_complete(record):
    try:
        target = Path(record['outputPath'])
        if target.is_symlink() or identity(target) != record['publicationIdentity']:
            return False
        verify_artifact(record['artifact'])
        return True
    except (KeyError, OSError, ContractError):
        return False


def cleanup_publication(record):
    try:
        path = Path(record.get('publicationPath', ''))
        if path.is_file() and not path.is_symlink() and identity(path) == record.get('publicationIdentity'):
            path.unlink()
    except OSError:
        pass
