# OpenNova

OpenNova 是面向工作协同、日常陪伴与随时交流的软硬一体 AI 超级助手。本仓库保存产品定义、技术预研与开发实现。

当前桌面开发版（2026-10-19，`codex/desktop-browser-m0`）已接入 **工作窗口 + 深空 Nova 对话窗口 + 原生持续语音**。语音链路为本地 VAD → 豆包 ASR → DeepSeek-Bot / Harness / GPT → Studio Vivian 或豆包 VV。文字与语音共享会话、工作引用和执行记录。

## 一键启动

完成本机配置与依赖安装后，在本仓库执行：

```sh
./start.command --ui --tts-provider studio --device 'SRS-XB100' --output-device 'SRS-XB100'
# 办公室 / 不连接 Studio
./start.command --ui --tts-provider doubao --device 'MacBook Air麦克风' --output-device '外置耳机'
./start.command --list-devices
./start.command --check --tts-provider doubao
```

`--ui` 按 Bot → Chrome 扩展及双窗口 → TTS → 原生语音的顺序启动。默认 `--no-ui` 保留终端模式。省略设备参数使用系统默认设备；设备名以 `--list-devices` 为准。`--check` 和设备列表均不开窗或收音。

首次在 Chrome 加载 `extensions/browser` 并按终端提示配对；已配对后自动复用窗口。扩展尚未连接时打开普通文字入口，文字、语音和本地文件仍可使用。TTS / 音频失败不会关闭文字入口；重复 `--ui` 不重复开麦克风，不改变已有窗口布局。终端 `/quit` 或 Ctrl+C 只清理本次语音与 SSH 转发，保留 Bot、浏览器及文件应用。

