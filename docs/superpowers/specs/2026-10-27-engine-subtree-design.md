# OpenNova 内置引擎设计

用户已在对话批准 Git subtree 方案，并选择保留上游同步能力、允许 OpenNova 定制。

## 目标

普通 clone 或源码归档包含 Harness 和 DeepSeek-Bot 的完整源代码。安装、构建和运行不依赖相邻检出、个人 GitHub SSH 权限或已有 output 缓存。保留现有插件职责、语音路径、会话和记忆数据。

## 方案与边界

- 采用单 Git 仓库、分层构建：`engine/harness/` 和 `engine/bot/` 使用 subtree --squash 导入完整上游源码。
- 曾比较复制快照和摊平 workspace；subtree 兼顾源码自包含与上游更新，保留 Harness 构建边界降低迁移风险。
- Harness 基线 d743267388641bc76f17c45ce8b4c231aed1d32c；保留本机已提交的 bf89008192 和 cccbe9cb47 网页读取修复，分别记录定制提交。
- Bot 固定 20ebc9213cbbde7249d71786765f86be00dc6663。
- Node 24；pnpm 11.28.5；Python 3.11+；原生语音/Keychain 仍为 macOS，Studio TTS 独立安装。
- OpenNova 根级脚本协调 setup/build/test/start/start:voice/doctor。Harness 保留原 workspace 和锁文件；根工具有自己的锁文件。
- 用户目录中的 Bot/会话/SQLite/授权数据不移动、不删除。构建及默认测试不授权、不打开麦克风、不调用付费模型。
- SIWC 是可选 ChatGPT 授权适配依赖，继续使用固定公共源码安装和仓库内补丁，不复制用户凭据。
- 持久源码和构建产物分开；启动只检查构建，不下载源码、不临时生成业务插件包装代码。

## 接口与实现

- `upstream.lock.json` 保存 URL、导入版本、目录及保留的定制。运行不要求子目录具有独立 .git。
- `services/runtime/sources.mjs` 统一解析仓库内引擎路径、验证来源清单和必要构建入口。
- `services/agent/settings.mjs` 与 Bot settings 使用内置引擎；旧机器配置中的 harness_root 不再决定源码位置。
- Bot 测试和运行时将 peers 解析到同一份内置 Harness，保持单一 Cordis 身份。
- 前端直接声明 esbuild；React 与上游 UI 使用同一份安装实例。避免硬编码 .pnpm 内部路径。
- `scripts/project.mjs` 提供统一命令；`scripts/test.mjs` 执行离线 Node/Python 测试。
- `scripts/verify-source.mjs` 和干净源码验证覆盖缺失引擎、归档无 .git、未知/过期构建、遗留路径污染。
- 根贡献文档说明 subtree 更新、独立的引擎定制提交、来源记录及干净构建。保留上游 LICENSE/NOTICE，新增根许可证和第三方声明。

## 验收

1. 两个 subtree 普通文件完整纳入 Git，无 gitlink 或外部源码软链接。
2. 在没有相邻 Harness、没有原 output、没有个人配置的目录完成依赖安装和构建。
3. 离线回归通过：原有 131 项 Node 基线、Python 回归及新增路径/安装/归档测试。
4. 真实内置 Harness/Bot 可加载，网页可构建，工具/取消/持久化契约通过；不消耗模型调用完成宿主集成验证。
5. 文档和 CI 使用相同根入口；构建版本明确区分 OpenNova 提交与引擎上游版本。
