"""Durable Seedream and Spark image generation with frozen inputs and atomic publication."""
import base64
import binascii
from contextlib import closing
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time
import uuid

from tools.image import export
from tools.image.operations import (
    MAX_INPUT_BYTES, MAX_TOTAL_BYTES, OperationError, atomic_json, executor_runtime,
    freeze, fsync_directory, identity, result_for, run_export, sha,
    validate_snapshot, verify_artifact,
)
from tools.image.providers import ark_provider as ark
from tools.image.providers import spark_provider as spark
from tools.image.schema import ContractError, FORMATS, absolute_path, normalize

ROOT = Path(__file__).resolve().parents[2]
MIN_PIXELS = 921600
MAX_PIXELS = 4624220


def _size(request):
    size = request.get('size')
    if size in ('1K', '1.5K', '2K'):
        return size
    if size:
        if not re.fullmatch(r'\d+x\d+', size):
            raise OperationError('unsupported_seedream_size')
        w, h = map(int, size.split('x'))
    elif 'width' in request:
        w, h = request['width'], request['height']
        if not MIN_PIXELS <= w * h <= MAX_PIXELS:
            # Ask the model to compose at the final aspect ratio even for thumbnails.
            scale = math.sqrt(1024**2 / (w * h))
            w, h = round(w * scale), round(h * scale)
    else:
        return '1K'
    if not MIN_PIXELS <= w * h <= MAX_PIXELS or not 1/16 <= w / h <= 16:
        raise OperationError('unsupported_seedream_size')
    return f'{w}x{h}'


def _request(arguments, workspace):
    req = normalize('image_generate', arguments, workspace)
    suffix = FORMATS.get(Path(req['outputPath']).suffix.lower())
    if suffix not in ('jpeg', 'png', 'webp') or req.get('outputFormat', suffix) != suffix:
        raise OperationError('output_format_mismatch')
    if not req['prompt'].strip():
        raise OperationError('empty_image_prompt')
    req['outputFormat'] = suffix
    req.setdefault('references', [])
    if req['provider'] == 'spark':
        size = req.get('size', spark.SQUARE if req['mode'] == 'create' else None)
        if size == '2K':
            size = spark.SQUARE
        sizes = (spark.SQUARE,) if req['mode'] == 'create' else (None, spark.PORTRAIT, spark.SQUARE)
        if size not in sizes:
            raise OperationError('unsupported_spark_image_size')
        if len(req['references']) != (1 if req['mode'] == 'edit' else 0):
            raise OperationError('invalid_spark_image_reference_count')
        if req.get('watermark'):
            raise OperationError('unsupported_spark_image_watermark')
        if size is not None:
            req['size'] = size
        req['watermark'] = False
    else:
        req['size'] = _size(req)
        req.setdefault('watermark', True)
    return req


def _project_path(path, workspace, state_dir):
    path = Path(path)
    if (not path.is_relative_to(workspace) or path == workspace or
            path.resolve() != path or path.is_relative_to(state_dir)):
        raise OperationError('invalid_project_media_path')
    return path


def _runtime(provider):
    return {**executor_runtime(), 'generationRevision': sha(__file__),
            'providerRevision': spark.revision() if provider == 'spark' else sha(ark.__file__)}


def _expected_hashes(value, references, workspace):
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > len(references):
        raise OperationError('invalid_expected_reference_hashes')
    result = {}
    for name, digest in value.items():
        if (not isinstance(name, str) or not isinstance(digest, str)
                or not re.fullmatch(r'[0-9a-fA-F]{64}', digest)):
            raise OperationError('invalid_expected_reference_hashes')
        path = absolute_path(name, workspace)
        if path not in references or path in result:
            raise OperationError('invalid_expected_reference_hashes')
        result[path] = digest.lower()
    return result


