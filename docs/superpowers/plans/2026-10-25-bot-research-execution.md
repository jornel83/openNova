# OpenNova 通用联网研究能力补齐开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让当前 Bot 自主组合搜索、网页读取、公开接口取数与脚本处理，能够换源、核验并保留实际证据。

**Architecture:** 复用现有 Harness Web provider、Shell executor、Bot 请求生命周期与 SQLite 来源记录。增加通用 `web_request` 和基于原生 Shell 的 `research_exec`；脚本 HTTP 辅助命令进入同一个宿主请求入口。普通 `bash` 保留完整工程能力，不以任意 Shell 输出冒充已观察的网络响应。

**Tech Stack:** Node 24 / ESM、现有 DeepSeek Harness TypeScript 插件、Bot bridge SQLite、React 对话界面、Python 语音客户端。

**Spec:** [2026-10-25 通用联网研究设计](../specs/2026-10-25-bot-research-execution-design.md)。用户认可的会话评审与该文件是本计划依据；其中配置数值和新增接口名称是工程细化选择。

**状态：** 2026-10-25，R6–R10 已实现；R11 自动化、隔离文字验证和日常部署完成，真人语音验收待用户执行。此前 R1–R5 的实施记录保留在 [原开发计划](2026-10-24-bot-web-research.md)，不回写为本轮已完成。

## Global Constraints

- 沿用 GPT-6.1 Sol、DeepSeek 搜索、当前 Bot 会话与语音链路，无新增用户确认流程。股票专用工具后移。
- 执行时复用合适的现有工作区；OpenNova 当前开发区为 `/Users/chenzhuoping/.codex/worktrees/desktop-browser-m0/openNova`，Harness 检出为 `/Users/chenzhuoping/Documents/work/project/deepseek-harness`。先读取适用 AGENTS.md，保护两仓库已有修改；Harness 依赖变更独立提交/构建，不能直接修改 lib 产物。
- Harness 的公开扩展必须完成其仓库要求的类型、相关测试、文档与构建验证；读取 `docs/architecture.md` 和 `docs/testing.md`，只做本任务需要的针对性检查。保持旧 provider 调用兼容，不替换 Agent loop。
- 普通工程请求总时限继续为 `600000 ms`；研究关闭不清空工程工具。新研究默认值：2 个 query、6 次逻辑读取，search/http 超时 15000/10000 ms，soft/hard 60000/90000 ms，研究 Shell 默认/最大 45000/90000 ms。
- 共用现有代理配置、取消与公共 URL 策略。请求头只允许非凭据字段，秘密、Cookie 和任意环境变量不进入工具结果、来源或 Git。JavaScript 格式接口只作为文本数据。
- 网络结果、脚本输出及派生文件都是资料，不提供额外执行授权。命令退出码、HTTP 状态、内容质量、结论依据分开处理。
- HTTP 上限 2000000 bytes、HTML 上限 500000 chars、模型正文 11000 chars、持久证据片段 12000 chars；原始响应放在忽略 Git 的请求目录，不挤满模型上下文。
- 不依赖浏览器完成后台查询，不自动激活工作窗口。实现中的诊断日志不输出本机 secrets 文件或认证令牌。
- 真实联测用独立 Bot home 与端口；日常 Bot 有语音连接或活跃请求时不替换服务。R11 通过前不把中间版本部署到日常入口。

## Review Focus

1. HTTP 200 仅标题、502 伴随 Shell exit 0、缺失 MIME：工具与来源不得显示“已查到”；R6/R7/R8 覆盖。
2. 修改 Referer 或编码后重试、同 URL 不同业务参数、多 query：去重和计数不能阻止有效修正或把来源全归给第一个 query；R7/R9 覆盖。
3. 停止、插话、Shell 退出和宿主重启后的迟到回包：不得归入新请求或生成成功来源；R8/R9/R11 覆盖。
4. 最新报价、历史日 K 线和除息前后口径不一致：保留原始字段及日期，答案不混用；R9/R11 覆盖。
5. 普通工程脚本、任意 curl 与统一 HTTP 辅助命令混用：不能宣称已统计所有网络请求，也不能因研究额度用尽终止工程测试；R8/R9/R10 覆盖。

## 任务总览与依赖

