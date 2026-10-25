# DSH Fork + Submodule 接入设计

用户已选择方案 2：目录统一，Git 历史独立。继续在当前 codex/desktop-browser-m0 worktree 实施，不重做已有联网改动。

- 在 third_party/deepseek-harness 引入用户的 git@github.com:jornel83/deepseek-harness.git，固定 cccbe9cb4763f597bfb83129ca03345c3fbead1b。先发布已有两个 HTTP 补丁提交至 codex/opennova-research-http；不覆盖 master，不升级官方版本。
- 保留原 Documents/work/project/deepseek-harness，运行默认路径改为工程内 submodule；环境变量和本地配置仍可显式指定独立检出。
- Git gitlink 是 Harness 提交版本的唯一来源；runtime-versions.json 保留路径、仓库、upstream 和 pnpm 11.28.5 等元数据。移除重复的 Harness SHA 常量。
- 安装入口初始化缺失 submodule；已有错误版本或未提交内容不重置。版本切换后通过构建回执识别失效产物并重建，运行检查使用同一版本定义。
- 构建及凭据、授权、会话保持独立；迁移不修改语音体验、搜索策略、VPN 配置。
- 文档记录初次安装、日常开发、官方升级、回退，以及两个仓库分别提交的流程。

考虑过继续并列仓库（配置路径依赖更强）及 subtree（同步复杂）；采用用户批准的 Fork + Submodule。

验收：默认与显式路径测试、未初始化和错误/脏检出保护、版本变化触发重建；从远程验证补丁提交可获取，构建新子模块并用独立 Bot 做真实工具链冒烟，保留日常 Bot 会话。
