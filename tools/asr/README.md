# 豆包流式 ASR 2.0 连通性测试

从项目根目录运行：

```sh
uv run tools/asr/doubao_asr.py
```

优先读取环境变量 `DOUBAO_ASR_API_KEY`，否则读取 Git 忽略的 `config/secrets.local.json` 中的 `doubao.api_key`；配置模板见根目录 README。脚本不打印密钥，不把凭据写入结果文件。依赖由 uv 隔离管理；音频转换需要本机 FFmpeg。

默认上传项目已有的中文合成音频 `videos/scene-one/public/audio/02-user.mp3`，参考台词为「这句太抽象，换成一个真实场景。」。替换为自己的短录音并保存结果：

```sh
uv run tools/asr/doubao_asr.py \
  --audio /absolute/path/to/recording.wav \
  --output output/asr/my-recording-result.json
```

支持 FFmpeg 可解码的 WAV、MP3 等格式，限制为非空且最长 60 秒。现有输出文件不会覆盖；每次保存结果请使用新的路径。

## 麦克风实时测试

在 MacBook Air 上使用内置麦克风收音 20 秒：

```sh
uv run tools/asr/doubao_asr.py --mic --device 'MacBook Air麦克风' --seconds 20
```

看到「麦克风已开启，请开始说话」后开始讲话，直接在当前终端查看「转写：……」。程序每 200 毫秒将刚采集的音频送给豆包，同时接收实时转写；20 秒后关闭麦克风，等待并显示「最终：……」。说完后请等待自动结束；Ctrl+C 是立即取消测试并释放麦克风，不会等待最终识别结果。`--seconds` 可设置为 1–60 秒。原始录音只在内存中处理；只有显式指定 `--output` 才把文字结果保存为 JSON。

每秒还会显示收音进度、本秒音量峰值、已发送音频包数和服务端响应数。峰值持续为 0 时可检查权限、输入设备或静音；峰值非零只能说明采集到信号，不代表一定包含清晰语音。收到响应也不等于已经识别出文字，以「转写」和「最终」行判断。中间文字可能修订，最终结果即使与上一条转写相同也会单独显示。

首次使用可能需要在 macOS 弹窗中允许运行程序的应用访问麦克风；若没有声音，可到「系统设置 → 隐私与安全性 → 麦克风」检查对应应用（例如 Codex 或终端）的权限后重新运行。

列出输入设备：

```sh
uv run tools/asr/doubao_asr.py --list-devices
```

可用 `--device` 指定设备编号或名称。不指定时使用系统默认输入；本次 Air 的系统默认输入是蓝牙设备 SRS-XB100，内置设备名为 `MacBook Air麦克风`，因此上面的命令显式指定内置麦克风。设备编号会随插拔变化，优先使用名称。

麦克风模式直接采集 16 kHz、16 bit、单声道 PCM，不依赖 FFmpeg。上述固定时长模式不启用 VAD，测试期间采集的音频会实时发送至豆包；需要本地语音检测时使用下面的 `--vad` 模式。本轮尚未加入回声消除或完整 Always On 会话管理。

## 本地 VAD 自动分轮

2026-10-11 已在 Air 接入 Silero VAD / ONNX Runtime。基础 ASR 的蓝牙麦克风真人试音已由用户确认通过；新 VAD 模式已用项目合成音频验证两轮自动识别，蓝牙真人 VAD 试音待执行。

```sh
uv run tools/asr/doubao_asr.py --mic --device 'SRS-XB100' --vad --seconds 60
```

60 秒内可以连续说几句话。检测到持续人声后才建立豆包请求；连续静音约 800ms 后结束本轮、打印最终文字，并继续监听。总测试时长结束时关闭麦克风；Ctrl+C 立即取消未完成轮次。该模式的 `--seconds` 支持 1–600 秒；单轮连续发言最长 45 秒，超限会取消测试并提示分段。

