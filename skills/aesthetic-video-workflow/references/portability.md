# OpenNova 工作流迁移

## 本机接续

轻量技能已放在 `skills/aesthetic-video-workflow/`，完整工作副本放在 `workspaces/aesthetic-video-workflow/data/`。从 OpenNova 根目录执行：

```sh
python3 skills/aesthetic-video-workflow/scripts/handoff.py check
```

也可在任何目录通过脚本绝对路径和 `check --workspace <data绝对路径>` 校验。输出分别报告原始 224 文件的大小/SHA256 和两张已知缺图。检查通过不表示照片已经补齐；对工作副本的正常编辑也会产生基线差异，不能自动覆盖。

## 另一台电脑首次恢复

Git 和技能快照不包含 209 MiB 素材，必须另外复制当前完整 `data/` 或原迁移包。优先带最新工作副本以保留进度。只有原包时，在 OpenNova 根目录执行：

```sh
python3 skills/aesthetic-video-workflow/scripts/handoff.py materialize \
  --source "/完整迁移包/aesthetic-video-workflow/assets/workspace" \
  --to "workspaces/aesthetic-video-workflow/data"
```

`--source` 指原包的工作资料根目录；复制前按技能内原清单验证。`--to` 只能是新建或空目录，拒绝覆盖旧项目。已编辑的最新工作副本应完整备份/恢复，并核对其修改记录，不强行恢复成 2026-11-13 快照。不要复制旧虚拟环境或浏览器缓存。

## 工具

Python 3.10+。FFmpeg/ffprobe 从 PATH 查找，也可设置 `FFMPEG_BIN`、`FFPROBE_BIN`。检查与抽帧不联网：

```sh
python3 skills/aesthetic-video-workflow/scripts/media_probe.py \
  workspaces/aesthetic-video-workflow/data/current_task/reference_b11.mp4 \
  --out workspaces/aesthetic-video-workflow/analysis/reference-b11 --sample-fps 2
```

输出目录需新建或为空。间隔抽帧不能代表逐帧观看，也不表示转录过音轨。其他视频工具、员工技能分配与历史接口差异见 [OpenNova 接入](opennova.md)。

## 素材边界

- `current_task/`：13.5 秒参考片、结构分析、状态；缺 `before.jpg`（蓝帽条纹衣）与 `after.jpg`（黑衣浅灰背景）。不能用历史人物填补。
- `benchmarks/realism_10s/`：已认可真实感基准。
- `projects/face_pair_480p_20261105/`：最近成片、原片、提示词和旧任务记录。
- `archive/`：选择性历史成果，不表示待自动恢复的生成队列。
- `library/`：89 条分类、首帧与提示词。
- `source_scripts/`、`docs/`：原拍摄 Excel、参考视频、Word 手册。
- `catalog/`：文件、缺失项与范围清单。

约 3.68 GB 的原始 89 条源片库未包含；只有需要重新研究源片时才补。旧 `${ORIGINAL_WORKSPACE}`、`${EXTERNAL_SOURCE}` 是来源标记，不是可运行路径。包内云端资产/任务 ID 不代表新账号有权限；需要生成时再核验同账号同项目关系与当前支持。

当前工作副本中的新指令和进度优先于历史偏好。继续在 `current_task/STATE.md` 保存新确认、task ID、下载、实际费用证据和下一步，不保存凭证或签名下载链接。
