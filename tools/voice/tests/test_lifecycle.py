import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from continuous_run import run

class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def scenario(self, action, *, quit_during_ready=False):
        instances=[]
        second_started=asyncio.Event()
        release_second=asyncio.Event()
        command_applied=asyncio.Event()
        state={'quitting':False}
        class Audio:
            def __init__(self):
                self.input=asyncio.Queue(); self.closed=False; self.enabled=[]; self.frames=0
                instances.append(self)
            async def start(self):
                if len(instances)>1:
                    second_started.set(); await release_second.wait()
                return {'input':'Air','output':'Air','voice_processing':True}
            async def clear(self,generation):
                if state['quitting'] and quit_during_ready:
                    release_second.set()
                    await asyncio.sleep(.03)  # let the already-pending queue.get own audio_ready
            async def capture(self,enabled,epoch):
                self.enabled.append(enabled)
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
        args=SimpleNamespace(audio=None,no_play=False,output_dir=None,check=False,device=None,output_device=None,
                             tts_url='http://unused',silence_ms=800,extended_silence_ms=1600)
        async def check(): return {'input':'Air','output':'Air'}
        with patch('continuous_run.NativeAudio',Audio),patch('continuous_run.StreamingAgent',Agent),\
             patch('continuous_run.TurnCapture',Capture),patch('continuous_run.SileroOnnx',lambda:None),\
             patch('continuous_run.read_controls',commands),patch('continuous_run.check_native',check),\
             patch('conversation.preflight',lambda _:None),patch('builtins.print'):
            await asyncio.wait_for(run(args,''),3)
        return instances

    async def test_retry_preserves_later_mute(self):
        instances=await self.scenario('/mute')
        self.assertNotIn(True,instances[1].enabled)
    async def test_retry_preserves_later_end(self):
        instances=await self.scenario('/end')
        self.assertNotIn(True,instances[1].enabled)
    async def test_quit_owns_ready_resource_already_consumed_by_event_wait(self):
        instances=await self.scenario('/quit',quit_during_ready=True)
        self.assertEqual(len(instances),2)
        self.assertTrue(all(instance.closed for instance in instances))
