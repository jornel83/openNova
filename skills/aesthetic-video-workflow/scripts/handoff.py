"""Check migrated assets or copy them into a new workspace without network access."""
from pathlib import Path, PureWindowsPath
import argparse
import hashlib
import json
import re
import shutil
import sys


SKILL = Path(__file__).resolve().parents[1]
DATA_PATH = Path('workspaces/aesthetic-video-workflow/data')


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def repository_root(start):
    """An archived skill alone is not an OpenNova checkout."""
    for candidate in (start, *start.parents):
        try:
            package = json.loads((candidate / 'package.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if (isinstance(package, dict) and package.get('name') == 'opennova'
                and (candidate / 'tools/video/tool.py').is_file()):
            return candidate
    return None


def default_workspace():
    # Frozen skill archives retain scripts but not the project's large assets.
    # The running task's cwd therefore takes precedence over the script path.
    repositories = []
    for start in (Path.cwd().resolve(), SKILL):
        root = repository_root(start)
        if root is not None and root not in repositories:
            repositories.append(root)
    for root in repositories:
        if (root / DATA_PATH).is_dir():
            return root / DATA_PATH
    bundled = SKILL / 'assets/workspace'
    if bundled.is_dir():
        return bundled
    return repositories[0] / DATA_PATH if repositories else bundled


def load_manifest():
    return json.loads((SKILL / 'migration_manifest.json').read_text(encoding='utf-8'))


def relative_path(value):
    if (not isinstance(value, str) or not value or '\\' in value or '\0' in value
            or value.startswith('/') or PureWindowsPath(value).drive
            or any(part in ('', '.', '..') for part in value.split('/'))):
        raise ValueError('invalid_relative_path')
    return Path(value)


def manifest_entries(manifest):
    if not isinstance(manifest, dict) or not isinstance(manifest.get('files'), list):
        raise ValueError('invalid_manifest')
    seen = set()
    for row in manifest['files']:
        if not isinstance(row, dict):
            raise ValueError('invalid_manifest')
        name = relative_path(row.get('path'))
        if (name in seen or not isinstance(row.get('bytes'), int)
                or isinstance(row['bytes'], bool) or row['bytes'] < 0
                or not isinstance(row.get('sha256'), str)
                or not re.fullmatch(r'[a-fA-F0-9]{64}', row['sha256'])):
            raise ValueError('invalid_manifest')
        seen.add(name)
    missing = manifest.get('known_missing', [])
    if not isinstance(missing, list):
        raise ValueError('invalid_manifest')
    for row in missing:
        if not isinstance(row, dict):
            raise ValueError('invalid_manifest')
        relative_path(row.get('expected_path'))
    return manifest['files'], missing


def contained_path(root, name):
    path = (root / relative_path(name)).resolve()
    if not path.is_relative_to(root):
        raise ValueError('invalid_relative_path')
    return path


def check(root, manifest=None):
    root = root.expanduser().resolve()
    manifest = load_manifest() if manifest is None else manifest
    rows, known_missing = manifest_entries(manifest)
    failures = []
    for row in rows:
        try:
            path = contained_path(root, row['path'])
            if not path.is_file():
                failures.append({'path': row['path'], 'error': 'missing'})
            elif path.stat().st_size != row['bytes'] or digest(path) != row['sha256'].lower():
                failures.append({'path': row['path'], 'error': 'changed_or_corrupt'})
        except (OSError, ValueError) as error:
            failures.append({'path': row['path'], 'error': str(error)})
    missing = [row for row in known_missing
               if not contained_path(root, row['expected_path']).is_file()]
    return {'workspace': str(root), 'packaged_files': len(rows),
            'integrity_ok': not failures, 'failures': failures,
            'known_missing_inputs': missing,
            'ffmpeg': shutil.which('ffmpeg'), 'ffprobe': shutil.which('ffprobe')}


def materialize(source, destination):
    source = source.expanduser().resolve()
    # Refuse symlink destinations, including ones pointing at an empty directory.
    if destination.expanduser().is_symlink():
        raise ValueError('Destination must not be a symbolic link.')
    destination = destination.expanduser().resolve()
    if destination == source or destination.is_relative_to(source):
        raise ValueError('Destination must be outside the source workspace.')
    if destination == SKILL or destination.is_relative_to(SKILL):
        raise ValueError('Destination must be outside the installed skill.')
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError('Destination must be absent or empty. Existing files will not be overwritten.')
    manifest = load_manifest()
    result = check(source, manifest)
    if not result['integrity_ok']:
        return result, 1
    if not source.is_dir():
        raise ValueError('Source workspace must be a directory.')
    # Unlisted files are copied too; reject links before copytree can follow one
    # outside the source or recurse through a directory cycle.
    if any(path.is_symlink() for path in source.rglob('*')):
        raise ValueError('Source workspace must not contain symbolic links.')
    shutil.copytree(source, destination, dirs_exist_ok=destination.exists())
    (destination / 'migration_manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'workspace': str(destination), 'source': str(source),
            'files_copied': result['packaged_files'],
            'known_missing_inputs': result['known_missing_inputs']}, 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    checker = actions.add_parser('check')
    checker.add_argument('--workspace', type=Path)
    copier = actions.add_parser('materialize')
    copier.add_argument('--source', type=Path,
                        help='Original assets/workspace or another verified data directory.')
    copier.add_argument('--to', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == 'check':
            result = check(args.workspace or default_workspace())
            code = 0 if result['integrity_ok'] else 1
        else:
            result, code = materialize(args.source or default_workspace(), args.to)
    except (OSError, ValueError) as error:
        result, code = {'error': str(error)}, 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    sys.exit(main())
