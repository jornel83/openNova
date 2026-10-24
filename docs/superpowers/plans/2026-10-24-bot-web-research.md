# OpenNova Bot 联网研究开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DeepSeek 搜索、公开网页正文读取、可追溯来源和检索预算接入当前 Bot，让语音与文字共用后台检索能力。

**Architecture:** 在现有 DeepSeek-Bot / Harness 工具循环中注册 `web_search` 和 `web_fetch`，复用现有搜索 provider 和正文提取器。新增 Bot 请求级检索管理，接入现有 SQLite 操作记录、请求取消和网页事件；GPT-6.1 Sol 继续承担理解、工具选择和回答。

**Tech Stack:** 现有 Node 24 / ESM、DeepSeek Harness Web 插件、Bot bridge SQLite、React 对话界面、Python 语音客户端。

**Spec:** 本轮用户要求及下文“范围与交互约定”。[旧搜索设计](../specs/2026-10-13-agent-web-search-design.md)和[旧开发计划](2026-10-13-agent-web-search.md)仅提供实现背景；其中 Exa 优先、仅 `--web` 模式、禁止工程工具及整轮 90 秒的约束不适用于本计划。

**状态：** 2026-10-24，R1–R5 已实施并完成自动化回归与隔离真实 API 联测；最终代码审查的两项问题已补测试修正。实际证据与真人语音验收边界见 [联网研究验收](../../research/opennova-bot-research-test-cases.md)。下文保留已执行的任务与接口约定。

## 范围与交互约定

| 用户意图 | 首选执行路径 | 用户看到的结果 |
| --- | --- | --- |
| 北京今天几度、查最新版本、比较公开技术资料 | `web_search`，需要时 `web_fetch` | 对话窗口显示结果和来源；不因查询新开或导航工作窗口 |
| 读这个公开链接并总结 | `web_fetch` | 后台读取，展示摘要和来源 |
| 打开网站、操作网页、看看当前页面 | 现有 `browser_*` | 在工作窗口打开、读取或操作网页 |
| 查资料后修改工程或写报告 | 搜索/读取 → 工程工具 | 共用同一请求与上下文，保留正常代码开发能力 |
| 刚才的结论来自哪里 | 已保存的本轮/历史来源 | 解释来源及当时查到的内容；只有要求更新或证据不足时重新检索 |

- 普通查询不会因为已有工作页面而改走浏览器。后台抓取失败时说明限制；用户明确要求使用可见页面时才切换浏览器。
- 搜索摘要含明确日期、对象和所需事实时可直接回答，并标注“依据搜索摘要”；不强制每次抓取全部来源。
- “今天/昨天/下周五”结合请求时刻、Asia/Shanghai 与上下文解释；未给年份且无矛盾时采用当前年并在结果中注明。歧义实际影响答案时再澄清。
- 普通闲聊不检索；来源中的发布时间、事件日期、获取时间分别处理。天气等实时问题不把历史缓存当作最新结果。
- 本轮包含公开 HTML / 文本网页，不扩展 PDF/OCR、登录墙绕过、验证码处理、长时间自主研究、多 Agent 或定时监控。
- 实施路线采用现有 Harness 搜索 provider + OpenNova HTTP 正文读取。另一条路线是改为 DeepSeek 独立 Search/Fetch API；它属于后续 provider 替换，本轮不同时引入，以便单独判断 Bot 整合是否成功。

## Global Constraints