def _freeze_reference(path, workspace, destination):
    # Walk from the trusted project root with no-follow opens. A directory
    # replacement between validation and capture cannot cross into another project.
    directories = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
    fd = os.open(workspace, directories)
    try:
        parts = path.relative_to(workspace).parts
        for part in parts[:-1]:
            child = os.open(part, directories, dir_fd=fd)
            os.close(fd)
            fd = child
        source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        return freeze(path, destination, source_fd=source)
    finally:
        os.close(fd)


def _prepare(record, directory, workspace, state_dir):
    req = record['request']
    target = _project_path(req['outputPath'], workspace, state_dir)
    if target.exists() or target.is_symlink():
        raise OperationError('media_target_exists')
    if not target.parent.is_dir():
        raise OperationError('target_parent_missing')
    inputs = []
    snapshots = directory / 'inputs'
    snapshots.mkdir(mode=0o700, exist_ok=True)
    for i, name in enumerate(req['references']):
        path = _project_path(name, workspace, state_dir)
        ext = path.suffix.lower()
        if FORMATS.get(ext) not in ('png', 'jpeg', 'webp'):
            raise OperationError('unsupported_image_reference_format')
        snap = snapshots / f'{i:03d}{ext}'
        # Only the pre-POST phase may recapture references after interruption.
        if snap.exists() and not snap.is_symlink():
            snap.unlink()
        item = _freeze_reference(path, workspace, snap)
        expected_hash = record.get('expectedReferenceHashes', {}).get(name)
        if expected_hash and item['sha256'] != expected_hash:
            raise OperationError('reference_version_changed', {'index': i})
        if sum(source['bytes'] for source in inputs) + item['bytes'] > MAX_TOTAL_BYTES:
            raise OperationError('inputs_too_large')
        metadata = export.inspect_media(snap)
        w, h = metadata['width'], metadata['height']
        if (metadata['frames'] != 1 or min(w, h) <= 14 or
                w*h > 36_000_000 or not 1/16 <= w/h <= 16):
            raise OperationError('invalid_spark_reference' if req['provider'] == 'spark'
                                 else 'invalid_seedream_reference')
        inputs.append({**item, 'format': metadata['format']})
    record.update(stage='prepared', inputs=inputs, parentIdentity=identity(target.parent))


def _payload(record):
    req = record['request']
    body = {k: req[k] for k in ('model', 'prompt', 'size', 'watermark')}
    body.update(output_format='png', response_format='url', background='opaque')
    refs = []
    validate_snapshot(record)
    for ref in record['inputs']:
        data = Path(ref['snapshotPath']).read_bytes()
        if hashlib.sha256(data).hexdigest() != ref['sha256']:
            raise OperationError('input_snapshot_changed')
        refs.append(f"data:image/{ref['format']};base64," + base64.b64encode(data).decode('ascii'))
    if refs:
        body['image'] = refs[0] if len(refs) == 1 else refs
    return body


def _spark_pending(record, path, *, reason=None):
    record.update(status='pending', stage='awaiting_provider')
    if reason:
        record['error'] = {'code': reason}
    else:
        record.pop('error', None)
    atomic_json(path, record)
    return result_for(record)


