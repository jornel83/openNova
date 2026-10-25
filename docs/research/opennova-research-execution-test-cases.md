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

自动化及真实网络结果将在开发完成后写入本节。实时数据正确性以保存的响应字段核对为准，不能单凭模型自述或 HTTP 200 判为通过。
