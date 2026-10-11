"""VAD segmentation invariants, without microphone or cloud dependencies."""
import importlib.util
import asyncio
import io
from contextlib import redirect_stdout
from pathlib import Path
import struct
import unittest

VAD = Path(__file__).resolve().parents[1] / 'vad.py'


class GateTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(VAD.exists(), 'VAD module must be implemented')
        spec = importlib.util.spec_from_file_location('vad', VAD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.Gate = module.SpeechGate

    def frame(self, value):
        return struct.pack('<h', value) * 512

    def test_preroll_preserves_first_syllables_without_duplicate_audio(self):
        gate = self.Gate(pre_roll_ms=96, min_speech_ms=64, silence_ms=96)
        events = []
        frames = [self.frame(i) for i in range(12)]
        probs = [0] * 6 + [0.9] * 3 + [0] * 3
        for frame, prob in zip(frames, probs):
            events += gate.push(frame, prob)
        self.assertEqual([e[0] for e in events if e[0] != 'audio'], ['start', 'end'])
        self.assertEqual(b''.join(e[1] for e in events), b''.join(frames[3:]))

    def test_short_pause_stays_in_same_turn_and_second_turn_is_separate(self):
        gate = self.Gate(pre_roll_ms=32, min_speech_ms=64, silence_ms=96)
        probs = [0.9] * 3 + [0] * 2 + [0.9] * 2 + [0] * 5 + [0.9] * 3 + [0] * 3
        events = []
        for index, prob in enumerate(probs):
            events += gate.push(self.frame(index), prob)
        self.assertEqual([e[0] for e in events if e[0] != 'audio'], ['start', 'end', 'start', 'end'])
        first_end = next(i for i, e in enumerate(events) if e[0] == 'end')
        first = b''.join(e[1] for e in events[:first_end + 1])
        self.assertIn(self.frame(3) + self.frame(4), first)

    def test_silence_and_short_click_never_start_a_turn(self):
        gate = self.Gate(min_speech_ms=96)
        for prob in [0] * 100 + [0.9, 0.9] + [0] * 100:
            self.assertEqual(gate.push(self.frame(1), prob), [])
        self.assertEqual(gate.finish(), [])

    def test_input_limit_has_distinct_reason_and_finish_is_idempotent(self):
        gate = self.Gate(min_speech_ms=64)
        gate.push(self.frame(1), 0.9)
        gate.push(self.frame(2), 0.9)
        self.assertEqual(gate.finish(), [('end', b'', 'input_limit')])
        self.assertEqual(gate.finish(), [])

    def test_maximum_utterance_aborts_instead_of_silently_splitting(self):
        gate = self.Gate(min_speech_ms=32, max_speech_seconds=0.1)
        with self.assertRaisesRegex(ValueError, '最长'):
            for _ in range(10):
                gate.push(self.frame(1), 0.9)

    def test_invalid_frame_or_probability_is_rejected(self):
        gate = self.Gate()
        for frame, prob in [(b'bad', 0.5), (self.frame(1), float('nan')), (self.frame(1), 1.1)]:
            with self.assertRaises(ValueError):
                gate.push(frame, prob)


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('vad', VAD)
        self.vad = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.vad)

    def detector(self, frame):
        return 0.9 if struct.unpack_from('<h', frame)[0] > 100 else 0.0

    async def source(self, values, closed=None):
        try:
            for value in values:
                await asyncio.sleep(0)
                yield struct.pack('<h', value) * 512, False
        finally:
            if closed is not None:
                closed.append(True)

    async def test_only_silence_never_calls_cloud(self):
        async def forbidden(*args):
            self.fail('Silence must not create an ASR request')
        with redirect_stdout(io.StringIO()):
            result = await self.vad.run_vad(self.source([1] * 200), self.detector,
                                            forbidden, total_seconds=7)
        self.assertEqual(result['asr_requests'], 0)
        self.assertEqual(result['speech_turns'], 0)

    async def test_two_turns_preserve_audio_and_finish_each_request_once(self):
        captured = []

        async def recognize(source, turn_id):
            packets = [packet async for packet in source]
            self.assertEqual(sum(final for _, final in packets), 1)
            self.assertTrue(packets[-1][1])
            self.assertTrue(all(len(pcm) <= 6400 for pcm, _ in packets))
            captured.append((turn_id, b''.join(pcm for pcm, _ in packets)))
            return {'success': True}

        values = [1] * 20 + [1000] * 15 + [2] * 40 + [2000] * 15 + [3] * 40
        with redirect_stdout(io.StringIO()):
            result = await self.vad.run_vad(self.source(values), self.detector,
                                            recognize, total_seconds=5)
        self.assertEqual(result['asr_requests'], 2)
        self.assertEqual([t['end_reason'] for t in result['turns']], ['silence', 'silence'])
        self.assertEqual(captured[0][1], b''.join(struct.pack('<h', v) * 512 for v in values[10:60]))
        self.assertEqual(captured[1][1], b''.join(struct.pack('<h', v) * 512 for v in values[65:115]))

    async def test_cloud_failure_closes_microphone_source(self):
        closed = []

        async def failed(*args):
            raise RuntimeError('connection failed')

        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, 'connection failed'):
            await self.vad.run_vad(self.source([1000] * 200, closed), self.detector,
                                   failed, total_seconds=10)
        self.assertEqual(closed, [True])

    async def test_slow_cloud_is_cancelled_on_bounded_queue_overflow(self):
        closed = []
        cancelled = []

        async def stalled(*args):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)

        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, '积压'):
            await self.vad.run_vad(self.source([1000] * 200, closed), self.detector,
                                   stalled, total_seconds=10)
        self.assertEqual(closed, [True])
        self.assertEqual(cancelled, [True])


if __name__ == '__main__':
    unittest.main()
