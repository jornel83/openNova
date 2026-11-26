# 医美视频工作流

2026-11-19 从下载目录 `aesthetic-video-workflow_迁移包_20261113` 迁入 OpenNova。已恢复完整包内素材和任务上下文；本次没有提交生成任务或产生视频生成费用。

后续真实云端验收已完成：历史后图资产通过既有备用凭证成功生成一个 4 秒小样，并完成下载和剪辑。原任务编号与成片路径保存在本机验收记录 `cloud-smoke-20261119.md`。下文“迁移时”和“离线验证”保留对应阶段的记录。

## 入口与存放

- [项目技能](../../skills/aesthetic-video-workflow/SKILL.md)：创作规则、接续步骤和工具边界。
- [当前状态](data/current_task/STATE.md)：后续在这里记录新确认、任务、费用和交付。
- [迁移时接续点](../../skills/aesthetic-video-workflow/references/CONTINUE_HERE.md)：13.5 秒参考片的结构与两图位置建议。
- [完整性清单](../../skills/aesthetic-video-workflow/migration_manifest.json)：原包 224 文件，218,366,614 字节（约 208.3 MiB）。
- [OpenNova 接入说明](../../skills/aesthetic-video-workflow/references/opennova.md)：员工技能分配与现有工具限制。

`data/` 保存完整工作资料，`analysis/`、`exports/` 用于新分析与交付，`verification/` 保存本机验证记录。大体积资料不进入 Git 或技能快照；换电脑时须另备份完整 `data/`，仅克隆代码仓库不会带来这些素材。原下载包保持不变。

## 现在能继续什么

可读取历史与真实感基准、分析参考片、设计分镜与提示词、对本地素材进行裁剪和拼接。当前参考片经本机检测为 720×1280、30fps、405 帧，画面 13.5 秒，容器 13.513991 秒；本次间隔抽帧 27 张，未转录音轨。

当前人物的新版本仍缺两张原图：

| 文件位置 | 应补的原图 |
|---|---|
| `data/current_task/before.jpg` | 蓝帽、条纹衣、蓝底、脸部紫色标记线 |
| `data/current_task/after.jpg` | 黑色圆领衣、深色束发、浅灰墙与沙发 |

不能用历史项目的人像替代。约 3.68 GB 的原始 89 条源视频库也不在原迁移包中；已带分类、提示词、参考帧和选定成果，当前接续不需要先补整库。

历史 Fast 的 `asset://` 人像首帧模式已接入。通过 `first_frame` 传已审核图片资产 URI，沿用生成、查询、下载与剪辑工具。显式设置的 `watermark` 和 `return_last_frame` 会传给方舟。详见[首帧生成步骤](../../skills/aesthetic-video-workflow/references/opennova.md#人像首帧生成)。

## 在 OpenNova 中使用

本机迁移检查时 Bot 宿主未启动，未修改其员工配置。下次启动后，仓库技能会进入技能库；给执行员工同时分配 `aesthetic-video-workflow` 与 `video-production`，保留其原有技能，并让视频任务加载两者。项目上下文需指向本 OpenNova 仓库，才能找到工作资料。

可输入：

> 使用 aesthetic-video-workflow 检查工作资料、读取当前状态，继续医美视频项目；生成或剪辑时配合 video-production。

新制作默认用 **Seedance 2.0 Fast**。若要在 Spark 生成，可直接说“用 MiniMax H3 Veda 生成这支片子的四个人物镜头”。Seedance 使用已入库的人像资产，Veda 使用本地 PNG/JPEG 首帧，每镜 4 秒。两种模型导出成片都默认关闭“AI 角色演示”角标；需要时可说“导出时加上 AI 角色演示”。详见[模型与导出参数](../../skills/aesthetic-video-workflow/references/opennova.md)。

在 Codex 中可直接要求读取本仓库的 `skills/aesthetic-video-workflow/SKILL.md`。本次未做全局技能安装。

## 本地验证

从 OpenNova 根目录执行：

```sh
python3 skills/aesthetic-video-workflow/scripts/handoff.py check
python3 -m unittest discover -s tools/video/tests -v
```

迁移时验证结果：224 个文件大小与 SHA256 全部匹配；两张缺图独立报告；轻量技能通过结构校验和真实 SkillStore 扫描/归档（12 文件，约 85 KiB，未触及 4 MiB / 128 文件限制）；35 项视频及迁移测试全部通过。历史两段源片已通过 OpenNova `video_edit` 的离线时间线校验，没有重跑历史生成脚本。验证产物在 `verification/`。

`check` 对照的是原迁移快照。后续正常编辑 `STATE.md` 或其他文件时会出现基线差异，应结合修改记录判断，不能自动覆盖回旧版。跨电脑恢复命令见 [迁移说明](../../skills/aesthetic-video-workflow/references/portability.md)。

## 首帧适配验证（2026-11-19）

41 项 Python 视频/迁移测试和 39 项 Node 视频网关/报告测试全部通过。新增首帧测试覆盖 URI 与参数校验、请求落盘、防重复提交、跨重启恢复、配置文件路径、旧技能版本保持、网关到真实 Python 校验。离线链路模拟方舟和存储响应，实际执行下载写盘与 FFmpeg 导出；没有进行真实云端付费生成，不能据此声称当前资产审核、账号权限或生成画质已经通过。

```sh
python3 tools/video/tool.py --request tools/video/examples/asset-first-frame-validate.json
python3 -m unittest discover -s tools/video/tests -v
node --test services/bot/tests/skills-video.test.mjs services/bot/tests/skills-video-reports.test.mjs
```

Node 测试使用项目要求的 Node 24。原迁移数据与历史 task ID 未改写，也没有重跑历史收费任务。