| 里程碑 | 交付物 | 依赖 | 可独立验证的结果 |
| --- | --- | --- | --- |
| R6 通用读取修复 | 正确编码、HTTP 状态与内容质量 | 无 | 中文正常、空壳与失败响应被准确识别 |
| R7 通用 HTTP 取数 | `web_request`、结构化响应和证据 | R6 | 带 Referer 的接口可后台读取并保存真实来源 |
| R8 研究脚本与取数辅助 | `research_exec`、HTTP CLI、派生证据 | R7 | 脚本内请求可关联本轮并被取消 |
| R9 自主研究与预算 | 选工具/换源规则、批量搜索、统一计数 | R7、R8 | 允许多步核验且工程功能不被研究预算关闭 |
| R10 网页与语音联动 | 真实状态、来源类型与回查 | R9 | 能看清搜索、取数、脚本处理及实际失败 |
| R11 综合验收与部署 | 回归报告、真实网络证据、启动文档 | R6–R10 | 隔离环境通过后更新日常 Demo |

按 R6 → R7 → R8 → R9 → R10 → R11 顺序执行；完成 R9 后可开展第一次隔离文字联测。每个任务先写失败用例、最小实现、验证后独立提交，只暂存本任务文件。以下文件均相对 OpenNova 根目录，`Harness:` 前缀表示另一仓库。

## R6：修复底层读取与内容质量

**Files**
- Harness Modify: `packages/web/web-fetch-http/src/provider.ts`、`src/policy.ts`、`src/index.ts`、该包 README 与 `tests/fetch-http.spec.ts`、`tests/proxy.spec.ts`（路径均在同一包）。
- Modify: `services/agent/web-fetch-content.mjs`、`services/bot/research/runtime.mjs`。
- Create: `services/agent/web-content-quality.mjs`。
- Test: `services/agent/tests/web-fetch-content.test.mjs`、`services/bot/tests/research-fetch.test.mjs`。

**Interfaces**
- Harness 新增公开 `HttpFetchProvider.fetchWithOptions(request, options, signal?) -> HttpFetchResponse`，保留原 `fetch(request, signal?) -> WebFetchResult`。`options = {headers?, encoding?, allowScriptText?}`；扩展响应保留原字段并包含 `contentType?`、`encoding?`、`replacementCount`。不改现有 html/text body 联合类型。
- 编码优先级：明确的有效 override → HTTP charset → BOM → HTML 前 4096 bytes 的 meta charset → UTF-8；仅 HTML 使用 meta。冲突、替换字符数量及截断可观察；无效显式编码报错，不把乱码再次编码来“修复”。
- `assessContent({body, contentType, statusCode, replacementCount, truncated}) -> {state:'usable'|'title_only'|'empty'|'blocked'|'encoding_error', reason?}`。这是内容可用性判断，不是股票价格或任意事实的业务校验。
- 非 2xx 在 MIME 解码前保留 HTTP 状态；错误页文本可截取，但不能生成成功来源。短小而有效的 JSON/文本不能仅因长度而被判空。

- [x] **Step 1 — 编写失败用例。** `html_meta_charset_without_header` 断言 GB2312 fixture 提取含“光迅科技”且无替换字符；`http_error_without_content_type` 保留 403；`title_only_is_not_body` 识别只有 title 的 200；`short_json_is_usable` 接受 `{\"price\":1}`；既有代理、地址限制与取消用例继续通过。
- [x] **Step 2 — 运行确认失败。** Harness：`pnpm exec vitest run packages/web/web-fetch-http/tests/fetch-http.spec.ts packages/web/web-fetch-http/tests/proxy.spec.ts`；OpenNova：`node --test services/agent/tests/web-fetch-content.test.mjs services/bot/tests/research-fetch.test.mjs`。记录新断言失败，不以环境缺包为 RED。
- [x] **Step 3 — 实现公开扩展及质量判断。** 在既有地址验证/代理/重定向流程中传递 options，识别编码后再转换；给 `web_fetch` 返回质量元数据。只保留失败事实，不自动执行响应中的脚本。
- [x] **Step 4 — 验证源码及实际加载产物。** 运行上述测试；按 Harness 当前构建规则生成对应产物，再通过 OpenNova 的真实 import 路径复跑读取测试。接口源码成功但运行产物不支持时不得进入 R7。
- [x] **Step 5 — 独立提交与依赖记录。** Harness 提交读取器改动及必要文档；OpenNova 提交适配/测试，更新 `config/runtime-versions.json` 中对应 Harness 修订信息（按现有结构），保留原版本回滚记录。

