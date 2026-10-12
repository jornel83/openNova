"""Reproducible SIWC extension built from a fixed Git tree and a tracked patch."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]


def valid_overlay(path, revision, patch_hash):
    try:
        manifest = json.loads((path / 'manifest.json').read_text())
        return (manifest == {'revision': revision, 'patch_sha256': patch_hash}
                and all((path / f'packages/local/dist/{name}.js').is_file()
                        for name in ('index', 'items')))
    except (OSError, ValueError):
        return False


def build_overlay(source_root, patch_path=None, output_root=None, *, check=False):
    patch_path = Path(patch_path or ROOT / 'patches/siwc/0001-stream-items.patch')
    output_root = Path(output_root or ROOT / 'output/deps/siwc')
    revision = json.loads((ROOT / 'config/runtime-versions.json').read_text())['siwc']['revision']
    digest = hashlib.sha256(patch_path.read_bytes()).hexdigest()
    target = output_root / f'{revision[:12]}-{digest[:12]}'
    if not valid_overlay(target, revision, digest):
        if check:
            raise RuntimeError('SIWC tool extension missing; run bootstrap.py --install --web')
        output_root.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix='.building-', dir=output_root))
        try:
            archive = subprocess.check_output(['git', '-C', str(source_root), 'archive', revision])
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(stage, filter='data')
            subprocess.run(['git', 'apply', str(patch_path.resolve())], cwd=stage, check=True)
            subprocess.run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund',
                            '--workspace', '@siwc/local', '--include-workspace-root'], cwd=stage, check=True)
            subprocess.run(['npm', 'run', 'build', '-w', '@siwc/local'], cwd=stage, check=True)
            (stage / 'manifest.json').write_text(json.dumps({'revision': revision, 'patch_sha256': digest})+'\n')
            if not valid_overlay(stage, revision, digest):
                raise RuntimeError('SIWC tool extension build incomplete')
            if target.exists():
                target.rename(target.with_name(target.name+'.invalid-'+uuid.uuid4().hex))
            stage.rename(target)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    if not check:
        pointer = output_root / ('.current-'+uuid.uuid4().hex+'.json')
        pointer.write_text(json.dumps({'path': str(target.resolve())})+'\n')
        pointer.replace(output_root / 'current.json')
    return target
