import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('bootstrap',Path(__file__).resolve().parents[1]/'bootstrap.py')
setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)

class BootstrapTests(unittest.TestCase):
    def test_existing_helper_is_preserved_without_reading_credentials(self):
        with tempfile.TemporaryDirectory(prefix='nova helper ') as directory:
            helper=Path(directory)/'helper';helper.write_bytes(b'existing helper');helper.chmod(0o700)
            with patch.object(setup,'run') as run:
                setup.ensure_helper(helper,install=True)
                run.assert_not_called()
            self.assertEqual(helper.read_bytes(),b'existing helper')

    def test_check_never_creates_missing_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            helper=Path(directory)/'helper'
            with self.assertRaisesRegex(RuntimeError,'helper missing'):
                setup.ensure_helper(helper,install=False)
            self.assertFalse(helper.exists())

    def test_install_compiles_only_missing_helper(self):
        with tempfile.TemporaryDirectory(prefix='nova helper ') as directory:
            helper=Path(directory)/'bin/helper'
            def compile(args):
                self.assertEqual(args[0],'swiftc');self.assertEqual(Path(args[-1]),helper)
                helper.write_bytes(b'compiled')
            with patch.object(setup,'run',side_effect=compile):setup.ensure_helper(helper,install=True)
            self.assertEqual(helper.stat().st_mode & 0o777,0o700)

if __name__=='__main__':unittest.main()
