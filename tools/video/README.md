# openNova 视频工具

视频工具支持方舟 Seedance、Spark 上的 Minimax H3 以及本地 FFmpeg 剪辑。医美工作流默认使用 Seedance 2.0 Fast，也可以选择 Minimax H3。
执行器使用 Python 3.10+。校验和生成交付文件需要 `ffprobe`，裁剪和合成视频需要 `ffmpeg`。
工具已接入 OpenNova 的任务视频网关；执行员工和任务需加载 `video-production` 技能。

## 直接运行

在仓库根目录执行：

```sh
python3 tools/video/tool.py --request tools/video/examples/validate.json
python3 tools/video/tool.py --catalog
```

方舟生成时由执行环境注入 `ARK_API_KEY`。Spark 生成使用执行器的 SSH 连接。
`examples/submit.json` 会产生一条收费的视频任务；用户授权生成后执行：

```sh
python3 tools/video/tool.py --request tools/video/examples/submit.json
```

已入库人像的严格首帧使用 `first_frame: "asset://asset-..."`，不要放进
`reference_images`。离线示例仅检查参数，不会提交任务：

```sh
python3 tools/video/tool.py --request tools/video/examples/asset-first-frame-validate.json
```

示例 ID 是占位符。实际生成前换成当前账号同项目下已审核的图片资产 ID。直接调用通用 CLI 时，使用资产 URI 的首帧请求要显式指定模型。本地 PNG/JPEG 首帧也可以通过 `first_frame_path` 传给 Seedance。加载医美工作流的 OpenNova 任务省略模型时，使用 `doubao-seedance-2-0-fast-260128`。离线结果 `asset_validation: not_checked` 只表示完成了本地参数校验。
首帧不能与参考图片/视频模式混用；默认比例为 `adaptive`，2.5 必须使用该比例；
2.0 Fast 支持 4–15 秒、480p/720p。`watermark`、`return_last_frame` 可显式设置。
提交前保存 `config.json` 和首帧请求的 `request.json`，随后沿用现有任务 ID 查询、
下载与剪辑。资产审核或跨账号错误不会触发自动重新提交。

CLI 不询问密钥，适合后台工具执行器。`submit` 立即返回任务 ID。
后续从同一个 `output_dir` 查询状态：

```sh
echo '{"action":"status","output_dir":"output/video-production/example-shot-01"}' | python3 tools/video/tool.py --request -
echo '{"action":"wait","output_dir":"output/video-production/example-shot-01","timeout_seconds":60}' | python3 tools/video/tool.py --request -
echo '{"action":"download","output_dir":"output/video-production/example-shot-01","filename":"opening.mp4"}' | python3 tools/video/tool.py --request -
```

## 一次调用生成视频

`video_generate` 提交一条任务、等待并下载 MP4。下面的 CLI 请求用 Minimax H3 从文字生成 4 秒短片。将 `first_frame_path` 加入 `config` 即可使用本地首帧，移除 `model` 则使用通用执行器默认的 Seedance 2.5。

```json
{
  "action": "generate",
  "config": {"model": "minimax-h3-veda", "prompt": "固定镜头，窗帘随微风轻轻摆动。", "duration": 4},
  "output_dir": "output/window-shot",
  "filename": "window.mp4",
  "timeout_seconds": 900
}
```

可以用 `config_path` 指向 JSON 配置。相对素材路径从该配置文件所在目录解析。生成成功返回 `status: succeeded`、`task_id`、绝对文件路径 `path`、`size_bytes`、`sha256` 和视频元数据 `metadata`。设置 `timeout_seconds: 0` 会立即进行一次状态查询。若仍在排队或生成中，使用返回的 ID、相同目录和文件名续查。下面的请求可直接交给 `--request`，将 ID 换成实际返回值即可。

```json
{"action":"generate","task_id":"返回的任务ID","output_dir":"output/window-shot","filename":"window.mp4","timeout_seconds":60}
```

每个 `output_dir` 对应一个任务。同配置重试沿用已提交的 ID。成片已经下载时，执行器校验本地摘要并返回文件。更换提示词、首帧或模型时，请使用另一个输出目录。

所有工具输入输出细节见
[tool-contract.md](../../skills/video-production/references/tool-contract.md)。
查询远端失败任务返回其 `status`；调用方必须检查状态，不只检查退出码。
已有 `task.json` 会阻止重复提交。方舟提交结果不明确时，先查方舟历史。Veda 提交中断时，用原 `output_dir` 查询已记录的任务。

`reference_videos` 支持本地 MP4/MOV 动作参考，使用 Seedance 2.5 或兼容接入点。
`validate` 离线检查视频规格，`submit` 将视频上传到官方 Ark Files（`purpose: agent`，
约一天保留期），等待文件可用后，将临时下载链接用于 `reference_video` 输入。
输入视频不使用 Base64；带签名链接仅保留在内存，配置与上传记录只保存本地路径、
文件 ID 和过期时间。`omni_reference_task_type` 自动设为 `reference`。
这组合了官方 Files 原文件下载与 Seedance URL 输入能力；若拿不到有效链接则停止生成。

## 剪辑

九分镜示例引用本次生成的本地素材，不携带图片或视频副本。
默认仅检查时间线，无生成费用：

```sh
python3 tools/video/tool.py --request tools/video/examples/nine-shots-edit.json
```

