"""Exercise interruption decisions without microphone or remote services."""
import asyncio
from array import array
from pathlib import Path
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from continuous import Conversation
from turns import TurnCapture
from test_continuous import Agent, Audio, tts


class BargeInTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.agent, self.audio = Agent(), Audio()
        self.agent.hold = True
        self.logs = []
        self.c = Conversation(self.agent, self.audio, 'unused', synthesize=tts, log=self.logs.append)
        await self.c.ask('请详细介绍一下这个项目')
        await asyncio.sleep(.01)
        self.original = self.c.response
        self.generation = self.c.generation

    async def asyncTearDown(self):
        await self.c.close()

    async def event(self, kind, *, strong_ms=96, text='', at=None, ident=1):
        await self.c.handle({'type':kind, 'id':ident, 'epoch':self.c.epoch,
                             'time':time.monotonic() if at is None else at,
                             'text':text, 'acoustic':{'strong_ms':strong_ms}})

    async def test_short_candidate_does_not_pause_or_cancel(self):
        await self.event('start')
        await self.event('partial', text='嗯')
        await self.event('failed')
        self.assertNotIn('pause', self.audio.calls)
        self.assertIs(self.c.response, self.original)

    async def test_single_filler_final_does_not_replace_response(self):
        await self.event('start')
        await self.event('evidence', strong_ms=320)
        await self.event('partial', strong_ms=320, text='嗯')
        await self.event('final', strong_ms=320, text='嗯。')
        self.assertIs(self.c.response, self.original)
        self.assertEqual(self.agent.prompts, ['请详细介绍一下这个项目'])
        self.assertIn('resume', self.audio.calls)

    async def test_filler_does_not_turn_one_character_ack_into_interruption(self):
        await self.event('start')
        await self.event('final', strong_ms=320, text='嗯，好')
        self.assertIs(self.c.response, self.original)
        await self.event('start', ident=2)
        self.agent.hold = False
        await self.event('final', strong_ms=320, text='嗯，好的', ident=2)
        await self.c.wait_idle()
        self.assertIn('嗯，好的', self.agent.prompts[-1])

    async def test_strong_candidate_pauses_then_failure_resumes(self):
        await self.event('start')
        self.assertNotIn('pause', self.audio.calls)
        await self.event('evidence', strong_ms=320)
        self.assertIn('pause', self.audio.calls)
        await self.event('partial', strong_ms=320, text='帮我')
        self.assertIs(self.c.response, self.original)
        await self.event('failed')
        self.assertIn('resume', self.audio.calls)
        self.assertEqual(self.c.generation, self.generation)

    async def test_stable_growing_partial_confirms(self):
        start = time.monotonic()
        await self.event('start', at=start)
        await self.event('partial', strong_ms=320, text='帮我', at=start+.1)
        self.assertIs(self.c.response, self.original)
        await self.event('partial', strong_ms=512, text='帮我换个说法', at=start+.35)
        self.assertIsNone(self.c.response)
        self.assertGreater(self.c.generation, self.generation)

    async def test_revised_partial_needs_new_stability_window(self):
        start = time.monotonic()
        await self.event('start', at=start)
        await self.event('partial', strong_ms=320, text='帮我', at=start+.1)
        await self.event('partial', strong_ms=512, text='你好', at=start+.4)
        self.assertIs(self.c.response, self.original)
        await self.event('partial', strong_ms=640, text='你好呀', at=start+.65)
        self.assertIsNone(self.c.response)

    async def test_short_stop_has_fast_path_but_weak_audio_does_not(self):
        await self.event('start', strong_ms=0)
        await self.event('partial', strong_ms=0, text='停')
        self.assertIs(self.c.response, self.original)
        await self.event('partial', strong_ms=96, text='停')
        self.assertIsNone(self.c.response)

    async def test_final_can_confirm_without_multiple_partials(self):
        await self.event('start')
        self.agent.hold = False
        await self.event('final', strong_ms=320, text='简短一点')
        await self.c.wait_idle()
        self.assertIn('简短一点', self.agent.prompts[-1])

    async def test_confirmed_short_command_keeps_revised_final(self):
        await self.event('start')
        await self.event('partial', strong_ms=96, text='停')
        self.assertIsNone(self.c.response)
        self.agent.hold = False
        await self.event('final', strong_ms=192, text='停啊')
        await self.c.wait_idle()
        self.assertIn('停啊', self.agent.prompts[-1])

    async def test_pause_expires_and_same_candidate_does_not_pause_again(self):
        await self.event('start')
        await self.event('evidence', strong_ms=320)
        await self.event('tick', at=time.monotonic()+2)
        self.assertIn('resume', self.audio.calls)
        await self.event('evidence', strong_ms=800)
        self.assertEqual(self.audio.calls.count('pause'), 1)
        self.assertIs(self.c.response, self.original)

    async def test_late_timeout_after_mute_does_not_resume_again(self):
        await self.event('start')
        await self.event('evidence', strong_ms=320)
        await self.c.control('/mute')
        await self.c.control('/unmute')
        count = self.audio.calls.count('resume')
        await self.event('tick', at=time.monotonic()+2)
        self.assertEqual(self.audio.calls.count('resume'), count)

    async def test_overlapping_candidates_do_not_resume_until_both_resolved(self):
        await self.event('start')
        await self.event('evidence', strong_ms=320)
        await self.event('start', ident=2)
        await self.event('evidence', strong_ms=320, ident=2)
        await self.event('failed')
        self.assertNotIn('resume', self.audio.calls)
        await self.event('failed', ident=2)
        self.assertEqual(self.audio.calls.count('resume'), 1)

    async def test_real_capture_filters_short_and_quiet_but_passes_sustained_speech(self):
        events = []
        probability = 0
        async def recognize(source, ident, partial):
            async for _ in source: pass
            return {'success':False}
        capture = TurnCapture(lambda _:probability, recognize, events.append)
        async def feed(count, amplitude, confidence):
            nonlocal probability
            probability = confidence
            frame = array('h', [amplitude, -amplitude]*256).tobytes()
            for _ in range(count):
                capture.feed(0, frame)
                await asyncio.sleep(0)
                while events: await self.c.handle(events.pop(0))
        try:
            await feed(100, 100, .05)  # steady background, about -50 dBFS
            await feed(4, 4000, .95)   # loud, brief cough-like candidate
            await feed(26, 100, .05)
            await feed(12, 4000, .55)  # loud, sustained but low VAD confidence
            await feed(26, 100, .05)
            await feed(15, 120, .95)   # speech-like signal barely above background
            await feed(26, 100, .05)
            self.assertNotIn('pause', self.audio.calls)
            await feed(12, 4000, .95)  # sustained clear candidate
            self.assertEqual(self.audio.calls.count('pause'), 1)
        finally:
            await capture.close()


