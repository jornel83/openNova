import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent import stop_process


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_cleanup_reaches_descendant_after_leader_has_exited(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'descendant.pid'
            child_code = 'import time; time.sleep(60)'
            parent_code = f'import subprocess,sys,pathlib; p=subprocess.Popen([sys.executable,"-c",{child_code!r}]); pathlib.Path({str(path)!r}).write_text(str(p.pid))'
            process = await asyncio.create_subprocess_exec(sys.executable, '-c', parent_code, start_new_session=True)
            await process.wait()
            pid = int(path.read_text())
            try:
                await stop_process(process)
                for _ in range(30):
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        break
                    await asyncio.sleep(.02)
                else:
                    self.fail('descendant survives cleanup')
            finally:
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass
