#!/bin/zsh
# One entry point for the persistent Bot + Studio TTS + continuous voice client.
set -euo pipefail
OPENNOVA_START_ROOT="${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
OPENNOVA_START_NODE="${OPENNOVA_NODE:-/opt/homebrew/opt/node@24/bin/node}"
if [[ ! -x "$OPENNOVA_START_NODE" ]]; then
  print -u2 '需要 Node 24；请安装 node@24 或设置 OPENNOVA_NODE。'
  exit 1
fi
export OPENNOVA_NODE="$OPENNOVA_START_NODE"
exec "$OPENNOVA_START_NODE" "$OPENNOVA_START_ROOT/tools/voice/start.mjs" "$@"
