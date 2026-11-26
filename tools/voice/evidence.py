"""Bounded playback evidence. No PCM, transcriptions, replies or device names."""
import asyncio
import json
import os
from pathlib import Path
import queue
import threading
import time


EVENTS = {'session_started', 'session_closed', 'turn_started', 'request_bound',
          'output_invalidated', 'output_cleared', 'turn_settled',
          'native_playback_receipt', 'native_clear_ack', 'control_received', 'control_settled'}
IDENTIFIERS = {'requestId', 'entryProjectId', 'controlId'}
NUMBERS = {'generation', 'captureEpoch', 'entryProjectRevision', 'nativeGeneration', 'segment', 'frames'}
CHOICES = {
    'status': {'running', 'complete', 'interrupted', 'failed', 'applied', 'stale'},
    'reason': {'replacement', 'speech', 'stop', 'end', 'quit', 'close', 'cancelled', 'audio_failure'},
    'action': {'stop', 'mute', 'unmute', 'end', 'start', 'retry', 'disable', 'devices'},
}


class VoiceEvidence:
    """Callbacks only enqueue; a single worker owns bounded, private disk writes."""
    def __init__(self, home, instance_id, *, max_bytes=1024*1024, queue_size=256, close_timeout=.5, log=lambda _: None):
        self.path = Path(home)/'voice-evidence.jsonl'
        self.instance_id = instance_id
        self.max_bytes = max_bytes
        self.queue = asyncio.Queue(maxsize=queue_size)
        self.worker = None
        self.closed = False
        self.dropped = 0
        self.warned = False
        self.log = log
        self.close_timeout = close_timeout
        self.io_queue = queue.Queue(maxsize=1)
        self.io_closed = threading.Event()

    def start(self):
        # Never use the default asyncio executor here: asyncio.run waits for its
        # threads at shutdown, even after an await of to_thread was cancelled.
        # A stuck diagnostic filesystem must not hold /disable or process exit.
        self.loop = asyncio.get_running_loop()
        self.writer = threading.Thread(target=self._write_loop,daemon=True,name='voice-evidence')
        self.writer.start()
        self.worker = asyncio.create_task(self._run())
        self.emit({'event': 'session_started'})

    def _write_loop(self):
        while not self.io_closed.is_set():
            try: row,done = self.io_queue.get(timeout=.1)
            except queue.Empty: continue
            error = None
            try: self._append(row)
            except Exception as failure: error = failure
            def finish(done=done,error=error):
                if not done.done():
                    if error is None: done.set_result(None)
                    else: done.set_exception(error)
            try: self.loop.call_soon_threadsafe(finish)
            except RuntimeError: return  # The owning voice loop has exited.

    def _warn(self):
        if self.warned: return
        self.warned = True
        try: self.log('语音时序记录暂不可写；语音继续运行，本轮记录可能不完整。')
        except Exception: pass

    def emit(self, event):
        if self.closed or event.get('event') not in EVENTS:
            return
        row = {'version': 1, 'at': time.time(), 'monotonic': time.monotonic(),
               'voiceInstanceId': self.instance_id, 'event': event['event']}
        if event['event'] == 'session_started':
            row['playbackEvidence'] = 'native_receipts_not_acoustic_measurement'
        for key in IDENTIFIERS:
            value = event.get(key)
            if isinstance(value, str) and 0 < len(value) <= 128 and all(c.isalnum() or c in '-_' for c in value):
                row[key] = value
        for key in NUMBERS:
            value = event.get(key)
            if type(value) is int and value >= 0:
                row[key] = value
        for key, choices in CHOICES.items():
            if isinstance(event.get(key), str) and event[key] in choices:
                row[key] = event[key]
        if type(event.get('accepted')) is bool:
            row['accepted'] = event['accepted']
        try:
            row['droppedBefore'] = self.dropped
            self.queue.put_nowait(row)
            self.dropped = 0
        except asyncio.QueueFull:
            self.dropped += 1

    def _append(self, row):
        data = (json.dumps(row, ensure_ascii=False, separators=(',', ':'))+'\n').encode()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists() and self.path.stat().st_size + len(data) > self.max_bytes:
            self.path.replace(self.path.with_suffix('.previous.jsonl'))
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, 'ab') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)

    async def _run(self):
        while True:
            row = await self.queue.get()
            try:
                if row is None:
                    return
                done = asyncio.get_running_loop().create_future()
                self.io_queue.put_nowait((row,done))
                await done
            except Exception:
                # Diagnostic failures never stop capture or make a successful
                # native clear appear to have failed. Do not print file contents.
                self._warn()
            finally:
                self.queue.task_done()

    async def close(self):
        if self.closed:
            return
        self.emit({'event': 'session_closed'})
        self.closed = True
        if self.worker:
            try:
                async with asyncio.timeout(self.close_timeout):
                    await self.queue.join()
                    await self.queue.put(None)
                    await asyncio.shield(self.worker)
            except TimeoutError:
                self._warn()
            finally:
                self.io_closed.set()
                if not self.worker.done(): self.worker.cancel()
                await asyncio.gather(self.worker,return_exceptions=True)
