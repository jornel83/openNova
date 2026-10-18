#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets==15.0.1", "python-socks[asyncio]==3.1.1", "sounddevice==0.5.6", "numpy==2.2.6", "onnxruntime==1.23.2"]
# ///
"""OpenNova demo: local VAD → Doubao ASR → Agent → Studio / Doubao TTS."""
import argparse
import asyncio
import json
from pathlib import Path
import re
import shutil
import sys
import time
import urllib.request

from capture import capture_turn
from agent import Agent, ROOT, stop_process
from doubao_asr import recognize, load_pcm, file_chunks, microphone_chunks, load_key, safe_message
from vad import SileroOnnx

sys.path.insert(0, str(ROOT / 'services/tts'))
from settings import load_settings, normalize_provider, default_speed


def tts_options(args):
    provider = normalize_provider(getattr(args, 'tts_provider', 'studio'))
    voice = getattr(args, 'tts_voice', None) or load_settings(validate_provider=False)['doubao_voice']
    return provider, voice if provider == 'doubao' else 'Vivian'


def speech_segments(text):
    """Short complete sentences keep TTS bounded; never drop the reply's tail."""
    if not text.strip() or len(text) > 6000:
        raise ValueError('回复为空或超过当前语音 Demo 的 6000 字限制。')
    parts = []
    for sentence in re.findall(r'[^。！？；\n]+[。！？；\n]*|[。！？；\n]+', text):
        while sentence:
            piece, sentence = sentence[:160], sentence[160:]
            if piece.strip():
                parts.append(piece)
    return parts


async def respond(asr, agent, play):
    if not asr.get('success') or not asr.get('text', '').strip():
        raise ValueError('只允许提交成功的最终转写。')
    print('你：' + asr['text'], flush=True)
    print('状态：正在思考（麦克风已关闭）', flush=True)
    started = time.monotonic()
    reply = await agent.ask(asr['text'])
    print('OpenNova：' + reply['text'], flush=True)
    print('状态：正在播报', flush=True)
    playback = []
    for index, text in enumerate(speech_segments(reply['text']), 1):
        playback.append(await play(text, index))
    return {'asr':asr, 'agent':reply, 'tts':playback,
            'reply_and_playback_seconds':round(time.monotonic()-started, 3)}


async def play_segment(text, index, *, args, turn):
    provider, voice = tts_options(args)
    path = args.output_dir / f'turn-{turn:02d}-reply-{index:02d}.wav' if args.output_dir else None
    process = await asyncio.create_subprocess_exec(sys.executable, str(Path(__file__).with_name('playback.py')),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, start_new_session=True)
    request = {'text':text, 'url':args.tts_url, 'speed':default_speed(provider), 'play':not args.no_play,
               'device':args.output_device, 'output':str(path) if path else None,
               'provider':provider, 'voice':voice}
    try:
        output, _ = await asyncio.wait_for(process.communicate(json.dumps(request).encode()+b'\n'), 180)
        result = json.loads(output)
        if process.returncode or result.get('type') != 'played':
            message = result.get('message') if result.get('code') == 'DoubaoTTSError' else None
            raise ValueError((message or 'TTS 播放失败') + '；文字回复已保留在终端。')
        return result
    finally:
        await stop_process(process)


def preflight(args):
    provider, voice = tts_options(args)
    if default_speed(provider) != 1 and not shutil.which('ffmpeg'):
        raise ValueError('需要 FFmpeg 提供 1.5 倍保调速率。')
    if provider == 'doubao':
        from doubao import load_tts_key
        load_tts_key()
    else:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(args.tts_url.rstrip('/')+'/v1/models', timeout=5) as response:
            json.load(response)
    if not args.audio and not getattr(args, 'continuous', False):
        import sounddevice as sd
        sd.check_input_settings(device=args.device, channels=1, dtype='int16', samplerate=16000)
    if not args.no_play and not getattr(args, 'continuous', False):
        import sounddevice as sd
        sd.check_output_settings(device=args.output_device, channels=1, dtype='int16', samplerate=24000)


async def check_cloud_tts(args):
    provider, voice = tts_options(args)
    if provider == 'doubao':
        from tts_stream import synthesize
        print('豆包 TTS：短句合成预检（少量计费用量，不播放）……', flush=True)
        # Use the same cancellable process as replies; to_thread would leave a
        # blocked HTTP connection alive and delay Ctrl+C during startup.
        async for _ in synthesize('你好。', args.tts_url, speed=1, provider=provider, voice=voice):
            pass