- 沿用当前 Bot、GPT-6.1 Sol、持久会话、语音链路和工程直接执行权限；不另起一套检索 Agent，不增加确认流程。
- 使用 `loadSettings().harnessRoot` 对应的固定安装版本验证插件接口；不能用另一个源码检出的新接口推定运行环境已支持。
- 配置沿用顶层 `web` 与 `config/secrets.local.json` 的 `web.deepseek_api_key`，环境变量 `DEEPSEEK_API_KEY` 优先；不把密钥写入 patch、会话、日志或版本库。
- 当前 Bot 在配置开启时加载搜索能力，无需另开 `--web` 会话。关闭检索或配置缺失时普通对话、浏览器和工程功能仍可用，并明确报告检索不可用。
- 搜索及正文读取接入已有外网代理配置；回环 API、Studio TTS 和桌面桥接继续使用现有路由。
- 所有工具事件、来源观察、预算、耗时与取消都关联 `requestId` / `callId`。取消后的迟到数据不得进入新请求、来源或播报。
- 网络正文视为外部资料，保留原抓取器的 URL、地址和重定向限制；不从网页内容获得 Shell 或工程写入授权。
- 限制仅作用于 `web_search` / `web_fetch`。现有工程任务总时限 `600000 ms` 保留；不得原样挂接旧 `web-policy.mjs` 的“关闭全部工具”或旧 `90000 ms` 请求时限。
- 保留当前 `settled-answer` 播报方式，先得到完整答复再播报。来源链接和正文不自动朗读。

## Review Focus

1. 工作窗口关闭或浏览器扩展断开时，后台检索仍可完成；查询不能意外激活浏览器。
2. 检索预算耗尽后，混合任务仍可保存报告、修改代码和运行测试；不能清空整个工具集合。
3. 停止、语音插话及宿主重启期间的迟到工具结果不能串入新请求，重连也不能重复发起计费请求。
4. 同一 URL 的旧摘要和新正文必须保留各自获取时间；失败抓取不能标记成已读正文，来源链接真实存在也不等于其中支持每个结论。
5. 网页混入命令、正文为空、页面重定向、日期缺失或正文截断时，不能执行网页指令或把不完整证据说成已经核验。

## 任务与依赖

| 里程碑 | 交付内容 | 依赖 |
| --- | --- | --- |
| R1 搜索接入 | Bot 可以通过 DeepSeek 后台搜索，记录实际工具调用 | 无 |
| R2 正文读取与路径选择 | 公开网页可后台读取，查询和可见页面操作各走对应路径 | R1 |
| R3 来源管理 | 来源、证据状态和引用持久化，可跨语音/文字追问 | R2 |
| R4 预算与取消 | 限次数、限时间、去重、受控收尾，停止后不串结果 | R1–R3 |
| R5 界面联调与验收 | 来源卡片、检索状态、一键启动检查、语音与现有工作能力回归 | R1–R4 |

R1/R2 的中间版本只用于受控测试；R4 完成后再作为日常 Demo 的默认联网能力。

## R1：接入 DeepSeek 搜索

**Files**
- Create: `services/bot/research/config.mjs`、`plugins.mjs`、`runtime.mjs`。
- Modify: `services/bot/launch.mjs`、`host.mjs`、`policy.mjs`；`config/voice.example.json`。
- Reuse: `services/agent/web-config.mjs` 与 `web.patch.yml` 中的 Web/provider/tool-web 插件配置。
- Test: `services/bot/tests/research-config.test.mjs`、`research-runtime.test.mjs`，扩展 `harness.test.mjs`。

**Interfaces**
- `loadResearchConfig({env, configFile, secretsFile}) -> {enabled, provider, available, reason?, limits, childEnv}`：只选择 DeepSeek；公开状态不含 `childEnv` 或密钥。
- `researchPlugins({harnessRoot, enabled}) -> PluginSpec[]`：组合已有 Web 插件，使用固定版本实测有效的辅助搜索模型标识。
- `installResearch(ctx, {ops, requests, config}) -> {begin(active), finish(requestId), health(), close()}`：拥有当前请求的检索生命周期，`begin/finish` 在 `host.run()` 的 try/finally 中调用。
- 搜索工具保持原生 `web_search({queries: [query]})` 协议；每次一个查询、最多 5 条结果；原生元数据中的真实 URL 和摘要回传给模型。

