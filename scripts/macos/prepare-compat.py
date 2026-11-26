#!/usr/bin/env python3
"""Prepare pinned macOS 15 Homebrew libraries under output; never install globally.

Official bottle archives and individual dylibs are SHA-256 verified against the
checked-in lock. Only copied binaries' install names are normalized. Deployment
targets are inspected, never rewritten. build.py must copy these replacements,
relocate their dependencies inside the application, then sign the final files.
"""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def command(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True, stderr=subprocess.PIPE)


def load_commands(path):
    blocks = []
    for block in re.split(r'Load command \d+', command('/usr/bin/otool', '-l', path)):
        name = re.search(r'\bcmd (LC_\w+)', block)
        if name:
            blocks.append((name.group(1), block))
    return blocks


def minimum_versions(path):
    versions = []
    for name, block in load_commands(path):
        pattern = r'\bminos ([\d.]+)' if name == 'LC_BUILD_VERSION' else r'\bversion ([\d.]+)' if name == 'LC_VERSION_MIN_MACOSX' else None
        if pattern:
            value = re.search(pattern, block)
            if value:
                versions.append(value.group(1))
    return versions


def version_key(value):
    pieces = tuple(int(part) for part in value.split('.'))
    return pieces + (0,) * (3 - len(pieces))


def fetch_bottle(bottle, output):
    name = bottle['formula'].replace('@', '-')
    archive = output / (name + '.arm64_sequoia.bottle.tar.gz')
    url = bottle['url']
    if not url.startswith('https://ghcr.io/v2/homebrew/core/') or not url.endswith('/blobs/sha256:' + bottle['sha256']):
        raise RuntimeError('Unsupported bottle URL in lock: ' + bottle['formula'])
    if not archive.is_file() or sha(archive) != bottle['sha256']:
        repository = url.split('/v2/', 1)[1].split('/blobs/', 1)[0]
        query = urllib.parse.urlencode({'service': 'ghcr.io', 'scope': 'repository:' + repository + ':pull'})
        # This is an anonymous public-registry pull token, not a user credential.
        with urllib.request.urlopen('https://ghcr.io/token?' + query, timeout=30) as response:
            token = json.load(response)['token']
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
        temporary = archive.with_suffix('.download')
        try:
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open('wb') as stream:
                shutil.copyfileobj(response, stream)
            if sha(temporary) != bottle['sha256']:
                raise RuntimeError('Bottle checksum mismatch: ' + bottle['formula'])
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    extracted = output / 'extracted' / name
    required = [entry['bottlePath'] for entry in bottle['libraries']] + bottle['licenses']
    with tarfile.open(archive) as bundle:
        for item in required:
            relative = PurePosixPath(item)
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('Unsafe bottle member in lock')
            member = bundle.getmember(item)
            if not member.isfile():
                raise RuntimeError('Bottle member is not a regular file: ' + item)
            destination = extracted.joinpath(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.unlink(missing_ok=True)
            with bundle.extractfile(member) as stream, destination.open('wb') as target:
                shutil.copyfileobj(stream, target)
            destination.chmod(member.mode & 0o777)
    for entry in bottle['libraries']:
        if sha(extracted / entry['bottlePath']) != entry['sha256']:
            raise RuntimeError('Library checksum mismatch: ' + entry['bottlePath'])
    return bottle, extracted


def normalize_dependency(value, prefix, bottle, lock):
    if value.startswith('@@HOMEBREW_PREFIX@@/'):
        return str(prefix / value.split('/', 1)[1])
    if value.startswith('@@HOMEBREW_CELLAR@@/'):
        parts = value.split('/')
        return str(prefix / 'opt' / parts[1] / Path(*parts[3:]))
    if value.startswith('@rpath/'):
        soname = value.split('/', 1)[1]
        for candidate in lock['bottles']:
            for library in candidate['libraries']:
                if soname == library['soname']:
                    return str(prefix / 'opt' / candidate['formula'] / 'lib' / soname)
    return value


def prepare(args):
    lock = json.loads(args.lock.read_text())
    if lock['schemaVersion'] != 1 or lock['platform'] != 'darwin' or lock['architecture'] != 'arm64' or lock['bottleTag'] != 'arm64_sequoia':
        raise RuntimeError('Unsupported compatibility lock')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    prepared = output / 'prepared'
    prepared.mkdir(exist_ok=True)
    mapping, verified = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        downloaded = list(pool.map(lambda bottle: fetch_bottle(bottle, output), lock['bottles']))
    for bottle, extracted in downloaded:
        for license_path in bottle['licenses']:
            destination = output / 'licenses' / bottle['formula'] / Path(license_path).name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.unlink(missing_ok=True)
            shutil.copy2(extracted / license_path, destination)
        for entry in bottle['libraries']:
            source = (args.prefix / 'Cellar' / bottle['formula'] / bottle['sourceVersion'] / 'lib' / entry['sourceFile']).resolve(strict=True)
            raw = extracted / entry['bottlePath']
            target = prepared / entry['sourceFile']
            target.unlink(missing_ok=True)
            shutil.copy2(raw, target)
            target.chmod(target.stat().st_mode | 0o200)
            architectures = command('/usr/bin/lipo', '-archs', target).strip().split()
            minimum = minimum_versions(target)
            if architectures != ['arm64'] or not minimum or any(version_key(item) > version_key(lock['minimumMacOS']) for item in minimum):
                raise RuntimeError('Incompatible architecture/deployment target: ' + str(raw))
            changes = []
            for name, block in load_commands(target):
                value = re.search(r'\bname (.+) \(offset', block)
                if name == 'LC_ID_DYLIB':
                    command('/usr/bin/install_name_tool', '-id', '@rpath/' + target.name, target)
                elif name in ('LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB') and value:
                    previous = value.group(1)
                    current = normalize_dependency(previous, args.prefix, bottle, lock)
                    if current != previous:
                        if not Path(current).exists():
                            raise RuntimeError('Required Homebrew dependency missing: ' + current)
                        command('/usr/bin/install_name_tool', '-change', previous, current, target)
                        changes.append({'from': previous, 'to': current})
                elif name == 'LC_RPATH':
                    value = re.search(r'\bpath (.+) \(offset', block)
                    if value and '@@HOMEBREW' in value.group(1):
                        command('/usr/bin/install_name_tool', '-rpath', value.group(1), '@loader_path', target)
            mapping[str(source)] = str(target)
            verified.append({'source': str(source), 'sourceSha256': sha(source), 'replacement': str(target),
                             'formula': bottle['formula'], 'version': bottle['version'], 'bottleSha256': bottle['sha256'],
                             'rawSha256': sha(raw), 'preparedSha256': sha(target), 'minOS': minimum,
                             'dependencyNormalization': changes})
    for name, value in [('mapping.json', mapping), ('verification.json', verified)]:
        temporary = output / (name + '.tmp')
        temporary.write_text(json.dumps(value, indent=2) + '\n')
        temporary.replace(output / name)
    print(json.dumps({'mapping': str(output / 'mapping.json'), 'libraries': len(mapping),
                      'minimumMacOS': lock['minimumMacOS'], 'licenses': str(output / 'licenses')}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, default=ROOT / 'packaging/macos/compat-bottles.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'output/macos/compat-libs')
    parser.add_argument('--prefix', type=Path, default=Path('/opt/homebrew'))
    prepare(parser.parse_args())
