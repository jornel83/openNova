# OpenNova 语音 Demo Agent

使用 **DeepSeek Harness + GPT-6.1 Sol + OpenNova 独立 Sign in with ChatGPT 授权**。模型由官方 DevKit 调用，历史、会话和轮次由 Harness 管理。`worker.mjs` 通过 JSON 行协议提供 `ask → reply`，供 [语音客户端](../../tools/voice/README.md) 使用。

当前在 **MacBook Air** 执行，因为本机授权与 Keychain 存储已验证。Studio 仍负责 Vivian 推理；迁移 Studio 常驻 Agent 需要完成该机的独立授权和安全存储验证。

## 当前依赖和数据

| 项目 | 位置 / 版本 |
| --- | --- |
| Harness | 相邻目录 `../deepseek-harness`；用户仓库 `git@github.com:jornel83/deepseek-harness.git`，锁定 `v0.2.1-alpha.2` / `d743267388641bc76f17c45ce8b4c231aed1d32c`，pnpm `11.28.5` |
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
- `voice.patch.yml`：中文语音交互提示词，关闭 Bash、PowerShell、工作目录工具和自动重试；保留运行时所需的工作目录服务。
- `worker.mjs`：校验授权和模型权限，维持单个 Harness 会话，退出时清理子进程。
- `result.mjs`：只接受当前轮次完整结束且未被中断的已提交回复。
- `authorize.mjs`：独立 OpenNova 登录入口，已连接时不重新发起授权。

默认模式仍是文字对话适配，拒绝模型工具和图片输入。2026-10-13 新增的 `--web` 模式仅开放下面两种只读 Web 工具。视觉、文件和命令执行仍需另行接入。原轮流模式只朗读完整回复；默认持续模式按增量文本分句朗读；联网持续模式等待整轮完成后朗读。

## 联网工具桥接（2026-10-13）

```sh
python3.11 tools/setup/bootstrap.py --install --web
python3.11 tools/setup/bootstrap.py --check --web
OPENNOVA_PROXY=http://127.0.0.1:7897 /opt/homebrew/opt/node@24/bin/node tools/agent/chat.mjs --web
```

真实 Exa Key 放在 Git 忽略的 `config/secrets.local.json` 的 `web.exa_api_key` 字段；环境变量 `EXA_API_KEY` 优先。默认不启用工具，只有显式 `--web` 加载 Web patch。该模式需要密钥才能启动。CLI 支持 `/stop`、`/quit`；`--check` 只检查依赖、授权与运行时启动，不调用搜索。

- `patches/siwc/0001-stream-items.patch`：在官方 DevKit 的 authenticated 路径增加 `streamItems`，沿用刷新和 Keychain。按固定提交导出、应用补丁、npm 锁定安装及构建；产物位于 `output/deps/siwc/<revision>-<patch-sha>`，不修改原检出。没有向业务层暴露 token。
- `responses-protocol.mjs`：把允许的工具放进 `opennova` namespace，往返保留 call ID、结果、reasoning replay。只接收完成的输出；兼容订阅流的空 completed.output + output_item.done，截断、失败和取消不会提交可执行调用。
- `web.patch.yml`：加载 Harness 原生 Web / Exa / HTTP fetch / tool-web / timeout-policy。每轮最多 2 次搜索、3 次读取、6 次模型请求；每次搜索 1 个查询、最多 5 项，网页输出 12,000 字符。单次搜索 15 秒、读取 10 秒，从第一个 Web 工具启动至 Agent 完成最多 45 秒（包括工具间模型推理）、整轮 90 秒；不含 TTS。
- `web-policy.mjs`、`web-budget.mjs`：通过现有 control 插件注册 Harness hooks，原子计数、传播取消并清理定时器；不实现另一套 Agent 循环。
- `web-events.mjs`、`speech-text.mjs`：真实工具结果关联来源；同进程保留最近 100 项来源供追问。显示文本保留已核对的链接，播报文本去除链接、编号和代码块；搜索摘要与读取正文用 `retrieval` 区分。

JSONL ready 包含 `outputMode: incremental | settled-answer`。联网模式仅发送 `status{id,phase,step,toolCallId?}`、`sources{id,items}` 和最终 `reply{id,text,speechText,sources,sessionId}`，不发送工具循环中的正文 delta。错误与取消没有成功 reply。两条路径共享 ask / cancel / close 和会话管理。

