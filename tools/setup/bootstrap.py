#!/usr/bin/env python3
"""Prepare/check the macOS helper; SDK sources and builds belong to OpenNova."""
import argparse
import hashlib
import tempfile
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def run(args, cwd=None, capture=False):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, check=True,
                          text=True, stdout=subprocess.PIPE if capture else None).stdout


def helper_record(helper):
    return {'schemaVersion': 1,
            'sourceSha256': hashlib.sha256((ROOT / 'services/agent/keychain.swift').read_bytes()).hexdigest(),
            'binarySha256': hashlib.sha256(helper.read_bytes()).hexdigest()}


def ensure_helper(path, *, install):
    helper = Path(path)
    record = helper.with_suffix('.build.json')
    try:
        saved = json.loads(record.read_text())
        current = helper_record(helper)
        if all(saved.get(key) == value for key, value in current.items()) and os.access(helper, os.X_OK):
            return
    except (OSError, ValueError):
        pass
    if not install:
        raise RuntimeError('Keychain helper missing or helper stale; run pnpm run build')
    helper.parent.mkdir(parents=True, exist_ok=True)
    # Build without accessing Keychain. Keep the last working binary on failure.
    with tempfile.TemporaryDirectory(prefix='.keychain-', dir=helper.parent) as directory:
        staged = Path(directory) / helper.name
        run(['swiftc', ROOT / 'services/agent/keychain.swift', '-o', staged])
        staged.chmod(0o700)
        metadata = helper_record(staged)
        metadata['origin'] = 'compiled-from-source'
        staged.replace(helper)
        temporary_record = Path(directory) / 'record.json'
        temporary_record.write_text(json.dumps(metadata, indent=2) + '\n')
        temporary_record.replace(record)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true', help='Check local builds/helper; no login or credentials')
    mode.add_argument('--install', action='store_true', help='Build the repository Keychain helper when missing or stale')
    parser.add_argument('--web', action='store_true', help='Compatibility flag: tool streaming is now included in the SDK')
    args = parser.parse_args()
    try:
        if platform.system() != 'Darwin':
            raise RuntimeError('This helper uses macOS Keychain')
        for executable in ('node', 'swiftc'):
            if not shutil.which(executable):
                raise RuntimeError(f'Missing {executable}; see README installation prerequisites')
        if int(run(['node', '--version'], capture=True).strip().lstrip('v').split('.')[0]) != 24:
            raise RuntimeError('OpenNova requires Node 24')
        settings = json.loads(run(['node', '--input-type=module', '-e',
            "import {loadSettings} from './services/agent/settings.mjs'; console.log(JSON.stringify(loadSettings()));"], cwd=ROOT, capture=True))
        run(['node', '--input-type=module', '-e',
            "import {checkEngineSources} from './services/runtime/sources.mjs'; checkEngineSources();"], cwd=ROOT)
        ensure_helper(settings['keychainPath'], install=args.install)
        if args.check:
            run(['node', '--input-type=module', '-e',
                "import {requireBuiltHarness} from './services/runtime/sources.mjs'; "
                "import {siwcModule} from './services/agent/siwc.mjs'; "
                "import {pathToFileURL} from 'node:url'; requireBuiltHarness(); await import(pathToFileURL(siwcModule()));"], cwd=ROOT)
        print('Keychain helper ready; existing authorization storage unchanged.')
        print('Build bundled SDK with pnpm run build; authorize separately when needed.')
        return 0
    except (RuntimeError, OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f'Environment setup failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
