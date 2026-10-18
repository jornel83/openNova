# OpenNova 双窗口交互 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以浏览器或本地应用承载工作内容，以 Nova 窗口持续对话；首版支持页面协作、本地文件打开、统一工作引用、语音 / 文字接续和一键启动。

**Architecture:** 复用当前 Bot HTTP 宿主与共享会话，在宿主内加入交互协调模块。Chrome 扩展管理浏览器窗口及页面操作，macOS 文件打开器将原文件交给本地应用；React 网页通过 HTTP / SSE 展示统一工作引用及状态；现有 Python 原生语音进程通过本机接口同步状态与执行控制。

**Tech Stack:** Node.js 24、现有 React / esbuild / DeepSeek-Bot UI、Chrome Manifest V3、WebSocket、SSE、macOS `/usr/bin/open`、Python asyncio、现有 macOS 原生音频。

**Spec:** [双窗口交互技术方案](../specs/2026-10-18-desktop-interaction-design.md)

状态：2026-10-18，M0（任务 1、2）已实现并完成独立 Chrome 实测；M1（任务 3、3A）已实现并完成审查与实测；M2（任务 4、5）已实现并完成真实 Bot 与窄窗口验收；M3–M4 尚未实施。测试范围、限制和启动步骤见 [验证记录](../../research/opennova-desktop-interaction-test-cases.md)。后续章节中的接口和命令参数仍为计划。

## Global Constraints

- 开发首版以 macOS、Chrome 120+ 为目标；这是技术建议，不表示已经确认用户的默认浏览器。
- 工作内容由浏览器或对应本地应用承载；Nova 沿用深空配色与约 72 px 环形，不新增固定项目侧栏、独立执行面板或两种控制模式。
- 自动排列仅覆盖两个 Chrome 窗口；原生应用首版只支持打开文件，不接入应用内部选区、自动编辑、焦点跟踪或窗口排列。
- 本地文本沿用现有文件读取工具；PDF / Office 正文解析、OCR 和未保存编辑同步不纳入本次扩展。
- 复用同一个 Bot 会话与单个前台请求约束。文件、Shell 和已授权页面操作直接执行，不恢复二次确认。
- 原生语音进程持有麦克风与播放；网页不请求麦克风，不重复执行 ASR 或 TTS。
- 页面正文最多 12,000 字符、选区最多 4,000 字符；超限标明截断。
- 扩展与网页只连接本机 `127.0.0.1:18560`；保留网页同源 / Cookie / CSRF 和 CLI Bearer，扩展使用独立配对凭证。
- 事件内存保留最近 512 条；扩展连接期间每 20 秒交换心跳，30 秒 alarm 用于唤醒恢复。
- `--ui` 首版显式启用；`--no-ui`、原有设备与 TTS 参数兼容；`--check` 不打开窗口、不启用麦克风。
- 不改动上游 DeepSeek-Bot / Harness 源码，不变更模型、VAD 判定或 TTS 合成算法。
- 当前工作区有未提交的既有改动。实施前确认基线，按任务精确暂存；不得通过清理、重置或整库暂存夹带无关文件。

## Review Focus

1. 切到右侧打字、工作页 SPA 导航、站点弹新标签页，或打开文件后网页后台刷新：绑定不能指向聊天页 / 无关弹窗，后台网页不能抢占文件引用。归属任务 2 / 3 / 3A。
2. 点击或文件打开已发送但连接断开：恢复不得重放；“未知”“系统已接受打开请求”与“已读正文”需要区别。归属任务 1 / 3 / 3A。
3. 重连同时发生请求完成：快照与游标不能漏事件、重复消息或重复工具执行。归属任务 4。
4. 语音插话、网页停止、旧播放回执交错：音频和 Agent 都必须停止，旧 generation 不能恢复动画或播放。归属任务 6。
5. MacBook Air 小屏、中文输入法、长代码和 reduced-motion：保持输入可用、窗口内容可读。归属任务 5 / 7。

## 里程碑与交付顺序

