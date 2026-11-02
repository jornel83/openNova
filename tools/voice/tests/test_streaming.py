import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from segments import SentenceBuffer

class SegmentTests(unittest.TestCase):
    def test_emits_first_sentence_without_waiting_for_final_reply(self):
        b=SentenceBuffer()
        self.assertEqual(b.feed('你好'),[])
        self.assertEqual(b.feed('。下一'),['你好。'])
        self.assertEqual(b.feed('句！'),['下一句！'])
        self.assertEqual(b.finish(),[])
    def test_decimal_and_english_word_are_not_split_on_each_period(self):
        b=SentenceBuffer()
        self.assertEqual(b.feed('使用 Python 3.'),[])
        self.assertEqual(b.feed('11。'),['使用 Python 3.11。'])
    def test_long_unpunctuated_tail_is_preserved(self):
        b=SentenceBuffer(limit=8)
        self.assertEqual(b.feed('一二三四五六七八九十'),['一二三四五六七八'])
        self.assertEqual(b.finish(),['九十'])
    def test_english_sentence_and_trailing_fragment_are_preserved(self):
        b=SentenceBuffer()
        self.assertEqual(b.feed('Hello. Next sentence'),['Hello.'])
        self.assertEqual(b.finish(),[' Next sentence'])
    def test_first_segment_has_smaller_limit_then_returns_to_normal_limit(self):
        b=SentenceBuffer(limit=12,first_limit=6)
        self.assertEqual(b.feed('一二三四五六七八九十十一十二十三十四十五'),['一二三四五六','七八九十十一十二十三十四'])
        self.assertEqual(b.finish(),['十五'])
    def test_numeric_run_across_length_boundary_is_not_split(self):
        b=SentenceBuffer(limit=8)
        self.assertEqual(b.feed('数值123,45'),[])
        self.assertEqual(b.feed('6.78元。'),['数值123,456.78','元。'])
