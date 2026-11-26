import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from tools.video import tool as video


class VideoReferenceTests(unittest.TestCase):
    metadata = {'duration': 6, 'width': 720, 'height': 1036, 'fps': 30, 'has_audio': False}

    def test_validate_local_video_without_credentials_or_network(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'dance.mp4').write_bytes(b'local-video')
            with patch.object(video, 'probe_video', return_value=self.metadata), \
                    patch.object(video, 'urlopen', side_effect=AssertionError('network not permitted')):
                result = video.run({'action': 'validate', 'config': {
                    'prompt': 'dance as in video 1', 'reference_videos': ['dance.mp4']}}, root)
            self.assertEqual(result['video_reference_count'], 1)
            self.assertEqual(result['settings']['omni_reference_task_type'], 'reference')

    def test_rejects_invalid_video_inputs_before_upload(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'dance.mp4').write_bytes(b'local-video')
            cases = [({'reference_videos': 'dance.mp4'}, self.metadata),
                     ({'reference_videos': ['dance.mp4'] * 11}, self.metadata),
                     ({'reference_videos': ['dance.mp4'] * 6}, self.metadata),
                     ({'reference_videos': ['dance.mp4']}, {**self.metadata, 'fps': 15}),
                     ({'reference_videos': ['dance.mp4']}, {**self.metadata, 'duration': 1}),
                     ({'reference_videos': ['dance.mp4']}, {**self.metadata, 'width': 200}),
                     ({'omni_reference_task_type': 'edit'}, self.metadata)]
            for config, metadata in cases:
                with self.subTest(config=config, metadata=metadata), \
                        patch.object(video, 'probe_video', return_value=metadata), \
                        patch.object(video, 'urlopen', side_effect=AssertionError('network not permitted')), \
                        self.assertRaises(video.VideoError):
                    video.build_payload({'prompt': 'x', **config}, root)

    def test_upload_url_only_reaches_generation_payload_and_duplicate_is_blocked(self):
        signed = 'https://storage.example/video.mp4?X-Tos-Signature=private'
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'dance.mp4').write_bytes(b'local-video')
            output = root / 'task'
            request = {'action': 'submit', 'config': {'prompt': 'x',
                        'reference_videos': ['dance.mp4']}, 'output_dir': str(output)}
            with patch.dict('os.environ', {'ARK_API_KEY': 'mock-key'}), \
                    patch.object(video, 'probe_video', return_value=self.metadata), \
                    patch.object(video, 'upload_reference_video', return_value={
                        'id': 'file-test', 'download_url': signed, 'expire_at': 123}) as upload, \
                    patch.object(video, 'request_json', return_value={'id': 'cgt-test'}) as api:
                result = video.run(request, root)
                payload = api.call_args.args[3]
                self.assertEqual(payload['content'][1]['video_url']['url'], signed)
                self.assertEqual(payload['omni_reference_task_type'], 'reference')
                self.assertEqual(api.call_count, 1)
                with self.assertRaises(video.VideoError):
                    video.run(request, root)
                self.assertEqual(upload.call_count, 1)
                self.assertEqual(api.call_count, 1)
            for path in output.glob('*.json'):
                self.assertNotIn(signed, path.read_text())
                self.assertNotIn('mock-key', path.read_text())
            self.assertNotIn(signed, json.dumps(result))
            self.assertEqual(json.loads((output / 'reference_uploads.json').read_text())[0]['id'], 'file-test')

    def test_upload_uses_only_official_files_endpoint_and_agent_purpose(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'dance.mp4'
            path.write_bytes(b'local-video')
            response = io.BytesIO(json.dumps({'id': 'file-test', 'status': 'active',
                       'download_url': 'https://storage.example/ref.mp4?signature=temporary'}).encode())
            with patch.object(video, 'urlopen', side_effect=[response, io.BytesIO(b'\x00\x00\x00\x18ftypisom')]) as api:
                result = video.upload_reference_video(path, 'mock-key')
            request = api.call_args_list[0].args[0]
            self.assertEqual(request.full_url, video.API_BASE + '/files')
            self.assertEqual(request.get_header('Authorization'), 'Bearer mock-key')
            self.assertIn(b'name="purpose"\r\n\r\nagent', request.data)
            self.assertIn(b'name="expire_at"', request.data)
            self.assertIn(b'local-video', request.data)
            self.assertEqual(result['id'], 'file-test')
            media_request = api.call_args_list[1].args[0]
            self.assertIsNone(media_request.get_header('Authorization'))
            self.assertEqual(media_request.get_header('Range'), 'bytes=0-63')

    def test_processing_file_with_readable_original_url_needs_no_preprocessing_wait(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'dance.mp4'
            path.write_bytes(b'local-video')
            response = io.BytesIO(json.dumps({'id': 'file-test', 'status': 'processing',
                       'download_url': 'https://storage.example/ref.mp4?signature=temporary'}).encode())
            with patch.object(video, 'urlopen', side_effect=[response, io.BytesIO(b'\x00\x00\x00\x18ftypisom')]), \
                    patch.object(video, 'request_json', side_effect=AssertionError('no preprocessing poll')):
                self.assertEqual(video.upload_reference_video(path, 'mock-key')['id'], 'file-test')

    def test_active_or_unspecified_file_without_url_polls_same_file_for_delayed_url(self):
        signed = 'https://storage.example/ref.mp4?signature=temporary'
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'dance.mp4'
            path.write_bytes(b'local-video')
            for status in ('active', None, ''):
                response = io.BytesIO(json.dumps({'id': 'file-test', 'status': status,
                                                 'download_url': None}).encode())
                with self.subTest(status=status), \
                        patch.object(video, 'urlopen', side_effect=[response, io.BytesIO(b'\x00\x00\x00\x18ftypisom')]) as http, \
                        patch.object(video.time, 'sleep'), \
                        patch.object(video, 'request_json', return_value={
                            'id': 'file-test', 'status': 'active', 'download_url': signed}) as query:
                    result = video.upload_reference_video(path, 'mock-key')
                self.assertEqual(result['download_url'], signed)
                query.assert_called_once_with('GET', '/files/file-test', 'mock-key')
                self.assertEqual(http.call_args_list[0].args[0].method, 'POST')
                self.assertEqual(http.call_count, 2)  # One upload, one unsigned media check.

    def test_delayed_download_url_polling_stops_at_deadline(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'dance.mp4'
            path.write_bytes(b'local-video')
            response = io.BytesIO(b'{"id":"file-test","status":"active"}')
            with patch.object(video, 'urlopen', return_value=response) as http, \
                    patch.object(video.time, 'monotonic', side_effect=[0, 0, 31]), \
                    patch.object(video.time, 'sleep'), \
                    patch.object(video, 'request_json', return_value={'id': 'file-test', 'status': 'active'}) as query, \
                    self.assertRaises(video.VideoError) as caught:
                video.upload_reference_video(path, 'mock-key')
            self.assertIn('file-test', str(caught.exception))
            self.assertIn('download URL', str(caught.exception))
            self.assertEqual(http.call_count, 1)
            query.assert_called_once_with('GET', '/files/file-test', 'mock-key')

    def test_unreadable_original_video_stops_before_generation(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'dance.mp4'
            path.write_bytes(b'local-video')
            response = io.BytesIO(json.dumps({'id': 'file-test', 'status': 'active',
                       'download_url': 'https://storage.example/ref.mp4?signature=temporary'}).encode())
            with patch.object(video, 'urlopen', side_effect=[response, io.BytesIO(b'<html>error</html>')]), \
                    self.assertRaises(video.VideoError):
                video.upload_reference_video(path, 'mock-key')

    def test_upload_error_redacts_key_and_signed_url(self):
        signed = 'https://storage.example/ref.mp4?signature=temporary'
        raw = json.dumps({'error': f'mock-key failed {signed}'}).encode()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'dance.mp4'
            path.write_bytes(b'local-video')
            error = HTTPError(video.API_BASE + '/files', 400, 'bad', {}, io.BytesIO(raw))
            with patch.object(video, 'urlopen', side_effect=error), self.assertRaises(video.VideoError) as caught:
                video.upload_reference_video(path, 'mock-key')
            self.assertNotIn(signed, str(caught.exception))
            self.assertNotIn('mock-key', str(caught.exception))

    def test_wait_existing_video_task_does_not_reupload_or_submit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'task.json').write_text('{"id":"cgt-existing"}')
            with patch.dict('os.environ', {'ARK_API_KEY': 'mock-key'}), \
                    patch.object(video, 'upload_reference_video', side_effect=AssertionError('no upload')), \
                    patch.object(video, 'request_json', return_value={'status': 'succeeded'}) as api:
                result = video.run({'action': 'wait', 'output_dir': folder})
            self.assertEqual(result['task_id'], 'cgt-existing')
            self.assertEqual(api.call_args.args[0], 'GET')

    def test_status_redacts_echoed_input_url_but_keeps_generated_video_url(self):
        signed = 'https://storage.example/input.mp4?signature=private-input'
        generated = 'https://storage.example/output.mp4?signature=download-output'
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'task.json').write_text('{"id":"cgt-existing"}')
            with patch.dict('os.environ', {'ARK_API_KEY': 'mock-key'}), \
                    patch.object(video, 'request_json', return_value={
                        'status': 'failed', 'error': {'code': 'BadInput', 'message': signed},
                        'content': {'video_url': generated}}):
                result = video.run({'action': 'status', 'output_dir': folder})
            self.assertNotIn(signed, (root / 'task.json').read_text())
            self.assertEqual(result['task']['content']['video_url'], generated)


if __name__ == '__main__':
    unittest.main()