## R7：通用 HTTP 工具与网络证据

**Files**
- Create: `services/bot/research/http.mjs`、`services/bot/research/http-tool.mjs`、`services/bot/tests/research-http.test.mjs`。
- Modify: `services/bot/research/runtime.mjs`、`config.mjs`、`sources.mjs`、`services/bot/host.mjs`。
- Test: `services/bot/tests/research-sources.test.mjs`、`research-runtime.test.mjs`、`research-config.test.mjs`。

**Interfaces**
- 新工具 `web_request({url, headers?, encoding?, responseType?:'auto'|'text'|'json'})`；首版仅 GET。允许的 header 名称不区分大小写：Accept、Accept-Language、Referer、User-Agent；拒绝 CR/LF、Cookie、Authorization 等字段。非秘密参数仍在来源中保留，脱敏不能改变实际调用语义。
- `executeResearchHttp(args, {requestId, callId, parentCallId?, signal, origin:'tool'|'shell-helper'}) -> HttpReceipt` 是唯一受观测接口取数入口，复用 R6 的 transport。receipt 包含宿主生成的 `receiptId/observationId`、请求及最终 URL、statusCode、contentType、encoding、retrievedAt、quality、truncated、模型片段及完整受限响应的 artifactPath/artifactHash。原响应 hash 在写入时计算；后续文件变化不能改写已保存的观察。
- JSON 模式解析失败返回 `invalid_json`；脚本 MIME 仅作为文本，不 `eval`。原始正文最大 2 MB 保存在 `output/research/requests/<requestId>/`，模型只接收有界片段及路径。错误响应保留记录但不进入成功来源。
- `sources.record()` 增加 `api_response` 类型与 HTTP 元数据，读取旧 `search_summary/page_body` 记录兼容；provider 对网页应为 `opennova-http`，不能把所有读取都记成 DeepSeek。

- [x] **Step 1 — 编写失败用例。** `referer_fetch_records_real_response` 验证带请求头取得受控行情样本且来源含实际 URL；`javascript_payload_is_text` 保留赋值文本、不产生执行副作用；`502_never_becomes_evidence` 不生成成功观察；`json_dates_preserved` 保留历史日期和原字段；`legacy_sources_still_read` 验证旧记录兼容。
- [x] **Step 2 — 确认 RED。** `node --test services/bot/tests/research-http.test.mjs services/bot/tests/research-sources.test.mjs services/bot/tests/research-runtime.test.mjs`。
- [x] **Step 3 — 实现工具、回执及来源接入。** 工具运行时、Shell 辅助命令后续调用均进入同一个函数；模型不能提交自己的 receipt/status 冒充宿主响应。工具允许列表与宿主注册一起更新。
- [x] **Step 4 — 验证。** 上述测试及 `research-config.test.mjs` 通过；增加本机脱敏响应 fixture，不依赖实时股价。此阶段先沿用现有读取预算，R9 统一调整。
- [x] **Step 5 — 提交。** 单独提交 HTTP 工具、来源协议和测试，补充 `services/bot/web/README.md` 中的响应类型说明。

## R8：研究脚本执行与 HTTP 辅助命令

**Files**
- Create: `services/bot/research/exec.mjs`、`services/bot/research/derivation.mjs`、`tools/research/http.mjs`、`services/bot/tests/research-exec.test.mjs`、`services/bot/tests/research-derivation.test.mjs`。
- Modify: `services/bot/controls.mjs`、`host.mjs`、`research/runtime.mjs`、`research/config.mjs`、`research/sources.mjs`。
- Test: `services/bot/tests/research-lifecycle.test.mjs`、`project.test.mjs`、`http.test.mjs`。

