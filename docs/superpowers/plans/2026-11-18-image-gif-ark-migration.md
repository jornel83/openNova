# 图片与 GIF：火山方舟路线切换

截至 2026-11-18，M0 真实图片与 GIF 验证已通过，M1 公共基础已完成。M2 项目对话已通过言昕两轮真实生图验收，包括参考图改衣、另存横版、切换历史版本和重启恢复。模型验证和图片对话验收分别见 [M0/M1 记录](../../research/opennova-image-gif-ark-verification.md) 与 [M2 记录](../../research/opennova-image-generation-m2.md)。

## 1. 最终技术分工

| 需求 | 实现 |
| --- | --- |
| 文字生图、参考图修改 | **Seedream 5.5**，候选模型 `doubao-seedream-5-5-261028` |
| 已确认静态图做动画 | **Seedance 2.5**，候选模型 `doubao-seedance-2-5-260628`，先生成视频 |
| GIF 交付 | 本地 FFmpeg 抽帧 + Pillow 编码，探针记录 `gif_route=seedance_video_then_local_export`，公开契约 `mode=video` |
| 首帧 | 从最终 GIF 实际解码第 0 帧提取 PNG |
| 保存与恢复 | 复用 `operations.py` / `bundle.py`，稳定动作身份、冻结输入、无覆盖发布、部分交付对账 |
| 凭据 | 图片和 GIF 优先使用图片/GIF 专用 Ark 凭据，包括 GIF 所需的 Seedance 调用。独立视频工具使用其原有视频凭据。 |

Seedream 是静态图片模型；Seedance 的公开生成接口返回视频，不把视频转 GIF 称为“模型原生 GIF”。GIF 没有音轨；需要背景音乐时另行交付 MP4。模型名出现在文档不代表账号已有对应权限，M0 真实回执决定能力状态。

