"""Generate the separate 48-second waterdrop scene's Mandarin dialogue locally.

The shared helper supplies serial macOS `say` synthesis, a 20-second timeout,
conservative AIFF recovery, normalization, and full decoded-audio validation.
Original scene audio and its script remain untouched.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

# Loading shared helpers must not create files beside the original script.
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts/make-voiceover.py'
spec = importlib.util.spec_from_file_location('scene_one_voiceover_helpers', HELPER)
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
helpers.TMP = ROOT / 'tmp/waterdrop'
helpers.AUDIO = ROOT / 'public/waterdrop/audio'

USER_VOICE = 'Reed (中文（中国大陆）)'
NOVA_VOICE = 'Tingting'
LINES = [
    ('01-user', USER_VOICE, '我们继续昨天的方案。', 185, 1.0, 3.3),
    ('02-nova', NOVA_VOICE, '好，我们接着看这一段。', 180, 4.5, 3.0),
    ('03-user', USER_VOICE, '这段太抽象，改成一个真实的使用场景。', 185, 8.6, 4.7),
    ('04-nova', NOVA_VOICE, '可以。把用户何时开口、助手如何接续，写清楚。', 180, 14.0, 5.0),
    ('05-user', USER_VOICE, '水滴是主方案，圆环保留为备选。', 185, 20.5, 3.6),
    ('06-nova', NOVA_VOICE, '记住了。水滴主方案，圆环作备选。', 180, 24.4, 3.3),
    ('07-user', USER_VOICE, '打开视觉，我们看看这个连接位置。', 185, 28.8, 4.1),
    ('08-nova', NOVA_VOICE, '我看到这处连接了。先把链条的走向标出来。', 180, 33.6, 4.8),
    ('09-user', USER_VOICE, '好，先关掉视觉。', 185, 39.2, 2.5),
    ('10-nova', NOVA_VOICE, '已关闭视觉，我们可以继续讨论。', 180, 43.0, 4.0),
]


def main():
    original_helper_hash = hashlib.sha256(HELPER.read_bytes()).hexdigest()
    helpers.TMP.mkdir(parents=True, exist_ok=True)
    helpers.AUDIO.mkdir(parents=True, exist_ok=True)
    result = []
    # Keep speech-service sessions serial. Only time compression is used when a
    # line exceeds its slot; there is no truncation or content removal.
    for row in LINES:
        item = helpers.make(row)
        item['slot'] = row[-1]
        item['rate'] = row[3]
        item['start_frame'] = round(item['start'] * 30)
        item['source_duration'] = helpers.duration(helpers.recover_aiff(
            helpers.TMP / f'{row[0]}.aiff')[0])
        stats = helpers.inspect_audio(helpers.AUDIO / item['file'])
        item['trailing_silence'] = round(stats['trailing_silence'], 6)
        if item['speed'] > 1.2:
            raise RuntimeError(f'{item["file"]} needs excessive speed-up: {item["speed"]}')
        if item['end'] > 48:
            raise RuntimeError(f'{item["file"]} exceeds the 48-second scene')
        if result and result[-1]['end'] > item['start']:
            raise RuntimeError(f'{item["file"]} overlaps its preceding line')
        result.append(item)
    if hashlib.sha256(HELPER.read_bytes()).hexdigest() != original_helper_hash:
        raise RuntimeError('The original voiceover script changed during generation')
    (helpers.AUDIO / 'voiceover.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Validated {len(result)} dialogue files; final line ends at {result[-1]["end"]:.3f}s.')


if __name__ == '__main__':
    main()
