# OpenNova 联网搜索开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 此计划按当前会话内顺序实施设计，不主动启动并行子代理。

**Goal:** 复用 Harness 原生搜索与网页读取，让 OpenNova 持续语音 Demo 能查询、引用公开资料，并能在检索中取消。

**Architecture:** Harness 负责工具循环和会话，OpenNova 负责 GPT 订阅协议适配、有限 Web 工具配置，以及终端 / 语音展示。先以本地只读测试工具验证协议，再接 Exa 与公开网页，最后适配语音生命周期。

**Tech Stack:** Node 24、Python 3.11+、DeepSeek Harness 0.2.1-alpha.2、现有 Sign in with ChatGPT DevKit、Exa、现有豆包 ASR / Silero VAD / Vivian / FFmpeg。

**Spec:** [联网搜索设计](../specs/2026-10-13-agent-web-search-design.md)。方案基于已讨论的接入路线，细节为本次计划建议；任务均未开始。

## 阶段和依赖

| 阶段 | 对应任务 | 可独立验收的结果 | 进入条件 |
| --- | --- | --- | --- |
| M1 工具协议打通 | T1、T2 | GPT 能通过 Harness 调用本地只读测试工具，并根据返回值回答 | 现有独立订阅授权有效；不需要 Exa Key |
| M2 文字联网可用 | T3、T4 | 查询、读取网页、展示来源、追问及取消可用 | M1 通过；真实搜索前配置 Exa Key |
| M3 语音联网可用 | T5 | 持续收音 → 搜索 → Vivian；状态提示和插话正常 | M2 通过；Studio Vivian 可达 |
| M4 交付新版本 | T6 | 回归记录、现场测试方法、启动和回退说明 | M3 通过，已区分自动化与人工验证 |

T1 → T2 是主要技术风险；在它通过之前，不把“官方支持”写成“OpenNova 已实现”。每个任务完成一个可复查的本地提交；不推送远程、不创建新的外部账号。新增功能采用 `--web` 显式启用，旧命令继续可用。

## Global Constraints

- Harness 固定 `d743267388641bc76f17c45ce8b4c231aed1d32c`（0.2.1-alpha.2），pnpm 11.28.5；Air 使用 Node 24，Python 3.11+。
- 模型固定 `gpt-6.1-sol`；保留 OpenNova 独立授权、刷新机制和 Keychain，不读取 Codex 凭据，不引入自动付费回退。
- 复用 Harness Web 插件；不改 Harness 上游源码，不在 Python 或 provider 内另写 Agent 循环。
- DevKit 基线保持当前版本清单；通过受版本控制的小补丁和隔离构建增加事件接口，不能留下只在本机存在的依赖修改。
- 首版仅 `web_search`、`web_fetch`；每轮最多 2 次搜索、3 次抓取、6 次模型请求；单次 1 个查询 / 5 个来源，单页模型输出最多 12,000 字符。
- 搜索 15 秒、单页 10 秒、检索累计预算 45 秒、Agent 轮次上限 90 秒；超时、取消和迟到结果都受当前请求 ID 约束。
- `--web` 使用完整最终答复确认后的分句合成；默认文字模式保留增量播报。Vivian 和 1.5 倍保调语速保持原配置。
- 实际搜索开始后等候 2 秒仍未结束时，至多播一次“我查一下，稍等。”；提示不计入最终回复。
- 仅开发持续模式和文字验证入口的联网；原轮流模式传 `--web` 时明确拒绝，不静默改变含义。
- 不修改已有未提交的 Harness 升级结果，不触碰无关 `skills/`、`tools/video/`；日志和测试生成物留在 Git 忽略的 `output/`。

## Review Focus

- T1 / T2：文字成功而工具不受支持、部分 SSE、工具参数分片、缺失 call ID；应报告失败且不执行残缺调用。
- T3：当前 worker 过滤环境密钥、搜索代理与抓取代理行为不同；密钥应仅到搜索插件，TTS 仍走现有路由。
- T4 / T5：多模型步骤混入工具前说明、引用跨片段、同轮 attempt 改变；不能误播原始资料或把正常续答判成重试。
- T4 / T5：取消发生在搜索、抓取、模型续答、提示播报之间；旧结果不能污染新轮次，原会话应可继续。
- T6：普通闲聊、中文时效性问题、空搜索、网页拒绝访问、蓝牙切换；分别验证检索选择、可核验结果和原语音行为。

