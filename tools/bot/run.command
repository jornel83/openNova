#!/bin/zsh
set -euo pipefail
BOT_PROJECT_ROOT="${0:A:h:h:h}"
BOT_NODE="${OPENNOVA_NODE:-}"
if [[ -z "$BOT_NODE" ]]; then
  if [[ -x /opt/homebrew/opt/node@24/bin/node ]]; then
    BOT_NODE=/opt/homebrew/opt/node@24/bin/node
  else
    BOT_NODE="$(command -v node || true)"
  fi
fi
if [[ ! -x "$BOT_NODE" ]]; then
  print -u2 '需要 Node 24；请安装 Node 24 或设置 OPENNOVA_NODE。'
  exit 1
fi
exec "$BOT_NODE" "$BOT_PROJECT_ROOT/scripts/project.mjs" start "$@"
