#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets==15.0.1", "python-socks[asyncio]==3.1.1", "sounddevice==0.5.6", "numpy==2.2.6", "onnxruntime==1.23.2"]
# ///
"""Test Doubao ASR 2.0 with a short audio file or a live microphone."""
import argparse
from array import array
import asyncio
from contextlib import aclosing
from datetime import datetime, timezone
import gzip
import json
import logging
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
SAMPLE = ROOT / 'videos/scene-one/public/audio/02-user.mp3'
BYTES_PER_SECOND = 16000 * 2


class ASRError(Exception):
    pass


def safe_message(value, key=''):
    text = str(value)
    return (text.replace(key, '[REDACTED]') if key else text)[:1000]


def load_key(path=None, *, environ=None):
    """Load only the environment or ignored local JSON; never read README."""
    env = os.environ if environ is None else environ
    key = env.get('DOUBAO_ASR_API_KEY', '').strip()
    if key:
        return key
    path = Path(path or env.get('OPENNOVA_SECRETS_FILE') or ROOT / 'config/secrets.local.json').expanduser()
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        key = data['doubao']['api_key']
        if not isinstance(key, str) or not key.strip():
            raise ValueError()
    except (OSError, UnicodeError, ValueError, KeyError, TypeError):
        # File contents and parsing errors may contain credentials.
        raise ASRError('请在 config/secrets.local.json 中配置 doubao.api_key，或设置 DOUBAO_ASR_API_KEY。') from None
    return key.strip()


def encode_packet(payload, *, audio=False, final=False):
    compressed = gzip.compress(payload)
    kind = 2 if audio else 1
    flags = 2 if final else 0
    serialization = 0 if audio else 1
    return (bytes([0x11, (kind << 4) | flags, (serialization << 4) | 1, 0])
            + struct.pack('>I', len(compressed)) + compressed)


def decode_packet(packet):
    if not isinstance(packet, bytes) or len(packet) < 8:
        raise ASRError('无效或截断的服务端二进制消息。')
    version, header_size = packet[0] >> 4, (packet[0] & 15) * 4
    kind, flags = packet[1] >> 4, packet[1] & 15
    serialization, compression = packet[2] >> 4, packet[2] & 15
    if (version != 1 or header_size < 4 or header_size + 4 > len(packet)
            or kind not in (9, 15) or flags > 3
            or serialization not in (0, 1) or compression not in (0, 1)):
        raise ASRError('不支持的服务端消息格式。')
    offset = header_size
    code = None
    if kind == 15 or flags & 1:
        if offset + 8 > len(packet):
            raise ASRError('服务端消息缺少序号或长度字段。')
        if kind == 15:
            code = struct.unpack_from('>I', packet, offset)[0]
        offset += 4
    size = struct.unpack_from('>I', packet, offset)[0]
    payload = packet[offset + 4:]
    if size != len(payload):
        raise ASRError('服务端消息长度不匹配。')
    try:
        if compression == 1:
            payload = gzip.decompress(payload)
        text = payload.decode('utf-8')
        if kind == 15:
            raise ASRError(f'服务端错误 {code}: {text}')
        body = json.loads(text)
    except (OSError, EOFError, UnicodeError, ValueError) as error:
        raise ASRError('服务端消息无法解码。') from error
    if not isinstance(body, dict):
        raise ASRError('服务端结果必须是 JSON 对象。')
    return body, bool(flags & 2)


class Transcript:
    def __init__(self):
        self.text = ''
        self.final = False

    def update(self, body, final):
        code = body.get('code')
        if code not in (None, 0, 20000000):
            raise ASRError(f'服务端错误 {code}: {body.get("message", "识别失败")}')
        result = body.get('result')
        if isinstance(result, dict) and isinstance(result.get('text'), str):
            # result_type=full: new results replace earlier revisions.
            self.text = result['text']
        self.final = final

    def finish(self):
        if not self.final:
            raise ASRError('连接结束前未收到最终结果，不能记为测试成功。')
        if not self.text.strip():
            raise ASRError('收到最终结果，但没有识别到文字。')
        return self.text


