import asyncio
import os
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent import Agent, stop_process


class ProcessTests(unittest.IsolatedAsyncioTestCase):
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