隔离开发版使用独立数据目录和 18564 端口，不能直接复用日常工作区的 Bot。当前机器的一键命令、首次扩展设置和验收边界见 [M4 启动说明](docs/research/opennova-desktop-interaction-test-cases.md#m4一键启动与双窗口)。

## 工程结构

2026-10-13 新增可选联网模式 `--web`：Harness 原生 `web_search` / `web_fetch` → GPT 工具回传 → 带来源的完整答案 → Vivian。搜索后端可选 Exa 或 DeepSeek；DeepSeek 实际搜索、GPT 来源答复与同会话追问已通过文字验证。网页读取与语音文件链路已有验证记录，搜索后的现场听感仍待验收。不传 `--web` 继续使用原增量语音模式。安装、命令和验收边界见[联网版验收记录](docs/research/opennova-web-search-verification.md)。

| 目录 | 职责 |
| --- | --- |
| `tools/voice/` | 完整对话入口、收音分轮、Agent 进程管理与播放 |
| `tools/asr/` | Silero VAD、豆包 WebSocket 协议、独立 ASR 测试 |
| `services/agent/` | Harness 桥接、官方 ChatGPT 授权、模型适配与 Keychain helper 源码 |
| `services/tts/` | Studio MLX 推理环境、固定模型下载、Vivian 请求与变速处理 |
| `tools/setup/` | 固定版本的 Agent 依赖安装与环境检查 |
| `config/` | 配置模板与上游版本清单；真实配置使用 `.local.json` |
| `docs/product/`、`docs/research/` | PRD、产品架构、技术选型和部署说明 |
| `videos/` | 产品演示视频工程 |
| `output/` | 本机生成的音频、测量报告及对话记录，Git 忽略 |

**MacBook Air** 负责拾音、VAD、豆包 ASR 接入、Agent 和播放；**Mac Studio** 负责 Vivian 推理，通过 SSH 转发连接。ASR 与 LLM 使用已配置的云端服务。

## 本地配置

真实豆包密钥保存于 `config/secrets.local.json`，读取顺序为 `DOUBAO_ASR_API_KEY` 环境变量 → 本地文件；可用 `OPENNOVA_SECRETS_FILE` 指定其他文件。README 不存放也不提供密钥。模板中的密钥值为空。

首次配置时复制模板，已有文件不要覆盖：

```sh
cp -n config/secrets.example.json config/secrets.local.json
chmod 600 config/secrets.local.json
cp -n config/voice.example.json config/voice.local.json
```

在本地文件填写 `doubao.api_key_name`、`doubao.api_key`。`voice.local.json` 不含凭据，用于配置机器路径：

| 配置 | 默认值 / 用途 | 环境变量覆盖 |
| --- | --- | --- |
| `agent.harness_root` | 相邻 `../deepseek-harness` | `OPENNOVA_HARNESS_ROOT` |
| `agent.siwc_root` | `~/.local/share/opennova/siwc-devkit` | `OPENNOVA_SIWC_ROOT` |
| `agent.keychain_helper` | `~/.local/share/opennova/bin/siwc-keychain` | `OPENNOVA_KEYCHAIN_HELPER` |
| `agent.siwc_storage` | `~/.config/opennova-siwc-probe`；保留已有独立授权 | `OPENNOVA_SIWC_STORAGE` |
| `tts.data_dir` | `~/AgentWorkstation`；**推理服务器上的绝对路径** | `OPENNOVA_TTS_DATA_DIR` |
| `tts.url` | `http://127.0.0.1:18000`；Air 的转发地址 | `OPENNOVA_TTS_URL` |

配置留空使用默认值；路径请用绝对路径。`OPENNOVA_CONFIG` 可指定其他非敏感配置文件。在 Air 上，`tts.data_dir` 必须填写 Studio 模型目录的根路径。本机已保存当前 Studio 路径，原启动命令可继续使用。Studio 可使用其自身默认主目录。

`.gitignore` 排除两份本地配置、`.env`、虚拟环境、日志、缓存与 `output/`。ChatGPT 凭据使用本机 Keychain 加密，保存在仓库外；换机器需独立授权。

## 搭建与启动

以下命令在仓库根目录执行。Air 需要 macOS 15+、Xcode Command Line Tools、Git、Python 3.11+、**Node 24**（含 npm/npx）、uv 和 FFmpeg。本机已验证 Node 24；虽上游声明兼容部分 Node 22 版本，本机曾遇到 Node 22 初始化退出，因此启动脚本优先使用 Homebrew Node 24。Studio 需要 Apple Silicon、uv 和 Python 3.12（由 uv 安装）。

1. **准备 Air 的 Agent 环境**：

   ```sh
   python3.11 tools/setup/bootstrap.py --install
   python3.11 tools/setup/bootstrap.py --check
   ```

   安装入口使用[固定版本清单](config/runtime-versions.json)下载并构建 Harness 与官方 SIWC DevKit，在本机编译 `keychain.swift`。Harness 固定为用户仓库 `git@github.com:jornel83/deepseek-harness.git` 的 `v0.2.1-alpha.2`，需要本机 GitHub SSH 访问权限。已有正确版本及构建会复用；版本不匹配或存在未提交文件时停止，保留原目录，可在配置中换一个路径再安装。已有检出升级后须重新安装依赖和构建。不会重新登录或覆盖已有 helper。首次完整构建会联网下载依赖，需要一定时间和磁盘空间。

2. **准备 Studio 的 TTS**：将仓库放到 Studio，从 `services/tts/` 运行：

   ```sh
   uv sync --locked --python 3.12.14
   uv run --locked python download_model.py
   sh serve.sh
   ```

   服务监听 `127.0.0.1:8000`。权重按固定快照下载到 `tts.data_dir`，不进入 Git。详见 [TTS 说明](services/tts/README.md)。已有服务无需重复启动。

3. **连接 TTS 与授权**：在 Air 的独立终端保持 SSH 转发；`agent-control` 是当前 Studio 的 SSH 别名，新环境请改为自己的主机。

   ```sh
   ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18000:127.0.0.1:8000 agent-control
   node services/agent/authorize.mjs
   ```

   按终端提示完成 OpenNova 自身的 Sign in with ChatGPT 授权。已授权时会复用。当前模型固定为 `gpt-6.1-sol`，以账号实际模型目录和额度为准。

4. **检查并开始对话**：

   ```sh
   tools/voice/run-continuous.command --list-devices
   tools/voice/run-continuous.command --check --device 'SRS-XB100' --output-device 'SRS-XB100'
   tools/voice/run-continuous.command --device 'SRS-XB100' --output-device 'SRS-XB100'
   ```

   内置设备可改为 `--device 'MacBook Air麦克风' --output-device 'MacBook Air扬声器'`，省略参数则使用系统默认设备。参数只影响本进程，不修改系统默认路由。`--check` 不打开麦克风，不调用 ASR 识别或生成模型回复；会检查音频设备、授权、Harness、VAD 依赖和 TTS 可达性。首次使用需要系统麦克风权限。输入 `/mute` 静音、`/stop` 停止回复、`/retry` 重建音频、`/quit` 或 `Ctrl+C` 退出。代理设置和原轮流模式见[完整运行说明](tools/voice/README.md)。

## 验证与当前边界

离线回归（需要 FFmpeg，不使用麦克风或云端推理）：

```sh
python3.11 -m unittest discover -s tools/asr/tests -v
python3.11 -m unittest discover -s tools/voice/tests -v
python3.11 -m unittest discover -s services/tts/tests -v
python3.11 -m unittest discover -s tools/setup/tests -v
node --test services/agent/tests/*.test.mjs
```

联网扩展测试需先执行 `python3.11 tools/setup/bootstrap.py --install --web`，使用 Node 24，并确保 `agent.harness_root` 指向固定版本的已构建 Harness。

完整链路可向持续模式入口传入 `--audio <一次自然发言.wav> --no-play`，可重复 `--audio` 验证多轮上下文；文件最长 60 秒，单次连续发言应小于 45 秒，尾部保留至少 2 秒静音。显式传 `--output-dir output/voice/<新目录>` 时，持续模式只保存文字与时序 JSON，原轮流模式另保存回复 WAV。Harness 文字会话保存在 `~/.local/share/opennova/harness-home/sessions/`；重新启动 Demo 会新建模型会话。

目前支持当前进程内的多轮文字上下文与 Vivian 固定音色。已接入系统 Voice Processing 和打断流程，声学效果仍待验证；Studio GPU 停算未获得确认。Bot 已接入工程文件、Shell 与基础持续记忆；视觉输入、硬件集成、完善的记忆管理和生产级服务自动恢复仍未完成。Base 真人声音克隆作为独立实验保留，当前对话默认使用 CustomVoice / Vivian。此版本可作为后续 MVP 开发起点，尚未覆盖完整 PRD。

已知限制：蓝牙音频进程刚启动即被终止后，立即重建可能报告路由变化；等待几秒再 `/retry` 的复测已通过。具体结果和其余待测项见[版本收尾记录](tools/voice/README.md#版本收尾验证2026-10-12)。

- [MVP PRD](docs/product/opennova-mvp-prd.md)
- [开发部署方案](docs/research/opennova-mvp-development-deployment.md)
- [语音链路设计](docs/research/opennova-voice-pipeline-design.md)
- [完整对话使用说明](tools/voice/README.md)
