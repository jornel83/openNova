# DSH 原生联网接入：启动与验收

2026-10-25。默认 research version 3 / mode native，DSH 固定 cccbe9cb。主对话仍使用 GPT-6.1 Sol，搜索由 DeepSeek 辅助模型完成。

## M1–M4 完成记录

| 里程碑 | 已完成 |
|---|---|
| M1 原生基线与配置 | 直接注册并实测 DSH 工具；默认 native、显式 legacy 回退；主模型与 DSH 提交保持不变 |
| M2 联网执行 | 使用原生搜索、HTTP 读取、bash 与 Agent 循环；OpenNova 通过 session/event 观察进度及来源，不拦截联网执行 |
| M3 产品接入 | 来源及历史回查、工具原始错误、语音阶段、取消后的事件隔离、启动版本/模式检查 |
| M4 验收与部署 | 真实联网、公开接口脚本、来源追问、取消及回退验证；空闲日常 Bot 已更新，Studio / 蓝牙组合启动预检通过 |

## 当前行为

- 直接使用 DSH 的 web_search、web_fetch、bash。搜索配置采用 DSH 默认辅助模型与工具次数；搜索超时 60 秒，读取超时 30 秒。
- 移除 native 模式的研究次数限制、60/90 秒研究截止、错误替换、自定义正文清洗，以及 web_request/research_exec/research_derive 工具。
- OpenNova 监听原生会话事件显示搜索/读取进度、保存来源；记录失败不替换原始工具结果。原生工具仍可能因网络、站点或账号失败。
- 搜索链接、搜索引用片段、网页响应分别标记；HTTP 200 不代表内容已核实。Shell 的命令和输出保留，不把 stdout 里的 URL 自动视为已读来源。
- 保留原生工具超时、整轮 10 分钟时限、用户取消、历史来源和桌面操作能力。

## 启动

家中局域网、Studio Vivian、SRS-XB100 蓝牙音响：

```bash
/Users/chenzhuoping/.codex/worktrees/desktop-browser-m0/openNova/output/desktop/start-m4.command \
  --tts-provider studio \
  --device 'SRS-XB100' \
  --output-device 'SRS-XB100'
```

预期显示 `DeepSeek 已接入（DSH 原生联网）`。语音中 `/quit` 或 Ctrl+C 退出语音，Bot 保持运行。

公司网络、本机麦克风与外放：

```bash
/Users/chenzhuoping/.codex/worktrees/desktop-browser-m0/openNova/output/desktop/start-m4.command \
  --tts-provider doubao \
  --device 'MacBook Air麦克风' \
  --output-device 'MacBook Air扬声器'
```

代理沿用实际可用配置。只有本机代理端口确实开启时才传 `--proxy http://127.0.0.1:7897`。

若启动器提示版本或模式不一致，先退出语音，再停止旧 Bot：

```bash
OPENNOVA_BOT_HOME=/Users/chenzhuoping/.codex/worktrees/desktop-browser-m0/openNova/output/bot/m1-home \
OPENNOVA_BOT_PORT=18564 OPENNOVA_BOT_WEB_PORT=18565 \
/Users/chenzhuoping/.codex/worktrees/desktop-browser-m0/openNova/tools/bot/run.command --stop
```

随后重新运行启动命令，聊天与记忆保持在同一个 Bot home。

## 真人验收

| 编号 | 说或输入的话 | 检查内容 |
|---|---|---|
| N01 | 帮我查一下北京下周六的天气 | 解释具体日期；查询在后台完成；来源失败可继续使用其他来源；答案有温度与可核实出处，或明确说明缺口 |
| N02 | 再查一下广州下周六的天气 | 使用广州数据；不把北京结果或旧预报冒充本次结果；只有链接时继续获取事实 |
| N03 | 帮我查一下华润微上周五的收盘价格 | 核对 688396、实际交易日期、收盘字段；最新报价不可代替历史收盘；检查来源 |
| N04 | 查一下 Python 的 TaskGroup 是做什么的，从哪个版本开始支持 | 使用实际官方资料；搜索与读取卡片能正常结束，不停留在执行中 |
| N05 | 刚才的信息来源是什么？不要重新联网 | 回查已有来源；来源卡片可点击；不会额外发起 web_search/web_fetch |
| N06 | 把刚才的技术说明保存成 output/research/taskgroup-note.md，再检查文件 | 文件工具或 bash 完成实际写入与检查；不要求研究脚本登记或二次确认 |
| N07 | 用 bash 运行 sleep 30，等执行结束 | 运行中说“停一下”或点停止；旧任务取消，继续提问仍可正常回答 |
| N08 | 打开雪球首页 | 显式打开网站时仍使用工作窗口；普通后台查询不自动打开网站 |