## 文件与接口分工

下面带“新增”的路径是计划落点，不表示文件已经实现。

| 位置 | 责任 |
| --- | --- |
| `patches/siwc/0001-stream-items.patch`（新增） | 为固定 DevKit 增加原始 Responses 事件接口，保留原文字接口和授权管理 |
| `tools/setup/build_siwc_overlay.py`（新增）、`bootstrap.py` | 用固定源与补丁生成可复现产物，检查版本、补丁哈希与导入 |
| `services/agent/chatgpt.mjs`、`settings.mjs` | 按模式加载原客户端或扩展客户端；不向业务层暴露 access token |
| `services/agent/responses-protocol.mjs`（新增）、`provider-core.mjs`、`provider.mjs` | 工具定义 / 消息 / Responses 事件与 Harness chunk 的转换 |
| `services/agent/web.patch.yml`、`web-config.mjs`、`web-budget.mjs`、`web-policy.mjs`（新增） | Web 插件组合、配置、密钥、次数 / 时间预算 |
| `services/agent/web-events.mjs`（新增）、`voice-control.mjs`、`stream-worker.mjs` | 工具状态、来源、最终答复和取消的统一桥接 |
| `services/agent/speech-text.mjs`（新增） | 最终文字的播报投影；去除引用、链接和 Markdown，展示文本保留 |
| `tools/agent/chat.mjs`、`tools/agent/web_probe.mjs`（新增） | 无麦克风的文字入口及显式工具验证入口 |
| `tools/voice/conversation.py`、`continuous_run.py`、`stream_agent.py`、`continuous.py` | CLI 模式、扩展事件、提示与最终答复播放 |
| `config/*.example.json`、Agent / Voice README、部署文档 | 本地配置模板、安装检查、启动和回退说明 |

## 执行准备

- [ ] 开始功能代码前建立合适的隔离工作区，带入已验证的 Harness 升级配套改动；记录起始提交和差异。后续集成复核用户工作区，保留其间新增内容，不触碰无关目录。
- [ ] 确认本轮采用的设计取舍，尤其是 Exa 后端和 `--web` 完整答复后播报；本文任务划分不表示这些细节已实测或已实现。

### T1 订阅客户端增加工具事件接口

**Files:** 新增 DevKit 补丁、`build_siwc_overlay.py`、`tools/setup/tests/test_siwc_overlay.py`、`services/agent/tests/siwc-items.test.mjs`；修改 `bootstrap.py`、`settings.mjs`、`chatgpt.mjs`。补丁只涉及 DevKit `packages/local/src/{types,index,responses}.ts` 及新增测试文件。

**Interfaces:** 扩展客户端新增 `streamItems({model,input,instructions?,tools?,signal?,onEvent?}) → Promise<{output}>`；input / output / tools 使用固定 OpenAI SDK 的 Responses 类型。`createClient({capabilities:'text'|'tools'})` 返回具有相应接口的客户端，默认 `text`。保留现有 `streamResponse`、`getSession`、`listModels`。

- [ ] 写失败测试：namespace 工具定义原样送达、工具参数事件和最终 output item 不丢失；失败 / incomplete / 缺少 completed 时必须拒绝。断言请求始终 `store:false`、`stream:true`，不携带订阅不支持的状态字段。
- [ ] 运行 `node --test services/agent/tests/siwc-items.test.mjs`，确认 RED 来自扩展接口缺失。
- [ ] 增加上述接口，在 DevKit 的 `authenticated` 内执行请求；调用方不能直接取得 token。`onEvent` 异常应取消连接，底层错误使用现有脱敏方式。
- [ ] 实现 `build_overlay(source_root, patch_path, output_root) -> Path`：按固定 Git 提交导出干净源码、应用补丁、锁定安装与构建；源检出及授权目录不变。产物位于 `output/deps/siwc/<revision>-<patch-sha>/`，清单记录源提交、补丁 SHA-256；以临时目录完成后原子替换。
- [ ] 为 `bootstrap.py` 增加可选 `--web`：安装扩展或只读检查扩展清单、完整构建入口；默认路径仍只要求原依赖。避免当前 `ensure_repo` 把生成目录误当成上游 Git 检出。
- [ ] GREEN：上述 Node 测试及 `python3.11 -m unittest discover -s tools/setup/tests -q`；验证重复安装复用、补丁变化重建、构建中断不留下假成功产物。
- [ ] 完成局部提交，建议信息 `feat: add reproducible SIWC tool event support`。此时不切换默认语音模式。

