"""The seven-shot, 13.5-second portrait edit and its optional editorial badge."""
import math
from pathlib import Path


SOURCES = ('template', 'before', 'after', 'wrap', 'tape', 'card')
# Source lengths at 30 fps include frames used for dissolves.
LENGTHS = {'before': 71, 'after': 76, 'wrap': 59, 'tape': 53}


def prepare(timeline, directory, probe):
    if not isinstance(timeline, dict) or set(timeline) - {*SOURCES, 'source_in_frames'}:
        raise ValueError('Unsupported aesthetic_timeline configuration.')
    starts = timeline.get('source_in_frames', {})
    if (not isinstance(starts, dict) or set(starts) - LENGTHS.keys()
            or any(type(frame) is not int or frame < 0 for frame in starts.values())):
        raise ValueError('source_in_frames requires nonnegative 30 fps frame indices.')
    starts = {name: starts.get(name, 0) for name in LENGTHS}
    paths = {}
    for name in SOURCES:
        filename = timeline.get(name)
        if not isinstance(filename, str) or not filename.strip():
            raise ValueError(f'aesthetic_timeline.{name} requires a local file.')
        path = (directory / filename).resolve()
        if not path.is_file():
            raise ValueError(f'Missing {name}: {path}')
        paths[name] = str(path)
        if name == 'card':
            if path.suffix.lower() not in ('.png', '.jpg', '.jpeg'):
                raise ValueError('card must be a PNG or JPEG still image.')
            probe(path, still=True)
            continue
        info = probe(path)
        needed = 405 if name == 'template' else starts[name] + LENGTHS[name]
        if math.floor(info['duration'] * 30 + 0.5) < needed:
            raise ValueError(f'{name} must cover {needed} frames at 30 fps for this edit.')
        if name == 'template':
            has_audio = info['has_audio']
    return {**paths, 'source_in_frames': starts, 'template_has_audio': has_audio}


def subtitles(plan):
    """Keep every shot caption, adding the badge text and backing only on request."""
    text = Path(__file__).with_name('aesthetic_timeline.ass').read_text(encoding='utf-8')
    if 'aesthetic_timeline' not in plan:
        text = text[:text.index('Dialogue:')]
        scale = 720 / min(plan['width'], plan['height'])
        text = text.replace('PlayResX: 720', f'PlayResX: {round(plan["width"] * scale)}')
        text = text.replace('PlayResY: 1280', f'PlayResY: {round(plan["height"] * scale)}')
    if plan.get('show_ai_badge', False):
        cent = math.ceil(plan['duration'] * 100)
        end = f'{cent // 360000}:{cent // 6000 % 60:02}:{cent // 100 % 60:02}.{cent % 100:02}'
        text += (f'Dialogue: 0,0:00:00.00,{end},Graphics,,0,0,0,,'
                 r'{\an7\pos(0,0)\p1\bord0\shad0\1c&H181918&\1a&H5A&}'
                 'm 32 35 l 188 35 188 78 32 78\n'
                 f'Dialogue: 2,0:00:00.00,{end},Mark,,0,0,0,,'
                 r'{\an7\pos(43,40)}AI 角色演示' '\n')
    return text


def command(plan, ffmpeg, destination):
    timeline = plan['aesthetic_timeline']
    starts = timeline['source_in_frames']
    args = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
            '-filter_complex_threads', '4']
    for name in SOURCES:
        if name == 'card':
            args += ['-f', 'image2', '-pattern_type', 'none', '-loop', '1', '-framerate', '30', '-t', '1.7']
        args += ['-i', timeline[name]]
    times = 'settb=1/30,setpts=N'
    cover = ('scale=720:1280:force_original_aspect_ratio=increase:flags=lanczos:'
             'out_color_matrix=bt709,crop=720:1280,setsar=1,format=yuv420p')

    def clip(source, start, length, target):
        return (f'[{source}]fps=30,trim=start_frame={start}:end_frame={start+length},'
                f'{times},{cover},fps=30[{target}]')

    graph = [
        '[0:v]split=2[template_open][template_proc]',
        '[4:v]split=2[tape_open][tape_full]',
        clip('template_open', 0, 51, 'open_full'),
        '[open_full]crop=720:544:0:736[lower]',
        clip('tape_open', 0, 51, 'open_portrait'),
        '[open_portrait]crop=720:736:0:92[upper]',
        '[upper][lower]vstack,drawbox=x=0:y=734:w=720:h=3:color=0x242827@0.8:t=fill[intro]',
        clip('1:v', starts['before'], LENGTHS['before'], 'before'),
        clip('template_proc', 122, 57, 'procedure'),
        clip('3:v', starts['wrap'], LENGTHS['wrap'], 'wrap'),
        clip('tape_full', starts['tape'], LENGTHS['tape'], 'tape'),
        clip('2:v', starts['after'], LENGTHS['after'], 'after'),
        '[wrap][tape]xfade=transition=fade:duration=0.133333:offset=1.833333,'
        'fps=30,settb=1/30[recovery]',
        '[recovery][after]xfade=transition=fade:duration=0.166667:offset=3.433333,'
        f'trim=end_frame=179,format=yuv420p,{times}[reveal]',
        clip('5:v', 0, 47, 'card'),
        '[intro][before][procedure][reveal][card]concat=n=5:v=1:a=0,fps=30,'
        'ass=filename=overlay.ass,format=yuv420p[v]',
    ]
    audio = '[0:a]' if timeline['template_has_audio'] else 'anullsrc=r=48000:cl=stereo,'
    graph.append(audio + 'atrim=start=0:end=13.5,asetpts=PTS-STARTPTS,volume=-3.3dB,'
                 'afade=t=in:st=0:d=0.025,afade=t=out:st=13.33:d=0.17,aresample=48000,'
                 'alimiter=limit=0.85:level=0:latency=1,apad,atrim=end=13.5[a]')
    return args + ['-filter_complex', ';'.join(graph), '-map', '[v]', '-map', '[a]',
                   '-t', '13.5', '-c:v', 'libx264', '-preset', 'medium', '-crf', str(plan['crf']),
                   '-r', '30', '-video_track_timescale', '30000', '-color_primaries', 'bt709',
                   '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-b:a', '192k',
                   '-movflags', '+faststart', str(destination)]
