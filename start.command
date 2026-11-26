#!/bin/zsh
# Persistent Bot and optional voice; --no-voice defers audio until explicitly enabled.
set -euo pipefail
OPENNOVA_START_ROOT="${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
OPENNOVA_START_NODE="${OPENNOVA_NODE:-}"
if [[ -z "$OPENNOVA_START_NODE" ]]; then
  if [[ -x /opt/homebrew/opt/node@24/bin/node ]]; then
    OPENNOVA_START_NODE=/opt/homebrew/opt/node@24/bin/node
  else
    OPENNOVA_START_NODE="$(command -v node || true)"
  fi
fi
if [[ ! -x "$OPENNOVA_START_NODE" ]]; then
  print -u2 '需要 Node 24；请安装 node@24 或设置 OPENNOVA_NODE。'
  exit 1
fi
export OPENNOVA_NODE="$OPENNOVA_START_NODE"
node_args=()
daily_profile="$OPENNOVA_START_ROOT/config/.env.daily"
# An explicit instance keeps its own data directory and port defaults.
if [[ -f "$daily_profile" && -z "${OPENNOVA_BOT_HOME:-}" && -z "${OPENNOVA_BOT_PORT:-}" && -z "${OPENNOVA_BOT_WEB_PORT:-}" ]]; then
  node_args+=("--env-file=$daily_profile")
fi
exec "$OPENNOVA_START_NODE" "${node_args[@]}" "$OPENNOVA_START_ROOT/scripts/project.mjs" start:voice "$@"
