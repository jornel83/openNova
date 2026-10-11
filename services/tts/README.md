# Mac Studio 本地 Qwen3-TTS

2026-10-12：已切换为 **Qwen3-TTS-12Hz-1.7B-CustomVoice / Vivian**。默认 HTTP 请求沿用已选样音的温柔、自然、放松聊天语气，Studio 合成并流式回传 Air 已通过。服务已加载 CustomVoice；Base 已从服务模型缓存卸载，磁盘权重继续保留。

用户随后选择加快到 **1.5 倍速**：Air 测试客户端默认对 PCM 做保持音调的流式变速，保存的 WAV 与 `--play` 播放都使用调整后的声音。Studio 的原始生成语气与模型配置保持不变。现已接入 [完整对话 Demo](../../tools/voice/README.md)，共享同一 Vivian 请求配置；两轮文件输入闭环通过。

2026-10-11 的 Base 克隆部署基线保留在本页后半部分，其参考为 macOS Tingting 合成声音。当前下载脚本与 HTTP 探针默认使用 Vivian；传入 `--voice-profile base` 可显式选择 Base。真人参考录音不是 Vivian 接入的前置条件。

## 已选音色 Vivian

- 模型：`mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16`；revision：`52f4770fd9726457eae3d3b6aa92047a25a10776`。
- Studio 权重：`~/AgentWorkstation/models/opennova/qwen3-tts-1.7b-customvoice-bf16/52f4770fd9726457eae3d3b6aa92047a25a10776/`。
- 音色参数：`voice=Vivian`，`lang_code=Chinese`。使用 CustomVoice 原生预设，不传 Base 的 `ref_audio` / `ref_text`。
- 语气指令：“用温柔、自然、放松的日常聊天语气说话，语速适中，停顿自然，像在和身边熟悉的人交流。”
- [已选样音](../../output/tts/female-voice-auditions/vivian.wav)与[完整生成参数](../../output/tts/female-voice-auditions/manifest.json)：24kHz 单声道，12.24 秒；此次使用非流式合成，不能作为 Vivian 首包延迟基线。
- 实时请求采用同一音色、语气指令与采样参数：`temperature=0.9`、`top_p=1.0`、`top_k=50`、`repetition_penalty=1.05`；`stream=true`、`streaming_interval=0.32`、`max_tokens=1200`。完整请求随输出 JSON 保存。随机生成与流式解码不保证和原试听 WAV 逐样本相同。

## 部署位置与版本

- SSH 主机：`agent-control`（Mac Studio）；工程：`/Users/nova/Documents/project/openNova/services/tts`。
- Python 3.12.14；MLX-Audio 固定提交 `e66ad2ff4eb96ce1149000187b30370cbcd707aa`，所有解析依赖记录在 `uv.lock`；实装 MLX 0.32.3、MLX-Audio 0.5.8。
- 默认模型：上述 CustomVoice / Vivian 固定快照，首次请求时加载，后续复用。
- 克隆备选：`mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16`，revision `a6eb4f68e4b056f1215157bb696209bc82a6db48`；权重保存在 `~/AgentWorkstation/models/opennova/qwen3-tts-1.7b-base-bf16/<revision>/`。
- 参考：`~/AgentWorkstation/artifacts/opennova/voices/`；样音：`~/AgentWorkstation/artifacts/opennova/tts-runs/`。
- 开发服务仅监听 Studio `127.0.0.1:8000`，每批最多一个请求，使用离线模型路径；尚未配置重启后自动运行。
- 日志：`~/AgentWorkstation/logs/opennova/tts/`。当前开发进程信息记录在 `dev-service.json`，日志尚未配置轮转。

## 安装与启动

在 Studio 工程目录：

```sh
uv sync --locked --python 3.12.14
uv run --locked python download_model.py
sh serve.sh
```

服务已在本次验证中启动；不要重复启动占用 8000 的第二个实例。`serve.sh` 前台运行，Ctrl+C 可停止；进程已启动不代表模型预热完成，首次真实合成后模型留在服务内。

