import asyncio
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from continuous_run import run, VOICE_DISABLED_EXIT_CODE
from continuous import Conversation
from bot_agent import BotAgent

class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        environment = patch.dict(os.environ, {'OPENNOVA_BOT_HOME':home.name})
        environment.start()
        self.addCleanup(environment.stop)

    async def test_disable_releases_devices_and_owned_pipeline_without_cancelling_web_or_tasks(self):
        for replying in (False, True):
            with self.subTest(replying=replying):
                calls,resources,acks=[],{},[]
                ready=asyncio.Event()
                response_started=asyncio.Event()
                response_closed=asyncio.Event()
                async def api(path,body,**kwargs):
                    calls.append((path,body))
                    if path=='/health':return {'sessionId':'shared'}
                    if path=='/snapshot':return {'activeId':'unrelated-web-request'}
                    return {}
                agent=BotAgent(api=api)
                class Audio:
                    def __init__(self,**devices):
                        self.input=asyncio.Queue();self.closed=False;self.captures=[]
                        resources['audio']=self
                    async def start(self):ready.set();return {'input':'AirPods','output':'AirPods'}
                    async def capture(self,enabled,epoch):self.captures.append(enabled)
                    async def clear(self,generation):pass
                    async def close(self):self.closed=True
                class Capture:
                    def __init__(self,*args,**kwargs):self.closed=False;resources['capture']=self
                    def reset(self,epoch):pass
                    async def close(self):self.closed=True
                class Controller(Conversation):
                    def __init__(self,*args,**kwargs):
                        super().__init__(*args,**kwargs)
                        if replying:
                            self.agent.current='owned-voice-request'
                            async def pipeline():
                                response_started.set()
                                try:await asyncio.Future()
                                finally:
                                    await self.agent.cancel()
                                    self.agent.current=None
                                    response_closed.set()
                            self.response=asyncio.create_task(pipeline())
                            self.tasks.add(self.response)
                            self.response_record={'status':'running','input':'voice test','admitted':True,'requestId':'owned-voice-request'}
                class Bridge:
                    instance_id='native-client'
                    def __init__(self,*args,**kwargs):self.closed=False;resources['bridge']=self
                    def publish(self,state):pass
                    async def connect(self):pass
                    async def run(self,commands):
                        await ready.wait()
                        if replying:await response_started.wait()
                        await commands.put({'id':'disable','action':'disable','voiceInstanceId':self.instance_id,'generation':0})
                        await asyncio.Future()
                    def ack(self,command,result):acks.append(result['status'])
                    async def close(self):self.closed=True
                class Speaker:
                    def __init__(self,*args,**kwargs):pass
                    async def run(self):await asyncio.Future()
                async def terminal(commands):await asyncio.Future()
                async def check(*args,**kwargs):return {'input':'AirPods','output':'AirPods'}
                args=SimpleNamespace(bot=True,audio=None,no_play=False,output_dir=None,check=False,device=None,output_device=None,tts_url='http://unused',silence_ms=800,extended_silence_ms=1600)
                with patch('continuous_run.NativeAudio',Audio),patch('continuous_run.BotAgent',lambda:agent), \
                     patch('continuous_run.UiBridge',Bridge),patch('continuous_run.Conversation',Controller), \
                     patch('continuous_run.TurnCapture',Capture),patch('continuous_run.SileroOnnx',lambda:None), \
                     patch('continuous_run.TaskNotificationSpeaker',Speaker),patch('continuous_run.read_controls',terminal), \
                     patch('continuous_run.check_native',check),patch('conversation.preflight',lambda _:None), \
                     patch('conversation.check_cloud_tts',check),patch('builtins.print'):
                    result=await asyncio.wait_for(run(args,''),1)
                self.assertEqual(result,VOICE_DISABLED_EXIT_CODE)
                self.assertTrue(all(resource.closed for resource in resources.values()))
                self.assertTrue(agent.closed)
                self.assertEqual(resources['audio'].captures,[False])
                self.assertEqual(acks,['applied'])
                cancellations=[body['id'] for path,body in calls if path=='/voice/cancel-request']
                self.assertEqual(cancellations,['owned-voice-request'] if replying else [])
                self.assertNotIn('/snapshot',[path for path,_ in calls])
                self.assertFalse(any('background-task' in path or path=='/shutdown' for path,_ in calls))
                self.assertEqual(response_closed.is_set(),replying)

    async def test_mic_muted_start_publishes_muted_before_native_capture_and_never_enables_input(self):
        order, audios = [], []
        started = asyncio.Event()
        class Audio:
            def __init__(self,**devices):
                self.enabled=True; self.epoch=0; self.input=asyncio.Queue(); self.closed=False; self.captures=[]; audios.append(self)
            async def start(self):
                order.append('native-start')
                await self.capture(self.enabled,self.epoch)
                started.set()
                return {'input':'Air','output':'Air'}
            async def capture(self,enabled,epoch): self.captures.append(enabled)
            async def clear(self,generation): pass
            async def close(self): self.closed=True
        class Agent:
            def __init__(self): self.error=None; self.process=None
            async def start(self): return {'sessionId':'shared'}
            async def _api(self,*args,**kwargs): return {}
            async def control(self,command): return None
            async def close(self): pass
        class Bridge:
            instance_id='muted-client'
            def __init__(self,*args,**kwargs): self.state={}
            def publish(self,state): self.state.update(state)
            async def connect(self):
                self_test.assertEqual(self.state['capture'],'muted')
                order.append('muted-connected')
            async def run(self,commands): await asyncio.Future()
            async def close(self): pass
        class Capture:
            def __init__(self,*args,**kwargs): pass
            def reset(self,epoch): pass
            async def close(self): pass
        async def terminal(queue):
            await started.wait(); await queue.put('/quit'); await asyncio.Future()
        async def check(*args,**kwargs): return {'input':'Air','output':'Air'}
        self_test=self
        args=SimpleNamespace(bot=True,mic_muted=True,audio=None,no_play=False,output_dir=None,check=False,device=None,output_device=None,tts_url='http://unused',silence_ms=800,extended_silence_ms=1600)
        with patch('continuous_run.NativeAudio',Audio),patch('continuous_run.BotAgent',Agent),patch('continuous_run.UiBridge',Bridge),\
             patch('continuous_run.TurnCapture',Capture),patch('continuous_run.SileroOnnx',lambda:None),\
             patch('continuous_run.check_native',check),patch('conversation.preflight',lambda _:None),\
             patch('conversation.check_cloud_tts',check),patch('continuous_run.read_controls',terminal),patch('builtins.print'):
            await asyncio.wait_for(run(args,''),1)
        self.assertEqual(order,['muted-connected','native-start'])
        self.assertEqual(audios[0].captures,[False])
        self.assertTrue(audios[0].closed)

    async def scenario(self, action, *, quit_during_ready=False):
        instances=[]
        second_started=asyncio.Event()
        release_second=asyncio.Event()
        command_applied=asyncio.Event()
        state={'quitting':False}
        class Audio:
            def __init__(self, **devices):
                self.input=asyncio.Queue(); self.closed=False; self.capture_history=[]; self.frames=0
                self.devices=devices
                instances.append(self)
            async def start(self):
                if len(instances)>1:
                    assert self.enabled is False
                    second_started.set(); await release_second.wait()
                return {'input':'Air','output':'Air','voice_processing':True}
            async def clear(self,generation):
                if self.closed: raise ConnectionError('Connection lost')
                if state['quitting'] and quit_during_ready:
                    release_second.set()
                    await asyncio.sleep(.03)  # let the already-pending queue.get own audio_ready
            async def capture(self,enabled,epoch):
                if self.closed: raise ConnectionError('Connection lost')
                self.capture_history.append(enabled)
                if self is instances[0]: command_applied.set()
            async def pause(self): pass
            async def resume(self): pass
            async def close(self): self.closed=True
        class Agent:
            def __init__(self): self.error=None; self.process=SimpleNamespace(returncode=None)
            async def start(self): return {'sessionId':'test'}
            async def close(self): pass
        class Capture:
            def __init__(self,*args,**kwargs): pass
            def reset(self,epoch): pass
            async def close(self): pass
        async def commands(queue):
            await queue.put('/retry')
            await second_started.wait()
            command_applied.clear()
            if quit_during_ready:
                state['quitting']=True
                await queue.put('/quit')
            else:
                await queue.put(action)
                await command_applied.wait()
                release_second.set()
                await asyncio.sleep(.04)
                await queue.put('/quit')
            await asyncio.sleep(10)
        original_control=Conversation.control
        async def applied(controller,command):
            try: return await original_control(controller,command)
            finally:
                if command == action: command_applied.set()
        args=SimpleNamespace(audio=None,no_play=False,output_dir=None,check=False,device='SRS-XB100',output_device='SRS-XB100',
                             tts_url='http://unused',silence_ms=800,extended_silence_ms=1600)
        async def check(**devices): return {'input':'SRS-XB100','output':'SRS-XB100'}
        with patch('continuous_run.NativeAudio',Audio),patch('continuous_run.StreamingAgent',Agent),\
             patch('continuous_run.TurnCapture',Capture),patch('continuous_run.SileroOnnx',lambda:None),\
             patch('continuous_run.read_controls',commands),patch('continuous_run.check_native',check),\
             patch('conversation.preflight',lambda _:None),patch('continuous_run.Conversation.control',applied),patch('builtins.print') as output:
            await asyncio.wait_for(run(args,''),3)
            self.assertFalse(any('Connection lost' in str(call) for call in output.call_args_list))
        return instances

    async def test_retry_retains_device_selection(self):
        instances=await self.scenario('/mute')
        self.assertTrue(all(audio.devices == {'device':'SRS-XB100', 'output_device':'SRS-XB100'}
                            for audio in instances))

    async def test_retry_preserves_later_mute(self):
        instances=await self.scenario('/mute')
        self.assertNotIn(True,instances[1].capture_history)
    async def test_retry_preserves_later_end(self):
        instances=await self.scenario('/end')
        self.assertNotIn(True,instances[1].capture_history)
    async def test_quit_owns_ready_resource_already_consumed_by_event_wait(self):
        instances=await self.scenario('/quit',quit_during_ready=True)
        self.assertEqual(len(instances),2)
        self.assertTrue(all(instance.closed for instance in instances))

    async def recovery(self, *, agent_failed=False, web=False):
        """Inject a native input failure, then drive the actual CLI retry loop."""
        audios, agents, messages, received = [], [], [], []
        failed, resumed = asyncio.Event(), asyncio.Event()
        class Audio:
            def __init__(self, **devices):
                self.devices=devices; self.input=asyncio.Queue(); self.closed=False; self.frames=0
                audios.append(self)
            async def start(self):
                if len(audios)==1:
                    self.input.put_nowait(ValueError('injected audio route failure'))
                return {'input':'SRS-XB100','output':'SRS-XB100','voice_processing':True}
            async def clear(self,generation): pass
            async def capture(self,enabled,epoch):
                if enabled:
                    self.input.put_nowait((epoch,b'\1\0'*160))
            async def close(self): self.closed=True
        class Agent:
            def __init__(self,**options):
                self.error=None; self.process=SimpleNamespace(returncode=None); self.closed=False
                self.options=options
                agents.append(self)
            async def start(self): return {'sessionId':f'session-{len(agents)}'}
            async def close(self): self.closed=True
        class Capture:
            def __init__(self,*args,**kwargs): self.epoch=0
            def reset(self,epoch): self.epoch=epoch
            def feed(self,epoch,pcm):
                received.append((epoch,self.epoch,pcm)); resumed.set()
            async def close(self): pass
        def log(*items,**kwargs):
            message=' '.join(map(str,items)); messages.append(message)
            if message=='injected audio route failure': failed.set()
        async def commands(queue):
            await failed.wait()
            if agent_failed:
                agents[0].error=ValueError('agent disconnected')
                agents[0].process.returncode=1
            await queue.put('/retry')
            await resumed.wait()
            await queue.put('/quit')
            await asyncio.Event().wait()
        args=SimpleNamespace(audio=None,no_play=False,output_dir=None,check=False,
                             web=web,
                             device='SRS-XB100',output_device='SRS-XB100',
                             tts_url='http://unused',silence_ms=800,extended_silence_ms=1600)
        async def check(**devices): return {'input':'SRS-XB100','output':'SRS-XB100'}
        with patch('continuous_run.NativeAudio',Audio),patch('continuous_run.StreamingAgent',Agent),\
             patch('continuous_run.TurnCapture',Capture),patch('continuous_run.SileroOnnx',lambda:None),\
             patch('continuous_run.read_controls',commands),patch('continuous_run.check_native',check),\
             patch('conversation.preflight',lambda _:None),patch('builtins.print',log):
            await asyncio.wait_for(run(args,''),3)
        self.assertEqual(len(audios),2)
        self.assertTrue(all(audio.closed for audio in audios))
        self.assertTrue(all(audio.devices=={'device':'SRS-XB100','output_device':'SRS-XB100'} for audio in audios))
        self.assertTrue(all(agent.closed for agent in agents))
        self.assertEqual(len(received),1)
        epoch,current_epoch,pcm=received[0]
        self.assertGreater(epoch,0)
        self.assertEqual(epoch,current_epoch)
        self.assertTrue(pcm)
        return agents,messages

    async def test_retry_keeps_web_mode_on_replacement_agent(self):
        agents,_=await self.recovery(agent_failed=True,web=True)
        self.assertEqual([a.options for a in agents],[{'web':True},{'web':True}])

    async def test_audio_failure_retry_resumes_input_and_keeps_healthy_agent(self):
        agents,messages=await self.recovery()
        self.assertEqual(len(agents),1)
        self.assertFalse(any('新的模型会话' in message for message in messages))

    async def test_audio_failure_retry_replaces_dead_agent_with_explicit_notice(self):
        agents,messages=await self.recovery(agent_failed=True)
        self.assertEqual(len(agents),2)
        self.assertTrue(any('新的模型会话' in message for message in messages))

    async def test_lost_voice_owner_stops_capture_and_closes_process(self):
        audios=[]
        class Audio:
            def __init__(self,**kwargs):self.input=asyncio.Queue();self.closed=False;self.captures=[];audios.append(self)
            async def start(self):return {'input':'Air','output':'Air'}
            async def capture(self,enabled,epoch):self.captures.append(enabled)
            async def clear(self,generation):pass
            async def close(self):self.closed=True
        class Agent:
            def __init__(self):self.error=None;self.process=None
            async def start(self):return {'sessionId':'shared'}
            async def _api(self,*a,**k):return {}
            async def close(self):pass
        class Bridge:
            instance_id='lost-client'
            def __init__(self,*a,**k):pass
            async def connect(self):pass
            async def run(self,commands):await commands.put('/voice-owner-lost');await asyncio.Future()
            def publish(self,state):pass
            async def close(self):pass
        class Capture:
            def __init__(self,*a,**k):pass
            def reset(self,epoch):pass
            async def close(self):pass
        async def terminal(queue):await asyncio.Future()
        async def check(**kw):return {'input':'Air','output':'Air'}
        args=SimpleNamespace(bot=True,audio=None,no_play=False,output_dir=None,check=False,device=None,output_device=None,tts_url='http://unused',silence_ms=800,extended_silence_ms=1600)
        with patch('continuous_run.NativeAudio',Audio),patch('continuous_run.BotAgent',Agent),patch('continuous_run.UiBridge',Bridge),patch('continuous_run.TurnCapture',Capture),patch('continuous_run.SileroOnnx',lambda:None),patch('continuous_run.check_native',check),patch('conversation.preflight',lambda _:None),patch('continuous_run.read_controls',terminal),patch('builtins.print'):
            await asyncio.wait_for(run(args,''),1)
        self.assertEqual(audios[0].captures,[False]);self.assertTrue(audios[0].closed)
