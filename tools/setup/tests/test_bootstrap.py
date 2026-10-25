import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import json
import os


class BootstrapTests(unittest.TestCase):
    def test_existing_wrong_revision_or_dirty_checkout_is_preserved(self):
        spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).resolve().parents[1] / 'bootstrap.py')
        setup = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(setup)
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
            git('init', '-q')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial')
            revision = git('rev-parse', 'HEAD')
            with self.assertRaisesRegex(RuntimeError, 'revision'):
                setup.ensure_repo(repo, {'url':'invalid', 'revision':'0'*40}, install=True)
            self.assertEqual(git('rev-parse', 'HEAD'), revision)
            (repo/'uncommitted.txt').write_text('preserve me')
            with self.assertRaisesRegex(RuntimeError, 'uncommitted'):
                setup.ensure_repo(repo, {'url':'invalid', 'revision':revision}, install=True)
            self.assertEqual((repo/'uncommitted.txt').read_text(), 'preserve me')


class HarnessSubmoduleTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).resolve().parents[1] / 'bootstrap.py')
        self.setup = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.setup)

    def test_empty_submodule_initializes_but_wrong_or_dirty_checkout_is_preserved(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {'GIT_ALLOW_PROTOCOL':'file'}):
            root=Path(d)/'parent'; source=Path(d)/'source';root.mkdir();source.mkdir()
            def git(path,*args):
                return subprocess.check_output(['git','-C',str(path),*args],text=True).strip()
            for repo in [root,source]:
                git(repo,'init','-q')
                git(repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','initial')
            revision=git(source,'rev-parse','HEAD')
            git(root,'submodule','add','-q',str(source),'third_party/deepseek-harness')
            git(root,'submodule','deinit','-f','--','third_party/deepseek-harness')
            target=root/'third_party/deepseek-harness'
            spec={'path':'third_party/deepseek-harness','url':str(source),'revision':revision,'pnpm':'11.28.5'}
            with self.assertRaisesRegex(RuntimeError,'initialize|initialized'):
                self.setup.ensure_harness(target,spec,install=False,root=root)
            self.setup.ensure_harness(target,spec,install=True,root=root)
            self.assertEqual(git(target,'rev-parse','HEAD'),revision)
            self.assertTrue((target/'.git').is_file())
            with self.assertRaisesRegex(RuntimeError,'revision'):
                self.setup.ensure_harness(target,{**spec,'revision':'0'*40},install=True,root=root)
            (target/'local-change').write_text('preserve')
            with self.assertRaisesRegex(RuntimeError,'uncommitted'):
                self.setup.ensure_harness(target,spec,install=True,root=root)
            self.assertEqual((target/'local-change').read_text(),'preserve')

    def test_changed_revision_rebuilds_and_failed_build_does_not_get_a_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);target=root/'third_party/deepseek-harness';target.mkdir(parents=True)
            spec={'revision':'a'*40,'pnpm':'11.28.5'}
            for file in self.setup.HARNESS_FILES:
                p=target/file;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('old build')
            with self.assertRaisesRegex(RuntimeError,'build'):
                self.setup.build_harness(target,spec,install=False,root=root)
            with patch.object(self.setup,'run') as run:
                self.setup.build_harness(target,spec,install=True,root=root)
                self.assertEqual(run.call_count,2)
                run.reset_mock()
                self.setup.build_harness(target,spec,install=True,root=root)
                run.assert_not_called()
            changed={**spec,'revision':'b'*40}
            with patch.object(self.setup,'run',side_effect=RuntimeError('build failed')):
                with self.assertRaisesRegex(RuntimeError,'build failed'):
                    self.setup.build_harness(target,changed,install=True,root=root)
            with self.assertRaisesRegex(RuntimeError,'build'):
                self.setup.build_harness(target,changed,install=False,root=root)


if __name__ == '__main__':
    unittest.main()
