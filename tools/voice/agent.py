"""Own and reap the persistent Node/Harness process through JSON lines."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import signal

ROOT = Path(__file__).resolve().parents[2]


async def stop_process(process):
    # Every caller creates a new session: this group belongs only to this worker.
    if process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), timeout=12)
        except asyncio.TimeoutError:
            pass
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    await asyncio.sleep(0.2)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if process.returncode is None:
        await process.wait()


class Agent:
    def __init__(self):
        self.process = None
        self.request_id = 0

    async def start(self):
        node = shutil.which('node')
        if not node:
            raise ValueError('需要 Node.js 22.19+ 或 24+。')
        self.process = await asyncio.create_subprocess_exec(
            node, str(ROOT / 'services/agent/worker.mjs'),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            limit=128 * 1024, start_new_session=True)
        ready = await self.read(timeout=60)
        if ready.get('type') != 'ready':
            raise ValueError('Agent 未就绪。')
        return ready

    async def read(self, timeout=200):
        line = await asyncio.wait_for(self.process.stdout.readline(), timeout)
        if not line:
            raise ValueError('Agent 进程已退出。')
        event = json.loads(line)
        if event.get('type') == 'error':
            raise ValueError('Agent 失败：' + event.get('code', 'unknown'))
        return event

    async def ask(self, text):
        self.request_id += 1
        self.process.stdin.write((json.dumps({'type':'ask', 'id':self.request_id, 'text':text})+'\n').encode())
        await self.process.stdin.drain()
        event = await self.read()
        if event.get('type') != 'reply' or event.get('id') != self.request_id or not event.get('text', '').strip():
            raise ValueError('Agent 回复与当前轮次不匹配。')
        return event

    async def close(self):
        if self.process is not None and self.process.returncode is None:
            if self.process.stdin:
                self.process.stdin.close()
            await stop_process(self.process)
