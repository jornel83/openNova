"""Download Vivian's CustomVoice model by default, or the retained Base clone model."""
import argparse
from pathlib import Path
from huggingface_hub import snapshot_download
from settings import load_settings

# Retained Base constants are also used by smoke.py for reference-audio cloning.
MODEL_ID = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16'
REVISION = 'a6eb4f68e4b056f1215157bb696209bc82a6db48'
DATA_DIR = Path(load_settings()['data_dir'])
MODEL_PATH = DATA_DIR / 'models/opennova/qwen3-tts-1.7b-base-bf16' / REVISION
CUSTOMVOICE_ID = 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16'
CUSTOMVOICE_REVISION = '52f4770fd9726457eae3d3b6aa92047a25a10776'
CUSTOMVOICE_PATH = DATA_DIR / 'models/opennova/qwen3-tts-1.7b-customvoice-bf16' / CUSTOMVOICE_REVISION

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--voice-profile', choices=['vivian', 'base'], default='vivian')
    args = parser.parse_args()
    model_id, revision, path = ((CUSTOMVOICE_ID, CUSTOMVOICE_REVISION, CUSTOMVOICE_PATH)
                               if args.voice_profile == 'vivian' else (MODEL_ID, REVISION, MODEL_PATH))
    print(f'Downloading {model_id} @ {revision}', flush=True)
    print(snapshot_download(model_id, revision=revision, local_dir=str(path), max_workers=4))
