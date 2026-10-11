#!/bin/sh
set -eu
cd "$(dirname "$0")"
export HF_HUB_OFFLINE=1
UV="${OPENNOVA_UV:-uv}"
DATA_DIR="$("$UV" run --locked python settings.py)"
exec "$UV" run --locked mlx_audio.server \
  --host 127.0.0.1 --port 8000 --tts-max-batch-size 1 \
  --allowed-origins http://localhost:8787 \
  --log-dir "$DATA_DIR/logs/opennova/tts"
