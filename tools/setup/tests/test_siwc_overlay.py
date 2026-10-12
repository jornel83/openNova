import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

class OverlayTests(unittest.TestCase):
    def test_builder_exists(self):
        self.assertTrue((Path(__file__).resolve().parents[1]/'build_siwc_overlay.py').is_file())

    def test_manifest_rejects_wrong_patch_and_missing_artifact(self):
        p=Path(__file__).resolve().parents[1]/'build_siwc_overlay.py'
        if not p.exists(): self.fail('overlay builder missing')
        spec=importlib.util.spec_from_file_location('overlay',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);artifact=root/'packages/local/dist/index.js';artifact.parent.mkdir(parents=True);artifact.write_text('export {}')
            (root/'manifest.json').write_text(json.dumps({'revision':'revision','patch_sha256':'hash'}))
            self.assertFalse(m.valid_overlay(root,'revision','hash'))
            (artifact.parent/'items.js').write_text('export {}')
            self.assertTrue(m.valid_overlay(root,'revision','hash'))
            self.assertFalse(m.valid_overlay(root,'revision','changed'))
            artifact.unlink();self.assertFalse(m.valid_overlay(root,'revision','hash'))
