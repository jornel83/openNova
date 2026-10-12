import asyncio
from contextlib import aclosing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tts_stream import synthesize

class BackpressureTests(unittest.IsolatedAsyncioTestCase):
    async def test_paused_consumer_can_resume_after_old_five_second_drain_timeout(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200); self.send_header('Content-Type','audio/pcm'); self.end_headers()
                self.wfile.write(b'\1\0'*160000)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            stream=synthesize('暂停后继续。',f'http://127.0.0.1:{server.server_port}')
            async with aclosing(stream):
                received=len(await anext(stream))
                await asyncio.sleep(6)
                async for chunk in stream: received+=len(chunk)
            self.assertGreater(received,150000)
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close();thread.join()
