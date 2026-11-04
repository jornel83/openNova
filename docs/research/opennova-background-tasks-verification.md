# OpenNova 后台任务第一阶段实现与验收

更新：2026-11-05。第一阶段让明确的测试、构建和脚本命令进入持久队列，执行期间可以继续与 OpenNova 交流。右侧窗口增加任务列表、执行详情和日志；没有启动独立 Agent 工作会话，也没有接入事件自动续跑。

## 使用方法

在原工程完成构建并重启 Bot，已有配置、授权和会话继续使用。若语音正在运行，先在语音终端 `/quit`，等当前工作结束后重启：

```sh
cd /Users/chenzhuoping/Documents/work/project/openNova
pnpm run build
pnpm start -- --stop
pnpm start
```

`pnpm start` 打开桌面窗口并提供文字交流；需要语音时用 `./start.command --tts-provider doubao` 启动。旧服务不会热加载新宿主代码。

可以说“在后台运行 `pnpm test`，提交后告诉我”，然后继续聊天。在“任务”页也可以展开“直接运行命令”，填写命令、项目内工作目录、时限和可选结果文件。结果路径相对执行目录，例如 `output/test-report.md`。

“取消任务”会停止该作业；“停止回复”、结束语音或关闭网页不会取消后台任务。失败、取消或中断且确认进程清理完成的任务可以点“重新执行”；每次重试保留独立日志。已经成功的任务需要重新提交才能再运行。

任务完成时，任务页显示结果，聊天页显示未读结果提示。当前只提供视觉提示，不会突然播报或自动让模型继续修改代码。终端客户端支持 `/tasks`、`/task ID`、`/task-log ID` 和 `/cancel-task ID`；日志命令返回首段，完整日志位置可在详情中查看。

## 数据与执行模型

| 对象 | 第一阶段职责 |
| --- | --- |
| Task | 用户提交的命令、工作目录、标题与当前状态；可关联提交它的聊天请求 |
| Run | 一次执行尝试；显式重试创建新的 Run，保留旧记录 |
| Job | 一次真实命令执行，保存退出码、日志、结果文件及进程清理回执 |

当前每个 Run 对应一个 Job，同一 Bot 的项目队列同时运行一个 Job，按执行尝试的入队时间排队。Task / Run / Job 分别保存在已有 `bridge.sqlite` 的 `background_task`、`background_run`、`background_job` 表；原 `records` 表和旧计时任务接口保留。

默认数据位置为仓库外的 `~/.local/share/opennova/bot-spike/`。任务日志及清理回执位于其 `tasks/<jobId>/` 下，授权、会话、记忆和浏览器 profile 位置不变。用户要求命令生成的测试报告等产物仍写入指定的项目目录。

命令默认时限 30 分钟，上限 2 小时，接口最短 1 秒，网页以分钟填写。队列最多接受 100 项待执行或执行中的新任务。日志保存上限为每个 Job 8 MiB，超过后继续读取并丢弃新增输出，避免输出管道堵塞；网页按字节游标增量读取，保留最近 120,000 字符。日志与历史当前没有自动过期策略。

## 取消与恢复

任务状态包括排队中、运行中、取消中、已完成、执行失败、已取消和异常中断。只有进程真实返回退出码 0 才记录成功；超时记录失败。

每个 Job 由独立 Node supervisor 管理 POSIX 进程组。取消先请求退出，随后对未退出进程强制终止；确认进程组退出并排空输出管道后才释放项目队列。“已取消”不撤销命令已经写入的文件。

网页刷新或断线后读取持久记录和日志游标，不重新提交命令。Bot 重启时，未启动的排队任务继续等待执行；已经启动的命令依据 supervisor 回执结算，不能确认完成的标为中断，不自动重跑。宿主崩溃导致 IPC 断开时，supervisor 停止其作业并保存回执。

如果 supervisor 也丢失且没有清理回执，后续队列保持等待，界面提示核对运行环境。第一阶段不提供强制释放按钮；不能仅凭旧 PID 猜测并终止进程。命令须以前台进程方式运行，不支持 `nohup`、守护化或主动脱离进程组。

