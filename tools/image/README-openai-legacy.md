> 历史说明：用户已切换到火山方舟，当前使用方法见 [README.md](README.md)。以下保留原 OpenAI 路线验收语境。

# OpenNova 图片与 GIF 基础工具

2026-11-18：M1 提供本地导出、持久操作记录及 GIF/首帧交付包；M0 提供离线检查和有预算的真实接口探针。`image_generate`、`gif_generate` 当前只有契约，调用返回 `media_generation_not_implemented`。前台工具、生成服务和 `image-production` skill 留在 M2–M4，尚未注册到 OpenNova。

## 独立运行环境

需要 Python 3.11+、POSIX 文件锁和支持硬链接的本地文件系统。当前锁定环境验证于 macOS / Python 3.11.15；其他平台尚未验收。Pillow 负责 M1 编解码，无需 FFmpeg。环境检查同时报告 FFmpeg，供后续阶段使用。

在仓库根目录执行：

```sh
python3.11 -m venv output/image/runtime/production
output/image/runtime/production/bin/python -m pip install -r tools/image/requirements.lock.txt
output/image/runtime/production/bin/python -m tools.image.probe --check
output/image/runtime/production/bin/python -m unittest discover -s tools/image/tests -v
```

`requirements.txt` 固定直接依赖；`requirements.lock.txt` 固定本次验证的完整依赖集，安装时使用后者。OpenAI SDK 3.54.0、Pillow 13.0.0 均安装到独立虚拟环境，不依赖 Codex 内置生图工具。缺少 SDK 的本地测试会明确跳过 SDK 序列化测试；发布验收须在锁定环境中实际执行。

默认 `pnpm test` 包含 `tools/image/tests`。使用 `OPENNOVA_IMAGE_PYTHON=/absolute/path/to/venv/bin/python` 指定该组独立解释器，其他 Python 测试仍使用 `OPENNOVA_PYTHON`。仓库的 Node 命令需要 Node 24。

## M0 凭据与探针

`--check` 不联网、不创建 API 客户端，不输出 key 或文件路径。它报告依赖、凭据是否配置，以及保持 `unverified` 的静态编辑/原生 GIF 能力。

本实现接受 `OPENAI_API_KEY`，或 `--key-file` / `OPENNOVA_OPENAI_KEY_FILE` 指定的私有文件。优先级是显式文件、环境变量指定文件、key 环境变量。文件须位于仓库外，由当前用户拥有、为普通文件、非符号链接，且不允许组或其他用户访问（例如权限 `600`）。不读取 ChatGPT/Codex 的登录缓存或 Ark key。

