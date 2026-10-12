"""Bounded IPC with the voice-processed macOS capture/playback process."""
import asyncio
import base64
import json
from pathlib import Path
from agent import ROOT, stop_process


def audio_error(code):
    hints = {
        'microphone_permission_denied':'请在 macOS 隐私设置中允许终端访问麦克风。',
        'builtin_route_required':'连续对话目前需要系统默认的 MacBook 内置麦克风和扬声器。',
        'audio_route_changed':'音频设备已变化，请恢复内置输入、输出后输入 /retry。',
        'capture_overflow':'收音缓冲已满，请输入 /retry 重试。',
        'macos_15_required':'连续对话需要 macOS 15 或更高版本。',
    }
    return ValueError(hints.get(code, '原生音频服务不可用，请检查麦克风权限和设备后输入 /retry。'))


async def build_helper():
    sources = [ROOT/'tools/voice/native'/name for name in ('PlaybackQueue.swift', 'AudioBridge.swift')]
    output = ROOT/'output/voice/bin/opennova-audio'
    if output.is_file() and output.stat().st_mtime >= max(p.stat().st_mtime for p in sources):
        return output
    output.parent.mkdir(parents=True, exist_ok=True)
    process = await asyncio.create_subprocess_exec('xcrun', 'swiftc', '-O', *map(str,sources), '-o', str(output),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
    try:
        _, error = await asyncio.wait_for(process.communicate(), 120)
        if process.returncode:
            raise ValueError('原生音频桥编译失败，请检查 Xcode Command Line Tools。\n'+error.decode()[-2000:])
        return output
    finally:
        await stop_process(process)


async def check_native():
    binary = await build_helper()
    process = await asyncio.create_subprocess_exec(str(binary), '--check', stdout=asyncio.subprocess.PIPE,
                                                   start_new_session=True)
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 15)
        result = json.loads(output)
        if process.returncode or result.get('type') != 'check':
            raise audio_error(result.get('code'))
        if not result.get('builtin_route'):
            raise audio_error('builtin_route_required')
        return result
    finally:
        await stop_process(process)


class NativeAudio:
    def __init__(self):
        self.process = self.reader = self.ready = None
        self.input = asyncio.Queue(maxsize=64)
        self.pending = {}
        self.counter = 0
        self.generation = self.frames = self.epoch = 0
        self.enabled = True
        self.error = None
        self.changed = asyncio.Event()
        self.played_segments = set()
        self.closed = False

    async def start(self):
        binary = await build_helper()
        self.ready = asyncio.get_running_loop().create_future()
        self.process = await asyncio.create_subprocess_exec(str(binary), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, limit=64*1024, start_new_session=True)
        self.reader = asyncio.create_task(self._read())
        return await asyncio.wait_for(asyncio.shield(self.ready), 40)

    def deliver(self, event):
        kind = event.get('type')
        if kind == 'audio':
            if self.enabled and event.get('epoch') == self.epoch:
                try:
                    self.input.put_nowait((self.epoch, base64.b64decode(event['data'], validate=True)))
                except asyncio.QueueFull:
                    self.deliver({'type':'error', 'code':'capture_overflow'})
            return
        if kind == 'error':
            self.error = audio_error(event.get('code'))
            self.enabled = False
            while not self.input.empty(): self.input.get_nowait()
            self.input.put_nowait(self.error)
            if self.ready and not self.ready.done(): self.ready.set_exception(self.error)
            for future in self.pending.values():
                if not future.done(): future.set_exception(self.error)
            self.changed.set()
            return
        if kind == 'ready':
            if not event.get('voice_processing'):
                self.deliver({'type':'error','code':'voice_processing_unavailable'})
            elif not self.ready.done(): self.ready.set_result(event)
        elif kind == 'played':
            if event.get('generation') == self.generation:
                self.frames = event['frames']
                self.played_segments.add(event['segment'])
                self.changed.set()
        elif kind == 'ack':
            if event.get('generation', self.generation) == self.generation:
                self.frames = event.get('frames', self.frames)
                self.changed.set()
            future = self.pending.get(event.get('rid'))
            if future and not future.done(): future.set_result(event)

    async def _read(self):
        try:
            while line := await self.process.stdout.readline():
                self.deliver(json.loads(line))
            self.deliver({'type':'error','code':'audio_closed'})
        except asyncio.CancelledError: raise
        except Exception:
            self.deliver({'type':'error','code':'audio_protocol_failed'})

    async def command(self, kind, **fields):
        if self.error: raise self.error
        self.counter += 1
        rid = self.counter
        future = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        try:
            self.process.stdin.write((json.dumps({'type':kind,'rid':rid, **fields})+'\n').encode())
            await self.process.stdin.drain()
            return await asyncio.wait_for(future, 5)
        finally:
            self.pending.pop(rid, None)

    async def capture(self, enabled, epoch):
        self.enabled = False
        self.epoch = epoch
        while not self.input.empty(): self.input.get_nowait()
        await self.command('capture', enabled=enabled, epoch=epoch)
        self.enabled = enabled

    async def clear(self, generation):
        self.generation = generation
        self.frames = 0
        self.played_segments.clear()
        self.changed.set()
        await self.command('clear', generation=generation)

    async def pause(self): await self.command('pause')
    async def resume(self): await self.command('resume')

    async def write(self, pcm, generation, segment):
        if not pcm or len(pcm)%2 or len(pcm)>8192: raise ValueError('无效 PCM 数据块。')
        while generation == self.generation:
            if self.error: raise self.error
            self.changed.clear()
            if self.frames + len(pcm)//2 <= 48000:
                result = await self.command('pcm', generation=generation, segment=segment,
                                            data=base64.b64encode(pcm).decode())
                if result.get('accepted'): return generation == self.generation
            await self.changed.wait()
        return False

    async def drained(self, generation):
        while generation == self.generation:
            if self.error: raise self.error
            self.changed.clear()
            if self.frames == 0: return
            await self.changed.wait()

    async def close(self):
        if self.closed: return
        self.closed = True
        self.enabled = False
        if self.reader:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        if self.process: await stop_process(self.process)
        for future in self.pending.values():
            if not future.done(): future.cancel()
