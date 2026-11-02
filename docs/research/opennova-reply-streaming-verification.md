# OpenNova 回复速度与流式播报验收

更新：2026-11-03。开发与真实测速于 11 月 2 日开始，源码位于原 OpenNova 工程。未迁移或覆盖已有配置、授权、会话、记忆和浏览器 profile；性能测试使用独立临时 Bot 会话，结束后清理。

## 三个里程碑

1. **真实文字增量与共享事件流。** 现有 SIWC `onEvent` 向 OpenNova 提供增量旁路；模型消息明确标记 `phase=final_answer` 才能提前展示与播报。工具、commentary、压缩请求和无法判断的响应不提前朗读。Harness 的工具执行、历史提交与 `completedReply` 校验仍等待完整响应。
2. **稳定语句播报与有限预合成。** 网页和语音使用同一请求、attempt、revision；统一朗读文本投影去除链接、引用和代码，保留已有长回答摘要规则。优先完整短句，首段默认上限 80 字，后续 160 字，数字和小数不在硬边界拆开。当前句获得首 PCM 后最多预合成下一句，每个任务的 PCM 队列最多 8 × 4096 字节，继续服从原生播放器背压。
3. **生命周期、回退与验收。** 取消清理模型等待、TTS 客户端和预取队列；旧代次 PCM 不进入新轮。重试废弃旧草稿，已播内容不能静默重播；客户端在已有语音前缀被废弃时停止该轮。事件断线恢复同一请求的快照，不重新提交任务；失败或取消保留标为未完成的文字。真实模型/TTS、浏览器和自动回归证据如下。2026-11-03 真人试听已获用户确认；真实声学首声尚未进行仪器测量。

## 接口与实现位置

- `services/agent/response-preview.mjs` / `responses-protocol.mjs`：增量预览与完整工具响应分离；出现与最终回答标记矛盾的后续工具或消息时终止预览和该响应。
- `services/bot/reply-stream.mjs`：有界内存草稿，40 ms 节流，`reply.stream` 完整草稿快照。不会逐 token 写 SQLite。
- `services/bot/reply-speech.mjs`：实时稳定前缀与最终 `speechText` 共用规则，保留 600 字摘要策略。
- `/snapshot.replyStream`：网页重连快照；Bearer `/stream-snapshot`：语音请求快照与最终结果；Bearer `/events`：事件流。网页继续使用原 cookie/CSRF 的 `/web/events`，凭据边界不变。
- `tools/voice/bot_agent.py` / `bot_events.py`：能力协商、SSE、重连、片段去重和最终前缀核对。
- `tools/voice/continuous.py` / `speech_pipeline.py`：分句、当前句与下一句的合成及取消。
- `services/bot/web/reply-stream.mjs`：旧快照、重放事件、换代和最终结果的展示规则。

协议中 `streaming` / `settled` 是预览状态；请求是否成功始终由 `/result.status` 决定。取消、失败和重启中断不能仅凭已显示的文字变成成功结果。未知或混合工具响应自动使用完整回答路径。

## 软件时序

语音记录增加接受输入的 ASR final、模型首段、语音前缀、TTS 首 PCM、播放器入队、原生首个已播放块回执和完成时间。后端记录模型请求、首个原始文本事件、首个草稿、首个可朗读前缀及模型/Bot 完成时间。

不同进程分别使用单调时钟或主机毫秒时间；先在各自时钟内计算时长，不跨时钟直接相减。`input_ended_at` 是 VAD 收尾点，包含停顿判定的影响；`dataPlayedBack` 回执表示首个音频块已经完成播放，不等于测得扬声器开始出声。状态提示音不计入有效答案首 PCM。

## 真实模型与 TTS 对照

使用同一组固定提示，分别运行 `settled` + 关闭预合成、`streaming` + 开启预合成。两种模式均使用本次分句器，因此是模式对照，并非逐字节复现旧版本。每例采用全新临时 Bot，读取既有模型授权；没有写入日常会话。TTS 音频流通过有界、按实际 PCM 时长消费的模拟播放器，不打开麦克风或扬声器，不包含 ASR。

以下是**提交文本到首段可播放 PCM**的秒数，不是实际首声、稳定 P95 或性能承诺：

| 场景 | 完整回答模式 | 增量模式 | 增量首 PCM 相对本轮回答完成 |
| --- | ---: | ---: | --- |
| 豆包长回答，第 1 组 | 10.330 | 6.504 | 提前 2.987 秒 |
| 豆包长回答，第 2 组（交换顺序） | 8.853 | 5.185 | 提前 3.856 秒 |
| Studio Vivian 长回答 | 8.880 | 4.580 | 提前 3.318 秒 |
| 豆包读取本地文件后解释 | 11.736 | 11.098 | 提前 0.746 秒 |
| 豆包一句话短回答 | 4.534 | 5.599 | 晚于完成 0.169 秒 |

