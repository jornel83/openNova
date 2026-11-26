# OpenNova 接入与能力边界

业务知识与媒体文件分开存放：技能快照只包含说明、辅助脚本、原始清单；224 个原始工作文件位于 `workspaces/aesthetic-video-workflow/data/`。所有相对路径以真实 OpenNova 项目根目录为基准，不能以技能归档根目录为基准。后续产出可写入本工作区 `exports/`、`analysis/`，进度写入 `data/current_task/STATE.md`。

## 发现与分配

OpenNova 的 SkillStore 启动时扫描仓库 `skills/`。已有安装需重启后发现新技能；在技能/员工配置中将 `aesthetic-video-workflow` 与 `video-production` 同时分配给执行员工，保留其现有技能。视频任务需加载两者。首次初始化的新安装会将内置技能分配给总管，已有安装不会自动追加本业务技能。不要直接改 SQLite 或绕过任务权限。

用户可在关联此 OpenNova 仓库的项目中说：

> 使用 aesthetic-video-workflow 读取当前状态、检查素材，继续医美视频项目；需要生成或剪辑时配合 video-production。

这里只安装项目内技能，不修改全局 Codex 技能目录。在 Codex 中也可直接指定读取 `skills/aesthetic-video-workflow/SKILL.md`；是否出现在全局 `$` 自动补全中是另一项安装设置。

## 可直接复用

- 参考片元数据和抽帧：本技能 `scripts/media_probe.py`，仅本地 FFmpeg/ffprobe。
- 时间线、提示词、人物与场景一致性判断：本技能的偏好、历史、提示词入口。
- 单镜生成：`video_generate` 接受提示词或参考素材，返回本地 MP4。需要分步控制时可继续使用 `video_submit`、`video_status`、`video_wait`、`video_download`。
- 裁剪、拼接、帧率和尺寸统一：`video_edit`，先 `dry_run`，再输出到新文件名。

工具参数以项目中的 `skills/video-production/references/tool-contract.md` 与 `tools/video/tool-definitions.json` 为准。命令行入口为 `python3 tools/video/tool.py --request <请求文件>`，stdin 请求用 `--request -`。请求文件内路径相对该文件解析；stdin 内路径相对 cwd 解析。通过 OpenNova 任务执行时优先使用已有视频工具网关，遵守该任务的授权与记录机制。

Seedance 提交时由执行器提供 `ARK_API_KEY`。Spark Veda 使用执行器的 SSH 连接，默认主机为 `agent-gpu`。不要把凭据写入项目配置。

## 选择生成模型

在项目对话里说“按这份分镜生成成片”会选择 Seedance 2.0 Fast；说“用 Minimax H3 生成整片”会把各人物镜头送往 Spark。两条路径都可以先用 `video_validate` 检查，再用 `video_generate` 生成并下载。每镜保存实际模型、配置和任务 ID。

| 生成模型 | 配置中的 model | 首帧与镜头规格 |
|---|---|---|
| Seedance 2.0 Fast（默认） | `doubao-seedance-2-0-fast-260128` | `first_frame` 为方舟已入库的图片资产，也可用 `first_frame_path` 提供本地 PNG/JPEG，实际受服务端审核约束。支持 4–15 秒。本项目按分镜设置竖屏、分辨率和声音。 |
| Minimax H3 | `minimax-h3-veda` | 纯文本和首帧镜头都支持 4 至 15 秒的整数时长，默认 4 秒。首帧用 `first_frame_path` 传入本地 PNG/JPEG。交付 576×1024、24 fps 的竖屏视频。 |

业务脚本用于人像首帧镜头，Seedance 模式接受已入库的资产，Spark 模式接受本地首帧。省略 `--model` 即选 Seedance。纯文本镜头或用本地文件请求 Seedance 时，直接给 `video_generate` 传 `config`。生成的 JSON 可补充本镜所需的参数，并作为 `config_path` 交给已有视频工具。

```sh
python3 skills/aesthetic-video-workflow/scripts/shot_config.py --first-frame 'asset://asset-REPLACE_WITH_APPROVED_ID' --prompt '正面近景，自然眨眼。' > before-seedance.json
python3 skills/aesthetic-video-workflow/scripts/shot_config.py --model veda --duration 8 --first-frame ./首帧.png --prompt '正面近景，自然眨眼后缓慢转头。' > before-veda.json
```

Spark 任务等待 GPU 时按原任务 ID 续查。P2 Turbo 的独立模型 ID 是 `minimax-h3-spark`。生成期间不在 Veda、P2 和 Seedance 之间自动重投。