Air 访问使用 SSH 转发。在独立终端保持以下命令运行：

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18000:127.0.0.1:8000 agent-control
```

本次验证已建立一个相同转发；若提示 18000 已占用，先确认现有转发，无需重复启动。服务尚无产品级认证或设备接入，仅用于本机／SSH 开发验证。

## 在 Air 请求与试听

从 OpenNova 仓库根目录运行，默认使用 Vivian：

```sh
uv run services/tts/probe_http.py --text '你好，我们可以开始今天的工作了。' --output output/tts/my-vivian-test.wav --play
```

`--play` 使用 Air 的系统默认输出，边接收边播放；省略它只保存音频。输出文件必须是新的路径，旁边另存 JSON 指标。此脚本是播放开发探针，没有正式播放器的打断、播放代次、抖动缓冲与进度协议；本轮未自动开启扬声器，现场试听和输出设备延迟仍待验证。

`--speed` 默认 `1.5`，可在 `0.5–2.0` 范围调整；`--speed 1` 保留原速与原始 PCM。变速依赖**运行客户端的电脑**上可调用的 FFmpeg，Air 已有 7.1.1；不要求 Studio 推理进程安装 FFmpeg。当前 Qwen / MLX 后端的数值 `speed` 参数尚未实现，因此客户端使用连续的 [FFmpeg atempo](https://ffmpeg.org/ffmpeg-filters.html#atempo) 处理整条流，不逐块单独变速，也不通过提高采样率改变音调。

1.5 倍速验证：原试听 17.680 秒调整为 11.771 秒，[试听对照](../../output/tts/vivian-http-warm-1.5x.wav)。另一次真实流式请求原音频 12.960 秒，调整后 8.643 秒；原始首包 0.225 秒到达，变速后首段可播放 PCM 在 0.226 秒就绪，总接收及处理 3.175 秒。此结果不含扬声器延迟；完整记录见 `output/tts/vivian-http-speed-1.5.json`。测试覆盖时长比例、440Hz 音调保持、输入尚未结束时持续输出、异常清理，以及原速直通。

需要 Base 克隆时显式传入 `--voice-profile base`；自定义参考需同时提供 `--reference`（**Studio 上的 WAV 绝对路径**）和 `--reference-text`（准确转写）。不提供两项时使用旧部署测试素材。Vivian 模式会拒绝参考录音参数，避免静默忽略。先挑选几秒到十几秒的干净片段；本轮不训练。

接口使用 `POST /v1/audio/speech`，`stream=true`、`response_format=pcm`，当前固定模型返回 **24kHz / 单声道 / signed 16-bit little-endian**。上游的流式 WAV 会为各块单独编码，不能当作一个普通 WAV 直接拼接；探针接收 PCM 后封装为一个 WAV。

当前接口没有独立的产品轮次、文本完成和播放完成协议。成功接收非空音频只证明本次音频响应有效；完整朗读、音色和自然度仍要试听。首段音频到达不等于实际出声，`--play` 的总时间还包含播放阻塞。

## Vivian 流式实测 2026-10-12

通过既有 SSH 转发调用 Studio HTTP 服务，返回 24kHz 单声道 PCM。以下保留切换音色时的**原速**单次请求记录，首段到达时间不含设备播放延迟，也不是 P95；后续默认 1.5 倍速的记录见上文。

| 请求 | 首段到达 Air | 总接收时间 | 音频时长 |
| --- | --- | --- | --- |
| 切换后首次聊天文本 | 0.466s | 3.492s | 13.280s |
| 同文本再次生成 | 0.381s | 4.350s | 17.680s |
| 长文复测，1200 Token 上限 | 0.266s | 10.135s | 42.720s |

旧 600 Token 上限在首次长文测试中生成了 48 秒音频，回转写缺少末尾“和日常陪伴”；Vivian 默认上限已提高到 1200。HTTP PCM 接口不返回模型的结束原因，成功返回音频仍不能单独证明完整朗读，正式对话需按语义分段并继续检查漏读与重复。

复测音频经豆包 ASR 回转写包含完整尾句“工作协同和日常陪伴”。`Mac Studio` 的转写出现专名偏差，短样音转写也出现额外语气词；不能仅凭 ASR 断定是发音还是识别问题，中英混读与语气细节仍需人工试听。

断流测试：收到首个 4096 字节后关闭响应，立即提交下一条请求，0.159 秒后收到新音频，新请求正常完成。本测试证明断流后的服务可继续使用；不代表麦克风插话、本地立即停播或 GPU 停止计算时延已经验证。

结果见 `output/tts/vivian-http-first.*`、`vivian-http-warm.*`、`vivian-http-long-retest.*` 与 `vivian-http-after-disconnect.*`；`vivian-http-long.*` 保留首次触及长度上限的记录。原始试听记录继续保留在 `output/tts/female-voice-auditions/`。

## Base 历史基线 2026-10-11

测试文本：“你好，OpenNova 的本地语音合成已经启动。接下来，我们一起完成语音助手。”使用约 5.5 秒已有合成女声作为参考。以下仅为单次基线，不是 P95 或性能承诺。

| 路径 | 首段音频 | 总生成／接收时间 | 音频时长 | 说明 |
| --- | --- | --- | --- | --- |
| Python 新进程第 1 次合成 | 5.057s | 6.652s | 7.040s | 模型另加载 2.103s；包含首次计算准备 |
| 同 Python 进程第 2 次合成 | 0.097s | 1.588s | 6.720s | RTF 0.236，22／21 块的流式输出 |
| 新 HTTP 服务第 1 次请求 → Air | 1.879s | 3.503s | 7.040s | 含服务侧加载及 SSH 传输；不含实际播放 |
| 同 HTTP 服务第 2 次请求 → Air | 0.214s | 1.793s | 6.800s | 模型常驻；不含实际播放 |

Python 实测 MLX 峰值分配约 4.815GiB，不是整个进程或系统总内存。新进程与新 HTTP 服务的缓存状态不同，不能将两项首段耗时直接视为同一冷启动指标。

生成音频重新经过豆包 ASR 检查：中文正文返回完整，品牌名 `OpenNova` 在最终转写中被改为 `OpenNMT`，不能仅据此判断是 TTS 发音还是 ASR 专名识别问题，需人工试听确认。

Air 结果：`output/tts/studio-smoke-metrics.json`、`studio-http-cold.json`、`studio-http-warm.json` 及同名 WAV。重新做 Python 基线可在 Studio 运行 `smoke.py --reference ... --reference-text ... --output-dir <新目录>`，它会在同进程生成两次并保存测量。

## 仍需完成

- Vivian 多轮中文、长句及中英混读的听感与稳定性；Base 真人声音克隆按后续需要准备录音并单独验证。
- 用户已反馈真人输入下完整链路可运行；仍需较长时间的连续交流与异常恢复验证。
- 用户插话时 Air 立即停播、旧音频过滤、服务端取消和资源回收。
- 外放 AEC、持续运行、服务重启恢复和日志轮转。

上游依据：[MLX-Audio Qwen 实现](https://github.com/Blaizzy/mlx-audio/tree/e66ad2ff4eb96ce1149000187b30370cbcd707aa/mlx_audio/tts/models/qwen3_tts)。

## 机器路径配置

服务端下载目录和日志目录使用 `config/voice.local.json` 的 `tts.data_dir`（或 `OPENNOVA_TTS_DATA_DIR`），默认 `~/AgentWorkstation`。Air 客户端需要填写 **Studio 上的绝对路径**，HTTP 请求会使用该路径定位服务器模型。客户端地址通过 `tts.url` / `OPENNOVA_TTS_URL` 设置，命令行 `--url` 优先；完整对话入口使用 `--tts-url`。`serve.sh` 从 PATH 查找 uv，也可用 `OPENNOVA_UV` 指定。音频和指标的 `output/` 链接指向本机实验文件，未纳入 Git。
