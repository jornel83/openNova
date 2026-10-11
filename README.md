# OpenNova

OpenNova 是面向工作协同、日常陪伴与随时交流的软硬一体 AI 超级助手。本仓库保存产品定义、技术预研与开发实现。

当前版本是 **v0.1.0-alpha 语音 MVP 开发基线**：本地 VAD → 豆包流式 ASR 2.0 → DeepSeek Harness / GPT-6.1 Sol → Qwen3-TTS Vivian，采用 1.5 倍保调语速。用户已确认现场对话可运行；当前版本轮流说话，思考和播放期间关闭麦克风。

## 工程结构

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

以下命令在仓库根目录执行。Air 需要 macOS、Xcode Command Line Tools、Git、Python 3.11+、Node **22.19+（22.x）或 24+**（含 npm/npx）、uv 和 FFmpeg。Studio 需要 Apple Silicon、uv 和 Python 3.12（由 uv 安装）。

1. **准备 Air 的 Agent 环境**：

   ```sh
   python3 tools/setup/bootstrap.py --install
   python3 tools/setup/bootstrap.py --check
   ```

   安装入口使用[固定版本清单](config/runtime-versions.json)下载并构建 Harness 与官方 SIWC DevKit，在本机编译 `keychain.swift`。已有正确版本及构建会复用；版本不匹配或存在未提交文件时停止，保留原目录，可在配置中换一个路径再安装。不会重新登录或覆盖已有 helper。首次完整构建会联网下载依赖，需要一定时间和磁盘空间。

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
   uv run tools/voice/conversation.py --check --device 'SRS-XB100' --output-device 'SRS-XB100'
   uv run tools/voice/conversation.py --device 'SRS-XB100' --output-device 'SRS-XB100'
   ```

   可省略设备参数使用系统默认设备。`--check` 不打开麦克风，不调用 ASR 识别或生成模型回复；会检查授权、模型目录、Harness 启动、VAD 依赖和 TTS 服务可达性。实际合成与识别仍需完整对话验证。首次使用需要系统麦克风权限。按 `Ctrl+C` 退出。

## 验证与当前边界

离线回归（需要 FFmpeg，不使用麦克风或云端推理）：

```sh
python3 -m unittest discover -s tools/asr/tests -v
python3 -m unittest discover -s tools/voice/tests -v
python3 -m unittest discover -s services/tts/tests -v
python3 -m unittest discover -s tools/setup/tests -v
node --test services/agent/tests/*.test.mjs
```

完整链路可使用 `--audio <一次自然发言.wav> --no-play`，可重复 `--audio` 验证多轮记忆；文件最长 60 秒，单次连续发言应小于 45 秒。显式传 `--output-dir output/voice/<新目录>` 才保存回复 WAV 与对话报告。Harness 文字会话保存在 `~/.local/share/opennova/harness-home/sessions/`。

目前支持当前进程内的多轮文字上下文与 Vivian 固定音色。工作工具执行、长期记忆、视觉输入、硬件集成、插话打断、AEC、服务自动恢复尚未完成。Base 真人声音克隆作为独立实验保留，当前对话默认使用 CustomVoice / Vivian。此版本可作为后续 MVP 开发起点，尚未覆盖完整 PRD。

- [MVP PRD](docs/product/opennova-mvp-prd.md)
- [开发部署方案](docs/research/opennova-mvp-development-deployment.md)
- [语音链路设计](docs/research/opennova-voice-pipeline-design.md)
- [完整对话使用说明](tools/voice/README.md)