### T2 GPT 与 Harness 工具协议往返

**Files:** 新增 `responses-protocol.mjs`、`services/agent/tests/responses-protocol.test.mjs`、`tools/agent/web_probe.mjs` 及只读测试工具夹具；修改 `provider-core.mjs`、`provider.mjs`。

**Interfaces:** `projectToolRequest(options) → Responses request`；`responseToolChunks(client, options) → AsyncIterable<Harness LlmChunk>`。Harness 的 `ToolCallBlock` 保留 `{id,name,arguments}`；工具调用映射到 `finish.reason.kind:'tool-calls'`，完整最终回复映射到 `'stop'`。纯文字路径继续走原 `projectRequest / responseChunks`。

- [ ] 写失败测试：碎片化参数还原、多个 call ID 对应各自结果、assistant tool-call 与 tool-result 往返、developer 消息及 replay 数据保留；非允许工具、缺失 ID、截断 JSON 不得被当作完整调用。
- [ ] 运行 `node --test services/agent/tests/responses-protocol.test.mjs`，检查预期 RED。
- [ ] 完成协议映射。静态 namespace 中只放配置准许的工具；工具动态增加 / 移除事件必须明确投影或拒绝，不能当普通文字悄悄丢弃。按官方协议保留下一请求需要的 reasoning / provider replay 项，避免暴露给终端和 TTS。
- [ ] 新增显式探针 `node tools/agent/web_probe.mjs --protocol-only`：加载单独测试 patch，由 Harness 注册只读 `lookup_probe_value`，返回固定 `opennova-web-probe-ok`；实际 GPT 调用工具，再根据工具结果回答。工具不能进入生产配置。
- [ ] GREEN：协议测试和既有 `node --test services/agent/tests/*.test.mjs`；运行真实探针，记录调用 ID、执行次数、完成 / 取消状态及脱敏证据到新建的 `output/agent/web-verification/` 子目录。
- [ ] **M1 门槛：**真实账号通过“调用 → Harness 执行 → 回传 → 答复”和取消后继续。若官方返回能力限制，保存实际错误码并修订接入方案，不先开发语音、不自动切换 API Key 计费。
- [ ] 完成局部提交，建议信息 `feat: bridge GPT tool calls through Harness`。

### T3 加载 Web 插件和运行预算

**Files:** 新增 `web.patch.yml`、`web-config.mjs`、`web-budget.mjs`、`web-policy.mjs`、`services/agent/tests/web-config.test.mjs`、`web-budget.test.mjs`、`web-tools.test.mjs`；修改 `voice.patch.yml`、配置模板和 worker 启动配置。原文字模式提示词保留，联网 patch 覆盖能力说明。

**Interfaces:** `loadWebConfig({env,configFile,secretsFile}) → {enabled,provider,apiKey,limits}`；`createWebBudget({limits,now}) → {startRequest,claimModel,claimTool,finishRequest}`。按请求计数；`claimTool({requestId,name})` 在调度实际请求之前检查次数及预算，失败返回受控错误。`web-policy.mjs` 以 Harness 插件 `apply(ctx,config)` 连接现有请求与工具策略，不创建另一个执行器。