提交编号与参数摘要防止网络重试重复创建任务；重试操作编号防止重复创建 Run；取消、重试和已读操作校验当前 Run，旧响应不能改写新的执行。日志读取也校验所属任务和 Run。

## 实现位置

- `services/bot/tasks/manager.mjs`：持久记录、串行调度、恢复、日志接口、结果文件校验及模型工具。
- `services/bot/tasks/worker.mjs`：真实进程、进程组清理、有界日志和原子回执。
- `services/bot/host.mjs`、`controls.mjs`、`web-http.mjs`：宿主生命周期、能力声明、共享 API 和网页认证边界。
- `services/bot/web/tasks.jsx`、`task-view.mjs`：列表、详情、筛选、重试、日志及结果文件；`app.jsx` 接入聊天卡片和未读提示。
- `services/bot/policy.mjs`：模型选择后台工具后立即结束等待；不循环轮询、不自行重试或自动续跑。

模型工具为 `background_task_start/list/status/log/cancel/retry`。网页使用 `/web/api/background-tasks` 和 `/web/api/background-task[-start|-cancel|-retry|-read|-log|-open]`，保留 HttpOnly Cookie、同源和 CSRF 校验；终端及语音继续使用原 Bearer 接口。`task.updated` 更新任务快照，日志通知不携带完整输出，避免每个输出块都重载聊天记录。

结果文件在作业结束时核对真实路径，并限制在项目内。打开前重新校验大小和修改时间；变化后提示重新核对。打开操作复用现有文档工具，返回应用调度回执；`.log`、`.csv` 和源码文件用文本编辑器打开。

命令使用当前用户权限和当前项目文件，不是系统沙箱，也没有独立 worktree。队列只串行化后台命令，前台聊天的文件操作仍可能修改同一工程；依赖固定代码版本的任务应在提交前安排好工作目录。独立 Agent 会话与代码隔离留到第二阶段。

## 验证记录

新增自动测试使用真实子进程与临时仓库外数据，覆盖排队、前台聊天可用、非零退出、提交与重试去重、旧 Run 操作失效、取消后无残留写入、超时、完整 UTF-8 输出、日志大小限制、重启不重放，以及实际 SIGKILL 宿主后的清理回执。未确认清理时队列保持等待，错误 Job 的回执不会释放队列。

真实 bundled Harness 集成测试覆盖语音来源提交后台任务、前台请求结束、继续文字聊天、取消和重启恢复。此处语音来源指原共享请求接口，不打开麦克风。

Playwright 在 460 × 900 的实际 Chrome 窗口验证后台运行时聊天、取消、刷新后返回同一任务、完成日志与报告、失败后重试、切换旧 Run 的日志和退出码。文件打开记录为 `dispatched`，窄窗口无横向溢出，控制台无错误或警告。截图保存在本机忽略目录 `output/playwright/background-tasks/`。

真实模型使用独立临时 Bot 和工作目录，复用既有授权，完成自然语言提交命令、作业运行时继续聊天、自然语言取消三步。实际调用了 `background_task_start` 和 `background_task_cancel`，最终状态为 `cancelled / cleanupConfirmed: true`。测试会话和示例文件不写入日常会话；记录为 `output/background-tasks/real-model-verification.json`。

完整回归为 **439 项 Node + 186 项 Python，共 625 项通过**；另有上游 Bot **517 项通过**。最后的状态文案与文件提示调整另经相关 9 项测试和浏览器复验。日志分别为 `output/background-tasks/tests.log`、`upstream-tests.log` 和 `final-focused-tests.log`。

最终完整构建完成，`doctor` 的 `build.ready` 为 `true`，源码审计为 `independent: true / gitlinks: 0`。原工程通过 `pnpm start -- --no-ui` 启动，健康状态包含 `backgroundTasks.version: 1`，工作目录为原 OpenNova，增量回复模式保持 `hybrid-stream`。启动前后两份本机配置、Bot 身份、207 条原有操作与请求记录以及三份记忆文件摘要一致；日常会话没有加入测试任务。文字服务保留运行，语音未连接。证据为 `output/background-tasks/final-doctor.json`、`final-source-audit.json`、`original-health.json` 和 `preservation-after.json`。
