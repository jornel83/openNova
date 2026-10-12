# OpenNova 联网 Demo 开发与验收记录

日期：2026-10-13。代码范围：订阅工具协议、Harness Web 工具、文字入口、持续语音联网模式及回归。**真实网页读取与语音文件闭环已经通过；Exa 搜索仍缺本机密钥，不能视为真实搜索已验收。**

## 四个里程碑

| 里程碑 | 已实现与验证 | 剩余验收 |
| --- | --- | --- |
| M1 工具协议 | 可复现 SIWC 扩展；实际 GPT 调用只读工具 → Harness 执行 → 回传 → 答复；取消后同会话继续 | 无账号能力阻塞 |
| M2 文字联网 | 原生 Exa / HTTP fetch 插件、次数与超时预算、来源、文字 CLI；真实公开网页读取与来源追问通过 | 配置 Exa Key 后实测搜索与搜索阶段取消 |
| M3 语音联网 | `--web`、完整答复后播报、2 秒提示、插话取消、重连保留模式；真实两轮 ASR → GPT / 网页工具 → Vivian 文件链路通过 | 真实搜索语音链路；内置 / 蓝牙现场插话与听感 |
| M4 收尾交付 | 固定版本、重建脚本、回归测试、说明与本地提交 | 搜索服务依赖及真人验收不能由离线测试替代 |

## 明早开始测试

在项目根目录、现有 Studio TTS 转发可用的情况下执行。下列密钥配置与扩展安装只需完成一次。

1. 在 `config/secrets.local.json` 的现有对象中加入 `web.exa_api_key`，值填写自己的 Exa Key。保留已有 `doubao` 字段；不要覆盖整份文件。也可使用 `EXA_API_KEY` 环境变量。文件保持 Git 忽略和 0600 权限，聊天、README 和提交中不放密钥。
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
- 回归：Agent 49、语音 61、安装 3、ASR 26、TTS 10 项，共 149 项通过。干净生成目录重建后，8 项 SIWC 流式合同测试再次通过。

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