| 里程碑 | 任务 | 用户可验收的结果 |
| --- | --- | --- |
| M0 浏览器技术验证 | 1、2 | 配对后读取真实 Chrome 页面与选区，切页后旧引用失效 |
| M1 双窗口文字协作 | 3、3A | 文字指令完成网页任务，定位并用本地应用打开文件 |
| M2 Nova 界面 | 4、5 | 新对话界面连接真实会话、网页 / 文件引用与执行结果 |
| M3 语音界面一体化 | 6 | 语音发起网页协作与文件打开，文字接续；真实环形状态与控制 |
| M4 一键启动与验收 | 7 | 带设备参数启动、浏览器布局、两类工作对象恢复与两种 TTS 路径验收 |

先交付 M0 判断浏览器路径是否成立；再扩展完整功能。M1 新增任务 3A，完成后已有网页协作与本地文件打开两条文字闭环。共 8 项开发任务，原任务编号保留；任务 3A 不依赖扩展在线，但依赖任务 2 的统一上下文接口。M2 视觉准备可提前进行，但不得将模拟状态计作真实接入完成。

## 文件与职责

以下“新增”为目标路径；实现时保持模块聚焦，不创建新的业务服务或会话数据库。

| 路径 | 类型 | 职责 |
| --- | --- | --- |
| `services/bot/desktop/protocol.mjs` | 新增 | 消息校验、版本与字段上限，JSDoc 协议类型 |
| `services/bot/desktop/browser.mjs` | 新增 | 扩展配对、WebSocket、命令分发与取消 |
| `services/bot/desktop/context.mjs` | 新增 | 网页 / 文件工作对象、页面绑定、引用冻结与失效 |
| `services/bot/desktop/tools.mjs` | 新增 | 浏览器工具定义、输入约束与回执记录 |
| `services/bot/desktop/documents.mjs` | 新增 | 路径与类型校验、macOS 文件打开、幂等回执、`document_open` 工具定义 |
| `services/bot/desktop/events.mjs` | 新增 | 事件游标、重放、快照一致性 |
| `services/bot/desktop/voice.mjs` | 新增 | 原生语音实例、状态、命令队列与回执 |
| `services/bot/desktop/package.json`、`package-lock.json` | 新增 | 将 WebSocket 库 `ws` 作为显式依赖锁定；不手写协议或依赖上游隐藏依赖 |
| `extensions/browser/` | 新增 | Manifest、service worker、DOM 能力、窗口管理、配对设置与测试页面 |
| `services/bot/web/nova-ring.jsx`、`context-chip.jsx`、`operation-card.jsx`、`events.mjs` | 新增 | 对话组件与事件消费；从现有 App 逐步抽取 |
| `services/bot/web/app.jsx`、`app.css`、`api.mjs` | 修改 | 页面布局、控制、请求恢复与样式 |
| `services/bot/host.mjs`、`policy.mjs`、`launch.mjs` | 修改 | 接入新模块、工具注册、运行依赖 |
| `services/bot/http.mjs`、`web-http.mjs`、`controls.mjs` | 修改 | 扩展桥接、SSE、统一控制路由 |
| `services/bot/requests.mjs`、`operations.mjs` | 修改 | 本轮工作引用、状态事件、浏览器及文件打开记录 |
| `tools/voice/ui_bridge.py` | 新增 | 发布原生状态、轮询命令、确认回执 |
| `tools/voice/continuous.py`、`continuous_run.py`、`bot_agent.py` | 修改 | 语音生命周期与本轮请求关联，复用现有控制实现 |
| `tools/voice/audio_bridge.py`、`native/AudioBridge.swift` | 修改 | 向上提供实际播放 / 暂停 / 清空回执，保留音频处理逻辑 |
| `tools/voice/start.mjs` | 修改 | UI 启动、复用、降级与资源归属 |
| `tools/desktop/setup.mjs`、`client.mjs` | 新增 | 一次性配对设置、复用窗口请求；不输出长期令牌 |
| `docs/research/opennova-desktop-interaction-test-cases.md` | 新增 | 真人浏览器、设备与端到端验收记录 |

## 协议约定