**Interfaces**
- `research_exec({command, workdir?, timeoutMs?})` 使用公开 `ctx.shell.resolve/execute`；不另建 Shell 实现，不替换原 `bash`。宿主创建 `executionId`，关联当前 requestId/callId，并向子进程注入 `OPENNOVA_RESEARCH_EXECUTION_ID` 及既有本机 Bot home/port 配置。
- HTTP CLI：`node tools/research/http.mjs --url URL [--header 'Referer: …'] [--encoding gbk] [--response-type json]`。读取上述上下文，通过已有认证 bridge 调用 `POST /research/http`，body 为 `{executionId, request:<web_request参数>}`；服务端检查该执行仍活跃且属于当前请求，调用 R7 入口。CLI 打印 receipt、artifactPath 及有界内容；HTTP 失败以非零退出。
- `/research/http` 复用现有认证，并且仅供活跃研究脚本调用。不能调用 `/ask` 再排队导致父 Shell 等待子请求死锁。网络信号与父 Shell、当前请求及研究预算组合，父 Shell 结束后撤销 executionId。
- `research_derive({executionId, observationIds, artifactPath, summary})` 仅把本轮已结束的成功研究执行、实际存在的受限输出文件与输入 observation 关联。产出独立 `kind:'research_derivation', evidenceType:'script_output'` 记录，包含宿主生成 id、requestId、executionId、inputObservationIds、artifactPath、artifactHash、summary；不调用要求 HTTP URL 的 `sources.record()` 伪造网页来源。它记录“脚本基于这些输入产生此结果”，不自动核验脚本算法。空输入列表允许保存未核验脚本输出，但不能生成已读接口标记；输入/输出文件变更时显示变化，不覆盖原观察。
- 普通 `bash/curl` 继续可用，沿用现有审计与取消；不自动把 stdout 中的 URL、价格或 exit 0 提升为网络 receipt。受观测助手与任意 Shell 的覆盖范围必须区分。

- [x] **Step 1 — 编写失败用例。** `helper_joins_parent_request` 核对父子 ID；`helper_502_exits_nonzero`；`late_helper_after_cancel_rejected`；`script_without_receipts_not_http_verified`；`derived_output_preserves_input_observations`；`ordinary_bash_still_works`。伪造的跨请求 observation 或 executionId 拒绝。
- [x] **Step 2 — 确认 RED。** `node --test services/bot/tests/research-exec.test.mjs services/bot/tests/research-derivation.test.mjs services/bot/tests/research-lifecycle.test.mjs`。
- [x] **Step 3 — 实现执行器、bridge 和 CLI。** 注册研究工具及执行上下文，传递已有 signal，记录 stdout/stderr/exitCode/耗时。用统一 helper 取 JSON 后，通过普通 Python/Node 脚本读取 artifact 并输出指定日期记录。
- [x] **Step 4 — 验证。** 上述用例与 `project.test.mjs`、`http.test.mjs` 通过；真实原生 Shell 运行 helper 的隔离集成测试验证退出、取消和完整进程回收，不开启麦克风。
- [x] **Step 5 — 提交。** 独立提交研究执行通道及 CLI 文档；不将测试生成的原始响应、令牌或脚本输出提交 Git。

## R9：自主工具选择、换源与研究预算

**Files**
- Modify: `services/bot/research/instructions.mjs`、`plugins.mjs`、`config.mjs`、`budget.mjs`、`runtime.mjs`、`sources.mjs`、`config/voice.example.json`。
- Test: `services/bot/tests/research-routing.test.mjs`、`research-budget.test.mjs`、`research-config.test.mjs`、`research-lifecycle.test.mjs`、`research-runtime.test.mjs`。

**Interfaces**
- 预算 snapshot 使用 `searchQueries/readCalls/researchExecCalls/elapsedMs/closed`，保留旧字段读取兼容。`claim(id,{kind:'search'|'read'|'exec',units,key,signal?})` 返回 lease；一个两 query 的搜索消耗 2，`web_fetch/web_request/helper` 各消耗一次逻辑读取，`research_exec` 自身不重复消耗内部 helper 的读取次数。
- 默认值采用 Global Constraints；批量搜索最多 2 query。统一入口的上限与原生插件实际配置一致，JSON 配置校验不再以旧 DEFAULT_LIMITS 将新值拒绝。缺失字段升级到新默认，已有有效显式配置保留。
- 搜索去重按每个规范化 query；读取按 URL、有语义的查询参数、有效非秘密 header、encoding、responseType 去重。首次无 Referer 403 后补 Referer 允许重试；相同失败请求不得无限重放。不同来源失败不再触发“连续两次读取失败就关闭所有读取”。
- 源记录保留 `queries[]`；只有 provider 能提供准确归属时才填单个 query，不把合并结果都归到第一个 query。无摘要保持为空，不能将辅助模型未经引用的总结补成事实摘要。
- 60 秒停止新研究调用、90 秒取消运行中的研究 Shell/HTTP。普通工程工具保留；任意 Shell 内部 HTTP 计数不作完整承诺，公开 usage 区分受观测网络和 Shell 执行。预算结束后提示 Agent 停止新增联网取数，可继续本地处理和工程任务；不把提示词约束描述成任意 bash 的网络沙箱。

