# OpenNova 图片与 GIF

静态图支持方舟 Seedream 和 Spark 上的 Minimax H3 Image。GIF 使用 Seedance 生成源视频，再在本地转换，交付 GIF、真实首帧和源视频。工具冻结输入并按独立操作保存结果。

项目工作对话中的 `image_generate` 默认使用 Seedream 生成和修改静态图。指定 `model: "minimax-h3-image"` 或 `provider: "spark"` 可改用 Spark。`gif_generate` 通过 Seedance 和本地导出生成 GIF。本地 MP4 转 GIF、首帧提取和账号能力探针仍可独立使用。旧 OpenAI 探针见 [历史说明](README-openai-legacy.md)。

## 在项目对话里生成 GIF

选中项目里的 PNG、JPEG 或 WebP 后，可以说：“把这张图做成 4 秒循环动图：眨一次眼，双拳轻抬后回到原位。横版 640×320，每秒 10 帧，存到 `assets/表情包/元气满满_动图_v1`。”目标目录须为新目录，其上一级目录须已存在。也可以在对话里直接引用同项目内的静态图。

- Seedance 提交后，项目对话用成果卡显示进度，任务在后台继续。重启恢复时查询已保存的任务 ID；提交结果未知且无 ID 时不会自动重发。
- 同一个新目录交付 `animation.gif`、从最终 GIF 解码的 `first-frame.png`、Seedance 原始 `source.mp4`。导出失败时，已保存的源视频仍可下载，用本地入口重做，不需重新生成视频。
- 动图文字需要保持稳定时，可提供无字动作参考和同尺寸的透明 PNG 文字层。文字由本地合成固定在每一帧；如果只提交一张带字静态图，交给 Seedance 的文字不保证稳定。
- 时长、帧数、无限循环标记和首帧一致性由程序验证。角色、衣着和动作衔接仍需点开动图看一遍。GIF 不包含声音。

## 使用 `image-production` 技能和项目角色

在目标项目对主助手说：“用 `image-production`，按本项目的伍宝定稿做一张表情图”，或“用这张确认稿做成 GIF，只出现伍宝”。只说“先给我提示词”时，技能不会调用 Seedream 或 Seedance。已有安装升级后，从技能页或对话里的 `skill_list` 查看主助手绑定；若之前已停用或移除，可手动重新绑定。

项目维护者将角色定稿索引放在项目根下的 `.opennova/image-characters.json`。格式是 `{ "schemaVersion": 1, "characters": [...] }`，每个角色包括 `id`、`name`、`version`、`constraints` 和 `references: [{ "path": "相对项目路径", "sha256": "64 位十六进制" }]`。`constraints` 只描述身份和造型识别点。通过新版本记录获准的定稿更新；参考文件变动后旧哈希不会自动通过。具体作品的服装、背景、文案和动作仍由本次请求指定。

成果卡可以播放、下载和本机打开 GIF；从对话要求“抽帧审阅”时，模型只读取带索引的 PNG 检查页。回执记录被审阅的 GIF 哈希、模型、总帧数及实际检查索引。要求提取首帧、压缩或用已有视频转 GIF 时，前台 `media_export` 在本地完成，无生成请求。

## 委派给后台员工

先在团队技能页把 `image-production` 绑定给目标员工，再在原项目说：“把这张确认稿交给图片员工，在后台做成 GIF。只用这一版做参考，完成后抽帧审阅，保存到 `assets/表情包/元气满满_动图_v2`。”需要用无字动作图和独立文字层时，一起指出项目里的参考文件。仅要提示词时，不需要运行生成任务。

- 委派记录锁定项目、角色、参考文件哈希、技能版本和这次允许的操作。默认输出到任务工作区；明确给出项目内的新路径时，才允许从任务写回该位置。静态图用新文件名，GIF 用新目录。
- 员工提交 GIF 后会释放执行位；稍后按同一个 Seedance 任务编号接续。暂停、取消或关闭会停止本地跟进，不会撤销已发生的远端生成。提交结果未知时不会自动重提；已知任务可以接续原编号。
- 在「后台任务」成果报告打开 GIF、实际首帧、源视频和有记录的检查页。报告按回执收录文件，每个不超过 20 MiB，合计不超过 64 MiB，最多 50 项。查看后台结果不会替换前台正在使用的项目或文件。

## 在项目对话里生成和修改图片

先进入目标项目，给出画面描述。需要沿用角色时可以引用项目内的定稿文件，例如“根据 assets/卡通分身/言昕_艾莎罗宾_半写实探索_v1.png 做一张‘元气满满’的图，存到 assets/表情包/元气满满_v1.png”。已有参考图可使用 PNG、JPEG 或 WebP。要从零创作，直接描述画面和目标文件即可。

完成后在对话里预览图片。继续说“把这张图改成白色圆领无帽卫衣，另存为 1536 × 768 的横版”，工具会使用当前项目中选定的图片。每版保存到独立路径。需要修改旧版时，从对应的成果选择那一版后再提出修改。

