# OpenNova 语音 Demo Agent

使用 **DeepSeek Harness + GPT-6.1 Sol + OpenNova 独立 Sign in with ChatGPT 授权**。模型由官方 DevKit 调用，历史、会话和轮次由 Harness 管理。`worker.mjs` 通过 JSON 行协议提供 `ask → reply`，供 [语音客户端](../../tools/voice/README.md) 使用。

当前在 **MacBook Air** 执行，因为本机授权与 Keychain 存储已验证。Studio 仍负责 Vivian 推理；迁移 Studio 常驻 Agent 需要完成该机的独立授权和安全存储验证。

## 当前依赖和数据

| 项目 | 位置 / 版本 |
| --- | --- |
| Harness | 相邻目录 `../deepseek-harness`，使用已有构建；本次实测提交 `ddefc45fbc7f8e46dd73185e68295696d1297887` |
| 启动方式 | 官方 SDK 启动 `dsh --profile sdk-minimal`，加载本目录 `voice.patch.yml`；不修改上游源码 |
| 官方 DevKit | `~/.local/share/opennova/siwc-devkit`，提交 `0a36fefeb913055c8c7a1a29b63d82b96b2e841a`；`@siwc/local` 已构建 |
| 凭据加密程序 | `~/.local/share/opennova/bin/siwc-keychain`；使用此前验证的 OpenNova Keychain 条目 `OpenNova.SIWC.Probe` |
| 独立注册与授权 | `~/.config/opennova-siwc-probe/`，沿用本次用户授权的 OpenNova 注册；凭据加密保存 |
| Harness 文字会话 | `~/.local/share/opennova/harness-home/sessions/`；不读取用户默认 Harness 配置 |

配置可通过 `OPENNOVA_HARNESS_ROOT`、`OPENNOVA_SIWC_ROOT`、`OPENNOVA_SIWC_STORAGE`、`OPENNOVA_KEYCHAIN_HELPER` 指定。`config/secrets.local.json` 中的豆包密钥不参与模型授权。不得读取或复用 Codex 的登录文件，也不自动使用环境中的其他模型 API Key。

```sh
node services/agent/worker.mjs --check
```

这只检查独立订阅授权和模型目录。完整语音入口还会启动 Harness 验证实际配置。账户授权失效时运行 `node services/agent/authorize.mjs`，打开终端显示的本机入口，在 OpenAI 页面本人登录；不循环注册或回退到另一计费账户。

## 范围与实现

- `chatgpt.mjs`：官方客户端和 Keychain 加密读写，凭据不进入 stdout。
- `provider-core.mjs`：把 Harness 完整文字历史投影为官方 DevKit 的消息；仅完整成功的模型响应可提交，失败时不提交部分文字。
- `provider.mjs`：外部 Cordis 模型插件，只注册 `opennova-chatgpt / gpt-6.1-sol`。
- `voice.patch.yml`：中文语音交互提示词，关闭 Bash、PowerShell 和自动重试。
- `worker.mjs`：校验授权和模型权限，维持单个 Harness 会话，退出时清理子进程。
- `result.mjs`：只接受当前轮次完整结束且未被中断的已提交回复。
- `authorize.mjs`：独立 OpenNova 登录入口，已连接时不重新发起授权。

此版本是文字对话适配，明确拒绝模型工具和图片输入；系统提示也告知模型没有执行工具。GPT 的视觉能力与未来工作工具仍需另行接入，不因模型本身支持就视为本 Demo 已实现。原轮流模式只朗读完整回复；持续模式按用户可见的增量文本分句朗读，不朗读推理、内部事件或错误堆栈。

## 持续对话桥接（2026-10-12）

`stream-worker.mjs` 为 `--continuous` 提供 `ask(id,text)` / `cancel(id)` / `close` JSONL 控制，输出 `ready`、`delta`、`reply`、`cancelled` 或受控 `error`。`delta` 含应用请求 ID 与 Harness attempt ID；最终结果仍通过 `completedReply` 校验，部分生成失败不会作为成功回复。

`stream.patch.yml` 加载 OpenNova 自有的 `voice-control.mjs` 插件，监听 Core 的 `agent/assistant-stream`，通过 `Agent.cancel()` / `whenIdle()` 结算取消。`voice-socket.mjs` 为每次进程建立当前用户独占的临时 Unix socket（目录 0700），退出清理。SDK 继续负责启动与提交；没有修改 Harness 上游或假定 SDK 有不存在的取消接口。

当前只允许一个活跃模型请求，日常插话取消后复用同一 Harness 会话。Python 保持独立 stdout 读取器，取消不阻塞本地音频控制；迟到增量和音频按请求 / 播放代次过滤。模型中途失败时，已显示文字保留，剩余播报取消，不自动从头重播。

真实固定版本验证：首个增量早于最终回复；取消后同一会话能回答并记住暗号。云端偶发过载仍可能导致单轮失败，取消成功不等于后续网络请求必然成功。所有 Agent 测试使用 `node --test services/agent/tests/*.test.mjs`。

2026-10-12：两轮真实 Harness 对话通过；持久化日志含两个 `user/message` 和两个 `assistant/message`，第二轮能回忆第一轮暗号。官方独立授权记录见 [验证文档](../../docs/research/opennova-chatgpt-subscription-verification.md)。

测试：`node --test services/agent/tests/provider.test.mjs`。调试可显式设置 `OPENNOVA_DEBUG=1` 查看本机 SDK 堆栈；正常运行只显示受控错误码。

## 环境重建

从仓库根目录运行 `python3 tools/setup/bootstrap.py --install`；`--check` 只检查依赖，不打开凭据。版本由 `config/runtime-versions.json` 固定，路径可在 Git 忽略的 `config/voice.local.json` 配置，详见[根目录说明](../../README.md)。`keychain.swift` 已纳入源码；安装过程保留已有 helper 与授权数据。