- [x] **Step 1 — 编写失败用例。** `batch_query_cost_is_two`、`changed_referer_can_retry`、`two_failed_sources_allow_third`、`helper_counts_once`、`late_receipt_dropped`、`budget_keeps_engineering_shell`、`missing_key_still_allows_public_http`。使用假时钟核对 60000/90000 ms 边界。
- [x] **Step 2 — 确认 RED。** `node --test services/bot/tests/research-budget.test.mjs services/bot/tests/research-config.test.mjs services/bot/tests/research-routing.test.mjs services/bot/tests/research-lifecycle.test.mjs`。
- [x] **Step 3 — 更新规则和调度。** 移除“一概禁止 Shell 补充检索”；允许已知接口直接取数、失败换源、脚本处理和必要交叉核对。地区信源是偏好，不是只能访问几家站点；回答必须区分日期、字段与报价口径。检索 key 缺失只关闭搜索，公开 HTTP 和脚本处理按可用性分别开放。
- [x] **Step 4 — 验证。** 上述测试及 runtime 测试通过；隔离真实模型分别完成“读公开 JSON 并按日期筛选”和“检索后写报告”。检查实际工具路径，不以提示词包含几个词作为路由验收。
- [x] **Step 5 — 提交。** 提交预算、规则、配置与相关测试；记录新旧默认和任意 Shell 观测边界。

## R10：来源展示与语音状态

**Files**
- Modify: `services/bot/web/research-view.mjs`、`web/operation-card.jsx`、`web/api.mjs`、`research/reply.mjs`、`tools/voice/bot_agent.py`。
- Test: `services/bot/tests/research-view.test.mjs`、`research-reply.test.mjs`、`tools/voice/tests/test_bot_agent.py`。

**Interfaces**
- 扩展阶段 `requesting/processing/verifying`，显示“正在获取数据 / 正在处理数据 / 正在核对结果”；是否正在核对必须由实际执行阶段提供，不由最终文案猜测。
- 来源标签分别为“搜索摘要 / 已读取正文 / 接口响应 / 脚本处理结果”；HTTP 卡可查看请求状态与数据获取时间，脚本卡链接输入 observation。`projectResearchReply` 增加独立 `derivations[]` 字段，不给本地脚本产物伪造 HTTP URL；网页刷新和历史回查一起读取派生记录。没有可核验证据时明确显示其边界，不给“已核验”绿标。
- 同一请求的部分失败保留，最终取得其他有效来源时可以完成回答；`speechText` 不朗读原始接口 URL、脚本、异常堆栈或整段数据。

- [x] **Step 1 — 编写失败用例。** API 502、Shell exit 0 + helper 失败、仅标题、有效接口响应、派生结果五种卡片不混用状态；旧来源兼容；重复阶段按 callId 区分；刷新不重发请求。
- [x] **Step 2 — 确认 RED。** `node --test services/bot/tests/research-view.test.mjs services/bot/tests/research-reply.test.mjs`；`python3.11 -m unittest discover -s tools/voice/tests -p test_bot_agent.py -v`。
- [x] **Step 3 — 实现状态和来源展示。** 接入现有深空对话界面和语音进度事件，不增加控制模式或窗口。具体失败与可继续询问的状态使用已有错误展示机制。
- [x] **Step 4 — 验证。** 上述用例通过；在隔离 Bot 网页查看一次来源详情、脚本结果和旧记录，检查链接、换行及脱敏；语音事件自动化通过，真人听感留到 R11。
- [x] **Step 5 — 提交。** 只提交对应界面/语音变化，不混入已有桌面改动。

