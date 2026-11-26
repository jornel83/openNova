# 团队长时间运行验证

## 最新结果：2026-11-12

本次一次性夜间测试已结束，**未通过验收**。实际运行从 11 月 11 日 23:44:52.347 至 11 月 12 日 07:44:53.839，满 8 小时 1.492 秒；完成 480 轮、8 次重启，无重复执行或采样空档。唯一失败为 `soak_source_changed_during_run`：凌晨约 00:27 的技能命名修复改变了源码基线。当前构建已不匹配源码；本次不重新构建、不自动再跑、不覆盖修复内容。

`cleanupConfirmed=true`，全部隔离进程已退出，3840 个 Job 均已清理，端口关闭、锁已释放，SQLite 正常。5759 条采样的最大间隔为 5017ms，宿主树 RSS 峰值约 607MiB。原 `result.json` 保持 `failed` / `eightHourComplete=false`，证据目录为 `~/.local/share/opennova/verification/team-m5-soak-20261111-2205`，另有独立 `final-audit.json`。同一版本的完整 8 小时验收仍待另行安排。

## 2026-11-11 夜间验证安排（历史记录）

用户已授权通过 Codex 当前聊天的一次性定时任务启动，自动化 ID 为 `opennova-m5`。计划北京时间 **2026-11-11 22:05** 触发；前置检查通过后观察完整 8 小时，预计 **2026-11-12 06:05 后**收尾。此记录表示已安排，尚未运行或通过；不每天重复。若到次日 00:00 仍未开始，则报告错过计划，不自行挪到其他日期。

实际启动更新：用户继续指令后，于北京时间 **2026-11-11 23:44:52** 启动，预计 **2026-11-12 07:45 左右**收尾；原计划 22:05 不是实际起点。Run ID `2e518f23-e35f-49d9-85fd-fa07059fa025`，runner PID `4091`，独立宿主首轮 PID `4101`。启动前 doctor 与构建新鲜度通过，源码摘要仍为 `bcbb015ef6ff1946b84915cd13d16f1596d53ccb26ab49ecbf132f94ccbf7efc`；首轮完成、无失败和采样空档，尚未完成 8 小时。运行时 Mac 接电但检测为合盖，已提醒用户保持开盖。最终以外部目录中的结果及采样证据为准，不把运行中状态记作通过。

- 原工程：`~/Documents/work/project/openNova`。安排时 `checkBuild().ready=true`，没有长测锁；启动前重新检查源码、构建及锁。
- 固定运行目录：`~/.local/share/opennova/verification/team-m5-soak-20261111-2205`。由 runner 创建，重复触发只跟踪此运行；旁路启动日志为同级 `team-m5-soak-20261111-2205.launch.log`。
- 保持默认 8 小时时长、60 秒周期、每 60 轮重启、5 秒采样及 2 GiB RSS 判据，使用 `caffeinate -i`。Mac 需接电、保持开盖和 Codex 运行；期间冻结源码与构建。独立测试仍会使用本机 CPU 和内存。
- 日常 Bot、授权、会话、记忆和音频设备不参与测试。覆盖真实宿主与离线模型 fixture，不据此宣称云服务网络或真人音频连续 8 小时通过。
- 定时执行负责跟踪到终态、核验清理和结果，并补充 M5 验证记录。只有最终 `passed`、`eightHourComplete=true`、满时长、无失败/观察空档/重复执行且 `cleanupConfirmed=true` 才记为通过。

## 方法与运行要求

`scripts/team-soak.mjs` 使用真实 bundled Bot、Harness、SQLite、文件和子进程，模型为离线 fixture。运行数据必须放在仓库外的全新目录。前台对话、员工返工验收和命令任务使用同一个宿主与串行调度；不会访问日常 Bot、账号、麦克风或扬声器。

每轮验证前台回复、后台命令的重复提交及总管自执行命令的独立自动验收、员工交付 → 总管返工 → 新成果验收、员工执行期间前台继续对话、取消并核对命令 PID 退出，以及重新连接后读取状态。M5 还验证员工加载固定版本技能，验收成果经过独立只读会话生成经验候选；每轮累计 7 个 Task、8 个 Run、4 份成果，其中 4 个为内部验收/提炼任务，不计作用户工作。默认每 60 秒发起一轮，每 60 轮重启一次宿主，核对员工身份、任务 Run 和已验收成果没有重复。每 5 秒记录宿主进程树、RSS、CPU 和 runner 资源；汇总实际 Task / Run / 报告 / 文件 / 投递数量。2026-11-09 以前的历史长测未包含总管命令自动验收，仍按当时每轮 6 个 Task、7 个 Run 的口径解读，不追改旧结果。