短回答样本没有变快：两次模型完成分别约 3.985 / 5.430 秒，模型本身波动占主要差异，且一句话通常接近完成时才有稳定语句。本次两组豆包长回答平均首 PCM 为 9.591 / 5.845 秒，只代表这组小样本。各例模拟播放均未观察到超过 20 ms 的断供，旧模式也没有断供，因此本次不能量化预合成对实际句间听感的改善；有限预取及慢服务衔接另由自动测试验证。

记录位于本机忽略目录：

- `output/reply-latency/2026-11-02-doubao-long-v3/`
- `output/reply-latency/2026-11-02-studio-long/`
- `output/reply-latency/2026-11-02-doubao-tool/`
- `output/reply-latency/2026-11-02-doubao-short/`

重复测速（真实模型和 TTS 会产生用量；请使用 Node 24）：

```sh
node scripts/benchmark-replies.mjs --run --provider doubao --case long --mode both --repeats 2
node scripts/benchmark-replies.mjs --run --provider studio --tts-url http://127.0.0.1:18000 --case long --mode both
```

省略 `--run` 只显示说明。`short` / `long` / `tool` / `all` 控制固定用例；`--output` 必须为新目录。脚本创建独立临时工作目录、令牌与 Bot 数据，最后停止子进程并清理。Studio 需要已有可用连接；测速脚本不会自动改动日常服务。

## 浏览器与异常验证

Playwright 使用实际网页、认证 SSE 和 bundled Harness/Bot，通过可控模型响应验证：完整生成前显示首句、生成中刷新接续、最终结果替换草稿、停止后保留部分文字、失败后刷新仍显示未完成结果；控制台无错误或警告。证据在 `output/playwright/reply-stream/ui-verification.json` 及同目录截图。

自动回归覆盖完整结果一致性、逐字符 Markdown/链接/数字、未知 phase、工具混合响应、503 重试时不重复执行已完成工具、客户端取消阻止后续重试、晚到 PCM、预合成有界、SSE 分块 UTF-8、失效 cursor、快照瞬断、宿主重启和数据持久化。

最终验证：

- `pnpm run build` 完成；`pnpm run doctor` 显示 `build.ready: true`。
- `pnpm test`：428 项 Node + 185 项 Python，共 **613 项通过**，其中语音 123 项。
- `pnpm run test:bot`：**517 项通过**。
- `pnpm run audit:sources`：`independent: true`，0 gitlinks。
- 日志：`output/reply-latency/final-build.log`、`final-tests.log`、`final-upstream-tests.log`。
- 原工程通过 `pnpm start -- --no-ui` 实际启动，健康状态为 `ready: true`、`outputMode: hybrid-stream`，工作目录正确。启动前后本机配置摘要、Bot 身份、197 条原有操作/请求记录及记忆文件摘要完全一致。验证后停止该测试宿主，恢复测试前的未运行状态；证据在 `output/reply-latency/startup-preservation.json`。

早期一次回归与清理产物的完整构建重叠，导致运行时入口暂时不存在；该结果未计为通过。最后采用完整构建结束后再运行全量回归，以上为最终结果。测速脚本的两次早期启动失败也保留在 `doubao-long` / `doubao-long-v2`，修复隔离运行时的 resolver 环境后，`v3` 的四轮均完成。

## 真人试听（2026-11-03）

用户确认方便试听后，使用原工程 `./start.command --tts-provider doubao` 启动。已有浏览器配对和双窗口正常恢复；健康状态为 `hybrid-stream`，原生音频使用 SRS-XB100 输入与输出，Voice Processing 开启。

用户进行了真实语音交流和长回答试听，运行日志记录到有效输入、提前显示回答及确认插话后取消旧播报。用户对声音、打断和追问接续的反馈为：“声音正常，打断及时，追问接续正常。”据此，本轮目标设备的主观听感验收通过。

试听结束后退出本次语音进程，关闭收音，保留文字窗口和 Bot。未保存原始麦克风录音。此项为现场功能与主观听感确认，不等于测得声学首声、打断延迟或稳定 P95；前面的软件时序仍按原测量口径解释。

## 启用与回退

默认入口和配置不变：

```sh
./start.command --tts-provider doubao
```

更新代码并构建后，先结束当前任务、在语音终端 `/quit`，再停止旧 Bot 并重启，避免复用旧进程：

```sh
pnpm start -- --stop
./start.command --tts-provider doubao
```

完整回答与串行合成回退：

```sh
pnpm start -- --stop
OPENNOVA_REPLY_MODE=settled OPENNOVA_TTS_PREFETCH=0 ./start.command --tts-provider doubao
```

`OPENNOVA_REPLY_MODE` 由 Bot 启动时读取，`OPENNOVA_TTS_PREFETCH` 由语音进程读取；复用已有进程不会切换模式。已配对窗口、授权身份、会话和记忆位置不变。没有自动修改声音、语速、VAD 阈值或默认模型。