字段采用 JSON；下列名字由 `protocol.mjs` 定义并由 JS / Python 共用协议测试验证。

- `PageRef = {bindingId, tabId, documentId, revision, url, title, readable}`；`revision` 为非负整数，失效时返回明确错误。
- `PageContext = {page: PageRef|null, selection: {text, documentId, revision}|null}`；引用文本独立于用户原始输入保存。
- `FileRef = {id, path, name, extension, size, mtimeMs, applicationId?, openStatus, contentAccess}`；`contentAccess` 为 `text_file/not_connected`，表示现有读取能力，不表示已经读取。
- `WorkContext = {kind:'none'} | {kind:'browser', page:PageRef, selection:PageContext.selection} | {kind:'file', file:FileRef}`。页面缓存与当前引用分开维护，文件引用没有浏览器选区。
- `DocumentOpenResult = {id, requestId, status, file?, error?}`；`status` 为 `dispatched/failed/cancelled/unknown`，默认应用未明确识别时不虚构应用名称。
- `PageSnapshot = {page, text, truncated, targets:[{ref, role, name, href?}]}`。
- `BrowserCommand = {id, requestId, method, page?, args, deadlineAt}`；方法包括 `open/read/click/fill/scroll/windows.ensure/cancel`，仅内部适配器使用后两项。
- `BrowserResult = {id, status, page?, snapshot?, error?}`；状态为 `completed/failed/cancelled/unknown`，`unknown` 不自动重放。
- `Event = {hostEpoch, seq, type, requestId?, payload}`；`Cursor = {hostEpoch, seq}`。
- `VoiceState = {voiceInstanceId, capture, recognition, playback, generation, requestId?, connected}`；Agent 状态从 Bot 请求推导。
- `VoiceTranscript = {voiceInstanceId, captureEpoch, utteranceId, text, final, requestId?}`；临时转写按前三个字段合并，最终发言关联实际请求。
- `VoiceControl = {id, voiceInstanceId, action, requestId?}`；动作 `start/end/mute/unmute/stop/retry`，回执包含 `id/status/error?`。
- `/ask` 继续接收 `{id,text,source}`；宿主接纳时关联 `WorkContext`。重复 id 返回原记录，不重新捕获网页 / 文件引用或再次运行。

## Task 1：扩展与本机 Bot 建立可靠连接（M0）

**Files:** 新增 `services/bot/desktop/{protocol,browser}.mjs`、该目录依赖清单；新增 `extensions/browser/{manifest.json,service-worker.mjs,options.html,options.mjs}`、`tools/desktop/setup.mjs`；修改 `services/bot/{http,host,launch}.mjs`。

**Tests:** 新增 `services/bot/tests/desktop-bridge.test.mjs`、`extensions/browser/tests/connection.test.mjs`。

**Interfaces:**
- Produces: `createBrowserBridge({server,home,onContext}) -> {execute(command,{signal}), ensureWindows(options), status(), close()}`。
- Produces: `POST /browser/pair` 与 WebSocket `/browser/bridge`；配对码一次有效、60 秒过期，配对后绑定扩展 Origin；认证首包时限 5 秒。
- Consumes: 现有 HTTP server 和生命周期清理；`BrowserCommand/BrowserResult`。

- [x] 写失败测试：非法 Origin、过期配对码、未认证连接不得收到命令；重复命令 ID 不重复执行；已发送动作失联返回 `unknown`。
- [x] 运行 `node --test services/bot/tests/desktop-bridge.test.mjs extensions/browser/tests/connection.test.mjs`，确认因新增能力缺失失败。
- [x] 实现本机桥接与扩展设置。令牌仅存本机受限文件 / 扩展存储；连接包限制 128 KiB；允许列表内方法校验后分发；服务停止关闭连接。增加心跳、退避、启动事件、alarm 恢复与已配对扩展状态显示。
- [x] 运行同一命令至通过；实机手动停止并唤醒 worker，确认恢复后不重放动作。首次安装与站点授权写入设置说明。
- [x] 检查 diff，仅提交本任务相关文件，建议提交信息 `feat: connect desktop browser extension`。