def _spark_step(record, path, *, submit, hook=None):
    """Reserve an ID before SSH; recovery can only inspect/download that ID."""
    req, gen = record['request'], record['generation']
    if submit:
        validate_snapshot(record)
        reference = None
        if record['inputs']:
            reference, gen['size'] = spark.prepare_reference(record['inputs'][0]['snapshotPath'], req.get('size'))
        task_id = 'h3-image-' + uuid.uuid4().hex
        record.update(stage='submitting_spark', sparkHost=spark.host(),
                      sparkReferenceSha256=hashlib.sha256(reference).hexdigest() if reference else None)
        gen.update(status='submitted', taskId=task_id, remoteCalls=1)
        atomic_json(path, record)
        if hook:
            hook('after_reserve')
        try:
            state = spark.submit(record['sparkHost'], task_id, req['mode'], req['prompt'], reference)
        except OSError:
            return _spark_pending(record, path, reason='spark_image_submit_unconfirmed')
    else:
        task_id = gen['taskId']
        try:
            state = spark.status(record['sparkHost'], task_id)
        except OSError:
            return _spark_pending(record, path, reason='spark_image_status_unavailable')

    if state.get('id') != task_id:
        raise OperationError('spark_image_receipt_mismatch')
    status = state.get('status')
    if status == 'missing':
        return _record_unknown(record, path)
    if status == 'submitting':
        return _spark_pending(record, path)
    if (state.get('mode') != req['mode'] or
            state.get('promptSha256') != hashlib.sha256(req['prompt'].encode()).hexdigest() or
            state.get('referenceSha256') != record['sparkReferenceSha256']):
        raise OperationError('spark_image_receipt_mismatch')
    gen['status'] = status
    if status in ('queued', 'running'):
        return _spark_pending(record, path)
    if status == 'failed':
        reason = state.get('reason')
        if reason not in ('spark_image_gpu_reserved', 'spark_image_deployment_unavailable',
                          'spark_image_memory_pressure', 'spark_image_worker_interrupted',
                          'spark_image_worker_start_failed'):
            reason = 'spark_image_generation_failed'
        raise OperationError(reason)
    if status != 'succeeded' or not re.fullmatch(r'[0-9a-f]{64}', str(state.get('sha256'))):
        raise OperationError('invalid_spark_image_receipt')

    expected = state.get('bytes')
    if type(expected) is not int or not 0 < expected <= MAX_INPUT_BYTES:
        raise OperationError('invalid_generated_image')
    raw_path = path.parent / 'provider.png'
    staging = path.parent / 'spark-download.tmp'
    try:
        if not raw_path.exists():
            try:
                spark.download(record['sparkHost'], task_id, staging, expected)
            except OSError:
                gen['status'] = 'downloading'
                return _spark_pending(record, path, reason='spark_image_download_pending')
            if staging.stat().st_size != expected or sha(staging) != state['sha256']:
                raise OperationError('spark_image_output_mismatch')
            staging.replace(raw_path)
            fsync_directory(path.parent)
    finally:
        staging.unlink(missing_ok=True)
    if raw_path.is_symlink() or raw_path.stat().st_size != expected or sha(raw_path) != state['sha256']:
        raise OperationError('spark_image_output_mismatch')
    info = export._decode(raw_path.read_bytes(), suffix='.png', pixel_budget=2048 ** 2).metadata
    if info['frames'] != 1 or (info['width'], info['height']) != spark.NATIVE_SIZES[gen['size']]:
        raise OperationError('invalid_generated_image')
    gen.update(status='succeeded', sourceArtifact={**info, 'path': str(raw_path)})
    record.pop('error', None)
    record.update(status='running', stage='receiving')
    atomic_json(path, record)
    if hook:
        hook('after_response')


def _decode(body, client):
    data = body.get('data')
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        raise OperationError('invalid_generated_image')
    if 'url' in data[0]:
        try:
            raw = client.download_image(data[0]['url'], max_bytes=MAX_INPUT_BYTES)
        except ark.ProviderError as error:
            raise OperationError(error.reason, {'category': 'download', 'httpStatus': error.status_code}) from None
    else:
        encoded = data[0].get('b64_json')
        if not isinstance(encoded, str) or len(encoded) > (MAX_INPUT_BYTES + 2) // 3 * 4:
            raise OperationError('invalid_generated_image')
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise OperationError('invalid_generated_image') from None
        if len(raw) > MAX_INPUT_BYTES:
            raise OperationError('invalid_generated_image')
    meta = export._decode(raw, suffix='.png', pixel_budget=MAX_PIXELS).metadata
    if meta['frames'] != 1 or meta['width'] * meta['height'] < MIN_PIXELS:
        raise OperationError('invalid_generated_image')
    return raw, meta


def _record_unknown(record, path):
    record.update(status='unknown', stage='unknown', error={'code': 'generation_completion_unknown'})
    record['generation']['status'] = 'unknown'
    atomic_json(path, record)
    return result_for(record)