async def run(args, key):
    provider, voice = tts_options(args)
    agent = Agent()
    report = {'mode':'file' if args.audio else 'microphone', 'model':'gpt-6.1-sol',
              'harness':'DeepSeek Harness', 'tts_provider':provider, 'voice':voice, 'speed':default_speed(provider),
              'turn_taking':True, 'turns':[], 'success':False}
    try:
        print(f'正在检查 Agent、订阅授权与 TTS（{provider} / {voice}）……', flush=True)
        await asyncio.to_thread(preflight, args)
        await check_cloud_tts(args)
        await agent.start()
        if args.check:
            SileroOnnx()
            print('检查通过：VAD、ASR 密钥、Harness/GPT-6.1 Sol 授权、TTS 服务均已就绪；未开启麦克风。', flush=True)
            return
        attempts = len(args.audio) if args.audio else args.turns
        for turn in range(1, attempts+1):
            if args.audio:
                source = file_chunks(load_pcm(args.audio[turn-1]))
                print(f'第 {turn} 轮：读取测试音频（未开启麦克风）', flush=True)
            else:
                source = microphone_chunks(args.listen_seconds, args.device)
                print(f'第 {turn} 轮：请说话，停顿 {args.silence_ms} ms 后自动提交；Ctrl+C 退出。', flush=True)
            detector = SileroOnnx()
            async def asr(audio):
                return await recognize(None, key, 'volc.seedasr.sauc.duration', audio_source=audio,
                                       audio_seconds_limit=48, turn_id=turn)
            transcript = await capture_turn(source, detector, asr, silence_ms=args.silence_ms)
            if transcript is None:
                print('这一轮没有检测到人声。', flush=True)
                continue
            async def play(text, index):
                return await play_segment(text, index, args=args, turn=turn)
            result = await respond(transcript, agent, play)
            report['turns'].append(result)
            if args.output_dir:
                (args.output_dir / 'conversation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            if not args.audio and not args.no_play:
                # The demo has no acoustic echo cancellation. Let the room/speaker tail settle.
                await asyncio.sleep(0.6)
        report['success'] = bool(report['turns'])
        print(f'对话结束，已完成 {len(report["turns"])} 轮。', flush=True)
    finally:
        await agent.close()
        if args.output_dir:
            (args.output_dir / 'conversation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))


def main():
    tts = load_settings(validate_provider=False)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', help='输入设备名称，例如 SRS-XB100 或 MacBook Air麦克风；默认系统输入')
    parser.add_argument('--output-device', help='Air 播放设备；默认系统输出')
    parser.add_argument('--list-devices', action='store_true', help='列出可用输入、输出设备，不打开麦克风')
    parser.add_argument('--turns', type=int, default=20)
    parser.add_argument('--listen-seconds', type=float, default=60)
    parser.add_argument('--silence-ms', type=int, default=800)
    parser.add_argument('--continuous', action='store_true', help='持续收音、增量播报与插话；用 --device / --output-device 选择设备')
    parser.add_argument('--web', action='store_true', help='持续模式中启用联网检索，完整答案就绪后播报')
    parser.add_argument('--bot', action='store_true', help='连接独立运行的 DeepSeek-Bot 实验服务，共享持久会话')
    parser.add_argument('--extended-silence-ms', type=int, default=1600, help='连续模式下未完句的最长停顿等待')
    parser.add_argument('--tts-url', default=tts['url'], help='Studio TTS 地址；豆包模式不使用')
    parser.add_argument('--tts-provider', choices=['studio','doubao','cloud'], default=tts['provider'], help='cloud 为 doubao 的别名')
    parser.add_argument('--tts-voice', default=tts['doubao_voice'], help='豆包语音合成 2.0 Speaker ID；Studio 固定 Vivian')
    parser.add_argument('--audio', type=Path, action='append', help='测试文件，一次一个自然发言；可重复提供多轮')
    parser.add_argument('--no-play', action='store_true', help='合成但不播放，用于自动验证')
    parser.add_argument('--output-dir', type=Path, help='显式保存回复音频和对话记录到一个新目录')
    parser.add_argument('--check', action='store_true', help='检查依赖和授权，不打开麦克风')
    args = parser.parse_args()
    args.tts_provider = normalize_provider(args.tts_provider)
    if args.bot and (not args.continuous or args.web):
        parser.error('--bot 需要 --continuous，当前实验不与 --web 同时使用。')
    if args.web and not args.continuous:
        parser.error('--web 需要 --continuous；普通轮流对话模式不启用联网工具。')
    if not 1 <= args.turns <= 100 or not 1 <= args.listen_seconds <= 600 or not 200 <= args.silence_ms <= 3000:
        parser.error('轮数 1–100、聆听上限 1–600 秒、静音阈值 200–3000 ms。')
    if args.continuous and not args.silence_ms <= args.extended_silence_ms <= 3000:
        parser.error('延长停顿必须不小于普通停顿，且不超过 3000 ms。')
    key = ''
    try:
        if args.list_devices:
            from audio_bridge import check_native
            info = asyncio.run(check_native(list_devices=True))
            for device in info['devices']:
                directions = []
                if device['input_channels']:
                    directions.append('输入' + ('（默认）' if device['id'] == info['default_input'] else ''))
                if device['output_channels']:
                    directions.append('输出' + ('（默认）' if device['id'] == info['default_output'] else ''))
                if directions: print(f"{device['name']} | {' / '.join(directions)}")
            return
        key = load_key()
        if args.output_dir:
            args.output_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
        if args.continuous:
            from continuous_run import run as run_continuous
            asyncio.run(run_continuous(args, key))
        else:
            asyncio.run(run(args, key))
    except KeyboardInterrupt:
        print('\n对话已停止，麦克风和播放已关闭。', flush=True)
    except Exception as error:
        print('对话失败：' + safe_message(error, key), file=sys.stderr, flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
