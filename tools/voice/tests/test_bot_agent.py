import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bot_agent import BotAgent

class BotAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_search_calls_produce_distinct_progress_and_sources_reach_reply(self):
        polls=iter([
            {'status':'running','tool':'web_search','research':{'phase':'searching','callId':'c1'}},
            {'status':'running','tool':'web_search','research':{'phase':'searching','callId':'c2'}},
            {'status':'running','tool':'web_fetch','research':{'phase':'reading','callId':'c3'}},
            {'status':'completed','text':'北京20℃','speechText':'北京20℃','sources':[{'id':'s1','url':'https://example.com'}]},
        ])
        async def api(path,body):
            return next(polls) if path=='/result' else {}
        events=[e async for e in BotAgent(api=api).stream('北京天气')]
        self.assertEqual([e['phase'] for e in events if e['type']=='status'],['searching','searching','reading'])
        self.assertEqual(events[-1]['sources'][0]['id'],'s1')

    async def test_reply_and_close_do_not_stop_the_host(self):
        calls=[]
        async def api(path,body):
            calls.append((path,body))
            if path=='/health':return {'sessionId':'same-bot'}
            if path=='/ask':return {'status':'queued'}
            if path=='/result':return {'status':'completed','text':'你好','speechText':'你好'}
        a=BotAgent(api=api)
        self.assertEqual((await a.start())['outputMode'],'settled-answer')
        events=[e async for e in a.stream('你好')]
        self.assertEqual(events[-1]['text'],'你好')
        self.assertEqual(events[0]['type'],'request')
        self.assertEqual(events[0]['id'],events[-1]['id'])
        await a.close()
        self.assertFalse(any(p in ('/shutdown','/voice/cancel-request') for p,_ in calls))

    async def test_interruption_cancels_foreground_only_not_independent_tasks(self):
        calls=[];waiting=asyncio.Event()
        async def api(path,body):
            calls.append((path,body))
            if path=='/ask':return {'status':'queued'}
            if path=='/result':waiting.set();await asyncio.Future()
            if path=='/voice/cancel-request':return {'status':'cancelled'}
        a=BotAgent(api=api)
        async def consume():
            async for _ in a.stream('start'):pass
        task=asyncio.create_task(consume());await waiting.wait();task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        self.assertTrue(any(p=='/voice/cancel-request' for p,_ in calls))
        self.assertFalse(any(p=='/cancel-task' for p,_ in calls))

    async def test_control_task_status_and_explicit_cancel(self):
        calls=[]
        async def api(path,body):calls.append((path,body));return {'status':'cancelled'}
        a=BotAgent(api=api)
        await a.control('/cancel-task task-1')
        self.assertEqual(calls,[('/cancel-task',{'id':'task-1'})])
        self.assertIsNone(await a.control('/mute'))

    async def test_failed_result_is_not_spoken(self):
        async def api(path,body):return {'status':'failed','error':'model_unavailable'}
        a=BotAgent(api=api)
        with self.assertRaisesRegex(ValueError,'model_unavailable'):
            _=[e async for e in a.stream('hello')]

    async def test_operations_include_native_project_and_shell_records(self):
        calls=[]
        async def api(path,body):
            calls.append(path)
            return [{'kind':'tool','tool':'bash','status':'completed','exitCode':0}]
        rows=await BotAgent(api=api).control('/operations')
        self.assertEqual(calls,['/operations'])
        self.assertEqual(rows[0]['tool'],'bash')
