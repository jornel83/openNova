"""Portable handoff checks use tiny isolated assets and never call paid APIs."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / 'skills/aesthetic-video-workflow/scripts/handoff.py'


class HandoffTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='nova-aesthetic-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.repo = self.base / 'checkout'
        self.skill = self.repo / 'skills/aesthetic-video-workflow'
        (self.skill / 'scripts').mkdir(parents=True)
        self.script = self.skill / 'scripts/handoff.py'
        shutil.copyfile(SCRIPT, self.script)
        (self.repo / 'tools/video').mkdir(parents=True)
        (self.repo / 'tools/video/tool.py').write_text('# checkout marker\n')
        (self.repo / 'package.json').write_text('{"name":"opennova"}')
        self.source = self.base / 'source'
        (self.source / 'current_task').mkdir(parents=True)
        payload = b'packaged reference bytes\n'
        (self.source / 'current_task/reference.mp4').write_bytes(payload)
        self.manifest = {
            'files': [{'path': 'current_task/reference.mp4', 'bytes': len(payload),
                       'sha256': hashlib.sha256(payload).hexdigest()}],
            'known_missing': [{'expected_path': 'current_task/before.jpg',
                               'reason': 'not included in handoff'}],
        }
        self.write_manifest()

    def write_manifest(self):
        (self.skill / 'migration_manifest.json').write_text(
            json.dumps(self.manifest), encoding='utf-8')

    def run_cli(self, *args, script=None, cwd=None):
        process = subprocess.run([sys.executable, str(script or self.script), *map(str, args)],
                                 cwd=cwd or self.base, capture_output=True, text=True)
        self.assertTrue(process.stdout, process.stderr)
        return process.returncode, json.loads(process.stdout)

    def test_integrity_and_known_missing_are_independent(self):
        code, value = self.run_cli('check', '--workspace', self.source)
        self.assertEqual(code, 0)
        self.assertTrue(value['integrity_ok'])
        self.assertEqual(value['packaged_files'], 1)
        self.assertEqual(value['known_missing_inputs'], self.manifest['known_missing'])
        (self.source / 'current_task/before.jpg').write_bytes(b'recovered')
        _, value = self.run_cli('check', '--workspace', self.source)
        self.assertEqual(value['known_missing_inputs'], [])

    def test_corruption_prevents_copy(self):
        (self.source / 'current_task/reference.mp4').write_bytes(b'broken')
        target = self.base / 'destination'
        code, value = self.run_cli('materialize', '--source', self.source, '--to', target)
        self.assertNotEqual(code, 0)
        self.assertFalse(value['integrity_ok'])
        self.assertEqual(value['failures'][0]['error'], 'changed_or_corrupt')
        self.assertFalse(target.exists())

    def test_copy_to_new_or_empty_destination(self):
        for name, existing in [('new', False), ('empty', True)]:
            with self.subTest(name=name):
                target = self.base / name
                if existing:
                    target.mkdir()
                code, value = self.run_cli('materialize', '--source', self.source, '--to', target)
                self.assertEqual(code, 0, value)
                self.assertEqual((target / 'current_task/reference.mp4').read_bytes(),
                                 (self.source / 'current_task/reference.mp4').read_bytes())
                self.assertEqual(json.loads((target / 'migration_manifest.json').read_text()),
                                 self.manifest)

    def test_nonempty_destination_is_preserved(self):
        target = self.base / 'existing'
        target.mkdir()
        (target / 'keep.txt').write_text('keep me')
        code, value = self.run_cli('materialize', '--source', self.source, '--to', target)
        self.assertNotEqual(code, 0)
        self.assertIn('not be overwritten', value['error'])
        self.assertEqual(list(target.iterdir()), [target / 'keep.txt'])
        self.assertEqual((target / 'keep.txt').read_text(), 'keep me')

    def test_copy_rejects_destination_inside_source(self):
        code, value = self.run_cli('materialize', '--source', self.source,
                                   '--to', self.source / 'recursive')
        self.assertNotEqual(code, 0)
        self.assertIn('outside the source', value['error'])
        self.assertFalse((self.source / 'recursive').exists())

    def test_manifest_rejects_traversal_and_absolute_paths(self):
        for name in ['../outside', '/tmp/outside', 'C:/outside', 'nested\\..\\outside']:
            with self.subTest(path=name):
                self.manifest['files'][0]['path'] = name
                self.write_manifest()
                code, value = self.run_cli('materialize', '--source', self.source,
                                           '--to', self.base / 'unsafe')
                self.assertNotEqual(code, 0)
                self.assertEqual(value['error'], 'invalid_relative_path')
                self.assertFalse((self.base / 'unsafe').exists())

    def test_known_missing_path_cannot_escape(self):
        self.manifest['known_missing'][0]['expected_path'] = '../outside.jpg'
        self.write_manifest()
        code, value = self.run_cli('check', '--workspace', self.source)
        self.assertNotEqual(code, 0)
        self.assertEqual(value['error'], 'invalid_relative_path')

    def test_external_symlink_is_not_copied(self):
        outside = self.base / 'private.txt'
        outside.write_text('not part of handoff')
        (self.source / 'extra-link').symlink_to(outside)
        code, value = self.run_cli('materialize', '--source', self.source,
                                   '--to', self.base / 'unsafe')
        self.assertNotEqual(code, 0)
        self.assertIn('symbolic links', value['error'])
        self.assertFalse((self.base / 'unsafe').exists())

    def test_archive_script_finds_data_from_project_cwd(self):
        data = self.repo / 'workspaces/aesthetic-video-workflow/data'
        shutil.copytree(self.source, data)
        archive = self.base / 'private/skills/versions/hash/skills/aesthetic-video-workflow'
        shutil.copytree(self.skill, archive)
        nested = self.repo / 'workspaces/current'
        nested.mkdir()
        code, value = self.run_cli('check', script=archive / 'scripts/handoff.py', cwd=nested)
        self.assertEqual(code, 0, value)
        self.assertEqual(value['workspace'], str(data))

    def test_script_in_checkout_finds_data_from_unrelated_cwd(self):
        data = self.repo / 'workspaces/aesthetic-video-workflow/data'
        shutil.copytree(self.source, data)
        code, value = self.run_cli('check')
        self.assertEqual(code, 0, value)
        self.assertEqual(value['workspace'], str(data))

    def test_original_bundle_assets_fallback(self):
        bundled = self.skill / 'assets/workspace'
        shutil.copytree(self.source, bundled)
        code, value = self.run_cli('check')
        self.assertEqual(code, 0, value)
        self.assertEqual(value['workspace'], str(bundled))


class ShotConfigTests(unittest.TestCase):
    def test_minimax_first_frame_duration(self):
        command = [sys.executable, str(SCRIPT.with_name('shot_config.py')),
                   '--model', 'veda', '--first-frame', 'frame.png', '--prompt', 'Blink.']
        for seconds in (None, '4', '5', '15', '3', '16', '4.5'):
            with self.subTest(seconds=seconds):
                args = [] if seconds is None else ['--duration', seconds]
                result = subprocess.run(command + args, capture_output=True, text=True)
                if seconds in ('3', '16', '4.5'):
                    self.assertNotEqual(result.returncode, 0)
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout)['duration'], int(seconds or 4))


if __name__ == '__main__':
    unittest.main()
