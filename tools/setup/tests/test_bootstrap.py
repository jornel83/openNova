import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


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


if __name__ == '__main__':
    unittest.main()
