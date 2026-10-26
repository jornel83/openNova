# 豆包云端 TTS 接入实施计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 办公室使用豆包云端 TTS，家中仍可使用 Studio / Vivian，通过参数或本机配置切换。

**Architecture:** Air 直接请求豆包语音合成 2.0 HTTP SSE，解码为现有播放器所需的 24kHz 单声道 PCM。复用保调变速、播放和取消链路；云端启动跳过 Studio / SSH。

**Tech Stack:** Python 标准库 urllib、SSE / Base64、FFmpeg、Node.js 启动器。

**Spec:** 本轮用户已确认的双后端方案：云端供应商改为豆包，使用已有本机 Key；自然女声，1.5 倍语速，保留 Studio 模式。

## Global Constraints

- 默认 `studio`；`doubao` 与别名 `cloud` 显式选择云端。CLI > 环境变量 > 本机配置。
- `seed-tts-2.0`、24kHz PCM、默认 `zh_female_vv_uranus_bigtts`；不把 Vivian 当成豆包音色。
- 密钥仅从本机忽略文件 / 环境变量读取，不写入参数、报告或 Git。
- 不自动开通付费服务，不自动切换后端；保留用户已有未提交工作。
- 云端预检合成“你好。”并丢弃音频以验证权限；不打开麦克风 / 扬声器。这会产生少量 TTS 用量。

## Review Focus

- HTTP 200 内的业务错误必须识别；当前账号返回 45000030，不能报告合成成功。
- SSE 拆包、非法 Base64、缺失终止帧、过大响应和半个 PCM 样本必须失败。
- 云端模式不能被离线 Studio 或占用的本地 TTS 端口阻塞。
- 插话取消必须关闭 HTTP / 子进程；保留服务端是否停止计算尚未验证的说明。
- 新音色、配置和错误需要贯穿入口、子进程和报告；旧 Studio 行为保持可用。

### Task 1: 云端适配器及播放器

Files: `services/tts/doubao.py`, `services/tts/settings.py`, `tools/voice/playback.py`, `services/tts/tests/test_doubao.py`, `services/tts/tests/test_settings.py`。

Interfaces: `stream_pcm(text, voice)` 上下文管理器返回 PCM 迭代器；`load_tts_key()` 读取专用或共享 Key；`load_settings()` 返回 provider / doubao_voice；`speak(..., provider='studio', voice=None)` 统一消费两种流。

- [x] 写协议、权限、凭据优先级及失败不泄露 Key 的测试；运行确认 RED。
- [x] 实现上述接口，保留音频上限、完整性检查与 1.5 倍速；运行 TTS / playback 测试确认 GREEN。

### Task 2: 对话与启动器

Files: `tools/voice/{start.mjs,conversation.py,continuous_run.py,tts_stream.py}`, 对应 tests，配置示例与 README。

Interfaces: `--tts-provider studio|doubao|cloud`, `--tts-voice SpeakerID`，`tts.provider` / `tts.doubao_voice`，`OPENNOVA_TTS_PROVIDER` / `OPENNOVA_DOUBAO_TTS_VOICE`。Worker 显式接收 provider / voice。

- [x] 写云端跳过 SSH / 本地端口、配置优先级、CLI 传递和取消测试，确认 RED。
- [x] 接入选择、权限预检、可理解的错误及真实音色报告；补充使用方法，确认 GREEN。
- [x] 运行完整 voice / TTS / launcher 回归并做独立代码评审；已有 Key 开通后验证真实云端样音。

## 执行记录

- 初次真实调用：HTTP 200，业务码 45000030，`requested resource not granted`，无音频。已请用户在同一应用开通语音合成 2.0。
- Ruling: 在当前目录实现，保留既有未提交的一键启动与 Bot 依赖；不提交混合工作。用户已确认方案，直接继续实施，不再次请求设计批准。
- 独立评审指出预检线程不能及时取消、CLI 不能覆盖无效低优先级 provider；已补充 RED → GREEN 回归并修复。云端预检改为可取消的独立合成进程；合并 CLI 后才校验 provider，Studio payload 不校验无关的后端选择。
- 用户开通后原 Key 实测成功：VV / 1.5 倍速，4.267 秒音频，首 PCM 0.646 秒，首变速 PCM 0.751 秒，总处理 1.650 秒。真实一键云端 `--check` 通过，未打开麦克风 / 扬声器。
- 现场待验收：云端音色偏好、长时间语音对话和真人插话听感；不属于自动测试可确认的结果。

- 后续用户试听反馈（2026-10-15）：豆包 VV 改为 1 倍原速，对话两种模式及独立播放默认同步；Studio Vivian 保留 1.5 倍。上文 1.5 倍云端指标为历史测试记录。
