"""Project admission follows the start of speech, without audio or model services."""
import asyncio
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bot_agent import BotAgent
from continuous import Conversation
from test_continuous import Audio, tts


class ProjectAgent:
    def __init__(self):
        self.state = {'projectId':'alpha','revision':7}
        self.captures = []
        self.submissions = []

    async def project_context(self):
        value = dict(self.state)
        self.captures.append(value)
        return value

    async def stream(self,text,*,expected_project=None):
        self.submissions.append((text,expected_project))
        yield {'type':'delta','text':'好的。','attemptId':'one'}
        yield {'type':'reply','text':'好的。'}


class VoiceProjectTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.agent,self.audio,self.logs = ProjectAgent(),Audio(),[]
        self.c = Conversation(self.agent,self.audio,'unused',synthesize=tts,log=self.logs.append)

    async def asyncTearDown(self):
        await self.c.close()

    async def event(self,kind,ident=1,**fields):
        await self.c.handle({'type':kind,'id':ident,'epoch':self.c.epoch,**fields})

    async def test_late_asr_uses_speech_start_revision_without_refetching(self):
        await self.event('start')
        self.assertEqual(self.agent.captures,[{'projectId':'alpha','revision':7}])
        self.agent.state = {'projectId':'beta','revision':8}
        await self.event('final',text='继续刚才的设计')
        await self.c.wait_idle()
        self.assertEqual(self.agent.submissions,[('继续刚才的设计',{'projectId':'alpha','revision':7})])
        self.assertEqual(self.c.records[-1]['expected_project'],{'projectId':'alpha','revision':7})
        self.assertEqual(len(self.agent.captures),1)

    async def test_multiple_asr_segments_keep_the_first_project_snapshot(self):
        await self.event('start',1)
        await self.event('start',2)
        await self.event('final',2,text='后面再补充结果')
        await self.event('final',1,text='先核对输入')
        await self.c.wait_idle()
        self.assertEqual(self.agent.submissions,[('先核对输入\n后面再补充结果',{'projectId':'alpha','revision':7})])

    async def test_segments_from_different_project_revisions_are_not_silently_merged(self):
        await self.event('start',1)
        self.agent.state = {'projectId':'beta','revision':8}
        await self.event('start',2)
        await self.event('final',1,text='在项目 A 里修改')
        await self.event('final',2,text='另一个补充')
        await self.c.wait_idle()
        self.assertEqual(self.agent.submissions,[])
        self.assertTrue(any('项目已变化' in line and '没有合并提交' in line for line in self.logs))
        self.assertEqual(self.c.voice_state()['capture'],'listening')

    async def test_snapshot_failure_does_not_fall_back_to_current_project_at_send(self):
        async def unavailable(): raise ConnectionError('offline')
        self.agent.project_context = unavailable
        await self.event('start')
        self.agent.project_context = ProjectAgent().project_context
        await self.event('final',text='不能静默提交')
        await self.c.wait_idle()
        self.assertEqual(self.agent.submissions,[])
        self.assertTrue(any('无法确认说话开始时的项目' in line for line in self.logs))

    async def test_mute_cancels_pending_project_lookup_and_late_final(self):
        started = asyncio.Event()
        async def slow():
            started.set()
            await asyncio.Future()
        self.agent.project_context = slow
        await self.event('start')
        await started.wait()
        final = asyncio.create_task(self.event('final',text='迟到的结果'))
        await asyncio.sleep(0)
        await self.c.control('/mute')
        await final
        self.assertEqual(self.agent.submissions,[])
        self.assertEqual(self.c.voice_state()['capture'],'muted')

    async def test_daily_story_continuation_keeps_microphone_active(self):
        for ident,text in [(1,'我昨天碰到一个老朋友'),(2,'他后来去了哪里')]:
            await self.event('start',ident)
            await self.event('final',ident,text=text)
            await self.c.wait_idle()
        self.assertEqual([text for text,_ in self.agent.submissions],['我昨天碰到一个老朋友','他后来去了哪里'])
        self.assertEqual(self.c.voice_state()['capture'],'listening')
        self.assertFalse(self.c.muted)

    async def test_unadmitted_text_from_another_project_is_not_rebound(self):
        await self.c.agent_lock.acquire()
        await self.c.ask('项目 A 的尚未提交内容',expected_project={'projectId':'alpha','revision':7})
        await asyncio.sleep(0)
        await self.c.ask('项目 B 的新内容',expected_project={'projectId':'beta','revision':8})
        self.c.agent_lock.release()
        await self.c.wait_idle()
        self.assertEqual(len(self.agent.submissions),1)
        self.assertNotIn('项目 A 的尚未提交内容',self.agent.submissions[0][0])
        self.assertIn('项目 B 的新内容',self.agent.submissions[0][0])
        self.assertEqual(self.agent.submissions[0][1],{'projectId':'beta','revision':8})
        self.assertTrue(any('上一段尚未提交的语音未合并' in line for line in self.logs))


class BotProjectAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_capture_is_separate_from_stream_and_exact_binding_reaches_ask(self):
        calls=[]
        async def api(path,body):
            calls.append((path,body))
            if path=='/projects': return {'state':{'projectId':'alpha','revision':7,'focus':'daily'}}
            if path=='/ask': return {'status':'queued'}
            return {'status':'completed','text':'他后来回家了','speechText':'他后来回家了'}
        agent=BotAgent(api=api)
        expected=await agent.project_context()
        result=[event async for event in agent.stream('他后来呢',expected_project=expected)]
        self.assertEqual([path for path,_ in calls],['/projects','/ask','/result'])
        self.assertEqual(calls[1][1]['expectedProject'],{'projectId':'alpha','revision':7})
        self.assertEqual(result[-1]['type'],'reply')

    async def test_rejected_old_revision_is_readable_and_does_not_cancel_another_request(self):
        calls=[]
        async def api(path,body):
            calls.append((path,body))
            raise ValueError('project_state_changed')
        agent=BotAgent(api=api)
        with self.assertRaisesRegex(ValueError,'说话期间当前项目已变化.*没有提交'):
            _=[event async for event in agent.stream('迟到的结果',expected_project={'projectId':'alpha','revision':7})]
        self.assertEqual([path for path,_ in calls],['/ask'])
        self.assertIsNone(agent.current)

    async def test_invalid_project_lookup_never_produces_an_unbound_snapshot(self):
        async def api(path,body): return {'state':{'projectId':'alpha','revision':True}}
        with self.assertRaisesRegex(ValueError,'项目状态尚未就绪'):
            await BotAgent(api=api).project_context()


if __name__=='__main__': unittest.main()
