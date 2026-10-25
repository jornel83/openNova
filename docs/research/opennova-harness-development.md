# OpenNova 的 Harness 源码开发与升级

更新：2026-10-25。采用用户确认的 Fork + Git Submodule：工程目录统一，提交历史独立。

## 当前结构与版本

```text
openNova/
├── services/                  # 产品逻辑、ChatGPT 适配、Bot 接入
├── tools/                     # 语音、启动、安装
├── extensions/                # 浏览器扩展
└── third_party/deepseek-harness/  # 独立 Git 子模块
```

- Fork：`git@github.com:jornel83/deepseek-harness.git`。
- 官方 upstream：`https://github.com/deepseek-ai/deepseek-harness`。
- 本次版本：`cccbe9cb4763f597bfb83129ca03345c3fbead1b`，位于 Fork 的 `codex/opennova-research-http`。基于 `d743267388641bc76f17c45ce8b4c231aed1d32c`，保留两个已有 HTTP/编码处理补丁，不升级官方版本。
- OpenNova 的 **gitlink** 是 Harness 提交版本的唯一来源；`config/runtime-versions.json` 保存路径、仓库、upstream 和 pnpm 版本。安装器与 Bot 使用相同解析器，不再维护第二份 SHA 常量。
- SIWC 和 DeepSeek-Bot 的版本管理保持原状，未将二者合并进 DSH。

原来的 `Documents/work/project/deepseek-harness` 检出保留，可独立开发和使用。默认 Demo 使用本工程内的子模块；`OPENNOVA_HARNESS_ROOT` 或 `agent.harness_root` 仍可指向另一个相同提交的检出。

## 新机器或新检出安装

需要 GitHub SSH 访问权限、Node 24、Python 3.11，以及 README 列出的 macOS 依赖。在需要的 OpenNova 分支上：

```sh
git clone --recurse-submodules --branch <OpenNova分支> git@github.com:jornel83/openNova.git
cd openNova
python3.11 tools/setup/bootstrap.py --install --web
python3.11 tools/setup/bootstrap.py --check --web
```

已克隆但未初始化子模块时，`--install` 会初始化它，也可显式运行：

```sh
git submodule update --init --recursive
```

安装器不会重置已有错误版本或脏检出；先保存开发修改，再由开发者明确更新子模块。不要对正在运行或有未保存修改的检出执行 `--force`。

构建回执存放于 `output/deps/harness-build.json`，包含规范化路径、提交和 pnpm 版本。首次安装或提交/路径变化时重新安装依赖并构建；失败不会生成有效回执。运行时发现旧产物会提示重新安装，不能只修改版本指针后复用旧 lib。

原有一键启动参数不变；子模块迁移不重建 Keychain 授权、Bot 记忆或会话。已经运行的 Bot 使用的是启动时的依赖，需要在没有进行中的任务/语音时重启 Bot 才切换；退出语音本身不会关闭后台 Bot。

## 日常二次开发

先区分改动归属：界面、语音、产品策略和模型适配放在 OpenNova；通用 DSH 运行时或工具缺陷放在 DSH Fork；Bot 自身机制独立处理。尽量使用插件接口，减少核心补丁数量。

子模块初始化通常处于 detached HEAD；修改前进入子模块创建开发分支，例如：

```sh
cd third_party/deepseek-harness
git switch -c codex/opennova-harness-feature
# 修改源码；按 DSH 项目说明构建、测试
# 审查并暂存本次改动后：
git commit -m "fix: describe the harness change"
git push -u origin codex/opennova-harness-feature
cd ../..
git add third_party/deepseek-harness
python3.11 tools/setup/bootstrap.py --install --web
# 完成 OpenNova 集成验证后提交依赖引用及相关适配改动
```

**顺序：先推送 DSH 提交，再提交 OpenNova 的 gitlink。** 否则其他机器可能无法获取被引用的提交。开发期间源码/构建测试遵循 DSH 的说明；正式接入 Demo 前提交改动、暂存 gitlink、运行安装和回归检查。安装器会拒绝未提交的源码，避免把不可复现的构建标记为已验证版本。

## 跟进官方更新

不要在 Demo 启动时自动追踪官方最新提交。每次升级从当前已验证提交建立独立升级分支：

```sh
cd third_party/deepseek-harness
# 新克隆的仓库若尚无 upstream，先配置一次：
git remote add upstream https://github.com/deepseek-ai/deepseek-harness
git fetch upstream --tags
git switch -c codex/opennova-harness-upgrade
# 选择已评估的官方 tag 或 commit，合并到自己的升级分支：
git merge <官方tag或commit>
```

已有 upstream 时跳过 `remote add`。保留 Fork 开发分支，用 merge 接入选定官方版本，不重写已被 OpenNova 引用的提交，不强推共享分支。官方已覆盖的补丁应移除重复实现，并保留可追溯提交。

升级验证至少覆盖：文本与工具调用、DeepSeek 搜索、国内外正文读取、文件与 Shell、取消、长会话接续、语音和双窗口。验证通过后推送 DSH 分支，在 OpenNova 暂存新 gitlink、重建、提交对应适配。合并冲突需要逐项审查，Submodule 不会自动消除冲突。

## 回退

结束正在运行的任务，保存子模块未提交修改，找出 OpenNova 上一个验证过的 gitlink：

```sh
git log --oneline -- third_party/deepseek-harness
git ls-tree <已验证的OpenNova提交> third_party/deepseek-harness
git -C third_party/deepseek-harness switch --detach <上一步的DSH提交>
git add third_party/deepseek-harness
python3.11 tools/setup/bootstrap.py --install --web
```

与该版本配套的 OpenNova 适配也要一起回退/验证，不能保证任意新旧组合兼容。通过新提交记录回退，不覆盖历史。运行数据在子模块外，不随源码回退删除。

## 本次迁移验证（2026-10-25）

- Fork 远程引用及独立 GitHub 克隆均可取得固定提交；子模块没有对旧检出的对象目录依赖。
- 新子模块完成锁定依赖安装与全量构建，`bootstrap.py --check --web` 通过。
- Agent/Bot 的 259 项 Node 测试、安装器的 5 项 Python 测试通过；原有 DSH HTTP 补丁的 65 项测试通过。
- 独立 Bot 的真实请求完成 DeepSeek 搜索、HTTP 正文读取和带来源回复，未打开浏览器，也未调用旧检索封装。
- 日常 Bot 已切到子模块并保留原会话；真实语音听感没有在本次迁移中重测。原有启动脚本和设备参数保持不变。
