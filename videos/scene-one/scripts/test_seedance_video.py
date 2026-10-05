"""Offline checks: request contract, credential redaction, and task recovery."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import seedance_video as video


class SeedanceTests(unittest.TestCase):
    def test_reference_is_embedded_with_native_audio_and_requested_duration(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'product.png').write_bytes(b'\x89PNG\r\n\x1a\n')
            config = {'model': 'test-model', 'prompt': '自然交谈',
                      'reference_images': ['product.png'], 'duration': 10,
                      'ratio': '16:9', 'resolution': '720p', 'generate_audio': True}
            payload = video.build_payload(config, root)
        self.assertEqual(payload['content'][1], {
            'type': 'image_url', 'role': 'reference_image',
            'image_url': {'url': 'data:image/png;base64,iVBORw0KGgo='}})
        self.assertTrue(payload['generate_audio'])
        self.assertEqual(payload['duration'], 10)
        self.assertEqual(payload['ratio'], '16:9')

    def test_http_error_redacts_key_and_does_not_retry_submission(self):
        key = 'test-secret-never-log'
        error = HTTPError(video.API_BASE, 403, 'Forbidden', {},
                          io.BytesIO(json.dumps({'error': {
                              'code': 'AccessDenied', 'message': f'bad token {key}'
                          }}).encode()))
        with patch('seedance_video.urlopen', side_effect=error) as transport:
            with self.assertRaises(video.VideoError) as caught:
                video.request_json('POST', '/contents/generations/tasks', key, {})
        self.assertNotIn(key, str(caught.exception))
        self.assertIn('AccessDenied', str(caught.exception))
        self.assertEqual(transport.call_count, 1)

    def test_resume_polls_existing_task_without_creating_another(self):
        responses = [
            {'id': 'cgt-example', 'status': 'running'},
            {'id': 'cgt-example', 'status': 'succeeded',
             'content': {'video_url': 'https://example.com/video.mp4'}}]
        with tempfile.TemporaryDirectory() as folder:
            with patch('seedance_video.request_json', side_effect=responses) as request:
                with patch('seedance_video.time.sleep'):
                    result = video.wait_for_task('cgt-example', 'test-key', Path(folder), 0, 30)
            self.assertEqual(result['status'], 'succeeded')
            self.assertEqual(request.call_count, 2)
            self.assertTrue(all(call.args[0] == 'GET' for call in request.call_args_list))
            saved = json.loads((Path(folder) / 'task.json').read_text())
            self.assertEqual(saved['status'], 'succeeded')

    def test_failed_generation_stops_with_provider_reason(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch('seedance_video.request_json', return_value={
                'id': 'cgt-example', 'status': 'failed',
                'error': {'code': 'QuotaExceeded', 'message': 'No quota'}}):
                with self.assertRaisesRegex(video.VideoError, 'QuotaExceeded'):
                    video.wait_for_task('cgt-example', 'test-key', Path(folder), 0, 30)

    def test_truncated_download_is_not_published_as_finished_video(self):
        response = io.BytesIO(b'partial-video')
        response.headers = {'Content-Length': '100'}
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / 'video.mp4'
            with patch('seedance_video.urlopen', return_value=response):
                with self.assertRaisesRegex(video.VideoError, 'incomplete'):
                    video.download_video('https://example.com/video.mp4', destination)
            self.assertFalse(destination.exists())
            self.assertTrue(destination.with_suffix('.mp4.part').exists())

    def test_existing_record_prevents_a_second_submission(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'task.json').write_text('{"id":"cgt-existing"}')
            with patch('sys.argv', ['seedance_video.py', '--submit', '--output-dir', folder]):
                with patch('seedance_video.request_json') as request:
                    self.assertEqual(video.main(), 1)
                    request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
