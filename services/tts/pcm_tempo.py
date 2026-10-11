"""Pitch-preserving tempo adjustment for a continuous 24kHz mono PCM stream."""
from contextlib import contextmanager
import shutil
import subprocess
import tempfile
from threading import Thread


@contextmanager
def tempo_output(speed, consume):
    """Yield a PCM writer; deliver adjusted PCM to consume before input EOF."""
    if not 0.5 <= speed <= 2.0:
        raise ValueError('Speed must be between 0.5 and 2.0.')
    if speed == 1.0:
        yield consume
        return
    executable = shutil.which('ffmpeg')
    if not executable:
        raise RuntimeError('FFmpeg is required for tempo adjustment; use --speed 1 to bypass.')

    # One filter for the entire response preserves continuity across network chunks.
    command = [executable, '-hide_banner', '-loglevel', 'error', '-nostdin',
               '-f', 's16le', '-ar', '24000', '-ac', '1',
               '-probesize', '32', '-analyzeduration', '0', '-i', 'pipe:0',
               '-af', f'atempo={speed}', '-f', 's16le', '-c:a', 'pcm_s16le',
               '-ar', '24000', '-ac', '1', '-flush_packets', '1', 'pipe:1']
    errors = []
    with tempfile.TemporaryFile() as diagnostics:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=diagnostics)

        def drain():
            try:
                while data := process.stdout.read1(4096):
                    consume(data)
            except Exception as error:
                errors.append(error)
                if process.poll() is None:
                    process.terminate()

        def write(data):
            if errors:
                raise errors[0]
            process.stdin.write(data)
            process.stdin.flush()

        reader = Thread(target=drain, name='tts-tempo-output', daemon=True)
        reader.start()
        try:
            yield write
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
            reader.join(timeout=5)
            if reader.is_alive():
                raise RuntimeError('Timed out draining tempo-adjusted audio.')
            return_code = process.wait(timeout=5)
            if errors:
                raise errors[0]
            if return_code:
                diagnostics.seek(0)
                detail = diagnostics.read(2000).decode(errors='replace').strip()
                raise RuntimeError(f'FFmpeg tempo adjustment failed ({return_code}): {detail}')
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
            reader.join(timeout=2)
            process.stdout.close()
