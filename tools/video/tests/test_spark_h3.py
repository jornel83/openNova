import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.video import spark_h3, tool


class SparkVideoTest(unittest.TestCase):
    def test_submit_resume_and_duplicate_guard(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / 'frame.png').write_bytes(b'\x89PNG\r\n\x1a\n')
            config = {'model': spark_h3.MODEL, 'prompt': '转头', 'first_frame_path': 'frame.png'}
            job = 'video_gen_' + '1' * 32
            with patch.object(spark_h3, 'request', side_effect=[
                {'id': job}, {'id': job, 'status': 'in_progress'}, {'id': job, 'status': 'completed'}
            ]) as request, patch.object(tool, 'credential', side_effect=AssertionError('Ark key requested')):
                self.assertEqual(tool.invoke('video_validate', {'config': config}, root)['first_frame'], str(root / 'frame.png'))
                args = {'config': config, 'output_dir': 'clip'}
                self.assertEqual(tool.invoke('video_submit', args, root)['task_id'], job)
                body = request.call_args.kwargs['body']
                self.assertIn(b'name="input_reference"', body)
                self.assertIn('转头'.encode(), body)
                self.assertIn(b'\x89PNG', body)
                with self.assertRaises(tool.VideoError):
                    tool.invoke('video_submit', args, root)
                self.assertEqual(tool.invoke('video_status', {'output_dir': 'clip'}, root)['status'], 'running')
                self.assertEqual(tool.invoke('video_wait', {'output_dir': 'clip'}, root)['status'], 'succeeded')
                self.assertEqual(request.call_count, 3)
                self.assertEqual(json.loads((root / 'clip/task.json').read_text())['provider'], spark_h3.MODEL)
                with self.assertRaises(ValueError):
                    tool.invoke('video_validate', {'config': {**config, 'first_frame': 'asset://asset-no'}}, root)