官方依据：[Seedream 5.5](https://ark.volcengine.com/region:cn-beijing/docs/seedream-5-5) · [图片 API](https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api) · [Seedance 2.5](https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5) · [创建视频任务](https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api) · [查询视频任务](https://ark.volcengine.com/region:cn-beijing/docs/get-video-generation-task-api)。

## 2. 保留的公共约定

- 宿主注入 operation/request/project/task/run 身份；模型参数不得覆盖身份或凭据。
- 冻结请求、参考素材字节/hash、目标位置及执行器版本。新一次“再生成”是新动作；同动作重放复用原记录。
- 默认 `expectedTarget=absent`，新版本不覆盖已有文件；半成品、实际产物和状态分开保存。
- `generation`、文件/动画结构核验、`visualReview` 分开记录。真实接口返回成功不等于视觉质量通过。
- GIF、PNG、manifest 可恢复交付，但多文件不承诺单次原子提交；部分交付标记 `partial`。
- 输出模型、实际路线、尺寸、帧数、逐帧时间、循环、hash 与真实文件路径；不把 Base64 或签名下载 URL 放入对话及持久回执。

## 3. 本轮 M0 / M1

### M0：替换能力验证后端

- 图片/GIF 专用文件默认为 `~/.config/opennova/ark-image-gif.key`，也可用 `OPENNOVA_IMAGE_ARK_KEY_FILE` 指定。独立视频沿用 `~/.config/opennova/ark.key` 或已有视频配置。完整的凭据选择顺序见 [工具说明](../../../tools/image/README.md)。
- 使用官方北京端点：静态 `POST /api/v3/images/generations`；视频 `POST /api/v3/contents/generations/tasks`；状态 `GET .../{task_id}`。
- 最多两次生成请求：一张简单圆形参考图的 Seedream 编辑、一个 4 秒 480p 无音频 Seedance 视频。图片生成失败或结果未知时停止后续付费动作，不轮换候选模型测试。
- Seedream 探针只生成一张 PNG，不传不支持的 `n` 或组图参数；保留返回原始字节、usage/request ID（若有）及实际格式尺寸。
- Seedance 静态参考使用 `role=first_frame`，该场景配合 `ratio=adaptive`。现有视频工具的 `reference_image` 是全模态参考，不与首帧语义混用。
- 提交前持久占用预算；POST 不自动重试。同步图片请求中断记为未知。视频收到任务 ID 后持久保存，再查询同一个 ID；查询超时可继续查询，不能再提交。
- 视频完成后下载同任务结果；下载失败仅重下同任务。签名 URL 只留在内存，不向存储域名转发 Ark Authorization。
- 保留原始 PNG/MP4，并通过 M1 导出 GIF + 真实首帧。权限/额度/审核/临时失败/未知与能力结论分开记录。

### M1：沿用公共基础并补视频转 GIF

- M1 定义三个公开工具 `image_generate`、`gif_generate`、`media_export`；M2 实现图片的正式执行入口，GIF 对话入口安排在 M3。
- `image_generate` 默认 provider=ark，参考图输入用于 Seedream；移除 OpenAI 特有质量枚举。
- `gif_generate` 路线为 `video`，`auto` 当前也只选视频路线；参数为视频时长/分辨率和最终 GIF fps/尺寸，不再使用原生 GIF 的 2–16 帧字段。
- 新增 `media_export(action=video_to_gif)`：本地 MP4/MOV，时间范围、fps、精确目标画布、调色板、体积限制和循环；输入/输出复用同一冻结及发布流程。
- 默认 4 秒、10 fps；允许 5/10/20/25 fps，帧延时均可由 GIF 10 ms 精度准确表示。时段不足完整周期时向下取整并记录请求/实际时长，不能冒称交付了请求全长。
- 单输入 20 MiB，最多 256 抽帧，总像素不超过 6400 万。限制本地解码协议及子进程执行时间；取消时回收 FFmpeg 子进程。
- 本地转换不发起模型请求。字节/时长/帧数/首帧一致性通过，不代表首尾动作自然衔接或人物稳定；循环观感在 M3 视觉验收。
- 记录 FFmpeg/ffprobe 的运行身份；未完成渲染恢复时环境变更明确报错，已渲染字节仍可本地发布。

## 4. 后续开发阶段

| 阶段 | 调整后的交付 |
| --- | --- |
| M2 | Seedream create/edit 正式工具、最小前台接入；图片生成→修改→新版本保存，项目和参考角色冻结 |
| M3 | Seedance 任务提交/查询/下载→本地 GIF→真实首帧；固定文字层、关键帧检查及循环视觉验收 |
| M4 | `image-production` skill、项目人物配置、不可变技能/执行器快照、依赖安装和 GIF 预览；已有安装显式可用 |
| M5 | 总管/员工后台接入、同远端 ID 恢复、报告归档、迟到结果不抢当前文件、后台视觉审阅 |

**M2 的交付顺序**

1. 把 Seedream 接到正式工具 `image_generate`，支持文生图及参考图编辑，明确区分模型输出尺寸和最终保存尺寸。
2. 从当前项目的对话调用该工具。首次请求绑定项目和选定的参考素材，后续“把衣服改一下”引用用户正在看的图片；改稿保存为新版本，返回可预览的项目文件。
3. 在言昕项目中以已定稿分身生成“元气满满”静态图，再改为白色圆领无帽卫衣并保存为 2:1 横版。核对人物辨识度、衣领与比例、两版文件的位置，以及刷新后能否重新打开。用同一请求回放检查能否取回已有结果。

**M3 实际验收**　项目对话已交付言昕「元气满满」的 4 秒动图、实际首帧及源视频，验证重启后跟进同一远端任务，以及固定文字、帧数、预览和下载。视觉上闭眼偏久，快速眨眼目标未达到。见 [M3 验收记录](../../research/opennova-gif-generation-m3.md)。M4 再用伍宝“我真是服了”验证跨角色复用及项目隔离，作为前台版本交付点。M5 用运行中重启、重复跟进及归档来验收后台版本。

**M4 前台验收**　`image-production`、项目角色配置、不可变执行器、GIF 本机打开与抽帧审阅已接入。见 [M4 验收记录](../../research/opennova-image-production-m4.md)。

**M5 后台验收**　主助手成功委派言昕 GIF，宿主重启后查询同一 Seedance 任务，员工接续并在原项目报告交付 GIF、实际首帧、源视频和检查页。伍宝案例复用原 GIF 进行只审阅任务。见 [M5 验收记录](../../research/opennova-image-production-m5.md)。

M2 的同步图片未知请求不能用新 operation 自动重提。M3 的视频有 task ID，可复用现有 `video-production` 宿主的异步任务跟进模式；持久写入与脱敏采用 M1 的新基础，不能原样复制旧 CLI 的完整远端回执。现有取消仅停止本地进程/跟进，不承诺远端任务或费用撤销。

固定文字仍采用已确认文字层在本地合成；不能假定 Seedance 会逐帧保持汉字不变，也不向视频接口伪造 GIF mask 参数。源 MP4 与最终 GIF 都保留，角色/服装/文字/动作的视觉审阅单独记录。

## 5. 验收与依赖

生产 Python 依赖只锁定 Pillow 13.0.0；Ark HTTP 使用标准库，另需 FFmpeg/ffprobe。旧 OpenAI SDK/探针只保留为历史资料与可选回归，不作为当前功能的默认后端或运行依赖；其依赖另存 `requirements-openai-legacy.lock.txt`。

本轮验收包括：契约严格校验、真实本地 MP4→GIF、最终首帧 RGBA、时长与帧数、取消/冲突/恢复、预算防重发、远端任务查询与下载脱敏、受控真实 Ark 请求。保持现有视频工具回归，并运行项目所需的测试、构建和 doctor。

前台/后台、skill、真实人物动画效果尚未接入的部分不得称为完成。结果在单独的 [Ark M0/M1 验收记录](../../research/opennova-image-gif-ark-verification.md) 中记录。
