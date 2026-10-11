"""Exercise the client/server request contract without a GPU or audio device."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
from threading import Thread
import unittest
import wave


SCRIPT = Path(__file__).resolve().parents[1] / 'probe_http.py'
PCM = struct.pack('<96000h', *(round(10000 * math.sin(2 * math.pi * 440 * i / 24000))
                             for i in range(96000)))


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        requests = self.requests

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                pcm = PCM
                self.send_response(200)
                self.send_header('Content-Type', 'audio/pcm')
                self.send_header('Content-Length', str(len(pcm)))
                self.end_headers()
                self.wfile.write(pcm)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.shutdown)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.output = Path(self.tmp.name) / 'speech.wav'

    def run_probe(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), '--url', f'http://127.0.0.1:{self.server.server_port}',
             '--text', '先休息一会儿吧。', '--output', str(self.output), *args],
            capture_output=True, text=True, timeout=10)

    def test_default_request_selects_vivian_and_preserves_audition_style(self):
        result = self.run_probe()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertIn('qwen3-tts-1.7b-customvoice-bf16/', request['model'])
        self.assertEqual(request['voice'], 'Vivian')
        self.assertEqual(request['instruct'], '用温柔、自然、放松的日常聊天语气说话，语速适中，停顿自然，像在和身边熟悉的人交流。')
        self.assertNotIn('ref_audio', request)
        self.assertNotIn('ref_text', request)
        self.assertTrue(request['stream'])
        self.assertEqual(request['response_format'], 'pcm')
        self.assertEqual(request['temperature'], 0.9)
        self.assertEqual(request['repetition_penalty'], 1.05)
        with wave.open(str(self.output)) as audio:
            self.assertEqual((audio.getframerate(), audio.getnchannels(), audio.getsampwidth()), (24000, 1, 2))
            self.assertAlmostEqual(audio.getnframes() / 24000, 4 / 1.5, delta=0.08)
            samples = struct.unpack('<' + 'h' * audio.getnframes(), audio.readframes(audio.getnframes()))
            middle = samples[12000:36000]
            crossings = sum(a <= 0 < b for a, b in zip(middle, middle[1:]))
            self.assertAlmostEqual(crossings, 440, delta=3, msg='Speed change must preserve pitch')
        report = json.loads(self.output.with_suffix('.json').read_text())
        self.assertEqual(report['voice_profile'], 'vivian')
        self.assertEqual(report['request'], request)
        self.assertEqual(report['playback_speed'], 1.5)
        self.assertEqual(report['source_audio_seconds'], 4.0)
        self.assertNotIn('speed', request, 'Qwen backend ignores numeric speed')

    def test_speed_one_preserves_original_pcm(self):
        result = self.run_probe('--speed', '1')
        self.assertEqual(result.returncode, 0, result.stderr)
        with wave.open(str(self.output)) as audio:
            self.assertEqual(audio.readframes(audio.getnframes()), PCM)

    def test_invalid_speed_is_rejected_before_sending_request(self):
        for speed in ('0', 'nan', '2.5'):
            with self.subTest(speed=speed):
                result = self.run_probe('--speed', speed)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Speed must be between 0.5 and 2.0', result.stderr)
        self.assertEqual(self.requests, [])

    def test_explicit_base_profile_keeps_custom_reference_out_of_vivian(self):
        result = self.run_probe('--voice-profile', 'base', '--reference', '/voices/person.wav',
                                '--reference-text', '这是真人参考录音。')
        self.assertEqual(result.returncode, 0, result.stderr)
        request = self.requests[0]
        self.assertIn('qwen3-tts-1.7b-base-bf16/', request['model'])
        self.assertEqual(request['ref_audio'], '/voices/person.wav')
        self.assertEqual(request['ref_text'], '这是真人参考录音。')
        self.assertNotIn('voice', request)
        self.assertNotIn('instruct', request)

    def test_reference_is_not_silently_ignored_in_vivian_mode(self):
        result = self.run_probe('--reference', '/voices/person.wav', '--reference-text', '参考。')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--voice-profile base', result.stderr)
        self.assertEqual(self.requests, [])
        self.assertFalse(self.output.exists())

    def test_custom_base_reference_requires_matching_transcript(self):
        result = self.run_probe('--voice-profile', 'base', '--reference', '/voices/person.wav')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--reference and --reference-text must be provided together', result.stderr)
        self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
