import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from stream_agent import StreamingAgent
from agent import failure_message

class AgentTests(unittest.IsolatedAsyncioTestCase):
    def test_retrieval_timeout_explains_the_budget_instead_of_a_service_fault(self):
        message=failure_message({'code':'web_time_budget','stage':'conversation'})
        self.assertIn('检索',message)
        self.assertIn('时间预算',message)
        self.assertNotIn('依赖',message)
    async def test_web_flag_and_ready_mode_are_preserved(self):
        agent=StreamingAgent(web=True)
        stdout=asyncio.StreamReader();stdout.feed_data(b'{"type":"ready","outputMode":"settled-answer"}\n')
        process=SimpleNamespace(stdout=stdout,returncode=0)
        spawn=AsyncMock(return_value=process)
        with patch('stream_agent.asyncio.create_subprocess_exec',spawn),patch('stream_agent.shutil.which',return_value='/node'):
            await agent.start()
        self.assertIn('--web',spawn.await_args.args);self.assertEqual(agent.output_mode,'settled-answer')
        with patch('stream_agent.stop_process',AsyncMock()): await agent.close()
    async def test_idle_disconnect_fails_next_request_immediately(self):
        agent = StreamingAgent()
        agent.ready = asyncio.get_running_loop().create_future()
        agent.ready.set_result({'type':'ready'})
        stdout = asyncio.StreamReader(); stdout.feed_eof()
        agent.process = SimpleNamespace(stdout=stdout,returncode=0)
        agent._send = AsyncMock()
        agent.reader = asyncio.create_task(agent._read())
        await agent.reader
        with self.assertRaises(ValueError):
            await asyncio.wait_for(anext(agent.stream('你好')), .1)

    async def test_cancel_terminal_unblocks_generator_and_next_turn(self):
        agent = StreamingAgent()
        agent.ready = asyncio.get_running_loop().create_future(); agent.ready.set_result({})
        stdout = asyncio.StreamReader()
        agent.process = SimpleNamespace(stdout=stdout,returncode=0)
        async def send(event):
            if event['type'] == 'ask':
                stdout.feed_data((f'{{"type":"delta","id":{event["id"]},"text":"你好"}}\n').encode())
            else:
                stdout.feed_data((f'{{"type":"cancelled","id":{event["id"]}}}\n').encode())
        agent._send = send
        agent.reader = asyncio.create_task(agent._read())
        try:
            stream = agent.stream('第一轮')
            self.assertEqual((await anext(stream))['type'],'delta')
            await stream.aclose()
            self.assertIsNone(agent.current)
            stream = agent.stream('第二轮')
            self.assertEqual((await anext(stream))['id'],2)
            await stream.aclose()
        finally:
            agent.reader.cancel()
            await asyncio.gather(agent.reader,return_exceptions=True)
