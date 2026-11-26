# OpenNova

OpenNova 是面向工作协同与持续交流的 AI 助手。当前包含网页聊天、持久 Bot、文件与命令工具、记忆、任务，以及 macOS 持续语音入口。

DeepSeek Harness、DeepSeek-Bot 和 SIWC DevKit 的完整工程源码已通过 **Git subtree** 纳入本仓库。普通 clone 或源码压缩包包含这三部分，无需相邻目录、私有 GitHub SSH 仓库、submodule 或源码软链接。安装 npm/Python 依赖仍需要网络；模型授权、语音服务与模型权重按需配置。

## 快速开始

目前支持和验证的开发环境是 **macOS、Node 24、pnpm 11.28.5**。完整离线回归另需 Python 3.11、uv、FFmpeg；原生构建和语音需要 Xcode Command Line Tools。持续语音要求 macOS 15+，Studio 本地 TTS 要求 Apple Silicon。其他系统尚未完成产品验证。

在仓库根目录执行：

```sh
corepack enable
corepack prepare pnpm@11.28.5 --activate
pnpm run setup
pnpm run build
pnpm run doctor
pnpm test
pnpm run test:bot
```

请使用 **`pnpm run setup`**：`pnpm setup` 是 pnpm 自身的命令。`setup` 安装根工程、三个引擎和桌面桥接各自锁定的依赖；`build` 构建 Harness、Bot、SIWC 和 OpenNova 网页。`doctor` 只检查本地源码与构建，不登录、不访问模型、不打开麦克风。上述测试使用本地模拟模型和临时数据目录。

当前产品模型适配使用 OpenNova 独立的 Sign in with ChatGPT。SDK 已随默认构建生成；在 macOS 上准备 Keychain helper，再由本人授权：

```sh
pnpm run setup -- --chatgpt
pnpm run build
pnpm run test:chatgpt
node services/agent/authorize.mjs
pnpm start
```

`--chatgpt` 仅为缺失的 Keychain helper 编译可执行程序，已有程序保持不变，不会触发登录。SIWC 源码、依赖和构建均位于仓库内，工具调用扩展已纳入源码。已有授权会继续复用。实际模型可用性取决于账号权限。

更换 ChatGPT 账号可运行 `node services/agent/authorize.mjs --add-account`，在官方页面选择另一个账号并完成授权。新账号成功后才切换，原账号、会话和记忆保留。`--list-accounts` 查看已保存账号，`--select-account ID` 切换已保存账号；未完成的注册可用相同 ID 继续授权。切换时请先停止正在执行的任务并暂停语音，完成后核对账号权限。

