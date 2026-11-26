"""Fixed CLI envelope input bounds; no model or service calls."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class CliInputTests(unittest.TestCase):
    def call_file(self, path):
        run = subprocess.run([sys.executable, str(ROOT / 'tools/image/tool.py'), '--request', str(path)],
                             cwd=ROOT, capture_output=True, text=True, timeout=3)
        self.assertEqual(run.returncode, 1, run.stderr)
        self.assertEqual(run.stderr, '')
        return json.loads(run.stdout)['error']['code']

    def test_large_file_read_is_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'large.json'
            with path.open('wb') as stream:
                stream.truncate(128 * 1024 * 1024)
            self.assertEqual(self.call_file(path), 'request_too_large')

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'requires POSIX')
    def test_fifo_envelope_fails_without_blocking(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'pipe.json'
            os.mkfifo(path)
            self.assertEqual(self.call_file(path), 'request_file_must_be_regular')

    def test_invalid_context_is_structured_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'request.json'
            path.write_text(json.dumps({'tool': 'media_export', 'arguments': {}, 'context': {'apiKey': 'not-used'}}))
            self.assertEqual(self.call_file(path), 'invalid_host_context')


if __name__ == '__main__':
    unittest.main()
