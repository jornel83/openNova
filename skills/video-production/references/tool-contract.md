# Tool contract

Repository implementation: `tools/video/tool.py`. Tool definitions:
`tools/video/tool-definitions.json`. Python callers use
`invoke("video_submit", arguments, base_dir=project_directory)`.
CLI requests use `{"action":"submit", ...arguments}`.

| Tool | Input | Result | Effect |
|---|---|---|---|
| video_generate | config or config_path for a new shot, task_id for resume, output_dir, optional filename and timeout_seconds | pending task ID or succeeded MP4 path, metadata, size_bytes, sha256 | Submit once, follow and download |
| video_validate | config or config_path | validated settings and reference_count | Local read |
| video_submit | config or config_path, output_dir | task_id and submitted status | One Ark API submission or one local Spark GPU job |
| video_status | output_dir, optional task_id | provider task and current status | API read and local task record update |
| video_wait | status inputs, poll_seconds, timeout_seconds | current task, timed_out when still pending | Bounded polling |
| video_download | status inputs, optional filename | local path and size_bytes | Download succeeded task, no overwrite |
| video_edit | config or config_path, optional dry_run | plan or completed local artifact metadata | Local FFmpeg export |

### Generate one clip

Use `video_generate` in an OpenNova video task, or send this request to the CLI.

```json
{
  "action": "generate",
  "output_dir": "output/tape",
  "config": {
    "model": "minimax-h3-veda",
    "prompt": "固定镜头，人物自然眨眼后轻微转头。",
    "first_frame_path": "frames/tape.png",
    "duration": 4,
    "ratio": "9:16"
  }
}
```

Omit `first_frame_path` for text-to-video. Switch `model` to
`doubao-seedance-2-0-fast-260128` for Seedance. It also accepts an approved
`asset://asset-...` in `first_frame`. Supply a single first-frame source.
A successful result includes `path`, `size_bytes`, `sha256`, `metadata`
and `task_id`. Use the delivered file as the input to `video_edit`.

For CLI recovery, pass `{"action":"generate","task_id":"<original ID>","output_dir":"output/tape"}`.
Keep the original filename if you overrode the default `video.mp4`.
`timeout_seconds: 0` requests one status check and downloads if ready.
The task gateway can infer the directory from the task ID. By default it
releases the worker during generation and resumes with a local MP4 receipt.

Generation configuration:

```json
{
  "model": "doubao-seedance-2-5-260628",
  "prompt": "@图片1规定人物与场景。8秒，镜头缓慢推进到空白调色盘。",
  "duration": 8,
  "ratio": "9:16",
  "resolution": "720p",
  "generate_audio": true,
  "reference_images": ["references/opening.png"],
  "reference_videos": ["references/dance.mp4"],
  "omni_reference_task_type": "reference"
}
```

The model ID is the version used for the existing clips, not a promise that
every account enables it. Supply an enabled Ark model or endpoint ID as needed.
Durations are integer seconds from 4 to 30. Resolutions are 480p, 720p, 1080p.
Up to 30 local reference images are supported. The tool checks per-image and
request-size limits and embeds images as Base64. Validate image contents with
the image viewer; path validation cannot establish artistic suitability.

### Approved portrait asset as first frame

```json
{
  "model": "doubao-seedance-2-0-fast-260128",
  "prompt": "保持首帧人物与房间光线，自然眨眼并轻微转头，无对白。",
  "first_frame": "asset://asset-REPLACE_WITH_APPROVED_ID",
  "duration": 4,
  "ratio": "9:16",
  "resolution": "480p",
  "generate_audio": false,
  "watermark": true,
  "return_last_frame": true
}
```

Replace the placeholder with an approved image asset available to the API key's
project. `first_frame` is an opaque URI (maximum 256 characters, client format
`asset://asset-` followed by letters, digits, underscores or hyphens), never a
local path, HTTP URL or Base64 value. The executor sends it unchanged as
`content: [{type: "text", text: prompt}, {type: "image_url", role: "first_frame",
image_url: {url: first_frame}}]`. It does not upload or register the asset.

