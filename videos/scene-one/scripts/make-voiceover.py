"""Create local Mandarin voiceover, including recovery of unclosed `say` AIFFs.

macOS `say` can finish writing PCM but hang before finalizing its AIFF header in
headless sessions. Keep the original for diagnosis, repair only supported PCM
containers, and reject a timed-out recording without a quiet ending.
"""
from array import array
import json
import math
from pathlib import Path
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
TMP = ROOT / 'tmp'
AUDIO = ROOT / 'public/audio'
LINES = [
    ('01-user', 'Reed (中文（中国大陆）)', '这份资料，我们一起改。', 195, 0.87, 4.0),
    ('02-user', 'Reed (中文（中国大陆）)', '这句太抽象，换成一个真实场景。', 195, 4.7, 4.0),
    ('03-nova', 'Tingting', '已改写，请看这一处变化。', 190, 9.87, 4.0),
    ('04-user', 'Reed (中文（中国大陆）)', '保留桌面方案，随身入口待定。', 195, 15.53, 4.0),
    ('05-nova', 'Tingting', '已保存，随身入口仍然待定。', 190, 20.53, 3.3),
]


def run(args):
    return subprocess.run(args, check=True, capture_output=True, timeout=30)


def duration(path):
    value = float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                       '-of', 'default=noprint_wrappers=1:nokey=1', str(path)]).stdout)
    if not math.isfinite(value) or value <= 0:
        raise RuntimeError(f'Invalid audio duration: {path}')
    return value


def inspect_audio(path):
    pcm = run(['ffmpeg', '-v', 'error', '-i', str(path), '-ar', '48000', '-ac', '1',
               '-f', 's16le', '-']).stdout
    samples = array('h', pcm)
    if sys.byteorder != 'little':
        samples.byteswap()
    if not samples:
        raise RuntimeError(f'No decoded audio: {path}')
    rms = math.sqrt(sum(x * x for x in samples) / len(samples))
    peak = max(abs(x) for x in samples)
    rms_db = 20 * math.log10(max(rms, 1) / 32768)
    peak_db = 20 * math.log10(max(peak, 1) / 32768)
    if rms_db < -45 or peak < 100:
        raise RuntimeError(f'Audio is silent or unusably quiet: {path}, {rms_db:.2f} dBFS')
    # `say` normally writes about 0.45 s of silence after the last syllable.
    quiet_tail = 0
    for sample in reversed(samples):
        if abs(sample) > 104:  # -50 dBFS
            break
        quiet_tail += 1
    return dict(rms_dbfs=round(rms_db, 2), peak_dbfs=round(peak_db, 2),
                trailing_silence=quiet_tail / 48000)


def recover_aiff(raw):
    data = bytearray(raw.read_bytes())
    if len(data) < 12 or data[:4] != b'FORM' or data[8:12] not in (b'AIFF', b'AIFC'):
        raise RuntimeError(f'Unsupported AIFF container: {raw}')
    position, comm = 12, None
    while position + 8 <= len(data):
        chunk = data[position:position + 4]
        size = struct.unpack_from('>I', data, position + 4)[0]
        if chunk == b'COMM':
            comm = position + 8
        if chunk == b'SSND':
            if comm is None or size < 8:
                raise RuntimeError(f'Malformed AIFF chunks: {raw}')
            channels, frames, bits = struct.unpack_from('>HIH', data, comm)
            codec = data[comm + 18:comm + 22] if data[8:12] == b'AIFC' else b'NONE'
            if bits != 16 or channels != 1 or codec not in (b'twos', b'NONE'):
                raise RuntimeError(f'Unsupported recovery PCM format: {raw}')
            offset, block_size = struct.unpack_from('>II', data, position + 8)
            audio_start = position + 16 + offset
            if frames and size > 8:
                return raw, False
            if frames != 0 or size != 8 or offset or block_size:
                raise RuntimeError(f'Unexpected incomplete AIFF header: {raw}')
            pcm_bytes = len(data) - audio_start
            if pcm_bytes <= 0 or pcm_bytes % (channels * bits // 8):
                raise RuntimeError(f'Incomplete PCM frame: {raw}')
            struct.pack_into('>I', data, 4, len(data) - 8)
            struct.pack_into('>I', data, comm + 2, pcm_bytes // (channels * bits // 8))
            struct.pack_into('>I', data, position + 4, len(data) - position - 8)
            repaired = raw.with_name(raw.stem + '.repaired.aiff')
            repaired.write_bytes(data)
            stats = inspect_audio(repaired)
            if stats['trailing_silence'] < 0.15:
                raise RuntimeError(f'Unclosed recording may be truncated: {raw}')
            return repaired, True
        position += 8 + size + (size & 1)
    raise RuntimeError(f'No PCM chunk: {raw}')


def make(row):
    name, voice, words, rate, start, limit = row
    raw = TMP / f'{name}.aiff'
    dest = AUDIO / f'{name}.mp3'
    if not raw.exists():
        process = subprocess.Popen(['say', '-v', voice, '-r', str(rate), '-o', str(raw), words])
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        if process.returncode not in (0, -15, -9):
            raise RuntimeError(f'say failed for {name}: exit {process.returncode}')
    if not raw.exists() or raw.stat().st_size < 1000:
        raise RuntimeError(f'No speech generated for {name}')
    source, recovered = recover_aiff(raw)
    inspect_audio(source)
    raw_duration = duration(source)
    speed = max(1.0, raw_duration / (limit - 0.1))
    filters = f'atempo={speed:.6f},loudnorm=I=-18:TP=-2:LRA=9'
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(source), '-af', filters,
         '-ar', '48000', '-ac', '1', '-b:a', '192k', str(dest)])
    seconds = duration(dest)
    stats = inspect_audio(dest)
    if seconds > limit:
        raise RuntimeError(f'{name} exceeds {limit}s: {seconds}s')
    result = dict(file=dest.name, text=words, voice=voice, duration=seconds,
                  start=start, end=round(start + seconds, 6), speed=round(speed, 6),
                  recovered_aiff=recovered, rms_dbfs=stats['rms_dbfs'],
                  peak_dbfs=stats['peak_dbfs'])
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def main():
    TMP.mkdir(exist_ok=True)
    AUDIO.mkdir(parents=True, exist_ok=True)
    # Serial `say` calls avoid simultaneous speech service sessions.
    result = [make(row) for row in LINES]
    (AUDIO / 'voiceover.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
