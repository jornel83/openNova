"""Continuous VAD capture with independent, epoch-scoped cloud recognition."""
import asyncio
import math
from pathlib import Path
import re
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'asr'))
from vad import SpeechGate, FRAME_BYTES, packet_stream
from barge_in import AcousticEvidence, FAST_MS, PAUSE_MS


def silence_for(text, normal, extended):
    """A bounded language hint, not semantic endpointing; always use the latest revision."""
    tail = text.strip().rstrip('，,、…')
    unfinished = re.search(r'(但是|因为|所以|然后|还有|或者|比如|先|把|想|想要|我想|改成|换成|优化|等一下|不对|不是|等等)$', tail)
    return max(normal, extended) if unfinished else normal


class TurnCapture:
    def __init__(self, detector, recognize, emit, *, silence_ms=800, extended_ms=1600):
        self.detector, self.recognize, self.emit = detector, recognize, emit
        self.normal, self.extended = silence_ms, extended_ms
        self.epoch = self.counter = 0
        self.pending = bytearray()
        self.tasks = set()
        self.current = None
        self.gate = SpeechGate(silence_ms=silence_ms)
        self.samples = self.zero_samples = 0
        self.zero_warned = False
        self.discarding = False
        self.discard_quiet = 0
        self.acoustics = AcousticEvidence()
        self.measurement = {'strong_ms':0}

    def event(self, kind, turn, **fields):
        if turn['epoch'] == self.epoch:
            self.emit({'type':kind,'id':turn['id'],'epoch':self.epoch,'time':time.monotonic(),
                       'acoustic':dict(turn['acoustic']), **fields})

    def reset(self, epoch):
        self.epoch = epoch
        self.pending.clear()
        self.gate = SpeechGate(silence_ms=self.normal)
        self.current = None
        self.zero_samples = 0
        self.zero_warned = False
        self.discarding = False
        self.discard_quiet = 0
        self.acoustics = AcousticEvidence()
        self.measurement = {'strong_ms':0}
        if hasattr(self.detector, 'reset'): self.detector.reset()
        for task in self.tasks: task.cancel()

    def feed(self, epoch, pcm):
        if epoch != self.epoch: return
        self.zero_samples = 0 if any(pcm) else self.zero_samples + len(pcm)//2
        if self.zero_samples >= 5*16000 and not self.zero_warned:
            self.emit({'type':'zero_input','epoch':epoch})
            self.zero_warned = True
        if any(pcm): self.zero_warned = False
        self.pending.extend(pcm)
        while len(self.pending) >= FRAME_BYTES:
            frame = bytes(self.pending[:FRAME_BYTES])
            del self.pending[:FRAME_BYTES]
            try:
                probability = self.detector(frame)
                self.measurement = self.acoustics.measure(frame, probability)
                if self.discarding:
                    self.discard_quiet = self.discard_quiet+1 if probability < self.gate.end_threshold else 0
                    if self.discard_quiet >= math.ceil(self.normal/32):
                        self.discarding = False
                        self.discard_quiet = 0
                    continue
                if self.current:
                    previous = self.current['acoustic']['strong_ms']
                    self.current['acoustic'] = {**self.measurement,
                        'strong_ms':max(previous,self.measurement['strong_ms'])}
                    if any(previous < boundary <= self.measurement['strong_ms']
                           for boundary in (FAST_MS, PAUSE_MS)):
                        self.event('evidence', self.current)
                self.handle(self.gate.push(frame, probability))
            except (ValueError, asyncio.QueueFull) as error:
                if self.current:
                    turn = self.current
                    self.event('failed', turn, error='发言超时或上行积压，本轮未提交。')
                    turn['invalid'] = True
                    turn['task'].cancel()
                else:
                    self.emit({'type':'notice','epoch':epoch,'text':'识别仍在收尾，请稍后重新说话。'})
                self.current = None
                self.gate = SpeechGate(silence_ms=self.normal)
                self.discarding = True
                self.discard_quiet = 0

    def handle(self, events):
        for kind, pcm, reason in events:
            if kind == 'start':
                if sum(not task.done() for task in self.tasks) >= 2:
                    raise ValueError('ASR turn capacity')
                self.counter += 1
                turn = {'id':self.counter,'epoch':self.epoch,'queue':asyncio.Queue(maxsize=100),
                        'invalid':False,'text':'','acoustic':dict(self.measurement)}
                self.current = turn
                self.gate.silence = math.ceil(self.normal/32)
                self.event('start', turn)
                task = asyncio.create_task(self._recognize(turn))
                turn['task'] = task
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
            turn = self.current
            if turn is None: continue
            turn['queue'].put_nowait((pcm, kind == 'end'))
            if kind == 'end':
                self.event('end', turn, reason=reason)
                self.current = None

    async def _recognize(self, turn):
        def partial(text):
            if turn['invalid'] or turn['epoch'] != self.epoch: return
            turn['text'] = text
            if self.current is turn:
                self.gate.silence = math.ceil(silence_for(text, self.normal, self.extended)/32)
            self.event('partial', turn, text=text)
        try:
            result = await self.recognize(packet_stream(turn['queue']), turn['id'], partial)
            if not turn['invalid'] and turn['epoch'] == self.epoch:
                if not result.get('success') or not result.get('text','').strip():
                    raise ValueError('没有有效的最终转写。')
                if self.current is turn:
                    raise ValueError('识别在音频收尾前结束，本轮未提交。')
                self.event('final', turn, text=result['text'], asr=result)
        except asyncio.CancelledError: raise
        except Exception:
            if not turn['invalid']:
                self.event('failed', turn, error='语音识别未完成，本轮未提交；请重新说话。')
                if self.current is turn:
                    self.current = None
                    self.gate = SpeechGate(silence_ms=self.normal)
                    self.pending.clear()
                    self.discarding = True
                    self.discard_quiet = 0

    async def finish(self):
        if self.current and self.pending:
            self.handle([('audio', bytes(self.pending), '')])
        self.pending.clear()
        self.handle(self.gate.finish())
        if self.tasks: await asyncio.gather(*tuple(self.tasks), return_exceptions=True)

    async def close(self):
        self.reset(self.epoch+1)
        await asyncio.gather(*tuple(self.tasks), return_exceptions=True)
