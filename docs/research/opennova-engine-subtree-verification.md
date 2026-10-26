# Harness / Bot 源码整合验证（2026-10-27）

实现分支：`codex/integrate-engine`。运行时代码验证到 `5113784f72`；后续收尾只更新文档。

## 来源与保护范围

- 从既有 OpenNova 工作区保存基线 `a2ca17fdd61c8701a053dedb1e1226e5538ae6f1`，在独立 managed worktree 实施；原目录的未提交改动保留。
- Harness subtree 基线：`d743267388641bc76f17c45ce8b4c231aed1d32c`；保留两项既有 HTTP/字符集修复后，完整目录树为 `4976b2b54c00c824448d160031ad592b75490b10`，与原 Harness 当前源码一致。
- Bot subtree 基线：`20ebc9213cbbde7249d71786765f86be00dc6663`；目录树 `b0378727fd397be8c1d203f338cc6f457779d6ee` 与上游一致。
- 没有 gitlink/submodule。上游自带的文档/测试内部相对软链接保留；运行时代码不指向外部 Harness/Bot 工程。
- 未移动、打开或迁移用户会话、记忆、Keychain；未切换正在运行的服务；未推送或发布。

## 自动验证

环境：macOS / Apple Silicon、Node 24.14.1、pnpm 11.28.5、Python 3.11。

| 验证 | 结果 |
| --- | --- |
| 根目录锁定安装、Harness/Bot/OpenNova 网页完整构建 | 通过 |
| 产品 Node 回归 | 134 / 134 |
| Python：ASR / 语音 / TTS / 安装器 / 视频工具 | 26 + 89 + 19 + 3 + 12 = 149 / 149 |
| Bot 上游完整测试 `pnpm run test:bot` | 517 / 517 |
| Harness `web-fetch-http` 测试（含保留修复） | 65 / 65 |
| 可选 SIWC 工具扩展协议测试 | 8 / 8 |
| 真实 Harness/Bot 进程 + 本地模拟模型 | 对话、取消、同一 Bot 重启与历史恢复通过 |
| 构建诊断 `pnpm run doctor` | ready=true |
| Bot / 语音帮助入口 | 无需账户或服务即可运行 |

合计 873 项测试通过。包含在默认 Node 回归中的进程冒烟使用临时工作区和数据目录，不使用真实模型或用户 Bot 数据。

## 独立源码验证

通过 `git archive` 导出到仓库外、路径含空格的临时目录，不含 `.git`、原有构建、`node_modules` 或用户配置。故意将环境变量 `OPENNOVA_HARNESS_ROOT` 和新建本地配置 `agent.harness_root` 指向不存在的旧目录。

在该目录从锁文件安装依赖，完整构建 Harness、Bot 和网页，执行 doctor、产品 Node/Python 回归及 Bot 全部测试，均通过。安装复用了本机软件包缓存，但未复用原工程的源码或构建产物。最后逐文件核对：该目录的 15,568 个跟踪源文件与所验证 HEAD 完全一致。

这项验证发现并修复了两处测试脚本把空格编码为 `%20` 的路径处理问题。另修复启动编排的控制路径：源码改变或构建缺失时，Bot `--stop` / `--check` 和帮助仍可使用；真正启动继续要求有效构建。

## 审查与限制

一次独立只读全分支审查核验了导入来源、适配边界、包实例、构建摘要、数据路径及后续修复，没有剩余阻塞项。

未在本次迁移中重新调用真实计费模型、豆包 ASR/TTS 或麦克风，也未验证 Linux/Windows。GitHub CI 已配置相同的无 Git 元数据源码流程，远端执行结果尚待仓库推送后产生。现有声学与产品功能限制继续以语音和 Bot 文档为准。
