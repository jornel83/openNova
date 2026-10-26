"""Stream one bounded Studio or cloud reply with pitch-preserving tempo."""
from contextlib import contextmanager, nullcontext
import json
from pathlib import Path
import signal
import sys
import time
import urllib.request
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/tts'))
from pcm_tempo import tempo_output
from doubao import stream_pcm, DEFAULT_VOICE, DoubaoTTSError
from settings import normalize_provider, default_speed


@contextmanager
def studio_pcm(text, url):
    from probe_http import vivian_payload
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url.rstrip('/') + '/v1/audio/speech',
        data=json.dumps(vivian_payload(text)).encode(), headers={'Content-Type':'application/json'})
    with opener.open(request, timeout=120) as response:
        if response.headers.get_content_type() != 'audio/pcm':
            raise ValueError('TTS 没有返回 PCM 音频。')
        yield iter(lambda: response.read(4096), b'')


def speak(text, *, url, speed=None, play=True, device=None, output=None, sink=None, provider='studio', voice=None):
    provider = normalize_provider(provider)
    speed = default_speed(provider) if speed is None else speed
    voice = (voice or DEFAULT_VOICE) if provider == 'doubao' else 'Vivian'
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
    source = stream_pcm(text, voice) if provider == 'doubao' else studio_pcm(text, url)
    started = time.monotonic()
    first_pcm = first_playable = None
    source_bytes = output_bytes = 0
    audible = False
    saved = bytearray() if output is not None else None
    pending = b''
    with player as stream, source as chunks:
        def consume(data):
            nonlocal first_playable, output_bytes, pending, audible
            if first_playable is None:
                first_playable = time.monotonic() - started
            output_bytes += len(data)
            audible = audible or any(data)
            if saved is not None:
                saved.extend(data)
            if sink is not None:
                sink(data)
            if stream is not None:
                pending += data
                even = len(pending) // 2 * 2
                if even:
                    stream.write(pending[:even])
                    pending = pending[even:]

        # Continuous playback applies backpressure while paused. The parent owns
        # cancellation/deadlines; a five-second EOF drain is not a synthesis failure.
        with tempo_output(speed, consume, drain_timeout=None if sink is not None else 5) as write_pcm:
            for data in chunks:
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
    return {'provider':provider, 'voice':voice, 'speed':speed, 'played':play,
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
        raw='--pcm' in sys.argv
        if raw:
            request['play']=False
            request['sink']=lambda data: (sys.stdout.buffer.write(data),sys.stdout.buffer.flush())
        print(json.dumps({'type':'played', **speak(**request)}, ensure_ascii=False),
              file=sys.stderr if raw else sys.stdout, flush=True)
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        print(json.dumps({'type':'error', 'code':type(error).__name__,
                         'message':str(error) if isinstance(error, DoubaoTTSError) else '语音合成失败。'}, ensure_ascii=False),
              file=sys.stderr if '--pcm' in sys.argv else sys.stdout, flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
