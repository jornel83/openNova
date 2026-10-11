# OpenNova 完整语音对话 Demo

运行链路：**Air 本地 Silero VAD → 豆包流式 ASR 2.0 → DeepSeek Harness / GPT-6.1 Sol → Studio Vivian → Air 1.5 倍速播放**。

2026-10-12 已用两段测试录音跑通真实链路，两轮共用同一 Harness 会话；第二轮正确回忆第一轮的“蓝色水滴”。输入录音是 macOS 合成的测试句，VAD、云端 ASR、订阅模型推理和 Studio TTS 均为真实调用，没有录制用户麦克风。结果保存在 `output/voice/complete-loop-20261012/`。

## 开始交流

在 **MacBook Air** 的终端执行：

```sh
uv run tools/voice/conversation.py --device 'SRS-XB100' --output-device 'SRS-XB100'
```

看到“请说话”后开口。连续静音约 800 ms 后提交，终端显示识别文字、思考状态和回复；Vivian 回答结束后自动重新聆听。每轮最长发言 45 秒，默认最多 20 次聆听，每次最多 60 秒。`Ctrl+C` 退出并关闭收音、播放与本次 Agent 子进程。

这版采用轮流说话：思考和播报期间关闭麦克风，播放后等待 0.6 秒再开启，避免将外放语音再次识别。尚不支持边播报边插话或完整 Always On，也没有 AEC。当前只开放对话和上下文，文件操作、命令执行和模型工具调用明确关闭。

默认使用系统输出也可以：省略 `--output-device`。蓝牙设备断开或系统输入改变时，重新运行检查后再试。设备被 macOS 切换后的麦克风/扬声器实际效果仍需现场验证。

## 启动检查

```sh
uv run tools/voice/conversation.py --check --device 'SRS-XB100' --output-device 'SRS-XB100'
```

检查 VAD 模型、密钥格式、音频设备参数、TTS 服务可达性、独立 ChatGPT 授权与 Harness 启动；不录音，不发起 ASR 请求，不产生新模型回复。正式运行仍会消耗豆包识别用量和已授权的 ChatGPT 订阅额度。

当前依赖：Air 的 `uv`、Node 22.23.1、FFmpeg 7.1.1；Python 依赖由脚本固定。Agent 准备与存储位置见 [Agent 说明](../../services/agent/README.md)。豆包密钥读取 `DOUBAO_ASR_API_KEY` 或 Git 忽略的 `config/secrets.local.json`，不向日志输出。

Studio 需要运行 [TTS 服务](../../services/tts/README.md)。Air 的 `127.0.0.1:18000` 通过 SSH 转发到 Studio `127.0.0.1:8000`，本次已经建立；只有现有转发停止时才在另一终端运行：

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18000:127.0.0.1:8000 agent-control
```

## 验证与记录

文件测试不会打开麦克风：

```sh
uv run tools/voice/conversation.py \
  --audio output/voice/inputs/remember.wav \
  --audio output/voice/inputs/recall.wav \
  --no-play --output-dir output/voice/my-new-test
```

每个文件包含一个自然发言，并在尾部保留至少一秒静音；VAD 在第一处足够长的停顿处分轮。输出目录必须不存在。`--no-play` 仍会真实合成，只是不播放。默认不保存录音或回复音频；传入 `--output-dir` 才保存回复 WAV 和本轮测试报告。Harness 会按其会话机制在 Air 本地保存文字上下文；关闭脚本后再次启动会创建新会话。

本次实测：两轮 Agent 回复耗时 3.457 / 4.748 秒，随后 TTS 首段可播放音频就绪为 0.190 / 0.244 秒，回复音频为 3.156 / 2.937 秒（1.5 倍速）。这些是单次文件测试，不包含现场扬声器延迟。首版等待 Agent 完整回复后按句合成；后续可接入边生成文本边合成，以改善首句等待和跨句停顿。

错误时不以旧回复代替新回复，不自动切换模型或计费路径。达到录音上限而尚未自然结束的发言会取消，避免把被截断的问题交给 Agent。当前以终端为交互入口；浏览器界面、Studio 常驻 Agent、工具执行与插话属于后续阶段。
