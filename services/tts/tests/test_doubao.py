import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import doubao


def event(code=0, data=None, kind=352, **extra):
    return (f'event: {kind}\r\ndata: ' + json.dumps(
        {'code': code, 'data': data, **extra}) + '\r\n\r\n').encode()


@contextmanager
def server(body, status=200, content_type='text/event-stream'):
    seen = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            seen.append((dict(self.headers), json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Location', 'http://127.0.0.1:1/steal')
            self.end_headers()
            for i in range(0, len(body), 19):
                self.wfile.write(body[i:i+19])
    http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        with patch.object(doubao, 'ENDPOINT', f'http://127.0.0.1:{http.server_port}/tts'), \
             patch.object(doubao, 'load_tts_key', return_value='private-test-key'):
            yield seen
    finally:
        http.shutdown(); http.server_close(); thread.join()


class DoubaoTests(unittest.TestCase):
    def test_real_http_request_decodes_sse_and_preserves_audio(self):
        pcm = b'\1\0' * 900
        body = b': heartbeat\n\n' + event(data=base64.b64encode(pcm).decode()) + \
            event(kind=351, sentence={'text': '你好'}) + event(20000000, kind=152)
        with server(body) as seen:
            with doubao.stream_pcm('你好', 'zh_female_vv_uranus_bigtts') as chunks:
                self.assertEqual(b''.join(chunks), pcm)
        headers, request = seen[0]
        self.assertEqual(headers['X-Api-Key'], 'private-test-key')
        self.assertEqual(headers['X-Api-Resource-Id'], 'seed-tts-2.0')
        self.assertEqual(request['req_params']['audio_params'],
                         {'format': 'pcm', 'sample_rate': 24000, 'speech_rate': 0})

    def test_business_error_has_actionable_message_without_reflecting_secrets(self):
        with server(event(45000030, message='private-test-key requested resource not granted')):
            with self.assertRaisesRegex(doubao.DoubaoTTSError, '开通.*2.0') as error:
                with doubao.stream_pcm('你好', 'voice') as chunks: list(chunks)
            self.assertNotIn('private-test-key', str(error.exception))

    def test_truncation_bad_base64_odd_empty_and_cancel_are_not_success(self):
        for body in [event(data='AQ=='), event(data='!!!') + event(20000000),
                     event(20000000), event(data='AQ==') + event(20000000),
                     event(kind=151), b'data: invalid\n\n', b'data: []\n\n']:
            with self.subTest(body=body), self.assertRaises(doubao.DoubaoTTSError):
                list(doubao.decode_sse(io.BytesIO(body)))

    def test_sse_is_incremental_and_bounded(self):
        source = io.BytesIO(event(data='AQA=') + event(20000000))
        chunks = doubao.decode_sse(source)
        self.assertEqual(next(chunks), b'\1\0')
        self.assertLess(source.tell(), len(source.getvalue()))
        self.assertEqual(list(chunks), [])
        with self.assertRaises(doubao.DoubaoTTSError):
            list(doubao.decode_sse(io.BytesIO(b'data: ' + b'x' * (2 * 1024 * 1024))))

    def test_http_errors_and_redirects_never_reflect_body(self):
        for code in (401, 403, 429, 500, 307):
            with self.subTest(code=code), server(b'private-test-key', status=code):
                with self.assertRaises(doubao.DoubaoTTSError) as error:
                    with doubao.stream_pcm('你好', 'voice') as chunks: list(chunks)
                self.assertNotIn('private-test-key', str(error.exception))

    def test_key_precedence_uses_shared_saved_key_without_modifying_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'secrets.json'
            path.write_text(json.dumps({'doubao': {'api_key': 'shared'}}))
            env = {'OPENNOVA_SECRETS_FILE': str(path)}
            self.assertEqual(doubao.load_tts_key(environ=env), 'shared')
            path.write_text(json.dumps({'doubao': {'api_key': 'shared', 'tts_api_key': 'tts'}}))
            self.assertEqual(doubao.load_tts_key(environ=env), 'tts')
            self.assertEqual(doubao.load_tts_key(environ={**env, 'DOUBAO_TTS_API_KEY': 'env'}), 'env')
            path.write_text('{broken private-test-key')
            with self.assertRaises(doubao.DoubaoTTSError) as error: doubao.load_tts_key(environ=env)
            self.assertNotIn('private-test-key', str(error.exception))

    def test_malformed_key_is_rejected_before_http_can_echo_header_value(self):
        for key in ('private\nkey', 'private\x00key', '私密key'):
            with self.assertRaisesRegex(doubao.DoubaoTTSError, '格式') as error:
                doubao.load_tts_key(environ={'DOUBAO_TTS_API_KEY': key})
            self.assertNotIn(key, str(error.exception))