- [ ] 写配置与预算 RED：默认关闭、非法值拒绝、缺密钥明确失败、只准许两种工具、并发调度不能突破次数、伪时钟验证所有时间上限，结束后移除计时器。
- [ ] 接入 `dsh-web`、Exa、HTTP fetch、`dsh-tool-web` 和 `dsh-tool-call-timeout-policy`，设置设计中的精确预算值。配置顶层新增 `web`，避免破坏当前仅允许字符串的 `agent` 路径配置。
- [ ] 搜索密钥按环境变量 → 本地文件读取，只将 `EXA_API_KEY` 作为显式例外传给当前联网运行时；其他凭据仍过滤。不得在 ready、错误、调试输出或 fixture 中保存真实密钥。
- [ ] 加入合同测试：实际插件注册名称、空结果、401 / 429、超时、网页 403、取消信号；公开网页读取保留上游 URL 限制，拒绝 loopback / 私有目标。使用本地 mock provider 进行离线测试，不能为测试关闭生产抓取限制。
- [ ] GREEN：`node --test services/agent/tests/web-*.test.mjs`；Exa 凭据就绪后，以真实公开查询验证搜索和网页读取，分别测试代理路径。记录中文 / 英文结果，不以搜索摘要代替已阅读正文。
- [ ] 完成局部提交，建议信息 `feat: configure bounded Harness web tools`。

### T4 文字搜索与多步骤事件闭环

**Files:** 新增 `web-events.mjs`、`speech-text.mjs`、`tools/agent/chat.mjs`、`services/agent/tests/web-events.test.mjs`、`speech-text.test.mjs`；修改 `stream-worker.mjs`、`voice-control.mjs`、`result.mjs`、`errors.mjs`、`voice-socket.mjs`（仅在协议需要时）。

**Interfaces:** JSONL `ready` 新增 `outputMode:'incremental'|'settled-answer'`，保留原字段；输入仍为 ask / cancel / close。联网模式新增 `status{id,phase,step,toolCallId?}` 和 `sources{id,items}`，phase 取 `searching|reading|answering`。最终 `reply{id,text,speechText,sources,sessionId}`；来源为 `{id,title,url,publishedAt?,retrievedAt}`。所有 status / sources 只投递给所属 ask。`toSpeechText(text,sources) → string` 产生播报投影。

- [ ] 写 RED：搜索 → 抓取 → 续答的多个 attempt 是正常步骤；工具前说明不出现在最终答复；旧请求的工具结束 / 来源事件被丢弃；最终失败没有成功 reply。
- [ ] 实现 `settled-answer` 模式：工具循环期间不向语音端发送正文 delta；只在 `completedReply` 验证当前完整终止轮次后发布 reply。增量模式沿用原行为，不能把 web 模式伪装成实时模型文本流。
- [ ] 从 Harness 的结构化工具结果关联来源，保留已取得来源供同会话追问。引用编号必须映射到真实来源；未知编号 / URL 不进入有效来源列表。格式化只改展示 / 播报投影，不篡改 Harness 的原始历史。
- [ ] 写并通过播报测试：中文句子、Markdown 链接、独立 URL、代码片段、引用编号、括号和数字。去除链接时保留可读锚文本；正文和语音字段分别校验长度，不再要求它们字节相同。
- [ ] 新增 `node tools/agent/chat.mjs --web` 文字入口，支持连续输入、`/stop`、`/quit`，显示状态和来源。`web_probe.mjs --live-web` 运行“搜索 → 读链接 → 追问来源”的实际会话，要求记录真实工具调用。
- [ ] GREEN：相关 Node 测试；在搜索、抓取、第二次模型请求中分别取消，后续同会话能正常回答。断网恢复不重播旧结果，未完成轮次不冒充已核实回答。
- [ ] **M2 门槛：**文字链路可用、来源可核验、预算有效、取消后会话可继续；完成局部提交 `feat: expose web progress and sourced answers`。

### T5 接入持续语音、提示与插话

**Files:** 修改 `tools/voice/{conversation,continuous_run,stream_agent,continuous}.py`；新增 `tools/voice/tests/test_web_conversation.py`，扩展 `test_stream_agent.py`、`test_cli.py`、`test_lifecycle.py`；已有启动包装器保持参数透传。

**Interfaces:** CLI 增加 `--web`，只在持续模式启用；`StreamingAgent(web=False)` 显式传递模式，`/retry` 保留该值。controller 按 ready.outputMode 选择增量或完整答复路径；两条路径共用同一个 TTS / 播放队列及 generation。record 增加 `output_mode`、`speech_text`、`sources`、工具时间点，原 text 保存展示文字。

