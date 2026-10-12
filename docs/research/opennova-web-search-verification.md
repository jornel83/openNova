# OpenNova 联网 Demo 开发与验收记录

日期：2026-10-13。代码范围：订阅工具协议、Harness Web 工具、文字入口、持续语音联网模式及回归。**DeepSeek 实际搜索、GPT 来源追问，以及 ASR → GPT / DeepSeek 搜索 / 网页读取 → Vivian 语音文件闭环已经通过；现场听感仍待验收。Exa 保留为可选后端，未实测。**

## 查询质量修复：日期、正文与收尾

- 每个模型步骤通过 Harness 的持久化运行时上下文刷新系统时间，包含本机时区与 `America/New_York`。即使关闭其他可选 runtime context 仍保留时间；跨午夜会刷新。缺省年份、今天 / 昨天和收盘口径遵循当前时间及用户上下文，明确的历史日期优先，不硬编码交易日历。
- 本地 `opennova-http` 提供方复用原生 HTTP 传输与安全 HTML 转换：最多下载 2 MB / 500,000 字符原始内容，先转换、过滤明显纯链接导航段，再限制正文为 11,000 字符，完整工具输出仍限 12,000 字符。原有超时、取消、公开地址校验和重定向限制保留；无需修改上游 Harness。
- 连续两次读取失败、剩余检索时间不超过 15 秒或仅剩最后一次模型请求时，关闭后续工具并提示模型根据已有证据收尾。同轮重复 URL / 相同查询不再分发；新一轮重新开始。45 秒检索、90 秒整轮的硬上限保留，预留收尾时间不保证慢模型一定在截止前答完。
- 新增回归覆盖：跨午夜、被关闭的可选上下文、长 HTML 后的正文与表格、空正文、拦截、取消、公开 URL 策略、重复请求、连续失败与下一轮恢复。Agent 61、语音 63、安装 3、ASR 26、TTS 10，共 163 项通过。

真实证据保存在忽略目录 `output/agent/web-quality/`：

| 用例 | 结果 |
| --- | --- |
| 原东方财富链接 | 从原先只得到导航，变为取得包含发布日期和三大指数收盘数字的正文；HTTP 200 |
| “昨天美股大概多少点” | 23.225 秒，按美国当地 2026-10-12 收盘回答三大指数，引用实际读取的 Yahoo Finance 报道 |
| “10月13日吧，三大指数都听一下” | 9.258 秒，承接北京时间 10-13 凌晨的口径，无重复年份追问，复用前文来源 |
| 上海今日天气 | 查询已携带 2026-10-13；天气网和中央气象台读取仍有传输失败，23.161 秒说明未核实气温。没有虚报天气，也没有触发 45 秒硬超时；此项不算天气数据查询成功 |
| 语音文件：“今天是几月几日，星期几” | Silero VAD → 豆包 → GPT → Vivian 通过，正确回答 2026-10-13 星期二，没有调用搜索；答案首 PCM 3.373 秒，消费 PCM 188,416 字节。未开启麦克风 / 扬声器，不代表现场声学验收 |

天气访问限制独立存在：同机只读诊断中，相关 HTTP 文章链接返回 403，HTTPS 预报页面发生 TLS 协议错误，代理及直连均出现失败。通用搜索和正文修复不能保证每个站点可读；尚未接入独立天气数据 API。首次集成探针也发现提示服务依赖声明缺失，补齐后运行时启动和上述对话通过。

## DeepSeek 搜索接入更新

- 配置 `web.provider: deepseek` 后使用 Harness 原生 DeepSeek 插件；主模型仍是 GPT-6.1 Sol。密钥仅保存在本机忽略文件，只有所选搜索后端的密钥传入运行时；无付费后端自动回退。
- 独立官方接口探针返回 HTTP 200、一次 `web_search` 与 10 条来源，耗时 6.570 秒。此探针直接调用 provider；正式工具由 Web 服务裁剪至最多 5 条。`input_tokens=10803`、`cache_read_input_tokens=256`、`output_tokens=836`，仅作为一次用量样本，非账单或平均值。
- `deepseek-agent.json`：真实 GPT → Harness → DeepSeek → GPT 两轮成功；首轮两次搜索、23.519 秒，来源追问无需重搜、5.348 秒。返回了 python.org 的真实搜索来源，但并非纯主页 URL；本次证明协议与引用可用，不代表搜索质量已完成评测。
- `deepseek-voice-proxy/conversation.json`：Silero VAD → 豆包 ASR → GPT / DeepSeek 搜索 / HTTP 读取 → Studio Vivian 文件验证成功，一次搜索及一次读取后返回 Python 官网，消费 PCM 658,664 字节。从最终转写提交到 Agent 完成为 18.528 秒、答案首 PCM 为 18.912 秒、文件管线完成为 23.253 秒。未开启麦克风或扬声器，不能代替现场听感验收。
- 当前网络直连 DeepSeek 在 TLS 握手阶段失败，通过现有 `http://127.0.0.1:7897` 代理成功。测试保留代理环境变量；未更改系统网络或 VPN。
- 首次直接运行 Python 文件入口时只设置了 `OPENNOVA_PROXY`，未设置标准 HTTP 代理变量，GPT 模型列表预检连接失败。改用正式 `run-continuous.command` 启动器后成功；该入口会设置 HTTP(S) 代理，并让本地 TTS 转发绕过代理。
- 回归为 Agent 55、语音 63、安装 3、ASR 26、TTS 10，共 157 项通过。原 Exa 配置默认值与普通增量模式保留。

