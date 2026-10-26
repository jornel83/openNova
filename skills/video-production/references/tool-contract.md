# Tool contract

Repository implementation: `tools/video/tool.py`. Tool definitions:
`tools/video/tool-definitions.json`. Python callers use
`invoke("video_submit", arguments, base_dir=project_directory)`.
CLI requests use `{"action":"submit", ...arguments}`.

| Tool | Input | Result | Effect |
|---|---|---|---|
| video_validate | config or config_path | validated settings and reference_count | Local read |
| video_submit | config or config_path, output_dir | task_id and submitted status | One billable API submission |
| video_status | output_dir, optional task_id | provider task and current status | API read and local task record update |
| video_wait | status inputs, poll_seconds, timeout_seconds | current task, timed_out when still pending | Bounded polling |
| video_download | status inputs, optional filename | local path and size_bytes | Download succeeded task, no overwrite |
| video_edit | config or config_path, optional dry_run | plan or completed local artifact metadata | Local FFmpeg export |

Generation configuration:

```json
{
  "model": "doubao-seedance-2-5-260628",
  "prompt": "@图片1规定人物与场景。8秒，镜头缓慢推进到空白调色盘。",
  "duration": 8,
  "ratio": "9:16",
  "resolution": "720p",
  "generate_audio": true,
  "reference_images": ["references/opening.png"]
}
```

The model ID is the version used for the existing clips, not a promise that
every account enables it. Supply an enabled Ark model or endpoint ID as needed.
Durations are integer seconds from 4 to 30. Resolutions are 480p, 720p, 1080p.
Up to 30 local reference images are supported. The tool checks per-image and
request-size limits and embeds images as Base64. Validate image contents with
the image viewer; path validation cannot establish artistic suitability.

Request paths (`config_path`, `output_dir`) resolve relative to `base_dir`.
CLI `base_dir` is the request JSON file's parent, or cwd for stdin. Paths inside
a config resolve relative to its file; inline config paths resolve relative to
`base_dir`. Returned artifact paths are absolute.

Use `config` or `config_path`, never both. Keep output directories per task.
`task.json` is created exclusively before POST and persists the task ID and
state. A status request can recover an old task using its ID. If a record has no
ID because submission was interrupted, check provider history manually.

Edit configuration:

```json
{
  "clips": [
    {"path": "clips/shot-01.mp4", "duration": 8},
    {"path": "clips/shot-02.mp4", "start": 0, "duration": 10}
  ],
  "output": "exports/film.mp4",
  "width": 720,
  "height": 1280,
  "fps": 24,
  "crf": 18
}
```

Trim durations are quantized to output frames. Other aspect ratios are fitted
with padding, without stretching or cropping. Outputs are H.264/AAC MP4 with
faststart. `FFMPEG_BIN` and `FFPROBE_BIN` may specify executables.

CLI stdout is one JSON object: `{"ok":true,"result":...}` or
`{"ok":false,"error":"..."}`. Exit code 0 means the tool call completed,
not necessarily that generation succeeded: inspect `result.status` and the
provider error for failed/expired/cancelled tasks. `video_wait` default timeout
is 60 seconds; use status queries in a background scheduler for long jobs.

Official API reference:
[Seedance 2.5](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh).
