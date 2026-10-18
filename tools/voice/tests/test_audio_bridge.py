import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audio_bridge import NativeAudio
from unittest.mock import AsyncMock, patch


class NativeProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_selected_devices_are_passed_to_helper_as_separate_arguments(self):
        audio = NativeAudio(device='MacBook Air 麦克风', output_device='SRS-XB100')
        async def ready():
            audio.deliver({'type':'ready', 'voice_processing':True})
        audio._read = ready
        audio.command = AsyncMock(return_value={'type':'ack'})
        with patch('audio_bridge.build_helper', AsyncMock(return_value=Path('/test/audio'))), \
             patch('audio_bridge.asyncio.create_subprocess_exec', AsyncMock()) as spawn:
            await audio.start()
            self.assertEqual(spawn.call_args.args,
                ('/test/audio', '--device', 'MacBook Air 麦克风', '--output-device', 'SRS-XB100'))
            audio.command.assert_awaited_once_with('capture',enabled=True,epoch=0)

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

    async def test_startup_error_survives_helper_exit(self):
        audio = NativeAudio()
        audio.ready = asyncio.get_running_loop().create_future()
        audio.deliver({'type':'error', 'code':'audio_engine_start_failed',
                       'system_code':-10875, 'detail':'untrusted native error detail'})
        original = audio.error
        audio.deliver({'type':'error', 'code':'audio_closed'})
        with self.assertRaisesRegex(ValueError, '音频引擎启动失败.*-10875'):
            await audio.ready
        self.assertIs(audio.error, original)
        self.assertIs(await audio.input.get(), original)
        self.assertNotIn('/retry', str(original))
        self.assertNotIn('untrusted', str(original))

    async def test_startup_error_only_displays_numeric_system_code(self):
        audio = NativeAudio()
        audio.deliver({'type':'error', 'code':'audio_engine_start_failed',
                       'system_code':'arbitrary diagnostic text'})
        self.assertIn('音频引擎启动失败', str(audio.error))
        self.assertNotIn('arbitrary', str(audio.error))

    async def test_native_playback_receipts_and_old_generation_are_isolated(self):
        states=[];audio=NativeAudio();audio.on_state=lambda:states.append(audio.playback)
        audio.deliver({'type':'ack','generation':0,'frames':2400,'playback':'playing'})
        self.assertEqual(states,['playing'])
        audio.deliver({'type':'ack','generation':0,'frames':2400,'playback':'paused'})
        self.assertEqual(states[-1],'paused')
        audio.deliver({'type':'played','generation':0,'segment':1,'frames':0,'playback':'idle'})
        self.assertEqual(states[-1],'idle')
        audio.generation=1
        audio.deliver({'type':'ack','generation':0,'frames':2400,'playback':'playing'})
        self.assertEqual(states[-1],'idle')
