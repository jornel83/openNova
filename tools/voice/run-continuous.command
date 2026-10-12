#!/bin/zsh
set -eu
project_dir="${0:A:h:h:h}"
cd "$project_dir"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -z "${OPENNOVA_NODE:-}" && -x /opt/homebrew/opt/node@24/bin/node ]]; then
  export OPENNOVA_NODE=/opt/homebrew/opt/node@24/bin/node
fi
if [[ -n "${OPENNOVA_PROXY:-}" ]]; then
  export HTTPS_PROXY="$OPENNOVA_PROXY"
  export HTTP_PROXY="$OPENNOVA_PROXY"
fi
if [[ -n "${HTTPS_PROXY:-}${HTTP_PROXY:-}" ]]; then
  export NODE_USE_ENV_PROXY=1
  export NO_PROXY="localhost,127.0.0.1${NO_PROXY:+,$NO_PROXY}"
fi
exec uv run tools/voice/conversation.py --continuous "$@"