class PauseWatchdogTests(unittest.IsolatedAsyncioTestCase):
    async def test_cli_resumes_even_when_audio_frames_stop_arriving(self):
        from continuous_run import run
        resumed = asyncio.Event()
        class QuietAudio(Audio):
            def __init__(self, **kwargs):
                super().__init__()
                self.input = asyncio.Queue()
            async def start(self): return {'input':'test','output':'test'}
            async def resume(self):
                await super().resume()
                resumed.set()
            async def close(self): pass
        class HeldAgent(Agent):
            def __init__(self):
                super().__init__()
                self.hold = True
            async def start(self): return {'sessionId':'test'}
            async def close(self): pass
        class Capture:
            def __init__(self, detector, asr, emit, **kwargs):
                for event in ({'type':'start','id':1},
                              {'type':'final','id':1,'text':'请介绍项目'},
                              {'type':'start','id':2},
                              {'type':'evidence','id':2,'acoustic':{'strong_ms':320}}):
                    emit({'epoch':0, **event})
            def reset(self, epoch): pass
            async def close(self): pass
        async def controls(queue):
            await resumed.wait()
            await queue.put('/quit')
            await asyncio.Event().wait()
        async def check(**kwargs): return {'input':'test','output':'test'}
        async def synth(*args, **kwargs): yield b'\1\0'*100
        args = SimpleNamespace(audio=None,no_play=False,output_dir=None,check=False,
            device=None,output_device=None,tts_url='unused',silence_ms=800,extended_silence_ms=1600)
        with patch('continuous_run.NativeAudio',QuietAudio), patch('continuous_run.StreamingAgent',HeldAgent), \
             patch('continuous_run.TurnCapture',Capture), patch('continuous_run.SileroOnnx',lambda:None), \
             patch('continuous_run.read_controls',controls), patch('continuous_run.check_native',check), \
             patch('continuous_run.synthesize',synth), patch('conversation.preflight',lambda _:None), \
             patch('builtins.print'):
            try: await asyncio.wait_for(run(args,''), 2.5)
            except TimeoutError: self.fail('候选暂停必须独立于后续音频帧，在超时后恢复')
        self.assertTrue(resumed.is_set())
