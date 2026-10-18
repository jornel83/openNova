#!/bin/sh
# Sent over SSH stdin; the argument is the already-installed Studio TTS directory.
set -eu
umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$1" || { echo 'Studio TTS 工程目录不存在。' >&2; exit 1; }
test -f serve.sh || { echo 'Studio 缺少 serve.sh；请先完成 TTS 安装。' >&2; exit 1; }
probe() {
  curl --noproxy '*' -fsS --connect-timeout 2 --max-time 3 \
    http://127.0.0.1:8000/openapi.json 2>/dev/null | grep -q '"/v1/audio/speech"'
}
if probe; then echo 'Studio TTS 已运行。'; exit 0; fi
# An occupied port can also be a service still starting. Wait before diagnosing it.
if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  for attempt in 1 2 3 4 5; do sleep 1; if probe; then exit 0; fi; done
  echo 'Studio 8000 端口已占用，但 TTS 接口未就绪；未终止现有进程。' >&2
  exit 1
fi
command -v "${OPENNOVA_UV:-uv}" >/dev/null || { echo 'Studio 找不到 uv。' >&2; exit 1; }
mkdir -p ../../output/tts
lock=../../output/tts/launcher.lock
if ! mkdir "$lock" 2>/dev/null; then
  # A stale startup lock may only be removed when its owner is no longer alive.
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  case "$owner" in ''|*[!0-9]*) owner=0;; esac
  stale=false
  if [ "$owner" -gt 1 ]; then
    if ! kill -0 "$owner" 2>/dev/null; then stale=true; fi
  else
    modified=$(stat -f %m "$lock")
    if [ "$(($(date +%s) - modified))" -gt 120 ]; then stale=true; fi
  fi
  if [ "$stale" = true ]; then
    rm -f "$lock/pid"
    rmdir "$lock"
    mkdir "$lock"
  else
    for attempt in $(seq 1 45); do sleep 1; if probe; then exit 0; fi; done
    echo '另一个 Studio TTS 启动仍未完成，请检查 output/tts/launcher.lock。' >&2
    exit 1
  fi
fi
echo $$ > "$lock/pid"
trap 'rm -f "$lock/pid"; rmdir "$lock"' EXIT
trap 'exit 130' INT TERM HUP
if probe; then exit 0; fi
nohup sh serve.sh > ../../output/tts/launcher.log 2>&1 < /dev/null &
tts_pid=$!
for attempt in $(seq 1 45); do
  if probe; then echo 'Studio TTS 已启动。'; exit 0; fi
  kill -0 "$tts_pid" 2>/dev/null || break
  sleep 1
done
echo 'Studio TTS 启动失败或超时，请查看 Studio 工程 output/tts/launcher.log。' >&2
exit 1
