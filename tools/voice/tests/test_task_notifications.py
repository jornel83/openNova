import asyncio
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from continuous import Conversation
from task_notifications import TaskNotificationSpeaker, notification_input_idle
from turns import TurnCapture
from vad import FRAME_BYTES


class Audio:
    playback = 'idle'
    def __init__(self): self.generation=0; self.pcm=[]; self.clears=[]; self.captures=[]
    async def clear(self,generation): self.generation=generation; self.clears.append(generation)
    async def capture(self,enabled,epoch): self.captures.append((enabled,epoch))
    async def resume(self): pass
    async def write(self,pcm,generation,segment):
        if generation != self.generation: return False
        self.pcm.append(pcm); return True
    async def drained(self,generation): pass


class Agent:
    def __init__(self): self.prompts=[]
    async def stream(self,text):
        self.prompts.append(text)
        yield {'type':'request','id':'foreground-request'}
        yield {'type':'delta','text':'普通回复。','attemptId':'one'}
        yield {'type':'reply','text':'普通回复。'}


async def tts(text,url,**kwargs): yield text.encode('utf-16-le')


class Bridge:
    instance_id='voice-one'
    registered=True
    closed=False
    retired=False
    held=set()
    def __init__(self):
        self.pending=[{'id':'n1','text':'完整文本','speechText':'资料员的资料整理已验收。'}]
        self.consumed=set(); self.calls=[]; self.on_claim=None; self.fail_ack=False; self.valid=True; self.on_active=None; self.seen={}
    async def call(self,path,body):
        self.calls.append((path,body))
        if path == '/task-notification-next':
            excluded=set(body.get('excludeIds',[]))
            return {'notification':next((n for n in self.pending if n['id'] not in self.consumed and n['id'] not in excluded),None)}
        if path == '/task-notification-claim':
            if self.on_claim: return await self.on_claim(body)
            found=next((n for n in self.pending if n['id']==body['id'] and n['id'] not in self.consumed),None)
            if found: self.consumed.add(found['id'])
            return {'notification':found}
        if path == '/task-notification-active':
            if self.on_active: return await self.on_active(body)
            return {'valid':self.valid}
        if path=='/task-notification-ack' and self.fail_ack: raise TimeoutError('ack lost')
        return {}


class TaskNotificationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.audio,self.agent,self.bridge=Audio(),Agent(),Bridge()
        self.c=Conversation(self.agent,self.audio,'unused',synthesize=tts,log=lambda _:None)
        self.idle=True; self.revision=0; self.now=10.
        self.speaker=TaskNotificationSpeaker(self.c,self.bridge,input_idle=lambda starting:self.idle,
            activity_stamp=lambda:self.revision,clock=lambda:self.now,watch_interval=.005)
    async def asyncTearDown(self): await self.c.close()
    def acks(self): return [body['status'] for path,body in self.bridge.calls if path=='/task-notification-ack']
    async def test_reports_use_speech_text_and_tts_without_model_turn_or_history(self):
        await self.speaker.step()
        self.assertEqual(b''.join(self.audio.pcm).decode('utf-16-le'),'资料员的资料整理已验收。')
        self.assertEqual(self.agent.prompts,[])
        self.assertEqual(self.c.records,[])
        self.assertFalse(self.c.interrupted)
        self.assertEqual(self.c.unsubmitted,'')
        self.assertEqual(self.acks(),['played'])
        self.now+=4
        await self.speaker.step()
        self.assertEqual(len(self.audio.pcm),1)

    async def test_speech_foreground_draft_and_audio_state_defer_without_claim(self):
        self.idle=False
        await self.speaker.step()
        self.idle=True
        self.c.inputs={1:{'finished':False}}
        await self.speaker.step()
        self.c.inputs={}; self.c.draft={'text':'未提交'}
        await self.speaker.step()
        self.c.draft=None; self.audio.playback='playing'
        await self.speaker.step()
        self.audio.playback='idle'; self.c.paused_at=time.monotonic()
        await self.speaker.step()
        self.c.paused_at=None
        async with self.c.agent_lock: await self.speaker.step()
        self.assertEqual(self.bridge.calls,[])
        await self.speaker.step()
        self.assertEqual(self.acks(),['played'])

    async def test_end_audio_error_and_lost_owner_never_claim(self):
        await self.c.control('/end'); await self.speaker.step()
        await self.c.control('/start'); self.c.audio_failed=True
        await self.speaker.step(); self.c.audio_failed=False
        self.bridge.registered=False; await self.speaker.step()
        self.bridge.registered=True; self.bridge.retired=True; await self.speaker.step()
        self.bridge.retired=False; self.bridge.held={'mute-command'}; await self.speaker.step()
        self.assertEqual(self.bridge.calls,[])

    async def test_muted_microphone_still_plays_notification_without_capture_or_model(self):
        await self.c.control('/mute')
        epoch=self.c.epoch
        await self.c.handle({'type':'final','id':4,'epoch':epoch-1,'text':'旧转写'})
        await self.c.handle({'type':'start','id':5,'epoch':epoch})
        await self.speaker.step()
        self.assertEqual(self.acks(),['played'])
        self.assertEqual(self.c.voice_state()['capture'],'muted')
        self.assertEqual(self.audio.captures,[(False,epoch)])
        self.assertEqual(self.agent.prompts,[])
        self.now+=4; await self.speaker.step()
        self.assertEqual(len(self.audio.pcm),1)

    async def test_mic_controls_during_claim_do_not_lose_consumed_notification(self):
        async def recognize(*args): await asyncio.Future()
        capture=TurnCapture(lambda _:0.,recognize,lambda _:None)
        self.c.reset_input=capture.reset
        capture.last_voice_at=time.monotonic()-2
        capture.feed(0,b'\x01\x00'*(FRAME_BYTES//2))
        self.audio.input=asyncio.Queue()
        events,commands=asyncio.Queue(),asyncio.Queue()
        future=asyncio.get_running_loop().create_future
        event_wait,command_wait,reader=future(),future(),future()
        def idle(starting,after_claim=False):
            return notification_input_idle(capture,self.audio,events,commands,event_wait,command_wait,reader,starting,muted=self.c.muted,epoch=self.c.epoch,after_claim=after_claim)
        self.speaker.input_idle=idle; self.speaker.claim_idle=lambda:idle(True,True)
        self.speaker.activity_stamp=lambda:capture.voice_revision
        try:
            for control in ('/mute','/unmute'):
                with self.subTest(control=control):
                    self.bridge.consumed.clear(); self.speaker.attempted.clear(); self.now+=4
                    self.bridge.held=set()
                    async def claim(body):
                        self.bridge.held={control}; self.bridge.seen={control:{'action':control[1:]}}
                        await self.c.control(control)
                        self.bridge.consumed.add(body['id'])
                        return {'notification':self.bridge.pending[0]}
                    self.bridge.on_claim=claim
                    await self.speaker.step()
                    self.assertEqual(self.acks()[-1],'played')
        finally: await capture.close()
        self.assertEqual(len(self.audio.pcm),2)
        self.assertEqual(self.agent.prompts,[])

    async def test_pending_mic_control_does_not_cancel_synthesis_or_playback(self):
        entered=asyncio.Event(); release=asyncio.Event()
        async def slow(*args,**kwargs): entered.set(); await release.wait(); yield b'00'
        self.c.synthesize=slow
        task=asyncio.create_task(self.speaker.step())
        await entered.wait()
        for control in ('mute','unmute','mute'):
            self.bridge.held={control}; self.bridge.seen={control:{'action':control}}
            await asyncio.sleep(.015)
            self.assertFalse(task.done())
            await self.c.control('/'+control)
            await asyncio.sleep(.015)
            self.assertFalse(task.done())
        release.set(); await asyncio.wait_for(task,.5)
        self.assertEqual(self.acks(),['played'])
        self.assertEqual(self.audio.pcm,[b'00'])
        self.assertEqual(self.audio.clears,[])
        self.assertEqual(self.c.voice_state()['capture'],'muted')

    async def test_pending_stop_control_still_cancels_synthesis(self):
        entered=asyncio.Event()
        async def slow(*args,**kwargs): entered.set(); await asyncio.sleep(30); yield b'00'
        self.c.synthesize=slow
        task=asyncio.create_task(self.speaker.step()); await entered.wait()
        self.bridge.held={'stop'}; self.bridge.seen={'stop':{'action':'stop'}}
        await asyncio.wait_for(task,.5)
        self.assertEqual(self.acks(),['interrupted'])
        self.assertEqual(self.audio.pcm,[])

    async def test_claim_response_loss_is_not_reclaimed_even_if_peek_repeats(self):
        async def claim(body): raise TimeoutError('response lost')
        self.bridge.on_claim=claim
        with self.assertRaises(TimeoutError): await self.speaker.step()
        await self.speaker.step()
        self.assertEqual(sum(path=='/task-notification-claim' for path,_ in self.bridge.calls),1)
        self.assertEqual(self.audio.pcm,[])

    async def test_ambiguous_unconsumed_claim_does_not_starve_later_reports(self):
        async def lost(body): raise ConnectionError('request lost before host')
        self.bridge.pending.append({'id':'n2','speechText':'下一项工作已验收。'})
        self.bridge.on_claim=lost
        with self.assertRaises(ConnectionError): await self.speaker.step()
        self.bridge.on_claim=None
        await self.speaker.step()
        claims=[body['id'] for path,body in self.bridge.calls if path=='/task-notification-claim']
        self.assertEqual(claims,['n1','n2'])
        self.assertEqual(self.acks(),['played'])
        self.assertEqual(b''.join(self.audio.pcm).decode('utf-16-le'),'下一项工作已验收。')

    async def test_host_persisted_consumption_survives_new_speaker_and_failed_ack(self):
        self.bridge.fail_ack=True
        await self.speaker.step()
        newer=TaskNotificationSpeaker(self.c,self.bridge,input_idle=lambda _:True,activity_stamp=lambda:0)
        await newer.step()
        self.assertEqual(len(self.audio.pcm),1)

    async def test_notification_preserves_normal_interruption_context_without_request_id(self):
        entered=asyncio.Event()
        async def slow(*args,**kwargs): entered.set(); await asyncio.sleep(30); yield b'00'
        self.c.synthesize=slow
        await self.c.ask('介绍项目'); await entered.wait()
        self.assertEqual(self.c.voice_state()['requestId'],'foreground-request')
        await self.c.control('/stop'); await self.c.wait_idle()
        self.assertIsNone(self.c.voice_state()['requestId'])
        self.assertTrue(self.c.interrupted)
        self.c.synthesize=tts
        await self.speaker.step()
        self.assertEqual(self.acks(),['played'])
        self.assertTrue(self.c.interrupted)  # Notification is not a model reply.
        await self.c.ask('简单一点'); await self.c.wait_idle()
        self.assertIn('上一段回复的播报已被打断',self.agent.prompts[-1])
        self.assertNotIn('资料员',self.agent.prompts[-1])

    async def test_claim_rejection_can_retry_after_foreground_host_is_idle(self):
        async def busy(body): return {'notification':None}
        self.bridge.on_claim=busy
        await self.speaker.step(); self.assertEqual(self.audio.pcm,[])
        self.bridge.on_claim=None; await self.speaker.step()
        self.assertEqual(self.acks(),['played'])

    async def test_unprocessed_voice_arriving_during_claim_never_starts_tts(self):
        async def claim(body):
            self.idle=False; self.revision+=1  # VAD state changed, UI event still queued.
            self.bridge.consumed.add(body['id'])
            return {'notification':self.bridge.pending[0]}
        self.bridge.on_claim=claim
        await self.speaker.step()
        self.assertEqual(self.audio.pcm,[])
        self.assertEqual(self.c.notification_records,[])
        self.assertEqual(self.acks(),['skipped'])

    async def test_raw_pcm_arriving_during_claim_is_checked_before_tts(self):
        audio=self.audio; audio.input=asyncio.Queue()
        capture=SimpleNamespace(notification_idle=lambda _,**kw:True)
        events,commands=asyncio.Queue(),asyncio.Queue()
        event_wait,command_wait,reader=(asyncio.get_running_loop().create_future() for _ in range(3))
        def idle(starting,after_claim=False):
            return notification_input_idle(capture,audio,events,commands,event_wait,command_wait,reader,starting,muted=self.c.muted,epoch=self.c.epoch,after_claim=after_claim)
        self.speaker.input_idle=idle
        self.speaker.claim_idle=lambda:idle(True,True)
        async def claim(body):
            audio.input.put_nowait((self.c.epoch,b'\x01\x00'*512))
            self.bridge.consumed.add(body['id'])
            return {'notification':self.bridge.pending[0]}
        self.bridge.on_claim=claim
        await self.speaker.step()
        self.assertEqual(self.audio.pcm,[])
        self.assertEqual(self.c.notification_records,[])
        self.assertEqual(self.acks(),['skipped'])

    async def test_short_input_finished_during_claim_still_invalidates_reservation(self):
        async def claim(body):
            self.revision+=1  # Back to quiet, but the request crossed a user action.
            return {'notification':self.bridge.pending[0]}
        self.bridge.on_claim=claim
        await self.speaker.step()
        self.assertEqual(self.acks(),['skipped'])
        self.assertEqual(self.audio.pcm,[])

    async def test_vad_start_interrupts_without_waiting_for_asr_and_no_phantom_prompt(self):
        entered=asyncio.Event()
        async def slow(*args,**kwargs): entered.set(); await asyncio.sleep(30); yield b'00'
        self.c.synthesize=slow
        task=asyncio.create_task(self.speaker.step())
        await asyncio.wait_for(entered.wait(),.5)
        await self.c.handle({'type':'start','id':1,'epoch':0})
        await asyncio.wait_for(task,.5)
        self.assertEqual(self.acks(),['interrupted'])
        self.assertFalse(self.c.interrupted); self.assertEqual(self.c.unsubmitted,'')
        self.assertEqual(self.audio.pcm,[])
        self.c.synthesize=tts
        await self.c.handle({'type':'final','id':1,'epoch':0,'text':'继续聊工作'})
        await self.c.wait_idle()
        self.assertEqual(self.agent.prompts,['继续聊工作'])

    async def test_new_voice_during_tts_prefetch_is_cleared_before_any_pcm(self):
        entered=asyncio.Event(); release=asyncio.Event()
        async def prefetched(*args,**kwargs): entered.set(); await release.wait(); yield b'00'
        self.c.synthesize=prefetched
        task=asyncio.create_task(self.speaker.step())
        await entered.wait()
        self.idle=False; self.revision+=1; release.set()
        await asyncio.wait_for(task,.5)
        self.assertEqual(self.audio.pcm,[])
        self.assertEqual(self.acks(),['interrupted'])
        self.assertGreater(self.audio.generation,0)

    async def test_task_changed_or_host_disconnected_during_synthesis_never_plays(self):
        entered=asyncio.Event(); release=asyncio.Event()
        async def prefetched(*args,**kwargs): entered.set(); await release.wait(); yield b'00'
        self.c.synthesize=prefetched
        task=asyncio.create_task(self.speaker.step())
        await entered.wait(); self.bridge.valid=False; release.set()
        await asyncio.wait_for(task,.5)
        self.assertEqual(self.acks(),['interrupted'])
        self.assertEqual(self.audio.pcm,[])
        self.now+=4; await self.speaker.step()
        self.assertEqual(self.audio.pcm,[])

    async def test_input_during_server_preflight_is_checked_again_before_first_pcm(self):
        async def active(body):
            self.idle=False; self.revision+=1
            return {'valid':True}
        self.bridge.on_active=active
        await self.speaker.step()
        self.assertEqual(self.acks(),['interrupted'])
        self.assertEqual(self.audio.pcm,[])

    async def test_server_check_error_fails_closed_without_replay(self):
        async def active(body): raise TimeoutError('host restarted')
        self.bridge.on_active=active
        await self.speaker.step(); self.now+=4; await self.speaker.step()
        self.assertEqual(self.acks(),['interrupted'])
        self.assertEqual(self.audio.pcm,[])

    async def test_task_invalidation_during_playback_clears_native_buffer(self):
        draining=asyncio.Event()
        async def drain(generation): draining.set(); await asyncio.sleep(30)
        self.audio.drained=drain
        task=asyncio.create_task(self.speaker.step())
        await draining.wait(); self.bridge.valid=False
        await asyncio.wait_for(task,1.)
        self.assertTrue(self.audio.pcm)
        self.assertGreater(self.audio.generation,0)
        self.assertEqual(self.acks(),['interrupted'])

    async def test_explicit_stop_or_end_while_mic_muted_cancels_and_never_resumes(self):
        await self.c.control('/mute')
        for command in ('/stop','/end'):
            self.now+=4
            self.bridge.consumed.clear()
            self.speaker.attempted.clear()
            entered=asyncio.Event()
            async def slow(*args,**kwargs): entered.set(); await asyncio.sleep(30); yield b'00'
            self.c.synthesize=slow
            task=asyncio.create_task(self.speaker.step())
            await entered.wait(); await self.c.control(command)
            await asyncio.wait_for(task,.5)
            self.assertEqual(self.acks()[-1],'interrupted')
            self.assertFalse(self.c.interrupted); self.assertEqual(self.c.unsubmitted,'')
            self.assertTrue(self.c.muted)
            self.assertTrue(all(not enabled for enabled,_ in self.audio.captures))
        await self.c.control('/unmute'); self.now+=4
        await self.speaker.step()
        self.assertEqual(self.audio.pcm,[])

    async def test_spacing_between_reports_and_request_id_cleared_after_foreground(self):
        await self.c.ask('你好'); await self.c.wait_idle()
        self.assertIsNone(self.c.voice_state()['requestId'])
        self.bridge.pending.append({'id':'n2','speechText':'第二项已验收。'})
        await self.speaker.step()
        first_count=len(self.audio.pcm)
        await self.speaker.step(); self.assertEqual(len(self.audio.pcm),first_count)
        self.now+=3.1; await self.speaker.step()
        self.assertEqual(self.acks(),['played','played'])
        self.assertEqual(self.agent.prompts,['你好'])

    async def test_tts_error_records_failure_and_does_not_retry(self):
        async def failed(*args,**kwargs): raise ValueError('tts unavailable'); yield b'00'
        self.c.synthesize=failed
        await self.speaker.step(); self.now+=4; await self.speaker.step()
        self.assertEqual(self.acks(),['failed'])
        self.assertEqual(self.audio.pcm,[])


class CaptureNotificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_get_controls_block_but_queued_quiet_pcm_does_not_cancel_playback(self):
        capture=SimpleNamespace(notification_idle=lambda _,**kwargs:True)
        audio=SimpleNamespace(input=asyncio.Queue())
        events,commands=asyncio.Queue(),asyncio.Queue()
        event_wait,command_wait,reader=(asyncio.get_running_loop().create_future() for _ in range(3))
        def idle(starting):
            return notification_input_idle(capture,audio,events,commands,event_wait,command_wait,reader,starting)
        self.assertTrue(idle(True))
        audio.input.put_nowait((0,b'\x00\x00'*512))
        self.assertFalse(idle(True))
        self.assertTrue(idle(False))
        audio.input.get_nowait()
        event_wait.set_result({'type':'start'})  # Queue is empty; get already consumed it.
        self.assertFalse(idle(True)); self.assertFalse(idle(False))
        event_wait=asyncio.get_running_loop().create_future()
        command_wait.set_result('/stop')
        self.assertFalse(idle(True)); self.assertFalse(idle(False))

    async def test_muted_without_pcm_and_mic_only_pending_controls_preserve_output(self):
        async def recognize(*args): await asyncio.sleep(30)
        capture=TurnCapture(lambda _:0.,recognize,lambda _:None)
        audio=SimpleNamespace(input=asyncio.Queue())
        events,commands=asyncio.Queue(),asyncio.Queue()
        future=asyncio.get_running_loop().create_future
        event_wait,command_wait,reader=future(),future(),future()
        def idle(starting,muted=True):
            return notification_input_idle(capture,audio,events,commands,event_wait,command_wait,reader,starting,muted=muted,epoch=capture.epoch)
        try:
            self.assertTrue(idle(True))  # Explicitly muted: no PCM is expected.
            self.assertFalse(idle(True,False))  # Listening still needs healthy, quiet capture.
            events.put_nowait({'type':'final','epoch':capture.epoch-1,'text':'stale'})
            self.assertTrue(idle(True)); self.assertTrue(idle(False))
            command_wait.set_result({'action':'mute'})
            commands.put_nowait('/unmute')
            self.assertFalse(idle(True)); self.assertTrue(idle(False))
            self.assertTrue(idle(False,False))  # Unmute does not interrupt existing speech while PCM starts.
            for control in ('/stop','/end','/retry','/start'):
                commands.put_nowait(control); self.assertFalse(idle(False)); commands.get_nowait(); commands.get_nowait(); commands.put_nowait('/unmute')
            events.put_nowait({'type':'audio_failure','error':'device lost'})
            self.assertFalse(idle(False))
        finally: await capture.close()

    async def test_raw_vad_frames_block_before_start_event_is_dispatched(self):
        probability=0.; events=[]
        async def recognize(*args): await asyncio.sleep(30)
        capture=TurnCapture(lambda _:probability,recognize,events.append)
        try:
            self.assertFalse(capture.notification_idle())  # No functioning input yet.
            capture.last_voice_at=time.monotonic()-2
            capture.feed(0,b'\x01\x00'*(FRAME_BYTES//2))
            self.assertTrue(capture.notification_idle())
            probability=.9
            capture.feed(0,b'\x01\x00'*(FRAME_BYTES//2))
            self.assertFalse(capture.notification_idle())
            self.assertFalse(capture.notification_idle(.12,require_capture=False))
            self.assertEqual(events,[])  # First frame: not yet a VAD start.
            capture.feed(0,b'\x01\x00'*FRAME_BYTES)
            self.assertEqual(events[0]['type'],'start')
            self.assertFalse(capture.notification_idle(0))
            capture.reset(1)
            self.assertFalse(capture.notification_idle(0))
        finally: await capture.close()
