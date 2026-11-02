import asyncio
from contextlib import aclosing
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from speech_pipeline import prepare_speech


class PrefetchTests(unittest.IsolatedAsyncioTestCase):
    def items(self):
        queue=asyncio.Queue()
        for i in range(3): queue.put_nowait((i+1,str(i+1),False))
        queue.put_nowait(None)
        return queue
    def metrics(self,item): return {'id':item[0],'kind':'answer'}

    async def test_first_pcm_priority_then_one_lookahead_with_bounded_chunks(self):
        first_started=asyncio.Event();first_pcm=asyncio.Event();second_started=asyncio.Event()
        started=[];closed=[];produced={}
        async def synth(text,metrics):
            started.append(text);produced[text]=0
            try:
                if text=='1': first_started.set();await first_pcm.wait()
                if text=='2': second_started.set()
                for _ in range(1000):
                    produced[text]+=1
                    yield b'\1\0'*2048
            finally: closed.append(text)
        async with aclosing(prepare_speech(self.items(),synth,lambda:True,self.metrics)) as jobs:
            job=await asyncio.wait_for(anext(jobs),.5)
            await asyncio.wait_for(first_started.wait(),.5)
            await asyncio.sleep(.01);self.assertEqual(started,['1'])
            first_pcm.set();await asyncio.wait_for(second_started.wait(),.5)
            await asyncio.sleep(.01)
            self.assertEqual(started,['1','2'])
            self.assertEqual(job.queue.qsize(),8)
            self.assertLessEqual(produced['2'],9)
        self.assertCountEqual(closed,['1','2'])

    async def test_fallback_disables_lookahead_until_current_is_consumed(self):
        started=[]
        async def synth(text,metrics):
            started.append(text);yield b'\1\0'
        async with aclosing(prepare_speech(self.items(),synth,lambda:True,self.metrics,lookahead=0)) as jobs:
            first=await anext(jobs)
            await asyncio.sleep(.01)
            self.assertEqual(started,['1'])
            self.assertEqual([chunk async for chunk in first.pcm()],[b'\1\0'])
            second=await anext(jobs)
            self.assertEqual([chunk async for chunk in second.pcm()],[b'\1\0'])
            self.assertEqual(started,['1','2'])

    async def test_prefetch_failure_is_delivered_in_order_and_all_jobs_close(self):
        closed=[]
        async def synth(text,metrics):
            try:
                if text=='2': raise ValueError('failed next sentence')
                yield b'\1\0'
            finally: closed.append(text)
        async with aclosing(prepare_speech(self.items(),synth,lambda:True,self.metrics)) as jobs:
            first=await anext(jobs)
            self.assertEqual([chunk async for chunk in first.pcm()],[b'\1\0'])
            second=await anext(jobs)
            with self.assertRaisesRegex(ValueError,'failed next'):
                _=[chunk async for chunk in second.pcm()]
        self.assertIn('1',closed);self.assertIn('2',closed)

    async def test_dispatch_failure_propagates_instead_of_hanging_consumer(self):
        async def synth(text,metrics): yield b'\1\0'
        def broken(item): raise ValueError('metric creation failed')
        async with aclosing(prepare_speech(self.items(),synth,lambda:True,broken)) as jobs:
            with self.assertRaisesRegex(ValueError,'metric creation'):
                await asyncio.wait_for(anext(jobs),.5)
