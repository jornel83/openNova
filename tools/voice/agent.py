"""Own and reap the persistent Node/Harness process through JSON lines."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import signal

ROOT = Path(__file__).resolve().parents[2]


def failure_message(event):
    stage = {'authorization':'ChatGPT 授权检查', 'model_catalog':'获取 GPT 模型列表',
             'harness_start':'Harness 启动', 'conversation':'Agent 对话'}.get(event.get('stage'), 'Agent')
    hints = {
        'network_error':'无法连接 ChatGPT，请检查当前网络连接。',
        'connection_error':'无法连接 ChatGPT，请检查当前网络连接。',
        'cancelled':'请求已取消或超时。',
        'chatgpt_authorization_required':'需要重新完成 OpenNova 的 ChatGPT 授权。',
        'secure_storage_unavailable':'无法访问本机 Keychain 凭据存储。',
        'gpt_6_1_sol_unavailable':'当前账号模型列表未提供 GPT-6.1 Sol。',
        'harness_connection_closed':'Harness 子进程在初始化时提前退出，请检查运行环境。',
        'harness_dependency_missing':'缺少 Harness 依赖或构建，请运行环境检查。',
        'incomplete_agent_turn':'本轮模型回复未完整完成。',
        'subscription_sharing_usage_limit_exceeded':'ChatGPT 共享用量已达上限。',
    }
    status = event.get('status')
    http = f'（HTTP {status}）' if type(status) is int and 400 <= status <= 599 else ''
    hint = hints.get(event.get('code'))
    if hint is None:
        hint = {401:'ChatGPT 拒绝了当前凭据，请检查授权。',
                403:'ChatGPT 请求被拒绝，请检查网络连接及账号或应用的访问权限。',
                429:'请求受限，请检查用量并稍后再试。'}.get(status if type(status) is int else None,
                    '请检查 Agent 依赖与服务状态。')
    return f'{stage}失败{http}：{hint}'


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
        selected = os.environ.get('OPENNOVA_NODE', '').strip() or 'node'
        node = shutil.which(str(Path(selected).expanduser()))
        if not node:
            raise ValueError('找不到 Node.js，请安装 Node 24，或通过 OPENNOVA_NODE 指定可执行文件。')
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
            raise ValueError(failure_message(event))
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