def _receive(record, path, credential, client_factory, hook, cancel_check):
    payload = _payload(record)
    if cancel_check and cancel_check():
        raise OperationError('media_cancelled')
    gen = record['generation']
    # Any interrupted replay beyond this durable boundary reuses the result or
    # reports an unknown outcome. It never issues another synchronous paid POST.
    record['stage'] = 'submitting'
    gen.update(status='submitting', remoteCalls=1, credentialScope=credential.scope)
    atomic_json(path, record)
    with closing(client_factory(credential)) as client:
        try:
            if hook:
                hook('after_reserve')
            response = client.create_image(payload)
        except ark.ProviderError as error:
            gen.update(requestId=error.request_id, httpStatus=error.status_code, errorCode=error.error_code,
                       category=error.category, reason=error.reason)
            if error.response_metadata:
                gen['responseMetadata'] = error.response_metadata
            if error.outcome_unknown:
                return _record_unknown(record, path)
            gen['status'] = 'rejected'
            raise OperationError(error.reason, {'category': error.category, 'providerCode': error.error_code})
        except Exception:
            return _record_unknown(record, path)
        gen.update(requestId=ark.request_id({'x-request-id': response.request_id}, credential.secret),
                   httpStatus=response.status_code, status='responded')
        usage = response.body.get('usage')
        gen['usage'] = ({k: v for k, v in usage.items() if k in
                        ('input_tokens','output_tokens','completion_tokens','total_tokens','generated_images')
                        and type(v) is int and v >= 0} if isinstance(usage, dict) else None)
        # Persist what the model acknowledged before fetching its ephemeral URL.
        record['stage'] = 'response_received'
        atomic_json(path, record)
        raw, info = _decode(response.body, client)
    raw_path = path.parent / 'provider.png'
    gen.update(status='succeeded', sourceArtifact={**info, 'path': str(raw_path)})
    record['stage'] = 'receiving'
    atomic_json(path, record)
    with raw_path.open('xb') as out:
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())
    fsync_directory(path.parent)
    if hook:
        hook('after_response')