## 人像首帧生成

已适配历史 Fast 的 `asset://` 首帧路径。使用新配置字段 `first_frame`，由执行器原样映射为 `image_url.url` 与 `role: first_frame`，不再依赖旧 `generate.mjs`。配置示例：

```json
{
  "model": "doubao-seedance-2-0-fast-260128",
  "prompt": "保持首帧人物、服装、发型和光线，自然眨眼、轻微呼吸后小幅转头，无对白。",
  "first_frame": "asset://asset-REPLACE_WITH_APPROVED_ID",
  "duration": 4,
  "ratio": "9:16",
  "resolution": "480p",
  "generate_audio": false,
  "watermark": true,
  "return_last_frame": true
}
```

示例中的资产 ID 是占位符，换成当前人物对应、已审核的图片资产 ID 后才能生成。当前两张缺失原图仍须补齐并完成所需入库流程，不能用历史人物的资产 ID 代替。`first_frame` 必须显式指定模型；不能混用非空 `reference_images` / `reference_videos` 或 `omni_reference_task_type`。2.0 Fast 支持 480p/720p、4–15 秒；2.5 首帧要求 `ratio: adaptive`。首帧未传 ratio 时默认 adaptive，其余模式默认仍为 9:16。

### 接续顺序

1. 把每镜配置写到本轮新目录（例如 `exports/<本轮名称>/before-config.json`）；保留已授权的画质、时长、声音与提示词。不要覆盖旧项目。
2. 用 `video_validate` 传 `config` 或 `config_path`。`generation_mode: first_frame` 表示选择了首帧模式，`asset_validation: not_checked` 明确没有核验云端资产。资产需为同账号同项目的已审核图片（Active）。本工具不办理入库，也不调用需独立 AK/SK 的 GetAsset；实际可用性由方舟鉴权与审核决定。
3. 在已授权生成范围内调用 `video_submit`，为每一镜指定独立 `output_dir`。保存返回的 task ID；执行器会先保存 `config.json`、首帧 `request.json` 和提交标记，再发一次 POST。
4. `video_status` / `video_wait` 续查同一 ID；等待超时不重新提交。`succeeded` 后 `video_download` 下载；`task.json` 保留真实 usage、错误和请求的尾帧 URL。`return_last_frame` 不会自动下载尾帧图片。
5. 下载后检查画面、人物和动作，再通过 `video_edit` 的 dry run 和实际导出完成裁剪/拼接。核对实际返回规格与音轨；无声素材拼接时当前编辑器会补静音音轨。最终视频与费用证据写入 `data/current_task/STATE.md`。

先验证本地示例可运行：

```sh
python3 tools/video/tool.py --request tools/video/examples/asset-first-frame-validate.json
```

此命令不产生视频，示例占位符的校验通过不代表它是可用资产。真实任务需要有效资产、模型权限和配置好的 ARK_API_KEY。旧 skill 版本固定在旧任务里；服务重新扫描后，应创建加载新版 `video-production` 的任务使用首帧功能。

历史 `request.json` 是云端原生请求，不能原样当作工具 `config`。`projects/face_pair_480p_20261105/generate.mjs`、`build_final.py` 保留为档案，不作为新任务入口。旧记录的路径占位符仅供溯源；`build_final.py` 会覆盖同目录旧成片与时间线，不应在档案目录直接重跑。

参数于 2026-11-19 对照 [方舟创建视频任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) 与 [人像素材库](https://docs.volcengine.com/docs/ark/private-virtual-avatar-library-guide-preview?lang=zh) 核对。图片审批和账号权限需以实际调用时状态为准。

## 导出成片

普通拼接用 `video_edit.config.clips`；项目的 13.5 秒七段成片用 `video_edit.config.aesthetic_timeline`。传入模板、四条人物原片和静态对照图，可分别设置前状态、后状态、包扎与贴布的源片起始帧。片头上半屏会复用贴布原片。先 dry run 核对素材和时间线，再导出到新文件。完整请求见 [视频工具的导出示例](../../video-production/references/tool-contract.md)。

角标设置位于导出配置。省略 `show_ai_badge` 或设为 `false` 时，导出画面没有“AI 角色演示”文字及其底板。设为 `true` 可加回。重导使用各镜原片；已有成片上烧录的像素属于输入画面。方舟生成配置的 `watermark` 只传给云端服务商，与剪辑角标独立。

历史 task ID 和 usage 用于查证已有成果；不导入为当前 OpenNova 任务，不自动重试，也不据此恢复 89 条批量生成。