- [x] **Step 1 — 编写失败测试。** `enabled_bot_registers_search_without_losing_project_tools` 验证搜索和原有 `read/write/bash/browser_open` 同时存在；`missing_key_only_disables_research` 验证无密钥时不注册搜索且其他工具可用；`child_env_exposes_only_selected_credential` 验证配置输出、健康接口和日志没有密钥。
- [x] **Step 2 — 运行测试确认未接入。** `node --test services/bot/tests/research-config.test.mjs services/bot/tests/research-runtime.test.mjs`；预期因新接口缺失或工具未注册失败。
- [x] **Step 3 — 实现插件和请求接线。** 对照实际安装的插件配置 schema 注册搜索，将 `web_search` 加入有效工具集合和模型投影；沿用受控环境变量传入密钥。将调用、结果、失败、耗时记入 `kind: tool, operation: research` 的操作记录。`/health` 返回 `{research:{enabled,available,provider,reason?}}`，健康检查不发计费搜索。
- [x] **Step 4 — 验证。** 上述测试加 `harness.test.mjs` 通过；隔离 Bot 的文字入口实际查一次当前北京天气，记录 DeepSeek provider、真实调用和来源 URL。即使浏览器未连接也能执行，不调用 `browser_open`。真实 API 验证不纳入普通单元测试。
- [x] **Step 5 — 完成独立提交。** 仅提交本任务文件，记录固定 Harness 版本和辅助搜索模型；不得混入已有桌面功能改动。

## R2：后台正文读取与工具路径选择

**Files**
- Modify: `services/bot/research/plugins.mjs`、`runtime.mjs`、`services/bot/policy.mjs`。
- Create: `services/bot/research/instructions.mjs`。
- Reuse: `services/agent/web-fetch-content.mjs`。
- Test: `services/bot/tests/research-fetch.test.mjs`、`research-routing.test.mjs`。

**Interfaces**
- 注册原生 `web_fetch({url})`，使用 `opennova-http` provider；保留最终 URL、状态码、截断标记与正文。
- `researchInstructions({now, timeZone, enabled, state}) -> string`：提供动态日期、查询/页面操作的路径说明、摘要与正文使用规则及检索收尾状态；不覆盖原有工程权限和桌面操作说明。
- 失败分类统一为 `unavailable/auth/rate_limited/timeout/blocked/empty/unsupported/cancelled`；重定向前后 URL 单独保留。

- [x] **Step 1 — 编写失败测试。** `fetch_preserves_tables_and_final_url` 检查天气表格和重定向元数据；`empty_or_blocked_body_is_not_success` 检查 HTTP 200 空页、403 和只含导航页；`query_does_not_require_desktop`、`explicit_open_keeps_browser_tools`、`relative_dates_follow_injected_clock` 固定两类路径及跨年日期上下文；网页中的 Shell 指令仅作为资料返回。
- [x] **Step 2 — 运行。** `node --test services/bot/tests/research-fetch.test.mjs services/bot/tests/research-routing.test.mjs`，确认失败来自待实现的接线。
- [x] **Step 3 — 实现。** 加载正文 provider 和 `web_fetch`；工具描述明确后台读取与当前页面读取的区别。精准查询优先 1 次搜索，必要时读 1 个来源；正文被拦截可使用其他来源或标明摘要证据，不反复询问已确定的城市、日期、年份。
- [x] **Step 4 — 验证。** 测试通过后，用真实模型分别执行“查天气”“总结公开链接”“打开天气网站”“读取当前页面”。确认前两者不导航工作窗口，后两者保留现有桌面行为。提示词单测不能替代真实模型路由验收。
- [x] **Step 5 — 独立提交。** 记录正文可读、被拦截、摘要足够三类结果，不将所有链接均可读写成能力承诺。

## R3：来源管理与跨轮引用

**Files**
- Create: `services/bot/research/sources.mjs`、`reply.mjs`。
- Modify: `services/bot/research/runtime.mjs`、`services/bot/host.mjs`、`controls.mjs`、`policy.mjs`。
- Reuse: `Operations.put/get/list`；参考 `services/agent/web-events.mjs`、`web-links.mjs`。
- Test: `services/bot/tests/research-sources.test.mjs`、`research-reply.test.mjs`。

