"""One text → Bot → real TTS measurement; never opens a microphone or speaker."""
import argparse
import asyncio
from functools import partial
import json
from pathlib import Path
import signal
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/voice'))
from bot_agent import BotAgent
from continuous import Conversation
from tts_stream import synthesize


class PacedSink:
    """A bounded 24 kHz playout simulation, not an acoustic measurement."""
    def __init__(self):
        self.generation = 0
        self.end = time.monotonic()
        self.started = False
        self.gaps = []
        self.bytes = 0

    async def clear(self, generation):
        self.generation = generation
        self.end = time.monotonic()

    async def write(self, pcm, generation, segment):
        duration = len(pcm) / 48000
        await asyncio.sleep(max(0, self.end - time.monotonic() + duration - 2))
        if generation != self.generation:
            return False
        now = time.monotonic()
        if self.started and now > self.end + .02:
            self.gaps.append(round(now - self.end, 4))
        self.end = max(now, self.end) + duration
        self.started = True
        self.bytes += len(pcm)
        return True

    async def drained(self, generation):
        await asyncio.sleep(max(0, self.end - time.monotonic()))


async def run(args):
    task = asyncio.current_task()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    agent = BotAgent()
    ready = await agent.start()
    sink = PacedSink()
    controller = Conversation(agent, sink, args.tts_url,
        synthesize=partial(synthesize, provider=args.provider),
        tts_speed=1 if args.provider == 'doubao' else 1.5,
        log=lambda _: None, render_text=lambda _: None)
    try:
        await controller.ask(args.text)
        await asyncio.wait_for(controller.wait_idle(), 300)
        record = controller.records[-1]
        result = await agent.api('/result', {'id': record['requestId']}) if record.get('requestId') else {}
        start = record['submitted_at']
        timings = {key: round((record[key] - start) * 1000, 1)
            for key in ('first_delta_at', 'agent_complete_at', 'first_pcm_at',
                        'first_enqueue_at', 'playback_drained_at') if key in record}
        return dict(status=record['status'], outputMode=ready.get('outputMode'),
            provider=args.provider, timing_ms=timings,
            simulated_playout_gaps_seconds=sink.gaps, audio_seconds=round(sink.bytes / 48000, 3),
            acoustic_validation=False, asr_included=False,
            record=record, result=result)
    finally:
        await controller.close()
        await agent.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--text', required=True)
    parser.add_argument('--provider', choices=('doubao', 'studio'), required=True)
    parser.add_argument('--tts-url', default='http://127.0.0.1:18000')
    args = parser.parse_args()
    try:
        report = asyncio.run(run(args))
        print(json.dumps(report, ensure_ascii=False))
        sys.exit(0 if report['status'] == 'complete' else 1)
    except (Exception, asyncio.CancelledError) as error:
        # Provider exceptions can contain environment information; keep CLI safe.
        print(json.dumps({'status': 'failed', 'error': type(error).__name__}))
        sys.exit(1)
