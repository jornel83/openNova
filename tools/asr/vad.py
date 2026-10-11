"""Local Silero ONNX detection and bounded, continuous ASR turn capture."""
import asyncio
from collections import deque
from contextlib import aclosing
import hashlib
import math
from pathlib import Path
import tempfile
import time
import urllib.request

RATE = 16000
FRAME_SAMPLES = 512
FRAME_BYTES = FRAME_SAMPLES * 2
REVISION = '1e261b036686cd0017d500ee96acd1c4ba572a9d'
MODEL_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'
MODEL_URL = f'https://raw.githubusercontent.com/snakers4/silero-vad/{REVISION}/src/silero_vad/data/silero_vad.onnx'
MODEL_PATH = Path.home() / '.cache/opennova/silero-vad' / REVISION / 'silero_vad.onnx'


def ensure_model():
    if MODEL_PATH.is_file():
        if hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError(f'VAD 模型校验失败，请移走损坏文件后重试：{MODEL_PATH}')
        return MODEL_PATH
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    print('首次下载 Silero VAD 模型（约 2.3 MB），下载后在本机运行。', flush=True)
    with urllib.request.urlopen(MODEL_URL, timeout=60) as response:
        data = response.read(8 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != MODEL_SHA256:
        raise ValueError('VAD 模型下载内容校验失败。')
    with tempfile.NamedTemporaryFile(dir=MODEL_PATH.parent, delete=False) as tmp:
        tmp.write(data)
        temporary = Path(tmp.name)
    temporary.replace(MODEL_PATH)
    return MODEL_PATH


class SileroOnnx:
    """16 kHz model state/context per the upstream MIT-licensed ONNX wrapper."""
    def __init__(self, path=None):
        import numpy as np
        import onnxruntime as ort
        self.np = np
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(path or ensure_model()), options,
                                           providers=['CPUExecutionProvider'])
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, 64), dtype=np.float32)

    def __call__(self, pcm):
        if len(pcm) != FRAME_BYTES:
            raise ValueError('VAD 每次需要 512 个 16-bit 音频样本。')
        np = self.np
        frame = np.frombuffer(pcm, dtype='<i2').astype(np.float32)[None, :] / 32768
        audio = np.concatenate((self.context, frame), axis=1)
        output, self.state = self.session.run(None, {
            'input': audio, 'state': self.state, 'sr': np.array(RATE, dtype=np.int64)})
        self.context = frame[:, -64:]
        return float(output.item())


class SpeechGate:
    """Return (start/audio/end, original PCM bytes, end reason) events."""
    def __init__(self, *, pre_roll_ms=300, min_speech_ms=96, silence_ms=800,
                 threshold=0.5, max_speech_seconds=45):
        if not (0 < threshold <= 1 and silence_ms > 0 and min_speech_ms > 0
                and pre_roll_ms >= 0 and max_speech_seconds > 0):
            raise ValueError('无效的 VAD 参数。')
        self.threshold = threshold
        self.end_threshold = max(0.01, threshold - 0.15)
        self.min_speech = math.ceil(min_speech_ms / 32)
        self.silence = math.ceil(silence_ms / 32)
        self.max_frames = math.ceil(max_speech_seconds * RATE / FRAME_SAMPLES)
        self.history = deque(maxlen=math.ceil(pre_roll_ms / 32) + self.min_speech)
        self.active = False
        self.speech_frames = self.quiet_frames = self.active_frames = 0

    def push(self, frame, probability):
        if len(frame) != FRAME_BYTES or not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError('无效的 VAD 音频帧或概率。')
        if not self.active:
            self.history.append(frame)
            self.speech_frames = self.speech_frames + 1 if probability >= self.threshold else 0
            if self.speech_frames < self.min_speech:
                return []
            self.active = True
            self.active_frames = self.speech_frames
            self.quiet_frames = 0
            pcm = b''.join(self.history)
            self.history.clear()
            return [('start', pcm, '')]
        self.active_frames += 1
        if self.active_frames > self.max_frames:
            raise ValueError('发言超过最长 45 秒限制，已取消本轮；请分段说话。')
        self.quiet_frames = self.quiet_frames + 1 if probability < self.end_threshold else 0
        if self.quiet_frames >= self.silence:
            self.active = False
            self.speech_frames = self.quiet_frames = 0
            return [('end', frame, 'silence')]
        return [('audio', frame, '')]

    def finish(self):
        if not self.active:
            return []
        self.active = False
        return [('end', b'', 'input_limit')]


