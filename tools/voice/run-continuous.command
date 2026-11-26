#!/bin/zsh
# Append --device '麦克风名称' and optionally --output-device '扬声器名称'.
# Omitted devices follow system defaults; --list-devices lists available names.
set -eu
project_dir="${0:A:h:h:h}"
cd "$project_dir"
if [[ "${OPENNOVA_PACKAGED:-}" != 1 ]]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi
if [[ "${OPENNOVA_PACKAGED:-}" != 1 && -z "${OPENNOVA_NODE:-}" && -x /opt/homebrew/opt/node@24/bin/node ]]; then
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
if [[ "${OPENNOVA_PACKAGED:-}" == 1 ]]; then
  if [[ -z "${OPENNOVA_PYTHON:-}" || ! -x "${OPENNOVA_PYTHON:-}" ]]; then
    print -u2 'OpenNova 安装包缺少 Python 运行时，请重新安装。'
    exit 1
  fi
  export PYTHONDONTWRITEBYTECODE=1
  exec "$OPENNOVA_PYTHON" -B tools/voice/conversation.py --continuous "$@"
fi
exec uv run tools/voice/conversation.py --continuous "$@"
