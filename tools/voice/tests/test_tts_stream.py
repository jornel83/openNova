import asyncio
import base64
import json
from contextlib import aclosing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tts_stream import synthesize

class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.payload = b'\1\0'*24000
        self.slow = False
        self.cloud = False
        self.error_code = 0
        self.requests = []
        self.closed = threading.Event()
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                owner.requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.send_header('Content-Type','text/event-stream' if owner.cloud else 'audio/pcm')
                self.end_headers()
                try:
                    def send(pcm):
                        if owner.cloud:
                            pcm = ('event: 352\ndata: ' + json.dumps({'code':0,'data':base64.b64encode(pcm).decode()}) + '\n\n').encode()
                        self.wfile.write(pcm); self.wfile.flush()
                    if owner.error_code:
                        self.wfile.write(('data: '+json.dumps({'code':owner.error_code,'message':'private-test-key'})+'\n\n').encode())
                        return
                    if owner.slow:
                        for _ in range(1000):
                            send(b'\1\0'*4096); time.sleep(.01)
                    else: send(owner.payload)
                    if owner.cloud: self.wfile.write(b'event: 152\ndata: {"code":20000000}\n\n')
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

    def cloud_process(self):
        # Keep the real worker, PCM pipes, tempo process and cancellation. Replace
        # only its official endpoint and key with a loopback HTTP fixture in child.
        create = asyncio.create_subprocess_exec
        async def start(executable, script, *args, **kwargs):
            code = (f'import sys;sys.path.insert(0,{str(Path(__file__).resolve().parents[1])!r});'
                    f'import playback,doubao;doubao.ENDPOINT={self.url!r};'
                    'doubao.load_tts_key=lambda:"private-test-key";playback.main()')
            return await create(executable, '-c', code, *args, **kwargs)
        return patch('tts_stream.asyncio.create_subprocess_exec', start)

    async def test_cloud_worker_voice_tempo_and_error_survive_process_boundary(self):
        self.cloud = True
        metrics = {}
        with self.cloud_process():
            chunks = [c async for c in synthesize('你好。','http://127.0.0.1:1',provider='doubao',voice='female-test',metrics=metrics)]
            self.assertGreater(sum(map(len,chunks)),20000)
            self.assertEqual(metrics['provider'],'doubao')
            self.assertEqual(metrics['voice'],'female-test')
            self.assertEqual(metrics['speed'],1.0)
            self.assertEqual(b''.join(chunks),self.payload, 'Cloud defaults to original speed without time stretching')
            self.assertEqual(self.requests[0]['req_params']['speaker'],'female-test')
            self.error_code = 45000030
            with self.assertRaisesRegex(ValueError,'开通.*2.0') as error:
                async for _ in synthesize('你好。','unused',provider='doubao'): pass
            self.assertNotIn('private-test-key',str(error.exception))

    async def test_cloud_cancel_closes_live_http_stream(self):
        self.cloud = self.slow = True
        with self.cloud_process():
            async with aclosing(synthesize('你好。','unused',provider='doubao')) as stream:
                self.assertTrue(await asyncio.wait_for(anext(stream),5))
                self.assertFalse(self.closed.is_set())
            self.assertTrue(await asyncio.to_thread(self.closed.wait,3))

    async def test_cloud_preflight_cancel_closes_http_without_waiting_for_service(self):
        from conversation import check_cloud_tts
        self.cloud = self.slow = True
        args=SimpleNamespace(tts_provider='doubao',tts_voice='female-test',tts_url='unused')
        with self.cloud_process():
            task=asyncio.create_task(check_cloud_tts(args))
            try:
                for _ in range(100):
                    if self.requests: break
                    await asyncio.sleep(.01)
                self.assertTrue(self.requests, 'preflight must have an active cloud request')
            finally:
                task.cancel()
                await asyncio.gather(task,return_exceptions=True)
            self.assertTrue(await asyncio.to_thread(self.closed.wait,3))
