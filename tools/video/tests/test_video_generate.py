"""Exercise the high-level tool across dispatch, recovery and actual MP4 delivery."""
import base64
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from tools.video import spark_h3, spark_veda, tool


class VideoGenerateTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.config = {'prompt': '慢慢转头。', 'duration': 4}
        self.job = 'cgt-offline'
        self.start = {'config': self.config, 'output_dir': 'shot', 'timeout_seconds': 0}
        self.resume = {'task_id': self.job, 'output_dir': 'shot', 'timeout_seconds': 0}
        self.addCleanup(patch.stopall)
        patch.dict('os.environ', {'ARK_API_KEY': 'test-secret'}).start()

    def generate(self, request):
        return tool.invoke('video_generate', request, self.root)

    def source_clip(self, frames):
        p = self.root / f'fixture-{frames}.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x96:r=24',
                        '-frames:v', str(frames), '-c:v', 'libx264', str(p)], check=True)
        return p

    def test_seedance_first_frame_exact_bytes_and_modes(self):
        (self.root/'media').mkdir()
        frame = self.root/'media'/'人像.jpg'
        frame.write_bytes(bytes.fromhex('ffd8ffe0') + b'reference')
        config = {**self.config, 'first_frame_path': frame.name}
        (frame.parent/'config.json').write_text(json.dumps(config))
        with patch.object(tool, 'request_json', side_effect=[{'id': self.job}, {'status': 'queued'}]) as api:
            self.generate({'config_path': 'media/config.json', 'output_dir': 'shot', 'timeout_seconds': 0})
        payload = api.call_args_list[0].args[-1]
        self.assertEqual(payload['ratio'], 'adaptive')
        ref = payload['content'][1]
        self.assertEqual(ref['role'], 'first_frame')
        self.assertEqual(ref['image_url']['url'], 'data:image/jpeg;base64,' + base64.b64encode(frame.read_bytes()).decode())
        self.assertNotIn('base64', (self.root/'shot/config.json').read_text())
        frame.write_bytes(frame.read_bytes()+b'changed')
        with self.assertRaisesRegex(tool.VideoError, 'different configuration'):
            self.generate({'config_path': 'media/config.json', 'output_dir': 'shot'})
        for changes in ({'reference_images': [frame.name]}, {'first_frame': 'asset://asset-a', 'model': 'ep-model'}):
            with self.assertRaises(tool.VideoError):
                tool.build_payload({**config, **changes}, frame.parent)
        frame.write_bytes(b'not a PNG or JPEG')
        with self.assertRaisesRegex(tool.VideoError, 'PNG or JPEG'):
            tool.build_payload(config, frame.parent)

    def test_ambiguous_submission_and_missing_state_never_repost(self):
        with patch.object(tool, 'request_json', side_effect=tool.RetryableVideoError('interrupted')) as api:
            with self.assertRaisesRegex(tool.VideoError, 'interrupted'):
                self.generate(self.start)
            with self.assertRaisesRegex(tool.VideoError, 'No valid task ID'):
                self.generate(self.start)
            (self.root/'shot/task.json').unlink()
            with self.assertRaisesRegex(tool.VideoError, 'missing its task state'):
                self.generate(self.start)
            self.assertEqual(api.call_count, 1)

    def test_reject_wrong_id_and_conflicting_operations(self):
        with patch.object(tool, 'request_json', side_effect=[{'id': self.job}, {'status': 'running'}]) as api:
            self.assertEqual(self.generate(self.start)['task_id'], self.job)
            for args in ({**self.resume, 'task_id': 'someone-else'}, {**self.resume, 'filename': 'other.mp4'},
                         {**self.start, 'config': {**self.config, 'duration': 6}},
                         {**self.resume, 'config': self.config}, {**self.resume, 'output_dir': 'unrelated'}):
                with self.subTest(args=args), self.assertRaises(tool.VideoError):
                    self.generate(args)
            self.assertEqual(api.call_count, 2)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'requires FFmpeg')
    def test_transient_poll_and_download_recover_same_id_and_replay_without_network(self):
        source = self.source_clip(96)
        done = {'status': 'succeeded', 'content': {'video_url': 'https://storage.invalid/video'}}
        with patch.object(tool, 'request_json', side_effect=[
                {'id': self.job}, tool.RetryableVideoError('interrupted'), dict(done), dict(done)]) as api:
            first = self.generate(self.start)
            self.assertEqual((first['task_id'], first['status'], first['phase']), (self.job, 'running', 'polling'))
            self.assertEqual(api.call_args_list[0].args[-1]['content'], [{'type': 'text', 'text': self.config['prompt']}])
            with patch.object(tool, 'download_video', side_effect=OSError('storage interrupted')):
                self.assertEqual(self.generate(self.resume)['phase'], 'downloading')
            with patch.object(tool, 'download_video', side_effect=lambda _, dest: shutil.copy(source, dest)):
                result = self.generate(self.resume)
            self.assertEqual([call.args[0] for call in api.call_args_list], ['POST', 'GET', 'GET', 'GET'])
        clip = Path(result['path'])
        self.assertEqual((result['status'], result['task_id'], result['metadata']['duration']),
                         ('succeeded', self.job, 4.0))
        self.assertEqual((result['size_bytes'], result['sha256']),
                         (clip.stat().st_size, hashlib.sha256(source.read_bytes()).hexdigest()))
        with patch.object(tool, 'request_json', side_effect=AssertionError('unexpected API call')), \
                patch.dict('os.environ', {'ARK_API_KEY': ''}):
            self.assertEqual(self.generate(self.resume), result)
            self.assertEqual(self.generate(self.start), result)
            clip.write_bytes(b'changed')
            with self.assertRaisesRegex(tool.VideoError, 'cannot overwrite'):
                self.generate(self.resume)
            self.assertEqual(clip.read_bytes(), b'changed')

    def test_cloud_terminal_failure_returns_provider_error(self):
        with patch.object(tool, 'request_json', side_effect=[
                {'id': self.job}, {'status': 'failed', 'error': {'message': 'Frame rejected'}}]):
            result = self.generate(self.start)
            self.assertEqual(result['status'], 'failed')
            self.assertIn('Frame rejected', result['error'])

    def test_veda_text_and_first_frame_archives_for_each_duration(self):
        frame_path = self.root / 'drop.png'
        frame_path.write_bytes(b'\x89PNG\r\n\x1a\n' + b'water drop')
        aligned_frames = (107, 124, 158, 175, 192, 226, 243, 277, 294, 328, 345, 362)
        for mode in ('text', 'first_frame'):
            for seconds, frames in enumerate(aligned_frames, start=4):
                with self.subTest(mode=mode, seconds=seconds):
                    config = {**self.config, 'model': spark_veda.MODEL, 'duration': seconds}
                    if mode == 'first_frame':
                        config['first_frame_path'] = frame_path.name
                    valid = tool.invoke('video_validate', {'config': config}, self.root)
                    self.assertEqual(valid['generation_mode'], mode)
                    frame, fields = spark_veda.prepare(config, self.root)
                    with patch.object(spark_h3, 'run_ssh', return_value={}) as ssh:
                        spark_veda.submit('mock-host', 'veda_' + 'a'*32, frame, fields)
                    with tarfile.open(fileobj=io.BytesIO(ssh.call_args.kwargs['body'])) as archive:
                        graph = json.load(archive.extractfile('workflow.json'))
                        job = json.load(archive.extractfile('job.json'))
                        if mode == 'first_frame':
                            self.assertEqual(archive.extractfile('input/frame.png').read(), frame_path.read_bytes())
                            self.assertEqual(job['first_frame_sha256'], tool.digest_file(frame_path))
                            self.assertEqual(graph['conditioning']['inputs']['first_frame'], ['first_frame', 0])
                        else:
                            self.assertFalse(any(name.startswith('input/') for name in archive.getnames()))
                            self.assertNotIn('first_frame_sha256', job)
                            self.assertNotIn('first_frame', graph)
                            self.assertNotIn('first_frame', graph['conditioning']['inputs'])
                    self.assertEqual(graph['conditioning']['inputs']['length'], frames)
                    self.assertEqual(graph['summary']['inputs']['frames'], frames)
                    self.assertEqual(graph['guider']['inputs']['model'], ['veda', 0])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'requires FFmpeg')
    def test_veda_lost_ack_delivers_verified_exact_duration(self):
        for seconds, frames in ((4, 107), (6, 158), (8, 192), (15, 362)):
            with self.subTest(seconds=seconds):
                clip = self.source_clip(frames)
                content = clip.read_bytes()
                output = 'shot-' + str(seconds)
                def get_status(host, job_id):
                    return {'id': job_id, 'status': 'completed', 'sha256': hashlib.sha256(content).hexdigest()}
                with patch.object(spark_veda, 'submit', side_effect=OSError('lost reply')) as submit, \
                        patch.object(spark_veda, 'status', side_effect=get_status), \
                        patch.object(spark_veda, 'download', side_effect=lambda host, job, file: file.write(content)), \
                        patch.object(tool, 'credential', side_effect=AssertionError('local task requested Ark key')):
                    result = self.generate({'config': {**self.config, 'duration': seconds, 'model': spark_veda.MODEL},
                                            'output_dir': output, 'timeout_seconds': 0})
                self.assertEqual(submit.call_count, 1)
                self.assertEqual((result['status'], result['metadata']['duration']), ('succeeded', seconds))
                self.assertEqual(result['sha256'], tool.digest_file(Path(result['path'])))
                self.assertNotIn('first_frame_path', json.loads((self.root/output/'config.json').read_text()))


if __name__ == '__main__':
    unittest.main()