宿主通过 `tools/image/tool.py --request -` 调用固定执行器。模型提交 `mode`、`prompt`、`outputPath`、可选的 `references`、`width`/`height` 等参数，宿主提供项目、请求、操作和状态目录。`size` 表示模型的生成尺寸，`width`/`height` 是最终文件尺寸。回执包含产物路径、实际宽高、文件哈希和生成模型。

同一操作重放可取回原结果。方舟同步提交后如果连接中断且没有可恢复的产物，状态会显示结果未知。可先在方舟核对该次调用，再决定是否发起新的生成。

### 使用 Spark 上的 Minimax H3 Image

| 模式 | 输入 | 模型输出 |
| --- | --- | --- |
| `create` | 文本提示词 | 2048 × 2048 PNG |
| `edit` | 文本提示词和一张方形参考图 | 2048 × 2048 PNG |
| `edit` | 文本提示词和一张 9:16 竖屏参考图 | 864 × 1536 PNG |

参考图可用 PNG、JPEG 或 WebP。工具按照片方向读取图片并自动匹配参考图比例，方图缩放到 1024 × 1024，竖图缩放到 720 × 1280。符合对应输入尺寸的 PNG 可直接使用。交付文件可选 PNG、JPEG 或 WebP。比如在项目对话中说“用 Minimax H3 Image，以 assets/贴布首帧.png 为参考，保留贴布位置并改用柔和侧光，保存到 assets/贴布侧光.png”。

宿主需要能通过非交互 SSH 连到已部署 H3 Image 的 Spark。默认 SSH 别名为 `agent-gpu`，可通过宿主环境的 `OPENNOVA_SPARK_SSH_HOST` 设置。当前配置使用 `~/h3-image-deploy/build` 内的锁定推理组件和已部署权重。工具在提交前保存任务 ID，使用 Spark 与视频推理共享的 GPU 锁排队。按同一操作可查询进度，完成后校验原始图片的大小、SHA-256 和分辨率，再发布到指定项目路径。

## 安装与检查

项目安装会使用 Python 3.11 和 uv 准备锁定的 Pillow 环境。已有安装可以只补图片依赖：

```sh
pnpm run setup -- --image-only
```

视频转 GIF 另需系统可用的 FFmpeg 和 ffprobe，静态生图和其他本地图片导出不依赖两者。POSIX 文件锁与目标目录硬链接已在 macOS 验证，Windows/网络文件系统未验收。Ark HTTP 使用标准库，无需外部 SDK；可选旧 OpenAI 回归依赖在 `requirements-openai-legacy.lock.txt`。

OpenNova 在调用时校验技能版本中冻结的执行器和 `requirements.lock.txt`。依赖环境目录按锁文件哈希区分，安装新锁不会升级旧环境。已明确配置 `OPENNOVA_IMAGE_PYTHON` 时也验证 Python 和 Pillow 版本；缺少或不兼容时不会提交远端生成。需恢复旧版环境时，使用 `python3.11 tools/setup/image-runtime.py --lock /absolute/path/to/archived/requirements.lock.txt`。

`pnpm test` 包含图片组；`pnpm run doctor` 检查本地配置。需要运行独立探针时，可取安装命令给出的解释器路径：

```sh
image_python="$(python3.11 tools/setup/image-runtime.py)"
"$image_python" -m tools.image.ark_probe --check
```

## 凭据与 M0 探针

图片编辑和 GIF 的 Seedance 步骤共用图片/GIF 专用 key。默认从 `~/.config/opennova/ark-image-gif.key` 读取，可通过 `OPENNOVA_IMAGE_ARK_KEY_FILE` 指定其他私有文件。CLI 的 `--key-file` 优先级最高。只有未配置专用文件时才依次尝试 `OPENNOVA_ARK_KEY_FILE`、`ARK_API_KEY` 和 `~/.config/opennova/ark.key`。选中的文件无效时会报错。独立视频工具继续使用原有视频凭据。

凭据文件须位于仓库外，属于当前用户，且为普通文件，权限建议设为 `0600`。工具拒绝符号链接和允许组或其他用户访问的文件。请勿把 key 写入请求 JSON、提示词、skill 或日志。

`--check` 只检查本地环境、凭据是否配置，不发生成请求。模型 ID 是候选配置；正确编码请求不等于账号有权限。

真实探针显式使用 `--live`、稳定 session 和最多两次生成请求预算：一张简单圆形的 Seedream 参考编辑，一个 4 秒、480p、无音频的 Seedance 图生视频。选项以 `python -m tools.image.ark_probe --help` 为准，实际命令及结果见 [验收记录](../../docs/research/opennova-image-gif-ark-verification.md)。

- 官方端点固定为 `https://ark.cn-beijing.volces.com/api/v3`，发送前持久占用预算，POST 不自动重试。
- 静态走 `/images/generations`；视频走 `/contents/generations/tasks`，后续查询同一 task ID。
- 图片失败/未知不切换模型或路线重付费。视频无 ID 的未知提交须先核对远端历史；有 ID 时继续查询它，不再提交。
- 下载失败只重下原任务；签名链接仅在内存，不转发 Ark Authorization 到存储域名。
- 原始 PNG/MP4 与后处理 GIF/首帧分开保存。权限、额度、审核、暂时故障、未知与文件核验分别记录。
- 本地取消不代表远端已撤销或退费。GIF 没有音轨，有配乐时另交付 MP4。

