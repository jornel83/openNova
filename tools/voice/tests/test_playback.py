import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playback import speak


class PlaybackTests(unittest.TestCase):
    def test_all_zero_pcm_is_not_successful_speech(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.send_header('Content-Type', 'audio/pcm')
                self.end_headers()
                self.wfile.write(bytes(48000))
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with self.assertRaisesRegex(ValueError, '静音'):
                speak('你好。', url=f'http://127.0.0.1:{server.server_port}', speed=1.5, play=False)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_streamed_pcm_uses_vivian_and_retains_complete_audio(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                seen.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.send_header('Content-Type', 'audio/pcm')
                self.end_headers()
                self.wfile.write(b'\x01\x00' * 24000)
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'reply.wav'
                report = speak('你好。', url=f'http://127.0.0.1:{server.server_port}', speed=1,
                               play=False, output=output)
                self.assertEqual(report['audio_seconds'], 1)
                self.assertEqual(seen[0]['voice'], 'Vivian')
                self.assertEqual(seen[0]['input'], '你好。')
                self.assertGreater(output.stat().st_size, 48000)
                with self.assertRaises(FileExistsError):
                    speak('你好。', url='http://127.0.0.1:1', speed=1, play=False, output=output)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
