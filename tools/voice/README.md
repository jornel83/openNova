# OpenNova 语音与桌面交互

当前统一入口默认打开工作窗口和右侧 Nova 对话窗口，然后连接共享 Bot 语音。公司网络可以运行 `./start.command --tts-provider doubao`；`--no-ui` 关闭自动开窗，`--ui` 保留为兼容参数。`--check` 和 `--list-devices` 不开窗口或麦克风。

首次使用需加载本工程 `extensions/browser` 扩展并与同一 Bot 配对，启动器会给出步骤。已配对浏览器会自动重连并复用窗口；语音未就绪时文字窗口仍保留。浏览器程序与外部 profile 由 `desktop.browser_executable` / `desktop.browser_user_data_dir` 或对应 `OPENNOVA_BROWSER_*` 环境变量配置。profile、授权、会话和记忆均应保存在仓库外。


> Harness 与 Bot 已作为源码纳入 OpenNova。首次运行先按[根目录说明](../../README.md)执行 `pnpm run setup -- --chatgpt` 与 `pnpm run build`。旧的外部 Harness 路径配置不再生效；以下历史验证记录保持原有日期。

## 一键启动共享 Bot 语音

2026-10-14 新增根目录 `start.command`，推荐用于当前 DeepSeek-Bot 版本。它自动使用 `--bot`，与网页共享上下文、工程文件和 Shell 能力；下文原有 `run-continuous.command` 仍是手动入口。

```sh
# 在项目根目录运行；省略设备参数则使用系统默认输入 / 输出
./start.command

# 内置麦克风 + 有线耳机
./start.command --device 'MacBook Air麦克风' --output-device '外置耳机'

# 蓝牙麦克风 + 音响
./start.command --device 'SRS-XB100' --output-device 'SRS-XB100'

# 可选：云端 GPT 代理；SSH 到 Studio 不使用此 HTTP 代理
./start.command --proxy http://127.0.0.1:7897 --device 'MacBook Air麦克风'

./start.command --list-devices
./start.command --check --device 'MacBook Air麦克风'

# 办公室云端 TTS，无需 Studio 在线；GPT 代理仍按自己的网络选择
./start.command --tts-provider doubao --device 'MacBook Air麦克风' --output-device '外置耳机'
./start.command --tts-provider doubao --check

# 回家使用 Vivian
./start.command --tts-provider studio
```

从其他目录可执行 `/path/to/openNova/start.command` 并附加相同参数。也可双击 `start.command` 使用系统默认设备。

启动按顺序完成：

1. 检查 Bot 身份和真实工程路径；已有服务复用，缺失时在后台启动。网页仍为 `http://127.0.0.1:18560/`。
2. 默认 Studio 模式检查本地 TTS 接口。若不可用，经 SSH 检查 Studio；TTS 尚未运行时执行已安装的 `serve.sh`，随后建立 SSH 转发。豆包模式跳过这一步全部本地端口 / SSH 检查，直接连接云端。
3. 执行现有持续语音客户端，自动带上 `--bot` 和本次转发地址，再传递输入 / 输出设备。VAD 和豆包 ASR 接入由语音客户端负责。

`--list-devices` 不启动服务、不打开麦克风。`--check` 会启动缺失的依赖服务，再检查原生设备、VAD、Bot 和 TTS 接口，不打开麦克风、不调用 ASR、不生成 GPT 回复。Studio 模式不合成音频；豆包模式合成一次“你好。”并丢弃，以确认服务权限和完整音频流，会产生少量 TTS 用量。不能代替真实交流验收。

`--tts-provider studio|doubao` 优先于 `OPENNOVA_TTS_PROVIDER`，其次为 `config/voice.local.json` 的 `tts.provider`，默认 `studio`；`cloud` 是 `doubao` 的别名。豆包默认使用 VV 女声、1 倍原速，可通过 `--tts-voice`、`OPENNOVA_DOUBAO_TTS_VOICE` 或 `tts.doubao_voice` 改为已授权的 2.0 Speaker ID。Vivian 仍是 Studio 音色，两者音色不同。云端固定请求官方 HTTPS 接口，`--tts-url` / `--tts-port` 只影响 Studio。