官方文档：[Seedream 5.5](https://ark.volcengine.com/region:cn-beijing/docs/seedream-5-5)、[Seedance 2.5](https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5)。

## 本地导出入口

模型填写 `arguments`，独立的 `context` 由可信宿主注入：

```json
{
  "tool": "media_export",
  "arguments": {
    "action": "video_to_gif",
    "sourcePath": "source.mp4",
    "outputPath": "exports/final_v1.gif",
    "width": 640,
    "height": 320,
    "fps": 10,
    "startMs": 0,
    "durationMs": 4000,
    "maxBytes": 2097152
  },
  "context": {
    "operationId": "export-video-gif-001",
    "workspace": "/absolute/path/to/project",
    "stateDir": "/absolute/path/to/private-media-state",
    "binding": {"projectId": "example", "requestId": "request-001"}
  }
}
```

```sh
"$image_python" tools/image/tool.py --request /absolute/path/request.json
# stdin 同样支持：--request -
```

相对素材路径以 workspace 为基准。请求文件须为普通文件，大小上限 1 MiB。stdout 为元数据 JSON，不返回 Base64。expectedTarget 只允许 absent，没有覆盖开关。

| action | 输出及限制 |
| --- | --- |
| first_frame | 实际解码第 0 帧 → PNG，未指定背景变换时精确保留 RGBA |
| resize | 精确 width/height，contain 等比缩放补边，cover 明确等比裁剪 |
| convert_image | 静态 PNG/JPEG/WebP 互转，拒绝动画；透明转 JPEG 要显式 background |
| optimize_gif | 保留原尺寸、逐帧时间、帧数和循环；改尺寸使用 resize |
| assemble_frames | 静态帧数组 {path,durationMs} → GIF，最多 256 帧，延时为 10 ms 整数倍 |
| video_to_gif | 本地 MP4/MOV → GIF；fps=5/10/20/25，默认 4 秒、10 fps，不含音轨 |

视频的 startMs/durationMs 选择时间段。源剩余片段不足请求时长时，按完整帧周期向下取整并记录请求与实际时长；不足一帧失败。无尺寸参数时等比控制长边 ≤512；指定尺寸时交付精确画布，不拉伸人物。只有 cover 才裁剪。loop=0 为无限循环，视频转 GIF 默认使用它。

GIF 压缩只尝试有限调色板，自动最低 64 色；明确要求更低颜色数才允许该值。无法满足 maxBytes 时返回 size_limit_exceeded 和实际最小字节数，不偷偷减帧/加速。默认优化若重编码更大且原图已合格，会保留原字节。GIF 不支持连续 alpha；PNG/WebP 可保留半透明。

输入单文件 ≤20 MiB、总量 ≤64 MiB；图片最多解码 512 帧，视频最多抽取 256 帧，总像素 ≤6400 万；输出边长 ≤4096。视频子进程限定本地协议、超时和取消，以固定参数数组执行，不拼接 shell。

## GIF / 首帧交付包

```python
from tools.image.bundle import run_gif_bundle

receipt = run_gif_bundle(
    {"action": "video_to_gif", "sourcePath": "source.mp4",
     "outputPath": "exports/final_v1.gif", "durationMs": 4000,
     "fps": 10, "width": 640, "height": 320},
    "exports/final_v1_首帧.png",
    base_dir="/absolute/path/to/project",
    state_dir="/absolute/path/to/private-media-state",
    operation_id="gif-delivery-001",
    binding={"projectId": "example", "requestId": "request-001"},
)
```

父 manifest 在 stateDir/.gif-bundles/operationId/manifest.json。首帧来自最终 GIF，回执含来源 SHA 和 RGBA 核对。多文件非原子提交：partial 无 terminalStatus 可恢复，带 failed/cancelled 则保持终态，只补已保存子操作的账。

操作阶段为 created → prepared → rendered → publishing → committed，冻结输入、参数、绑定与执行器版本。发布前后检查身份/hash，无覆盖。已保存而记账暂失败时返回 bookkeepingPending，下次只补记账；原输入变化/删除不使已完成动作重新编码。

prepared 恢复需重新渲染时检查执行器/Pillow；视频还核对 FFmpeg/ffprobe 身份。环境变化明确失败，已有 rendered/completed 字节仍可复用。父/子记录丢失会停止，不冒充新请求。

本地 generation.remoteCalls=0；结构核验和 visualReview 独立，未实际审阅保持 not_checked。循环扩展存在不等于首尾动作自然衔接。

当前是可信本地组件。前台准入、项目权限、角色配置、skill 快照、后台任务和完整视觉验收按 [当前计划](../../docs/superpowers/plans/2026-11-18-image-gif-ark-migration.md) 接入。
