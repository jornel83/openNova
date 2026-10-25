# 通用联网研究验收（R6–R11）

范围：DeepSeek 搜索、网页读取、公开 GET 接口、原生研究 Shell、来源和脚本结果回查。工作浏览器不需要启动；只有明确要求打开网页才走浏览器。

## 已实现能力

- `web_fetch`：识别 HTML 中的 GB2312 等编码；只有标题、空白、明显解码错误不作为可用正文。
- `web_request`：可传 Accept、Accept-Language、Referer、User-Agent、编码和 JSON/文本模式；记录实际 HTTP 状态、获取时间、原始受限响应路径和 SHA-256。JavaScript 响应仅作为文本。
- `research_exec`：使用原生 Harness Shell 执行研究脚本，提供 `OPENNOVA_RESEARCH_OUTPUT_DIR`。脚本调用 `node tools/research/http.mjs --url URL` 时，网络请求加入当前研究记录和预算。
- `research_derive`：把成功执行的脚本输出与本轮真实 HTTP observation 关联。它不核验脚本算法，也不把普通 stdout 自动升级成接口来源；文件变化保留旧指纹并显示提醒。
- `research_sources`：回查来源和脚本结果。网页与语音使用同一个 Bot 会话。

默认每轮 2 个搜索 query、6 次读取、4 次研究脚本；单搜索 15 秒、单 HTTP 10 秒、研究 Shell 默认 45 秒（单次可指定至 90 秒）；60 秒后停止新增研究，90 秒中止仍在运行的研究。普通工程 Shell 不计入研究预算，内部自行联网也不能承诺完整观测；Agent 被要求在预算结束后停止新增联网，仍可处理已有数据和开发工程。

## 自动化验证

使用 Node 24，明确设置本机 Harness 路径：

```sh
OPENNOVA_HARNESS_ROOT=/Users/chenzhuoping/Documents/work/project/deepseek-harness \
  /opt/homebrew/opt/node@24/bin/node --test services/bot/tests/research-*.test.mjs services/agent/tests/web-fetch-content.test.mjs
python3.11 -m unittest discover -s tools/voice/tests -p test_bot_agent.py -q
```

真实探针会启动独立 Bot home、随机空闲端口，不打开麦克风或浏览器。沿用配置与密钥路径，原始响应和报告存入 Git 忽略的 output 目录：

```sh
OPENNOVA_HARNESS_ROOT=/Users/chenzhuoping/Documents/work/project/deepseek-harness \
OPENNOVA_CONFIG=/Users/chenzhuoping/Documents/work/project/openNova/config/voice.local.json \
OPENNOVA_SECRETS_FILE=/Users/chenzhuoping/Documents/work/project/openNova/config/secrets.local.json \
OPENNOVA_PROXY=http://127.0.0.1:7897 \
/opt/homebrew/opt/node@24/bin/node tools/bot/research-execution-probe.mjs \
  --scenario all --output output/bot/research-execution-verification/report.json
```

可选场景 `stocks / general / cancel / all`。股票共 9 次重复查询及一次较早历史日查询；通用场景包含天气、Python 官方资料、GitHub JSON + 脚本、保存报告及来源追问。探针保存所有尝试，不隐藏失败。`review_required` 表示链路完成后仍须对照原始字段核验事实；`graceful_failure` 是明确未查到，不计为查到；取消场景可按实际取消状态判定通过。

## 真人语音验收

| 编号 | 说法 / 操作 | 预期 |
| --- | --- | --- |
| R11-01 | “查一下华润微最近周五收盘价，告诉我具体交易日期。”连续查询三次 | 后台查询；核对代码、日期与收盘字段；能说明真实来源或如实说明缺失 |
| R11-02 | “查光迅科技和华工科技最近周五收盘价。” | 国内可靠来源优先，允许换源；不把检索摘要无依据的数值当正文核验 |
| R11-03 | “改查上上周五。” | 使用历史数据，不直接复用最新报价；说明明确日期及口径 |
| R11-04 | “今天北京最高最低几度？” | 后台搜索或读取；不打开工作窗口；回答预报日期 |
| R11-05 | “查 Python 官方 TaskGroup 文档，告诉我作用。” | 给官方链接；文字保留来源，语音不念原始 URL |
| R11-06 | 文字输入探针里的 GitHub JSON 任务 | 接口 → 脚本 → 文件 → 结果关联；展开来源能看到输入观察和脚本结果 |
| R11-07 | 执行中说“停止”，再提出新问题 | 旧研究结束，迟到数据不进入新轮；新问题可继续 |
| R11-08 | 语音问完后在网页追问“刚才的数据来源是什么？” | 读取已有来源，保持原获取时间，不为回忆而重新检索 |
| R11-09 | 刷新网页，再展开来源 | 历史结果保留；没有重发查询；更改过的脚本输入/输出会标注变化 |
| R11-10 | “把刚才结果写成报告，再运行一个本地检查。” | 研究预算不阻止写文件和工程 Shell；无需二次确认 |

