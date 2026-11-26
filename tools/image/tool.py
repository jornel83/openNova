#!/usr/bin/env python3
"""Fixed local entrypoint. Public arguments never include trusted host identity."""
import argparse
import json
import os
from pathlib import Path
import stat
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.image.schema import ContractError, normalize


def invoke(name, arguments, *, base_dir=None, state_dir, operation_id, binding=None, cancel_check=None,
           hook=None, expected_reference_hashes=None, recover_only=False, expected_output_parent_identity=None):
    base_dir = Path(base_dir or Path.cwd())
    normalize(name, arguments, base_dir)
    if expected_output_parent_identity is not None and (name != 'media_export' or
            not isinstance(expected_output_parent_identity, list) or len(expected_output_parent_identity) != 2 or
            any(type(item) is not int or item < 0 for item in expected_output_parent_identity)):
        raise ContractError('invalid_host_context')
    if name == 'image_generate':
        from tools.image.generation import run_image
        return run_image(arguments, base_dir=base_dir, state_dir=state_dir, operation_id=operation_id,
                         binding=binding, cancel_check=cancel_check, hook=hook,
                         expected_reference_hashes=expected_reference_hashes, recover_only=recover_only)
    if name == 'gif_generate':
        from tools.image.gif_generation import run_gif
        return run_gif(arguments, base_dir=base_dir, state_dir=state_dir, operation_id=operation_id,
                       binding=binding, cancel_check=cancel_check, hook=hook,
                       expected_reference_hashes=expected_reference_hashes, recover_only=recover_only)
    if recover_only:
        raise ContractError('invalid_host_context')
    from tools.image.operations import run_export
    return run_export(arguments, base_dir=base_dir, state_dir=state_dir, operation_id=operation_id,
                      binding=binding, cancel_check=cancel_check, hook=hook,
                      expected_reference_hashes=expected_reference_hashes,
                      expected_parent_identity=expected_output_parent_identity)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True, help='JSON envelope path, or - for stdin')
    parser.add_argument('--recover-only', action='store_true', help='follow a saved operation without submitting generation')
    options = parser.parse_args()
    try:
        if options.request == '-':
            raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        else:
            fd = os.open(options.request, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0))
            with os.fdopen(fd, 'rb') as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ContractError('request_file_must_be_regular')
                raw = stream.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ContractError('request_too_large')
        request = json.loads(raw)
        if not isinstance(request, dict) or set(request) != {'tool', 'arguments', 'context'}:
            raise ContractError('invalid_request_envelope')
        context = request['context']
        if not isinstance(context, dict) or set(context) - {'operationId', 'workspace', 'stateDir', 'binding', 'expectedReferenceHashes', 'expectedOutputParentIdentity'} or not {'operationId', 'workspace', 'stateDir'} <= set(context):
            raise ContractError('invalid_host_context')
        result = invoke(request['tool'], request['arguments'], base_dir=context['workspace'], state_dir=context['stateDir'],
                        operation_id=context['operationId'], binding=context.get('binding'),
                        expected_reference_hashes=context.get('expectedReferenceHashes'), recover_only=options.recover_only,
                        expected_output_parent_identity=context.get('expectedOutputParentIdentity'))
        print(json.dumps({'ok': result['status'] == 'completed', 'result': result}, ensure_ascii=False))
        return 0 if result['status'] == 'completed' else 1
    except (ContractError, OSError, ValueError, TypeError) as error:
        print(json.dumps({'ok': False, 'error': {'code': getattr(error, 'code', 'invalid_media_request'),
                                              'details': getattr(error, 'details', {})}}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
