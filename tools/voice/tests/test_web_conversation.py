import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from continuous import Conversation
from test_continuous import Audio

class WebAgent:
    output_mode='settled-answer'
    def __init__(self,delay=0): self.delay=delay;self.closed=0
    async def stream(self,text):
        try:
            yield {'type':'status','phase':'searching','step':1}
            await asyncio.sleep(self.delay)
            yield {'type':'status','phase':'reading','step':2}
            yield {'type':'reply','text':'参见[报告](https://example.com/)。','speechText':'参见报告。','sources':[{'id':'1','url':'https://example.com/','title':'报告'}]}
        finally: self.closed+=1

class WebConversationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.audio=Audio();self.spoken=[];self.agent=WebAgent()
        async def synth(text,*args,**kwargs): self.spoken.append(text);yield b'\1\0'*10
        self.c=Conversation(self.agent,self.audio,'unused',synthesize=synth,log=lambda _:None)
        self.c.notice_delay=.01
    async def asyncTearDown(self): await self.c.close()
    async def test_settled_answer_uses_speech_projection_and_keeps_sources(self):
        await self.c.ask('查一下');await self.c.wait_idle();r=self.c.records[-1]
        self.assertEqual(r['status'],'complete');self.assertEqual(self.spoken,['参见报告。']);self.assertIn('https',r['text']);self.assertEqual(r['speech_text'],'参见报告。');self.assertEqual(len(r['sources']),1)
        self.assertNotIn('notice_first_pcm_at',r)
    async def test_slow_search_prompts_once_without_polluting_answer_or_latency(self):
        self.agent.delay=.04;await self.c.ask('查一下');await self.c.wait_idle();r=self.c.records[-1]
        self.assertEqual(self.spoken,['我查一下，请稍等。','参见报告。']);self.assertEqual(r['speech_text'],'参见报告。');self.assertLess(r['notice_first_pcm_at'],r['first_pcm_at']);self.assertEqual(r['first_pcm_at'],r['answer_first_pcm_at'])
    async def test_final_answer_cancels_notice_still_waiting_for_tts(self):
        self.agent.delay=.03;entered=asyncio.Event();cancelled=asyncio.Event()
        async def synth(text,*args,**kwargs):
            if text.startswith('我查一下'):
                entered.set()
                try: await asyncio.sleep(30)
                finally: cancelled.set()
            self.spoken.append(text);yield b'\1\0'*10
        self.c.synthesize=synth;await self.c.ask('查一下');await asyncio.wait_for(self.c.wait_idle(),1)
        self.assertTrue(entered.is_set());self.assertTrue(cancelled.is_set());self.assertEqual(self.spoken,['参见报告。'])
    async def test_stop_during_search_reaps_prompt_and_next_question_works(self):
        self.agent.delay=30;await self.c.ask('查一下');await asyncio.sleep(.003);await self.c.control('/stop');await self.c.wait_idle()
        self.assertEqual(self.spoken,[]);self.agent.delay=0;await self.c.ask('继续');await self.c.wait_idle();self.assertEqual(self.c.records[-1]['status'],'complete')
    async def test_stop_during_notice_or_answer_discards_late_pcm(self):
        for on_notice in (True,False):
            entered=asyncio.Event();self.agent.delay=.04 if on_notice else 0
            async def synth(text,*args,**kwargs):
                entered.set()
                try:await asyncio.sleep(30)
                except asyncio.CancelledError:pass
                yield b'\1\0'*10
            self.c.synthesize=synth;before=len(self.audio.calls);await self.c.ask('查一下');await asyncio.wait_for(entered.wait(),1);await self.c.control('/stop');await self.c.wait_idle()
            self.assertFalse(any(isinstance(x,tuple) and x[0]=='pcm' for x in self.audio.calls[before:]))