办公室 / 家庭的原一键启动参数继续适用。本轮真人麦克风、TTS 听感和插话由用户现场验收，自动化不代替实际听感。

## 部署与回退

Harness 的 HTTP 扩展已在独立分支提交；OpenNova 的 `config/runtime-versions.json` 与 `services/bot/settings.mjs` 共同固定修订。升级需构建 HTTP 包 TypeScript 与 JS 产物，不能只修改源码；恢复旧版时同时恢复 OpenNova 版本和该 JSON 中的 `previous_revision` 对应 Harness 构建。不要直接切换有未提交改动的 checkout。

日常 Bot 只有在无活跃任务且无语音连接时才重启；保留 home、SQLite、会话和浏览器配置。新版本来源/派生记录使用独立记录类型，旧记录继续可读；回退后旧界面不会显示新增派生记录，但不要删除数据库。

## 本次执行记录

2026-10-25：R6–R10 开发、R11 自动化和隔离文字验证完成，日常 Bot 已升级；真人语音验收仍待用户完成。

| 检查 | 实际结果 |
| --- | --- |
| OpenNova Node 24 相关全量回归 | 259/259 通过 |
| Python 语音回归 | 103/103 通过 |
| Harness HTTP 包测试 | 74/74 通过；TypeScript 检查和实际 JS 构建通过 |
| 华润微、光迅科技、华工科技各三次重复查询 | 8/9 次取得目标日历史日线并与答案核对；首次华润微未查到，保留失败 |
| 华润微较早历史日查询 | 1/1 取得目标日记录，与最新日期分开核对 |
| 北京天气 | 未查到：搜索有链接但无温度摘要，正文及接口不可用；未报告未经核实的温度 |
| Python 官方文档 | 读到 TaskGroup 示例与 3.11 引入版本的正文 |
| GitHub JSON → helper → 研究脚本 → 派生结果 | 通过；输出 full_name/default_branch 与原始接口字段一致；初次错误的 timeoutMs 被拒绝，后续修正成功 |
| 保存报告、工程 Shell 检查 | 通过；write 保存且 bash 文件存在检查退出码 0，没有新增联网 |
| 历史来源追问 | 通过；持久化 research_usage 关联原 observation，无新联网调用 |
| 重启与网页刷新 | 同一隔离会话、来源和派生记录仍可读取；输入/输出 hash 未变化；网页可展开接口证据与脚本结果，未重发查询 |
| 取消 | 修复后真实模型停止探针通过；原生 Shell 忽略 TERM 的受控测试确认工具返回前进程已回收 |

重复股票查询共享一个隔离会话，每次重新取数；这验证同会话连续使用，不代表独立冷启动成功率。结果来自腾讯历史日线，本轮没有证明所有国内网站都可读取，也没有新增股票专用核验器。原始日期、代码、未复权 day 字段及 hash 已逐条对照；这不是投资判断。

详细证据保存在本机忽略 Git 的目录：

- [首次真实探针（保留全部失败）](../../output/bot/research-execution-verification/first-live.json)
- [字段核对结果](../../output/bot/research-execution-verification/reviewed-summary.json)
- [修复后停止探针](../../output/bot/research-execution-verification/post-review-cancel.json)
- [实际生成的研究报告](../../output/research/acceptance-report.md)

代码审查发现的 4 项问题均已修复并补回归：取消时等待进程回收；接口原始产物保留 2 MB 上限而不受 50 万字符 HTML 限额误截断；脚本换源成功后可以登记结果并保留失败请求；错误页无效 meta charset 不覆盖真实 HTTP 状态。另修复网页提取与原始接口读取被错误视为同一次重复请求的问题。

部署记录：日常 `18564` Bot 在空闲、无语音连接时重启，research version 为 2；原 home、会话和桌面入口保留。使用已有一键启动命令和麦克风/TTS 参数即可；本轮未启动麦克风。OpenNova 实现提交 `9f6e343`，Harness 依赖 `cccbe9cb4763f597bfb83129ca03345c3fbead1b`；改动保留在本地分支，尚未推送。

### 实施取舍和待验收

- Harness 使用已有干净 checkout 的独立开发分支，保留原修订用于回退；OpenNova 原有未提交桌面/网络改动保留，本轮提交未混入这些改动。
- `research_derive` 显示“处理数据”，只登记输入与输出关联，不冒充自动核验算法。
- 脚本 exit 0 且取得过成功 HTTP 时可完成；若同时有失败 HTTP，记录 `httpOutcome=partial`，失败响应仍不能成为成功来源。exit 0 且 HTTP 全部失败仍返回失败。
- 默认 60 秒关闭新增研究调用、90 秒取消在途研究；普通工程 bash 保持原权限，内部任意联网不承诺完整计数。
- 尚未现场验收：真人 TTS 听感、语音插话/停止后的连续交互、语音问完后网页追问。天气查询本次未成功；外部来源可用性与模型选源仍会造成失败。
