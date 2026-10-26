# openNova 视频工具

把 Seedance 分镜生成与 FFmpeg 剪辑封装为六个可注册的工具。
Python 3.10+，生成模块仅使用标准库；剪辑另需 `ffmpeg`、`ffprobe`。
工具与 skill 已放进仓库，尚未注册到 openNova 的线上运行时。

## 直接运行

在仓库根目录执行：

```sh
python3 tools/video/tool.py --request tools/video/examples/validate.json
python3 tools/video/tool.py --catalog
```

生成时由执行环境注入 `ARK_API_KEY`，不接受请求中的密钥字段。
`examples/submit.json` 会产生一条收费的视频任务；用户授权生成后执行：

```sh
python3 tools/video/tool.py --request tools/video/examples/submit.json
```

CLI 不询问密钥，适合后台工具执行器。`submit` 立即返回任务 ID。
后续从同一个 `output_dir` 查询状态：

```sh
echo '{"action":"status","output_dir":"output/video-production/example-shot-01"}' | python3 tools/video/tool.py --request -
echo '{"action":"wait","output_dir":"output/video-production/example-shot-01","timeout_seconds":60}' | python3 tools/video/tool.py --request -
echo '{"action":"download","output_dir":"output/video-production/example-shot-01","filename":"opening.mp4"}' | python3 tools/video/tool.py --request -
```

所有工具输入输出细节见
[tool-contract.md](../../skills/video-production/references/tool-contract.md)。
查询远端失败任务返回其 `status`；调用方必须检查状态，不只检查退出码。
POST 不自动重试。已有 `task.json` 会阻止重复提交，未知提交结果需先查方舟历史。

## 剪辑

九分镜示例引用本次生成的本地素材，不携带图片或视频副本。
默认仅检查时间线，无生成费用：

```sh
python3 tools/video/tool.py --request tools/video/examples/nine-shots-edit.json
```

确认素材路径可用后，将请求的 `dry_run` 改为 `false`，导出到新文件名。
支持按顺序裁剪、合并、尺寸适配、帧率统一、保留音轨、缺失音轨补静音。
不提供叠化、背景音乐、字幕或时间线 GUI。原始素材和已有输出不会覆盖。

## 接入 openNova

工具定义采用常见 function-tool JSON 格式，位于 `tool-definitions.json`。
注册 `video_validate`、`video_submit`、`video_status`、`video_wait`、
`video_download`、`video_edit`。Python 调用示例：

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
  video_wait: 'wait', video_download: 'download', video_edit: 'edit',
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
需要给 Codex 使用时，可复制该 skill 文件夹到 `~/.codex/skills/`，并设置
`OPENNOVA_ROOT` 指向此仓库；不自动修改用户的全局 skill 配置。

## 验证

```sh
python3 -m unittest discover -s tools/video/tests -v
```

测试涵盖请求校验、密钥脱敏、防重复提交、未知提交结果、任务恢复、裁剪边界、
输出保护、工具名派发和真实 FFmpeg 合并。测试不调用收费 API。
`examples/shot-01.json` 到 `shot-09.json` 保留本次提示词与设置，参考图路径
相对示例文件解析。若素材不在当前仓库，替换路径后再校验。