## Task 2：绑定工作窗口，取得页面与选区（M0）

**Files:** 新增 `extensions/browser/{windows.mjs,dom.mjs,content.js}`、`extensions/browser/tests/fixtures/work-page.html`、`services/bot/desktop/context.mjs`；修改 service worker、options、manifest。

**Tests:** 新增 `extensions/browser/tests/windows.test.mjs`、`services/bot/tests/desktop-context.test.mjs`；真实 DOM 验证记录在桌面测试文档。

**Interfaces:**
- Consumes: 任务 1 的 `ensureWindows` 与 `onContext(PageContext)`。
- Produces: `createWorkContext() -> {updateBrowser(pageContext,{activate}), selectFile(fileRef), snapshot(), capture(), clearSelection(), invalidate(reason)}`；`snapshot/capture` 返回 `WorkContext`，`capture()` 为不可变副本。当前为网页引用时同步对应绑定的页面变化；当前为文件引用时，被动浏览器更新只改缓存，主动返回绑定网页才使用 `activate:true` 切换。
- Produces: `ensureWindows({chatUrl,bounds?}) -> {workWindowId,workTabId,chatWindowId}`；DOM 适配器处理 `read` 并返回 `PageSnapshot`。

- [x] 写失败测试：右侧聚焦不改变 workTabId；绑定页导航后旧选区清空；重复 ensure 复用窗口；浏览器重启后失效 ID 不误绑；超长正文 / 选区截断可见。
- [x] 运行 `node --test services/bot/tests/desktop-context.test.mjs extensions/browser/tests/windows.test.mjs`，确认预期失败。
- [x] 实现明确窗口绑定、首次布局、轻量上下文更新和按需 DOM 快照。忽略无关页事件；普通文本框以外的敏感字段不读取；DOM 变化让被替换的目标引用失效，避免页面动画导致所有引用持续失效。
- [x] 同一测试通过后，在真实 Chrome 测试 fixture、雪球及一个普通文章页；验证选中文字后点击 Nova 窗口仍保留引用，SPA 跳转可更新，跨域 iframe / 不支持内容有明确状态。记录实际站点结果，不写模拟成功。
- [x] 检查 diff 并形成 M0 提交，建议 `feat: bind work pages and capture context`。

**M0 关口：** 实际验证打开、读取、选区和重连成立后进入 M1。雪球登录或访问受限单独记录，不能把通用 fixture 通过当作雪球案例通过。

## Task 3：浏览器工具进入共享 Bot 会话（M1）

**Files:** 新增 `services/bot/desktop/tools.mjs`；修改 `services/bot/{host,policy,requests,operations,controls}.mjs` 和 `extensions/browser/{service-worker,dom}.mjs`；对现有网页先加入基础引用提示与浏览器回执。

**Tests:** 新增 `services/bot/tests/desktop-tools.test.mjs`，扩展现有 `requests.test.mjs`、`web-controls.test.mjs`。

**Interfaces:**
- Consumes: `bridge.execute(command,{signal})`、`context.capture()`、现有 `Operations.put(record)` / 请求取消。浏览器读取与操作要求明确的 PageRef，不能把文件引用当作网页；`browser_open` 可显式切回网页。
- Produces: `createBrowserTools({bridge,context,ops})`，返回宿主 `defineTool` 可注册的五个工具定义；工具名、输入输出见 spec 5.4。
- Produces: 请求记录 `context: WorkContext`；浏览器工具记录 `{kind:'tool',operation:'browser',requestId,commandId,status,...}`。