OpenNova 现有 Sign in with ChatGPT（SIWC）只授权符合条件的 Responses 推理，当前预览明确不支持图片生成，不能把该登录 token 当成 Images API key。OpenAI API 的 Workload Identity Federation 是另一个需要组织/项目身份配置的方案，本阶段未实现。[SIWC 限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [允许的推理端点](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) · [WIF](https://developers.openai.com/api/docs/guides/workload-identity-federation)

有独立 API 凭据后，显式执行以下探针会产生最多两次 API 请求：

```sh
output/image/runtime/production/bin/python -m tools.image.probe --live \
  --model gpt-image-2.6-sunburst \
  --key-file ~/.config/opennova/openai-api-key \
  --session-dir output/image/probes/first-account-check \
  --max-requests 2
```

探针用本地小圆形图片进行一次静态编辑、一次原生 GIF 编辑，不上传项目人物素材。模型为显式参数，示例模型只是计划候选，不代表账号已获权限。可以用 `--feature static_edit` 或 `--feature native_gif` 选其中一项。

- 固定官方 `/v1/images/edits`，超时 120 秒、SDK 重试 0、禁止 HTTP 跳转；不换模型或接口重试。
- 请求发送前持久占用预算。预算是请求次数，不是金额；同一 session 的预算不能提高。中断后继续使用原 session，不能删除记录来重试未知请求。
- 同一 session/feature 不重复发送；失败或结果未知立即停止后续请求。已有成功结果、失败及未知状态均可审计。
- 原生 GIF 要求模型的 GIF preview 权限。参数可序列化不证明服务端支持；SDK 离线测试不替代真实调用。
- 输出能力结论与错误分类分开：无权限、额度、审核、临时故障、明确不支持等；网络故障保持 `unverified`。无 usage 则记录 `null`，不能假填零费用。
- CLI 接收到中断不承诺供应商已取消；发送前的持久 `unknown` 预留阻止重启后盲目重发。尚无后台任务取消桥接。

接口依据：[Images edit](https://developers.openai.com/api/reference/resources/images/methods/edit) · [GIF 输出指南](https://developers.openai.com/api/docs/guides/image-generation#generate-animated-gif-output)。当前账号真实编辑及原生 GIF 均未验证。

## 本地工具入口

固定 JSON envelope 包含公开工具参数和独立宿主 context。`operationId` 是一次用户动作的稳定身份；同一次动作重放保留它，新的“再导出”使用新的标识。未来宿主应自行注入 context，不能让模型填写项目、请求或任务身份。

```json
{
  "tool": "media_export",
  "arguments": {
    "action": "first_frame",
    "sourcePath": "assets/example.gif",
    "outputPath": "assets/example_首帧_v2.png"
  },
  "context": {
    "operationId": "export-first-frame-001",
    "workspace": "/absolute/path/to/project",
    "stateDir": "/absolute/path/to/private-media-state",
    "binding": {"projectId": "example", "requestId": "request-001"}
  }
}
```

```sh
output/image/runtime/production/bin/python tools/image/tool.py --request /absolute/path/request.json
# 也可从 stdin 读取同样的 envelope：--request -
```

请求最大 1 MiB，文件输入必须是普通文件。相对素材路径以 `workspace` 为基准。默认只创建新文件：`expectedTarget` 仅接受 `absent`，无覆盖开关。stdout 返回 JSON 元数据，不返回图片 Base64。

| action | 输入和输出 | 约束 |
| --- | --- | --- |
| `first_frame` | 已有图片/动画 → PNG | 从实际解码第 0 帧提取，未要求背景合成时逐像素保留 RGBA；不借用静态方案图 |
| `resize` | PNG/JPEG/WebP/GIF → 指定格式 | 必填 `width`、`height`；`contain` 等比缩放后补足精确画布，`cover` 为显式等比裁剪 |
| `convert_image` | 静态 PNG/JPEG/WebP → PNG/JPEG/WebP | 拒绝动画输入，避免静默丢帧；透明图转 JPEG 必须给 `background` |
| `optimize_gif` | GIF → GIF | 保留尺寸、帧数、时间数组及循环；需要缩放请使用 `resize` |
| `assemble_frames` | `frames:[{path,durationMs}]` → GIF | 最多 256 张静态帧，每帧延时 20–655350 ms 且为 10 ms 的整数倍 |

公共参数包括 `outputFormat`、`width/height`、`fit`、`background`（`#RRGGBB`）、`quality`、`colors`、`loop`、`maxBytes`，具体组合由 schema 校验。GIF 的 `loop=0` 表示无限循环；未指定则保留源值，包括缺少循环扩展的情况。

GIF 压缩在有限调色板候选内尝试，自动不低于 64 色；用户明确指定更低颜色数才允许该值。默认优化若重编码变大且原图已满足体积要求，保留原始字节。无法满足 `maxBytes` 时失败并报告 `smallestBytes`，不会偷偷减帧、加速或裁剪。JPEG/WebP 在指定体积上限时会尝试降低编码质量，是否可接受仍需视觉检查。

源文件单个不超过 20 MiB、总和不超过 64 MiB；解码最多 512 帧、总像素 6400 万，输出边长最多 4096。所有帧均解码检查。GIF 只支持离散透明度，不能承诺保留 PNG 的半透明边缘；PNG/WebP 可保留 alpha。JPEG 的透明/补边须明确背景颜色。

## 操作记录与交付

每次操作冻结规范参数、输入副本及 SHA-256、项目/请求绑定和输出位置。阶段依次为 `created → prepared → rendered → publishing → committed`。暂存渲染完成后，先保存发布意图，再在目标目录内以硬链接无覆盖发布；源图片绝不原地修改。

重放校验动作参数与绑定。完成结果直接核验并返回；原输入后续修改或删除不影响已冻结操作。重启可以复用已渲染字节。目标抢先创建、输入副本被改写或输出被外部修改均明确报错，不覆盖或重新生成。已发布事实优先于迟到取消和记账失败；记录写入暂不可用时返回 `bookkeepingPending`，下次继续对账。

`tools.image.bundle.run_gif_bundle` 是宿主内部基础接口，将一次本地 GIF 导出与最终 GIF 的真实首帧组成交付包。它使用稳定子操作并记录父 manifest，重启只补本地未完成步骤。多文件并非一次原子发布；`partial` 明确表示部分成果已提交，不能当作完整交付。父/子失败或取消不会偷偷创建新操作继续执行。

```python
from tools.image.bundle import run_gif_bundle

receipt = run_gif_bundle(
    {"action": "optimize_gif", "sourcePath": "input.gif",
     "outputPath": "exports/final_v1.gif", "maxBytes": 2 * 1024 * 1024},
    "exports/final_v1_首帧.png",
    base_dir="/absolute/path/to/project",
    state_dir="/absolute/path/to/private-media-state",
    operation_id="gif-delivery-001",
    binding={"projectId": "example", "requestId": "request-001"},
)
```

父记录位于 `stateDir/.gif-bundles/<operationId>/manifest.json`，回执提供实际路径及哈希。记录丢失会明确停止；不能删掉 state 目录后对同一输出假装是新请求。`partial` 无 `terminalStatus` 可继续本地恢复；带 `failed/cancelled` 则保持终态，但仍允许修补已经保存的子产物记账。

回执独立记录 `generation`（本地导出为 `not_applicable`、`remoteCalls:0`）、`fileValidation`、`animationValidation`、`visualReview`。解码、帧数、时间核验通过不代表人物动作或文字质量通过；未实际审阅时 `visualReview=not_checked`。

常见错误：`media_target_exists`、`operation_id_conflict`、`operation_in_progress`、`input_snapshot_changed`、`committed_artifact_changed`、`background_required`、`animated_source_not_allowed`、`size_limit_exceeded`。错误只返回稳定代码及必要字段，避免透出 SDK 服务端消息或凭据。

此阶段仅提供可信本地宿主调用基础。state 目录属于宿主管理的私有数据；前台准入、路径权限、角色版本冻结、后台沙箱和 skill 快照接入按 M2–M5 实现。不能直接将该 CLI 暴露为任意远端用户的文件写入接口。