**Interfaces**
- `createSources({ops, botId, workspace}) -> {record(observation), forRequest(requestId), resolve(ids), resolveUrls(urls), forReply(requestId, text)}`。
- Source：`id, botId, workspace, canonicalUrl, title`；按 Bot + 工程 + 规范 URL 去重，生成并持久化稳定 ID，不随 Harness 会话分段重新编号。
- Observation：`id, sourceId, requestId, callId, provider, query?, requestedUrl, finalUrl, retrievedAt, publishedAt?, publishedAtRaw?, eventDate?, evidenceType, excerpt, truncated, status`。`evidenceType` 为 `search_summary` 或 `page_body`；来源日期不明时保留未知，不能把“3 小时前”直接当 ISO 发布时间。
- 记录每次观察，不用新数据覆盖历史请求的证据。规范化移除 fragment、统一 URL 序列化；保留有语义的查询参数，不做激进去参或合并页面。
- `projectResearchReply({text, requestId, sources}) -> {text, speechText, sources, research}`；最终来源引用绑定到具体 observation，`research` 包含检索状态和预算统计。
- 新增只读工具 `research_sources({requestId?, sourceIds?})`，二选一；都省略时读取同 Bot、同工程最近一个已完成的检索请求。返回最多 10 项来源及对应 observation 的证据片段；不发网络请求、不消耗检索预算。异 Bot/工程或未知 ID 明确返回未找到。通过该工具让跨轮追问可以取回真实持久证据，不依赖模型记住全部历史。

- [x] **Step 1 — 编写失败测试。** `same_url_keeps_old_and_new_observations`、`restart_retains_source_ids`、`cancelled_result_cannot_create_observation`、`failed_fetch_does_not_upgrade_summary`、`unknown_citation_not_promoted_to_source`、`project_and_browser_links_survive_projection`、`source_lookup_reads_only_requested_scope_without_network`。对同 URL 跨日查询验证旧结果不被静默改写。
- [x] **Step 2 — 运行。** `node --test services/bot/tests/research-sources.test.mjs services/bot/tests/research-reply.test.mjs`，确认缺失来源存储和投影行为。
- [x] **Step 3 — 实现。** 使用新记录种类 `research_source` / `research_observation` 存入现有 SQLite；每份 observation 的证据片段最多 12,000 字符，保留截断信息，不保存整份 HTML。注册并放行 `research_sources`，其结果带原获取时间；仅将实际引用的来源放入答复，不把搜索到的全部 URL 都当作引用。来源记录保存供追溯，不作为天气等实时查询的自动缓存。
- [x] **Step 4 — 验证。** 测试通过；语音查询后在网页追问来源，再重启宿主读取已保存结果，来源可恢复。来源元数据只证明取得过资料；用固定事实夹具和人工抽查检查回答是否受证据支持。不要直接套旧 `projectWebReply` 的全局链接删除逻辑，以免删掉工程文件或浏览器的合法链接。
- [x] **Step 5 — 独立提交。** 补充记录结构和恢复说明；原始密钥、完整响应头和无限量正文不进入记录。

## R4：检索预算、收尾与取消

**Files**
- Create: `services/bot/research/budget.mjs`、`policy.mjs`。
- Modify: `services/bot/research/config.mjs`、`runtime.mjs`、`services/bot/host.mjs`。
- Reference only: `services/agent/web-budget.mjs`、`web-policy.mjs`；不直接加载旧策略。
- Test: `services/bot/tests/research-budget.test.mjs`、`research-lifecycle.test.mjs`；扩展 `requests.test.mjs`。

**Interfaces**
- `createResearchBudget({limits, now, timers}) -> {open(requestId,{signal}), claim(requestId,{name,args,callId}), snapshot(requestId), finish(requestId)}`。
- `claim` 同步占用次数，返回 `{signal, finish}`；超限/重复调用返回受控错误。只接受 Web 工具，非 Web 工具直接通过 Bot 原有链路。
- `installResearchPolicy(ctx,{budget,getActive,onStatus,onResult})`：关联工具调用和 Bot 请求；工具完成、取消、超时、宿主关闭均清理监听与定时器。