def load_pcm(path):
    if not path.is_file():
        raise ASRError(f'音频文件不存在：{path}')
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise ASRError('需要 FFmpeg 将音频转换为 16 kHz 单声道 PCM。')
    completed = subprocess.run(
        [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', str(path),
         '-t', '61', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
        capture_output=True, timeout=30, check=False)
    if completed.returncode:
        raise ASRError('音频转换失败：' + completed.stderr.decode('utf-8', errors='replace'))
    pcm = completed.stdout
    if not pcm or len(pcm) > 60 * BYTES_PER_SECOND:
        raise ASRError('请选择非空且不超过 60 秒的测试音频。')
    return pcm


async def microphone_chunks(seconds, device=None):
    """Bounded live capture; release the device on completion or cancellation."""
    import sounddevice as sd

    queue = asyncio.Queue(maxsize=10)
    loop = asyncio.get_running_loop()
    failure = None
    accepting = True

    def enqueue(data, status):
        nonlocal failure
        if not accepting:
            return
        if status:
            failure = ASRError('麦克风采集出现溢出或中断，请重新测试。')
        elif queue.full():
            failure = ASRError('音频发送积压超过 2 秒，已停止采集，请检查网络。')
        else:
            queue.put_nowait(data)

    def callback(indata, frames, timing, status):
        loop.call_soon_threadsafe(enqueue, bytes(indata), bool(status))

    remaining = round(seconds * 16000) * 2
    try:
        with sd.RawInputStream(samplerate=16000, blocksize=3200, channels=1,
                               dtype='int16', device=device, callback=callback):
            print(f'麦克风已开启，请开始说话（{seconds:g} 秒后自动停止；说完请等待；Ctrl+C 立即取消）。', flush=True)
            while remaining:
                if failure:
                    raise failure
                try:
                    chunk = await asyncio.wait_for(queue.get(), timeout=3)
                except TimeoutError:
                    raise ASRError('麦克风未返回音频，请检查输入设备及 macOS 麦克风权限。') from None
                if failure:
                    raise failure
                if not chunk or len(chunk) % 2:
                    raise ASRError('麦克风返回了无效的 PCM 数据。')
                chunk = chunk[:remaining]
                remaining -= len(chunk)
                yield chunk, remaining == 0
    finally:
        accepting = False


async def file_chunks(pcm):
    stream_start = time.monotonic()
    chunk_size = BYTES_PER_SECOND // 5
    for offset in range(0, len(pcm), chunk_size):
        chunk = pcm[offset:offset + chunk_size]
        deadline = stream_start + (offset + len(chunk)) / BYTES_PER_SECOND
        await asyncio.sleep(max(0, deadline - time.monotonic()))
        yield chunk, offset + len(chunk) == len(pcm)


async def recognize(pcm, key, resource_id, *, mic_seconds=None, device=None,
                    audio_source=None, audio_seconds_limit=48, turn_id=None, on_text=None):
    from websockets.asyncio.client import connect
    from websockets.exceptions import InvalidStatus

    request_id = str(uuid.uuid4())
    headers = {'X-Api-Key': key, 'X-Api-Resource-Id': resource_id,
               'X-Api-Request-Id': request_id, 'X-Api-Connect-Id': request_id}
    params = {
        'user': {'uid': 'opennova-asr-smoke-test'},
        'audio': {'format': 'pcm', 'codec': 'raw', 'rate': 16000, 'bits': 16, 'channel': 1},
        'request': {'model_name': 'bigmodel', 'enable_itn': True, 'enable_punc': True,
                    'enable_ddc': False, 'enable_nonstream': True,
                    'show_utterances': True, 'result_type': 'full'},
    }
    prefix = f'[第 {turn_id} 轮] ' if turn_id is not None else ''
    duration = (audio_seconds_limit if audio_source is not None else mic_seconds
                if mic_seconds is not None else round(len(pcm) / BYTES_PER_SECOND, 3))
    report = {'timestamp': datetime.now(timezone.utc).isoformat(), 'endpoint': ENDPOINT,
              'resource_id': resource_id, 'request_id': request_id,
              'input_mode': 'vad_turn' if audio_source is not None else 'microphone' if mic_seconds is not None else 'file',
              'audio_seconds': duration,
              'enable_nonstream': True, 'success': False}
    logger = logging.getLogger('opennova.asr.websocket')
    logger.handlers = [logging.NullHandler()]
    logger.propagate = False
    logger.setLevel(logging.CRITICAL)
    started = time.monotonic()
    try:
        async with connect(ENDPOINT, additional_headers=headers, open_timeout=15,
                           close_timeout=5, max_size=4 * 1024 * 1024, logger=logger) as ws:
            report['connect_ms'] = round((time.monotonic() - started) * 1000)
            report['log_id'] = ws.response.headers.get('X-Tt-Logid')
            print(prefix + '连接成功，准备实时音频输入。', flush=True)
            await ws.send(encode_packet(json.dumps(params).encode('utf-8')))
            stream_start = time.monotonic()
            last_sent = None
            transcript = Transcript()
            report['first_text_ms'] = None
            report['text_updates'] = 0
            report['input_peak'] = 0
            report['audio_packets_sent'] = 0
            report['server_messages'] = 0

            async def send_audio():
                nonlocal last_sent
                sent_bytes = 0
                window_peak = 0
                next_status_at = BYTES_PER_SECOND
                source = (audio_source if audio_source is not None else
                          microphone_chunks(mic_seconds, device) if mic_seconds is not None else file_chunks(pcm))
                async with aclosing(source):
                    async for chunk, final in source:
                        peak = max(abs(value) for value in array('h', chunk))
                        report['input_peak'] = max(report['input_peak'], peak)
                        window_peak = max(window_peak, peak)
                        if final:
                            last_sent = time.monotonic()
                        await ws.send(encode_packet(chunk, audio=True, final=final))
                        sent_bytes += len(chunk)
                        report['audio_packets_sent'] += 1
                        if mic_seconds is not None and (sent_bytes >= next_status_at or final):
                            state = '已收到转写' if transcript.text else '等待转写'
                            if window_peak == 0:
                                state += '；当前为全零信号，可检查麦克风权限或静音'
                            print(f'收音 {sent_bytes / BYTES_PER_SECOND:.1f}/{mic_seconds:g} 秒'
                                  f' | 音量峰值 {window_peak}/32768'
                                  f' | 已发送 {report["audio_packets_sent"]} 包'
                                  f' / 收到 {report["server_messages"]} 条响应 | {state}', flush=True)
                            window_peak = 0
                            next_status_at = sent_bytes + BYTES_PER_SECOND
                report['audio_seconds'] = round(sent_bytes / BYTES_PER_SECOND, 3)
                if mic_seconds is not None:
                    print('麦克风已关闭，等待最终识别结果。', flush=True)
                    if report['input_peak'] == 0:
                        raise ASRError('麦克风全程返回零信号，请检查静音、输入设备和 macOS 麦克风权限。')

            sender = asyncio.create_task(send_audio())

            async def receive():
                async for packet in ws:
                    report['server_messages'] += 1
                    body, final = decode_packet(packet)
                    old_text = transcript.text
                    transcript.update(body, final)
                    if on_text is not None and transcript.text != old_text:
                        on_text(transcript.text)
                    if transcript.text and transcript.text != old_text:
                        report['text_updates'] += 1
                        if report['first_text_ms'] is None:
                            report['first_text_ms'] = round((time.monotonic() - stream_start) * 1000)
                        if not final:
                            print(prefix + '转写：' + safe_message(transcript.text, key), flush=True)
                    if final:
                        if last_sent is None:
                            raise ASRError('服务端在音频发送完成前结束了识别。')
                        report['final_after_last_packet_ms'] = round((time.monotonic() - last_sent) * 1000)
                        text = transcript.finish()
                        print(prefix + '最终：' + safe_message(text, key), flush=True)
                        return text
                return transcript.finish()

            receiver = asyncio.create_task(receive())
            try:
                _, text = await asyncio.wait_for(asyncio.gather(sender, receiver),
                                                timeout=report['audio_seconds'] + 30)
            finally:
                for task in (sender, receiver):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(sender, receiver, return_exceptions=True)
            report.update(success=True, text=text,
                          total_ms=round((time.monotonic() - started) * 1000))
            return report
    except InvalidStatus as error:
        response = error.response
        details = response.body.decode('utf-8', errors='replace')
        log_id = response.headers.get('X-Tt-Logid', '')
        raise ASRError(f'连接被拒绝 HTTP {response.status_code}，log_id={log_id}：{details}') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--audio', type=Path, help='WAV/MP3 等音频文件，最长 60 秒；默认使用项目样例')
    source.add_argument('--mic', action='store_true', help='通过本机麦克风实时收音')
    source.add_argument('--list-devices', action='store_true', help='列出麦克风设备，不录音、不调用 API')
    parser.add_argument('--seconds', type=int, default=20, help='麦克风测试时长 1–60 秒，默认 20')
    parser.add_argument('--device', help='麦克风设备编号或名称；默认使用系统输入设备')
    parser.add_argument('--vad', action='store_true', help='本地 VAD 自动分轮；麦克风测试支持最长 600 秒')
    parser.add_argument('--vad-only', action='store_true', help='仅测试本地 VAD，不读取密钥、不调用 ASR')
    parser.add_argument('--silence-ms', type=int, default=800, help='VAD 连续静音收尾时长，默认 800 ms')
    parser.add_argument('--vad-threshold', type=float, default=0.5, help='VAD 开始阈值，默认 0.5')
    parser.add_argument('--output', type=Path, help='可选：保存脱敏后的成功结果 JSON')
    parser.add_argument('--billing', choices=['duration', 'concurrent'], default='duration',
                        help='已开通的小时版或并发版；默认 duration')
    args = parser.parse_args()
    key = ''
    try:
        if args.list_devices:
            import sounddevice as sd
            for index, info in enumerate(sd.query_devices()):
                if info['max_input_channels'] > 0:
                    marker = '（默认）' if index == sd.default.device[0] else ''
                    print(f'{index}: {info["name"]}{marker}')
            return 0
        vad_enabled = args.vad or args.vad_only
        max_seconds = 600 if vad_enabled else 60
        if not 1 <= args.seconds <= max_seconds:
            raise ASRError(f'--seconds 必须在 1–{max_seconds} 之间。')
        if not 200 <= args.silence_ms <= 3000 or not 0.1 <= args.vad_threshold <= 0.9:
            raise ASRError('静音时长需为 200–3000 ms，VAD 阈值需为 0.1–0.9。')
        device = int(args.device) if args.device and args.device.isdigit() else args.device
        if args.output and (args.output.exists() or args.output.is_symlink()):
            raise ASRError('结果文件已存在，请指定新的输出路径。')
        if not args.vad_only:
            key = load_key()
        credentials = '仅本地 VAD，不调用云端' if args.vad_only else '密钥已加载（不显示）'
        if args.mic:
            import sounddevice as sd
            info = sd.query_devices(device, 'input')
            sd.check_input_settings(device=device, samplerate=16000, channels=1, dtype='int16')
            print(f'输入设备：{info["name"]} | 测试 {args.seconds} 秒 | {credentials}', flush=True)
            pcm = None
        else:
            pcm = load_pcm((args.audio or SAMPLE).resolve())
            print(f'音频测试 | 音频 {len(pcm) / BYTES_PER_SECOND:.3f} 秒 | {credentials}', flush=True)
        resource_id = 'volc.seedasr.sauc.' + args.billing
        if vad_enabled:
            from vad import SileroOnnx, run_vad
            detector = SileroOnnx()

            async def recognize_turn(source, turn_id):
                return await recognize(None, key, resource_id, audio_source=source, turn_id=turn_id)

            source = microphone_chunks(args.seconds, device) if args.mic else file_chunks(pcm)
            report = asyncio.run(run_vad(source, detector, None if args.vad_only else recognize_turn,
                total_seconds=args.seconds if args.mic else len(pcm) / BYTES_PER_SECOND,
                silence_ms=args.silence_ms, threshold=args.vad_threshold))
        else:
            report = asyncio.run(recognize(pcm, key, resource_id,
                                          mic_seconds=args.seconds if args.mic else None, device=device))
        if args.mic:
            report['input_device'] = info['name']
        encoded = json.dumps(report, ensure_ascii=False, indent=2)
        if key:
            encoded = encoded.replace(key, '[REDACTED]')
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            # Avoid overwriting an earlier run or any unrelated file.
            with args.output.open('x', encoding='utf-8') as output:
                output.write(encoded + '\n')
        print(encoded)
        return 0
    except KeyboardInterrupt:
        print('测试已停止（Ctrl+C 取消，未等待最终识别结果）。\n'
              '如需完整结果，请重新运行，说完后等待计时自动结束。', file=sys.stderr)
        return 130
    except Exception as error:
        detail = str(error) or type(error).__name__
        print('测试失败：' + safe_message(detail, key), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