豆包凭据优先级：`DOUBAO_TTS_API_KEY` → 本地 secrets 的 `doubao.tts_api_key` → 已有 `doubao.api_key`。同一 Key 可以调用已开通的 ASR 和 TTS；只有 ASR 权限时会提示开通语音合成 2.0，停止启动。无需把密钥放入命令。详细配置见 [TTS 说明](../../services/tts/README.md#豆包云端-tts办公室模式)。

默认 SSH 主机为 `agent-control`。Studio 的 `services/tts` 部署路径通过机器配置 `tts.studio_tts_dir`、`OPENNOVA_STUDIO_TTS_DIR` 或 `--studio-tts-dir` 指定；优先级为命令行、环境变量、配置文件。主机同样支持 `tts.studio_host`、`OPENNOVA_STUDIO_HOST`、`--studio-host`。没有可复用的 TTS 连接且未配置部署路径时会报错，不再内置个人机器路径。Studio 运行的是本仓库 `services/tts` 的部署副本。要求此前已完成 SSH 主机信任和免密认证；连接失败会停止并提示，不自动修改 SSH 信任设置。默认本地转发端口为 18000，可用 `--tts-port` 修改；一键入口显式向语音客户端传入该回环地址，覆盖普通入口的 `tts.url` / `OPENNOVA_TTS_URL`。

`--proxy` 优先于 `OPENNOVA_PROXY`，仅对本次启动的进程生效；已有 Bot 保持原启动环境。更换代理后如需让 Bot 使用新设置，先执行 `tools/bot/run.command --stop`，再执行一键入口。脚本不更改系统代理。TTS HTTP 检查和语音传输绕过 HTTP 代理，SSH 的实际网络路径由现有 SSH / Tailscale 配置决定。

退出时输入 `/quit` 或按 `Ctrl+C`：语音客户端清理收音、播放和当前任务；保留 Bot 和 Studio TTS，便于继续网页聊天或再次启动。仅本次创建的 SSH 转发会关闭，原有转发不受影响。一键入口同时只允许一个语音会话，避免重复拾音。启动失败不会结束已有服务；自动启动且已就绪的 Bot 也会保留。

Air 启动日志位于 `output/voice/launcher/` 下的 `bot.log`、`studio.log`、`tunnel.log`；远端自动启动 TTS 的日志位于 Studio 工程 `output/tts/launcher.log`。日志受 Git 忽略并以本机私有权限创建，Bot 内部日志可能包含本地管理地址，勿公开上传。端口被其他程序占用时明确报错，不自动结束该程序。

启动器回归：`/opt/homebrew/opt/node@24/bin/node --test tools/voice/tests/launcher.test.mjs`。覆盖服务启动与复用、参数传递、SSH / 端口错误、并发启动保护、锁恢复、真实 uv/Python 中断清理以及远端启动脚本；外部 Bot / SSH / 音频使用本地测试进程，TTS 启动脚本使用临时 HTTP 服务。另已在 Air 实测现有转发复用、新建转发及 `--check`，未进行真人对话或重新加载 Studio 模型。

## 原有语音模式

以下为旧模式和手动启动说明，`--web` 是旧语音模式的联网搜索开关，不是网页入口，也不与 `--bot` 同时使用。

运行链路：**Air 原生音频 / Silero VAD → 豆包流式 ASR 2.0 → DeepSeek Harness / GPT-6.1 Sol → Studio Vivian → Air 1.5 倍保调播放**。

2026-10-12 新增 `--continuous` 持续交流模式：持续拾音、增量文本分段合成、候选插话暂停、确认插话后取消旧生成和播报，以及静音、停止和重新开始。原来的轮流说话模式继续保留。2026-10-13 新增可选 `--web` 只读搜索和网页读取；视觉、文件和命令执行仍关闭。

## 联网对话

先按 [Agent 安装说明](../../services/agent/README.md#联网工具桥接2026-10-13) 构建扩展。本机使用 DeepSeek 搜索时，在 `config/voice.local.json` 设置 `web.provider` 为 `deepseek`，并在 Git 忽略的 `config/secrets.local.json` 配置 `web.deepseek_api_key`。也可选择 `exa` 并配置 `web.exa_api_key`。DeepSeek 搜索、GPT 来源追问与搜索后的 Vivian 语音文件链路已通过真实验证；语音听感仍需现场验收。

```sh
OPENNOVA_PROXY=http://127.0.0.1:7897 tools/voice/run-continuous.command --web \
  --output-device 'SRS-XB100' --device 'SRS-XB100'

OPENNOVA_PROXY=http://127.0.0.1:7897 tools/voice/run-continuous.command --web \
  --device 'MacBook Air麦克风'
```

联网模式在完整答案就绪后分句合成。检索或读取开始后等待超过 2 秒，会最多提示一次“我查一下，请稍等”；快速完成则不提示。提示和答案共用一个播放队列，链接和来源留在终端，Vivian 不朗读 URL。答案到达时，仍未产出 PCM 的提示合成会取消；已开始输出的提示先结束，再播放答案。插话、`/stop`、`/end` 和退出会取消本轮输出，`/retry` 保留联网模式与设备参数。

报告分别记录 `notice_first_pcm_at`、`answer_first_pcm_at`、`agent_complete_at`；`first_pcm_at` 继续代表答案首 PCM，不用提示音时间替代答案延迟。PCM 到达与实际扬声器首声不同，文件验证不证明现场听感。

不传 `--web` 即恢复原增量模式；`--web` 只支持持续模式，旧轮流模式会明确拒绝。可先用[文字入口和验收用例](../../docs/research/opennova-web-search-verification.md) 排除音频因素。

已通过真实云端与 Studio 的两轮文件链路、同一 Harness 会话取消后继续交流，以及本地自动化回归。**原生音频已通过内置设备的实际启动、Voice Processing 开启、采集 PCM、静音播放排空和上行静音检查；内置扬声器下的 AEC 效果、插话完整性和跨句听感仍待现场验证。**

## 在 Air 开始持续交流

不传设备参数时，使用 macOS 当前默认输入、输出。从项目根目录运行：

```sh
tools/voice/run-continuous.command
```

也可以在命令末尾选择设备，参数仅影响本次 Demo，不修改系统全局默认输入、输出：

```sh
# 蓝牙麦克风和音响
tools/voice/run-continuous.command --output-device 'SRS-XB100' --device 'SRS-XB100'

# 内置麦克风和扬声器
tools/voice/run-continuous.command --output-device 'MacBook Air扬声器' --device 'MacBook Air麦克风'

# 只切换麦克风，播放仍使用系统默认输出
tools/voice/run-continuous.command --device 'MacBook Air麦克风'

# 查看设备名称，不连接模型服务，不打开麦克风
tools/voice/run-continuous.command --list-devices
```

`--device` 选择输入，`--output-device` 选择输出；名称忽略空格和大小写，支持唯一的部分名称。找不到设备、名称有歧义或设备方向不符会明确报错，不会悄悄改用另一个麦克风。`/retry` 会保留传入的选择；未指定的一侧重新读取系统默认设备。运行中换设备后，需要 `/retry` 或用新的参数重启。

本机需要现有代理时，只为该命令指定地址：

```sh
OPENNOVA_PROXY=http://127.0.0.1:7897 tools/voice/run-continuous.command
```

其他机器填写实际代理地址；脚本不更改系统代理或网络配置。它优先使用已有的 Homebrew Node 24，也可用 `OPENNOVA_NODE` 指定实际可执行文件。与已有 CLI 等价的入口是：

```sh
OPENNOVA_NODE=/opt/homebrew/opt/node@24/bin/node \
uv run tools/voice/conversation.py --continuous
```

默认 Node 22 曾在本机初始化 Harness 时提前退出，因此此开发环境使用已验证的 Node 24.14.1。`NODE_USE_ENV_PROXY=1` 配合 `HTTPS_PROXY` / `HTTP_PROXY` 也是有效的启动方式。错误会区分授权、模型列表、Harness 启动和对话阶段，不输出凭据或服务端任意错误正文。

第一次运行或源码更新后会编译 `tools/voice/native/` 的 Swift 源码到 Git 忽略的 `output/voice/bin/`。需要 macOS 15+ 和 Xcode Command Line Tools；macOS 可能请求终端麦克风权限。看到“正在聆听”后再开口。持续模式要求所选输入、输出组合能启用 Voice Processing；失败会报告设备问题，不会静默降级。已验证内置组合、SRS-XB100 组合和内置麦克风配 SRS-XB100 输出的启动、PCM 采集与静音播放排空；实际蓝牙外放回声和插话听感仍需现场验证。

| 终端操作（输入后回车） | 行为 |
| --- | --- |
| `/stop` | 立即停止当前回复，取消生成与合成，保留会话继续聆听 |
| `/mute` / `/unmute` | 阻断 / 恢复 VAD 与 ASR 上行，丢弃静音前未提交的输入；静音不停止现有播报 |
| `/end` / `/start` | 结束 / 重新进入活跃交流；保留本进程的模型上下文 |
| `/retry` | 恢复设备连接后按本次设备参数重建音频；若 Agent 连接已退出，显式重建 Agent 并提示进入新模型会话 |
| `/quit` 或 `Ctrl+C` | 退出并清理采集、播放、识别连接及本次自有子进程 |

正常停顿默认 800 ms。最新中间转写出现明显未完句或改口词时延长到 1600 ms；可用 `--silence-ms` / `--extended-silence-ms` 调整，最大 3000 ms。这是有限规则，不是完整语义断句。中间转写按修订替换，只有成功的最终文本进入 Agent。思考或播报期间新增输入采用下面的插话过滤；待机聆听仍使用原来的起点与前置音频缓存。

每轮最长发言 45 秒。超时、积压或提前失败的输入会被放弃，等待真实停顿后接收下一轮，避免把残余半句话当作新问题。最多 2 个 ASR 请求在收尾，100 帧上行缓存、8 个待合成文本段，每段最多 160 字，原生播放器最多缓存 2 秒 PCM；子进程和管道也有各自有限缓冲。持续模式运行到明确退出，不使用原有 `--turns` / `--listen-seconds` 的轮流模式计数。

## 插话误触发优化（2026-10-16）

所有持续模式入口（包括一键 Bot、旧 Harness 和云端 / Studio TTS）默认启用；退出旧语音进程后重新运行原命令即可，不需要更新 Studio。收音与 ASR 仍从原有约 96 ms 的 VAD 候选开始，不会为等待插话确认而丢弃句首。

| 判定步骤 | 当前行为 |
| --- | --- |
| 候选收音 | 仅开始识别，不立即暂停播报 |
| 暂停门槛 | 连续 256 ms 的音频同时满足 VAD 概率 ≥ 0.65、RMS ≥ -55 dBFS，且高于估计环境底噪 8 dB；底噪仅在低语音概率帧更新 |
| 普通插话确认 | 去掉标点和“嗯、啊”等语气音后至少两个有效字符；中间转写的前两个有效字符跨至少 160 ms 的两次结果保持一致，或得到有效最终转写，并满足上述声学门槛 |
| 明确停止指令 | “停”“等一下”“暂停”等完整匹配指令，在满足声学强度要求的连续 96 ms 人声后可快速确认，不等待普通插话稳定窗口 |
| 未确认的候选 | ASR 失败或最终转写不符合插话条件时，恢复仍有效的旧播报；没有结论时约 1.2 秒自动恢复，同一候选不反复暂停。较晚到达的有效最终转写仍可提交 |

一旦已确认插话并取消旧回复，保留该轮有效最终转写，包括 ASR 对短指令的修订。这些是初始保守阈值，尚未完成真实蓝牙声学验收。较轻或极短的“好”“不”等播报中插话可能被忽略，可改为“好的，继续”“不是这个”；待机时单字交流不受此限制。清晰持续的远处人声仍可能通过，音量不是距离或身份识别；本次没有新增声纹、唤醒词或回声消除模型，也不会保证过滤所有咳嗽。

若通过手动持续入口使用 `--output-dir`，`conversation.json` 的每轮 `barge_in` 最多保存 50 条候选、暂停、确认、过滤及恢复事件，包含连续强人声时长、最近一帧 VAD 概率 / RMS 和环境底噪估计，不保存原始录音。`strong_ms` 是该候选内最长连续合格时长，不代表最近一帧仍是人声。一键入口暂不透传 `--output-dir`。

复测时先让 Nova“用五句话介绍一下 OpenNova”，在播报过程中分别测试：

1. 敲键盘、短促咳嗽或让远处的人正常说话，观察是否仍频繁暂停；安静外放也应测试，排查自身回声。
2. 近距离说“帮我说得简短一点”，应暂停并切换到新回复，句首不丢失。
3. 说“停”或“等一下”，应保留快速插话；一次未确认候选后，旧回复应恢复，不从头重播。
4. `/mute`、`/unmute` 与 `/retry` 后重新测试，确认没有迟到识别或超时事件干扰新回复。

离线针对性回归：`python3.11 -m unittest discover -s tools/voice/tests -p test_barge_in.py`。使用人工构造的音频强度 / VAD 结果与本地替身 ASR、Agent、播放器，验证决策和生命周期；不代表真实噪音识别率或扬声器停声延迟。

## 依赖和启动检查

Air 需要 `uv`、Node 24、FFmpeg 和 Swift 工具链。Python 3.11+ 依赖由入口脚本固定。配置、版本和授权重建见[根目录说明](../../README.md)与 [Agent 说明](../../services/agent/README.md)。豆包密钥从 `DOUBAO_ASR_API_KEY` 或 Git 忽略的 `config/secrets.local.json` 读取；持续模式不引入新授权或计费路径。

```sh
OPENNOVA_PROXY=http://127.0.0.1:7897 tools/voice/run-continuous.command --check
```

该检查编译并检查原生设备、加载本地 VAD、检查 Vivian 与模型授权、启动流式 Harness，但**不打开麦克风、不调用 ASR、不生成回复**，不能替代实际交流。

单独验证原生音频实际启动，可运行：

```sh
python3.11 tools/voice/tests/native_startup_smoke.py

# 显式验证蓝牙设备
python3.11 tools/voice/tests/native_startup_smoke.py --output-device 'SRS-XB100' --device 'SRS-XB100'
```

此项会短暂打开麦克风，检查采集 PCM、播放一段全零 PCM 并等待排空，然后验证上行静音；不保存录音、不连接 ASR，也不发出可听声音。它不属于默认单元测试，需要显式执行。修复过的启动问题为 Voice Processing 两端客户端格式不一致（系统错误 `-10875`）：现在采集 tap 与播放 mixer 的输出统一为同采样率单声道；24 kHz TTS 和 16 kHz ASR 在各自边界转换。

Studio 运行[现有 TTS 服务](../../services/tts/README.md)。Air 的 `127.0.0.1:18000` 需要 SSH 转发到 Studio `127.0.0.1:8000`。仅在没有现有转发时，另开终端运行：

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18000:127.0.0.1:8000 agent-control
```

使用这个手动入口时，SSH 转发需要手动保持运行；根目录 `start.command` 已自动管理连接。端口不可达时先检查转发和 Studio 服务。网络过载不会自动重试旧回答，终端保留已显示文字，下一轮可继续说话。授权或启动失败仍需修复对应配置。TTS 客户端绕过 HTTP 代理访问回环端口；SSH 实际走局域网还是中继取决于当前网络路径，不能仅凭开启 VPN 推断。网络排查与单次局域网测量见 [TTS 说明](../../services/tts/README.md#局域网传输复核-2026-10-12)。

## 版本收尾验证（2026-10-12）

本次收尾包含原生启动格式修复、进程内设备选择及 `/retry` 保留选择；未调整 VAD 阈值或咳嗽过滤规则。

| 验证 | 结果与边界 |
| --- | --- |
| Python 回归 | 90 项通过：语音 53、ASR 26、TTS 10、环境安装 1；使用 Python 3.11 |
| Agent 回归 | Node 24 下 16 项通过；覆盖流式响应、取消、会话隔离与错误信息处理 |
| Swift 回归 | 播放队列 7 项、设备选择 7 项检查通过 |
| 原生实际启动 | 内置组合、SRS-XB100 组合、内置麦克风配 SRS-XB100 输出均通过；每种收到 17,600 个采集样本，完成全零 PCM 播放排空与上行静音 |
| 故障恢复自动化 | 注入音频故障后 `/retry` 恢复收音、保留所选设备、复用正常 Agent；Agent 已退出时明确提示新模型会话。覆盖重连期间静音、结束与退出时的资源清理 |
| 原生进程退出探针 | SRS-XB100 音频进程刚开始采集即被终止后，立即重建两次均出现路由变化；等待 3 秒后重建的一次复测通过采集与静音播放。另三次常规关闭 / 重建通过。这是已知时序问题，尚未修复 |
| 服务预检 | SRS-XB100 参数下 `--check` 通过原生设备、VAD、Agent 授权 / 启动和 Vivian 可达性检查；没有生成新回复 |

离线回归命令见[根目录说明](../../README.md#验证与当前边界)。Swift 检查在仓库根目录运行：

```sh
mkdir -p output/voice
xcrun swiftc -O tools/voice/native/PlaybackQueue.swift tools/voice/native/tests/QueueTests.swift -o output/voice/queue-tests
output/voice/queue-tests
xcrun swiftc -O tools/voice/native/AudioDevices.swift tools/voice/native/tests/DeviceTests.swift -o output/voice/device-tests
output/voice/device-tests
```

既有真实两轮文件链路与取消记录保留在下文。本次收尾不重复生成云端回复；上述检查不代表已验证真实蓝牙断连 / 热插拔、外放 AEC、插话听感或长时间稳定性。

蓝牙快速重建若出现“音频设备已断开或默认设备已变化”，可先等待几秒再输入 `/retry`；本次 3 秒等待复测成功，不代表所有设备都能在固定时间内恢复。该问题保留为后续音频恢复优化项，本版不自动循环重试或切换设备。

## 文件验证与记录

```sh
OPENNOVA_PROXY=http://127.0.0.1:7897 tools/voice/run-continuous.command \
  --audio output/voice/inputs/remember.wav \
  --audio output/voice/inputs/recall.wav \
  --no-play --output-dir output/voice/my-new-continuous-test
```

持续模式的文件测试必须带 `--no-play`，使用真实 VAD、ASR、GPT 和 Vivian，但不打开麦克风或扬声器。每个文件尾部保留至少 2 秒静音，输出目录必须不存在。报告记录输入收尾、提交、首个模型增量、首个 PCM、入队、完成和中断状态；文件模式的“入队 / 排空”仅代表消费数据，不代表实际出声。

两轮实测均成功，第二轮记住“蓝色水滴”。从最终转写提交开始计时：

| 指标 | 第一轮 | 第二轮 |
| --- | --- | --- |
| 模型首个文本片段 | 5.853 s | 5.633 s |
| 首个保调 PCM | 7.517 s | 7.499 s |
| 模型整轮完成 | 6.657 s | 6.383 s |

这是短回复单次文件样本，不是 P95，也不能据此宣称首声比旧版更快。原始记录：`output/voice/continuous-real-04/conversation.json`。同会话取消探针在收到首个增量后，约 0.006 s 收到取消结算，后续成功回忆暗号；这不包括真人插话、扬声器停声或 GPU 停算延迟。

另一次六句长回复文件测试中，模型首字为 4.065 s、首个 PCM 为 5.821 s、整轮模型完成为 8.298 s，六段全部合成成功。首段 PCM 比模型整轮结束早约 2.48 s，验证了“边生成边合成”的路径；未测量扬声器首声。记录：`output/voice/continuous-long-01/conversation.json`。

默认不保存用户原始收音或回复 WAV；持续模式 `--output-dir` 只保存文字和时序 JSON。Harness 按自身机制保存本地文字上下文；重新启动脚本会创建新模型会话。

本地取消会关闭 TTS 客户端进程、HTTP 连接和 FFmpeg。**Studio 没有返回 GPU 计算释放的确认信号**，因此报告始终将服务端取消验证标为 false，不把断开连接等同于模型立即停算。新音频仍有播放代次校验，旧结果不能重新入队。

## 现场仍需验证

- 安静时连续外放，确认助手不会把自己当作用户。
- 在句首、句中、句尾插话，确认及时停声且新表达开头完整。
- “好”“不”“等一下”、停顿后补充和改口；键盘声、轻声、重咳嗽与远处人声。插话过滤规则已更新，听感和阈值仍需现场验证。
- 静音期间说话、恢复后开口、设备变更后 `/retry`。
- 多句 Vivian 的衔接、音量与语调；长时间运行；Studio 断流后的资源释放时间。

## 保留的轮流说话模式

```sh
OPENNOVA_NODE=/opt/homebrew/opt/node@24/bin/node \
uv run tools/voice/conversation.py --device 'MacBook Air麦克风'
```

不传 `--continuous` 时仍按原流程：思考和播报期间关闭麦克风，播放结束等待 0.6 秒后重新收音。可显式指定蓝牙设备和输出，例如 `--device SRS-XB100 --output-device SRS-XB100`。默认最多 20 次聆听、每次 60 秒；此模式没有 AEC 或播报插话。原有 `--audio` / `--no-play` / 回复 WAV 保存行为保持不变。

## 可选 DeepSeek-Bot 实验

先运行 `tools/bot/run.command` 保持宿主，再在持续语音命令加 `--bot`。网页入口为 http://127.0.0.1:18560/，可输入文本、查看双方对话、查看语音执行的文件/记忆修改记录；文件与记忆直接生效，无需确认。该模式与 `--web` 互斥，文本和语音使用同一持久 Bot，会等待完整答复再播报。部署、操作记录命令及尚待现场验收项目见[接入实验说明](../../docs/research/opennova-bot-spike.md)。

Bot 模式现已连接 OpenNova 真实工程，支持文件浏览、代码检索、读写和 Shell 测试执行，无需二次确认。语音 `/stop` 或确认插话会取消当前前台命令，已完成的修改保留；`/operations` 与网页操作记录显示同一组文件差异和命令结果。前台整轮时限 10 分钟，长任务等待期间麦克风继续监听。