| 初始预算 | 数值/行为 |
| --- | --- |
| 搜索 | 每请求最多 2 次，每次 1 query、最多 5 个来源，单次最多 15 秒 |
| 正文 | 每请求最多 3 次，单次最多 10 秒；沿用正文 11,000 字符、工具输出 12,000 字符上限 |
| 总检索窗口 | 从第一项 Web 工具开始 45 秒，包含工具间模型思考时间 |
| 收尾 | 到第 30 秒停止发起新 Web 请求；已启动工具仍受其单次时限及 45 秒总上限限制 |
| 去重与失败 | 同请求相同规范 query/URL 不重试；连续 2 次正文失败停止继续读取，返回已得证据和缺失项 |
| 重试 | 首版无透明自动重试；换查询或换 URL 占用下一次预算；401/配额不足不重试 |
| 整轮任务 | 保留 Bot 的 600 秒；检索用尽只关闭本请求 Web 工具，不关闭文件、Shell 或显式桌面操作 |

预算数值不是端到端回复时延承诺：模型总结和 TTS 的时间独立统计。首版不承诺长期、无限轮次的研究。

- [x] **Step 1 — 编写失败测试。** 假时钟验证第 3 次搜索/第 4 次抓取被拒绝、并发领取无超额、30 秒不再发新请求、45 秒取消在途 Web 请求；`research_exhaustion_keeps_write_and_bash_available` 验证工程工具未被清空；`cancel_drops_late_results_and_next_request_resets` 验证新轮次预算和来源独立；取消期间的模型/工具收尾沿用现有串行准入。
- [x] **Step 2 — 运行。** `node --test services/bot/tests/research-budget.test.mjs services/bot/tests/research-lifecycle.test.mjs services/bot/tests/requests.test.mjs`。
- [x] **Step 3 — 实现。** 父级用户取消传播到检索子信号；检索超时只中止子信号，不调用 `requests.cancel` 终止整个混合任务。向模型回传“检索已结束、已有证据、缺失项”，在纯查询中转为回答，在混合任务中继续用户要求的工程操作。搜索失败不能自动以浏览器或 Shell 绕过预算。
- [x] **Step 4 — 验证。** 各取消阶段、超时、空结果、限流、断网测试通过；“查询后写 Markdown 报告”即使来源部分失败也能保存有出处和限制说明的结果。`/stop`、有效语音插话后，旧结果不写入新轮次也不播报。
- [x] **Step 5 — 独立提交。** 记录实际用量字段：搜索/抓取次数、各工具耗时、模型等待、Agent 总耗时和结束原因。没有供应商计费回执时不显示推测费用。

## R5：网页、语音与启动流程统一验收

**Files**
- Create: `services/bot/web/research-sources.jsx`。
- Modify: `services/bot/web/app.jsx`、`app.css`、`operation-card.jsx`、`voice-state.mjs`、`api.mjs`；`tools/voice/bot_agent.py`、`tools/voice/start.mjs`。
- Test: `services/bot/tests/research-view.test.mjs`，扩展 `voice-view.test.mjs`、`web-controls.test.mjs`、`tools/voice/tests/test_bot_agent.py`、`launcher.test.mjs`。
- Docs: `docs/research/opennova-demo-architecture-status.md`、`opennova-mvp-development-deployment.md`；新建 `opennova-bot-research-test-cases.md`。

**Interfaces**
- 请求记录 `research.phase` 为 `searching/reading/summarizing/finished`，`research.outcome` 为 `complete/partial/unavailable`；用户主动取消仍使用现有请求 `cancelled` 状态。
- `ResearchSources({sources})` 展示标题、链接、摘要/正文依据、已知发布时间与获取时间；缺失字段不补造。
- 沿用 `request.updated` / `operation.updated` 和 `/snapshot`、`/result`，不另建第二套连接。完成请求返回 `text/speechText/sources/research`。
- Python 客户端将实际检索阶段映射到现有 `status` 事件的 `searching/reading/answering`；同一工具再次调用以 `callId` 或操作 ID 区分，不只比较工具名称。

