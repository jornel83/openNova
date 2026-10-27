import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('bootstrap',Path(__file__).resolve().parents[1]/'bootstrap.py')
setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)

class BootstrapTests(unittest.TestCase):
    def test_check_never_creates_missing_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            helper=Path(directory)/'helper'
            with self.assertRaisesRegex(RuntimeError,'helper missing|helper stale'):
                setup.ensure_helper(helper,install=False)
            self.assertFalse(helper.exists())

    def test_build_is_atomic_and_reuses_only_matching_source_and_binary(self):
        with tempfile.TemporaryDirectory(prefix='nova helper ') as directory:
            helper=Path(directory)/'bin/helper'
            def compile(args):
                self.assertEqual(args[0],'swiftc')
                self.assertNotEqual(Path(args[-1]),helper)
                Path(args[-1]).write_bytes(b'compiled')
            with patch.object(setup,'run',side_effect=compile) as run:
                setup.ensure_helper(helper,install=True)
                self.assertEqual(run.call_count,1)
                setup.ensure_helper(helper,install=True)
                self.assertEqual(run.call_count,1)
                helper.write_bytes(b'tampered')
                with self.assertRaisesRegex(RuntimeError,'helper stale'):
                    setup.ensure_helper(helper,install=False)
                setup.ensure_helper(helper,install=True)
                self.assertEqual(run.call_count,2)
            self.assertEqual(helper.stat().st_mode & 0o777,0o700)

    def test_source_change_rebuilds_without_accessing_keychain(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'services/agent/keychain.swift'
            source.parent.mkdir(parents=True);source.write_text('version one')
            helper=root/'output/helper'
            def compile(args): Path(args[-1]).write_bytes(b'compiled')
            with patch.object(setup,'ROOT',root), patch.object(setup,'run',side_effect=compile) as run:
                setup.ensure_helper(helper,install=True)
                source.write_text('version two')
                with self.assertRaisesRegex(RuntimeError,'helper stale'):
                    setup.ensure_helper(helper,install=False)
                setup.ensure_helper(helper,install=True)
                self.assertEqual(run.call_count,2)

    def test_failed_rebuild_preserves_old_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            helper=Path(directory)/'helper';helper.write_bytes(b'trusted');helper.chmod(0o700)
            with patch.object(setup,'run',side_effect=RuntimeError('compiler failed')):
                with self.assertRaisesRegex(RuntimeError,'compiler failed'):
                    setup.ensure_helper(helper,install=True)
            self.assertEqual(helper.read_bytes(),b'trusted')

if __name__=='__main__':unittest.main()
