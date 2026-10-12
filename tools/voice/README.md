# OpenNova 语音对话 Demo

运行链路：**Air 原生音频 / Silero VAD → 豆包流式 ASR 2.0 → DeepSeek Harness / GPT-6.1 Sol → Studio Vivian → Air 1.5 倍保调播放**。

2026-10-12 新增 `--continuous` 持续交流模式：持续拾音、增量文本分段合成、候选插话暂停、确认插话后取消旧生成和播报，以及静音、停止和重新开始。原来的轮流说话模式继续保留。当前只开放对话和同一进程内的上下文，工具执行与视觉输入仍关闭。

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

正常停顿默认 800 ms。最新中间转写出现明显未完句或改口词时延长到 1600 ms；可用 `--silence-ms` / `--extended-silence-ms` 调整，最大 3000 ms。这是有限规则，不是完整语义断句。中间转写按修订替换，只有成功的最终文本进入 Agent。候选人声先暂停播报，有有效识别文本后才取消；空结果可以恢复仍有效的上一段播报。

每轮最长发言 45 秒。超时、积压或提前失败的输入会被放弃，等待真实停顿后接收下一轮，避免把残余半句话当作新问题。最多 2 个 ASR 请求在收尾，100 帧上行缓存、8 个待合成文本段，每段最多 160 字，原生播放器最多缓存 2 秒 PCM；子进程和管道也有各自有限缓冲。持续模式运行到明确退出，不使用原有 `--turns` / `--listen-seconds` 的轮流模式计数。

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

SSH 转发当前需要手动保持运行；端口不可达时先检查转发和 Studio 服务。网络过载不会自动重试旧回答，终端保留已显示文字，下一轮可继续说话。授权或启动失败仍需修复对应配置。TTS 客户端绕过 HTTP 代理访问回环端口；SSH 实际走局域网还是中继取决于当前网络路径，不能仅凭开启 VPN 推断。网络排查与单次局域网测量见 [TTS 说明](../../services/tts/README.md#局域网传输复核-2026-10-12)。

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
- “好”“不”“等一下”、停顿后补充和改口；键盘声与轻声。重咳嗽可能触发候选人声，相关优化按用户决定暂缓。
- 静音期间说话、恢复后开口、设备变更后 `/retry`。
- 多句 Vivian 的衔接、音量与语调；长时间运行；Studio 断流后的资源释放时间。

## 保留的轮流说话模式

```sh
OPENNOVA_NODE=/opt/homebrew/opt/node@24/bin/node \
uv run tools/voice/conversation.py --device 'MacBook Air麦克风'
```

不传 `--continuous` 时仍按原流程：思考和播报期间关闭麦克风，播放结束等待 0.6 秒后重新收音。可显式指定蓝牙设备和输出，例如 `--device SRS-XB100 --output-device SRS-XB100`。默认最多 20 次聆听、每次 60 秒；此模式没有 AEC 或播报插话。原有 `--audio` / `--no-play` / 回复 WAV 保存行为保持不变。
