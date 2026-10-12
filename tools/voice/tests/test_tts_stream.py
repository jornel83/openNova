import asyncio
from contextlib import aclosing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import time
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tts_stream import synthesize

class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.payload = b'\1\0'*24000
        self.slow = False
        self.closed = threading.Event()
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.send_header('Content-Type','audio/pcm')
                self.end_headers()
                try:
                    if owner.slow:
                        for _ in range(1000):
                            self.wfile.write(b'\1\0'*4096); self.wfile.flush(); time.sleep(.01)
                    else: self.wfile.write(owner.payload)
                except (BrokenPipeError,ConnectionResetError): pass
                finally: owner.closed.set()
        self.server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
    async def asyncTearDown(self):
        await asyncio.to_thread(self.server.shutdown)
        self.server.server_close()
        self.thread.join()
    async def test_pcm_arrives_before_eof_and_cancel_closes_http(self):
        self.slow = True
        stream = synthesize('你好。',self.url)
        async with aclosing(stream):
            data = await asyncio.wait_for(anext(stream),5)
            self.assertTrue(data)
            self.assertFalse(self.closed.is_set())
        self.assertTrue(await asyncio.to_thread(self.closed.wait,3))
    async def test_invalid_empty_and_silent_pcm_are_errors(self):
        for payload in (b'',b'\1',b'\0'*48000):
            self.payload = payload
            with self.assertRaises(ValueError):
                async for _ in synthesize('你好。',self.url): pass
    async def test_tempo_stream_keeps_pcm_and_reports_speed(self):
        metrics = {}
        chunks = [chunk async for chunk in synthesize('你好。',self.url,metrics=metrics)]
        self.assertGreater(sum(map(len,chunks)),20000)
        self.assertEqual(metrics['speed'],1.5)
        self.assertFalse(metrics['played'])