def run_image(arguments, *, base_dir, state_dir, operation_id, binding=None, cancel_check=None,
              hook=None, client_factory=None, expected_reference_hashes=None, recover_only=False):
    if not isinstance(operation_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', operation_id):
        raise OperationError('invalid_operation_id')
    workspace = Path(base_dir).resolve(strict=True)
    req = _request(arguments, workspace)
    expected = _expected_hashes(expected_reference_hashes, req['references'], workspace)
    binding = binding or {}
    if (not isinstance(binding, dict) or set(binding) - {'projectId','requestId','taskId','runId'} or
            any(not isinstance(v, str) or len(v) > 200 for v in binding.values())):
        raise OperationError('invalid_host_binding')
    fingerprint = hashlib.sha256(json.dumps([req, str(workspace), binding], sort_keys=True).encode()).hexdigest()
    root = Path(state_dir).absolute()
    if root.is_symlink():
        raise OperationError('invalid_state_directory')
    if recover_only:
        if not root.is_dir():
            raise OperationError('image_operation_state_missing')
    else:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = root.resolve(strict=True)
    directory = root / operation_id
    if directory.is_symlink():
        raise OperationError('invalid_operation_directory')
    if recover_only:
        if not directory.is_dir():
            raise OperationError('image_operation_state_missing')
        created = False
    else:
        try:
            directory.mkdir(mode=0o700)
            fsync_directory(root)
            created = True
        except FileExistsError:
            created = False
    path = directory / 'operation.json'
    with (directory / '.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise OperationError('operation_in_progress') from error
        if created:
            record = dict(schemaVersion=1, operationId=operation_id, tool='image_generate', status='running',
                          stage='created', createdAt=time.time(), binding=binding, fingerprint=fingerprint,
                          request=req, expectedReferenceHashes=expected, runtime=_runtime(req['provider']),
                          visualReview={'status':'not_checked'},
                          generation={'provider':req['provider'],'model':req['model'],'mode':req['mode'],
                                      'size':req.get('size'),'status':'not_submitted','remoteCalls':0})
            atomic_json(path, record)
        else:
            if path.is_symlink() or not path.is_file():
                raise OperationError('image_operation_state_missing')
            record = json.loads(path.read_text())
            if (record.get('tool') != 'image_generate' or record.get('fingerprint') != fingerprint
                    or record.get('expectedReferenceHashes', {}) != expected):
                raise OperationError('operation_id_conflict')
            if record['status'] == 'completed':
                target = _project_path(req['outputPath'], workspace, root)
                if identity(target.parent) != record['parentIdentity']:
                    raise OperationError('target_parent_changed')
                verify_artifact(record['artifact'])
                return result_for(record)
            if record['status'] in ('failed','cancelled','unknown'):
                return result_for(record)
            if recover_only and record['stage'] in ('created', 'prepared'):
                raise OperationError('image_recovery_not_submitted')
        try:
            if record['stage'] in ('submitting_spark', 'awaiting_provider'):
                pending = _spark_step(record, path, submit=False, hook=hook)
                if pending:
                    return pending
            if record['stage'] == 'submitting':
                return _record_unknown(record, path)
            if record['stage'] == 'response_received':
                raise OperationError('generated_image_delivery_interrupted')
            if record['stage'] == 'created':
                _prepare(record, directory, workspace, root)
                atomic_json(path, record)
            if record['stage'] == 'prepared':
                if record['runtime'] != _runtime(req['provider']):
                    raise OperationError('media_runtime_changed')
                if cancel_check and cancel_check():
                    raise OperationError('media_cancelled')
                target = _project_path(req['outputPath'], workspace, root)
                if target.exists() or identity(target.parent) != record['parentIdentity']:
                    raise OperationError('target_changed')
                if req['provider'] == 'spark':
                    terminal = _spark_step(record, path, submit=True, hook=hook)
                else:
                    credential = ark.resolve_credential(repo_root=ROOT)
                    if credential is None:
                        raise OperationError('image_credential_missing')
                    terminal = _receive(record, path, credential, client_factory or ark.ArkClient, hook, cancel_check)
                if terminal:
                    return terminal
            if record['stage'] not in ('receiving','delivering'):
                raise OperationError('image_operation_state_invalid')
            source = record['generation']['sourceArtifact']
            verify_artifact(source)
            target = _project_path(req['outputPath'], workspace, root)
            if identity(target.parent) != record['parentIdentity']:
                raise OperationError('target_parent_changed')
            record['stage'] = 'delivering'
            atomic_json(path, record)
            spec = {'action':'convert_image','sourcePath':source['path'],'outputPath':str(target)}
            if 'width' in req:
                spec.update(action='resize', width=req['width'], height=req['height'])
            if req['outputFormat'] == 'jpeg':
                spec['background'] = '#FFFFFF'
            child = run_export(spec, base_dir=workspace, state_dir=directory/'local', operation_id='publish',
                               binding=binding, cancel_check=cancel_check, hook=hook,
                               expected_parent_identity=record['parentIdentity'])
            for name in ('status','artifact','fileValidation','animationValidation','error'):
                if name in child:
                    record[name] = child[name]
            record.update(stage=child['stage'], finishedAt=time.time())
            try:
                atomic_json(path, record)
            except OSError:
                if child['status'] == 'completed':
                    return {**result_for(record), 'bookkeepingPending': True}
                raise
            return result_for(record)
        except (OSError, ContractError, export.MediaExportError, ark.ConfigurationError) as error:
            if record['stage'] == 'submitting' and record['generation']['status'] == 'submitting':
                return _record_unknown(record, path)
            code = getattr(error, 'code', 'image_generation_io_error')
            if isinstance(error, ark.ConfigurationError):
                code = 'image_credential_invalid'
            record.update(status='cancelled' if code == 'media_cancelled' else 'failed',
                          error={'code':code,'details':getattr(error,'details',{})}, finishedAt=time.time())
            atomic_json(path, record)
            return result_for(record)
