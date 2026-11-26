"""Asset-backed first-frame contract and offline lifecycle, with no cloud calls."""
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools.video import tool as video


class AssetFirstFrameTests(unittest.TestCase):
    def config(self, **changes):
        return {'model': 'doubao-seedance-2-0-fast-260128',
                'prompt': '人物轻微眨眼，保持首帧服装和房间光线。',
                'first_frame': 'asset://asset-offline-portrait',
                'duration': 4, 'resolution': '480p', 'ratio': '9:16',
                'generate_audio': False, 'watermark': True,
                'return_last_frame': True, **changes}

    def test_exact_first_frame_payload_and_offline_validation(self):
        config = self.config()
        with patch.object(video, 'urlopen', side_effect=AssertionError('No network')), \
                patch.object(video, 'upload_reference_video', side_effect=AssertionError('No upload')), \
                patch.object(video, 'probe_video', side_effect=AssertionError('No local asset')):
            payload = video.build_payload(config, Path('/nonexistent'))
            self.assertEqual(payload['content'], [
                {'type': 'text', 'text': config['prompt']},
                {'type': 'image_url', 'role': 'first_frame',
                 'image_url': {'url': config['first_frame']}}])
            self.assertNotIn('omni_reference_task_type', payload)
            self.assertEqual({k: payload[k] for k in ('model', 'duration', 'resolution', 'ratio',
                             'generate_audio', 'watermark', 'return_last_frame')},
                             {k: config[k] for k in ('model', 'duration', 'resolution', 'ratio',
                             'generate_audio', 'watermark', 'return_last_frame')})
            result = video.invoke('video_validate', {'config': config})
            self.assertEqual(result['generation_mode'], 'first_frame')
            self.assertEqual(result['first_frame'], config['first_frame'])
            self.assertEqual(result['asset_validation'], 'not_checked')
            self.assertEqual(result['reference_count'], 0)

    def test_defaults_do_not_change_existing_generation(self):
        payload = video.build_payload({'prompt': 'Old text task'}, Path('.'))
        self.assertEqual(payload['ratio'], '9:16')
        self.assertEqual(payload['model'], 'doubao-seedance-2-5-260628')
        self.assertNotIn('watermark', payload)
        self.assertNotIn('return_last_frame', payload)
        config = self.config(model='doubao-seedance-2-5-260628')
        del config['ratio']
        self.assertEqual(video.build_payload(config, Path('.'))['ratio'], 'adaptive')
        config['model'] = 'ep-my-approved-model'
        config['ratio'] = '9:16'
        self.assertEqual(video.build_payload(config, Path('.'))['ratio'], '9:16')

    def test_invalid_uri_mode_model_and_flags_stop_before_submission(self):
        invalid = [self.config(first_frame=x) for x in (
            '', None, 42, 'asset://', 'asset://other-id', 'asset://asset-',
            'asset://asset-123/child', 'asset://asset-123?key=x', 'asset://asset-123#part',
            'asset://asset-123\n', 'ASSET://asset-123', 'asset://asset-../x',
            'asset://asset-%31', 'asset://user:pass@asset-123', 'https://example.com/face.jpg',
            'data:image/png;base64,eA==', './before.jpg', 'asset://asset-' + 'a' * 256)]
        invalid += [self.config(**changes) for changes in (
            {'model': ' '}, {'reference_images': ['before.png']},
            {'reference_videos': ['before.mp4']}, {'omni_reference_task_type': 'reference'},
            {'watermark': 1}, {'return_last_frame': 'true'}, {'duration': 16},
            {'resolution': '1080p'}, {'model': 'doubao-seedance-2-5-260628', 'ratio': '9:16'})]
        absent = self.config()
        del absent['model']
        invalid.append(absent)
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(video, 'request_json', side_effect=AssertionError('No API call')):
            output = Path(folder) / 'new-task'
            for config in invalid:
                with self.subTest(config=config), self.assertRaises(video.VideoError):
                    video.run({'action': 'submit', 'config': config, 'output_dir': str(output)})
                self.assertFalse(output.exists(), 'Invalid config must not reserve a task')

    def test_provider_refusal_and_lost_response_never_repost(self):
        for failure in ('Asset not active or project mismatch', 'timeout after POST'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                request = {'action': 'submit', 'config': self.config(), 'output_dir': folder}
                with patch.dict('os.environ', {'ARK_API_KEY': 'mock-secret'}), \
                        patch.object(video, 'request_json', side_effect=video.VideoError(failure)) as api:
                    with self.assertRaises(video.VideoError):
                        video.run(request)
                    with self.assertRaisesRegex(video.VideoError, 'already exists'):
                        video.run(request)
                self.assertEqual(api.call_count, 1)
                state = json.loads((Path(folder) / 'task.json').read_text())
                self.assertEqual(state['status'], 'submission_not_confirmed')
                self.assertTrue((Path(folder) / 'request.json').is_file())

    def test_config_path_preserves_asset_and_saves_request_before_post(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'inputs').mkdir()
            config_path = root / 'inputs/config.json'
            config_path.write_text(json.dumps(self.config()))
            output = root / 'result'

            def api(method, path, key, payload=None):
                self.assertEqual((method, path), ('POST', video.TASKS))
                self.assertEqual(json.loads((output / 'request.json').read_text()), payload)
                self.assertEqual(json.loads((output / 'config.json').read_text())['first_frame'],
                                 self.config()['first_frame'])
                self.assertEqual(json.loads((output / 'task.json').read_text())['status'], 'submitting')
                return {'id': 'cgt-first-frame'}

            with patch.dict('os.environ', {'ARK_API_KEY': 'mock-secret'}), \
                    patch.object(video, 'request_json', side_effect=api) as call:
                result = video.run({'action': 'submit', 'config_path': 'inputs/config.json',
                                    'output_dir': 'result'}, root)
            self.assertEqual(call.call_count, 1)
            self.assertEqual(result['task_id'], 'cgt-first-frame')
            for path in output.glob('*.json'):
                self.assertNotIn('mock-secret', path.read_text())

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_submit_resume_download_and_real_edit_lifecycle(self):
        """Mock only Ark/storage; exercise real records, downloader and FFmpeg."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'cloud-response.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                            'color=c=blue:s=160x90:r=24', '-t', '4', '-c:v', 'libx264',
                            str(source)], check=True)
            media_bytes = source.read_bytes()
            output = root / 'task'
            calls = []
            usage = {'completion_tokens': 40594, 'total_tokens': 40594}

            def api(method, path, key, payload=None):
                calls.append((method, path))
                if method == 'POST':
                    self.assertEqual(payload['content'][1]['role'], 'first_frame')
                    self.assertEqual(payload['content'][1]['image_url']['url'], self.config()['first_frame'])
                    return {'id': 'cgt-lifecycle'}
                self.assertEqual(path, video.TASKS + '/cgt-lifecycle')
                if len(calls) == 2:
                    return {'status': 'running'}
                return {'status': 'succeeded', 'usage': usage, 'content': {
                    'video_url': 'https://storage.example/result.mp4',
                    'last_frame_url': 'https://storage.example/last.jpg'}}

            def storage(url, timeout):
                self.assertEqual(url, 'https://storage.example/result.mp4')
                response = io.BytesIO(media_bytes)
                response.headers = {'Content-Length': str(len(media_bytes))}
                return response

            args = {'config': self.config(), 'output_dir': str(output)}
            with patch.dict('os.environ', {'ARK_API_KEY': 'mock-secret'}), \
                    patch.object(video, 'request_json', side_effect=api), \
                    patch.object(video, 'urlopen', side_effect=storage):
                created = video.invoke('video_submit', args)
                self.assertEqual(created['task_id'], 'cgt-lifecycle')
                self.assertEqual(video.invoke('video_status', {'output_dir': str(output)})['status'], 'running')
                # New calls recover the ID solely from disk, as after restart.
                completed = video.invoke('video_wait', {'output_dir': str(output), 'timeout_seconds': 1})
                self.assertEqual(completed['status'], 'succeeded')
                self.assertEqual(completed['task']['usage'], usage)
                downloaded = video.invoke('video_download', {'output_dir': str(output)})
                self.assertEqual(Path(downloaded['path']).read_bytes(), media_bytes)
                with self.assertRaisesRegex(video.VideoError, 'already exists'):
                    video.invoke('video_submit', args)
            self.assertEqual(sum(method == 'POST' for method, _ in calls), 1)
            self.assertEqual(json.loads((output / 'task.json').read_text())['usage'], usage)
            edited = video.invoke('video_edit', {'config': {'clips': [
                {'path': downloaded['path'], 'duration': 2},
                {'path': downloaded['path'], 'start': 2, 'duration': 2}],
                'width': 160, 'height': 90, 'fps': 24, 'output': str(root / 'final.mp4')}})
            self.assertEqual(edited['status'], 'completed')
            self.assertAlmostEqual(edited['metadata']['duration'], 4, places=2)
            self.assertGreater(edited['size_bytes'], 0)


if __name__ == '__main__':
    unittest.main()
