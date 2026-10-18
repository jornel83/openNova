import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from continuous import Conversation


class Audio:
    def __init__(self): self.calls=[]; self.generation=0; self.frames=0
    async def pause(self): self.calls.append('pause')
    async def resume(self): self.calls.append('resume')
    async def clear(self,generation): self.generation=generation; self.calls.append('clear')
    async def capture(self,enabled,epoch): self.calls.append(('capture',enabled,epoch))
    async def write(self,pcm,generation,segment):
        self.calls.append(('pcm',generation)); return generation==self.generation
    async def drained(self,generation): pass

class Agent:
    def __init__(self): self.prompts=[]; self.cancelled=0; self.fail=False; self.hold=False
    async def stream(self,text):
        self.prompts.append(text)
        try:
            yield {'type':'delta','text':'你好。','attemptId':'one'}
            if self.hold: await asyncio.sleep(30)
            if self.fail: raise ValueError('model failed')
            yield {'type':'reply','text':'你好。'}
        except asyncio.CancelledError:
            self.cancelled+=1
            raise

async def tts(text,url,speed=1.5,metrics=None):
    yield b'\1\0'*100


class ControllerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.agent, self.audio = Agent(), Audio()
        self.controller=Conversation(self.agent,self.audio,'http://unused',synthesize=tts,log=lambda _:None)
    async def asyncTearDown(self): await self.controller.close()
    async def event(self,kind,ident=1,epoch=0,**fields):
        await self.controller.handle({'type':kind,'id':ident,'epoch':epoch,**fields})
    async def submit(self,ident=1,text='你好'):
        await self.event('start',ident)
        await self.event('end',ident)
        await self.event('final',ident,text=text)
    async def settle(self):
        await self.controller.wait_idle()
    async def test_false_candidate_resumes_same_generation(self):
        self.agent.hold=True
        await self.submit()
        await asyncio.sleep(.01)
        generation=self.controller.generation
        await self.event('start',2)
        await self.event('evidence',2,acoustic={'strong_ms':320})
        await self.event('failed',2,error='empty')
        self.assertIn('pause', self.audio.calls)
        self.assertIn('resume', self.audio.calls)
        self.assertEqual(self.controller.generation,generation)
    async def test_revision_not_concatenated_and_final_only(self):
        await self.event('start')
        await self.event('partial',text='用英文')
        await self.event('partial',text='用中文')
        self.assertEqual(self.agent.prompts,[])
        await self.event('end')
        await self.event('final',text='用中文')
        await self.settle()
        self.assertEqual(self.agent.prompts,['用中文'])
    async def test_mute_rejects_old_final(self):
        await self.event('start')
        await self.controller.control('/mute')
        await self.event('final',text='不能提交')
        await self.controller.control('/unmute')
        await self.event('final',text='仍然不能提交')
        self.assertEqual(self.agent.prompts,[])
    async def test_confirmed_interruption_cancels_old_then_next_turn(self):
        self.agent.hold=True
        await self.submit()
        await asyncio.sleep(.01)
        old=self.controller.generation
        await self.event('start',2)
        await self.event('partial',2,text='等一下',acoustic={'strong_ms':96})
        self.assertGreater(self.controller.generation,old)
        self.agent.hold=False
        await self.event('end',2)
        await self.event('final',2,text='请简短些',acoustic={'strong_ms':320})
        await self.settle()
        self.assertEqual(self.agent.cancelled,1)
        self.assertIn('请简短些',self.agent.prompts[-1])
        self.assertEqual(self.controller.records[-1]['status'],'complete')
    async def test_model_failure_does_not_kill_next_turn(self):
        self.agent.fail=True
        await self.submit()
        await self.settle()
        self.assertEqual(self.controller.records[-1]['status'],'failed')
        self.agent.fail=False
        await self.submit(2)
        await self.settle()
        self.assertEqual(self.controller.records[-1]['status'],'complete')
    async def test_two_pending_asr_finals_keep_original_order(self):
        await self.event('start',1)
        await self.event('end',1)
        await self.event('start',2)
        await self.event('end',2)
        await self.event('final',2,text='改成中文')
        await asyncio.sleep(0)
        self.assertEqual(self.agent.prompts,[])
        await self.event('final',1,text='用英文')
        await self.settle()
        self.assertEqual(self.agent.prompts,['用英文\n改成中文'])
    async def test_stop_remains_listening_end_requires_start(self):
        self.agent.hold=True
        await self.submit()
        await self.controller.control('/stop')
        self.assertTrue(self.controller.active)
        await self.controller.control('/end')
        self.assertFalse(self.controller.active)
        await self.event('final',2,text='不提交')
        self.assertEqual(len(self.agent.prompts),0)  # stopped before admission

    async def test_tts_failure_preserves_text_and_next_turn_works(self):
        async def failed_tts(*args,**kwargs):
            yield b'\1\0'*100
            raise ValueError('TTS interrupted')
        self.controller.synthesize=failed_tts
        await self.submit()
        await self.settle()
        self.assertEqual(self.controller.records[-1]['status'],'failed')
        self.assertEqual(self.controller.records[-1]['text'],'你好。')
        self.controller.synthesize=tts
        await self.submit(2)
        await self.settle()
        self.assertEqual(self.controller.records[-1]['status'],'complete')

    async def test_late_pcm_from_cancelled_synthesizer_is_not_played(self):
        entered=asyncio.Event()
        async def late_tts(*args,**kwargs):
            entered.set()
            try: await asyncio.sleep(30)
            except asyncio.CancelledError: pass
            yield b'\1\0'*100
        self.controller.synthesize=late_tts
        await self.submit()
        await entered.wait()
        await self.controller.control('/stop')
        await self.settle()
        self.assertFalse(any(isinstance(call,tuple) and call[0]=='pcm' for call in self.audio.calls))

    async def test_attempt_replacement_does_not_read_mixed_answers(self):
        async def retrying(text):
            yield {'type':'delta','text':'旧句。','attemptId':'old'}
            yield {'type':'delta','text':'新句。','attemptId':'new'}
        self.agent.stream=retrying
        await self.submit()
        await self.settle()
        self.assertEqual(self.controller.records[-1]['status'],'failed')
        self.assertNotIn('新句',self.controller.records[-1]['text'])

    async def test_pipeline_failure_clears_before_slow_model_cleanup(self):
        cleanup=asyncio.Event()
        release=asyncio.Event()
        async def slow_agent(text):
            try:
                yield {'type':'delta','text':'第一句。','attemptId':'one'}
                await asyncio.sleep(30)
            finally:
                cleanup.set()
                await release.wait()
        async def failing_tts(*args,**kwargs):
            yield b'\1\0'*100
            raise ValueError('TTS failed')
        self.agent.stream=slow_agent
        self.controller.synthesize=failing_tts
        await self.submit()
        try:
            await asyncio.wait_for(cleanup.wait(),1)
            self.assertEqual(self.audio.calls.count('clear'),2)
            self.assertEqual(self.controller.records[-1]['status'],'failed')
        finally:
            release.set()
            await self.settle()

    async def test_attempt_change_stops_before_stream_cleanup(self):
        cleanup=asyncio.Event()
        release=asyncio.Event()
        async def slow_agent(text):
            try:
                yield {'type':'delta','text':'旧句。','attemptId':'one'}
                yield {'type':'delta','text':'新句。','attemptId':'two'}
            finally:
                cleanup.set()
                await release.wait()
        self.agent.stream=slow_agent
        await self.submit()
        try:
            await asyncio.wait_for(cleanup.wait(),1)
            self.assertEqual(self.audio.calls.count('clear'),2)
        finally:
            release.set()
            await self.settle()