- [ ] RED：web 模式只有 status 与最终 reply 也能播报；多步骤不会误判重试；普通模式仍验证增量与最终文字一致；web 参数不影响设备参数，旧轮流模式明确拒绝它。
- [ ] 处理 status / sources 事件，终端显示工具状态和链接；收到完整 reply 后按 speechText 分句合成，沿用 8 段队列、160 字切分和既有有限 PCM 缓存。
- [ ] 增加可取消的 2 秒等待提示；每个问题最多一次，快速完成不播。提示和最终答复串行使用同一输出管道；最终答复就绪时取消尚未播放的提示，不能叠音或把提示写成模型回答。
- [ ] RED → GREEN：搜索等待时插话、提示合成 / 播放时停止、来源迟到、最终答复播放时插话、静音 / 结束 / 重连、退出清理；使用假 Agent / TTS / 音频验证无旧 generation 被播放。
- [ ] 执行 `python3.11 -m unittest discover -s tools/voice/tests -q`；真实两轮文件输入跑通 ASR → 工具搜索 → GPT → Vivian，报告区分状态提示首声、最终答复首声和最终完成，不能用提示首声美化答案延迟。
- [ ] **M3 门槛：**文件链路、取消和下一轮恢复通过；现场用内置 / 蓝牙设备验证后，再记录真实听感结果。完成局部提交 `feat: add web search to continuous voice demo`。

### T6 集成、验证与交付

**Files:** 更新 `README.md`、`services/agent/README.md`、`tools/voice/README.md`、`docs/research/opennova-mvp-development-deployment.md`；记录版本清单中的扩展构建方式，必要时新增 `docs/research/opennova-web-search-verification.md`。

- [ ] 运行受影响的 Node、语音、环境安装测试；完整串联涉及 ASR / TTS 配置或代码时，再运行对应模块测试，不重复跑无关上游全库。
- [ ] 运行一次原文字模式和一次联网模式的真实对话；覆盖最新发布查询、用户链接、来源追问、空结果、搜索失败、总超时、检索中取消。中文 / 英文 / 混合问题至少各 3 个，记录来源可核验性和耗时。
- [ ] 做一次整体差异审查：协议完整性、授权刷新、凭据过滤、多步骤事件、取消、旧模式兼容。发现实质缺陷时先复现，再修复并重跑对应测试。
- [ ] 更新安装、配置和运行说明；新增参数的命令示例标明已实现状态，既有版本验证记录保持历史事实。构建产物可重建、真实密钥未进入差异、全部生成记录在忽略目录。
- [ ] 在清洁生成目录按固定源与补丁重建客户端并完成预检，证明安装不依赖本次手工修改。实际授权复用已有存储，不复制凭据到构建目录。
- [ ] **M4 门槛：**交付本地开发提交、验证记录和测试方法；说明仍待真人验证的事项。默认不开启搜索；使用旧命令可恢复原模式。没有用户另行要求不推送 GitHub。

## 计划中的使用方式

以下命令是开发完成后的目标接口，当前不可用于开启搜索。

```sh
# 安装 / 检查可复现的订阅工具扩展
python3.11 tools/setup/bootstrap.py --install --web
python3.11 tools/setup/bootstrap.py --check --web

# 先验证文字，不打开麦克风
OPENNOVA_PROXY=http://127.0.0.1:7897 node tools/agent/chat.mjs --web

# 再接持续语音，设备参数继续放在末尾
OPENNOVA_PROXY=http://127.0.0.1:7897 tools/voice/run-continuous.command --web \
  --output-device 'SRS-XB100' --device 'SRS-XB100'
```

文字入口需实现与现有启动脚本相同的 OPENNOVA_PROXY 映射，并使用 Node 24；不能只把此环境变量写进示例而没有代码接收它。

## 执行前置与验证边界

- 先做 M1：现有账号即可验证工具协议，不需要先申请搜索 API。
- M2 的离线配置和事件工作可先做，真实搜索需要 Exa Key；密钥仅由本地配置读取，本文不保存。
- M3 需要 Air 与 Studio 连通；真人插话和听感由现场测试确认，自动化通过不代替它。
- 计划按串行交付安排。源码、接口和验证结果若推翻假设，应在对应里程碑更新本计划及设计，再推进后续任务。
