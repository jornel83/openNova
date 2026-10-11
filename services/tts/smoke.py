"""Measure real Base voice-clone inference; no microphone or cloud TTS calls."""
import argparse
import json
from pathlib import Path
import time

from download_model import MODEL_ID, MODEL_PATH, REVISION


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--reference-text', type=Path, required=True)
    parser.add_argument('--text', default='你好，OpenNova 的本地语音合成已经启动。接下来，我们一起完成语音助手。')
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    if args.output_dir.exists():
        parser.error('Output directory exists; choose a new run directory.')
    if not args.reference.is_file() or not args.reference_text.is_file():
        parser.error('Reference WAV and exact transcript are required.')
    ref_text = args.reference_text.read_text().strip()
    if not ref_text:
        parser.error('Reference transcript is empty.')

    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model

    args.output_dir.mkdir(parents=True)
    loaded = time.monotonic()
    model = load_model(str(MODEL_PATH))
    load_seconds = time.monotonic() - loaded
    print(f'Model loaded in {load_seconds:.3f}s', flush=True)
    reports = []
    for index in range(2):
        started = time.monotonic()
        first_audio = None
        chunks = []
        rate = None
        for result in model.generate(text=args.text, ref_audio=str(args.reference.resolve()),
                                     ref_text=ref_text, lang_code='Chinese', stream=True,
                                     streaming_interval=0.32, max_tokens=600):
            mx.eval(result.audio)
            chunk = np.asarray(result.audio).reshape(-1)
            if not chunk.size:
                continue
            if first_audio is None:
                first_audio = time.monotonic() - started
                print(f'Run {index + 1}: first audio in {first_audio:.3f}s', flush=True)
            if rate is not None and rate != result.sample_rate:
                raise RuntimeError('Sample rate changed during generation.')
            rate = result.sample_rate
            chunks.append(chunk)
        elapsed = time.monotonic() - started
        if not chunks:
            raise RuntimeError('Model generated no audio.')
        audio = np.concatenate(chunks)
        if not np.isfinite(audio).all() or not np.any(audio):
            raise RuntimeError('Model generated invalid or silent audio.')
        with (args.output_dir / f'run-{index + 1}.wav').open('xb') as output:
            sf.write(output, audio, rate, format='WAV', subtype='PCM_16')
        report = {'run': index + 1, 'first_audio_seconds': round(first_audio, 3),
                  'generation_seconds': round(elapsed, 3), 'audio_seconds': round(len(audio) / rate, 3),
                  'rtf': round(elapsed / (len(audio) / rate), 3), 'sample_rate': rate,
                  'chunks': len(chunks), 'mlx_peak_memory_gib': round(mx.get_peak_memory() / 2**30, 3)}
        reports.append(report)
        print(json.dumps(report, ensure_ascii=False), flush=True)
    result = {'model': MODEL_ID, 'revision': REVISION, 'model_load_seconds': round(load_seconds, 3),
              'reference': str(args.reference.resolve()), 'text': args.text, 'runs': reports}
    with (args.output_dir / 'metrics.json').open('x') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
