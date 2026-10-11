from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conversation import respond, speech_segments


class DialogueTests(unittest.IsolatedAsyncioTestCase):
    async def test_final_transcript_then_agent_then_each_audio_segment(self):
        events = []
        class Agent:
            async def ask(self, text):
                events.append(('agent', text))
                return {'text':'第一句。第二句。', 'sessionId':'same-session'}
        async def play(text, index):
            events.append(('play', text))
            return {'played':False}
        result = await respond({'success':True, 'text':'最终文本'}, Agent(), play)
        self.assertEqual(events, [('agent','最终文本'), ('play','第一句。'), ('play','第二句。')])
        self.assertEqual(result['agent']['sessionId'], 'same-session')

    async def test_model_failure_does_not_trigger_tts(self):
        class Agent:
            async def ask(self, text):
                raise ValueError('model failed')
        async def play(*args):
            self.fail('must not play a failed response')
        with self.assertRaisesRegex(ValueError, 'model failed'):
            await respond({'success':True, 'text':'你好'}, Agent(), play)

    def test_segmenting_preserves_long_reply_without_cutting_tail(self):
        text = '开始。' + '语音测试' * 120 + '最后一句。'
        segments = speech_segments(text)
        self.assertEqual(''.join(segments), text)
        self.assertTrue(all(len(s) <= 160 for s in segments))
