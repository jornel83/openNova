"""One current sentence and one lookahead, with bounded PCM and owned cleanup."""
import asyncio
from contextlib import aclosing
import time


class PreparedSpeech:
    def __init__(self, item, synthesize, valid, metrics, *, chunks=8):
        self.seq, self.text, self.notice = item
        self.metrics, self.valid = metrics, valid
        self.queue = asyncio.Queue(maxsize=chunks)
        self.started = asyncio.Event()
        self.synthesize = synthesize
        self.task = asyncio.create_task(self._prepare())

    async def _prepare(self):
        pending = b''
        try:
            if not self.valid(): return
            self.metrics['requested_at'] = time.monotonic()
            async with aclosing(self.synthesize(self.text, self.metrics)) as stream:
                async for pcm in stream:
                    if not self.valid(): return
                    if not isinstance(pcm, bytes): raise ValueError('无效 PCM 数据。')
                    if pcm:
                        self.metrics.setdefault('first_pcm_at', time.monotonic())
                        self.started.set()
                    pending += pcm
                    size = len(pending)//2*2
                    for offset in range(0, size, 4096):
                        await self.queue.put(('pcm', pending[offset:min(offset+4096,size)]))
                    pending = pending[size:]
            if pending: raise ValueError('合成音频尾部不完整。')
            self.metrics['http_closed_at'] = time.monotonic()
            self.started.set()
            await self.queue.put(('done', None))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.started.set()
            await self.queue.put(('error', error))

    async def pcm(self):
        while self.valid():
            kind, value = await self.queue.get()
            if kind == 'done': return
            if kind == 'error': raise value
            yield value

    async def close(self):
        self.started.set()
        if not self.task.done(): self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        while not self.queue.empty(): self.queue.get_nowait()


async def prepare_speech(items, synthesize, valid, make_metrics, *, lookahead=1):
    """Yield prepared sentences in order; cancellation closes every TTS iterator.

    Each job holds at most eight 4096-byte PCM chunks. Admission has its own
    semaphore so a fast provider cannot start sentence N+2 while N is playing.
    """
    slots = asyncio.Semaphore(lookahead+1)
    ready = asyncio.Queue(maxsize=lookahead+1)
    owned = set()

    async def dispatch():
        previous=None
        try:
            while True:
                item = await items.get()
                if item is None:
                    await ready.put(None)
                    return
                await slots.acquire()
                # Give the current answer's first PCM priority over lookahead.
                # Notices are exempt so a slow notice cannot delay the answer.
                if previous is not None and not previous.notice:
                    await previous.started.wait()
                if not valid(): return
                job = PreparedSpeech(item, synthesize, valid, make_metrics(item))
                owned.add(job)
                await ready.put(job)
                previous=job
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await ready.put(error)

    dispatcher = asyncio.create_task(dispatch())
    try:
        while True:
            job = await ready.get()
            if job is None: return
            if isinstance(job,Exception): raise job
            try: yield job
            finally:
                await job.close()
                owned.discard(job)
                slots.release()
    finally:
        dispatcher.cancel()
        await asyncio.gather(dispatcher, return_exceptions=True)
        await asyncio.gather(*(job.close() for job in owned), return_exceptions=True)
