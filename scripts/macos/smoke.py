#!/usr/bin/env python3
"""Exercise an assembled macOS bundle without accounts, network models, or audio capture.

Usage: python3 scripts/macos/smoke.py /path/to/OpenNova.app
The report contains fixture results only. Local service tokens and raw controller
logs are never written to the report. No build/install command is run.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]

PYTHON_PROBE = r'''
import json, os, sys, urllib.request
from pathlib import Path
import numpy, onnxruntime, PIL, sounddevice, websockets
sys.path.insert(0, str(Path(os.environ['SMOKE_CODE'])/'tools/asr'))
import vad
def no_download(*args, **kwargs): raise AssertionError('unexpected_network_download')
urllib.request.urlopen = no_download
model = vad.ensure_model()
value = vad.SileroOnnx()(bytes(vad.FRAME_BYTES))
assert 0 <= value <= 1
assert str(Path(sys.executable).resolve()).startswith(str(Path(os.environ['SMOKE_RUNTIME']).resolve()) + '/')
print(json.dumps({'python':sys.version.split()[0], 'modules':{
 'numpy':numpy.__version__, 'onnxruntime':onnxruntime.__version__, 'Pillow':PIL.__version__,
 'sounddevice':sounddevice.__version__, 'websockets':websockets.__version__},
 'vadZeroFrameProbability':value, 'modelSha256':vad.MODEL_SHA256,
 'downloadAttempted':False, 'microphoneOpened':False}))
'''

DOCUMENT_PROBE = r'''
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.SMOKE_CODE, runtime=realpathSync(process.env.SMOKE_RUNTIME), workdir=process.env.SMOKE_WORK;
const calls=[];
for(const method of ['spawn','execFile','execFileSync']){
 const original=cp[method];
 cp[method]=function(command,...args){
  assert.ok(!['uv','swift','swiftc','xcrun'].includes(basename(command)),'unexpected developer toolchain fallback');
  assert.ok(realpathSync(command).startsWith(runtime+'/'),'subprocess outside packaged runtime');
  calls.push({method,executable:basename(command)});return original.call(this,command,...args);
 };
}
syncBuiltinESMExports();
const moduleAt=path=>import(pathToFileURL(join(root,path)).href);
const {normalizeDocumentSpec}=await moduleAt('services/bot/documents/spec.mjs');
const {documentCapabilities,runDocumentGenerator}=await moduleAt('services/bot/documents/runner.mjs');
const {preparePdfPages}=await moduleAt('services/bot/desktop/pdf-pages.mjs');
const {verifyPdfQuotes}=await moduleAt('services/bot/desktop/pdf-evidence.mjs');
const {verifyOfficeQuotes}=await moduleAt('services/bot/desktop/office-evidence.mjs');
const capabilities=documentCapabilities();
assert.equal(capabilities.pdf.compiled,true);assert.equal(capabilities.pdf.available,true);assert.equal(capabilities.docx.available,true);
const quote='OpenNova packaging smoke verification.';
const spec=normalizeDocumentSpec({schemaVersion:1,title:'OpenNova 安装包验收',blocks:[{type:'paragraph',text:quote}]});
const specPath=join(workdir,'document-spec.json');writeFileSync(specPath,JSON.stringify(spec));
const results={};
for(const format of ['pdf','docx']){
 const outputPath=join(workdir,'fixture.'+format);
 const result=await runDocumentGenerator({format,specPath,outputPath,workdir});
 assert.equal(result.generation.status,'completed');assert.equal(result.contentValidation.status,'passed');
 results[format]={bytes:readFileSync(outputPath).length,contentValidation:result.contentValidation.status};
}
const pdf=readFileSync(join(workdir,'fixture.pdf'));
const pages=await preparePdfPages({bytes:pdf});assert.ok(pages.pageCount>=1);
const citation=(await verifyPdfQuotes({bytes:pdf,items:[{page:1,quote}]}))[0];assert.equal(citation.verified,true);
const docx=readFileSync(join(workdir,'fixture.docx'));
const office=(await verifyOfficeQuotes({bytes:docx,mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',items:[{locator:{paragraph:2},quote}]}))[0];
assert.equal(office.verified,true);
console.log(JSON.stringify({documents:results,pdfPages:pages.pageCount,pdfCitationVerified:true,docxCitationVerified:true,subprocesses:calls,developerToolchainFallback:false}));
'''

AUTH_PROBE = r'''
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
let networkCalls=0,encryptionCalls=0;
globalThis.fetch=async()=>{networkCalls++;throw Error('network_disabled_in_smoke');};
const {createChatGPT}=await import(pathToFileURL(join(process.env.SMOKE_CODE,'engine/siwc/packages/local/dist/index.js')));
const client=createChatGPT({appName:'OpenNova offline verification',appId:'opennova-smoke',redirectPort:0,
 storageDir:join(process.env.OPENNOVA_APP_DATA,'sdk-empty-auth'),
 credentialEncryption:{id:'offline-test-only',isAvailable:async()=>true,
 encrypt:async()=>{encryptionCalls++;throw Error('unexpected credential write');},
 decrypt:async()=>{encryptionCalls++;throw Error('unexpected credential read');}},
 openBrowser:()=>{throw Error('unexpected interactive login');}});
const session=await client.getSession();assert.equal(session.status,'disconnected');assert.equal(session.sharing,false);
let errorCode;try{await client.listModels();}catch(error){errorCode=error.code;}
assert.equal(errorCode,'sign_in_required');assert.equal(networkCalls,0);assert.equal(encryptionCalls,0);
console.log(JSON.stringify({sessionStatus:session.status,sharing:session.sharing,modelRequestError:errorCode,
 networkCalls,keychainAccessed:false,encryptionAdapter:'inert test adapter; native Keychain is not exercised'}));
'''


def safe(value):
    value = str(value)
    value = re.sub(r'(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]+', r'\1[redacted]', value)
    value = re.sub(r'(?i)([?&]token=)[^&\s]+', r'\1[redacted]', value)
    return re.sub(r'\b[a-fA-F0-9]{64}\b', '[redacted]', value)[-2500:]


def execute(command, env, cwd, timeout=90):
    child = subprocess.Popen([str(x) for x in command], env=env, cwd=cwd,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             start_new_session=True)
    try:
        stdout, stderr = child.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        raise RuntimeError('subprocess_timeout:' + Path(command[0]).name) from None
    if child.returncode:
        raise RuntimeError(f'{Path(command[0]).name}_exit_{child.returncode}: ' + safe(stderr or stdout))
    return stdout


def tree_snapshot(root):
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            stat = path.lstat()
            result[str(path.relative_to(root))] = (stat.st_mode, stat.st_size, stat.st_mtime_ns,
                                                  os.readlink(path) if path.is_symlink() else None)
    return result


def free_ports():
    sockets = [socket.socket(), socket.socket()]
    try:
        for item in sockets:
            item.bind(('127.0.0.1', 0))
        return [item.getsockname()[1] for item in sockets]
    finally:
        for item in sockets:
            item.close()


def port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.3):
            return True
    except OSError:
        return False


def process_table():
    text = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,lstart='], text=True)
    result = {}
    for line in text.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            result[int(parts[0])] = (int(parts[1]), parts[2])
    return result


def descendants(parent, table):
    found = {parent}
    while True:
        new = {pid for pid, (ppid, _) in table.items() if ppid in found} - found
        if not new:
            return {pid: table[pid][1] for pid in found if pid in table}
        found.update(new)


def controller_instance_probe(node, code, env, work, cycles=1):
    ports = free_ports()
    runtime_env = {**env, 'OPENNOVA_BOT_PORT': str(ports[0]), 'OPENNOVA_BOT_WEB_PORT': str(ports[1])}
    process = subprocess.Popen([str(node), str(code / 'packaging/macos/runner.mjs')],
                               cwd=work, env=runtime_env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                               bufsize=1, start_new_session=True)
    messages = queue.Queue()
    states, diagnostics = [], []
    tracked = {}
    forced = []
    completed = False

    def read_stdout():
        for line in process.stdout:
            try:
                item = json.loads(line)
            except ValueError:
                item = {'type': 'protocol-error', 'text': safe(line)}
            messages.put(item)

    def read_stderr():
        for line in process.stderr:
            diagnostics.append(safe(line))
            del diagnostics[:-8]

    readers = [threading.Thread(target=read_stdout, daemon=True), threading.Thread(target=read_stderr, daemon=True)]
    for thread in readers:
        thread.start()

    def send(action):
        process.stdin.write(json.dumps({'action': action}) + '\n')
        process.stdin.flush()

    def wait_for(predicate, timeout=90):
        deadline = time.monotonic() + timeout
        recent = []
        while time.monotonic() < deadline:
            tracked.update(descendants(process.pid, process_table()))
            try:
                item = messages.get(timeout=0.2)
            except queue.Empty:
                if process.poll() is not None:
                    raise RuntimeError('controller_exited_early:' + safe(' '.join(diagnostics)))
                continue
            if item.get('type') == 'status':
                states.append(item.get('state'))
            if item.get('type') == 'log':
                recent.append(item.get('text', ''))
                del recent[:-6]
            if item.get('type') in ('error', 'protocol-error'):
                raise RuntimeError('controller_error:' + safe(item.get('text', '') + '\n' + '\n'.join(recent)))
            if predicate(item):
                return item
        raise RuntimeError('controller_timeout:' + safe('\n'.join(recent)))

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base = f'http://127.0.0.1:{ports[0]}'
    try:
        wait_for(lambda item: item.get('type') == 'status' and item.get('state') == 'stopped', 15)
        send('status')
        settings = wait_for(lambda item: item.get('type') == 'settings', 10)
        assert settings['hasAsrKey'] is False and settings['hasTtsKey'] is False
        cycle_results = []
        session_fingerprint = None
        previous_runtime = None
        for cycle in range(1, cycles + 1):
            # Discard previous status notifications before requesting a new boot.
            while True:
                try:
                    messages.get_nowait()
                except queue.Empty:
                    break
            started = time.monotonic()
            send('start')
            wait_for(lambda item: item.get('type') == 'status' and item.get('state') == 'ready', 140)
            with opener.open(base + '/', timeout=5) as response:
                page = response.read(2_000_000)
                assert response.status == 200 and b'OpenNova' in page
            token = (Path(env['OPENNOVA_APP_DATA']) / 'bot/client.token').read_text().strip()
            def snapshot_value():
                request = urllib.request.Request(base + '/snapshot', data=b'{}', method='POST',
                                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with opener.open(request, timeout=5) as response:
                    return json.load(response)
            snapshot = snapshot_value()
            deadline = time.monotonic() + 10
            while snapshot['desktop']['voice'].get('phase') != 'standby' and time.monotonic() < deadline:
                time.sleep(0.1)
                snapshot = snapshot_value()
            assert snapshot['health']['workspace'] == env['OPENNOVA_WORKSPACE']
            assert snapshot['health']['ready'] is True
            assert snapshot['messages'] == [], 'restart_created_unrequested_messages'
            current_runtime = snapshot['health']['runtimeId']
            assert current_runtime != previous_runtime, 'controller_reused_old_runtime_after_stop'
            previous_runtime = current_runtime
            identity = ':'.join([snapshot['health']['botId'], snapshot['health']['sessionId']])
            fingerprint = hashlib.sha256(identity.encode()).hexdigest()
            if session_fingerprint is not None:
                assert fingerprint == session_fingerprint, 'empty_session_identity_not_preserved_on_restart'
            session_fingerprint = fingerprint
            voice = snapshot['desktop']['voice']
            assert voice.get('audioEnabled') is False and voice.get('phase') == 'standby'
            assert not (Path(env['OPENNOVA_APP_DATA']) / 'auth/chatgpt-auth.json').exists()
            send('stop')
            wait_for(lambda item: item.get('type') == 'status' and item.get('state') == 'stopped', 40)
            deadline = time.monotonic() + 8
            while any(port_open(port) for port in ports) and time.monotonic() < deadline:
                time.sleep(0.1)
            assert not any(port_open(port) for port in ports), 'controller_left_service_listening'
            cycle_results.append({'cycle': cycle, 'seconds': round(time.monotonic() - started, 3),
                                  'pageHTTP': 200, 'voicePhase': voice['phase'], 'audioEnabled': False,
                                  'conversationMessages': 0, 'portsClosed': True})
        send('quit')
        process.wait(timeout=10)
        assert process.returncode == 0
        completed = True
        return {'protocol': ['status'] + ['start', 'stop'] * cycles + ['quit'], 'states': states,
                'cycles': cycle_results, 'sessionFingerprint': session_fingerprint,
                'savedAuthorization': False, 'modelRequestSubmitted': False,
                'portsClosed': True, 'controllerExitCode': 0}
    except Exception as error:
        diagnostic = Path(env['OPENNOVA_APP_DATA']) / 'logs/voice/bot.log'
        tail = safe(diagnostic.read_text(errors='replace')[-6000:]) if diagnostic.is_file() else ''
        raise RuntimeError(f'{type(error).__name__}: {error}' + ('\nIsolated Bot diagnostic:\n' + tail if tail else '')) from None
    finally:
        if process.poll() is None:
            tracked.update(descendants(process.pid, process_table()))
        if process.poll() is None:
            try:
                send('quit')
                process.wait(timeout=30)
            except (OSError, subprocess.TimeoutExpired):
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=5)
        # Only descendants observed under this controller may be reaped. PID start
        # times must still match; another process reusing a PID is never signalled.
        remaining = process_table()
        for pid, started in tracked.items():
            if pid != process.pid and pid in remaining and remaining[pid][1] == started:
                try:
                    os.kill(pid, signal.SIGTERM); forced.append(pid)
                except ProcessLookupError:
                    pass
        if forced:
            time.sleep(0.3)
            remaining = process_table()
            for pid in forced:
                if pid in remaining and remaining[pid][1] == tracked[pid]:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                stream.close()
            except OSError:
                pass
        if completed and forced:
            raise RuntimeError('controller_left_descendants_after_clean_exit')



def controller_probe(node, code, env, work):
    # Reuse the same data without sending any message. First restart the Bot in
    # one controller, then relaunch the entire app controller against its state.
    first = controller_instance_probe(node, code, env, work, cycles=2)
    reopened = controller_instance_probe(node, code, env, work, cycles=1)
    assert first['sessionFingerprint'] == reopened['sessionFingerprint'], 'empty_session_lost_after_controller_reopen'
    first.pop('sessionFingerprint')
    reopened.pop('sessionFingerprint')
    return {'sameDataDirectory': True, 'startStopCycles': 3, 'controllerInstances': 2,
            'emptySessionPreserved': True, 'conversationMessages': 0,
            'modelRequestSubmitted': False, 'portsClosed': True,
            'firstController': first, 'reopenedController': reopened}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'output/macos/verification')
    parser.add_argument('--skip-controller', action='store_true', help='Runtime-only partial check; report is marked partial.')
    parser.add_argument('--only', action='append', choices=['native', 'python', 'media', 'documents', 'authorization', 'controller'],
                        help='Repeat only selected checks after a fix; may be passed more than once.')
    options = parser.parse_args()
    bundle = options.bundle.resolve(strict=True)
    resources = bundle / 'Contents/Resources'
    code, runtime = resources / 'app', resources / 'runtime'
    binary, python = runtime / 'bin', runtime / 'python/bin/python3.11'
    required = [binary / name for name in ['node', 'ffmpeg', 'ffprobe', 'opennova-generate-pdf', 'opennova-pdf-pages', 'opennova-pdf-evidence']]
    required += [python, runtime / 'models/silero_vad.onnx', code / 'packaging/macos/runner.mjs']
    missing = [str(path.relative_to(bundle)) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError('bundle_not_ready:' + ','.join(missing))
    started = datetime.now(timezone.utc).isoformat()
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(os.getpid())
    output = options.output_dir.resolve() / run_id
    output.mkdir(parents=True, exist_ok=False)
    selected = set(options.only or ['native', 'python', 'media', 'documents', 'authorization', 'controller'])
    if options.skip_controller:
        selected.discard('controller')
    partial = bool(options.skip_controller or options.only)
    report = {'schemaVersion': 1, 'bundle': str(bundle), 'startedAt': started,
              'partial': partial, 'selected': sorted(selected), 'checks': [], 'limits': [
                  'No microphone capture, cloud request, interactive authorization, or native Keychain validation.',
                  'Controller protocol is tested; Finder UI rendering and target-machine Gatekeeper are not tested.',
                  'The SDK authorization check uses an inert test encryption adapter with empty temporary storage.']}
    before = tree_snapshot(bundle)
    with tempfile.TemporaryDirectory(prefix='opennova-package-smoke-') as directory:
        scratch = Path(directory)
        data, work, cache = scratch / 'data', scratch / 'workspace', scratch / 'cache'
        for path in (data, work, cache, scratch / 'tmp'):
            path.mkdir(mode=0o700)
        # HOME retains its real OS meaning. Every app/account/cache path used by
        # these probes is explicit; no developer credential variable is inherited.
        env = {key: os.environ[key] for key in ['HOME', 'USER', 'LOGNAME'] if key in os.environ}
        env.update({'PATH': ':'.join([str(binary), str(runtime / 'python/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
                    'LANG': 'en_US.UTF-8', 'TMPDIR': str(scratch / 'tmp'), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
                    'XDG_CACHE_HOME': str(cache), 'XDG_CONFIG_HOME': str(scratch / 'config'), 'XDG_DATA_HOME': str(scratch / 'share'),
                    'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1', 'NO_PROXY': 'localhost,127.0.0.1',
                    'OPENNOVA_PACKAGED': '1', 'OPENNOVA_APP_DATA': str(data), 'OPENNOVA_WORKSPACE': str(work),
                    'OPENNOVA_CONFIG': str(data / 'config/voice.local.json'), 'OPENNOVA_SECRETS_FILE': str(data / 'config/secrets.local.json'),
                    'OPENNOVA_BOT_HOME': str(data / 'bot'), 'OPENNOVA_SIWC_STORAGE': str(data / 'auth'),
                    'OPENNOVA_NODE': str(binary / 'node'), 'OPENNOVA_PYTHON': str(python), 'OPENNOVA_IMAGE_PYTHON': str(python),
                    'OPENNOVA_BIN_DIR': str(binary), 'OPENNOVA_VAD_MODEL': str(runtime / 'models/silero_vad.onnx'),
                    'FONTCONFIG_FILE': str(runtime / 'share/fonts.conf'), 'FONTCONFIG_PATH': str(runtime / 'share'),
                    'SMOKE_CODE': str(code), 'SMOKE_RUNTIME': str(runtime), 'SMOKE_WORK': str(work)})

        def check(name, operation):
            begin = time.monotonic()
            try:
                details = operation()
                record = {'name': name, 'status': 'passed', 'details': details}
            except Exception as error:
                record = {'name': name, 'status': 'failed', 'error': safe(f'{type(error).__name__}: {error}')}
            record['seconds'] = round(time.monotonic() - begin, 3)
            report['checks'].append(record)
            print(json.dumps({'check': name, 'status': record['status'], 'seconds': record['seconds']}, ensure_ascii=False), flush=True)

        def python_probe():
            return json.loads(execute([python, '-B', '-c', PYTHON_PROBE], env, work, 90))

        def media_probe():
            video, gif = work / 'fixture.mp4', work / 'fixture.gif'
            execute([binary / 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i',
                     'color=c=blue:s=32x32:r=5:d=0.4', '-an', '-c:v', 'mpeg4', '-y', video], env, work, 30)
            execute([binary / 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', video,
                     '-vf', 'fps=5,scale=32:32:flags=neighbor', '-loop', '0', '-y', gif], env, work, 30)
            probe = json.loads(execute([binary / 'ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height',
                                       '-of', 'json', video], env, work, 15))
            assert probe['streams'][0]['width'] == 32 and float(probe['format']['duration']) > 0
            image = json.loads(execute([python, '-B', '-c',
                'from PIL import Image; import json,sys; image=Image.open(sys.argv[1]); assert image.format=="GIF"; print(json.dumps({"format":image.format,"frames":image.n_frames,"size":list(image.size)}))', gif], env, work, 15))
            return {'video': probe, 'gif': image}

        def node_probe(name, source):
            script = scratch / (name + '.mjs'); script.write_text(source)
            return json.loads(execute([binary / 'node', script], env, work, 90))

        if 'native' in selected or 'controller' in selected:
            check('harness-native-session-lock', lambda: json.loads(execute(
                [binary / 'node', ROOT / 'scripts/macos/probe-system-lock.mjs', '--code', code], env, work, 30)))
        if 'python' in selected:
            check('bundled-python-and-local-vad', python_probe)
        if 'media' in selected:
            check('bundled-ffmpeg-ffprobe-and-gif', media_probe)
        if 'documents' in selected:
            check('compiled-pdf-and-python-docx', lambda: node_probe('documents', DOCUMENT_PROBE))
        if 'authorization' in selected:
            check('isolated-sdk-without-authorization', lambda: node_probe('authorization', AUTH_PROBE))
        if 'controller' in selected:
            check('real-controller-and-bot-restart-persistence', lambda: controller_probe(binary / 'node', code, env, work))
        for name in ['fixture.pdf', 'fixture.docx', 'fixture.mp4', 'fixture.gif']:
            if (work / name).is_file():
                shutil.copy2(work / name, output / name)
        after = tree_snapshot(bundle)
        changed = [name for name in before.keys() | after.keys() if before.get(name) != after.get(name)]
        report['checks'].append({'name': 'application-bundle-remains-unchanged',
                                 'status': 'failed' if changed else 'passed', 'details': {'changedPaths': sorted(changed)}})
    report['finishedAt'] = datetime.now(timezone.utc).isoformat()
    report['status'] = 'failed' if any(item['status'] != 'passed' for item in report['checks']) else 'partial' if partial else 'passed'
    report['artifacts'] = {path.name: {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                           for path in output.iterdir() if path.is_file()}
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'report': str(output / 'report.json')}, ensure_ascii=False), flush=True)
    return 1 if report['status'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
