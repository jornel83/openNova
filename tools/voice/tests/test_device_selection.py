"""Drive actual voice control/lease loops with audio startup held at the boundary."""
import asyncio
import copy
from contextlib import ExitStack
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from continuous_run import run, VOICE_DISABLED_EXIT_CODE
from ui_bridge import UiBridge


class DeviceSelectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        import os
        import tempfile
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        environment = patch.dict(os.environ, {'OPENNOVA_BOT_HOME':home.name})
        environment.start()
        self.addCleanup(environment.stop)

    async def scenario(self, action=None, *, fail=False, stale=False):
        audios, calls, acknowledgements, snapshots, controls = [], [], {}, [], []
        first_ready, second_starting, release_second = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def until(condition):
            async with asyncio.timeout(2):
                while not condition(): await asyncio.sleep(.005)
        async def api(path,body,**kwargs):
            calls.append((path,copy.deepcopy(body)))
            if path == '/voice/publish': snapshots.append(copy.deepcopy(body))
            elif path == '/voice/ack': acknowledgements[body['id']]=body['status']
            elif path == '/voice/poll':
                await asyncio.sleep(.005)
                return {'commands':[c for c in controls if c['id'] not in acknowledgements]}
            return {}
        class Audio:
            def __init__(self,**devices):
                self.devices=devices;self.input=asyncio.Queue();self.closed=False;self.captures=[]
                audios.append(self)
            async def start(self):
                if self is audios[0]: first_ready.set()
                elif self is audios[1]:
                    second_starting.set();await release_second.wait()
                    if fail: raise ValueError('selected Bluetooth device disconnected')
                return {'input':'Mac microphone','output':'Bluetooth speaker'}
            async def clear(self,generation): pass
            async def capture(self,enabled,epoch): self.captures.append(enabled)
            async def close(self): self.closed=True
        class Agent:
            error=None;process=None
            async def start(self): return {'sessionId':'existing-project-session'}
            async def _api(self,path,body,**kwargs): return await api(path,body,**kwargs)
            async def control(self,command): return None
            async def close(self): pass
        class Capture:
            def __init__(self,*args,**kwargs): pass
            def reset(self,epoch): pass
            async def close(self): pass
        class Speaker:
            def __init__(self,*args,**kwargs): pass
            async def run(self): await asyncio.Future()
        async def check(*args,**kwargs): return {'input':'old mic','output':'old speaker'}
        def push(ident,action,**extra):
            current=snapshots[-1]
            controls.append({'id':ident,'action':action,'generation':current['generation'],
                'voiceInstanceId':current['voiceInstanceId'],'requestId':current['requestId'],**extra})
        async def terminal(queue):
            await first_ready.wait()
            push('select','devices',devices={'input':'uid:mac','output':'uid:speaker'},deviceRevision=0 if stale else 1)
            if stale:
                await until(lambda:'select' in acknowledgements)
                await queue.put('/quit')
                await asyncio.Future()
            await second_starting.wait()
            self.assertNotIn('select',acknowledgements,'queued device changes must not be acknowledged as connected')
            await until(lambda:snapshots[-1].get('devices',{}).get('switching'))
            if action:
                push(action,action)
                await until(lambda:action in acknowledgements)
                self.assertEqual(acknowledgements[action],'applied')
                if action == 'disable': await asyncio.Future()
            release_second.set()
            await until(lambda:'select' in acknowledgements)
            self.assertEqual(acknowledgements['select'],'failed' if fail else 'applied')
            if fail:
                await until(lambda:snapshots[-1]['capture']=='error')
                self.assertEqual(len(audios),2,'failure must not silently try a default device')
                push('recover','devices',devices={'input':None,'output':None},deviceRevision=2)
                await until(lambda:'recover' in acknowledgements)
                self.assertEqual(acknowledgements['recover'],'applied')
            await until(lambda:not snapshots[-1]['devices']['switching'])
            await queue.put('/quit')
            await asyncio.Future()
        args=SimpleNamespace(bot=True,audio=None,no_play=False,output_dir=None,check=False,
            device='old mic',output_device='old speaker',tts_url='http://unused',silence_ms=800,extended_silence_ms=1600)
        patches={
            'continuous_run.NativeAudio':Audio,'continuous_run.BotAgent':Agent,
            'continuous_run.UiBridge':lambda callback:UiBridge(callback,interval=.01),
            'continuous_run.TurnCapture':Capture,'continuous_run.SileroOnnx':lambda:None,
            'continuous_run.TaskNotificationSpeaker':Speaker,'continuous_run.read_controls':terminal,
            'continuous_run.check_native':check,'conversation.preflight':lambda _:None,
            'conversation.check_cloud_tts':check,'builtins.print':lambda *a,**k:None,
        }
        with ExitStack() as stack:
            for name,value in patches.items(): stack.enter_context(patch(name,value))
            stack.enter_context(patch.dict('os.environ',{'OPENNOVA_VOICE_DEVICE_REVISION':'0'}))
            code=await asyncio.wait_for(run(args,''),4)
        self.assertTrue(all(a.closed for a in audios))
        self.assertFalse(any(p in ('/snapshot','/voice/cancel-request','/shutdown') or 'background-task' in p for p,_ in calls))
        self.assertFalse(snapshots[-1]['connected'])
        return audios, acknowledgements, snapshots, code

    async def test_switch_waits_for_ready_and_preserves_mute_or_end_arriving_during_startup(self):
        for action in ('mute','end'):
            with self.subTest(action=action):
                audios,acks,states,code=await self.scenario(action)
                self.assertEqual(len(audios),2)
                self.assertEqual(audios[1].devices,{'device':'uid:mac','output_device':'uid:speaker'})
                self.assertNotIn(True,audios[1].captures)
                self.assertEqual(acks['select'],'applied')
                self.assertTrue(any(s.get('deviceRevision')==1 and s['devices'].get('activeOutput')=='Bluetooth speaker' for s in states))
                self.assertEqual(code,0)

    async def test_failure_acknowledges_failure_without_fallback_and_accepts_new_selection(self):
        audios,acks,states,_=await self.scenario(fail=True)
        self.assertEqual(len(audios),3)
        self.assertEqual(audios[2].devices,{'device':None,'output_device':None})
        self.assertEqual(acks,{'select':'failed','recover':'applied'})
        self.assertTrue(any(s.get('deviceRevision')==2 and not s['devices']['switching'] for s in states))

    async def test_disable_remains_responsive_and_closes_pending_device_without_success_ack(self):
        audios,acks,_,code=await self.scenario('disable')
        self.assertEqual(code,VOICE_DISABLED_EXIT_CODE)
        self.assertEqual(len(audios),2)
        self.assertEqual(acks,{'select':'stale','disable':'applied'})
        self.assertEqual(audios[1].captures,[])

    async def test_old_device_revision_does_not_reopen_audio(self):
        audios,acks,_,_=await self.scenario(stale=True)
        self.assertEqual(len(audios),1)
        self.assertEqual(acks['select'],'stale')
