# OpenNova 桌面整合验收（2026-10-28）

## 当前状态

桌面分支 `codex/desktop-browser-m0` 已合入 OpenNova 的完整源码架构，并快进合并到原工程 `/Users/chenzhuoping/Documents/work/project/openNova`。原工程使用 `engine/harness`、`engine/bot`、`engine/siwc`，浏览器扩展在 `extensions/browser`；没有恢复 submodule、外部源码软链接或外部 SIWC 适配源码。

**后台部署与数据保留已验证；本机浏览器首次配对及右侧窗口可视验收尚未完成。** 当前 Mac 锁屏，桌面工具无法操作配对界面。浏览器专用配置已迁移，服务已启动并启用桌面接口；扩展状态为 `paired: false, connected: false`，启动器因此提供普通网页入口。不能将此状态视为双窗口验收通过。

## 启动方式

在原工程根目录运行：

```sh
./start.command                 # 桌面窗口 + 持续语音
pnpm start                      # 桌面窗口 + 文字对话
pnpm start -- --no-ui            # 仅后台服务
pnpm start -- --check            # 检查现有 Bot
pnpm run doctor                 # 检查源码与构建
```

这些入口使用同一 Bot。默认开窗先于语音初始化；重复运行复用现有 Bot，扩展已配对时恢复右侧聊天窗口。语音初始化失败不会关闭文字服务。`--check`、`--help`、设备列表不会自动开窗。首次配对按启动日志提示，在新工程的扩展设置中连接 `http://127.0.0.1:18560`；码过期可运行 `node tools/desktop/setup.mjs` 重新生成。

## 配置和数据

- 原 `voice.local.json` 的已有配置保持原值，仅补入 `desktop.browser_executable` 和 `desktop.browser_user_data_dir`；`secrets.local.json` 字节不变。
- 主 Bot 数据仍在 `~/.local/share/opennova/bot-spike`。Bot ID、会话 ID、196 条记录及 3 个记忆文件保持不变。
- 旧桌面历史独立迁到 `~/.local/share/opennova/legacy-desktop`，保留 591 条记录及记忆。关闭旧实例时仅 `work-context` 记录因浏览器断开更新，没有与主会话混合。
- 专用浏览器配置从旧 worktree 迁到 `~/.local/share/opennova/browser-profile`，启动参数加载原工程内的扩展。授权和配对状态随配置保留，但源码路径改变产生的新扩展仍须重新配对。
- SIWC 授权继续在 `~/.config/opennova-siwc-probe`。可信 Keychain helper 未被替换；模型目录检查通过，未发送模型生成请求。检查触发正常令牌刷新：变动仅涉及令牌、保存时间与刷新/过期时间，注册、账号、scope 等配置不变。
- 外部备份：`~/.local/share/opennova/backups/desktop-integration/20261027-232944`。包括原配置、加密授权、SQLite 备份、记忆、旧桌面历史及浏览器配置；没有把备份放回源码仓库。

## 验证证据

- 产品回归：397 项 Node 测试 +167 项 Python 测试，共 **564 项通过**。
- 独立源码目录含空格，不带用户配置或原工程数据；安装、构建、项目 doctor、源码审计及产品测试通过。包含上游 Bot 的 **517 项测试通过**。
- 原工程完整构建和 doctor 通过；源码审计 `independent: true`、0 gitlinks、14 个仓库内软链接、2 个仓库内本地包依赖。
- 真实 bundled Harness + 本地模拟模型验证共享请求、取消和重启；桌面 bridge、双窗口复用、语音状态同步由本地集成测试覆盖。
- 原工程实测 `/health.ready: true`、`desktopEnabled: true`；重复启动保持同一个 runtime/session。订阅授权检查 `authorized: true`。
- 新增回归覆盖：扩展重载后的聊天弹窗恢复、最小化窗口恢复且不重排用户布局、已确认完成命令到期清理、保留结果不明确的命令防止重放、存储失败不阻断后续命令/已知结果返回。
- 导出测试最初暴露 5 个 URL 路径解码问题，已使用 `fileURLToPath` 修复。后续回归曾出现临时测试 Bot/SSH 启动超时，其中耗时异常拉长；将测试夹具启动预算从 3 秒调整为 10 秒后，单项及完整回归通过。生产启动预算未变，失败日志保留，没有将失败结果计为通过。

原工程证据位于 `output/desktop-integration/`，其中 `preservation.json` 记录数据核对，`source-export/` 保存独立源码验证日志。日志不进入 Git；包含配对码的启动日志仅限本机用户读取。

## 待解锁后完成

1. 在新工程加载的 OpenNova Browser Bridge 设置中重新配对 18560 服务。
2. 从默认入口再次启动，确认工作窗口与右侧聊天窗口实际显示；最小化后重启能恢复，重复启动不新增聊天窗口。
3. 用本地页面完成打开、读取和点击验证，并核验扩展显示已连接。

本次没有采集麦克风音频、调用付费 TTS 或发送付费模型任务；真实语音听感不属于已完成的验收范围。