Direct requests to the generic CLI or Python executor require an explicit
model for an Ark `asset://` first frame. A local `first_frame_path` defaults
to Seedance 2.5 in the generic tool. The OpenNova aesthetic workflow fills in
`doubao-seedance-2-0-fast-260128` when the user leaves the model unspecified.
First-frame mode excludes nonempty `reference_images`,
`reference_videos`, and any `omni_reference_task_type`. Omitted ratio defaults to
`adaptive` only in first-frame mode; existing modes retain `9:16`. Seedance 2.5
first-frame requests require adaptive. Seedance 2.0 duration is 4–15 seconds;
2.0 Fast resolution is 480p or 720p. Endpoint IDs (`ep-...`) are accepted without
guessing their underlying model; the provider enforces that model's limits.

Optional boolean `watermark` and `return_last_frame` are forwarded only when
provided, preserving existing defaults. `watermark` configures the provider's
generated clip. The aesthetic workflow controls its “AI 角色演示” corner label
when exporting the edited film. `return_last_frame` requests an output
JPEG URL in `task.json` → `content.last_frame_url`; the tool does not download
that image and does not accept an input last frame.

`video_validate` adds `generation_mode` (`text`, `reference`, `first_frame`).
For asset first frames it also returns `first_frame` and `asset_validation: not_checked`. Local first frames return their resolved path.
Validation remains offline: it does not prove asset existence, image type,
Active review status, account/project access or model activation. Cloud asset
inspection (`GetAsset`) uses separate AK/SK signing and is not implemented here.
Do not infer approval from a syntactically valid URI or reuse an old identity for
a new person's footage.

For an approved `asset://` first frame, `video_submit` writes the API payload to `request.json` before its
single POST, alongside `config.json` and the exclusive `task.json` submission
guard. The asset URI and explicit flags survive restarts. Existing status/wait/
download tools use that same task ID; `task.json` retains actual `usage` and
provider errors. A failed or ambiguous submission never automatically generates
a replacement. Old task runs keep their pinned executor/schema: create a new run
with the refreshed `video-production` skill to use this feature.