## R11：端到端验收、文档与日常部署

**Files**
- Create: `tools/bot/research-execution-probe.mjs`、`docs/research/opennova-research-execution-test-cases.md`。
- Modify: `docs/research/opennova-demo-architecture-status.md`、`docs/research/opennova-bot-research-test-cases.md`、`docs/research/opennova-mvp-development-deployment.md`。
- Evidence only: `output/bot/research-execution-verification/`（忽略 Git）。

**Interfaces**
- Probe 参数 `--scenario stocks|general|cancel|all --output PATH`，使用隔离 Bot home/port；沿用当前配置与密钥文件路径，不复制秘密到报告。输出每轮 `{id,input,status,tools,sources,failures,elapsedMs,checks}`，同时保存可回查的来源观察。
- 验收区分“回答正确且有证据”“如实报告失败”“未通过”；如实失败不能计入查到率。外部服务失败时不伪造通过，也不重试到成功后隐藏前面的失败。

- [x] **Step 1 — 固定可重复回归。** 用受控响应验证：HTML meta 编码、Referer 403→200、两家失败后第三家成功、HTTP 502 + Shell exit 0、旧日期报价不能满足目标日、最新报价与日 K 线不一致时保留差异、取消后迟到数据。股票 fixture 标为测试数据。
- [x] **Step 2 — 运行一次相关回归。** `OPENNOVA_HARNESS_ROOT=/Users/chenzhuoping/Documents/work/project/deepseek-harness node --test services/bot/tests/*.test.mjs services/agent/tests/*.test.mjs tools/voice/tests/*.test.mjs`；`python3.11 -m unittest discover -s tools/voice/tests -q`。记录实际数量；已有失败单独定位，不通过修改期望掩盖。
- [x] **Step 3 — 真实文字验收。** 华润微、光迅科技、华工科技各执行三次最近周五收盘查询，另测明确指定的较早历史日期；记录日期、原字段、来源和耗时。再测天气、官方软件资料、公开非金融 JSON + 脚本处理。工作浏览器关闭时可完成后台任务；显式“打开网页”仍走现有浏览器工具。
- [ ] **Step 4 — 故障及跨轮验收（自动化与重启回查已完成；真人语音/网页跨轮待验收）。** 在受控响应下令一个来源失败，确认换源；停止正在运行的脚本/HTTP 后启动新轮次；网页追问语音查询的来源；宿主重启后回查 observation；预算用尽后仍能保存报告、修改代码和运行测试。
- [x] **Step 5 — 更新部署与真人验收说明。** 文档标注实际能力和任意 Shell 的观测边界。确认日常 Bot 空闲且无语音连接后才更新，保留 home、会话、浏览器配置和启动参数；忙碌时完成部署准备但不终止用户会话。重启后检查 health，再请用户用既有设备完成语音、停止、插话和来源追问验收。
- [x] **Step 6 — 提交验收文档。** 记录已跑与未跑检查、外部失败和版本依赖；部署文件与日志不混入提交。回滚同时恢复 OpenNova 与对应 Harness 构建，保持 SQLite 来源新旧读取兼容。

## 执行前后自检

- 本轮已实施并调用真实搜索/模型验证；失败尝试完整保留。具体结果、版本、实施取舍与未跑的真人验收见 [验收记录](../../research/opennova-research-execution-test-cases.md)。
- R6 的公开 HTTP 扩展是 R7/R8 的依赖，必须在实际加载的 Harness 构建上验证；不能用另一个 Harness UI 的表现代替。
- R8 中 Shell 的 HTTP 请求复用 R7 入口，R9 统一预算；普通工程 Shell 保持独立。R10 只展示实际记录，不能把进度或最终自然语言当证据。
- 先完成底层与受控测试，后启用模型路由，最后真实网络/语音验收；专用行情工具、额外搜索服务和自动浏览器兜底另行评估。

实施补充：HTML 提取与原始接口响应按不同读取表示去重；成功和失败 HTTP 混合的脚本保留 partial 取数状态，允许关联有效输入，不代表所有子请求成功。所有审查问题已修复；未增加专用行情核验器。
