"""Regression checks for the ignored native workspace artifact packaging gate."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('macos_builder', Path(__file__).parents[1] / 'build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class SystemArtifactTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.package = self.root / 'engine/harness/native/system/packages/darwin-arm64'
        self.package.mkdir(parents=True)
        self.manifest = {'platform': 'darwin-arm64', 'binaries': [
            {'tool': 'flock', 'kind': 'node-api', 'napi': 8, 'path': 'bin/system.node'}]}
        self.write_manifest()

    def write_manifest(self):
        (self.package / 'prebuilds.json').write_text(json.dumps(self.manifest))

    def test_missing_ignored_binary_is_a_build_error(self):
        with self.assertRaisesRegex(RuntimeError, 'native lock binary missing/invalid'):
            builder.system_artifact(self.root)

    def test_nested_binary_is_the_required_artifact(self):
        binary = self.package / 'bin/system.node'
        binary.parent.mkdir()
        binary.write_bytes(b'\xcf\xfa\xed\xfe' + bytes(28))
        self.assertEqual(builder.system_artifact(self.root), binary)

    def test_wrong_platform_cannot_satisfy_arm64_requirement(self):
        self.manifest['platform'] = 'darwin-x64'
        self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, 'Unsupported macOS system prebuild'):
            builder.system_artifact(self.root)

    def test_binary_symlink_is_rejected(self):
        binary = self.package / 'bin/system.node'
        binary.parent.mkdir()
        actual = self.root / 'external.node'
        actual.write_bytes(b'\xcf\xfa\xed\xfe' + bytes(28))
        binary.symlink_to(actual)
        with self.assertRaisesRegex(RuntimeError, 'native lock binary missing/invalid'):
            builder.system_artifact(self.root)


if __name__ == '__main__':
    unittest.main()
