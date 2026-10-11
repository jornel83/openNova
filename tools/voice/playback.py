"""Stream one bounded Vivian reply, preserving the selected pitch at 1.5× tempo."""
from contextlib import nullcontext
import json
from pathlib import Path
import signal
import sys
import time
import urllib.request
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/tts'))
from pcm_tempo import tempo_output
from probe_http import vivian_payload


def speak(text, *, url, speed=1.5, play=True, device=None, output=None):
    if not 0.5 <= speed <= 2.0:
        raise ValueError('无效语速。')
    if not isinstance(text, str) or not text.strip() or len(text) > 500:
        raise ValueError('单段回复必须为 1–500 字。')
    if output is not None:
        output = Path(output)
        if output.exists() or output.is_symlink():
            raise FileExistsError(output)
        output.parent.mkdir(parents=True, exist_ok=True)
    player = nullcontext(None)
    if play:
        import sounddevice as sd
        player = sd.RawOutputStream(samplerate=24000, channels=1, dtype='int16', device=device)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url.rstrip('/') + '/v1/audio/speech',
        data=json.dumps(vivian_payload(text)).encode(), headers={'Content-Type':'application/json'})
    started = time.monotonic()
    first_pcm = first_playable = None
    source_bytes = output_bytes = 0
    audible = False
    saved = bytearray() if output is not None else None
    pending = b''
    with player as stream, opener.open(request, timeout=120) as response:
        if response.headers.get_content_type() != 'audio/pcm':
            raise ValueError('TTS 没有返回 PCM 音频。')

        def consume(data):
            nonlocal first_playable, output_bytes, pending, audible
            if first_playable is None:
                first_playable = time.monotonic() - started
            output_bytes += len(data)
            audible = audible or any(data)
            if saved is not None:
                saved.extend(data)
            if stream is not None:
                pending += data
                even = len(pending) // 2 * 2
                if even:
                    stream.write(pending[:even])
                    pending = pending[even:]

        with tempo_output(speed, consume) as write_pcm:
            while data := response.read(4096):
                if first_pcm is None:
                    first_pcm = time.monotonic() - started
                source_bytes += len(data)
                if source_bytes > 120 * 48000:
                    raise ValueError('TTS 音频超过两分钟上限。')
                write_pcm(data)
            if source_bytes % 2:
                raise ValueError('TTS 音频不完整。')
    if not output_bytes or output_bytes % 2:
        raise ValueError('TTS 返回空音频或不完整音频。')
    if not audible:
        raise ValueError('TTS 返回全静音音频。')
    if output is not None:
        with output.open('xb') as file, wave.open(file, 'wb') as audio:
            audio.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
            audio.writeframes(saved)
    return {'voice':'Vivian', 'speed':speed, 'played':play,
        'audio_seconds':round(output_bytes/48000, 3),
        'first_pcm_seconds':round(first_pcm, 3),
        'first_playable_seconds':round(first_playable, 3),
        'total_seconds':round(time.monotonic()-started, 3)}


def main():
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        request = json.loads(sys.stdin.readline(20000))
        print(json.dumps({'type':'played', **speak(**request)}, ensure_ascii=False), flush=True)
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        print(json.dumps({'type':'error', 'code':type(error).__name__}), flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
