"""Exercise the real SSH job protocol in a temporary Spark home with a CPU test double."""
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools.video import spark_h3, spark_veda, tool


class VedaVideoTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.frame = self.root / 'reference.jpg'
        self.frame.write_bytes(b'\xff\xd8\xff' + b'first frame')
        self.config = {'model': spark_veda.MODEL, 'prompt': '眨眼，然后回正。', 'first_frame_path': self.frame.name}
        self.args = {'config': self.config, 'output_dir': 'local'}

    def test_profile_accepts_only_its_local_frame_contract(self):
        with patch.object(spark_h3, 'run_ssh', side_effect=AssertionError('offline validation called SSH')):
            result = tool.invoke('video_validate', {'config': self.config}, self.root)
            self.assertEqual(result['settings']['frames'], 107)
            self.assertEqual(result['settings']['model'], spark_veda.MODEL)
            for invalid in [{'ratio': 'adaptive'}, {'seed': -1},
                            {'first_frame_path': 'asset://asset-a'}, {'first_frame': 'asset://asset-a'}]:
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    tool.invoke('video_validate', {'config': {**self.config, **invalid}}, self.root)

    def test_rejects_invalid_duration_before_submit_in_both_modes(self):
        text = {'prompt': self.config['prompt'], 'model': spark_veda.MODEL}
        with patch.object(spark_h3, 'run_ssh', side_effect=AssertionError('invalid duration reached Spark')):
            for config in (self.config, text):
                for duration in (3, 16, 4.5, True, '8'):
                    with self.subTest(config=config, duration=duration), self.assertRaisesRegex(ValueError, 'duration'):
                        tool.invoke('video_submit', {**self.args, 'config': {**config, 'duration': duration}}, self.root)

    def test_detached_job_keeps_identity_across_lost_ack_and_downloads_verified_clip(self):
        host = self.root / 'spark'
        for folder in ['bin', 'h3-deploy', 'h3-veda/data/models', 'h3-veda/control-t6-s90-20261122a']:
            (host/folder).mkdir(parents=True)
        (host/'bin/nvidia-smi').write_text('#!/bin/sh\nexit 0\n')
        if not shutil.which('flock'):
            # macOS test hosts do not ship the Linux flock command.
            (host/'bin/flock').write_text("""#!/usr/bin/env python3
import fcntl,sys
if sys.argv[1] == '-x':
    fcntl.flock(int(sys.argv[2]), fcntl.LOCK_EX)
else:
    with open(sys.argv[2]) as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: sys.exit(1)
""")
        (host/'bin/docker').write_text("""#!/usr/bin/env python3
import json,sys
from pathlib import Path
assert 'run' in sys.argv and sys.argv[-1] == 'generate'
jit_mount = next(arg for arg in sys.argv if arg.startswith('/run/veda-jit:'))
assert 'size=2g' in jit_mount.split(':')[1].split(',')
assert 'CUDA_CACHE_MAXSIZE=536870912' in sys.argv
graph = json.loads(Path('workflow.json').read_text())
assert graph['conditioning']['class_type'] == 'MiniMaxH3ImageToVideo'
assert graph['conditioning']['inputs']['first_frame'] == ['first_frame',0]
assert graph['guider']['inputs']['model'] == ['veda',0]
assert graph['veda']['inputs']['generated_sparsity'] == graph['veda']['inputs']['reference_sparsity'] == '90%'
Path('output/clip_00001_.mp4').write_bytes(b'test clip bytes')
job = json.loads(Path('job.json').read_text())
Path('output/receipt.json').write_text(json.dumps({'first_frame_sha256':job['first_frame_sha256']}))
""")
        for binary in (host/'bin').iterdir():
            binary.chmod(0o700)

        def local_ssh(_host, command, *, body=None, output=None):
            result = subprocess.run(['sh', '-c', command], cwd=host, input=body or b'',
                env={**os.environ, 'HOME': str(host), 'PATH': str(host/'bin') + os.pathsep + os.environ['PATH']},
                stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=10)
            if body is not None:
                raise OSError('simulated lost SSH response after accepting the job')
            return json.loads(result.stdout) if output is None else None

        with patch.object(spark_h3, 'run_ssh', side_effect=local_ssh), patch.object(tool, 'credential',
                side_effect=AssertionError('Veda requested Ark credentials')):
            with self.assertRaisesRegex(OSError, 'lost SSH response'):
                tool.invoke('video_submit', self.args, self.root)
            state = json.loads((self.root/'local/task.json').read_text())
            job = state['id']
            self.assertRegex(job, r'^veda_[0-9a-f]{32}$')
            self.assertEqual(state['status'], 'submission_not_confirmed')
            with self.assertRaisesRegex(tool.VideoError, 'already exists'):
                tool.invoke('video_submit', self.args, self.root)
            completed = tool.invoke('video_wait', {'output_dir': 'local', 'poll_seconds': 1, 'timeout_seconds': 10}, self.root)
            self.assertEqual((completed['task_id'], completed['status']), (job, 'succeeded'))
            remote = host / spark_veda.job_directory(job)
            graph = json.loads((remote/'workflow.json').read_text())
            self.assertEqual(graph['conditioning']['inputs']['prompt'], self.config['prompt'])
            self.assertEqual((remote/'input/frame.jpg').read_bytes(), self.frame.read_bytes())
            self.assertEqual(completed['task']['first_frame_sha256'], hashlib.sha256(self.frame.read_bytes()).hexdigest())
            with patch.object(tool, 'probe_video', return_value={'fps': 24}):
                downloaded = tool.invoke('video_download', {'output_dir': 'local'}, self.root)
                self.assertEqual(Path(downloaded['path']).read_bytes(), b'test clip bytes')
                (remote/'output/clip_00001_.mp4').write_bytes(b'incomplete')
                with self.assertRaisesRegex(tool.VideoError, 'digest mismatch'):
                    tool.invoke('video_download', {'output_dir': 'local', 'filename':'retry.mp4'}, self.root)
                self.assertFalse((self.root/'local/retry.mp4').exists())
            absent = spark_veda.status('test', 'veda_' + '0' * 32)
            self.assertEqual(absent['status'], 'failed')