- 首次运行下载固定版本的约 2.3MB 模型，验证 SHA256 后缓存到 `~/.cache/opennova/silero-vad/`；随后在本地 CPU 推理。
- 模型使用 512 样本／32ms 窗口；麦克风目前仍按 200ms 采集块交付。约 300ms 起点前缓存避免漏首字，短暂停顿及尾部静音连续送入 ASR。
- 上行音频按约 200ms 分包。云端建连或上一轮收尾时仍继续采集，有界队列积压会显式失败，不悄悄丢词。
- 说话中思考容易被截断时，可试 `--silence-ms 1200`；`--vad-threshold` 默认 0.5，支持 0.1–0.9。参数需要真人噪声环境调节。
- `end_reason=silence` 表示自然停顿收尾；`input_limit` 表示到达测试时长，可能截断了发言，不能当成业务输入确认。

只看本地人声检测，不读密钥、不上传音频：

```sh
uv run tools/asr/doubao_asr.py --mic --device 'SRS-XB100' --vad-only --seconds 30
```

也支持 `--vad --audio /path/to/test.wav` 重放测试。两轮样例验证记录为 `output/asr/vad-two-turns-result.json`：9.537 秒音频触发两轮识别，正文均完整返回，最终标点有差异；本次每 32ms 窗口的平均 VAD 推理为 0.422ms。此数据不代表真人准确率或全天性能。

本轮不包含 AEC、设备指向判断、语义轮次或插话停播；VAD 会检测背景人声，不能保证只上传对助手说的话。模型依据：[Silero VAD](https://github.com/snakers4/silero-vad/tree/1e261b036686cd0017d500ee96acd1c4ba572a9d)。固定时长模式仍可通过省略 `--vad` 使用。

Silero 模型及 ONNX 状态／上下文适配依据上游 MIT 许可实现；版权与许可保存在 `LICENSE.silero`。

## 调用方式

- 固定使用双向流式优化接口 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`。
- 默认小时版资源 `volc.seedasr.sauc.duration`；只有已开通并发版时才使用 `--billing concurrent`。
- 转换成 16 kHz、16 bit、单声道 PCM，每 200 毫秒发送一段，同时接收转写。
- 开启 `enable_nonstream=true`：先返回流式文字，再进行二遍识别。中间结果可能修订，以最终结果为准。
- 沿用系统代理配置，包含 SOCKS 所需依赖；不修改系统网络设置。
- 服务端错误、断流、超时、没有最终消息或最终文本为空时返回非零退出码；不自动重试。

依据：[火山引擎实时语音识别接口](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh)。

## 结果含义

输出包含最终文字、请求 ID、服务端日志 ID、输入模式、音频时长、连接时间、首次出现文字的时间，以及最后一个音频包发送到最终结果的时间。麦克风模式另记录输入设备；`input_peak` 为输入 PCM 的峰值（0–32768），便于排查静音或权限问题。

`success=true` 表示接口连通并完成一次非空转写，不代表识别准确率达到某个指标。首次出字从连接成功并发送识别配置后计时，包含麦克风开启和积累首个音频包的时间；文件模式包含模拟采集的等待时间。收尾耗时从发送最后一包计时，并非从真人实际说完计时。

2026-10-11 的首次验证中，单遍识别漏掉了默认样例的前半句；服务端原始结果确认并非脚本拼接丢失。启用二遍识别后完整返回参考台词，另一个样例「已改写，请看这一处变化。」也在单遍对照中识别正确。单次记录只用于检查接入，不能代替真人录音、远场、噪声、否定和改口测试。

## 离线检查

```sh
python3 -m unittest discover -s tools/asr/tests -v
```

这些检查不调用云端，也不启动真实麦克风，覆盖凭据定位与脱敏、消息边界、错误帧、最终结果判断、转写修订、输出文件保护，以及麦克风数据分块、溢出、中止和资源释放。
