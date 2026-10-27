# OpenNova 开发与上游维护

## 源码与包管理边界

`engine/harness/`、`engine/bot/` 和 `engine/siwc/` 是普通 Git 跟踪目录。它们由 `git subtree --squash` 导入，源码压缩包中也完整存在；运行时不会克隆或链接外部 Harness/Bot/SIWC。三个上游各自的 README、测试、许可、开发文档与锁文件均保留。子目录中的 `.github/workflows` 不作为 OpenNova 根目录工作流执行。

根目录是产品编排层，保留四个依赖边界，避免迁移时改写上游整个 workspace：

| 项目 | 依赖锁 | 安装 |
| --- | --- | --- |
| OpenNova | `pnpm-lock.yaml` | 根目录 pnpm frozen install |
| Harness | `engine/harness/pnpm-lock.yaml` | Harness 目录 pnpm frozen install |
| Bot 插件 | `engine/bot/ds-bot/package-lock.json` | Bot 目录 npm ci |
| SIWC | `engine/siwc/package-lock.json` | npm ci，选择 @siwc/local 和根构建依赖 |

根目录 `pnpm run setup` 依次执行以上安装；设置 `CI=true`，防止 Harness 安装脚本修改 OpenNova 的 Git hooks。Node 固定主版本 24，pnpm 固定 11.28.5。需要 C/C++ 编译工具；macOS 使用 Xcode Command Line Tools。开发环境需预装 Python 3.11、uv 和 FFmpeg 才能运行完整测试。

`pnpm run build` 调用上游构建，再使用根目录声明的 esbuild 构建 OpenNova 网页。Bot 通过 `services/bot/resolve.mjs` 从仓库内 Harness 的包 exports 加载 peer，避免 Cordis/运行时实例重复；网页同样复用 Harness 的 React。OpenNova 直接加载受版本管理的 `services/bot/host.mjs`，不在用户数据目录生成可执行插件包装器。

## 构建与验证

```sh
pnpm run setup
pnpm run build
pnpm run doctor
pnpm run audit:sources
pnpm test
pnpm run test:bot
```

默认回归包括产品 Node 测试和 ASR、语音、TTS、安装器、视频工具的 Python 测试。运行时冒烟测试会在临时目录启动真实 Harness/Bot，使用本地模拟模型验证请求、取消和重启后历史，不使用用户的 Bot 状态、模型凭据或麦克风。`test:bot` 运行被导入 Bot 的完整测试集，通过相同的包解析规则加载 Harness。

构建完成后写入 `output/build/manifest.json`，记录源文件内容摘要、上游版本、Node 主版本与运行时产物摘要。启动时拒绝缺失或陈旧构建；源码、锁文件或适配层变化后重新 `pnpm run build`，依赖变化先 `pnpm run setup`。诊断不会把 OpenNova 的 HEAD 当成 Harness 的来源版本。

源码 ZIP 无需 `.git` 也可安装和构建：Harness 的展示用构建标识由编排器传入，有 Git 时使用 OpenNova 提交，无 Git 时使用内容摘要；上游来源始终以 `upstream.lock.json` 为准。源码包内不能包含机器配置、`node_modules`、缓存和构建产物。

macOS CI 从 `git archive` 导出的临时源码运行同一套 setup/build/test/test:bot 命令，验证无 Git 元数据的安装路径，并故意提供无效的旧 Harness 路径。所有构建依赖来自锁文件对应的软件包源；首次安装需要联网和数 GB 空间。

## ChatGPT 授权与语音依赖

```sh
pnpm run setup -- --chatgpt
pnpm run build
pnpm run test:chatgpt
node services/agent/authorize.mjs
pnpm start
```

`upstream.lock.json` 统一管理 Harness、Bot、SIWC。SIWC 源码在 `engine/siwc/`，构建在 `engine/siwc/packages/local/dist/`；文本与工具模型调用使用同一套 SDK。旧的 `output/deps/siwc/` overlay 不再被读取，旧外部 SDK 目录保留但不参与运行。`patches/siwc/0001-stream-items.patch` 已应用到跟踪源码，构建时不要再次应用。

默认 `pnpm test` 包含 SIWC 协议测试；`pnpm run test:chatgpt` 可以单独运行这些测试。它们使用模拟响应，不登录、不访问 Keychain。上游 SDK 本地测试可运行 `node --test engine/siwc/packages/local/test/*.test.mjs`。`--chatgpt` 准备仓库内的 macOS Keychain helper；macOS 的 `build` 也自动完成此步骤，`bootstrap.py --check --web` 只检查本地依赖；`--web` 作为兼容参数保留。