- [x] 写失败测试：同一 `/ask` id 重试仍使用第一次引用；语音与网页接入同一会话；切页期间的旧点击返回 `context_changed`；取消后未发送命令不执行。
- [x] 写额外失败测试：点击产生的有效新标签页可跟踪，无关弹窗不绑定；网页正文中要求调用 Shell 的文本仅作为引用；断线未知结果不自动重试。
- [x] 运行 `node --test services/bot/tests/desktop-tools.test.mjs services/bot/tests/requests.test.mjs services/bot/tests/web-controls.test.mjs`，确认新增断言失败。
- [x] 实现工具定义、实际回执、请求引用及五项 DOM 操作。工具列入 `ALLOWED_TOOLS` 并进入现有 provider 配置；用户输入与引用分字段渲染，禁止把引用拼接成高优先级系统指令。
- [x] 运行上述测试；用文字实测“打开雪球上的华工科技 → 看最新公告 → 解释选区”。核对真实页面标题和链接；登录 / 验证码由用户在原页面完成，工具如实返回未完成原因。
- [x] 检查并提交本任务，建议 `feat: add shared-session browser tools`。

## Task 3A：定位本地文件并交给应用打开（M1）

**Files:** 新增 `services/bot/desktop/documents.mjs`；修改 `desktop/{protocol,context}.mjs`、`services/bot/{host,policy,controls,web-http,operations}.mjs`；现有网页先显示文件引用与回执，任务 5 再统一样式。

**Tests:** 新增 `services/bot/tests/desktop-documents.test.mjs`；扩展 `desktop-context.test.mjs`、`web-controls.test.mjs`。真人测试使用临时文档，禁止自动打开用户现有文件作单元测试。

**Interfaces:**
- Consumes: 现有 `glob/grep/read` 与项目路径、`context.selectFile(fileRef)`、`Operations.put(record)`、请求 AbortSignal。
- Produces: `createDocumentOpener({workspace,ops,context,spawnOpen}) -> {open({id,requestId,path,applicationId?},{signal})}`，返回 `Promise<DocumentOpenResult>`；`spawnOpen` 可注入测试替身。
- Produces: `createDocumentTool({opener,getRequest})` 返回 `document_open({path,applicationId?})` 定义，宿主提供 `getRequest() -> {id,signal}`；执行器产生 command id，当前 requestId 由宿主取得。
- Produces: 文件打开操作记录 `{kind:'tool',operation:'document_open',commandId,requestId,status,file?,error?}`；新增 `/web/api/document-open` 接收 `{id,fileId}`，复用服务端已登记文件重新打开，不接收任意网页提供的路径或 Shell 文本。

- [x] 写失败测试：中文 / 空格 / 引号 / Shell 特殊字符路径原样作为参数；不存在文件、非本机文件、指定应用缺失有明确错误；脚本执行、安装包、自定义 URL scheme 不走文件打开器。
- [x] 写幂等与引用测试：同 id 重试只打开一次，id 对应不同文件报冲突；取消前不启动，发送后取消不关闭应用；超时为 `unknown` 不重放；成功发送才选中文件引用，失败保留旧引用；网页后台更新不覆盖文件，显式返回网页清除文件引用。
- [x] 运行 `node --test services/bot/tests/desktop-documents.test.mjs services/bot/tests/desktop-context.test.mjs services/bot/tests/web-controls.test.mjs`，确认新增能力失败。
- [x] 实现路径规范化、存在性 / 文件类型检查与应用路由。首版类型覆盖 PDF、PNG/JPEG/WebP、DOC/DOCX、XLS/XLSX、PPT/PPTX、Markdown / TXT 与常见源代码文本；源代码默认加 `-t`，显式应用仅接受编辑器，避免误用脚本执行器。调用 `/usr/bin/open` 使用绝对路径和参数数组，`shell:false`，不使用强制新实例或等待应用退出参数；为子进程提供必要环境，不传递模型密钥。
- [x] 实现 10 秒调用超时、明确失败及 `dispatched` 回执；发起调用前保存带 commandId 的运行记录，启动恢复时将未收尾记录标为 `unknown`，不重放。工具注册到允许列表，按现有授权直接执行。同名候选由 Agent 结合当前项目定位；仍有歧义时询问文件选择，不增加批准步骤。文本读取核对磁盘保存版本；PDF / Office 显示“正文未接入”，不生成臆测摘要。
- [x] 运行同一测试至通过；使用临时 TXT、PDF 和已安装办公软件支持的文档实测默认应用与指定应用。扩展未连接时仍可打开本地文件；记录人工看到的结果与系统回执的差别。
- [x] 检查 diff 并提交本任务，建议 `feat: open local documents in native applications`。

