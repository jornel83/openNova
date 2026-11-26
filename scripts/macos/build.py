#!/usr/bin/env python3
"""Build an internal arm64 macOS app from the current OpenNova working tree.

The build never reads local configuration or user account data. Build inputs may
include uncommitted source changes. Runtime tools are staged independently of
the developer's Homebrew installation; target machines do not run installers.
"""
import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/macos'
APP = OUT / 'stage/OpenNova.app'
RESOURCES = APP / 'Contents/Resources'
CODE = RESOURCES / 'app'
RUNTIME = RESOURCES / 'runtime'
BIN = RUNTIME / 'bin'
CACHE = OUT / 'cache'
NODE_VERSION = '24.14.1'
NODE_SHA256 = '25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe'
VAD_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'
VAD_REV = '1e261b036686cd0017d500ee96acd1c4ba572a9d'
MACH_MAGIC = {b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf'}


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, **kwargs)


def capture(args, **kwargs):
    return subprocess.check_output([str(x) for x in args], text=True, **kwargs).strip()


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def copy(source, target):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        target.unlink()
    elif target.exists():
        target.chmod(target.stat().st_mode | 0o200)
    shutil.copy2(source, target)
    return target


def fetch(url, target, expected=None):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file() or expected and sha(target) != expected:
        temporary = target.with_suffix('.download')
        run(['/usr/bin/curl', '--fail', '--location', '--retry', '2', '--connect-timeout', '20',
             '--max-time', '300', '--silent', '--show-error', url, '-o', temporary])
        if expected and sha(temporary) != expected:
            raise RuntimeError('Download checksum mismatch: ' + target.name)
        temporary.replace(target)
    return target


def macho(path):
    if not path.is_file() or path.is_symlink():
        return False
    with path.open('rb') as stream:
        return stream.read(4) in MACH_MAGIC


def system_artifact(root):
    """The platform package is a workspace: pnpm staging does not copy its bin/."""
    package = Path(root) / 'engine/harness/native/system/packages/darwin-arm64'
    metadata = package / 'prebuilds.json'
    try:
        manifest = json.loads(metadata.read_text())
    except (OSError, ValueError) as error:
        raise RuntimeError('Missing/invalid macOS system prebuild manifest: ' + str(metadata)) from error
    required = {'tool': 'flock', 'kind': 'node-api', 'napi': 8, 'path': 'bin/system.node'}
    if manifest.get('platform') != 'darwin-arm64' or required not in manifest.get('binaries', []):
        raise RuntimeError('Unsupported macOS system prebuild manifest: ' + str(metadata))
    binary = package / required['path']
    if not binary.is_file() or binary.is_symlink() or not macho(binary):
        raise RuntimeError('Required macOS native lock binary missing/invalid: ' + str(binary)
                           + '; build the Harness darwin-arm64 system prebuild before packaging.')
    return binary


def verify_system_artifact(root):
    binary = system_artifact(root)
    run(['/usr/bin/lipo', binary, '-verify_arch', 'arm64'], stdout=subprocess.DEVNULL)
    run(['/usr/bin/codesign', '--verify', '--strict', binary])
    return binary


def dependencies(path):
    result = capture(['/usr/bin/otool', '-L', path])
    identifiers = set(line.strip() for line in capture(['/usr/bin/otool', '-D', path]).splitlines()
                      if line and not line.endswith(':'))
    return list(dict.fromkeys(line.strip().split(' (compatibility')[0]
                             for line in result.splitlines() if line.startswith('\t')
                             and line.strip().split(' (compatibility')[0] not in identifiers))


def original_dependency(dep, source, identity):
    if dep.startswith(('/System/', '/usr/lib/')):
        return None
    if dep.startswith('/'):
        return Path(dep).resolve()
    if dep.startswith('@loader_path/'):
        return (identity.parent / dep.removeprefix('@loader_path/')).resolve(strict=True)
    if dep.startswith('@rpath/'):
        tail = dep.removeprefix('@rpath/')
        commands = capture(['/usr/bin/otool', '-l', source])
        paths = re.findall(r'cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset', commands)
        for value in [*paths, str(identity.parent)]:
            value = value.replace('@loader_path', str(identity.parent)).replace('@executable_path', str(identity.parent))
            candidate = Path(value) / tail
            if candidate.is_file():
                return candidate.resolve()
            if str(candidate).startswith(('/System/', '/usr/lib/')):
                return None
        raise RuntimeError('Unresolved original dylib: ' + str(identity) + ': ' + dep)
    raise RuntimeError('Unsupported original dylib path: ' + dep)


