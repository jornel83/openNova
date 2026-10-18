"""Bounded IPC with the voice-processed macOS capture/playback process."""
import asyncio
import base64
import json
from pathlib import Path
from agent import ROOT, stop_process


def audio_error(code, system_code=None):
    if code == 'audio_engine_start_failed':
        detail = f'（系统错误 {system_code}）' if type(system_code) is int else ''
        return ValueError(f'原生音频引擎启动失败{detail}，请重新运行；若仍失败，请提供此错误信息。')
    hints = {
        'microphone_permission_denied':'请在 macOS 隐私设置中允许终端访问麦克风。',
        'audio_device_not_found':'找不到指定方向的音频设备，请用 --list-devices 查看名称并重新运行。',
        'audio_device_ambiguous':'设备名称匹配多项，请用 --list-devices 查看完整名称。',
        'audio_device_selection_failed':'无法启用所选音频设备，请检查连接后重试。',
        'voice_processing_unavailable':'所选音频组合无法开启 Voice Processing，请换用其他输入或输出设备。',
        'audio_route_changed':'音频设备已断开或默认设备已变化，请恢复设备后输入 /retry。',
        'capture_overflow':'收音缓冲已满，请输入 /retry 重试。',
        'macos_15_required':'连续对话需要 macOS 15 或更高版本。',
    }
    return ValueError(hints.get(code, '原生音频服务不可用，请检查音频设备或重新启动 Demo。'))


async def build_helper():
    sources = [ROOT/'tools/voice/native'/name for name in ('PlaybackQueue.swift', 'AudioDevices.swift', 'AudioBridge.swift')]
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


def device_arguments(device=None, output_device=None):
    args = []
    if device is not None: args.extend(('--device', device))
    if output_device is not None: args.extend(('--output-device', output_device))
    return args


async def check_native(device=None, output_device=None, *, list_devices=False):
    binary = await build_helper()
    process = await asyncio.create_subprocess_exec(str(binary), '--list-devices' if list_devices else '--check',
                                                   *device_arguments(device, output_device), stdout=asyncio.subprocess.PIPE,
                                                   start_new_session=True)
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 15)
        result = json.loads(output)
        if process.returncode or result.get('type') != ('devices' if list_devices else 'check'):
            raise audio_error(result.get('code'))
        return result
    finally:
        await stop_process(process)


class NativeAudio:
    def __init__(self, device=None, output_device=None):
        self.device_args = device_arguments(device, output_device)
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
        self.playback = 'idle'
        self.on_state = None

    async def start(self):
        binary = await build_helper()
        self.ready = asyncio.get_running_loop().create_future()
        self.process = await asyncio.create_subprocess_exec(str(binary), *self.device_args, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, limit=64*1024, start_new_session=True)
        self.reader = asyncio.create_task(self._read())
        info = await asyncio.wait_for(asyncio.shield(self.ready), 40)
        await self.capture(self.enabled,self.epoch)
        return info

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
            # The helper's subsequent EOF must not replace the actual failure.
            if self.error is not None: return
            self.error = audio_error(event.get('code'), event.get('system_code'))
            self.enabled = False
            while not self.input.empty(): self.input.get_nowait()
            self.input.put_nowait(self.error)
            if self.ready and not self.ready.done(): self.ready.set_exception(self.error)
            for future in self.pending.values():
                if not future.done(): future.set_exception(self.error)
            self.playback = 'error'
            if self.on_state: self.on_state()
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

        if kind in ('ack','played') and event.get('generation') == self.generation:
            playback = event.get('playback',self.playback)
            if playback != self.playback:
                self.playback = playback
                if self.on_state: self.on_state()

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