在所有代码修改、回归和构建完成后启动：

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
caffeinate -i node scripts/team-soak.mjs \
  --home "$HOME/.local/share/opennova/verification/team-m5-soak-new-run"
```

默认实际观察 28,800,000 毫秒，即 8 小时。`caffeinate -i` 仅在测试运行期间阻止系统空闲睡眠；合盖等导致的观察中断仍会记录。超过 30 秒（或采样间隔四倍，以更大者为准）的采样空档会使耐久验收失败；不把睡眠或加速时钟计作连续观察通过。宿主进程树默认 RSS 上限为 2 GiB，可用 `--rss-limit-mb` 明确调整测试判据；此判据不是产品的任务执行预算。

短时验证示例：

```sh
node scripts/team-soak.mjs --home /tmp/opennova-team-smoke-new \
  --duration-ms 1000 --interval-ms 0 --restart-every 1 --sample-ms 1000
```

短时请求至少完整执行一轮，因此实际用时可能大于请求时长。报告写明 `mode=smoke`、实际 `elapsedMs`，`eightHourComplete` 始终为 false。离线长时间测试也不能替代真实模型和真人听感验收。

外部运行目录包含：

- `status.json`：持续更新的状态、runner PID、宿主 PID、周期进度、用量峰值、计数和失败原因。
- `samples.jsonl`：逐次真实资源采样和覆盖间隙。
- `result.json`：最终状态、实际时长、清理证明，以及是否真正完成 8 小时观察。
- `bridge.sqlite`、`bot/`、`tasks/`、`workspace/`：可审计的隔离执行证据。
- `host.log`：最多 4 MiB 的离线宿主日志。

停止时，向 `status.json` 的 `pid` 发送 SIGTERM。runner 会停止宿主、检查已观察到的子进程退出并写入 `status=interrupted`，不会将未满时长标为通过。

同一工程的长跑与 `pnpm build` 共用 `output/team-soak.lock/owner.json` 独占锁，`purpose` 区分 `soak` 和 `build`。构建在启动第一条命令前原子获取锁，并持有到所有构建命令、进程组及构建记录完成；无论谁先启动，另一个都会立即拒绝。构建失败或收到 SIGINT / SIGTERM 时，确认子进程退出后才释放；子进程拒绝停止或清理无法确认时保留锁。运行期间也不要直接执行子工程构建或修改源码；8 小时验收会再次核对源码与构建完整性。长跑正常完成或停止后自动释放锁。若宿主意外退出且清理无法证明，保留锁和失败报告，先核对隔离运行进程，不能仅因 PID 不存在就删除锁。

已确认清理完成、但 runner 在最终释放锁前退出时，可调用 `recoverTeamSoakLock(root, runId)`。它要求 owner 与最终报告为同一个 run、包含完成和清理证明，并核对进程启动身份，防止将复用的 PID 当成原测试进程。此操作不自动篡改失败报告，也不把未完成测试改为通过。

构建被 SIGKILL 等异常终止后不会自动删除锁。先读取 `owner.json` 确认 `purpose=build`、运行 ID 和记录的子进程；确认原构建已经退出后，在工程根目录执行以下恢复检查，将示例 ID 替换为该记录的 `runId`：

```sh
node --input-type=module -e \
  'import {recoverBuildLock} from "./scripts/team-soak-lock.mjs"; recoverBuildLock(process.cwd(), process.argv[1]);' \
  '填写 owner.json 中的 runId'
```

该操作只检查并释放锁，不杀进程、不标记构建成功。原构建进程或尚未确认结束的子进程组仍存活时会拒绝；如果异常恰好发生在创建子进程与登记 PID 之间（`spawning=true`），或缺少 owner 记录，也会拒绝自动恢复。这种情况必须先人工核对构建进程树，不能用删除锁目录的命令绕过检查。恢复后重新执行完整构建。定向测试 `node --test scripts/tests/build-lock.test.mjs` 使用仓库外临时命令，覆盖双向互斥、并发竞争、失败、子进程清理和异常恢复，不重建共享工程。