class Dylibs:
    """Copy Homebrew dynamic dependencies and rewrite only the staged binaries."""
    def __init__(self):
        self.seen = {}
        self.destinations = {}
        self.records = []
        mapping = OUT / 'compat-libs/mapping.json'
        self.compatibility = json.loads(mapping.read_text()) if mapping.exists() else {}

    def collect(self, source, target):
        identity = Path(source).resolve()
        source = Path(self.compatibility.get(str(identity), identity))
        target = Path(target)
        if identity in self.seen:
            return self.seen[identity]
        prior = self.destinations.get(target)
        if prior and prior != identity:
            raise RuntimeError('Conflicting library basename: ' + target.name)
        self.destinations[target] = identity
        self.seen[identity] = target
        if source != target.resolve():
            copy(source, target)
        for dep in dependencies(source):
            original = original_dependency(dep, source, identity)
            if original is None:
                continue
            if original == identity:
                continue
            library = RUNTIME / 'lib' / original.name
            self.collect(original, library)
            relative = os.path.relpath(library, target.parent)
            run(['/usr/bin/install_name_tool', '-change', dep, '@loader_path/' + relative, target],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if target.suffix == '.dylib':
            run(['/usr/bin/install_name_tool', '-id', '@rpath/' + target.name, target],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.records.append({'file': str(target.relative_to(RESOURCES)), 'source': str(identity),
                             'actualBuildSource': str(source), 'sourceSha256': sha(source)})
        return target


def runtime():
    BIN.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    run([sys.executable, ROOT / 'scripts/macos/prepare-compat.py'])
    print('Preparing standalone Node and Python...', flush=True)
    archive = fetch(f'https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-darwin-arm64.tar.gz',
                    CACHE / f'node-v{NODE_VERSION}-darwin-arm64.tar.gz', NODE_SHA256)
    with tarfile.open(archive) as bundle:
        prefix = f'node-v{NODE_VERSION}-darwin-arm64'
        for name, destination in [('bin/node', BIN / 'node'), ('LICENSE', RUNTIME / 'licenses/node-LICENSE')]:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(bundle.extractfile(prefix + '/' + name).read())
    (BIN / 'node').chmod(0o755)
    standalone = Path(capture([sys.executable, '-c', 'import sys; print(sys.base_prefix)']))
    if (standalone / 'Python').exists() or not (standalone / 'bin/python3.11').exists():
        raise RuntimeError('Run with uv-managed standalone Python 3.11, not a Framework Python.')
    python_root = RUNTIME / 'python'
    python_root.mkdir(parents=True, exist_ok=True)
    run(['/usr/bin/rsync', '-a', '--exclude', '__pycache__', '--exclude', '*.pyc',
         str(standalone) + '/', str(python_root) + '/'])
    python = python_root / 'bin/python3.11'
    uv = shutil.which('uv')
    if not uv:
        raise RuntimeError('Build requires uv.')
    lock = ROOT / 'packaging/macos/requirements.lock.txt'
    if not lock.exists():
        run([uv, 'pip', 'compile', '--python-version', '3.11', '--generate-hashes', '--no-header',
             ROOT / 'packaging/macos/requirements.in', '-o', lock], stdout=subprocess.DEVNULL)
    # This is our private copied interpreter, never the developer's installation.
    run([uv, 'pip', 'install', '--python', python, '--break-system-packages', '--require-hashes', '--only-binary', ':all:',
         '-r', lock], stdout=subprocess.DEVNULL)
    # Python's runtime is relocatable; console-script shebangs from installers are not.
    # OpenNova invokes modules through this interpreter, so drop nonessential scripts.
    for path in (python_root / 'bin').iterdir():
        if path.name not in ('python', 'python3', 'python3.11'):
            path.unlink()
    for name in ('python', 'python3', 'python3.11'):
        target = BIN / name
        if target.exists() or target.is_symlink():
            target.unlink()
        target.symlink_to('../python/bin/python3.11')
    for path in python_root.rglob('direct_url.json'):
        if 'file://' in path.read_text():
            path.unlink()
    copy(lock, RUNTIME / 'requirements.lock.txt')
    model = fetch(f'https://raw.githubusercontent.com/snakers4/silero-vad/{VAD_REV}/src/silero_vad/data/silero_vad.onnx',
                  CACHE / 'silero_vad.onnx', VAD_SHA256)
    copy(model, RUNTIME / 'models/silero_vad.onnx')
    copy(ROOT / 'tools/asr/LICENSE.silero', RUNTIME / 'licenses/silero-LICENSE')
    libs = Dylibs()
    print('Collecting FFmpeg and its dynamic libraries...', flush=True)
    for name in ('ffmpeg', 'ffprobe'):
        binary = shutil.which(name)
        if not binary:
            raise RuntimeError('Build requires ' + name)
        libs.collect(binary, BIN / name)
    # /usr/bin/git is an Xcode selector stub. Ship the real Git executable and
    # its helpers so background Git work also works without Command Line Tools.
    git_core = Path(capture(['/usr/bin/git', '--exec-path']))
    git = git_core.parents[1] / 'bin/git'
    copy(git, BIN / 'git')
    core_target = RUNTIME / 'libexec/git-core'
    core_target.mkdir(parents=True, exist_ok=True)
    for name in ('git-remote-http', 'git-remote-https', 'git-sh-setup', 'git-sh-i18n',
                 'git-sh-i18n--envsubst', 'git-credential-osxkeychain'):
        source = git_core / name
        if source.exists():
            copy(source, core_target / name)
    rg = shutil.which('rg')
    if rg:
        libs.collect(rg, BIN / 'rg')
    fontconfig = RUNTIME / 'share/fonts.conf'
    fontconfig.parent.mkdir(parents=True, exist_ok=True)
    fontconfig.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">'
                          '<fontconfig><dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir>'
                          '<dir prefix="xdg">fonts</dir><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>\n')
    # Keep dependency source records locally for rebuild/audit; no machine paths
    # are shipped in the app's public version inventory.
    (OUT / 'native-build-inputs.json').write_text(json.dumps(libs.records, indent=2) + '\n')
    license_root = RUNTIME / 'licenses/homebrew'
    for record in libs.records:
        parts = Path(record['source']).parts
        if 'Cellar' in parts:
            index = parts.index('Cellar')
            package = Path(*parts[:index + 3])
            for name in ('LICENSE', 'COPYING', 'COPYING.GPLv2', 'COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3'):
                if (package / name).is_file():
                    copy(package / name, license_root / parts[index + 1] / name)
    print('Runtime prepared.', flush=True)


def assemble():
    # Fail before changing staging when the ignored native build output is absent.
    system_binary = verify_system_artifact(ROOT)
    if CODE.is_symlink():
        raise RuntimeError('Staging code directory must not be a symlink.')
    if CODE.exists():
        shutil.rmtree(CODE)
    CODE.mkdir(parents=True, exist_ok=True)
    print('Staging current source and built engine artifacts...', flush=True)
    directories = ['engine', 'services', 'tools', 'scripts', 'skills', 'extensions', 'patches', 'packaging']
    excluded = ['node_modules', '.git', '.env*', '*.local.json', '.DS_Store', '__pycache__', '*.pyc',
                '.venv', '.cache', '.pytest_cache', '*.log', 'snapshots', 'tests', 'test', '.agents', '.claude',
                'website', 'benchmarks', 'coverage', '.dsh-build', '*.tsbuildinfo']
    # Only Git-visible source plus an explicit build-output allowlist can ship.
    # Copying directories wholesale could accidentally include ignored state.
    raw = subprocess.check_output(['/usr/bin/git', 'ls-files', '--cached', '--others',
                                   '--exclude-standard', '-z', '--', *directories], cwd=ROOT)
    names = {name.decode() for name in raw.split(b'\0') if name}
    for pattern in ['engine/harness/apps/*/{kind}/**/*',
                    'engine/harness/packages/*/*/{kind}/**/*',
                    'engine/harness/vendor/*/{kind}/**/*',
                    'engine/harness/native/system/packages/*/{kind}/**/*',
                    'engine/siwc/packages/local/{kind}/**/*']:
        for kind in ('lib', 'dist', 'prebuilds'):
            names.update(str(path.relative_to(ROOT)) for path in ROOT.glob(pattern.format(kind=kind))
                         if path.is_file() or path.is_symlink())
    names.add(str(system_binary.relative_to(ROOT)))
    for name in sorted(names):
        source = ROOT / name
        if any(fnmatch.fnmatch(part, pattern) for part in Path(name).parts for pattern in excluded):
            continue
        if not source.exists() and not source.is_symlink():
            continue
        target = CODE / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink():
            if not source.resolve().is_relative_to(ROOT):
                raise RuntimeError('External source symlink: ' + name)
            target.symlink_to(os.readlink(source))
        elif source.is_file():
            copy(source, target)
    for name in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'upstream.lock.json',
                 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'start.command'):
        if (ROOT / name).exists():
            copy(ROOT / name, CODE / name)
    (CODE / 'config').mkdir(exist_ok=True)
    for source in (ROOT / 'config').glob('*.example.json'):
        copy(source, CODE / 'config' / source.name)
    run([BIN / 'node', ROOT / 'scripts/macos/stage-node.mjs', '--source', ROOT, '--target', CODE])
    verify_system_artifact(CODE)
    for path in CODE.rglob('*'):
        if path.is_file() and path.name in ('.modules.yaml', '.pnpm-workspace-state-v1.json', '.package-lock.json'):
            path.unlink()
    root_shims = CODE / 'node_modules/.bin'
    if root_shims.exists():
        shutil.rmtree(root_shims)
    # Build tooling belongs on the build machine, not in the installed closure.
    run([BIN / 'node', ROOT / 'services/bot/web/build.mjs'], cwd=ROOT)
    shutil.copytree(ROOT / 'output/bot/web', CODE / 'output/bot/web', dirs_exist_ok=True)
    # Runtime helper paths are stable. Sources remain available for executor hashes.
    compile_jobs = {
        'opennova-audio': ['tools/voice/native/PlaybackQueue.swift', 'tools/voice/native/AudioDevices.swift', 'tools/voice/native/AudioBridge.swift'],
        'opennova-active-document': ['tools/desktop/active-document.swift'],
        'opennova-pdf-pages': ['tools/documents/read_pdf_pages.swift'],
        'opennova-pdf-evidence': ['tools/documents/pdf_evidence.swift'],
        'opennova-generate-pdf': ['tools/documents/generate_pdf.swift'],
    }
    for name, sources in compile_jobs.items():
        print('Compiling ' + name, flush=True)
        run(['/usr/bin/xcrun', 'swiftc', '-O', '-target', 'arm64-apple-macos15.0',
             *[ROOT / source for source in sources], '-o', BIN / name])
    helper = CODE / 'output/bin/siwc-keychain'
    helper.parent.mkdir(parents=True, exist_ok=True)
    run(['/usr/bin/xcrun', 'swiftc', '-O', '-target', 'arm64-apple-macos15.0',
         ROOT / 'services/agent/keychain.swift', '-o', helper])
    executable = APP / 'Contents/MacOS/OpenNova'
    executable.parent.mkdir(parents=True, exist_ok=True)
    run(['/usr/bin/xcrun', 'swiftc', '-O', '-target', 'arm64-apple-macos15.0',
         ROOT / 'packaging/macos/Launcher.swift', '-o', executable])
    copy(ROOT / 'packaging/macos/Info.plist', APP / 'Contents/Info.plist')
    run(['/usr/bin/swift', ROOT / 'packaging/macos/make-icon.swift', RESOURCES / 'OpenNova.icns'])
    print('App assembled.', flush=True)


