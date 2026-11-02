import asyncio
from contextlib import aclosing
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bot_agent import BotAgent
from bot_events import read_events
from continuous import Conversation
from test_continuous import Audio


class LiveFixture:
    def __init__(self):
        self.ident=None;self.calls=[];self.seq=0;self.queue=asyncio.Queue();self.current=None
        self.result={'status':'running'};self.closed=False
    async def api(self,path,body):
        self.calls.append((path,body))
        if path=='/health': return {'outputMode':'hybrid-stream','replyStreaming':{'version':1,'enabled':True}}
        if path=='/ask': self.ident=body['id'];return {'status':'queued'}
        if path=='/stream-snapshot':
            return {'stream':self.current,'result':self.result,'cursor':{'hostEpoch':'host','seq':self.seq}}
        if path=='/result': return self.result
        return {}
    def push(self,kind,payload):
        self.seq+=1
        self.queue.put_nowait({'type':kind,'payload':payload,'requestId':self.ident,'hostEpoch':'host','seq':self.seq})
    def draft(self,text,speech,attempt='a',status='streaming'):
        self.current={'requestId':self.ident,'attemptId':attempt,'revision':self.seq+1,'status':status,
                      'text':text,'speechText':speech,'speechEligible':True}
        self.push('reply.stream',self.current)
    def complete(self,text,speech):
        self.result={'status':'completed','text':text,'speechText':speech,'sources':[{'id':'s','title':'source','url':'https://example.com'}]}
        self.push('request.updated',self.result)
    async def events(self,cursor):
        try:
            while True:
                event=await self.queue.get()
                if isinstance(event,Exception): raise event
                yield event
        finally: self.closed=True


class ReplyStreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.f=LiveFixture();self.agent=BotAgent(api=self.f.api,events=self.f.events)
        await self.agent.start()
    async def next(self,stream): return await asyncio.wait_for(anext(stream),.5)
    async def test_safe_prefix_arrives_before_completion_and_final_is_not_duplicated(self):
        async with aclosing(self.agent.stream('hello')) as stream:
            self.assertEqual((await self.next(stream))['type'],'request')
            task=asyncio.create_task(self.next(stream));await asyncio.sleep(.01)
            self.f.draft('参见[报告](https://example.com)。','参见报告。')
            self.assertEqual((await task)['type'],'draft')
            self.assertEqual((await self.next(stream))['text'],'参见报告。')
            self.f.draft('参见[报告](https://example.com)。第二句。','参见报告。第二句。')
            self.assertEqual((await self.next(stream))['type'],'draft')
            self.assertEqual((await self.next(stream))['text'],'第二句。')
            self.f.complete('参见[报告](https://example.com)。第二句。','参见报告。第二句。')
            result=await self.next(stream)
            self.assertEqual(result['streamedSpeech'],'参见报告。第二句。')
            self.assertEqual(result['sources'][0]['id'],'s')
        self.assertTrue(self.f.closed)
        self.assertFalse(any(p=='/voice/cancel-request' for p,_ in self.f.calls))

    async def test_reconnect_snapshot_resumes_unseen_prefix_without_resubmitting(self):
        async with aclosing(self.agent.stream('hello')) as stream:
            await self.next(stream)
            first=asyncio.create_task(self.next(stream));await asyncio.sleep(.01)
            self.f.draft('第一句。','第一句。');await first;await self.next(stream)
            self.f.queue.put_nowait(ConnectionError('lost'))
            self.f.draft('第一句。第二句。','第一句。第二句。')
            self.assertEqual((await self.next(stream))['type'],'draft')
            self.assertEqual((await self.next(stream))['text'],'第二句。')
            self.f.complete('第一句。第二句。','第一句。第二句。')
            self.assertEqual((await self.next(stream))['type'],'reply')
        self.assertEqual(sum(p=='/ask' for p,_ in self.f.calls),1)

    async def test_transient_snapshot_failure_retries_same_request_then_resumes(self):
        failures=0
        original=self.agent.api
        async def api(path,body):
            nonlocal failures
            if path=='/stream-snapshot' and failures<1:
                failures+=1
                raise ConnectionError('temporarily unavailable')
            return await original(path,body)
        self.agent.api=api
        async with aclosing(self.agent.stream('hello')) as stream:
            await self.next(stream)
            pending=asyncio.create_task(self.next(stream))
            await asyncio.sleep(.03)
            self.f.complete('恢复完成。','恢复完成。')
            self.assertEqual((await pending)['type'],'reply')
        self.assertEqual(sum(p=='/ask' for p,_ in self.f.calls),1)
        self.assertEqual(failures,1)

    async def test_attempt_replacement_after_speech_stops_without_replaying(self):
        async with aclosing(self.agent.stream('hello')) as stream:
            await self.next(stream)
            first=asyncio.create_task(self.next(stream));await asyncio.sleep(.01)
            self.f.draft('第一句。','第一句。');await first;await self.next(stream)
            self.f.draft('新的一句。','新的一句。',attempt='replacement')
            with self.assertRaisesRegex(ValueError,'重新生成'): await self.next(stream)
        self.assertTrue(any(p=='/voice/cancel-request' for p,_ in self.f.calls))

    async def test_unclassified_tool_text_is_not_forwarded_and_final_falls_back(self):
        async with aclosing(self.agent.stream('查资料')) as stream:
            await self.next(stream)
            pending=asyncio.create_task(self.next(stream));await asyncio.sleep(.01)
            self.f.push('reply.stream',{'requestId':self.f.ident,'attemptId':'a','revision':1,'status':'streaming',
                                      'text':'我猜工具已经成功','speechEligible':False})
            await asyncio.sleep(.01);self.assertFalse(pending.done())
            self.f.complete('工具执行成功。','工具执行成功。')
            self.assertEqual((await pending)['type'],'reply')

    async def test_final_prefix_mismatch_never_replays_full_reply(self):
        async with aclosing(self.agent.stream('hello')) as stream:
            await self.next(stream)
            first=asyncio.create_task(self.next(stream));await asyncio.sleep(.01)
            self.f.draft('第一句。','第一句。');await first;await self.next(stream)
            self.f.complete('完全不同。','完全不同。')
            with self.assertRaisesRegex(ValueError,'不一致'): await self.next(stream)

    async def test_cancel_closes_event_reader_and_cancels_only_foreground(self):
        async def consume():
            async for _ in self.agent.stream('hello'): pass
        task=asyncio.create_task(consume());await asyncio.sleep(.02);task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(self.f.closed)
        self.assertEqual(sum(p=='/voice/cancel-request' for p,_ in self.f.calls),1)


class SpeechFlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_sentence_is_synthesized_before_model_complete_and_tail_once(self):
        spoken=[];early=asyncio.Event();release=asyncio.Event()
        class Agent:
            output_mode='hybrid-stream'
            async def stream(self,text):
                yield {'type':'draft','text':'**第一句。**','attemptId':'a'}
                yield {'type':'speech-delta','text':'第一句。','attemptId':'a'}
                await release.wait()
                yield {'type':'reply','text':'**第一句。**第二句。','speechText':'第一句。第二句。','sources':[]}
        async def synth(text,*args,**kwargs):
            spoken.append(text);early.set();yield b'\1\0'*10
        c=Conversation(Agent(),Audio(),'unused',synthesize=synth,log=lambda _:None)
        try:
            await c.ask('hello');await asyncio.wait_for(early.wait(),.5)
            self.assertNotIn('agent_complete_at',c.records[-1])
            release.set();await c.wait_idle()
            self.assertEqual(spoken,['第一句。','第二句。'])
            self.assertEqual(c.records[-1]['status'],'complete')
            self.assertLess(c.records[-1]['first_pcm_at'],c.records[-1]['agent_complete_at'])
        finally: await c.close()

    async def test_stop_discards_current_and_prefetched_audio(self):
        started=[];closed=[];second=asyncio.Event();write_entered=asyncio.Event()
        class Agent:
            output_mode='settled-answer'
            async def stream(self,text):
                yield {'type':'reply','text':'第一句。第二句。第三句。','speechText':'第一句。第二句。第三句。'}
        class BlockedAudio(Audio):
            async def write(self,pcm,generation,segment):
                write_entered.set();await asyncio.Future()
        async def synth(text,*args,**kwargs):
            started.append(text)
            if len(started)==2: second.set()
            try:
                for _ in range(100): yield b'\1\0'*2048
            finally: closed.append(text)
        c=Conversation(Agent(),BlockedAudio(),'unused',synthesize=synth,log=lambda _:None)
        try:
            await c.ask('hello');await asyncio.wait_for(second.wait(),.5)
            await asyncio.wait_for(write_entered.wait(),.5)
            self.assertEqual(started,['第一句。','第二句。'])
            await c.control('/stop');await asyncio.wait_for(c.wait_idle(),.5)
            self.assertCountEqual(closed,started)
            self.assertEqual(c.records[-1]['status'],'interrupted')
        finally: await c.close()


class EventTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_expired_cursor_is_recoverable_and_connection_closes(self):
        closed=asyncio.Event()
        async def serve(reader,writer):
            await reader.readuntil(b'\r\n\r\n')
            writer.write(b'HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n')
            await writer.drain();await reader.read();closed.set()
            writer.close();await writer.wait_closed()
        server=await asyncio.start_server(serve,'127.0.0.1',0)
        try:
            async with aclosing(read_events(server.sockets[0].getsockname()[1],'test-token',{})) as events:
                with self.assertRaisesRegex(ConnectionError,'cursor_reset'):
                    await anext(events)
            await asyncio.wait_for(closed.wait(),.5)
        finally: server.close();await server.wait_closed()
    async def test_chunked_utf8_split_and_disconnect_cleanup(self):
        disconnected=asyncio.Event();received=[]
        async def serve(reader,writer):
            try:
                header=await reader.readuntil(b'\r\n\r\n');received.append(header)
                size=int(next(line.split(b':')[1] for line in header.split(b'\r\n') if line.lower().startswith(b'content-length:')))
                received.append(json.loads(await reader.readexactly(size)))
                writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n')
                event='data: '+json.dumps({'type':'reply.stream','text':'你好'},ensure_ascii=False)+'\n\n'
                raw=event.encode()
                for byte in raw:
                    writer.write(b'1\r\n'+bytes([byte])+b'\r\n')
                await writer.drain();await reader.read();disconnected.set()
            finally: writer.close();await writer.wait_closed()
        server=await asyncio.start_server(serve,'127.0.0.1',0)
        try:
            async with aclosing(read_events(server.sockets[0].getsockname()[1],'test-token',{'hostEpoch':'h','seq':0})) as events:
                self.assertEqual((await asyncio.wait_for(anext(events),1))['text'],'你好')
            await asyncio.wait_for(disconnected.wait(),1)
            self.assertIn(b'Authorization: Bearer test-token',received[0])
            self.assertEqual(received[1]['cursor']['seq'],0)
        finally: server.close();await server.wait_closed()