搜索耗时可能比旧版长。工具卡片显示某个来源失败，与整轮任务失败是两个层次；后续来源成功后仍可完成回答。

## 本轮实测证据

2026-10-25 09:13–09:20，Asia/Shanghai。以下是单次链路验收，不是稳定性统计或响应时间承诺：

| 测试 | 观察结果 |
|---|---|
| 北京下周六 | 约 43 秒，明确 10 月 31 日；两次读取失败后，从东方天气取得相符日期和气温。回答说明未完成官方来源交叉核验 |
| 广州下周六 | 约 54 秒，两次读取失败后继续搜索、读取国内页面并回答；同样保留交叉核验不足的说明 |
| 华润微上周五 | 约 166 秒，3 次搜索、11 次读取、2 次 bash；原生读取拒绝 application/x-javascript 后，bash/curl 读取搜狐公开接口。实际响应含代码 cn_688396、日期 2026-10-23 及所报收盘字段 |
| 技术资料 | 约 21 秒，从 Python 官方文档读取 TaskGroup；约 10 秒完成来源追问，使用 research_sources 和已保存观察，没有重新联网 |
| 公开 JSON 与文件 | 约 24 秒，bash 获取 GitHub 公开 JSON，提取 full_name/default_branch 并保存，再用 read 核对 |
| 取消及回退 | 原生 bash 运行中成功取消；独立 legacy 模式搜索/读取烟测完成；未切换日常服务到 legacy |
| 修复后的原生烟测 | 约 25 秒，一次搜索、一次读取；真实 JSON 字符串参数中的查询词已保存，工具卡片正常结束 |
| 日常启动 | 18564 返回 version 3 / native / dsh-native；同一 Bot 和会话 ID 保留，浏览器自动重连。Studio Vivian、VAD、音频桥与 SRS-XB100 参数预检通过，未收音或播放 |

实测搜索请求使用 DSH 默认的 `deepseek-v4-flash`、`max_tokens=4096`、`web_search max_uses=5`；最后一项是一次辅助模型请求内部的工具上限，不是 OpenNova 每轮只能搜索 5 次。网页查询全程未调用 browser_*。

262 项 Node 回归（Bot、浏览器、启动器）及 103 项 Python 语音测试通过；代码评审发现的参数解析和来源写入异常状态清理问题已修复并补充测试。网页实测确认来源回查能显示“网页响应”、截断标记和获取时间。

原始报告在工作树的 `output/bot/native-research-verification/`：`baseline.json`、`acceptance-v2.json`、`final-smoke.json`、`cancel.json`、`rollback.json`、`deployed.json`。更早的 smoke/acceptance 报告是修复前的诊断记录，不是最终验收依据。

当前仍有边界：部分国内站点的 TLS 连接失败在 DSH 原生链路中也存在；本次改动允许 Agent 保留错误并自主换源或使用 bash，并未保证任一站点可读。复杂查询可能耗时更久。Shell 获取的数据可从命令输出和最终引用检查，不会自动生成结构化来源卡片；本轮未重新验证真人收音、播报和声学插话效果。

## 可重复自动验证

在开发工作树根目录运行，使用现有本机密钥文件，不在命令中填 Key：

```bash
export OPENNOVA_HARNESS_ROOT=/Users/chenzhuoping/Documents/work/project/deepseek-harness
export OPENNOVA_CONFIG=/Users/chenzhuoping/Documents/work/project/openNova/config/voice.local.json
export OPENNOVA_SECRETS_FILE=/Users/chenzhuoping/Documents/work/project/openNova/config/secrets.local.json
/opt/homebrew/opt/node@24/bin/node tools/bot/native-research-probe.mjs --scenario baseline
/opt/homebrew/opt/node@24/bin/node tools/bot/native-research-probe.mjs --scenario acceptance
/opt/homebrew/opt/node@24/bin/node tools/bot/native-research-probe.mjs --scenario cancel
```

baseline 直接注册原生工具，不加载 OpenNova 研究中间件；acceptance/cancel 使用一次性 Bot home，不重置日常对话。真实查询会消耗现有模型/搜索额度。报告保存在被 Git 忽略的 `output/bot/native-research-verification/`。检查报告中的工具路径和实际响应，`completed` 只说明 Agent 回合完成，并不自动代表事实正确。

## 临时回退

先停止 Bot，再在启动命令前加 `OPENNOVA_RESEARCH_MODE=legacy`。恢复原生模式时再次停止 Bot，并使用 `OPENNOVA_RESEARCH_MODE=native` 启动。不能仅切换启动器变量而继续复用另一个模式的旧进程。

旧来源和脚本结果继续可读。legacy 代码为验收期间的回退路径，默认不挂载其研究中间件；后续可在确认无须回退后删除。