启动后默认只打开右侧 OpenNova 对话窗口；点击“打开工作窗口”或要求助手浏览网页时，再打开工作窗口。网页地址为 [本地网页聊天](http://127.0.0.1:18560/)。首次使用需按终端提示加载工程内 `extensions/browser` 并配对；`pnpm start -- --no-ui` 可仅运行后台服务。需要代理时通过 `OPENNOVA_PROXY` 设置自己的代理地址。网页和语音共用一个 Bot；默认允许助手在当前 OpenNova 工程工作，文件、Shell 等操作具有当前用户的权限。

默认支持增量回答：模型明确标记的最终答案会提前显示在右侧窗口，并按稳定语句开始合成；播放当前句时最多预合成下一句。未提供可靠回答标记的响应继续等待完整结果。工具执行、来源和会话提交仍以完整校验后的结果为准；取消或失败后的部分文字会标明未完成。启动已有 Bot 时沿用该进程的模式，更新后需在结束当前工作并退出语音后重启 Bot。

回退时，在停止现有 Bot 后使用 `OPENNOVA_REPLY_MODE=settled OPENNOVA_TTS_PREFETCH=0 ./start.command --tts-provider doubao`。实现、测速命令和验证边界见 [回复速度与流式播报验收](docs/research/opennova-reply-streaming-verification.md)。

A1 项目上下文首版已实现：支持创建、选择、归档和恢复项目，目录可以留空；按项目关联资料、决定、备选、未决问题和任务，通过轻量项目入口查看接续摘要。工作与日常交流按自然话题转场，无需固定口令或模式按钮；日常交流保留可接续项目，已有后台任务保持原归属。文字、语音和新建任务携带项目版本，迟到输入或旧页面不会静默改绑到新项目。

2026-11-15 工程收尾：用户已结束本轮人工测试；全量回归通过（986 项 JavaScript、252 项 Python），34 条真实模型路由、原生长上下文摘要换段、语音协议隔离与恢复界面检查通过。新增“仅补汇总／仅重试验收”，可恢复模型失败阶段并保留原失败记录。原数据备份、恢复、迁移及原目录源码同步、构建和启动核验已完成；设备播放证据边界见 [A1 验证记录](docs/research/opennova-project-context-verification.md)。

2026-11-16 A2 首批文件入口：已接通“直接说文件名或路径”和“引用 Nova 已关联的当前文件”。PDF、扫描 PDF、PNG、基础 DOCX/XLSX 已通过真实 OpenNova 原生读取；单文件上限 20 MiB，文件版本和读取状态保留在当前对象与操作记录。实现沿用当前模型与授权，通过只读工具返回有来源的内容；主会话 provider 仍是文本投影。后台快照继承、研究出处和笔记接续继续开发。测试结果及范围见 [A2 文件入口接入](docs/research/opennova-a2-native-file-entry.md)，能力基线见 [文件能力验证](docs/research/opennova-file-capability-verification.md)，顺序见 [A2 计划](docs/superpowers/plans/2026-11-16-a2-research-learning.md)。

2026-11-17 正式生成工具：`document_generate` 已接入前台 Agent Harness，支持新建可编辑 Word 和中文多页 PDF。模型组织内容，仓库内固定执行器处理生成、分页和本地核验；已补齐二进制原子保存、目标冲突、取消/幂等、项目归属和最终文件绑定。真实模型调用及独立内容、逐页视觉检查通过。更新代码并重启 Bot 后，可直接要求 Nova“把这些内容整理成 Word，再生成同内容的 PDF”。首版不覆盖已有文件；后台生成、精确引用、继续修改及原生长文读回边界仍按计划推进。见 [工具接入与验收](docs/research/opennova-a2-document-tools.md)、[调用说明](tools/documents/README.md)和 [工具方案](docs/superpowers/specs/2026-11-17-a2-document-generation-design.md)。

支持把明确的测试、构建和脚本命令放到后台运行。右侧“任务”页可以查看排队状态、增量日志、结果文件，取消作业或重试失败的执行；后台运行时仍可继续聊天。任务记录和日志默认保存在仓库外，刷新不重复提交，服务重启不自动重跑已经启动的命令。使用方法与恢复边界见 [后台任务第一阶段验收](docs/research/opennova-background-tasks-verification.md)。

第二阶段支持独立 Agent 工作任务：在仓库外 Git 工作目录中分析、修改并验证，后台执行时仍可继续交流；支持补充要求、暂停、接续原会话、查看执行步骤和文件差异，再显式应用到原工程。使用方法与边界见 [独立 Agent 任务验收](docs/research/opennova-agent-tasks-verification.md)。

第三阶段支持事件驱动接续：在明确启用、次数和期限受限的规则下，测试／构建完成、指定文件变化或 GitHub 讨论评论可以接续同一任务。面板提供暂停、来源与消费记录，文件修改仍需审阅后应用。使用方式见 [事件接续说明与验收](docs/research/opennova-event-continuation-verification.md)。

团队员工可以承接通用工作，职责和擅长方向用于分工。新建任务默认“通用工作”模板与“完整执行（Full Access）”权限，可读写当前系统用户有权访问的任意目录，并使用已接入的命令、联网和浏览器工具；“只读”允许读取任务目录内资料和联网检索。模板只决定输入与目录准备，资料任务也可运行处理脚本。Full Access 仍遵守用户任务约束与操作系统权限，成果默认写入独立任务目录，用户明确指定外部交付路径时可按要求保存。会话和来源记录继续保存在仓库外，后台浏览器操作与前台排队协调。已有 `policyVersion=2` 的 Full Access 任务接续时使用相同目录权限；更早的历史契约保持原范围。详见 [通用员工执行能力与验收](docs/research/opennova-generic-execution-verification.md)。

团队版已支持成果版本、总管后台验收与有限返工、待处理问题、员工交接及明确前置依赖。新建普通后台任务默认自动检查，无论员工执行还是总管亲自执行，都由独立只读验收会话核对成果与实际证据；满足要求自动通过，需要用户判断时才转为待处理。可以关闭自动检查；历史任务保留原设置，可在任务详情启用跟进。验收通过后才释放依赖任务；查看成果、验收和合入代码各自独立。历史任务不自动补跑，配置、授权、会话、记忆和任务数据继续保留在仓库外。入口与验证边界见 [团队 M2 使用与验证](docs/research/opennova-team-m2-verification.md)。

总管和员工任务验收通过或需要用户处理时，会在原对话主动汇报，可直接打开对应任务。语音已连接时等待空闲播报，讲话即停；刷新和重连不重复通知，升级不集中补发旧任务。说明与测试步骤见 [任务主动汇报](docs/research/opennova-task-notifications.md)。

新 Agent 任务的步骤、Token、运行时长及总管累计预算默认不限制，预算字段留空即可；旧任务保留原设置。任务详情展示当前执行阶段和最近活动，总管验收有独立活动记录。团队运行、恢复与交付验收见 [M3 验证记录](docs/research/opennova-team-m3-verification.md)，停机备份和恢复步骤见 [状态恢复说明](docs/research/opennova-team-recovery.md)。

任务页提供“正在做 / 需要你处理 / 最近成果”团队总览，支持按员工查询全部任务和加载历史。总管值守提醒临近截止、逾期、持续阻塞及无新进展；默认只提醒，可明确开启逾期排队提优先级。语音或对话可直接询问团队进展、确认提醒，执行完成与验收记录分开汇总。详见 [M4 使用与验证](docs/research/opennova-team-m4-verification.md)。

不再需要的任务可以在详情点击“关闭任务”，也可以用语音或对话提出关闭。停止后续跟进并确认进程清理后，任务移出默认列表；原执行结果、日志和成果仍保留。通过“任务记录 → 已关闭”查看或恢复；恢复只重新显示，执行需另行接续或重试。“取消执行”仍只停止本次执行，不等同于关闭。

技能库复用 Harness 的技能加载和 DeepSeek Bot 的员工绑定。已有 `video-production` 可分配给员工，任务固定技能与资源版本；视频等待释放执行槽，重启后查询同一远端任务。新成果验收后默认只读整理经验候选，检查保存后供后续任务复用，支持更新、停用与回退。个人技能、候选及版本继续放在仓库外。详见 [M5 技能与经验沉淀](docs/research/opennova-team-m5-verification.md) 和 [人工测试用例](docs/research/opennova-team-m5-test-cases.md)。

医美视频项目已迁入 [aesthetic-video-workflow 工作区](workspaces/aesthetic-video-workflow/README.md)：技能保存创作方法和接续记录，完整素材保存在本机工作区，视频任务配合 `video-production`。缺失原图、历史首帧接口差异及使用方式见工作区说明。

前台项目对话也内置 `image-production`：使用项目定稿角色生成或改图，再把已有确认稿做成 GIF。成果卡可播放、打开及下载 GIF、首帧和源视频；需要时可在对话中要求抽帧审阅。已有安装可运行 `pnpm run setup -- --image-only` 补齐环境。详见 [图片与 GIF 使用说明](tools/image/README.md)。

同一技能可委派给已绑定 `image-production` 的员工。后台任务使用委派时的项目、角色、来源和版本；成品及抽帧审阅随任务报告送回，等待或重启不会额外提交生成。项目内保存须在委派时给出明确的新路径。

## 工程结构

| 目录 | 职责 |
| --- | --- |
| `engine/harness/` | 完整 Harness：Agent 运行时、SDK、工具、存储、插件与原生界面 |
| `engine/bot/` | 完整 DeepSeek-Bot 上游；实际插件位于 `ds-bot/` |
| `engine/siwc/` | 完整 SIWC DevKit 及已应用的 OpenNova 工具流扩展 |
| `services/runtime/` | 仓库内源码定位、版本验证与 Harness 包解析 |
| `services/agent/` | OpenNova 模型适配、授权、流式会话与联网策略 |
| `services/bot/` | OpenNova Bot 宿主、任务与团队、技能与经验、网页及工具操作记录 |
| `skills/`、`tools/video/` | 内置技能与视频工具源码 |
| `services/tts/` | Studio Vivian / MLX、豆包云端 TTS |
| `tools/voice/`、`tools/asr/` | 音频、VAD、ASR、持续语音与播放 |
| `scripts/` | 根目录安装、构建、诊断和离线回归 |
| `config/` | 配置模板；真实配置保存在忽略的 `*.local.json` |
| `upstream.lock.json` | Harness/Bot/SIWC 来源、导入提交和保留补丁 |
| `output/` | 本机产物、扩展构建和日志，不进入 Git |

```mermaid
flowchart TD
  UI[网页 / 终端 / 持续语音] --> Product[OpenNova services/bot 与 services/agent]
  Product --> Bot[engine/bot/ds-bot]
  Bot --> Harness[engine/harness]
  Product --> Harness
  Harness --> Model[OpenNova 模型适配]
  Harness --> State[仓库外的会话 / 记忆 / SQLite]
```

## 语音与本地配置

首次配置可复制模板，已有文件请保留：

```sh
cp -n config/secrets.example.json config/secrets.local.json
chmod 600 config/secrets.local.json
cp -n config/voice.example.json config/voice.local.json
```

按 [语音说明](tools/voice/README.md) 配置豆包 ASR、Studio TTS 或豆包云端 TTS。完成依赖、授权和服务配置后：

```sh
pnpm run start:voice -- --help
./start.command
# 云端 TTS 示例
./start.command --tts-provider doubao
# 仅文字启动，之后在窗口点击“开启语音”再连接音频
./start.command --no-voice --tts-provider doubao
```

更新代码后仍可直接运行 `./start.command`。启动器会检查构建，缺失或过期时自动重建，校验成功后按本次参数继续启动。若已有同一工程的 Bot 在运行，启动器会复用它，服务端代码更新在该 Bot 下次启动时生效。

窗口“音频设备”可分别选择麦克风和外放，支持系统默认、刷新列表、保存选择和运行中应用并重连；例如使用 Mac 内置麦克风配合蓝牙音响。仅文字模式下保存设备不会开启语音。蓝牙设备先在 macOS 系统设置连接，操作说明见[语音说明](tools/voice/README.md)。

语音 `--check` 与 `pnpm run doctor` 不同：前者会检查实际服务和授权；豆包 TTS 模式会合成一段探针音频并产生少量计费用量。真人麦克风、声学打断和云端效果需要在目标设备另行验收。

已有 Bot 数据仍在 `~/.local/share/opennova/bot-spike/`，独立 Harness 语音会话仍在 `~/.local/share/opennova/harness-home/`。迁移不搬动会话、记忆、权限或 Keychain。`agent.harness_root`、`agent.siwc_root` 和用户传入的 `OPENNOVA_HARNESS_ROOT`、`OPENNOVA_SIWC_ROOT` 不再选择外部源码；授权存储和 TTS 的机器配置继续有效。Keychain helper 及旧 `agent.keychain_helper` / `OPENNOVA_KEYCHAIN_HELPER` 路径覆盖已收拢为工程内 `output/bin/siwc-keychain`，由仓库内 Swift 源码构建；原 Keychain 身份保持不变。

## 开发与许可

- [开发、构建、上游同步与回归](docs/development.md)
- [贡献指南](CONTRIBUTING.md)
- [Agent 适配](services/agent/README.md)、[TTS 配置](services/tts/README.md)
- [Bot 能力与历史验证](docs/research/opennova-bot-spike.md)
- [MVP PRD](docs/product/opennova-mvp-prd.md)
- [A1 项目上下文功能设计](docs/superpowers/specs/2026-11-12-project-context-design.md)、[开发计划](docs/superpowers/plans/2026-11-12-project-context.md)与[验证记录](docs/research/opennova-project-context-verification.md)：首版工程收尾完成，已同步到原运行目录并通过启动核验；证据边界见验证记录。

OpenNova 自有代码采用 [Apache-2.0](LICENSE)。引入组件保留各自许可：Harness 为 MIT，DeepSeek-Bot 为 Apache-2.0，SIWC 使用 **Sign-in with ChatGPT DevKit Noncommercial License v1.0（非商业许可）**；根 Apache-2.0 不覆盖 SIWC。详情见 [第三方声明](THIRD_PARTY_NOTICES.md)。本仓库是 OpenNova 的独立整合项目，不代表上游官方发行版。

桌面交互已与同一个 Bot 和语音会话整合。`./start.command --tts-provider doubao` 默认自动开窗并启动语音；加 `--no-voice` 先进入文字模式，保留窗口“开启语音”及终端 `/start` 入口。待机不检查或占用音频设备，不启动 ASR、TTS 或 Studio SSH；开启时才连接。音频或语音服务启动失败时保留文字和重试入口。窗口“关闭语音”或 `/disable` 释放音频并返回待机；“静音”只停止收音，“结束”结束当前交流，`/quit` 则退出启动器。`pnpm start` 仍只启动文字服务。`--check` / `--list-devices` 不开窗。浏览器程序与外部 profile 可在 `desktop.browser_executable`、`desktop.browser_user_data_dir` 中配置，原有环境变量仍可覆盖。配对数据和浏览器 profile 必须保留在工程外。
