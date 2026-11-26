#!/usr/bin/env python3
"""Provision a separate Pillow environment keyed by the exact dependency lock."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]


def install(lock, runtime_root):
    if sys.version_info[:2] != (3, 11):
        raise ValueError('image runtime requires Python 3.11')
    raw = lock.read_bytes()
    lines = [line.strip() for line in raw.decode().splitlines() if line.strip() and not line.strip().startswith('#')]
    requirement = re.fullmatch(r'(?i:pillow)==(\d+\.\d+\.\d+)', lines[0]) if len(lines) == 1 else None
    if not requirement:
        raise ValueError('invalid image dependency lock')
    runtime_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = runtime_root / ('py311-' + hashlib.sha256(raw).hexdigest())
    python = path / 'bin/python'
    check = ['-I', '-B', '-c', 'import sys, PIL; from PIL import Image; '
             'sys.exit(sys.version_info[:2] != (3, 11) or PIL.__version__ != sys.argv[1])', requirement[1]]
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not python.is_file() or subprocess.run([python, *check], check=False).returncode:
            raise ValueError('installed image runtime is incompatible; preserve it and restore a matching environment')
        return python

    stage = Path(tempfile.mkdtemp(prefix='.install-image-', dir=runtime_root))
    try:
        uv = shutil.which('uv')
        if uv is None:
            raise ValueError('uv is required for the locked image runtime')
        # Python distributions managed by uv may omit ensurepip. Populate the
        # environment with uv, and never rewrite an existing version in place.
        base_python = Path(getattr(sys, '_base_executable', sys.executable)).resolve(strict=True)
        subprocess.run([uv, '--no-config', 'venv', '--python', base_python, stage], check=True)
        candidate = stage / 'bin/python'
        subprocess.run([uv, '--no-config', 'pip', 'install', '--python', candidate,
                        '--no-deps', '--only-binary', ':all:', 'Pillow==' + requirement[1]], check=True)
        subprocess.run([candidate, *check], check=True)
        try:
            os.rename(stage, path)
        except OSError:
            # Another installer may have published the same immutable version.
            if path.is_symlink() or not python.is_file():
                raise
        subprocess.run([python, *check], check=True)
        return python
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, default=ROOT / 'tools/image/requirements.lock.txt',
                        help='restore a saved skill version using its archived lock')
    options = parser.parse_args()
    try:
        print(install(options.lock, ROOT / 'output/image/runtime'))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f'OpenNova image runtime setup failed: {error}\n')


if __name__ == '__main__':
    main()
