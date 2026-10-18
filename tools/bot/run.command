#!/bin/zsh
set -euo pipefail
BOT_PROJECT_ROOT="${0:A:h:h:h}"
BOT_NODE="${OPENNOVA_NODE:-/opt/homebrew/opt/node@24/bin/node}"
exec "$BOT_NODE" "$BOT_PROJECT_ROOT/services/bot/launch.mjs" "$@"
