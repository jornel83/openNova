"""Build a bounded PNG contact sheet from actual GIF frames; never call a model."""
from base64 import b64encode
from hashlib import sha256
from io import BytesIO
import json
import sys
import warnings

from PIL import Image, ImageDraw

MAX_INPUT = 20 * 1024 * 1024
MAX_PIXELS = 64_000_000
MAX_FRAMES = 512
MAX_SAMPLES = 9


def contact_sheet(data: bytes) -> dict:
    if not 0 < len(data) <= MAX_INPUT:
        raise ValueError('gif_review_invalid_input')
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(BytesIO(data), formats=('GIF',)) as source:
            # Index the sequence with a bounded seek loop, even for a hostile file
            # whose n_frames property would traverse arbitrarily many tiny frames.
            width, height = source.size
            pixels = width * height
            if pixels < 1 or pixels > MAX_PIXELS:
                raise ValueError('gif_review_limit_exceeded')
            limit = min(MAX_FRAMES, MAX_PIXELS // pixels)
            durations = []
            for index in range(limit + 1):
                try:
                    source.seek(index)
                except EOFError:
                    break
                if index >= limit or source.size != (width, height):
                    raise ValueError('gif_review_limit_exceeded')
                durations.append(int(source.info.get('duration', 0)))
            count = len(durations)
            if count < 2:
                raise ValueError('gif_review_animation_required')
            samples = min(count, MAX_SAMPLES)
            indices = [i * (count - 1) // (samples - 1) for i in range(samples)]
            columns = min(samples, 3)
            rows = (samples + columns - 1) // columns
            w, h = 320, 264
            sheet = Image.new('RGB', (columns * w, rows * h), '#e8edf4')
            draw = ImageDraw.Draw(sheet)
            for offset, index in enumerate(indices):
                source.seek(index)
                frame = source.convert('RGBA')
                frame.thumbnail((w - 14, h - 30), Image.Resampling.LANCZOS)
                x, y = offset % columns * w, offset // columns * h
                draw.rectangle((x + 3, y + 3, x + w - 4, y + h - 4), fill='#f5f7fa')
                sheet.paste(frame, (x + (w - frame.width) // 2, y + 4 + (h - 28 - frame.height) // 2), frame)
                draw.text((x + 10, y + h - 19), f'Frame {index}  |  {sum(durations[:index])} ms', fill='#263345')
            png = BytesIO()
            sheet.save(png, 'PNG')
            return {'sha256': sha256(data).hexdigest(), 'frames': count, 'indices': indices,
                    'timestampsMs': [sum(durations[:i]) for i in indices],
                    'png': b64encode(png.getvalue()).decode('ascii')}


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'sample': contact_sheet(sys.stdin.buffer.read(MAX_INPUT + 1))}, separators=(',', ':')))
    except (OSError, ValueError, Image.DecompressionBombWarning, Image.DecompressionBombError, OverflowError) as error:
        safe = {'gif_review_invalid_input', 'gif_review_animation_required', 'gif_review_limit_exceeded'}
        print(json.dumps({'ok': False, 'error': str(error) if str(error) in safe else 'gif_review_invalid_animation'}))
        sys.exit(1)