## Task 4：增加实时事件与可恢复快照（M2）

**Files:** 新增 `services/bot/desktop/events.mjs`、`services/bot/web/events.mjs`；修改 `operations.mjs`、`controls.mjs`、`web-http.mjs`、`host.mjs`、`web/api.mjs`。

**Tests:** 新增 `services/bot/tests/desktop-events.test.mjs`，扩展 `services/bot/tests/web.test.mjs`。

**Interfaces:**
- Produces: `createEvents({capacity:512}) -> {publish(type,payload,requestId?), snapshot(readState), subscribe(cursor,onEvent), close()}`；快照返回 `{state,cursor}`。
- Produces: `/snapshot` 的既有字段保留，新增 `desktop:{context:WorkContext,browser,voice}`、`cursor`；`POST /web/events` 接受 `{cursor}`，统一引用事件为 `work.context`。
- Produces: `WebApi.events(cursor,onEvent,{signal})`，失败或游标失效回退到现有 snapshot。

- [x] 写失败测试：先快照后订阅的时间窗内完成的请求仍能收到；过期 cursor / 新 epoch 触发重新快照；慢客户端断开恢复；外站及无 CSRF 请求无法订阅；恢复历史文件引用不会再次打开文件或宣称原生窗口仍在前台。
- [x] 运行 `node --test services/bot/tests/desktop-events.test.mjs services/bot/tests/web.test.mjs`，确认失败位置对应新增能力。
- [x] 实现有限事件缓冲、统一发布点、SSE 与客户端恢复。持久请求和操作继续使用现有 SQLite；实时音频状态与转写不另建数据库。断开的 SSE 客户端必须释放监听器。
- [x] 同一测试通过；人工刷新网页并中断网络，确认不重复发起任务、无消息倒退，使用轮询仍能看到最终结果。
- [x] 检查并提交，建议 `feat: stream recoverable interaction events`。

## Task 5：实现 Nova 对话界面（M2）

**Files:** 新增 `services/bot/web/{nova-ring.jsx,context-chip.jsx,operation-card.jsx}`；修改 `app.jsx`、`app.css`、`api.mjs`、`services/bot/{controls,web-http}.mjs`；按需调整 `build.mjs` 的资源入口，不复制整个上游 UI。

**Interfaces:**
- Consumes: 扩展后的 snapshot、事件流、现有 `ask/cancel`；语音未接入时显示不可用，不生成模拟倾听状态。
- Produces: `NovaRing({state,reducedMotion})`、`ContextChip({context,onClear,onOpenFile})`、`OperationCard({record})`；新增 `POST /web/api/context-clear` 仅清除浏览器选区；文件卡片重新打开调用任务 3A 的接口。

- [x] 以归档原型右侧为参考实现深空样式、环形 Nova、消息区、引用和输入。移除当前左右常驻栏；保留中文输入法、消息发送去重、断网草稿、Markdown、代码与差异展示。
- [x] 接入真实请求与工作引用，按 requestId 将操作挂到对话；文件卡片显示名称、所属目录、打开方式 / 回执和“重新打开”，不显示未接入的原生选区。区分 `dispatched` 与内容已读取；详情按需展开，取消仍通过服务端。无语音进程时不显示“正在聆听”。
- [x] 运行 `/opt/homebrew/opt/node@24/bin/node services/bot/web/build.mjs`，确认构建成功；运行 `node --test services/bot/tests/web.test.mjs services/bot/tests/web-controls.test.mjs` 验证现有交互接口。
- [x] 浏览器人工核对 400 px 宽、中文输入法回车、长代码、旧消息加载、键盘焦点、reduced-motion、离线草稿和消息内操作详情；保存实际截图及结论。纯样式不新增镜像实现的单元测试。
- [x] 检查并提交，建议 `feat: add minimal Nova conversation interface`。

## Task 6：连接语音状态与网页控制（M3）

