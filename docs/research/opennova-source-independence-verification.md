# OpenNova 源码独立性复查（2026-10-27）

## 结论与修正

当前 OpenNova 产品入口不再选择工程外的私人 Harness、Bot、SIWC、Keychain helper 或视频工具实现。三个引擎均为普通 Git 跟踪源码，完整源代码压缩包可独立安装、构建；subtree 仅用于上游维护，不是运行时链接。

本次修正：

- Keychain helper 从固定的 `output/bin/siwc-keychain` 加载，源码为 `services/agent/keychain.swift`。旧 helper 环境变量和机器路径设置不再选择外部程序。macOS 构建检查源码及二进制摘要，缺失或变化时原子重建；编译失败保留原产物，构建不访问凭据。
- 现有机器迁入已受 macOS 信任的 helper 二进制，保留 Keychain 访问能力。其本机元数据明确标记为 `migrated-trusted-local-binary`，源码摘要仅是迁移基线，不宣称该旧产物可由当前源码逐字节复现。全新源码包从 Swift 源码编译；源码变化会触发重建，系统可能要求为新程序允许访问原 Keychain 条目。
- 移除 Studio TTS 的个人路径默认值。远端运行本仓库 `services/tts` 的部署副本，通过 CLI、环境变量或 `tts.studio_host` / `tts.studio_tts_dir` 配置；已有 TTS 连接及云端 TTS 不依赖此部署路径。
- 视频 skill 启动器固定加载自身所在工程，忽略旧 `OPENNOVA_ROOT` 工程切换设置。
- 新增 `pnpm run audit:sources`：检查源码符号链接、嵌套仓库、gitlink/submodule、本地包依赖和 workspace 范围。使用锁定版本 YAML 解析器处理 workspace 配置，检查规范化路径及真实路径，包含生成目录中的依赖符号链接。CI 同步运行此检查。

## 验证结果

在 macOS / Apple Silicon、Node 24.14.1、pnpm 11.28.5 上：

- 14 个源码符号链接均指向工程内部；0 个 gitlink/submodule。2 个实际 `link:` 包覆盖均位于仓库内。
- 产品回归共 **311 项通过**：160 项 Node 测试，151 项 Python 测试。覆盖外部路径覆盖、符号链接逃逸、workspace 外部路径、YAML 别名、helper 重建与失败保护，以及 Bot 持久化、语音启动和视频工具。
- 最终实现提交 `2cdc1e1c55` 的 `git archive` 导出到带空格的全新临时目录；不含 `.git`、机器配置或旧 helper。设置无效的旧 Harness/SIWC/helper/video 路径后，setup、build、doctor、audit:sources、311 项产品测试及 helper 本地检查全部通过。
- 原始工程目录已快进合并、构建并重启。Bot 健康检查正常，网页 HTML/JS/CSS 可访问，继续使用相同 Bot/会话 ID；保留 105 条请求历史及全部 188 条持久记录，3 个记忆文件摘要一致。
- 原配置字段、密钥配置与客户端 token 保留；仅给机器 TTS 配置补充此前隐含的 Studio 主机与部署目录。复制进工程的 helper 二进制摘要与原文件相同。
- SIWC 授权读取成功，SDK 校验模型列表时正常续期令牌。加密文件因此更新，但账户、注册 client、profile、权限范围和选中身份未变，无需重新登录。
- 独立复核未发现剩余的产品外部私人源码引用；复核提出的两项检查器漏检问题已通过先失败后通过的测试修复。

## 数据和外部环境边界

SIWC 授权继续保存在 `~/.config/opennova-siwc-probe/`，加密密钥保留在原系统 Keychain 条目。Bot 会话与记忆仍在 `~/.local/share/opennova/bot-spike/`，独立 Harness 语音状态仍在 `~/.local/share/opennova/harness-home/`。本次备份和此前落在 `output` 的整合状态备份均已移到仓库外的 `~/.local/share/opennova/backups/`。现有 Git 忽略的机器配置保留。

“源码独立”不等于零安装依赖：Node、Python、Swift、uv、FFmpeg、锁文件声明的公共第三方包、模型权重和可选远端 TTS 服务仍需准备。检查器排除安装依赖及生成产物，不能替代任意新增插件的人工审阅。未进行真实模型生成、付费 TTS 合成或麦克风录音测试；未改动其他运行中的开发实例。

本机验证日志和摘要位于原工程的 `output/source-audit/`；其中只保存诊断记录，授权与会话备份路径在 `backup-path.txt` 指向仓库外。
