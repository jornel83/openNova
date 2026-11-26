"""Host-only, resumable delivery of a GIF, its actual first frame and a manifest.

This is deliberately a sequence of two no-overwrite publications, not an atomic
multi-file transaction. A partial delivery is retained and accounted for. Stable
child operations reuse saved bytes; terminal cancellation/failure never starts a
new child. Losing the parent ledger requires intervention, never a fresh request.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

from PIL import Image

from tools.image.operations import (
    OperationError, atomic_json, executor_runtime, fsync_directory, run_export,
    sha, verify_artifact,
)
from tools.image.schema import ContractError, absolute_path, normalize


def _read_json(path):
    try:
        if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
            raise OperationError('bundle_state_corrupt')
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise OperationError('bundle_state_corrupt')
        return value
    except (OSError, ValueError, TypeError):
        raise OperationError('bundle_state_corrupt') from None


def _exclusive_json(path, value):
    """An immutable intent/terminal marker remains evidence even after a crash."""
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    fsync_directory(path.parent)


def _runtime():
    return {**executor_runtime(), 'bundleRevision': sha(Path(__file__))}


def _save(path, record):
    try:
        atomic_json(path, record)
        return True
    except OSError:
        return False


def _result(record, manifest_path, *, pending=False):
    keys = ('schemaVersion', 'operationId', 'tool', 'status', 'stage', 'binding', 'artifacts',
            'childOperations', 'generation', 'visualReview', 'firstFrameValidation',
            'terminalStatus', 'error', 'runtime', 'publication')
    result = {key: record[key] for key in keys if key in record}
    if manifest_path.is_file() and not manifest_path.is_symlink():
        result['manifest'] = {'path': str(manifest_path), 'bytes': manifest_path.stat().st_size,
                              'sha256': sha(manifest_path)}
    if pending or any(child.get('bookkeepingPending') for child in record.get('childOperations', {}).values()):
        result['bookkeepingPending'] = True
    return result


def _validate_pair(record):
    gif, first = record['artifacts']['gif'], record['artifacts']['firstFrame']
    verify_artifact(gif)
    verify_artifact(first)
    child = record['childOperations']['firstFrame']
    if not child.get('inputs') or child['inputs'][0]['sha256'] != gif['sha256']:
        raise OperationError('bundle_source_changed')
    try:
        with Image.open(gif['path']) as animation, Image.open(first['path']) as frame:
            animation.seek(0)
            first_pixels = animation.convert('RGBA')
            delivered_pixels = frame.convert('RGBA')
            if first_pixels.size != delivered_pixels.size or first_pixels.tobytes() != delivered_pixels.tobytes():
                raise OperationError('bundle_first_frame_mismatch')
            pixel_digest = hashlib.sha256(first_pixels.tobytes()).hexdigest()
    except ContractError:
        raise
    except (OSError, ValueError):
        raise OperationError('bundle_first_frame_invalid') from None
    # Verify again after decoding; externally changed committed outputs are never
    # accepted as the source of an apparently reconciled delivery.
    verify_artifact(gif)
    verify_artifact(first)
    record['firstFrameValidation'] = {
        'status': 'passed', 'scope': 'exact_decoded_rgba', 'sourceGifSha256': gif['sha256'],
        'firstFrameSha256': first['sha256'], 'decodedPixelSha256': pixel_digest,
    }


def _terminal(record, manifest_path, terminal_path, status, code, details=None):
    record.update(status='partial' if record['artifacts'] else status, terminalStatus=status,
                  stage='stopped', error={'code': code, 'details': details or {}}, finishedAt=time.time())
    # This independent immutable marker keeps a failed manifest update from
    # turning observed cancellation into permission to dispatch another child.
    if terminal_path.exists() or terminal_path.is_symlink():
        previous = _read_json(terminal_path)
        if previous.get('fingerprint') != record['fingerprint']:
            raise OperationError('bundle_state_corrupt')
        record = previous
    else:
        try:
            _exclusive_json(terminal_path, record)
        except OSError:
            if not _save(manifest_path, record):
                raise OperationError('bundle_terminal_record_failed') from None
    saved = _save(manifest_path, record)
    return _result(record, manifest_path, pending=not saved)


def run_gif_bundle(arguments, first_frame_path, *, base_dir, state_dir, operation_id,
                   binding=None, cancel_check=None, hook=None, expected_parent_identity=None):
    """Export a GIF, extract its real first frame and return an auditable bundle.

    The manifest lives at ``state_dir/.gif-bundles/<id>/manifest.json``. The
    returned ``manifest`` includes its actual hash and byte count. ``partial``
    with no ``terminalStatus`` can resume; ``partial`` plus failed/cancelled is
    terminal. A completed result can carry ``bookkeepingPending`` when saved
    artifacts await durable ledger reconciliation, without re-encoding them.
    """
    if not isinstance(operation_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', operation_id):
        raise OperationError('invalid_operation_id')
    base_dir = Path(base_dir).resolve(strict=True)
    request = normalize('media_export', arguments, base_dir)
    if request['outputFormat'] != 'gif':
        raise OperationError('bundle_gif_output_required')
    if not isinstance(first_frame_path, (str, Path)) or not str(first_frame_path) or '\0' in str(first_frame_path):
        raise OperationError('bundle_first_frame_path_invalid')
    first_frame_path = absolute_path(str(first_frame_path), base_dir)
    first_request = normalize('media_export', {
        'action': 'first_frame', 'sourcePath': request['outputPath'], 'outputPath': first_frame_path,
    }, base_dir)
    binding = dict(binding or {})
    if set(binding) - {'projectId', 'requestId', 'taskId', 'runId'} or any(not isinstance(value, str) or len(value) > 200 for value in binding.values()):
        raise OperationError('invalid_host_binding')
    frozen = {'request': request, 'firstFrameRequest': first_request, 'workspace': str(base_dir), 'binding': binding}
    if expected_parent_identity is not None:
        frozen['expectedParentIdentity'] = expected_parent_identity
    fingerprint = hashlib.sha256(json.dumps(frozen, sort_keys=True).encode()).hexdigest()
    root = Path(state_dir).absolute()
    # A leading dot cannot be a public media operation ID, so this namespace
    # cannot collide with run_export's state_dir/<operation_id> directories.
    for path in (root, root / '.gif-bundles'):
        if path.is_symlink():
            raise OperationError('invalid_state_directory')
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = root / '.gif-bundles' / operation_id
    if directory.is_symlink():
        raise OperationError('invalid_operation_directory')
    created = False
    try:
        directory.mkdir(mode=0o700)
        created = True
    except FileExistsError:
        if not directory.is_dir():
            raise OperationError('invalid_operation_directory') from None
    manifest_path, intent_path = directory / 'manifest.json', directory / 'intent.json'
    terminal_path, child_state = directory / 'terminal.json', directory / 'children'
    for target in (Path(request['outputPath']), Path(first_frame_path)):
        # Artifacts must not overwrite this operation's bookkeeping or children.
        if target.resolve(strict=False).is_relative_to(directory.resolve()):
            raise OperationError('bundle_output_in_state_directory')

    def notify(phase):
        if hook:
            hook(phase)

    def cancelled():
        return bool(cancel_check and cancel_check())

    def invoke_child(kind, child_request):
        child_id = 'gif' if kind == 'gif' else 'first-frame'
        child_directory = child_state / child_id
        if child_directory.exists() and not (child_directory / 'operation.json').is_file():
            raise OperationError('bundle_child_record_missing')
        receipt = run_export(child_request, base_dir=base_dir, state_dir=child_state,
                             operation_id=child_id, binding=binding, cancel_check=cancel_check,
                             hook=lambda phase: notify(f'{kind}:{phase}'),
                             expected_parent_identity=expected_parent_identity)
        record['childOperations'][kind] = {**receipt, 'stateDirectory': str(child_state)}
        if receipt['status'] == 'completed':
            verify_artifact(receipt['artifact'])
            record['artifacts'][kind] = receipt['artifact']
            record['status'] = 'partial'
        return receipt

    def reconcile_child(kind, child_request):
        child = record['childOperations'].get(kind, {})
        if not child.get('bookkeepingPending'):
            return False
        child_id = 'gif' if kind == 'gif' else 'first-frame'
        child_path = child_state / child_id / 'operation.json'
        if not child_path.is_file():
            raise OperationError('bundle_child_record_missing')
        saved_child = _read_json(child_path)
        if saved_child.get('status') != 'completed' and saved_child.get('stage') != 'publishing':
            raise OperationError('bundle_child_state_invalid')
        if saved_child.get('artifact', {}).get('sha256') != record['artifacts'][kind]['sha256']:
            raise OperationError('bundle_child_state_invalid')
        previous_status = record['status']
        receipt = invoke_child(kind, child_request)
        record['status'] = previous_status
        if receipt['status'] != 'completed':
            raise OperationError('bundle_child_reconciliation_failed')
        return True

    lock_path = directory / '.lock'
    lock_flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    try:
        lock_fd = os.open(lock_path, lock_flags, 0o600)
    except OSError:
        raise OperationError('invalid_operation_directory') from None
    with os.fdopen(lock_fd, 'a+b') as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise OperationError('invalid_operation_directory')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise OperationError('operation_in_progress') from None
        if created:
            record = {
                'schemaVersion': 1, 'operationId': operation_id, 'tool': 'gif_bundle',
                'status': 'running', 'stage': 'created', 'fingerprint': fingerprint,
                **frozen, 'createdAt': time.time(), 'runtime': _runtime(),
                'artifacts': {}, 'childOperations': {},
                'generation': {'status': 'not_applicable', 'remoteCalls': 0},
                'visualReview': {'status': 'not_checked'},
                'publication': {'atomicAcrossFiles': False, 'overwrite': False},
            }
            try:
                _exclusive_json(intent_path, {'schemaVersion': 1, 'fingerprint': fingerprint, **frozen})
                atomic_json(manifest_path, record)
            except OSError:
                raise OperationError('bundle_initial_record_failed') from None
        else:
            if not intent_path.exists() or not manifest_path.exists():
                raise OperationError('bundle_manifest_missing')
            intent, record = _read_json(intent_path), _read_json(manifest_path)
            if intent.get('fingerprint') != fingerprint or record.get('fingerprint') != fingerprint:
                raise OperationError('operation_id_conflict')
            if record.get('operationId') != operation_id or not isinstance(record.get('artifacts'), dict):
                raise OperationError('bundle_state_corrupt')
        if terminal_path.exists() or terminal_path.is_symlink():
            terminal = _read_json(terminal_path)
            if terminal.get('fingerprint') != fingerprint:
                raise OperationError('bundle_state_corrupt')
            if record.get('terminalStatus') != terminal.get('terminalStatus'):
                record = terminal
            # The immutable stop marker prohibits new steps, but a saved child
            # may still need its own completed ledger reconciled after I/O heals.
            for kind, child_request in (('gif', request), ('firstFrame', first_request)):
                if kind in record['artifacts']:
                    reconcile_child(kind, child_request)
            return _result(record, manifest_path, pending=not _save(manifest_path, record))
        if record.get('terminalStatus') in ('failed', 'cancelled') or record['status'] in ('failed', 'cancelled'):
            return _result(record, manifest_path)
        if record['status'] == 'completed':
            _validate_pair(record)
            changed = reconcile_child('gif', request)
            changed = reconcile_child('firstFrame', first_request) or changed
            return _result(record, manifest_path, pending=changed and not _save(manifest_path, record))

        try:
            notify('after_create')
            # A completed child takes priority over a late cancellation. Always
            # recover children with durable records before deciding what is left.
            for kind, child_request in (('gif', request), ('firstFrame', first_request)):
                child_id = 'gif' if kind == 'gif' else 'first-frame'
                child_record = child_state / child_id / 'operation.json'
                if kind == 'firstFrame' and 'gif' not in record['artifacts']:
                    break
                if kind in record['artifacts']:
                    verify_artifact(record['artifacts'][kind])
                    if reconcile_child(kind, child_request) and not _save(manifest_path, record):
                        return _result(record, manifest_path, pending=True)
                    continue
                if not child_record.exists() and cancelled():
                    return _terminal(record, manifest_path, terminal_path, 'cancelled', 'media_cancelled')
                record['stage'] = 'gif_pending' if kind == 'gif' else 'first_frame_pending'
                if not _save(manifest_path, record):
                    return _result(record, manifest_path, pending=True)
                notify('before_gif' if kind == 'gif' else 'before_first_frame')
                receipt = invoke_child(kind, child_request)
                if receipt['status'] != 'completed':
                    error = receipt.get('error', {'code': 'bundle_child_failed'})
                    return _terminal(record, manifest_path, terminal_path,
                                     'cancelled' if receipt['status'] == 'cancelled' else 'failed',
                                     error['code'], error.get('details'))
                record['stage'] = 'gif_committed' if kind == 'gif' else 'first_frame_committed'
                notify('after_gif' if kind == 'gif' else 'after_first_frame')
                if not _save(manifest_path, record):
                    if len(record['artifacts']) == 2:
                        break
                    return _result(record, manifest_path, pending=True)
                notify('after_gif_manifest' if kind == 'gif' else 'after_first_frame_manifest')
            if len(record['artifacts']) != 2:
                raise OperationError('bundle_incomplete')
            _validate_pair(record)
            record.update(status='completed', stage='committed', finishedAt=time.time())
            saved = _save(manifest_path, record)
            notify('after_complete')
            return _result(record, manifest_path, pending=not saved)
        except (ContractError, OSError, ValueError) as error:
            # Both files already saved remain a complete delivery even if a host
            # notification or the final manifest update failed afterwards.
            if len(record['artifacts']) == 2:
                try:
                    _validate_pair(record)
                    record.update(status='completed', stage='committed', finishedAt=time.time())
                    return _result(record, manifest_path, pending=not _save(manifest_path, record))
                except (ContractError, OSError, ValueError):
                    pass
            return _terminal(record, manifest_path, terminal_path, 'failed',
                             getattr(error, 'code', 'bundle_io_error'), getattr(error, 'details', {}))


__all__ = ['run_gif_bundle']
