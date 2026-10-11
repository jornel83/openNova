#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["sounddevice==0.5.6"]
# ///
"""Stream Vivian from Studio through SSH; optionally select the retained Base clone profile."""
import argparse
from contextlib import nullcontext
import json
from pathlib import Path
import shutil
import time
import urllib.request
import wave

from pcm_tempo import tempo_output
from settings import load_settings

REVISION = '52f4770fd9726457eae3d3b6aa92047a25a10776'
BASE_REVISION = 'a6eb4f68e4b056f1215157bb696209bc82a6db48'
STUDIO_DATA = load_settings()['data_dir']
VIVIAN_INSTRUCT = '用温柔、自然、放松的日常聊天语气说话，语速适中，停顿自然，像在和身边熟悉的人交流。'


def vivian_payload(text):
    """The selected preset, shared by the probe and conversation player."""
    return {
        'input': text, 'lang_code': 'Chinese', 'stream': True, 'streaming_interval': 0.32,
        'response_format': 'pcm', 'max_tokens': 1200,
        'model': STUDIO_DATA + '/models/opennova/qwen3-tts-1.7b-customvoice-bf16/' + REVISION,
        'voice': 'Vivian', 'instruct': VIVIAN_INSTRUCT,
        'temperature': 0.9, 'top_p': 1.0, 'top_k': 50, 'repetition_penalty': 1.05,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default=load_settings()['url'])
    parser.add_argument('--text', default='你好，OpenNova 的本地语音合成已经启动。接下来，我们一起完成语音助手。')
    parser.add_argument('--voice-profile', choices=['vivian', 'base'], default='vivian',
                        help='Default: Vivian preset; base: retained reference-audio clone test')
    parser.add_argument('--reference', help='Base only: reference WAV path on Studio, with --reference-text')
    parser.add_argument('--reference-text', help='Base only: exact transcript of --reference')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--play', action='store_true', help='Play on this computer as PCM arrives')
    parser.add_argument('--speed', type=float, default=1.5,
                        help='Pitch-preserving output tempo, 0.5–2.0; default 1.5; 1 keeps original PCM')
    args = parser.parse_args()
    if not 0.5 <= args.speed <= 2.0:
        parser.error('Speed must be between 0.5 and 2.0.')
    if args.speed != 1.0 and not shutil.which('ffmpeg'):
        parser.error('FFmpeg is required on this playback computer; install it or use --speed 1.')
    has_reference = args.reference is not None or args.reference_text is not None
    if args.voice_profile != 'base' and has_reference:
        parser.error('Reference audio requires --voice-profile base; Vivian uses a preset voice.')
    if has_reference and not (args.reference and args.reference_text):
        parser.error('--reference and --reference-text must be provided together and non-empty.')
    if args.output.exists() or args.output.is_symlink() or args.output.with_suffix('.json').exists():
        parser.error('Output WAV or JSON exists; choose a new path.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'input': args.text,
        'lang_code': 'Chinese', 'stream': True, 'streaming_interval': 0.32,
        'response_format': 'pcm', 'max_tokens': 600,
    }
    if args.voice_profile == 'vivian':
        payload = vivian_payload(args.text)
    else:
        payload.update({
            'model': STUDIO_DATA + '/models/opennova/qwen3-tts-1.7b-base-bf16/' + BASE_REVISION,
            'ref_audio': args.reference or STUDIO_DATA + '/artifacts/opennova/voices/smoke-reference.wav',
            'ref_text': args.reference_text or '已改写，请看这一处变化。已保存，随身入口仍然待定。',
        })
    print('音色：Vivian | 温柔自然的聊天语气' if args.voice_profile == 'vivian'
          else '音色：Base 参考录音克隆', flush=True)
    print(f'输出语速：{args.speed:g} 倍（保持音调）', flush=True)
    request = urllib.request.Request(args.url.rstrip('/') + '/v1/audio/speech',
        data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    if args.play:
        import sounddevice as sd
        player = sd.RawOutputStream(samplerate=24000, channels=1, dtype='int16')
    else:
        player = nullcontext(None)
    # Avoid routing loopback requests through a system proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    started = time.monotonic()
    first_audio = None
    first_output = None
    source_bytes = 0
    raw = bytearray()
    with opener.open(request, timeout=120) as response, player as stream:
        if response.headers.get_content_type() != 'audio/pcm':
            raise RuntimeError('Expected PCM audio response.')
        pending = b''

        def consume(data):
            nonlocal first_output, pending
            if first_output is None:
                first_output = time.monotonic() - started
                print(f'首段可播放音频就绪：{first_output:.3f} 秒', flush=True)
            raw.extend(data)
            if stream is not None:
                pending += data
                even = len(pending) // 2 * 2
                if even:
                    underflow = stream.write(pending[:even])
                    if underflow:
                        print('播放出现缓冲不足；需继续调节预缓冲。', flush=True)
                    pending = pending[even:]

        with tempo_output(args.speed, consume) as write_pcm:
            while data := response.read(4096):
                if first_audio is None:
                    first_audio = time.monotonic() - started
                    print(f'首段音频到达 Air：{first_audio:.3f} 秒', flush=True)
                source_bytes += len(data)
                if source_bytes > 120 * 24000 * 2:
                    raise RuntimeError('Response exceeded the 120-second source audio limit.')
                write_pcm(data)
            if source_bytes % 2:
                raise RuntimeError('Incomplete source PCM response.')
    if not raw or len(raw) % 2 or not any(raw):
        raise RuntimeError('Empty, silent, or incomplete PCM response.')
    elapsed = time.monotonic() - started
    with args.output.open('xb') as output, wave.open(output, 'wb') as audio:
        audio.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
        audio.writeframes(raw)
    report = {'text': args.text, 'voice_profile': args.voice_profile, 'request': payload,
              'stream': True, 'sample_rate': 24000,
              'first_audio_seconds': round(first_audio, 3), 'total_seconds': round(elapsed, 3),
              'first_playable_audio_seconds': round(first_output, 3),
              'playback_speed': args.speed, 'source_audio_seconds': round(source_bytes / 48000, 3),
              'audio_seconds': round(len(raw) / 48000, 3), 'played': args.play,
              'note': '24kHz mono s16le; tempo adjusted on client. Ready time excludes speaker latency.'}
    with args.output.with_suffix('.json').open('x') as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
