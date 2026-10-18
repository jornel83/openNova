from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import conversation
from types import SimpleNamespace
import os

class CliTests(unittest.TestCase):
    def test_explicit_provider_overrides_invalid_lower_priority_environment(self):
        run=AsyncMock()
        with patch.dict(os.environ,{'OPENNOVA_TTS_PROVIDER':'invalid'}), \
             patch.object(sys,'argv',['conversation.py','--continuous','--tts-provider','cloud']), \
             patch('conversation.load_key',return_value=''),patch('continuous_run.run',run):
            conversation.main()
        self.assertEqual(run.await_args.args[0].tts_provider,'doubao')

    def test_cloud_provider_and_voice_reach_continuous_args(self):
        run=AsyncMock()
        with patch.object(sys,'argv',['conversation.py','--continuous','--tts-provider','cloud','--tts-voice','female-test']), \
             patch('conversation.load_key',return_value=''),patch('continuous_run.run',run):
            conversation.main()
        self.assertEqual(run.await_args.args[0].tts_provider,'doubao')
        self.assertEqual(run.await_args.args[0].tts_voice,'female-test')

    def test_cloud_sync_preflight_checks_key_without_studio_audio_or_blocking_cloud_io(self):
        args=SimpleNamespace(tts_provider='doubao',tts_voice='female-test',audio=[],continuous=True,no_play=False)
        with patch('conversation.shutil.which',return_value='/usr/bin/ffmpeg'), \
             patch('doubao.check_service') as check,patch('doubao.load_tts_key') as key, \
             patch('conversation.urllib.request.build_opener') as opener:
            conversation.preflight(args)
        key.assert_called_once_with()
        check.assert_not_called()
        opener.assert_not_called()

    def test_bot_is_explicit_and_cannot_mix_with_web(self):
        for argv in (['conversation.py','--bot'],['conversation.py','--continuous','--bot','--web']):
            with patch.object(sys,'argv',argv),self.assertRaises(SystemExit):conversation.main()
        run=AsyncMock()
        with patch.object(sys,'argv',['conversation.py','--continuous','--bot','--device','MacBook Air麦克风']),patch('conversation.load_key',return_value=''),patch('continuous_run.run',run):conversation.main()
        self.assertTrue(run.await_args.args[0].bot)
    def test_web_requires_continuous_and_keeps_devices(self):
        with patch.object(sys,'argv',['conversation.py','--web']),self.assertRaises(SystemExit):conversation.main()
        run=AsyncMock()
        with patch.object(sys,'argv',['conversation.py','--continuous','--web','--device','SRS-XB100']),patch('conversation.load_key',return_value=''),patch('continuous_run.run',run):conversation.main()
        self.assertTrue(run.await_args.args[0].web);self.assertEqual(run.await_args.args[0].device,'SRS-XB100')
    def test_legacy_accepts_preexisting_silence_threshold(self):
        run=AsyncMock()
        with patch.object(sys,'argv',['conversation.py','--silence-ms','2000']),\
             patch('conversation.load_key',return_value=''),patch('conversation.run',run):
            conversation.main()
        self.assertEqual(run.await_args.args[0].silence_ms,2000)
