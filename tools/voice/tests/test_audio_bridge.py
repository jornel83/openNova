import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audio_bridge import NativeAudio


class NativeProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_clear_rejects_late_pcm_and_waiter_wakes(self):
        audio = NativeAudio()
        audio.generation = 1
        audio.frames = 48000
        audio.command = self.command
        waiting = asyncio.create_task(audio.write(b'\1\0' * 100, 1, 1))
        await asyncio.sleep(0)
        self.assertFalse(waiting.done())
        await audio.clear(2)
        self.assertFalse(await asyncio.wait_for(waiting, 1))
        self.assertEqual(audio.frames, 0)

    async def command(self, kind, **fields):
        return {'type':'ack', 'frames':0, 'accepted':True}

    async def test_capture_epoch_drops_muted_audio(self):
        audio = NativeAudio()
        audio.command = self.command
        await audio.capture(False, 1)
        audio.deliver({'type':'audio','epoch':0,'data':'AQI='})
        audio.deliver({'type':'audio','epoch':1,'data':'AQI='})
        self.assertTrue(audio.input.empty())
        await audio.capture(True, 2)
        audio.deliver({'type':'audio','epoch':1,'data':'AQI='})
        audio.deliver({'type':'audio','epoch':2,'data':'AQI='})
        self.assertEqual(await audio.input.get(), (2, b'\1\2'))

    async def test_device_error_unblocks_playback(self):
        audio = NativeAudio()
        audio.frames = 48000
        waiting = asyncio.create_task(audio.write(b'\1\0', 0, 1))
        await asyncio.sleep(0)
        audio.deliver({'type':'error','code':'audio_route_changed'})
        with self.assertRaisesRegex(ValueError, '设备'):
            await asyncio.wait_for(waiting, 1)
        self.assertIsInstance(await audio.input.get(), Exception)
