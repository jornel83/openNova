import asyncio
import os
import json
from pathlib import Path
import sys
import tempfile
import subprocess
import textwrap
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent import Agent, stop_process


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_exited_process_pipes_and_cancelled_prefetch_close_before_loop_gc(self):
        # Run in a separate interpreter so GC occurs AFTER asyncio.run closes
        # its loop, reproducing the live /quit warning instead of masking it
        # through IsolatedAsyncioTestCase's own asynchronous cleanup.
        script=textwrap.dedent('''
            import asyncio,gc,sys
            from contextlib import aclosing
            from unittest.mock import patch
            sys.path.insert(0,sys.argv[1])
            from agent import Agent,stop_process
            from speech_pipeline import prepare_speech
            import tts_stream
            held=[]
            create=asyncio.create_subprocess_exec
            code='import os,time; [(os.write(1,b"x"*4096),os.write(2,b"y"*4096)) for _ in range(512)];time.sleep(60)'
            async def start(*args,**kwargs):
                p=await create(sys.executable,'-c',code,**kwargs)
                held.append(p)
                return p
            def closed(p):
                assert p.returncode is not None
                assert p.stdout.at_eof() and p.stderr.at_eof()
                assert p.stdin.is_closing()
            async def run():
                p=await start(stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,
                              stderr=asyncio.subprocess.PIPE,limit=1024,start_new_session=True)
                await asyncio.sleep(.15)
                p.terminate()
                for _ in range(100):
                    if p.returncode is not None:break
                    await asyncio.sleep(.01)
                assert p.returncode is not None
                assert not p.stdout.at_eof() and not p.stderr.at_eof()
                # Agent.close must also clean an already-exited worker.
                owner=Agent();owner.process=p;await owner.close();closed(p)
                items=asyncio.Queue()
                for n in range(3):items.put_nowait((n+1,'sentence',False))
                items.put_nowait(None)
                def synth(text,metrics):return tts_stream.synthesize(text,'unused',metrics=metrics)
                cleanup_started=asyncio.Event();release_cleanup=asyncio.Event()
                async def delayed_stop(p):
                    cleanup_started.set()
                    await release_cleanup.wait()
                    await stop_process(p)
                with patch('tts_stream.asyncio.create_subprocess_exec',start),patch('tts_stream.stop_process',delayed_stop):
                    jobs=prepare_speech(items,synth,lambda:True,lambda item:{})
                    first=await anext(jobs)
                    for _ in range(100):
                        if len(held)==3 and first.queue.full():break
                        await asyncio.sleep(.01)
                    assert len(held)==3
                    assert first.queue.full()
                    # /quit owns current + lookahead. A second cancellation
                    # during cleanup must not interrupt process pipe drainage.
                    closing=asyncio.create_task(jobs.aclose())
                    await cleanup_started.wait()
                    closing.cancel()
                    await asyncio.sleep(0)
                    release_cleanup.set()
                    outcome=await asyncio.gather(closing,return_exceptions=True)
                    assert isinstance(outcome[0],asyncio.CancelledError)
                    for p in held:closed(p)
            asyncio.run(run())
            held.clear();gc.collect()
            print('pipes-clean')
        ''')
        result=await asyncio.to_thread(subprocess.run,[sys.executable,'-W','error::ResourceWarning','-c',script,
                                        str(Path(__file__).resolve().parents[1])],capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('pipes-clean',result.stdout)
        self.assertEqual(result.stderr,'',result.stderr)

    async def test_explicit_node_override_launches_selected_runtime(self):
        agent = Agent()
        with patch.dict(os.environ, {'OPENNOVA_NODE':'/chosen/node'}), \
             patch('agent.shutil.which', side_effect=lambda name: '/chosen/node' if name == '/chosen/node' else '/default/node'), \
             patch('agent.asyncio.create_subprocess_exec', new_callable=AsyncMock) as spawn, \
             patch.object(agent, 'read', new_callable=AsyncMock, return_value={'type':'ready'}):
            await agent.start()
        self.assertEqual(spawn.call_args.args[0], '/chosen/node')

    async def test_error_response_names_model_stage_and_http_status(self):
        agent = Agent()
        stdout = asyncio.StreamReader()
        stdout.feed_data(json.dumps({'type':'error','code':'api_error','stage':'model_catalog','status':403}).encode()+b'\n')
        agent.process = SimpleNamespace(stdout=stdout)
        with self.assertRaises(ValueError) as caught:
            await agent.read()
        self.assertIn('GPT 模型列表', str(caught.exception))
        self.assertIn('HTTP 403', str(caught.exception))

    async def test_error_response_never_displays_arbitrary_protocol_fields(self):
        agent = Agent()
        stdout = asyncio.StreamReader()
        stdout.feed_data(json.dumps({'type':'error','code':'private_secret','stage':'private_secret','status':'private_secret'}).encode()+b'\n')
        agent.process = SimpleNamespace(stdout=stdout)
        with self.assertRaises(ValueError) as caught:
            await agent.read()
        self.assertNotIn('private_secret', str(caught.exception))

    async def test_cleanup_reaches_descendant_after_leader_has_exited(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'descendant.pid'
            child_code = 'import time; time.sleep(60)'
            parent_code = f'import subprocess,sys,pathlib; p=subprocess.Popen([sys.executable,"-c",{child_code!r}]); pathlib.Path({str(path)!r}).write_text(str(p.pid))'
            process = await asyncio.create_subprocess_exec(sys.executable, '-c', parent_code, start_new_session=True)
            await process.wait()
            pid = int(path.read_text())
            try:
                await stop_process(process)
                for _ in range(30):
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        break
                    await asyncio.sleep(.02)
                else:
                    self.fail('descendant survives cleanup')
            finally:
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass
