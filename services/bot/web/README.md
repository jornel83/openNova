# Bot 网页入口

由 `tools/bot/run.command` 自动构建并在本机 18560 端口提供。页面复用固定版本 DeepSeek-Bot 的 `BotMark`、`Bubbles`、`UserMessageCell`、中文词典与样式，以及 Harness 的 `Button` / `DiffBlock`，不修改上游源码。新增的壳层负责共享请求历史、文本输入和操作记录。原生文件工具显示修改差异，Shell 显示命令、工作目录、完成输出、退出码和取消/超时状态；停止回复会取消对应前台命令。

构建使用固定 Harness 已安装的 React、UI primitives 和 esbuild，无需另建前端依赖目录：

```sh
/opt/homebrew/opt/node@24/bin/node services/bot/web/build.mjs
```

构建产物及上游许可证副本位于 Git 忽略的 `output/bot/web/`。修改前端后重新构建并刷新页面；修改宿主后重启 Bot。现有部署与验证方法见 [接入实验说明](../../../docs/research/opennova-bot-spike.md)。

浏览器仅访问 `/web/session` 和受限 `/web/api/*`，通过 HttpOnly Cookie 和 CSRF 校验。CLI/语音继续使用既有 bearer API。所有入口调用同一个 `controls.mjs`，复用持久请求编号、单前台准入和操作记录；页面每秒同步快照，隐藏时降为每 5 秒。
