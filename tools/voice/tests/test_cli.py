from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import conversation

class CliTests(unittest.TestCase):
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
