"""Bounded local MP4/MOV sampling, followed by the existing GIF encoder.

Only the file protocol and MOV/MP4 demuxer are enabled. External MOV references
are explicitly disabled. No network, audio copying, publication or provider I/O.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_FLOOR
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import time

from tools.image.export import MediaExportError


MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_FRAMES = 256
MAX_PIXELS = 64_000_000
MAX_EDGE = 4096
PROBE_TIMEOUT_SECONDS = 10
DECODE_TIMEOUT_SECONDS = 60
PROCESS_OUTPUT_BYTES = 256 * 1024
FPS_VALUES = (5, 10, 20, 25)
_LOCAL_INPUT_OPTIONS = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov',
                        '-enable_drefs', '0', '-use_absolute_path', '0']


def _cancel(check):
    if check is not None and check():
        raise MediaExportError('cancelled')


def _integer(value, field, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise MediaExportError('invalid_spec', {'field': field})
    return value


def _stop(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except OSError:
        return
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            # Do not replace the original sanitized cancellation/timeout error
            # with an exception containing the local process command and paths.
            pass


def _run(command, *, timeout, code, cancel_check=None):
    """Poll cancellation and bounded log files without unbounded PIPE buffers."""
    _cancel(cancel_check)
    process = None
    try:
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                       start_new_session=True, shell=False)
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                _cancel(cancel_check)
                if time.monotonic() >= deadline:
                    raise MediaExportError('video_process_timeout', {'stage': code})
                if any(os.fstat(stream.fileno()).st_size > PROCESS_OUTPUT_BYTES for stream in (stdout, stderr)):
                    raise MediaExportError('video_process_output_limit', {'stage': code})
                time.sleep(0.02)
            _cancel(cancel_check)
            if any(os.fstat(stream.fileno()).st_size > PROCESS_OUTPUT_BYTES for stream in (stdout, stderr)):
                raise MediaExportError('video_process_output_limit', {'stage': code})
            if process.returncode != 0:
                raise MediaExportError(code)
            stdout.seek(0)
            return stdout.read(PROCESS_OUTPUT_BYTES + 1)
    except MediaExportError:
        raise
    except (OSError, ValueError, subprocess.SubprocessError):
        raise MediaExportError(code) from None
    finally:
        if process is not None:
            _stop(process)


def _decimal(value, code='video_invalid_metadata'):
    try:
        number = Decimal(str(value))
        if not number.is_finite() or number < 0:
            raise InvalidOperation()
        return number
    except (InvalidOperation, ValueError, TypeError):
        raise MediaExportError(code) from None


def _probe(ffprobe, source, cancel_check):
    command = [ffprobe, '-v', 'error', '-hide_banner', *_LOCAL_INPUT_OPTIONS,
               '-probesize', str(MAX_INPUT_BYTES), '-analyzeduration', '5000000',
               '-select_streams', 'v:0', '-show_entries',
               'format=format_name,duration:stream=index,codec_type,width,height,duration,sample_aspect_ratio:'
               'stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation',
               '-of', 'json', str(source)]
    try:
        metadata = json.loads(_run(command, timeout=PROBE_TIMEOUT_SECONDS, code='video_probe_failed',
                                   cancel_check=cancel_check))
        if not isinstance(metadata, dict) or 'mov' not in metadata.get('format', {}).get('format_name', '').split(','):
            raise MediaExportError('video_format_mismatch')
        streams = metadata.get('streams', [])
        if len(streams) != 1 or streams[0].get('codec_type') != 'video' or streams[0].get('disposition', {}).get('attached_pic'):
            raise MediaExportError('video_stream_required')
        stream = streams[0]
        width, height = stream.get('width'), stream.get('height')
        if type(width) is not int or type(height) is not int or min(width, height) < 1:
            raise MediaExportError('video_invalid_metadata')
        if width * height > MAX_PIXELS:
            raise MediaExportError('input_pixel_limit_exceeded')
        raw_duration = stream.get('duration')
        if raw_duration in (None, 'N/A'):
            raw_duration = metadata['format'].get('duration')
        duration_ms = _decimal(raw_duration) * 1000
        if duration_ms <= 0:
            raise MediaExportError('video_duration_invalid')
        sar = stream.get('sample_aspect_ratio', '1:1')
        if sar in ('N/A', '0:1', None):
            sar = '1:1'
        parts = str(sar).split(':')
        if len(parts) != 2:
            raise MediaExportError('video_invalid_metadata')
        numerator, denominator = _decimal(parts[0]), _decimal(parts[1])
        if not numerator or not denominator or not Decimal('0.01') <= numerator / denominator <= 100:
            raise MediaExportError('video_invalid_metadata')
        display_width, display_height = float(Decimal(width) * numerator / denominator), float(height)
        rotation = stream.get('tags', {}).get('rotate', 0)
        for side_data in stream.get('side_data_list', []):
            if 'rotation' in side_data:
                rotation = side_data['rotation']
        rotation = float(rotation)
        if not math.isfinite(rotation) or rotation % 90 != 0:
            raise MediaExportError('video_rotation_unsupported')
        if abs(rotation) % 180 == 90:
            display_width, display_height = display_height, display_width
        return {'width': width, 'height': height, 'displayWidth': display_width,
                'displayHeight': display_height, 'durationMs': duration_ms}
    except MediaExportError:
        raise
    except (ValueError, TypeError, KeyError, IndexError, OverflowError):
        raise MediaExportError('video_invalid_metadata') from None


def _target(spec, video):
    width, height = spec.get('width'), spec.get('height')
    if (width is None) != (height is None):
        raise MediaExportError('invalid_spec', {'field': 'dimensions'})
    if width is not None:
        return (_integer(width, 'width', 1, MAX_EDGE), _integer(height, 'height', 1, MAX_EDGE))
    ratio = min(1, 512 / max(video['displayWidth'], video['displayHeight']))
    return (max(1, round(video['displayWidth'] * ratio)), max(1, round(video['displayHeight'] * ratio)))


def _filters(video, size, fps, fit, background):
    width, height = size
    ratios = (width / video['displayWidth'], height / video['displayHeight'])
    ratio = max(ratios) if fit == 'cover' else min(ratios)
    rounding = math.ceil if fit == 'cover' else math.floor
    scaled_width = max(1, rounding(video['displayWidth'] * ratio))
    scaled_height = max(1, rounding(video['displayHeight'] * ratio))
    # Normalize non-square source pixels using display aspect ratio, then make
    # the output square-pixel. FFmpeg performs metadata rotation before filters.
    filters = [f'fps=fps={fps}:start_time=0:round=down:eof_action=pass',
               f'scale={scaled_width}:{scaled_height}:flags=lanczos', 'setsar=1', 'format=rgba']
    if fit == 'cover':
        filters.append(f'crop={width}:{height}:(iw-ow)/2:(ih-oh)/2')
    else:
        color = '0x' + background[1:] + 'FF' if background else '0x00000000'
        filters.append(f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={color}')
    return ','.join(filters)


def _version(executable, cancel_check):
    output = _run([executable, '-version'], timeout=5, code='video_dependency_failed', cancel_check=cancel_check)
    match = re.match(rb'(ffmpeg|ffprobe) version ([^\s]+)', output)
    return match.group(2).decode('ascii', errors='replace') if match else 'unknown'


def render_video_gif(spec, destination, cancel_check=None):
    """Sample complete frame periods; reuse assemble_frames for GIF verification."""
    from tools.image.export import load_fixed_overlay, render_export
    try:
        if not isinstance(spec, dict) or spec.get('action') != 'video_to_gif' or spec.get('outputFormat', 'gif') != 'gif':
            raise MediaExportError('invalid_spec', {'field': 'action_or_outputFormat'})
        destination = Path(destination)
        if destination.exists() or destination.is_symlink():
            raise MediaExportError('destination_exists')
        _cancel(cancel_check)
        fps = spec.get('fps', 10)
        if type(fps) is not int or fps not in FPS_VALUES:
            raise MediaExportError('invalid_spec', {'field': 'fps'})
        duration_ms = _integer(spec.get('durationMs', 4000), 'durationMs', 1, 10000)
        start_ms = _integer(spec.get('startMs', 0), 'startMs', 0, 2**53 - 1)
        loop = _integer(spec.get('loop', 0), 'loop', 0, 65535)
        _integer(spec.get('colors', 256), 'colors', 2, 256)
        if 'maxBytes' in spec:
            _integer(spec['maxBytes'], 'maxBytes', 1, 2**53 - 1)
        fit = spec.get('fit', 'contain')
        if fit not in ('contain', 'cover'):
            raise MediaExportError('invalid_spec', {'field': 'fit'})
        background = spec.get('background')
        if background is not None and (not isinstance(background, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', background)):
            raise MediaExportError('invalid_spec', {'field': 'background'})
        source_name = spec.get('sourcePath')
        if not isinstance(source_name, str) or not source_name or '\0' in source_name or '://' in source_name:
            raise MediaExportError('invalid_spec', {'field': 'sourcePath'})
        source = Path(source_name)
        if source.suffix.lower() not in ('.mp4', '.mov'):
            raise MediaExportError('video_format_not_supported')
        info = source.stat()
        if not stat.S_ISREG(info.st_mode):
            raise MediaExportError('video_source_not_regular')
        if info.st_size > MAX_INPUT_BYTES:
            raise MediaExportError('input_size_limit_exceeded', {'maxBytes': MAX_INPUT_BYTES})
        source = source.resolve(strict=True)
        ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        if not ffmpeg or not ffprobe:
            raise MediaExportError('video_dependency_missing', {'dependency': 'ffmpeg' if not ffmpeg else 'ffprobe'})
        video = _probe(ffprobe, source, cancel_check)
        size = _target(spec, video)
        overlay_path = spec.get('fixedOverlayPath')
        overlay = load_fixed_overlay(overlay_path, size, cancel_check=cancel_check) if overlay_path else None
        delay_ms = 1000 // fps
        available = min(Decimal(duration_ms), video['durationMs'] - start_ms)
        frame_count = int((available / delay_ms).to_integral_value(rounding=ROUND_FLOOR))
        if frame_count < 1:
            raise MediaExportError('video_clip_too_short', {'frameDurationMs': delay_ms})
        if frame_count > MAX_FRAMES:
            raise MediaExportError('frame_limit_exceeded', {'maxFrames': MAX_FRAMES})
        if size[0] * size[1] * frame_count > MAX_PIXELS:
            raise MediaExportError('output_pixel_limit_exceeded')
        versions = {'ffmpeg': _version(ffmpeg, cancel_check), 'ffprobe': _version(ffprobe, cancel_check)}
        with tempfile.TemporaryDirectory(prefix='opennova-video-gif-') as working:
            working = Path(working)
            command = [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
                       '-threads', '2', '-filter_threads', '1', *_LOCAL_INPUT_OPTIONS,
                       '-ss', str(Decimal(start_ms) / 1000), '-i', str(source),
                       '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
                       '-t', str(Decimal(frame_count * delay_ms) / 1000),
                       '-vf', _filters(video, size, fps, fit, background),
                       '-frames:v', str(frame_count), '-fps_mode', 'passthrough',
                       '-c:v', 'png', '-threads', '1', '-f', 'image2', str(working / '%06d.png')]
            _run(command, timeout=DECODE_TIMEOUT_SECONDS, code='video_decode_failed', cancel_check=cancel_check)
            frames = sorted(working.glob('*.png'))
            if not frames or len(frames) > frame_count:
                raise MediaExportError('video_frame_count_invalid')
            assemble = {key: spec[key] for key in ('colors', 'maxBytes', 'background') if key in spec}
            assemble.update(action='assemble_frames', outputFormat='gif', width=size[0], height=size[1],
                            fit='contain', loop=loop,
                            frames=[{'path': str(frame), 'durationMs': delay_ms} for frame in frames])
            result = render_export(assemble, destination, cancel_check=cancel_check, _overlay=overlay)
            result.update(requestedDurationMs=duration_ms, effectiveDurationMs=len(frames) * delay_ms,
                          sourceDurationMs=float(video['durationMs']), startMs=start_ms, fps=fps,
                          video={'sourceWidth': video['width'], 'sourceHeight': video['height'],
                                 'displayWidth': video['displayWidth'], 'displayHeight': video['displayHeight'],
                                 'runtime': versions, 'audioIncluded': False,
                                 'sampling': 'complete_frame_periods_floor'})
            return result
    except MediaExportError:
        raise
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        raise MediaExportError('video_export_failed') from None


__all__ = ['render_video_gif']
