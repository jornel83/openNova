# Bot 网页入口

由 `tools/bot/run.command` 自动构建并在本机 18560 端口提供。页面复用固定版本 DeepSeek-Bot 的 `BotMark`、`Bubbles`、`UserMessageCell`、中文词典与样式，以及 Harness 的 `Button` / `DiffBlock`，不修改上游源码。新增的壳层负责共享请求历史、文本输入和操作记录。原生文件工具显示修改差异，Shell 显示命令、工作目录、完成输出、退出码和取消/超时状态；停止回复会取消对应前台命令。

构建使用固定 Harness 已安装的 React、UI primitives 和 esbuild，无需另建前端依赖目录：

```sh
/opt/homebrew/opt/node@24/bin/node services/bot/web/build.mjs
```

构建产物及上游许可证副本位于 Git 忽略的 `output/bot/web/`。修改前端后重新构建并刷新页面；修改宿主后重启 Bot。现有部署与验证方法见 [接入实验说明](../../../docs/research/opennova-bot-spike.md)。

浏览器仅访问 `/web/session` 和受限 `/web/api/*`，通过 HttpOnly Cookie 和 CSRF 校验。CLI/语音继续使用既有 bearer API。所有入口调用同一个 `controls.mjs`，复用持久请求编号、单前台准入和操作记录；页面通过可恢复事件流同步，5 秒快照轮询兜底，隐藏时降为每 15 秒。


M3 接入现有 `--continuous --bot` 原生语音进程：环形 Nova 与收音、识别、TTS 缓冲和播放状态联动，支持停止、静音、开始 / 结束及音频重连。网页不启动另一套麦克风、ASR 或 TTS。临时转写仅存于语音桥内存，最终请求仍由 Python 提交；历史共用原 Bot 会话。开发分支启动、控制语义与现场验收见 [M3 验收说明](../../../docs/research/opennova-desktop-interaction-test-cases.md#m3语音与环形-nova-联动)。

M4 使用根目录 `start.command --ui` 统一启动：Bot → 扩展及双窗口 → TTS → 原生语音。对话页顶部“打开工作窗口”调用同源 `/web/api/desktop-open`，只接受空请求，由宿主使用可信聊天地址调用同一开窗协调器；本机启动器使用 Bearer `/desktop/open`（空请求开窗，原有 URL 请求仍用于页面导航）。浏览器不能借此设置任意地址、窗口边界或配对凭据。

自动开窗不切走文件引用、不重放打开文件；显式点击“打开工作窗口”会聚焦浏览器并恢复网页引用。扩展首次安装与当前开发机一键命令见 [M4 启动说明](../../../docs/research/opennova-desktop-interaction-test-cases.md#m4一键启动与双窗口)。TTS / 麦克风失败时仍能文字交流；恢复语音需要重新运行终端启动器。已有不带桌面能力的旧 Bot 不会被自动强杀，需结束当前工作后停止旧服务并用 `--ui` 重启。


2026-10-24 联网研究：回复下新增可折叠的“参考来源”，显示真实链接、搜索摘要 / 已读取正文、原获取时间和证据片段；历史快照直接恢复，不重新联网。环形 Nova 在思考状态显示实际检索阶段。Python 语音客户端消费同一请求结果，口播省略来源 URL 和正文。启动配置、边界和验收见 [联网研究验收](../../../docs/research/opennova-bot-research-test-cases.md)。

通用研究结果额外包含 `api_response` 来源和独立 `derivations[]` 脚本记录；接口卡显示真实 HTTP 状态、编码和获取时间，脚本卡引用输入 observation，文件变化显示提醒。界面不把正常退出或收到 HTTP 200 标为业务已核验。详见 [验收说明](../../../docs/research/opennova-research-execution-test-cases.md)。

研究 Shell 的 HTTP 辅助命令仅能在活跃执行中通过本机认证桥调用 `/research/http`；普通网页 API 不开放该路由。请求结束或取消后 executionId 失效。脚本原始响应和产物位于 Git 忽略的 `output/research/requests/`。
