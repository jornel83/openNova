"""Prepare two real, silent-on-device TTS runs for A4 experiment acceptance."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/voice"))
from playback import speak
from doubao import DEFAULT_VOICE

SENTENCE = "请保留两次实验的样音和配置，方便稍后比较语速。"


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def manifest(label):
    title = {"baseline": "原速", "faster": "1.35 倍速"}[label]
    files = [{"role": "data", "path": "input.txt"}] + [
        {"role": role, "path": f"{label}/{filename}"}
        for role, filename in (("config", "config.json"), ("log", "log.json"), ("sample", "sample.wav"))
    ]
    return {"experiment": "中文播报语速对比", "title": title, "modelVersion": "seed-tts-2.0", "files": files}


def prepare(directory):
    # Keep independent evidence when acceptance is replayed.
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "input.txt").write_text(SENTENCE, encoding="utf-8")
    for label, speed in (("baseline", 1.0), ("faster", 1.35)):
        folder = directory / label
        folder.mkdir()
        sample = folder / "sample.wav"
        # Doubao's public resource identifier is available; its weights/build ID is not.
        config = {"provider": "doubao", "modelVersion": "seed-tts-2.0", "speaker": DEFAULT_VOICE,
                  "providerSpeechRate": 0, "playbackTempo": speed, "sampleRateHz": 24000}
        save_json(folder / "config.json", config)
        metrics = speak(SENTENCE, url="", provider="doubao", voice=DEFAULT_VOICE,
                        speed=speed, play=False, output=sample)
        with wave.open(str(sample), "rb") as recorded:
            assert recorded.getframerate() == 24000 and recorded.getnchannels() == 1
            duration = recorded.getnframes() / recorded.getframerate()
        assert abs(metrics["audio_seconds"] - duration) < 0.001 and not metrics["played"]
        save_json(folder / "log.json", {"tool": "tools/voice/playback.py", **metrics,
                  "sha256": hashlib.sha256(sample.read_bytes()).hexdigest()})
        save_json(directory / f"{label}.json", manifest(label))
        print(label, f"{duration:.3f}s", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    prepare(parser.parse_args().directory)