旧 `agent.harness_root`、`agent.siwc_root`、`agent.keychain_helper` 以及对应的源码路径环境变量不再决定实现位置。Keychain helper 源码在 `services/agent/keychain.swift`，本机产物固定为 `output/bin/siwc-keychain`。构建记录其源码和二进制摘要，缺失或变更时原子重建，不访问 Keychain。迁移已有安装时保留已受系统信任的程序副本及摘要；全新安装从完整 Swift 源码编译。Keychain 条目身份不变；新编译的程序可能需要系统访问许可，不应删除原条目。`OPENNOVA_SIWC_STORAGE` 继续指定外部授权数据，原会话和记忆仍在仓库外。配置文件与凭据不要提交到仓库。

`pnpm run audit:sources` 可在 checkout 或无 Git 源码包内检查源码链接、嵌套仓库、submodule/gitlink 和包清单中的本地路径依赖。它排除安装依赖与生成产物，不能替代对任意自定义插件的人工审阅。产品默认路径回归还验证旧外部 SDK/helper/video 路径不会改变实现。Node、Python、Swift、uv、FFmpeg 和通过锁文件安装的第三方包仍是正常环境依赖；可选 Studio TTS 是本仓库服务的远端部署，位置必须显式配置。

SIWC 原始代码和 OpenNova 对其所做的修改采用其 **Noncommercial License v1.0**，保留在 `engine/siwc/LICENSE`、`patches/siwc/LICENSE` 中；其非商业限制不因纳入 OpenNova 而改变。OpenNova 独立自有代码继续采用根目录许可。不要将整个源码包描述为全部采用 Apache-2.0。

## 同步上游

导入来源和精确 SHA 见 `upstream.lock.json`。Harness 基线为 `d743267388641bc76f17c45ce8b4c231aed1d32c`，Bot 基线为 `20ebc9213cbbde7249d71786765f86be00dc6663`，SIWC 基线为 `0a36fefeb913055c8c7a1a29b63d82b96b2e841a`。Harness 另外保留了两项既有 HTTP/字符集修复，其原始提交写在 lock 清单和对应的 `Preserved-Harness-Commit` 提交说明中。

先保证工作区干净，在维护分支同步。以下 `<reviewed-upstream-ref>` 必须替换成已审阅的上游 tag 或提交；不要将这些命令作为日常启动步骤：

```sh
git subtree pull --prefix=engine/harness https://github.com/deepseek-ai/deepseek-harness.git <reviewed-upstream-ref> --squash
git subtree pull --prefix=engine/bot https://github.com/Fei2411/DeepSeek-Bot.git <reviewed-upstream-ref> --squash
git subtree pull --prefix=engine/siwc https://github.com/openai/sign-in-with-chatgpt-devkit.git <reviewed-upstream-ref> --squash
```

每次只同步一个组件，审阅差异、解决与本地补丁的冲突，更新 `upstream.lock.json` 的 `revision`、`version` 和适用补丁。SIWC 的修改文件保留变更声明，刷新已应用补丁及其 SHA-256；若上游已收录补丁，明确记录其退役。保留 subtree merge/squash 的提交消息和 `git-subtree-*` 元数据，否则下次同步可能找不到基线。导入后的普通修复提交无需伪造 subtree 元数据。

优先在 `services/` 编写 OpenNova 策略与插件；确需改动 `engine/` 时遵循相应目录的 AGENTS.md，使用单独的、可解释的补丁提交，不大规模重命名上游包。不能同时保留另一个作为运行时依赖的 Harness 副本。

同步后运行安装、构建、产品回归、Bot 回归和受影响 Harness 包测试。涉及模型协议再运行上游 SIWC 测试；涉及音频再做真人测试。最后验证全新源码导出，更新许可与第三方声明后发布。仅升级 manifest 中的版本而未更新源文件会被检测为不匹配。

## 本次验证边界

已在 macOS/Apple Silicon、Node 24.14.1 环境进行整合；仓库内 Harness/Bot 的完整构建和本地模拟模型测试覆盖加载、数据持久化与取消。CI 配置用于后续重复验证，其远端运行结果以实际 CI 为准。Linux/Windows 产品入口、真实云端调用和目标设备麦克风效果不在本次自动验证范围内。

本次整合的具体命令范围、计数和源码导出结果见[整合验证记录](research/opennova-engine-subtree-verification.md)。

SIWC 纳入仓库后的验证和原目录切换记录见[SIWC 整合验证](research/opennova-siwc-subtree-verification.md)。

工程外源码引用复查、检查命令和数据保留结果见[源码独立性验证](research/opennova-source-independence-verification.md)。