**Files:** 新增 `services/bot/desktop/voice.mjs`、`tools/voice/ui_bridge.py`；修改 `controls.mjs`、`web-http.mjs`、`host.mjs`、`web/app.jsx`、`tools/voice/{continuous.py,continuous_run.py,bot_agent.py,audio_bridge.py,native/AudioBridge.swift}`。

**Tests:** 新增 `services/bot/tests/desktop-voice.test.mjs`、`tools/voice/tests/test_ui_bridge.py`；扩展 `test_continuous.py`、`test_audio_bridge.py`、`test_bot_agent.py`。

**Interfaces:**
- Produces: `createVoiceChannel({events}) -> {publish(update), poll(instanceId,signal), enqueue(control), ack(result), snapshot(), close()}`。
- Produces: Bearer 路由 `/voice/publish`、`/voice/poll`、`/voice/ack`；网页路由 `/web/api/voice-control`。
- Produces: Python `UiBridge(api, instance_id)`，提供 `publish(state_or_transcript)`、`run(commands)`、`ack(command_id,result)`、`close()`。
- Consumes: `Conversation.control(command)`、现有 retry 流程、原生 generation / played / 清空回执；所有控制回到同一个 asyncio 命令队列。

- [ ] 写失败测试：ASR partial 多次更新只出现一条草稿，final 仅一次 ask；无语音进程返回 `voice_unavailable`；重复 control id 幂等；旧 voiceInstanceId / generation 回执丢弃。
- [ ] 写取消竞态测试：文本任务执行时网页“停止回复”也能取消当前 Bot；Bot 已完成但 TTS 缓冲 / 播放中仍显示停止按钮，点击后清空队列；旧请求的停止不能取消新请求；静音不意外恢复收音；`/retry` 与 `/end` 交错不自动开始监听。
- [ ] 运行 `node --test services/bot/tests/desktop-voice.test.mjs` 及 `python3.11 -m unittest discover -s tools/voice/tests -p 'test_ui_bridge.py' -v`，确认新增能力失败。
- [ ] 实现语音发布与控制桥。后台发布失败不能堵塞音频；状态过期显示离线；播放回执来自原生队列，区分 buffering / playing / paused。增加观察事件，不改变降噪、VAD 或插话阈值。
- [ ] 让现有 `/cancel` 与新增语音 `stop` 共用协调逻辑，按 requestId 取消对应 Bot 请求并清理该请求的语音输出；纯文字运行也可停止。不得等待整个 TTS 完成后才响应；临时转写只走事件通道；网页收到已完成消息不合成第二份音频。
- [ ] 运行 Bot 语音测试与 `python3.11 -m unittest discover -s tools/voice/tests -v`。实机完成语音打开页面、打开本地 PRD、文字追问已保存文本、停止、静音、恢复和重连；停止不得关闭已打开的本地应用。无实机听感验证不能声称播报已验证。
- [ ] 检查并提交，建议 `feat: synchronize native voice with Nova UI`。

## Task 7：一键启动、降级与完整验收（M4）

**Files:** 新增 `tools/desktop/client.mjs`；修改 `tools/voice/start.mjs`、`tools/voice/tests/launcher.test.mjs`、`README.md`、`services/bot/web/README.md`、`docs/research/opennova-demo-architecture-status.md`；完成桌面交互测试文档。

**Interfaces:**
- Consumes: 配对扩展 `ensureWindows`、Bot health、语音 ready、已有启动器资源归属与信号清理。
- Produces: `start.command --ui` / `--no-ui`；新增本机 Bearer `/desktop/open` 让启动器请求扩展开窗，网页“打开浏览器工作窗口”复用同一实现；本地文件另走 `document_open`，不依赖扩展开窗。
- 新设备参数仍是 `--device`、`--output-device`；TTS 参数仍是 `--tts-provider studio|doubao`，不另造一套配置。

