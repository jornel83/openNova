"""One natural utterance, with capture closed before handing its final text onward."""
import asyncio
from contextlib import aclosing
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'asr'))
from vad import SpeechGate, FRAME_BYTES, packet_stream


async def capture_turn(source, detector, recognize, *, silence_ms=800):
    gate = SpeechGate(silence_ms=silence_ms)
    pending = bytearray()
    queue = asyncio.Queue(maxsize=100)
    task = None
    ended = False
    finished_at = None
    try:
        async with aclosing(source):
            async for chunk, _ in source:
                if task is not None and task.done():
                    task.result()
                    raise ValueError('ASR 提前结束，已停止本轮。')
                pending.extend(chunk)
                while len(pending) >= FRAME_BYTES:
                    frame = bytes(pending[:FRAME_BYTES])
                    del pending[:FRAME_BYTES]
                    for kind, pcm, reason in gate.push(frame, detector(frame)):
                        if kind == 'start':
                            print('检测到人声，正在识别……', flush=True)
                            task = asyncio.create_task(recognize(packet_stream(queue)))
                        try:
                            queue.put_nowait((pcm, kind == 'end'))
                        except asyncio.QueueFull:
                            raise ValueError('语音上行积压，已停止本轮。') from None
                        if kind == 'end':
                            ended = True
                            finished_at = time.monotonic()
                    if ended:
                        break
                if ended:
                    break
                await asyncio.sleep(0)
        if task is None:
            return None
        if not ended:
            raise ValueError('录音达到上限，发言被截断；本轮不会提交给助手。')
        result = await task
        if not result.get('success') or not result.get('text', '').strip():
            raise ValueError('没有可提交的最终识别结果。')
        return {**result, 'vad_end_to_final_ms': round((time.monotonic()-finished_at)*1000)}
    finally:
        if task is not None:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