Contract checked 2026-11-19 against [Create video task](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh),
[portrait assets](https://docs.volcengine.com/docs/ark/private-virtual-avatar-library-guide-preview?lang=zh)
and [GetAsset](https://docs.volcengine.com/docs/ark/get-asset-api?lang=zh).

### Local video references

Optional `reference_videos` accepts up to 10 local MP4/MOV files for Seedance
2.5 or a compatible endpoint. Validation is offline: each video must be 2–30
seconds, at most 200 MB, 24–60 FPS, 300–6000 pixels per side, aspect ratio
0.4–2.5 and total pixels 407696–8295044; combined duration is at most 30 seconds.
`@视频1` refers to their list order. The only supported explicit
`omni_reference_task_type` is `reference`; it is added automatically when
videos are supplied. A video is never sent as unsupported Base64.

On submit, local video files are uploaded to official Ark Files with
`purpose: agent` and about one-day retention. When no download URL is available,
the tool polls the same file ID for up to 30 seconds, including when the file
already reports `active`. Its HTTPS `download_url` is passed in memory to Seedance
as `reference_video`; the signed URL is not written to config, upload records,
or errors. `reference_uploads.json` stores local paths, file IDs and expiry.
This composes the official Files download URL and Seedance URL-input APIs;
the tool first verifies a small MP4/MOV header is readable using an unauthenticated
Range GET. If the original-file URL is usable while preprocessing is still
running, it can be used immediately; unreadable URLs stop generation.
Validation returns separate `reference_count` and `video_reference_count`.

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

`config.show_ai_badge` is an optional boolean, default `false`. Set it to
`true` to add the text “AI 角色演示” with its backplate to the exported video.
The dry-run plan reports the chosen setting. The same flag applies when
`config.aesthetic_timeline` selects the seven-shot composition. Ark's
generation-time `watermark` controls the provider mark.

### Aesthetic seven-shot export

For the 13.5-second portrait film, provide `aesthetic_timeline` in place of
`clips` in `video_edit.config`. The same request works with CLI
`action: "edit"`. Each path points to local media. The template supplies the
opening diagram, procedure shot and audio. The four generated videos supply
the moving portraits, and `card` is the final PNG/JPEG comparison image.

```json
{
  "action": "edit",
  "dry_run": true,
  "config": {
    "output": "exports/portrait.mp4",
    "aesthetic_timeline": {
      "template": "template.mp4",
      "before": "clips/before.mp4",
      "after": "clips/after.mp4",
      "wrap": "clips/wrap.mp4",
      "tape": "clips/tape.mp4",
      "card": "frames/comparison.png",
      "source_in_frames": {"before": 26, "after": 25, "wrap": 34, "tape": 66}
    }
  }
}
```

All six paths are required. Each optional `source_in_frames` entry is a
nonnegative integer measured **after** converting the source to 30 fps and
defaults to 0. The opening takes the tape clip from frame 0. Its later recovery
shot starts at the `tape` in-point. The example uses the cuts from the Veda
test01 film. For the Seedance test01 edit, use 25, 16, 26 and 54 respectively.
The output is 720×1280 at 30 fps (405 frames), with CRF 17 by default. Set
`dry_run` to `false` to render the film.

CLI stdout is one JSON object: `{"ok":true,"result":...}` or
`{"ok":false,"error":"..."}`. Exit code 0 means the tool call completed,
not necessarily that generation succeeded: inspect `result.status` and the
provider error for failed/expired/cancelled tasks. `video_wait` default timeout
is 60 seconds; use status queries in a background scheduler for long jobs.

Official API reference:
[Seedance 2.5](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh).

## Spark H3 first-frame mode

The aesthetic workflow selects Seedance 2.0 Fast by default. To run its local
alternative, send a `video_validate` request with this `config`, then pass the
same configuration to `video_generate` with a fresh `output_dir`.

```json
{
  "model": "minimax-h3-veda",
  "first_frame_path": "frames/tape.png",
  "prompt": "固定镜头，人物轻轻转头后回正。",
  "duration": 4,
  "ratio": "9:16",
  "seed": 1101
}
```

| Model ID | Spark runtime | Request duration | Native image and sampling |
|---|---|---|---|
| `minimax-h3-veda` | ComfyUI FL2VA with Veda | 4–15 whole seconds for both text-to-video and first-frame generation | 576×1024, 24 fps, 4 steps, 90% sparsity for generated and reference frames |
| `minimax-h3-spark` | P2 Turbo on vLLM-Omni | 4, 5 or 6 s | 768×1344, 24 fps, 5 steps |

For first-frame generation, supply a prompt and one local PNG/JPEG (up to 30 MiB). Minimax H3 also accepts a prompt alone.
`duration`, `ratio` and `seed` default to 4, `9:16` and 1101. The accepted
seed range is 0–2147483647. Both profiles return native MP4 with audio.
For Minimax H3, the workflow uses the smallest frame count of the form
`17k + 5` that covers the requested duration. A 15-second request generates
362 native frames. `video_generate` delivers 360 frames at 24 fps, and
`video_download` preserves all 362 native frames.

Both profiles use the executor's noninteractive SSH connection to
`OPENNOVA_SPARK_SSH_HOST` (default `agent-gpu`). Veda starts a job from the
deployed ComfyUI image, weights and profile. Its worker waits for the shared
GPU lock and reports a failure if another application still occupies the GPU.
The P2 deployment serves the asynchronous API on the Spark loopback interface
and needs its vLLM-Omni service online through download.

Use the same host and output directory for status, wait and download. Veda
records a `veda_…` job ID before dispatch, so an interrupted submission can be
checked using the original directory. Its download verifies the SHA256
recorded on Spark. Ark portrait requests use the approved `first_frame` URI
described above and the executor's Ark credentials.