- [x] **Step 1 — 编写失败测试。** `source_cards_restore_from_snapshot`、`speech_omits_urls_and_citation_marks`、`two_search_calls_produce_distinct_progress`、`disabled_research_keeps_normal_startup`、`ring_label_matches_request_phase`；旧请求没有 `sources/research` 时仍正常显示。
- [x] **Step 2 — 运行。** `node --test services/bot/tests/research-view.test.mjs services/bot/tests/voice-view.test.mjs services/bot/tests/web-controls.test.mjs tools/voice/tests/launcher.test.mjs`；`python3.11 -m unittest discover -s tools/voice/tests -p test_bot_agent.py`。
- [x] **Step 3 — 实现。** 复用深空对话界面，在回复下显示来源、在原操作卡展示检索记录；环形 Nova 沿用思考态，仅状态文案显示“正在联网搜索/正在读取资料/正在整理回答”。TTS 只播报简短结论。启动检查显示检索是否可用，复用旧 Bot 时核对运行能力，避免声称已接入而实际仍在旧进程。
- [x] **Step 4 — 综合验证。** 运行 `node --test services/bot/tests/*.test.mjs services/agent/tests/*.test.mjs tools/voice/tests/*.test.mjs` 与 `python3.11 -m unittest discover -s tools/voice/tests -q`。以隔离测试状态执行下表真实流程，保留脱敏操作记录和阶段耗时，确认家中 TTS/云端 TTS 的来源和播报行为一致。
- [x] **Step 5 — 独立提交和文档更新。** 更新架构、部署和验收说明；以真实测试结果记录可用性及限制。合并前检查已有浏览器/工程能力回归，提交范围不包含用户其他未提交内容。

## 用户验收场景

| 编号 | 测试指令/动作 | 通过标准 |
| --- | --- | --- |
| NET-01 | 北京今天几度？ | 实际后台检索，区分当前温度与全天高低温；来源有日期，不新开/切换工作页面 |
| NET-02 | 北京下周五天气怎么样？ | 日期解释正确，返回对应预报；不把本周五或今年其他日期混入 |
| NET-03 | 总结一个公开文章链接 | 后台读取正文；来源标明正文读取；不弹工作窗口 |
| NET-04 | 刚才的数据来自哪里？ | 语音查完后文字追问能指向同一证据；重启后历史来源仍可查 |
| NET-05 | 打开中国天气网，看看当前页面 | 可见浏览器仍能操作；与普通后台查询行为有明确区别 |
| NET-06 | 查一个技术方案，整理到工程里的 Markdown 文件 | 来源可追溯，文件实际保存；预算达到上限也不误杀工程工具 |
| NET-07 | 检索中说“停一下”，接着问一个新问题 | 取消旧轮次、下一轮正常；没有旧来源和旧播报混入 |
| NET-08 | 浏览器关闭/扩展断开后问天气 | 搜索可用；结果不依赖桌面浏览器连接 |
| NET-09 | 模拟网页 403、空结果、超时、429 | 有明确状态和受控收尾；不无限重试，不把失败说成成功 |
| NET-10 | 网页刷新、语音转文字再追问；普通闲聊、代码开发 | 来源与上下文一致；不重复搜索计费；原有功能回归通过 |

实时答案取决于来源质量和网络。自动化测试固定数据验证逻辑，现场验收验证当时的检索质量；不能用缓存答案或固定天气数字代替真实验收。

## 实施和交付顺序

按 **R1 → R2 → R3 → R4 → R5** 实施，每项有独立测试与提交。R2 完成时可进行第一次受控文字演示；R5 完成后再做语音及日常 Demo 验收。首版交付后台查询闭环，后续再评估独立 Search/Fetch API、专用天气数据源和更长的研究任务。
