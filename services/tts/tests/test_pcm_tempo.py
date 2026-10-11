"""Check real FFmpeg streaming behavior and cleanup at the PCM boundary."""
import importlib.util
import math
from pathlib import Path
import struct
from threading import Event, enumerate as threads
import unittest


SPEC = importlib.util.spec_from_file_location('pcm_tempo', Path(__file__).resolve().parents[1] / 'pcm_tempo.py')
tempo = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tempo)
PCM = struct.pack('<24000h', *(round(10000 * math.sin(2 * math.pi * 440 * i / 24000))
                             for i in range(24000)))


class StreamingTempoTests(unittest.TestCase):
    def test_emits_audio_before_input_finishes_and_preserves_tail(self):
        ready = Event()
        chunks = []

        def consume(data):
            chunks.append(data)
            ready.set()

        with tempo.tempo_output(1.5, consume) as write:
            write(PCM)
            self.assertTrue(ready.wait(2), 'Tempo adjustment must not wait for input EOF')
            write(PCM)
        self.assertAlmostEqual(sum(map(len, chunks)) / 48000, 2 / 1.5, delta=0.08)
        self.assertFalse(any(t.name == 'tts-tempo-output' for t in threads()))

    def test_consumer_failure_propagates_and_closes_reader(self):
        def consume(data):
            raise RuntimeError('audio output failed')

        with self.assertRaisesRegex(RuntimeError, 'audio output failed'):
            with tempo.tempo_output(1.5, consume) as write:
                write(PCM)
        self.assertFalse(any(t.name == 'tts-tempo-output' for t in threads()))

    def test_input_failure_does_not_leave_reader_running(self):
        with self.assertRaisesRegex(RuntimeError, 'network failure'):
            with tempo.tempo_output(1.5, lambda _: None) as write:
                write(PCM[:4096])
                raise RuntimeError('network failure')
        self.assertFalse(any(t.name == 'tts-tempo-output' for t in threads()))


if __name__ == '__main__':
    unittest.main()