已集成至原项目的 `codex/voice-vad-tts` 本地分支，功能修复提交 `de89bf0`，未推送远程。原有 Harness 升级与计划已单独保存在 `3159412`；无关 `skills/`、`tools/video/` 保持原样。原路径已重新构建并检查工具扩展，155 项测试再次通过；`integrated-fetch.json` 记录了集成后的真实读取 → 来源答复，耗时 9.189 秒，未调用搜索。开发决策、审查与 RED→GREEN 记录保存在本机 [开发审计](../../output/agent/web-verification/development-audit/progress.md)。

## 四个里程碑

| 里程碑 | 已实现与验证 | 剩余验收 |
| --- | --- | --- |
| M1 工具协议 | 可复现 SIWC 扩展；实际 GPT 调用只读工具 → Harness 执行 → 回传 → 答复；取消后同会话继续 | 无账号能力阻塞 |
| M2 文字联网 | 原生 Exa / DeepSeek / HTTP fetch 插件、次数与超时预算、来源、文字 CLI；DeepSeek 实际搜索、来源追问与公开网页读取通过 | DeepSeek 多语言效果矩阵与真实搜索阶段取消；Exa 可选验收 |
| M3 语音联网 | `--web`、完整答复后播报、2 秒提示、插话取消、重连保留模式；真实 ASR → GPT / DeepSeek 搜索 / 网页读取 → Vivian 文件链路通过 | 内置 / 蓝牙现场插话与听感 |
| M4 收尾交付 | 固定版本、重建脚本、回归测试、说明与本地提交 | 搜索服务依赖及真人验收不能由离线测试替代 |

## 明早开始测试

在项目根目录、现有 Studio TTS 转发可用的情况下执行。下列密钥配置与扩展安装只需完成一次。

1. 使用 DeepSeek 时，在 `config/voice.local.json` 的 `web.provider` 填写 `deepseek`，在 `config/secrets.local.json` 的 `web.deepseek_api_key` 填入密钥（或使用 `DEEPSEEK_API_KEY`）。选择 Exa 时使用 `provider: exa` 和 `web.exa_api_key` / `EXA_API_KEY`。保留已有配置；不要覆盖整份文件。密钥文件保持 Git 忽略和 0600 权限。
2. 安装 / 检查扩展：

   ```sh
   python3.11 tools/setup/bootstrap.py --install --web
   python3.11 tools/setup/bootstrap.py --check --web
   ```

3. 先测文字：

   ```sh
   OPENNOVA_PROXY=http://127.0.0.1:7897 /opt/homebrew/opt/node@24/bin/node tools/agent/chat.mjs --web
   ```

4. 再测语音，麦克风参数继续放在末尾：

   ```sh
   OPENNOVA_PROXY=http://127.0.0.1:7897 tools/voice/run-continuous.command --web --device 'MacBook Air麦克风'
   # 蓝牙输入和输出
   OPENNOVA_PROXY=http://127.0.0.1:7897 tools/voice/run-continuous.command --web --output-device 'SRS-XB100' --device 'SRS-XB100'
   ```

代理地址按本机实际情况设置，无需代理时省略。移除 `--web` 就是原增量对话模式，无需回退 Git 或卸载扩展。

| 用例 | 输入 / 操作 | 预期 |
| --- | --- | --- |
| 最新信息搜索 | “联网查一下 DeepSeek Harness 最近的官方发布，给我来源。” | 显示正在搜索；答复引用真实链接，区分发布日期；不能只凭已有知识作答 |
| 指定链接 | “读取 https://example.com，解释这个网页。” | 显示正在读取；答案附已读网页链接 |
| 来源追问 | “刚才的依据来自哪里？” | 同会话能给出上一轮真实来源 |
| 普通聊天 | “你好，今天陪我聊聊。” | 无需工具；联网模式仍等待完整答案后播报 |
| 工具等待时打断 | 搜索中输入 `/stop`，或语音说“等一下，换个问题” | 旧请求取消；迟到来源与音频不恢复；下一轮正常 |
| 提示与答案 | 较慢的检索 | 最多一次“我查一下，请稍等”；随后答案，不叠音、不朗读 URL |
| 静音 / 结束 / 重连 | `/mute`、`/unmute`、`/end`、`/start`、`/retry` | 沿用原控制语义；`/retry` 保留联网模式及输入 / 输出设备选择 |
| 故障 | 缺密钥、网络断开、搜索服务返回错误 | 明确失败或说明未核实，不把未完成工具结果当成功答复 |

