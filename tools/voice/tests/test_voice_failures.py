import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bot_agent import BotAgent, BotRequestFailure, BotRequestCancelled
from continuous import Conversation
from test_continuous import Audio, tts


MESSAGE='话题识别服务暂时无法连接，当前项目保持不变，请稍后重试。'
PROJECT={'projectId':'project','revision':0}
FAILED={'status':'failed','error':'network_error','userMessage':MESSAGE,
        'diagnostic':{'code':'network_error','stage':'routing','message':'private-provider-detail'}}


class FailureTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_safe_host_message_is_preserved_in_polling_and_snapshot_without_cancel_cleanup(self):
        for mode in ['settled-answer','hybrid-stream']:
            calls=[]
            async def api(path,body):
                calls.append(path)
                if path=='/voice/cancel-request': raise ConnectionError('cleanup must not mask original failure')
                if path=='/stream-snapshot':return {'cursor':{'hostEpoch':'host','seq':0},'result':FAILED,'stream':None}
                return FAILED if path=='/result' else {}
            agent=BotAgent(api=api);agent.output_mode=mode
            with self.assertRaises(BotRequestFailure) as caught:
                _=[event async for event in agent.stream('现在几点？')]
            self.assertEqual(str(caught.exception),MESSAGE)
            self.assertEqual(caught.exception.stage,'routing')
            self.assertEqual(caught.exception.code,'network_error')
            self.assertNotIn('/voice/cancel-request',calls)
            self.assertIsNone(agent.current)

    async def test_sse_terminal_failure_closes_reader_without_cancelling_a_failed_request(self):
        calls=[];closed=[]
        async def api(path,body):
            calls.append(path)
            if path=='/stream-snapshot':return {'cursor':{'hostEpoch':'host','seq':0},'result':{'status':'running'},'stream':None}
            return FAILED if path=='/result' else {}
        async def events(cursor):
            try:yield {'type':'request.updated','requestId':agent.current,'seq':1,'hostEpoch':'host'}
            finally:closed.append(True)
        agent=BotAgent(api=api,events=events);agent.output_mode='hybrid-stream'
        with self.assertRaisesRegex(BotRequestFailure,'话题识别服务暂时无法连接'):
            _=[event async for event in agent.stream('hello')]
        self.assertEqual(closed,[True]);self.assertNotIn('/voice/cancel-request',calls)

    async def test_invalid_user_message_falls_back_to_bounded_diagnostics_without_raw_detail(self):
        for message in [None,{},42,'','  ','x'*1001,'bad\x00text']:
            error=BotAgent._failure({**FAILED,'userMessage':message})
            self.assertIsInstance(error,BotRequestFailure)
            self.assertIn('话题识别失败',str(error));self.assertIn('无法连接 ChatGPT',str(error))
            self.assertNotIn('private-provider-detail',str(error))
        for code in ['routing_timeout','invalid_route_response']:
            error=BotAgent._failure({'status':'failed','diagnostic':{'stage':'routing','code':code}})
            self.assertIn('当前项目保持不变',str(error))
        error=BotAgent._failure({'status':'failed','diagnostic':{'code':{},'stage':[],'message':'private'}})
        self.assertNotIn('private',str(error))

    async def test_server_acknowledged_cancel_is_distinct_from_failed_timeout(self):
        self.assertIsInstance(BotAgent._failure({'status':'cancelled','userMessage':'不要播报'}),BotRequestCancelled)
        self.assertIsInstance(BotAgent._failure({'status':'failed','diagnostic':{'code':'agent_timeout'}}),BotRequestFailure)


class VoiceFailurePresentationTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_failure_is_visible_once_keeps_listening_and_next_turn_succeeds(self):
        replies=[FAILED,{'status':'completed','text':'下一轮正常。','speechText':'下一轮正常。'}]
        async def api(path,body):
            if path=='/projects':return {'state':PROJECT}
            return replies.pop(0) if path=='/result' else {}
        logs=[];states=[];spoken=[]
        async def synth(text,*args,**kwargs):spoken.append(text);yield b'\1\0'*10
        controller=Conversation(BotAgent(api=api),Audio(),'unused',log=logs.append,on_state=states.append,synthesize=synth)
        try:
            await controller.handle({'type':'start','id':1,'epoch':0})
            await controller.handle({'type':'end','id':1,'epoch':0})
            await controller.handle({'type':'final','id':1,'epoch':0,'text':'现在几点？'})
            await asyncio.wait_for(controller.wait_idle(),1)
            record=controller.records[-1]
            self.assertEqual(record['status'],'failed');self.assertEqual(record['error'],'network_error')
            self.assertEqual(record['failure_stage'],'routing');self.assertEqual(record['userMessage'],MESSAGE)
            self.assertEqual(logs.count(MESSAGE),1);self.assertEqual(spoken,[MESSAGE])
            self.assertEqual(record['failure_notice']['status'],'spoken')
            self.assertEqual(states[-1]['problem'],MESSAGE)
            self.assertEqual(states[-1]['capture'],'listening');self.assertEqual(states[-1]['playback'],'idle')
            self.assertTrue(controller.active);self.assertFalse(controller.audio_failed)
            await controller.ask('继续说话',expected_project=PROJECT);await asyncio.wait_for(controller.wait_idle(),1)
            self.assertEqual(controller.records[-1]['status'],'complete')
            self.assertIsNone(states[-1]['problem']);self.assertEqual(spoken,[MESSAGE,'下一轮正常。'])
        finally:await controller.close()

    async def test_muted_capture_remains_muted_on_model_failure(self):
        async def api(path,body):return FAILED if path=='/result' else {}
        controller=Conversation(BotAgent(api=api),Audio(),'unused',log=lambda _:None,synthesize=tts)
        try:
            controller.muted=True
            await controller.ask('hello',expected_project=PROJECT);await asyncio.wait_for(controller.wait_idle(),1)
            self.assertEqual(controller.voice_state()['capture'],'muted')
            self.assertEqual(controller.voice_state()['problem'],MESSAGE)
        finally:await controller.close()

    async def test_user_cancel_is_not_a_model_or_device_failure_and_does_not_hang_speech(self):
        for mode in ['settled-answer','hybrid-stream']:
            calls=[];logs=[];spoken=[]
            async def api(path,body):
                calls.append(path)
                result={'status':'cancelled','userMessage':'不得朗读取消'}
                if path=='/stream-snapshot':return {'cursor':{'hostEpoch':'host','seq':0},'result':result,'stream':None}
                return result if path=='/result' else {}
            agent=BotAgent(api=api);agent.output_mode=mode
            async def synth(text,*args,**kwargs):spoken.append(text);yield b'\1\0'*10
            controller=Conversation(agent,Audio(),'unused',log=logs.append,synthesize=synth)
            try:
                await controller.ask('hello',expected_project=PROJECT);await asyncio.wait_for(controller.wait_idle(),1)
                self.assertEqual(controller.records[-1]['status'],'interrupted')
                self.assertEqual(controller.records[-1]['interruption'],'cancelled')
                self.assertNotIn('error',controller.records[-1]);self.assertFalse(controller.audio_failed)
                self.assertEqual(controller.voice_state()['capture'],'listening');self.assertIsNone(controller.voice_state()['problem'])
                self.assertEqual(spoken,[]);self.assertFalse(any('失败' in line or '回复中断' in line for line in logs))
                self.assertNotIn('/voice/cancel-request',calls)
            finally:await controller.close()

    async def test_asr_failure_is_distinct_and_never_submits_to_model(self):
        calls=[]
        async def api(path,body):calls.append(path);return {}
        controller=Conversation(BotAgent(api=api),Audio(),'unused',log=lambda _:None,synthesize=tts)
        try:
            await controller.handle({'type':'start','id':1,'epoch':0})
            await controller.handle({'type':'failed','id':1,'epoch':0,'error':'识别连接中断'})
            self.assertEqual(controller.voice_state()['problem'],'这段语音未能识别，请重新说话。')
            self.assertEqual(controller.voice_state()['capture'],'listening');self.assertFalse(controller.audio_failed)
            self.assertNotIn('/ask',calls)
        finally:await controller.close()

    async def test_failed_tts_notice_does_not_recurse_or_replace_original_model_problem(self):
        attempts=[];calls=[];logs=[]
        async def api(path,body):calls.append(path);return FAILED if path=='/result' else {}
        async def broken(text,*args,**kwargs):
            attempts.append(text);raise ValueError('TTS service unavailable')
            yield b''
        controller=Conversation(BotAgent(api=api),Audio(),'unused',log=logs.append,synthesize=broken)
        try:
            await controller.ask('hello',expected_project=PROJECT);await asyncio.wait_for(controller.wait_idle(),1)
            self.assertEqual(attempts,[MESSAGE]);self.assertEqual(calls.count('/ask'),1)
            self.assertEqual(controller.records[-1]['failure_notice']['status'],'unavailable')
            self.assertEqual(controller.voice_state()['problem'],MESSAGE)
            self.assertEqual(controller.voice_state()['capture'],'listening');self.assertFalse(controller.audio_failed)
            self.assertEqual(logs.count(MESSAGE),1)
        finally:await controller.close()

    async def test_stop_cancels_only_the_notice_without_model_replay_and_keeps_listening(self):
        started=asyncio.Event();closed=[];spoken=[];calls=[]
        async def api(path,body):calls.append(path);return FAILED if path=='/result' else {}
        async def synth(text,*args,**kwargs):
            spoken.append(text)
            try:
                yield b'\1\0'*10
                started.set();await asyncio.Future()
            finally:closed.append(True)
        controller=Conversation(BotAgent(api=api),Audio(),'unused',log=lambda _:None,synthesize=synth)
        try:
            await controller.ask('hello',expected_project=PROJECT);await asyncio.wait_for(started.wait(),1)
            self.assertEqual(controller.voice_state()['playback'],'buffering')
            await controller.control('/stop');await asyncio.wait_for(controller.wait_idle(),1)
            self.assertEqual(closed,[True]);self.assertEqual(spoken,[MESSAGE]);self.assertEqual(calls.count('/ask'),1)
            self.assertEqual(controller.records[-1]['failure_notice']['status'],'interrupted')
            self.assertEqual(controller.voice_state()['capture'],'listening');self.assertIsNone(controller.voice_state()['problem'])
        finally:await controller.close()

    async def test_notice_keeps_barge_in_guard_for_weak_echo_and_accepts_real_user_interruption(self):
        started=asyncio.Event();spoken=[];prompts=[]
        async def api(path,body):
            if path=='/projects':return {'state':PROJECT}
            if path=='/ask':prompts.append(body['text']);return {}
            if path=='/result':return FAILED if len(prompts)==1 else {'status':'completed','text':'继续。','speechText':'继续。'}
            return {}
        async def synth(text,*args,**kwargs):
            spoken.append(text);yield b'\1\0'*10
            if text==MESSAGE:started.set();await asyncio.Future()
        controller=Conversation(BotAgent(api=api),Audio(),'unused',log=lambda _:None,synthesize=synth)
        try:
            await controller.ask('hello',expected_project=PROJECT);await asyncio.wait_for(started.wait(),1)
            # Existing AEC/barge-in evidence rejects low-strength echoed text.
            for kind in ['start','end','final']:
                await controller.handle({'type':kind,'id':1,'epoch':0,'text':MESSAGE,'acoustic':{'strong_ms':32}})
            self.assertEqual(prompts,['hello']);self.assertEqual(controller.records[0]['failure_notice']['status'],'playing')
            for kind in ['start','end','final']:
                await controller.handle({'type':kind,'id':2,'epoch':0,'text':'换个问题','acoustic':{'strong_ms':320}})
            await asyncio.wait_for(controller.wait_idle(),1)
            self.assertEqual(prompts,['hello','换个问题'])
            self.assertEqual(spoken,[MESSAGE,'继续。'])
            self.assertEqual(controller.records[0]['failure_notice']['status'],'interrupted')
            self.assertEqual(controller.records[-1]['status'],'complete')
        finally:await controller.close()
