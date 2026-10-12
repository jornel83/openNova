import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from turns import TurnCapture, silence_for

VOICE = b'\1\0' * 512
QUIET = b'\0' * 1024

class TurnTests(unittest.IsolatedAsyncioTestCase):
    def test_endpoint_uses_latest_revision_and_bounded_extension(self):
        self.assertEqual(silence_for('我想先优化', 800, 1600), 1600)
        self.assertEqual(silence_for('我想先优化语音交互。', 800, 1600), 800)
        self.assertEqual(silence_for('不，改成', 800, 1600), 1600)
        self.assertEqual(silence_for('好', 800, 1600), 800)

    async def test_pause_then_continuation_is_one_final_with_preroll(self):
        events, received = [], []
        async def recognize(source, ident, partial):
            async for pcm, final in source: received.append(pcm)
            return {'success':True, 'text':'我想先优化语音交互'}
        capture = TurnCapture(lambda frame: 1 if any(frame) else 0, recognize, events.append)
        for frame in [QUIET]*10+[VOICE]*4+[QUIET]*10+[VOICE]*4+[QUIET]*26:
            capture.feed(0, frame)
            await asyncio.sleep(0)
        await capture.finish()
        self.assertEqual([e['type'] for e in events], ['start','end','final'])
        self.assertTrue(b''.join(received).startswith(QUIET))
        self.assertEqual(b''.join(received).count(VOICE), 8)
        await capture.close()

    async def test_mute_invalidates_late_final_even_if_asr_ignores_cancel(self):
        events = []
        started = asyncio.Event()
        async def recognize(source, ident, partial):
            started.set()
            try: await asyncio.sleep(5)
            except asyncio.CancelledError: pass
            partial('晚到的中间结果')
            return {'success':True, 'text':'晚到的结果'}
        capture = TurnCapture(lambda _:1, recognize, events.append)
        for _ in range(3): capture.feed(0, VOICE)
        await started.wait()
        capture.reset(1)
        await asyncio.sleep(0)
        self.assertFalse(any(e['type'] in ('partial','final') for e in events))
        await capture.close()

    async def test_asr_failure_allows_next_utterance(self):
        events = []
        async def recognize(source, ident, partial):
            async for _ in source: pass
            if ident == 1: raise ValueError('offline')
            return {'success':True,'text':'好了'}
        capture = TurnCapture(lambda frame: int(any(frame)), recognize, events.append)
        for _ in range(2):
            for frame in [VOICE]*4+[QUIET]*26:
                capture.feed(0, frame)
                await asyncio.sleep(0)
            await capture.finish()
        self.assertEqual([e['type'] for e in events if e['type'] in ('failed','final')], ['failed','final'])
        await capture.close()

    async def test_failed_long_turn_discards_remainder_until_real_silence(self):
        events=[]
        async def recognize(source,ident,partial):
            async for _ in source: pass
            return {'success':True,'text':'新的一轮'}
        capture=TurnCapture(lambda frame:int(any(frame)),recognize,events.append)
        for _ in range(3): capture.feed(0,VOICE)
        capture.gate.max_frames=4
        for _ in range(20): capture.feed(0,VOICE)
        self.assertEqual(sum(e['type']=='start' for e in events),1)
        for frame in [QUIET]*25+[VOICE]*3+[QUIET]*25:
            capture.feed(0,frame)
            await asyncio.sleep(0)
        await capture.finish()
        self.assertEqual(sum(e['type']=='start' for e in events),2)
        await capture.close()