`/mute` 只关闭上行收音；需要停止本轮回复用 `/stop` 或 `/end`。`/quit` 退出。

## 已取得的真实证据

记录均在 Git 忽略的 `output/agent/web-verification/`，不包含认证令牌；Harness 仍按既有机制在仓库外保存文字会话。

- `protocol-1791823835349.json`：真实 GPT 工具调用一次，正确回传固定探针值；生成取消成功，随后同会话继续成功。
- `web-1791824241252.json`：真实公开 HTTP 读取、再次读取、来源追问；分别约 9.1、10.7、4.2 秒。这里没有调用 Exa，不作为搜索证据。由该样本发现的“URL 同时作为链接标题”显示缺陷已有回归测试修复。
- `voice-fetch-retry/conversation.json`：真实 Silero VAD、豆包 ASR、订阅 GPT、Harness HTTP fetch、Studio Vivian 两轮文件验证成功，消费 PCM 1,250,168 字节。使用 macOS 合成测试发言，不开启麦克风或扬声器。首轮确实调用读取工具，第二轮使用已读来源；未调用 Exa。

| 指标：从最终转写提交开始 | 第一轮：读取网页 | 第二轮：来源追问 |
| --- | --- | --- |
| 提示首 PCM | 7.225 s | 未播放提示 |
| GPT 整轮完成 | 10.806 s | 5.530 s |
| 答案首 PCM | 11.213 s | 5.825 s |
| 文件管线完成 | 18.063 s | 8.124 s |

这是单次文件样本，PCM 指标不等于扬声器实际首声，不代表 P95。首次文件尝试在 GPT 模型目录检查中超时，未开始识别；一次重试通过，未隐藏首次失败。文件夹具的未使用 Exa 占位值只用于测试，生产联网入口仍要求真实 Key。

- `multilingual-fetch.json`：中文 3 个、英文 3 个、中英混合 3 个实际公开网页问题，9/9 取得可核验来源；读取开始时取消成功，下一轮可继续。仍不包含 Exa 搜索。
- `legacy.json`：不带 `--web` 的真实增量对话通过，增量拼接与最终答复一致。
- 回归：Agent 54、语音 62、安装 3、ASR 26、TTS 10 项，共 155 项通过。干净生成目录重建后，8 项 SIWC 流式合同测试再次通过。

## 最终审查

独立审查提出的三项主要问题均已补充失败用例并修复：从首个 Web 工具开始的 45 秒连续计时覆盖模型等待并取消本轮；英文句末标点、括号 URL 保留有效引用；文字入口 `/quit` 立即取消活动请求，不等答案完成。超时后下一轮可继续，语音入口给出检索预算提示。

延期小项：同一 URL 从搜索结果升级为读取结果时，来源列表可能丢失 `publishedAt`；终端来源列表也暂不单列发布日期。原始工具结果仍保留在 Harness 会话中，时效性验收需检查原始来源页面，不能把来源列表当完整出版信息。

## 实现边界与取舍

- 沿用官方 SIWC 的登录、自动刷新与加密存储；OpenNova 不读取 Codex 登录，也不自动切换其他 API Key 计费。
- 官方订阅流实际出现 `response.completed.output=[]`，但已发送完整 `output_item.done`。扩展按顺序保存完成项，并仍要求最终 completed；只有部分 added / delta 时明确失败。
- Harness 持续拥有会话、工具循环和取消。Web 限制挂在现有 private control 插件上，读取外部内容时沿用上游公开 URL 策略。代理场景下域名解析由代理承担，私人 IP 字面量与 loopback 仍拒绝。
- 联网模式选择完整答案后播报，所以检索和模型多步骤会增加等待；普通增量模式保持原行为。显示 / 语音分别投影，不修改原 Harness 历史。
- Web 原生工具提供 URL 引用。验证列表仅接收结构化工具返回的来源，未知链接不成为有效引用；未映射的纯数字引用标记移除。同会话最多保留最近 100 个来源，重启新会话。
- 缺 Exa Key 时已完成离线合同与实际网页读取验证，仍需完成中文 / 英文 / 混合的真实搜索矩阵、搜索失败与检索阶段取消。现场 AEC、插话听感及 Studio GPU 停算确认仍需独立验证。

## 回归与重建

```sh
node --test services/agent/tests/*.test.mjs
python3.11 -m unittest discover -s tools/voice/tests -q
python3.11 -m unittest discover -s tools/setup/tests -q
```

Node 必须使用 24；首次运行测试前构建 `--web` 扩展。隔离工作区需通过 `OPENNOVA_HARNESS_ROOT` 指向固定的 Harness；正常仓库默认使用相邻目录。补丁 SHA-256 和固定源码提交共同决定生成路径，manifest 校验入口文件，干净重建不依赖上游检出中的手工修改。原检出和授权目录均不改动。