async def packet_stream(queue):
    """Keep a last packet in reserve, so the terminal frame contains audio."""
    pending = bytearray()
    while True:
        pcm, final = await queue.get()
        pending.extend(pcm)
        while len(pending) > 6400:
            yield bytes(pending[:6400]), False
            del pending[:6400]
        if final:
            if not pending:
                raise ValueError('本轮没有可提交的音频。')
            yield bytes(pending), True
            return


async def run_vad(source, detector, recognize_turn, *, total_seconds,
                  silence_ms=800, threshold=0.5):
    """Continuously capture while each bounded cloud turn runs independently.

    recognize_turn(audio_iterator, turn_id) is None for a local-only test.
    No source audio is persisted. Queue overflow fails instead of dropping words.
    """
    from array import array
    gate = SpeechGate(silence_ms=silence_ms, threshold=threshold)
    pending = bytearray()
    turns = []
    tasks = []
    queue = None
    current = None
    samples = peak = window_peak = 0
    next_status = RATE
    inference_seconds = 0.0
    frame_count = 0
    probability = 0.0

    def handle(events):
        nonlocal queue, current
        for kind, pcm, reason in events:
            if kind == 'start':
                if sum(not task.done() for task in tasks) >= 2:
                    raise ValueError('前两轮识别尚未完成，已停止收音，请检查网络。')
                turn_id = len(turns) + 1
                current = {'turn_id': turn_id, 'end_reason': None}
                turns.append(current)
                queue = asyncio.Queue(maxsize=100) if recognize_turn else None
                if recognize_turn:
                    task = asyncio.create_task(recognize_turn(packet_stream(queue), turn_id))
                    tasks.append(task)
                print(f'[第 {turn_id} 轮] 检测到人声，开始识别。' if recognize_turn
                      else f'[第 {turn_id} 轮] 检测到人声（仅本地检测）。', flush=True)
            if queue is not None:
                try:
                    queue.put_nowait((pcm, kind == 'end'))
                except asyncio.QueueFull:
                    raise ValueError('ASR 上行积压超过约 3 秒，已停止收音；没有丢弃后继续提交。') from None
            if kind == 'end':
                current['end_reason'] = reason
                ending = '持续静音，本轮收尾' if reason == 'silence' else '达到录音上限，本轮被截断收尾'
                print(f'[第 {current["turn_id"]} 轮] {ending}；继续监听直到测试时长结束。', flush=True)
                queue = None

    print(f'本地 VAD 已就绪：静音 {silence_ms} ms 收尾，测试上限 {total_seconds:g} 秒。', flush=True)
    try:
        async with aclosing(source):
            async for chunk, _ in source:
                for task in tasks:
                    if task.done():
                        task.result()
                peak_now = max(abs(value) for value in array('h', chunk))
                peak = max(peak, peak_now)
                window_peak = max(window_peak, peak_now)
                samples += len(chunk) // 2
                pending.extend(chunk)
                while len(pending) >= FRAME_BYTES:
                    frame = bytes(pending[:FRAME_BYTES])
                    del pending[:FRAME_BYTES]
                    started = time.perf_counter()
                    probability = detector(frame)
                    inference_seconds += time.perf_counter() - started
                    frame_count += 1
                    handle(gate.push(frame, probability))
                if samples >= next_status:
                    state = '有人声／等待停顿' if gate.active else '等待开口'
                    print(f'VAD {samples / RATE:.1f}/{total_seconds:g} 秒 | 音量峰值 {window_peak}/32768'
                          f' | 人声概率 {probability:.2f} | {state}', flush=True)
                    next_status = samples + RATE
                    window_peak = 0
                await asyncio.sleep(0)
        # Preserve residual samples at the capture limit without fabricating audio.
        if gate.active and pending:
            handle([('audio', bytes(pending), '')])
        handle(gate.finish())
        results = await asyncio.gather(*tasks)
        for turn, result in zip(turns, results):
            turn['asr'] = result
        if peak == 0:
            print('全程零信号：检查所选麦克风、合盖状态或麦克风权限。', flush=True)
        elif not turns:
            print('本次没有检测到持续人声；未创建 ASR 请求。', flush=True)
        return {'mode': 'vad', 'success': True, 'audio_seconds': round(samples / RATE, 3),
                'input_peak': peak, 'speech_turns': len(turns), 'asr_requests': len(tasks),
                'vad_frame_ms_mean': round(inference_seconds * 1000 / max(1, frame_count), 3),
                'silence_ms': silence_ms, 'threshold': threshold, 'model_revision': REVISION,
                'turns': turns}
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