- [ ] 扩展启动测试：重复执行不重复开浏览器窗口或占麦克风，不重放历史文件打开；缺少扩展只降级页面协作，本地文件打开仍可用；TTS / 麦克风失败保留文字入口；`--check` 和 `--list-devices` 无开窗 / 收音副作用。
- [ ] 运行 `node --test tools/voice/tests/launcher.test.mjs`，确认新增断言失败。
- [ ] 实现启动顺序、窗口恢复、扩展安装 / 配对引导和清晰失败原因。浏览器窗口布局按 Chrome 实际返回的尺寸校正；用户移动后不反复抢回位置；原生窗口由应用决定，退出启动器不关闭用户应用。保留终端作为首版语音进程入口，不在此任务引入 macOS 常驻后台服务。
- [ ] 运行启动测试、`node --test services/bot/tests/*.test.mjs` 与 `python3.11 -m unittest discover -s tools/voice/tests -v`；构建网页，并记录通过的命令及结果。
- [ ] 按下表做真人端到端验收；在部署文档中写入实测命令、扩展设置步骤、未通过项。不要把以下预期命令提前标为当前可用。
- [ ] 核对产品 PRD 与实现状态，精确提交本任务，建议 `feat: launch the dual-window Nova experience`。用户请求推送后再发布到远端。

## 端到端验收清单

| 编号 | 操作 | 预期 |
| --- | --- | --- |
| UI-01 | 启动后再执行一次启动 | 两个 Chrome 窗口等高、位置合理；复用服务与窗口，不重放文件打开 |
| UI-02 | 文字要求打开雪球华工科技 | 原站目标正确；对话引用对应实际页面，打开与读取结果分别准确 |
| UI-03 | 语音“看看最新公告”，选区后“解释这一段” | 页面操作可见；解释有正确引用；语音文字同一会话 |
| UI-04 | 读取期间手动切工作标签页，再切到右侧输入 | 旧页面命令不误操作新页；右侧聚焦不污染引用 |
| UI-05 | 回复 / 页面操作期间点击停止，随后提新问题 | 当前前台执行与播报停止，旧事件不重新触发；新问题正常 |
| UI-06 | 静音、恢复、结束交流；重建音频期间结束交流 | 界面与实际收音一致，结束后不自动恢复麦克风 |
| UI-07 | 网页刷新、扩展 worker 重启、Bot 重启 | 能重新连接；结果不重复、动作不重放、离线状态明确 |
| UI-08 | 家中 Studio 与办公室豆包分别运行 | 两条 TTS 链路沿用原参数；文字与浏览器不依赖 Studio 在线 |
| UI-09 | 站点登录页、验证码、不可读 PDF / iframe | 如实报告限制；用户可操作原页面；不伪造已读取内容 |
| UI-10 | 现有工程读写与 Shell 测试 | 无新增审批；结果及差异可在消息内展开，功能不回退 |
| UI-11 | 语音“打开 OpenNova 的 PRD”，再用文字询问第 4 章 | 默认编辑器打开实际 Markdown；右侧引用该文件；回答依据另行读取的磁盘内容 |
| UI-12 | 打开本地 PDF 和 Office 测试文件 | 交给默认 / 明确指定的已安装应用；回执准确，不声称已解析正文或取得原生选区 |
| UI-13 | 重名文件、中文 / 空格路径、文件丢失、指定应用未安装 | 必要时选择候选，路径无 Shell 注入，错误清晰，无错误成功状态 |
| UI-14 | 打开文件后让网页后台刷新，再主动返回工作网页 | 后台刷新不抢文件引用；显式返回网页恢复网页引用；旧网页选区不混入文件问题 |
| UI-15 | 文件打开后停止回复、刷新网页或重启 Bot | 已打开应用保持；历史记录不触发重新打开；状态未知时不自动重试 |

实现后的预期命令示例（目前尚未支持 `--ui`）：

```bash
./start.command --ui --tts-provider studio --device 'SRS-XB100' --output-device 'SRS-XB100'
./start.command --ui --tts-provider doubao --device 'MacBook Air麦克风' --output-device '外置耳机'
```

设备名以当时 `--list-devices` 输出为准。生产数据、密钥、浏览器登录状态和生成日志不纳入 Git；操作测试使用测试页面 / 测试文件，真实网站主要验收导航、读取与查询。
