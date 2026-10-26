# OpenNova 开发与上游维护

## 源码与包管理边界

`engine/harness/` 和 `engine/bot/` 是普通 Git 跟踪目录。它们由 `git subtree --squash` 导入，源码压缩包中也完整存在；运行时不会克隆或链接外部 Harness/Bot。两个上游各自的 README、测试、许可、开发文档与锁文件均保留。子目录中的 `.github/workflows` 不作为 OpenNova 根目录工作流执行。

根目录是产品编排层，保留三个依赖边界，避免迁移时改写上游整个 workspace：

| 项目 | 依赖锁 | 安装 |
| --- | --- | --- |
| OpenNova | `pnpm-lock.yaml` | 根目录 pnpm frozen install |
| Harness | `engine/harness/pnpm-lock.yaml` | Harness 目录 pnpm frozen install |
| Bot 插件 | `engine/bot/ds-bot/package-lock.json` | Bot 目录 npm ci |

根目录 `pnpm run setup` 依次执行以上安装；设置 `CI=true`，防止 Harness 安装脚本修改 OpenNova 的 Git hooks。Node 固定主版本 24，pnpm 固定 11.28.5。需要 C/C++ 编译工具；macOS 使用 Xcode Command Line Tools。开发环境需预装 Python 3.11、uv 和 FFmpeg 才能运行完整测试。

`pnpm run build` 调用上游构建，再使用根目录声明的 esbuild 构建 OpenNova 网页。Bot 通过 `services/bot/resolve.mjs` 从仓库内 Harness 的包 exports 加载 peer，避免 Cordis/运行时实例重复；网页同样复用 Harness 的 React。OpenNova 直接加载受版本管理的 `services/bot/host.mjs`，不在用户数据目录生成可执行插件包装器。

## 构建与验证

```sh
pnpm run setup
pnpm run build
pnpm run doctor
pnpm test
pnpm run test:bot
```

默认回归包括产品 Node 测试和 ASR、语音、TTS、安装器、视频工具的 Python 测试。运行时冒烟测试会在临时目录启动真实 Harness/Bot，使用本地模拟模型验证请求、取消和重启后历史，不使用用户的 Bot 状态、模型凭据或麦克风。`test:bot` 运行被导入 Bot 的完整测试集，通过相同的包解析规则加载 Harness。

构建完成后写入 `output/build/manifest.json`，记录源文件内容摘要、上游版本、Node 主版本与运行时产物摘要。启动时拒绝缺失或陈旧构建；源码、锁文件或适配层变化后重新 `pnpm run build`，依赖变化先 `pnpm run setup`。诊断不会把 OpenNova 的 HEAD 当成 Harness 的来源版本。

源码 ZIP 无需 `.git` 也可安装和构建：Harness 的展示用构建标识由编排器传入，有 Git 时使用 OpenNova 提交，无 Git 时使用内容摘要；上游来源始终以 `upstream.lock.json` 为准。源码包内不能包含机器配置、`node_modules`、缓存和构建产物。

macOS CI 从 `git archive` 导出的临时源码运行同一套 setup/build/test/test:bot 命令，验证无 Git 元数据的安装路径，并故意提供无效的旧 Harness 路径。所有构建依赖来自锁文件对应的软件包源；首次安装需要联网和数 GB 空间。

## 可选 ChatGPT / 语音依赖

```sh
pnpm run setup -- --chatgpt
pnpm run build
pnpm run test:chatgpt
node services/agent/authorize.mjs
pnpm start
```

`config/runtime-versions.json` 只管理 SIWC 固定版本，`upstream.lock.json` 管理两个内置引擎。可选 SIWC 源码默认在 `~/.local/share/opennova/siwc-devkit`，扩展构建在 `output/deps/siwc/`；这是独立的模型适配依赖。`test:chatgpt` 验证已构建扩展的协议，仍使用模拟响应、不登录。真实模型、网页搜索和语音验证需使用自己的授权及服务，另行显式执行。

旧 `agent.harness_root` 和用户设置的 `OPENNOVA_HARNESS_ROOT` 已不再作为源码配置。后者仅作为宿主启动时由 OpenNova 设置的内部路径参数传给插件。`OPENNOVA_SIWC_ROOT`、`OPENNOVA_KEYCHAIN_HELPER`、`OPENNOVA_SIWC_STORAGE` 继续支持机器配置。现有 `~/.local/share/opennova/bot-spike/` 数据及 Keychain 保持原位。新工作区首次运行需自行复制配置模板或指定 `OPENNOVA_CONFIG` / `OPENNOVA_SECRETS_FILE`，不要把密钥提交到仓库。

## 同步上游

导入来源和精确 SHA 见 `upstream.lock.json`。Harness 基线为 `d743267388641bc76f17c45ce8b4c231aed1d32c`，Bot 基线为 `20ebc9213cbbde7249d71786765f86be00dc6663`。Harness 另外保留了两项既有 HTTP/字符集修复，其原始提交写在 lock 清单和对应的 `Preserved-Harness-Commit` 提交说明中。

先保证工作区干净，在维护分支同步。以下 `<reviewed-upstream-ref>` 必须替换成已审阅的上游 tag 或提交；不要将两个命令作为日常启动步骤：

```sh
git subtree pull --prefix=engine/harness https://github.com/deepseek-ai/deepseek-harness.git <reviewed-upstream-ref> --squash
git subtree pull --prefix=engine/bot https://github.com/Fei2411/DeepSeek-Bot.git <reviewed-upstream-ref> --squash
```

每次只同步一个组件，审阅差异、解决与本地补丁的冲突，更新 `upstream.lock.json` 的 `revision`、`version` 和适用补丁；若上游已收录补丁，明确记录其退役。保留 subtree merge/squash 的提交消息和 `git-subtree-*` 元数据，否则下次同步可能找不到基线。导入后的普通修复提交无需伪造 subtree 元数据。

优先在 `services/` 编写 OpenNova 策略与插件；确需改动 `engine/` 时遵循相应目录的 AGENTS.md，使用单独的、可解释的补丁提交，不大规模重命名上游包。不能同时保留另一个作为运行时依赖的 Harness 副本。

同步后运行安装、构建、产品回归、Bot 回归和受影响 Harness 包测试。涉及模型协议再运行可选 `test:chatgpt`；涉及音频再做真人测试。最后验证全新源码导出，更新许可与第三方声明后发布。仅升级 manifest 中的版本而未更新源文件会被检测为不匹配。

## 本次验证边界

已在 macOS/Apple Silicon、Node 24.14.1 环境进行整合；仓库内 Harness/Bot 的完整构建和本地模拟模型测试覆盖加载、数据持久化与取消。CI 配置用于后续重复验证，其远端运行结果以实际 CI 为准。Linux/Windows 产品入口、真实云端调用和目标设备麦克风效果不在本次自动验证范围内。

本次整合的具体命令范围、计数和源码导出结果见[整合验证记录](research/opennova-engine-subtree-verification.md)。