显式探针：`node tools/agent/web_probe.mjs --protocol-only` 验证真实工具往返与取消后继续；`--live-web` 验证真实 Exa 搜索、读取及来源追问；`--fetch-only` 是不使用 Exa 的公开网页测试夹具，不代表真实搜索已通过。结果保存在 Git 忽略的 `output/agent/web-verification/`。详见[验收记录](../../docs/research/opennova-web-search-verification.md)。

## 持续对话桥接（2026-10-12）

`stream-worker.mjs` 为 `--continuous` 提供 `ask(id,text)` / `cancel(id)` / `close` JSONL 控制，输出 `ready`、`delta`、`reply`、`cancelled` 或受控 `error`。`delta` 含应用请求 ID 与 Harness attempt ID；最终结果仍通过 `completedReply` 校验，部分生成失败不会作为成功回复。

`stream.patch.yml` 加载 OpenNova 自有的 `voice-control.mjs` 插件，监听 Core 的 `agent/assistant-stream`，通过 `Agent.cancel()` / `whenIdle()` 结算取消。`voice-socket.mjs` 为每次进程建立当前用户独占的临时 Unix socket（目录 0700），退出清理。SDK 继续负责启动与提交；没有修改 Harness 上游或假定 SDK 有不存在的取消接口。

当前只允许一个活跃模型请求，日常插话取消后复用同一 Harness 会话。Python 保持独立 stdout 读取器，取消不阻塞本地音频控制；迟到增量和音频按请求 / 播放代次过滤。模型中途失败时，已显示文字保留，剩余播报取消，不自动从头重播。

真实固定版本验证：首个增量早于最终回复；取消后同一会话能回答并记住暗号。云端偶发过载仍可能导致单轮失败，取消成功不等于后续网络请求必然成功。所有 Agent 测试使用 `node --test services/agent/tests/*.test.mjs`。

2026-10-12：两轮真实 Harness 对话通过；持久化日志含两个 `user/message` 和两个 `assistant/message`，第二轮能回忆第一轮暗号。官方独立授权记录见 [验证文档](../../docs/research/opennova-chatgpt-subscription-verification.md)。

测试：`node --test services/agent/tests/provider.test.mjs`。调试可显式设置 `OPENNOVA_DEBUG=1` 查看本机 SDK 堆栈；正常运行只显示受控错误码。

## Harness 升级验证（2026-10-13）

本机从 `v0.1.6-alpha.2` / `ddefc45f` 快进到用户仓库 `origin/master` 的 `v0.2.1-alpha.2` / `d7432673`，使用 Node `24.14.1`、pnpm `11.28.5` 完成锁定依赖安装、清理旧产物和完整构建。

新版 `sdk-minimal` 默认注册 `working_directory` 工具，真实对话首先复现 `voice_demo_tools_disabled`。在 OpenNova 的 `voice.patch.yml` 中禁用 `tool-working-directory` 后通过验证；Harness 源码保持干净，适配器继续拒绝工具调用。

- `bootstrap.py --check` 通过；环境安装测试 1 项、Agent 测试 16 项、语音客户端测试 53 项通过。
- 真实 GPT 流式对话通过：收到文本增量后完成回复，增量拼接与最终提交文字一致。
- 生成中取消后，在同一会话继续提问，能回忆前一完整轮次的暗号；测试进程退出并完成清理。
- 原轮流模式的 `worker.mjs` 真实回复与进程清理通过。

本机验证记录位于 Git 忽略的 `output/setup/harness-upgrade-20261013/`。本轮验证覆盖 Agent 升级及相关回归，未重新进行麦克风 → ASR → Vivian 的现场听感测试。

## 环境重建

从仓库根目录运行 `python3.11 tools/setup/bootstrap.py --install`；`--check` 只检查依赖，不打开凭据。版本由 `config/runtime-versions.json` 固定，路径可在 Git 忽略的 `config/voice.local.json` 配置，详见[根目录说明](../../README.md)。Harness 源码从用户的 GitHub SSH 仓库获取，需要本机有相应访问权限。`keychain.swift` 已纳入源码；安装过程保留已有 helper 与授权数据。

已有 Harness 检出切换版本后，需使用新版本声明的 pnpm 安装锁定依赖并重新构建；bootstrap 只检查构建入口存在，不会按源码提交自动判定旧产物是否失效。本机 `origin` 指向用户仓库，`upstream` 保留官方仓库；旧提交由 `codex/baseline-0.1.6-alpha.2-20261012` 保留。回退代码时也必须重新安装与构建，不能混用不同版本的产物。
