#!/usr/bin/env python3
"""Prepare pinned macOS Agent dependencies without replacing existing checkouts."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
HARNESS_FILES = ['packages/sdk/client/lib/index.js', 'packages/llm/llm/lib/index.js',
                 'apps/cli/lib/bin.js']


def run(args, cwd=None, capture=False):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, check=True,
                          text=True, stdout=subprocess.PIPE if capture else None).stdout


def ensure_repo(path, spec, *, install):
    path = Path(path)
    if not path.exists():
        if not install:
            raise RuntimeError(f'Missing repository: {path}; run --install')
        path.parent.mkdir(parents=True, exist_ok=True)
        run(['git', 'init', '-q', path])
        run(['git', '-C', path, 'remote', 'add', 'origin', spec['url']])
        run(['git', '-C', path, 'fetch', '--depth=1', 'origin', spec['revision']])
        run(['git', '-C', path, 'checkout', '--detach', spec['revision']])
    actual_root = Path(run(['git', '-C', path, 'rev-parse', '--show-toplevel'], capture=True).strip())
    if actual_root.resolve() != path.resolve():
        raise RuntimeError(f'Not an initialized repository: {path}; checkout preserved')
    revision = run(['git', '-C', path, 'rev-parse', 'HEAD'], capture=True).strip()
    if revision != spec['revision']:
        raise RuntimeError(f'Unexpected revision in {path}; preserve it and configure another install path')
    if run(['git', '-C', path, 'status', '--porcelain'], capture=True).strip():
        raise RuntimeError(f'Found uncommitted changes in {path}; checkout preserved')


def ensure_harness(path, spec, *, install, root=ROOT):
    path = Path(path)
    if path.resolve() != (root / spec['path']).resolve():
        return ensure_repo(path, spec, install=install)
    if not (path / '.git').exists():
        if path.exists() and any(path.iterdir()):
            raise RuntimeError(f'Uninitialized Harness directory is not empty: {path}; preserved')
        if not install:
            raise RuntimeError('Harness submodule is not initialized; run bootstrap.py --install')
        run(['git', '-C', root, 'submodule', 'update', '--init', '--recursive', '--', spec['path']])
    ensure_repo(path, spec, install=False)


def build_harness(path, spec, *, install, root=ROOT):
    path = Path(path)
    receipt = root / 'output/deps/harness-build.json'
    expected = {'root': str(path.resolve()), 'revision': spec['revision'], 'pnpm': spec['pnpm']}
    try:
        current = json.loads(receipt.read_text())
    except (OSError, ValueError):
        current = None
    if current == expected and all((path / file).is_file() for file in HARNESS_FILES):
        return
    if not install:
        raise RuntimeError('Harness build missing or stale; run bootstrap.py --install')
    receipt.unlink(missing_ok=True)
    pnpm = ['npx', '--yes', f"pnpm@{spec['pnpm']}"]
    run([*pnpm, 'install', '--frozen-lockfile'], cwd=path)
    run([*pnpm, 'run', 'build'], cwd=path)
    if not all((path / file).is_file() for file in HARNESS_FILES):
        raise RuntimeError('Harness build did not produce required artifacts')
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps(expected, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true', help='Read-only local dependency checks; no login or microphone')
    mode.add_argument('--install', action='store_true', help='Download/build missing dependencies at pinned versions')
    parser.add_argument('--web', action='store_true', help='Also prepare/check the pinned SIWC tool extension')
    args = parser.parse_args()
    try:
        if platform.system() != 'Darwin':
            raise RuntimeError('This bootstrap targets macOS and its Keychain')
        for executable in ('git', 'node', 'npm', 'npx', 'uv', 'ffmpeg', 'swiftc'):
            if not shutil.which(executable):
                raise RuntimeError(f'Missing {executable}; see README installation prerequisites')
        version = run(['node', '--version'], capture=True).strip().lstrip('v')
        major, minor, *_ = map(int, version.split('.'))
        if not (major == 22 and minor >= 19 or major >= 24):
            raise RuntimeError('Node 22.19+ (22.x) or 24+ required by the pinned Harness')
        source = ("import {loadSettings} from './services/agent/settings.mjs';"
                  "import {harnessDependency} from './services/agent/dependencies.mjs';"
                  "console.log(JSON.stringify({...loadSettings(),harness:harnessDependency()}));")
        settings = json.loads(run(['node', '--input-type=module', '-e', source], cwd=ROOT, capture=True))
        versions = json.loads((ROOT / 'config/runtime-versions.json').read_text())
        harness, siwc = Path(settings['harnessRoot']), Path(settings['siwcRoot'])
        # Validate both before installing/building anything in existing checkouts.
        if siwc.exists():
            ensure_repo(siwc, versions['siwc'], install=False)
        ensure_harness(harness, settings['harness'], install=args.install)
        ensure_repo(siwc, versions['siwc'], install=args.install)
        build_harness(harness, settings['harness'], install=args.install)
        if not (siwc / 'packages/local/dist/index.js').is_file():
            if not args.install:
                raise RuntimeError('SIWC build missing; run --install')
            run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund',
                 '--workspace', '@siwc/local', '--include-workspace-root'], cwd=siwc)
            run(['npm', 'run', 'build', '-w', '@siwc/local'], cwd=siwc)
        helper = Path(settings['keychainPath'])
        if not helper.exists():
            if not args.install:
                raise RuntimeError('Keychain helper missing; run --install')
            helper.parent.mkdir(parents=True, exist_ok=True)
            run(['swiftc', ROOT / 'services/agent/keychain.swift', '-o', helper])
            helper.chmod(0o700)
        if not os.access(helper, os.X_OK):
            raise RuntimeError('Keychain helper is not executable; existing file preserved')
        # Import artifacts, without authorizing or opening private credential storage.
        for module in (harness / HARNESS_FILES[0], siwc / 'packages/local/dist/index.js'):
            run(['node', '--input-type=module', '-e', f'await import({json.dumps(module.as_uri())});'])
        if args.web:
            from build_siwc_overlay import build_overlay
            overlay = build_overlay(siwc, check=not args.install)
            module = overlay / 'packages/local/dist/index.js'
            run(['node', '--input-type=module', '-e', f'await import({json.dumps(module.as_uri())});'])
        print('Agent dependencies ready: pinned Harness + SIWC + existing Keychain helper.')
        print('Next: configure local secrets/TTS; authorize; run conversation.py --check.')
        return 0
    except (RuntimeError, OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f'Environment setup failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