确认素材路径可用后，将请求的 `dry_run` 改为 `false`，导出到新文件名。
支持按顺序裁剪、合并、尺寸适配、帧率统一、保留音轨、缺失音轨补静音。
导出默认关闭“AI 角色演示”文字和底板。需要角标时，在 `video_edit` 的 `config` 中设置 `"show_ai_badge": true`，可先通过 `dry_run` 查看设置。方舟生成参数 `watermark` 单独控制平台水印。

医美工作流的 13.5 秒七段成片包含上下分屏、叠化和镜头名称。用 `video_edit` 导出时，在 `config.aesthetic_timeline` 填入 `template`、`before`、`after`、`wrap`、`tape` 和 `card` 六个本地素材路径。导出为 720×1280、30 fps，角标也由 `show_ai_badge` 控制。[完整请求与镜头取点示例](../../skills/video-production/references/tool-contract.md#aesthetic-seven-shot-export)

## 接入 openNova

工具定义采用常见 function-tool JSON 格式，位于 `tool-definitions.json`。
注册 `video_validate`、`video_submit`、`video_status`、`video_wait`、
`video_download`、`video_edit` 和 `video_generate`。Python 调用示例：

```python
from tools.video.tool import invoke

result = invoke("video_validate", {
    "config_path": "tools/video/examples/shot-02.json"
}, base_dir=project_root)
```

Node 服务可用 `spawn` 启动 Python 子进程，并向 stdin 写入 JSON：

```js
const actions = {
  video_validate: 'validate', video_submit: 'submit', video_status: 'status',
  video_wait: 'wait', video_download: 'download', video_edit: 'edit', video_generate: 'generate',
};
// 网关先验证工具名、参数 schema、用户身份、成本与文件权限。
// 禁止 args.action，避免只授权 validate 却通过参数覆盖为 submit。
if (!Object.hasOwn(actions, name) || Object.hasOwn(args, 'action')) throw new Error('Invalid tool');
const child = spawn(pythonExecutable, [absoluteToolPath, '--request', '-'], {
  cwd: authorizedWorkspace,
  env: { ...process.env, ARK_API_KEY: userCredential },
  shell: false,
});
child.stdin.end(JSON.stringify({ ...args, action: actions[name] }));
// 收集 stdout 的单个 JSON 结果并检查 ok/status；stderr 仅供执行器诊断。
```

工具本身是可信本地执行组件，不是多租户沙箱。网关需要校验工作区内的
配置、图片、输入视频和输出路径，包含符号链接的真实路径；按用户隔离密钥
与任务目录。Skill 不绕过这些权限控制。子进程在 POST 后中断时可能留下
`submitting` 记录，先查询方舟任务历史，避免重复计费。

将 `skills/video-production/SKILL.md` 注册到 Harness 的 skill 搜索目录。
将 skill 保留在工程内，使用其完整路径注册；启动器始终加载本仓库代码，
不再使用 `OPENNOVA_ROOT` 跳转工程。不自动修改用户的全局 skill 配置。

## 验证

```sh
python3 -m unittest discover -s tools/video/tests -v
```

测试涵盖请求校验、密钥脱敏、防重复提交、未知提交结果、任务恢复、裁剪边界、
输出保护、工具名派发和真实 FFmpeg 合并。测试不调用收费 API。
`examples/shot-01.json` 到 `shot-09.json` 保留本次提示词与设置，参考图路径
相对示例文件解析。若素材不在当前仓库，替换路径后再校验。

## Spark 上的 Minimax H3

选择 Minimax H3 时，`video_validate`、`video_submit` 和 `video_generate` 共用下面的配置。把 `first_frame_path` 换成准备好的本地 PNG/JPEG（最大 30 MiB，路径相对于配置文件）。只给提示词时，模型直接进行文生视频。

```json
{"model":"minimax-h3-veda","first_frame_path":"贴布.png","prompt":"固定镜头，人物轻轻转头后回正。","duration":4,"ratio":"9:16","seed":1101}
```

| 模型 ID | 运行方式 | 竖屏原片规格 |
|---|---|---|
| `minimax-h3-veda` | ComfyUI，稀疏率 90% | 576×1024、24 fps、4 步。文生视频和首帧生视频均可请求 4–15 秒的整数时长。模型按 `17k+5` 向上对齐帧数，`video_generate` 自动裁至指定时长。例如，4 秒生成 107 帧、交付 96 帧；15 秒生成 362 帧、交付 360 帧。 |
| `minimax-h3-spark` | P2 Turbo，vLLM-Omni | 可请求 4、5、6 秒，768×1344，24 fps，5 步。 |

两种模式的默认种子均为 1101。执行器通过非交互 SSH 访问 Spark，别名由 `OPENNOVA_SPARK_SSH_HOST` 指定，默认为 `agent-gpu`。Veda 使用部署好的 ComfyUI 镜像、权重和配置，等待共享 GPU 锁后启动。若 GPU 仍被其他服务占用，可在任务详情中查看失败原因。P2 使用 Spark 的 `127.0.0.1:8000/v1/videos`，下载前需要保持该服务在线。

需要含音轨的原始 MP4 时，可以使用 `video_submit`，在同一个 `output_dir` 调用 `video_status`、`video_wait` 和 `video_download`。Minimax H3 下载时校验 Spark 提供的 SHA-256 摘要。