def finalize():
    print('Auditing relocatability and applying local signatures...', flush=True)
    system_artifact(CODE)
    native = [path for path in APP.rglob('*') if macho(path)]
    libs = Dylibs()
    for name in ('ffmpeg', 'ffprobe'):
        libs.collect(shutil.which(name), BIN / name)
    for original in libs.compatibility:
        libs.collect(original, RUNTIME / 'lib' / Path(original).name)
    compatibility_licenses = OUT / 'compat-libs/licenses'
    if compatibility_licenses.exists():
        shutil.copytree(compatibility_licenses, RUNTIME / 'licenses/macos15-bottles', dirs_exist_ok=True)
    for path in native:
        if any(dep.startswith('/') and not dep.startswith(('/System/', '/usr/lib/')) for dep in dependencies(path)):
            libs.collect(path, path)
    for path in APP.rglob('*'):
        if path.is_symlink():
            resolved = path.resolve()
            if not resolved.is_relative_to(APP.resolve()) or not resolved.exists():
                raise RuntimeError('External/broken symlink in app: ' + str(path.relative_to(APP)))
    native = [path for path in APP.rglob('*') if macho(path)]
    deployment = {}
    for path in native:
        external = [dep for dep in dependencies(path) if dep.startswith('/') and not dep.startswith(('/System/', '/usr/lib/'))]
        if external:
            raise RuntimeError('External native dependency: ' + str(path) + ': ' + repr(external))
        commands = capture(['/usr/bin/xcrun', 'vtool', '-show-build', path])
        versions = re.findall(r'\bminos\s+(\d+(?:\.\d+)+)', commands)
        versions += re.findall(r'cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\d+(?:\.\d+)+)', commands)
        if any(tuple(map(int, value.split('.'))) > (15, 0, 0) for value in versions):
            raise RuntimeError('Native binary requires newer macOS: ' + str(path.relative_to(APP)) + ': ' + ','.join(versions))
        deployment[str(path.relative_to(APP))] = versions
        run(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', path],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    probe_env = {**os.environ, 'DYLD_BIND_AT_LAUNCH': '1', 'PATH': str(BIN) + ':/usr/bin:/bin'}
    for name in ('ffmpeg', 'ffprobe'):
        run([BIN / name, '-version'], env=probe_env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    # The loader dynamically resolves a platform package through pnpm's hoisted
    # production aliases; checking CLI --help alone does not exercise that path.
    run([BIN / 'node', '--input-type=module', '-e',
         "import {createRequire} from 'node:module'; const require=createRequire(process.cwd()+'/engine/harness/apps/cli/package.json'); require('node-addon-require-builtin').getBindingInfo();"],
        cwd=CODE, stdout=subprocess.DEVNULL)
    verify_system_artifact(CODE)
    run([BIN / 'node', CODE / 'scripts/macos/probe-system-lock.mjs', '--code', CODE], cwd=CODE)
    run([BIN / 'node', '--input-type=module', '-e',
         "import {recordBuild} from './scripts/build-record.mjs'; recordBuild();"], cwd=CODE)
    version = json.loads((CODE / 'package.json').read_text())['version']
    manifest = {'product': 'OpenNova', 'version': version, 'channel': 'internal', 'architecture': 'arm64',
                'minimumMacOS': '15.0', 'node': NODE_VERSION, 'python': '3.11.15',
                'developerID': False, 'notarized': False,
                'runtimeFiles': {str(path.relative_to(RUNTIME)): sha(path) for path in RUNTIME.rglob('*')
                                 if path.is_file() and not path.is_symlink()}}
    (RESOURCES / 'release.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    (OUT / 'deployment-targets.json').write_text(json.dumps(deployment, indent=2) + '\n')
    for path in APP.rglob('*'):
        if path.is_file() and not path.is_symlink():
            path.chmod(path.stat().st_mode | 0o200)
    run(['/usr/bin/xattr', '-cr', APP])
    run(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', APP],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', APP])
    print('App signature and dependency checks passed.', flush=True)


def disk_image():
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', APP])
    version = json.loads((CODE / 'package.json').read_text())['version']
    release = OUT / 'release'
    release.mkdir(parents=True, exist_ok=True)
    stage = APP.parent
    applications = stage / 'Applications'
    if not applications.exists():
        applications.symlink_to('/Applications')
    readme = ROOT / 'packaging/macos/安装说明.txt'
    copy(readme, stage / readme.name)
    target = release / f'OpenNova-{version}-internal-mac-arm64.dmg'
    run(['/usr/bin/hdiutil', 'create', '-volname', 'OpenNova 内部测试版', '-srcfolder', stage,
         '-ov', '-format', 'UDZO', target])
    run(['/usr/bin/hdiutil', 'verify', target])
    (release / 'SHA256SUMS.txt').write_text(sha(target) + '  ' + target.name + '\n')
    copy(readme, release / readme.name)
    print(str(target), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['runtime', 'assemble', 'finalize', 'dmg', 'all'], default='all')
    args = parser.parse_args()
    if sys.platform != 'darwin' or capture(['/usr/bin/uname', '-m']) != 'arm64':
        parser.error('This internal builder requires Apple Silicon macOS.')
    OUT.mkdir(parents=True, exist_ok=True)
    phases = {'runtime': runtime, 'assemble': assemble, 'finalize': finalize, 'dmg': disk_image}
    for name, callback in phases.items():
        if args.phase in (name, 'all'):
            callback()


if __name__ == '__main__':
    main()
