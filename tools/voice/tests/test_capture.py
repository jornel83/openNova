import asyncio
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capture import capture_turn

FRAME = b'\x01\x00' * 512


class CaptureTests(unittest.IsolatedAsyncioTestCase):
    async def test_silence_never_opens_asr(self):
        async def source():
            for _ in range(10):
                yield FRAME, False
        async def recognize(audio):
            self.fail('silence must not open ASR')
        self.assertIsNone(await capture_turn(source(), lambda _: 0.0, recognize))

    async def test_microphone_closes_before_final_transcript_is_consumed(self):
        closed = False
        seen = []
        async def source():
            nonlocal closed
            try:
                for _ in range(40):
                    yield FRAME, False
                    await asyncio.sleep(0)
            finally:
                closed = True
        probabilities = iter([0.9] * 5 + [0.0] * 35)
        async def recognize(audio):
            async for pcm, final in audio:
                seen.append((pcm, final))
            await asyncio.sleep(0)
            self.assertTrue(closed)
            return {'success': True, 'text': '最终修订内容'}
        result = await capture_turn(source(), lambda _: next(probabilities), recognize, silence_ms=96)
        self.assertEqual(result['text'], '最终修订内容')
        self.assertEqual(sum(final for _, final in seen), 1)

    async def test_truncated_utterance_cancels_asr_and_closes_source(self):
        settled = asyncio.Event()
        async def source():
            for _ in range(6):
                yield FRAME, False
                await asyncio.sleep(0)
        async def recognize(audio):
            try:
                async for _ in audio:
                    pass
            finally:
                settled.set()
        with self.assertRaisesRegex(ValueError, '截断'):
            await capture_turn(source(), lambda _: .9, recognize)
        self.assertTrue(settled.is_set())

    async def test_asr_failure_closes_microphone(self):
        closed = False
        async def source():
            nonlocal closed
            try:
                for _ in range(100):
                    yield FRAME, False
                    await asyncio.sleep(0)
            finally:
                closed = True
        async def recognize(audio):
            raise RuntimeError('ASR unavailable')
        with self.assertRaisesRegex(RuntimeError, 'ASR unavailable'):
            await capture_turn(source(), lambda _: .9, recognize)
        self.assertTrue(closed)
