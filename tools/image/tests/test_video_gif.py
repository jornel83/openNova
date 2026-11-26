"""Real local FFmpeg conversion and bounded-process regressions; no network."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

from tools.image import video_gif
from tools.image.bundle import run_gif_bundle
from tools.image.export import MediaExportError, inspect_media, render_export


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'requires local ffmpeg and ffprobe')
class VideoGIFTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix='nova-video-gif-fixture-')
        cls.source = Path(cls.fixture.name) / 'source.mp4'
        cls.large = Path(cls.fixture.name) / 'large.mp4'
        for path, size, duration in ((cls.source, '80x40', '1.25'), (cls.large, '640x320', '0.2')):
            subprocess.run([shutil.which('ffmpeg'), '-nostdin', '-hide_banner', '-loglevel', 'error',
                            '-f', 'lavfi', '-i', f'color=c=red:s={size}:r=20', '-t', duration,
                            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)],
                           check=True, capture_output=True, timeout=10)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nova-video-gif-test-')
        self.root = Path(self.temp.name)
        self.output = self.root / 'result.gif'
        self.spec = {'action': 'video_to_gif', 'sourcePath': str(self.source), 'outputFormat': 'gif'}

    def tearDown(self):
        self.temp.cleanup()

    def render(self, **options):
        return render_export({**self.spec, **options}, self.output)

    def assert_error(self, code, options=None, callback=None):
        with self.assertRaises(MediaExportError) as caught:
            if callback:
                callback()
            else:
                self.render(**(options or {}))
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(str(self.root), str(caught.exception))
        self.assertFalse(self.output.exists())

    def test_real_mp4_conversion_reports_requested_and_actual_trim(self):
        result = self.render()
        self.assertEqual((result['width'], result['height']), (80, 40))
        self.assertEqual(result['frames'], 12)
        self.assertEqual(result['durationsMs'], [100] * 12)
        self.assertEqual(result['durationMs'], 1200)
        self.assertEqual(result['requestedDurationMs'], 4000)
        self.assertEqual(result['effectiveDurationMs'], 1200)
        self.assertEqual(result['sourceDurationMs'], 1250)
        self.assertEqual((result['startMs'], result['fps'], result['loop']), (0, 10, 0))
        self.assertFalse(result['video']['audioIncluded'])
        self.assertTrue(result['video']['runtime']['ffmpeg'])
        self.assertEqual(inspect_media(self.output)['sha256'], result['sha256'])

    def test_supported_frame_rates_have_exact_10ms_representable_delays(self):
        for fps, count, delay in ((5, 6, 200), (10, 12, 100), (20, 25, 50), (25, 31, 40)):
            with self.subTest(fps=fps):
                result = self.render(fps=fps, loop=3)
                self.assertEqual((result['frames'], result['loop']), (count, 3))
                self.assertEqual(result['durationsMs'], [delay] * count)
                self.assertEqual(result['effectiveDurationMs'], count * delay)
                self.output.unlink()

    def test_start_and_requested_duration_are_sampled_in_complete_periods(self):
        result = self.render(startMs=250, durationMs=735, fps=20)
        self.assertEqual(result['frames'], 14)
        self.assertEqual(result['effectiveDurationMs'], 700)
        self.assertEqual((result['requestedDurationMs'], result['startMs']), (735, 250))

    def test_contain_centers_image_on_exact_transparent_canvas(self):
        result = self.render(width=40, height=40, durationMs=200)
        self.assertEqual((result['width'], result['height']), (40, 40))
        self.assertTrue(result['hasTransparency'])
        with Image.open(self.output) as image:
            self.assertEqual(image.convert('RGBA').getchannel('A').getbbox(), (0, 10, 40, 30))

    def test_explicit_cover_crops_to_exact_size_without_padding(self):
        result = self.render(width=40, height=40, fit='cover', durationMs=200)
        self.assertEqual((result['width'], result['height']), (40, 40))
        self.assertFalse(result['hasTransparency'])

    def test_explicit_background_is_used_for_contain_padding(self):
        result = self.render(width=40, height=40, background='#FFFFFF', durationMs=200)
        self.assertFalse(result['hasTransparency'])
        with Image.open(self.output) as image:
            self.assertEqual(image.convert('RGB').getpixel((0, 0)), (255, 255, 255))

    def test_default_size_limits_long_edge_to_512_without_stretching(self):
        result = self.render(sourcePath=str(self.large))
        self.assertEqual((result['width'], result['height']), (512, 256))

    def test_video_action_flows_through_bundle_and_final_gif_first_frame(self):
        arguments = {**self.spec, 'outputPath': str(self.output), 'width': 40, 'height': 40, 'durationMs': 200}
        receipt = run_gif_bundle(arguments, self.root / 'first.png', base_dir=self.root,
                                 state_dir=self.root / 'state', operation_id='video-bundle')
        self.assertEqual(receipt['status'], 'completed', receipt)
        self.assertEqual(receipt['artifacts']['gif']['effectiveDurationMs'], 200)
        self.assertEqual(receipt['firstFrameValidation']['status'], 'passed')
        with Image.open(self.output) as gif, Image.open(receipt['artifacts']['firstFrame']['path']) as first:
            self.assertEqual(gif.convert('RGBA').tobytes(), first.convert('RGBA').tobytes())
        with patch('tools.image.video_gif._run', side_effect=AssertionError('no second video decode')):
            self.assertEqual(run_gif_bundle(arguments, self.root / 'first.png', base_dir=self.root,
                                           state_dir=self.root / 'state', operation_id='video-bundle'), receipt)

    def test_fixed_overlay_is_frozen_and_opaque_pixels_decode_identically(self):
        moving = self.root / 'moving.mp4'
        subprocess.run([shutil.which('ffmpeg'), '-nostdin', '-hide_banner', '-loglevel', 'error',
                        '-f', 'lavfi', '-i', 'testsrc2=size=80x40:rate=20', '-t', '1',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(moving)],
                       check=True, capture_output=True, timeout=10)
        caption = self.root / 'caption.png'
        overlay = Image.new('RGBA', (160, 80))
        ImageDraw.Draw(overlay).rectangle((64, 5, 96, 24), fill=(23, 53, 111, 255))
        overlay.save(caption)
        original_sha = inspect_media(caption)['sha256']

        def change_original_after_freeze(phase):
            if phase == 'gif:after_prepare':
                overlay.putpixel((80, 12), (255, 20, 0, 255))
                overlay.save(caption)

        receipt = run_gif_bundle({**self.spec, 'sourcePath': str(moving), 'outputPath': str(self.output),
                                  'fixedOverlayPath': str(caption), 'colors': 64}, self.root / 'first.png',
                                 base_dir=self.root, state_dir=self.root / 'state', operation_id='caption',
                                 hook=change_original_after_freeze)
        self.assertEqual(receipt['status'], 'completed', receipt)
        proof = receipt['artifacts']['gif']['fixedOverlay']
        self.assertEqual((proof['status'], proof['checkedFrames'], proof['sourceSha256']),
                         ('passed', 10, original_sha))
        self.assertNotEqual(inspect_media(caption)['sha256'], original_sha)
        self.assertEqual(receipt['firstFrameValidation']['status'], 'passed')
        with Image.open(self.output) as gif:
            opaque_pixels, content = set(), set()
            for index in range(gif.n_frames):
                gif.seek(index)
                frame = gif.convert('RGBA')
                opaque_pixels.add(frame.getpixel((40, 6)))
                content.add(frame.crop((0, 15, 80, 40)).tobytes())
        self.assertEqual(len(opaque_pixels), 1)
        self.assertTrue(all(abs(actual - original) <= 5 for actual, original in
                            zip(next(iter(opaque_pixels)), (23, 53, 111, 255))))
        self.assertGreater(len(content), 1)

    def test_overlay_rejects_wrong_aspect_and_empty_caption(self):
        caption = self.root / 'caption.png'
        overlay = Image.new('RGBA', (80, 80))
        overlay.save(caption)
        self.assert_error('invalid_fixed_overlay', {'fixedOverlayPath': str(caption)})
        overlay.putpixel((40, 40), (23, 53, 111, 255))
        overlay.save(caption)
        self.assert_error('fixed_overlay_aspect_mismatch', {'fixedOverlayPath': str(caption)})

    def test_frame_limit_and_total_output_pixel_limit_fail_before_decode(self):
        self.assert_error('output_pixel_limit_exceeded', {'width': 4096, 'height': 4096})
        with patch.object(video_gif, 'MAX_FRAMES', 10):
            self.assert_error('frame_limit_exceeded')

    def test_invalid_duration_fps_and_unavailable_clip_are_rejected(self):
        for options in ({'durationMs': 0}, {'durationMs': 10001}, {'durationMs': True}, {'fps': 7},
                        {'startMs': -1}, {'outputFormat': 'png'}, {'width': 30}):
            with self.subTest(options=options):
                self.assert_error('invalid_spec', options)
        self.assert_error('video_clip_too_short', {'startMs': 1250})
        self.assert_error('video_clip_too_short', {'durationMs': 10})

    def test_source_size_type_and_extension_are_bounded(self):
        oversized = self.root / 'oversized.mp4'
        with oversized.open('wb') as stream:
            stream.truncate(video_gif.MAX_INPUT_BYTES + 1)
        self.assert_error('input_size_limit_exceeded', {'sourcePath': str(oversized)})
        wrong_extension = self.root / 'source.avi'
        shutil.copyfile(self.source, wrong_extension)
        self.assert_error('video_format_not_supported', {'sourcePath': str(wrong_extension)})
        fifo = self.root / 'pipe.mp4'
        os.mkfifo(fifo)
        self.assert_error('video_source_not_regular', {'sourcePath': str(fifo)})

    def test_disguised_image_and_network_source_are_rejected(self):
        disguised = self.root / 'fake.mp4'
        Image.new('RGB', (10, 10), 'red').save(disguised, format='PNG')
        self.assert_error('video_probe_failed', {'sourcePath': str(disguised)})
        self.assert_error('invalid_spec', {'sourcePath': 'https://example.invalid/video.mp4'})

    def test_unachievable_byte_limit_does_not_publish(self):
        self.assert_error('size_limit_exceeded', {'maxBytes': 1, 'durationMs': 200})

    def test_cancel_before_work_creates_no_destination(self):
        self.assert_error('cancelled', callback=lambda: video_gif.render_video_gif(
            self.spec, self.output, cancel_check=lambda: True))

    def test_destination_is_never_overwritten(self):
        self.output.write_bytes(b'existing user data')
        with self.assertRaises(MediaExportError) as caught:
            self.render()
        self.assertEqual(caught.exception.code, 'destination_exists')
        self.assertEqual(self.output.read_bytes(), b'existing user data')

    def test_demuxing_commands_disable_network_external_tracks_and_audio(self):
        actual = video_gif._run
        commands = []
        def record(command, **kwargs):
            commands.append(command)
            return actual(command, **kwargs)
        with patch.object(video_gif, '_run', side_effect=record):
            self.render(durationMs=200)
        demuxing = [command for command in commands if '-protocol_whitelist' in command]
        self.assertEqual(len(demuxing), 2)
        for command in demuxing:
            self.assertEqual(command[command.index('-protocol_whitelist') + 1], 'file')
            self.assertEqual(command[command.index('-format_whitelist') + 1], 'mov')
            self.assertEqual(command[command.index('-enable_drefs') + 1], '0')
            self.assertEqual(command[command.index('-use_absolute_path') + 1], '0')
        decode = [command for command in demuxing if '-vf' in command][0]
        self.assertIn('-an', decode)
        self.assertIn('-n', decode)


class BoundedVideoProcessTests(unittest.TestCase):
    def run_sleeper(self, *, timeout=5, cancel_check=None):
        return video_gif._run([sys.executable, '-c', 'import time; time.sleep(10)'],
                              timeout=timeout, code='video_decode_failed', cancel_check=cancel_check)

    def test_cancellation_terminates_running_subprocess(self):
        processes = []
        actual = subprocess.Popen
        def capture(*args, **kwargs):
            process = actual(*args, **kwargs)
            processes.append(process)
            return process
        started = time.monotonic()
        with patch.object(video_gif.subprocess, 'Popen', side_effect=capture):
            with self.assertRaises(MediaExportError) as caught:
                self.run_sleeper(cancel_check=lambda: time.monotonic() - started > 0.06)
        self.assertEqual(caught.exception.code, 'cancelled')
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())

    def test_subprocess_timeout_is_bounded_and_sanitized(self):
        started = time.monotonic()
        with self.assertRaises(MediaExportError) as caught:
            self.run_sleeper(timeout=0.06)
        self.assertEqual(caught.exception.code, 'video_process_timeout')
        self.assertLess(time.monotonic() - started, 2)

    def test_subprocess_output_is_bounded(self):
        with self.assertRaises(MediaExportError) as caught:
            video_gif._run([sys.executable, '-c', 'import sys,time; sys.stdout.write("x"*1000000); sys.stdout.flush(); time.sleep(10)'],
                           timeout=2, code='video_decode_failed')
        self.assertEqual(caught.exception.code, 'video_process_output_limit')


if __name__ == '__main__':
    unittest.main()
