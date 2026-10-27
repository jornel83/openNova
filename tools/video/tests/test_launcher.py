import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[3]

class LauncherTests(unittest.TestCase):
    def test_external_project_override_cannot_replace_bundled_video_code(self):
        with tempfile.TemporaryDirectory(prefix='foreign nova ') as directory:
            foreign=Path(directory);(foreign/'tools/video').mkdir(parents=True)
            (foreign/'tools/video/tool.py').write_text("raise RuntimeError('FOREIGN_CODE_EXECUTED')")
            result=subprocess.run(['python3.11',str(ROOT/'skills/video-production/scripts/video_tool.py'),'--help'],
                cwd=foreign,env={**os.environ,'OPENNOVA_ROOT':str(foreign)},capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertNotIn('FOREIGN_CODE_EXECUTED',result.stderr)

if __name__=='__main__':unittest.main()
