"""Local timeline export regressions: source cuts, retained captions and optional badge."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools.video import aesthetic_edit, tool


class AestheticEditTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.sources = {name: name + ('.png' if name == 'card' else '.mp4')
                        for name in aesthetic_edit.SOURCES}
        for name in self.sources.values():
            (self.root / name).touch()
        self.config = {'aesthetic_timeline': self.sources, 'output': 'export.mp4'}

    def test_dry_run_and_subtitles_cover_old_and_new_configs(self):
        with patch.object(tool, 'probe_video', return_value={'duration': 14, 'has_audio': True}):
            plan = tool.invoke('video_edit', {'config': self.config, 'dry_run': True}, self.root)['plan']
            tagged = tool.plan_edit({**self.config, 'show_ai_badge': True}, self.root)
            self.assertFalse(plan['show_ai_badge'])
            self.assertEqual(plan['duration'], 13.5)
            self.assertEqual(plan['aesthetic_timeline']['source_in_frames'], dict.fromkeys(aesthetic_edit.LENGTHS, 0))
            clean = aesthetic_edit.subtitles(plan)
            self.assertEqual(sum(line.startswith('Dialogue:') for line in clean.splitlines()), 24)
            self.assertNotIn('AI 角色演示', clean)
            self.assertNotIn('m 32 35 l 188 35', clean)
            self.assertIn('恢复示意 · 贴布', clean)
            badge = aesthetic_edit.subtitles(tagged).removeprefix(clean)
            self.assertEqual(len(badge.splitlines()), 2)
            self.assertIn('AI 角色演示', badge)
            self.assertIn('m 32 35 l 188 35', badge)

    def test_invalid_edit_stops_before_export(self):
        with patch.object(tool, 'probe_video', return_value={'duration': 14, 'has_audio': False}):
            for config in [{**self.config, 'show_ai_badge': 'false'},
                           {**self.config, 'clips': [{'path': 'before.mp4'}]},
                           {**self.config, 'fps': 24},
                           {**self.config, 'aesthetic_timeline': {**self.sources, 'source_in_frames': {'wrap': 450}}},
                           {**self.config, 'aesthetic_timeline': {**self.sources, 'source_in_frames': {'before': True}}}]:
                with self.subTest(config=config), self.assertRaises(tool.VideoError):
                    tool.run({'action': 'edit', 'config': config}, self.root)
            self.assertFalse((self.root / 'export.mp4').exists())

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'requires FFmpeg')
    def test_real_portrait_export_changes_only_the_badge_setting(self):
        source = self.root / 'template.mp4'
        card = self.root / 'card.png'
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=gray:s=72x128:r=30',
                        '-t','13.5','-c:v','libx264',str(source)],check=True)
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(source),'-frames:v','1',str(card)],check=True)
        self.config['aesthetic_timeline'] = {name: (card if name == 'card' else source).name
                                           for name in aesthetic_edit.SOURCES}
        def crop_hash(path, region):
            return hashlib.sha256(subprocess.check_output(['ffmpeg','-v','error','-ss','2','-i',path,
                                  '-frames:v','1','-vf','crop='+region,'-f','rawvideo','-pix_fmt','gray','-'])).digest()
        outputs = []
        for extra in [{},{'show_ai_badge': True, 'output': 'marked.mp4'}]:
            result = tool.run({'action':'edit','config':{**self.config, **extra}},self.root)
            self.assertEqual(result['metadata']['duration'], 13.5)
            self.assertTrue(result['metadata']['has_audio'])
            outputs.append(result['path'])
        self.assertNotEqual(crop_hash(outputs[0], '160:50:30:34'), crop_hash(outputs[1], '160:50:30:34'))
        self.assertEqual(crop_hash(outputs[0], '160:50:300:700'), crop_hash(outputs[1], '160:50:300:700'))
