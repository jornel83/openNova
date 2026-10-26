import importlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class VideoTests(unittest.TestCase):
    def module(self):
        self.assertTrue(Path('tools/video/tool.py').is_file(), 'Reusable video tool is missing')
        return importlib.import_module('tools.video.tool')

    def test_validate_embeds_relative_images_without_credentials(self):
        video = self.module()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'ref.png').write_bytes(b'\x89PNG\r\n\x1a\n')
            config = {'prompt': 'rainy mountain', 'duration': 10,
                      'reference_images': ['ref.png']}
            payload = video.build_payload(config, root)
            self.assertEqual(payload['resolution'], '720p')
            self.assertEqual(payload['ratio'], '9:16')
            self.assertTrue(payload['content'][1]['image_url']['url'].startswith('data:image/png;base64,'))
            self.assertNotIn('api_key', payload)

    def test_rejects_invalid_settings_before_network(self):
        video = self.module()
        for config in [{'prompt': 'x', 'duration': 0}, {'prompt': 'x', 'resolution': '4k'},
                       {'prompt': ''}, {'prompt': 'x', 'api_key': 'secret'},
                       {'prompt': 'x', 'generate_audio': 'false'}]:
            with self.subTest(config=config), self.assertRaises(video.VideoError):
                video.build_payload(config, Path('.'))

    def test_submit_is_asynchronous_and_duplicate_is_blocked(self):
        video = self.module()
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict('os.environ', {'ARK_API_KEY': 'test-secret'}):
                with patch.object(video, 'request_json', return_value={'id': 'cgt-test'}) as call:
                    request = {'action': 'submit', 'config': {'prompt': 'x'}, 'output_dir': folder}
                    result = video.run(request)
                    self.assertEqual(result['task_id'], 'cgt-test')
                    self.assertEqual(call.call_count, 1)
                    with self.assertRaises(video.VideoError):
                        video.run(request)
                    self.assertEqual(call.call_count, 1)
            self.assertNotIn('test-secret', (Path(folder) / 'task.json').read_text())

    def test_ambiguous_submit_blocks_automatic_resubmission(self):
        video = self.module()
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict('os.environ', {'ARK_API_KEY': 'test-secret'}):
                with patch.object(video, 'request_json', side_effect=video.VideoError('timeout')) as call:
                    request = {'action': 'submit', 'config': {'prompt': 'x'}, 'output_dir': folder}
                    with self.assertRaises(video.VideoError):
                        video.run(request)
                    with self.assertRaises(video.VideoError):
                        video.run(request)
                    self.assertEqual(call.call_count, 1)
            self.assertEqual(json.loads((Path(folder) / 'task.json').read_text())['status'], 'submission_not_confirmed')

    def test_status_uses_saved_id_without_post(self):
        video = self.module()
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'task.json').write_text('{"id":"cgt-test"}')
            with patch.dict('os.environ', {'ARK_API_KEY': 'test-secret'}):
                with patch.object(video, 'request_json', return_value={'status': 'running'}) as call:
                    result = video.run({'action': 'status', 'output_dir': folder})
                    self.assertEqual(result['status'], 'running')
                    self.assertEqual(call.call_args.args[0], 'GET')

    def test_api_error_never_exposes_secret(self):
        video = self.module()
        from urllib.error import HTTPError
        error = HTTPError(video.API_BASE, 403, 'Forbidden', {}, io.BytesIO(b'{"error":"test-secret"}'))
        with patch.object(video, 'urlopen', side_effect=error) as call:
            with self.assertRaises(video.VideoError) as caught:
                video.request_json('POST', video.TASKS, 'test-secret', {})
            self.assertNotIn('test-secret', str(caught.exception))
            self.assertEqual(call.call_count, 1)

    def test_edit_plan_rejects_overlong_trim_and_preserves_input_order(self):
        video = self.module()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ('one.mp4', 'two.mp4'):
                (root / name).touch()
            probe = {'duration': 8, 'has_audio': True, 'width': 720, 'height': 1280}
            with patch.object(video, 'probe_video', return_value=probe):
                plan = video.plan_edit({'clips': [{'path': 'two.mp4', 'duration': 5},
                                                  {'path': 'one.mp4', 'duration': 7}],
                                        'output': 'final.mp4'}, root)
                self.assertEqual([Path(c['path']).name for c in plan['clips']], ['two.mp4', 'one.mp4'])
                self.assertEqual(plan['duration'], 12)
                with self.assertRaises(video.VideoError):
                    video.plan_edit({'clips': [{'path': 'one.mp4', 'duration': 10}], 'output': 'final.mp4'}, root)

    def test_edit_refuses_overwrite_of_source(self):
        video = self.module()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'one.mp4').touch()
            with self.assertRaises(video.VideoError):
                video.plan_edit({'clips': [{'path': 'one.mp4'}], 'output': 'one.mp4'}, root)

    def test_named_dispatch_rejects_action_override(self):
        video = self.module()
        self.assertTrue(hasattr(video, 'invoke'), 'Named tool dispatch is missing')
        with self.assertRaises(video.VideoError):
            video.invoke('video_validate', {'action': 'submit', 'config': {'prompt': 'x'}})
        result = video.invoke('video_validate', {'config': {'prompt': 'x'}})
        self.assertEqual(result['status'], 'validated')

    def test_request_contract_rejects_credentials_and_conflicting_config(self):
        video = self.module()
        for request in [{'action': 'validate', 'config': {'prompt': 'x'}, 'api_key': 'secret'},
                        {'action': 'validate', 'config': {'prompt': 'x'}, 'config_path': 'missing.json'},
                        {'action': 'edit', 'dry_run': 'false', 'config': {}}]:
            with self.subTest(request=request), self.assertRaises(video.VideoError):
                video.run(request)

    def test_wait_timeout_keeps_same_task(self):
        video = self.module()
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'task.json').write_text('{"id":"cgt-existing"}')
            with patch.dict('os.environ', {'ARK_API_KEY': 'test-key'}), \
                 patch.object(video, 'request_json', return_value={'status': 'running'}) as call, \
                 patch.object(video.time, 'monotonic', side_effect=[0, 0, 2]):
                result = video.run({'action': 'wait', 'output_dir': folder, 'timeout_seconds': 1})
                self.assertTrue(result['timed_out'])
                self.assertEqual(result['task_id'], 'cgt-existing')
                self.assertTrue(all(c.args[0] == 'GET' for c in call.call_args_list))

    def test_real_edit_accepts_mixed_size_and_missing_audio(self):
        import shutil
        import subprocess
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            self.skipTest('FFmpeg unavailable')
        video = self.module()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24',
                            '-t', '0.5', '-c:v', 'libx264', str(root / 'red.mp4')], check=True)
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=90x160:r=30',
                            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000', '-t', '0.5',
                            '-c:v', 'libx264', '-c:a', 'aac', str(root / 'blue.mp4')], check=True)
            request = {'action': 'edit', 'config': {'clips': [{'path': 'red.mp4', 'duration': 0.5},
                                                            {'path': 'blue.mp4', 'duration': 0.5}],
                                                  'width': 90, 'height': 160, 'output': 'final.mp4'}}
            result = video.run(request, root)
            self.assertAlmostEqual(result['metadata']['duration'], 1, places=2)
            self.assertTrue(result['metadata']['has_audio'])
            self.assertEqual(result['metadata']['width'], 90)
            raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', result['path'],
                                           '-vf', 'select=eq(n\\,0)+eq(n\\,18),scale=1:1',
                                           '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
            self.assertGreater(raw[0], raw[2])
            self.assertGreater(raw[5], raw[3])


if __name__ == '__main__':
    unittest.main()
