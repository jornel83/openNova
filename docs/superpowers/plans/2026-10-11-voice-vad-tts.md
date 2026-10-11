# VAD 与 Studio TTS 实施计划

> 执行方式：本会话按 executing-plans 执行；保留现有用户文件，不提交含凭据的根 README。

**Goal:** 在已跑通的 ASR 客户端接入本地 VAD，同时部署 Studio 的 Qwen Base 推理环境。

**Architecture:** Air 保持实时采集，Silero ONNX 检测人声；每轮独立连接豆包，连续保留停顿和尾部静音，结果逐轮显示。Studio 单独安装固定 MLX-Audio 与模型，先生成 WAV，再验证本机 HTTP 服务和 Air 取回音频。

**Tech Stack:** Python / uv、ONNX Runtime、Silero VAD、Doubao WebSocket、MLX-Audio、Qwen3-TTS-12Hz-1.7B-Base。

**Spec:** `docs/research/opennova-mvp-development-deployment.md`、`docs/research/opennova-voice-pipeline-design.md`，以及用户认可的 VAD＋ASR / TTS＋播放两个小闭环。

## Global Constraints

- VAD 在 Air 本地 CPU 运行；TTS 仅在 Studio 运行。Spark 不参与。
- 不输出凭据；参考录音、权重和生成音频不加入 Git。
- 保持现有文件和固定时长麦克风测试入口；新增 `--vad`。
- 无人声不建立 ASR 请求；声音起点前缓存约 300ms，默认连续静音 800ms 收尾，可调。
- VAD 窗口为 512 samples / 16kHz；上行合并为约 200ms 音频包。
- 有界缓存；断网、积压、过长发言不静默丢数据；Ctrl+C 关闭麦克风和连接。
- 首轮不实现 AEC、指向判断、语义轮次或完整 Always On。

## Review Focus

- 首字缓存和短暂停顿必须保留，不能拼接不连续的人声片段。
- 纯静音不能调用云端；多轮音频不能交叉或重复提交。
- 建连和最终结果等待期间仍采集；网络积压必须显式失败。
- 录音时长上限与自然停顿收尾要分别记录。
- TTS 目标录音尚待用户提供路径；已有合成素材仅用于部署冒烟测试。

## Task 1: VAD + ASR

Files: `tools/asr/vad.py`, `tools/asr/doubao_asr.py`, `tools/asr/tests/test_vad.py`, `tools/asr/README.md`.

- [x] 写首字缓存、停顿、多轮、纯静音和上限测试，先观察失败。
- [x] 下载固定 Silero ONNX，验证 SHA256，实现本地推理和流式分段。
- [x] 扩展 ASR 输入接口，加入有界音频队列和多轮控制；保持原入口。
- [x] 用项目已有合成音频组成多轮样例，实测 VAD + 豆包；不擅自开启真人麦克风。
- [x] 更新用户运行命令与验证记录。

## Task 2: Studio TTS

Files: `services/tts/pyproject.toml`, `services/tts/uv.lock`, `services/tts/README.md`, scripts as needed.

- [x] 固定部署文档的 MLX-Audio commit 与 BF16 模型 revision，在 Studio 建立 Python 3.12 环境。
- [x] 下载模型，使用已有中文合成素材作为明确标记的冒烟参考，真实生成音频。
- [x] 测量首声、生成时间与音频时长；验证回环 HTTP 服务与 Air 取回音频。
- [ ] 用用户指定参考录音验证目标音色；若录音路径尚未提供，明确保留此项待办。

## 执行记录

- 已核实：Studio `agent-control` 可连接，uv 0.12.19、Python 3.12.14 可用，约 350GiB 空间；无既有 TTS 目录或 8000 监听服务。
- Ruling: 在当前工作区新分支继续，保留用户未跟踪的脚本与文档；不迁移/覆盖整仓、不自动提交，以确保既有运行命令继续可用。
- Task 1 complete: `python3 -m unittest discover -s tools/asr/tests -v` 26 项通过；真实 ONNX＋豆包双轮样例成功，结果 `output/asr/vad-two-turns-result.json`。真人 VAD 试音留待用户执行。
- Task 2 deployment complete: 固定模型实际加载，Python 两次合成成功，HTTP PCM 经 SSH 回传 Air 两次成功；常驻开发服务绑定 Studio 127.0.0.1:8000，Air 18000 转发已建立。未配置自动启动，未自动播放声音。
- Ruling: 目标录音路径尚未提供，使用现有合成女声作为部署验证参考；不能据此判定目标音色通过。播放探针已提供，现场播放、打断与生产播放器仍待后续。
- Independent review: 只读复核 VAD 资源释放与队列、PCM 格式、HTTP 错误传播；26 项测试独立重跑通过，未发现 P1/P2 缺陷。
