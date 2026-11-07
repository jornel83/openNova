# OpenNova 团队状态备份与恢复

本工具用于同一台机器上的停机备份和恢复演练。源码留在 OpenNova 工程；Bot 身份、任务、成果、会话、记忆和本机连接凭据备份到仓库外的私有目录。ChatGPT 的 SIWC 授权存储和 macOS Keychain 保持原位置，不导出、不重新登录。

## 备份边界

`tools/bot/state-backup.mjs` 提供 `backup`、`verify`、`restore`。需要 Node 24，目标的父目录必须已存在。备份和恢复都只接受新目录，不覆盖、删除或合并旧数据。

- 先停止 Bot，等正在执行的任务和子进程清理完成。工具检查指定本机端口已关闭，并在复制期间持有 bundled Bot 使用的 `bot/state.lock`，阻止另一个宿主同时写入。
- 遇到已有 Bot 锁、Git 写入锁或未确认清理的作业会拒绝备份；不会强删锁。Harness 正常释放后仍会留下 `session.lock`：工具使用仓库内原生模块尝试真实非阻塞 flock，被占用则拒绝；未占用时持锁复制并在 manifest 记录省略该临时载体，不删除原文件。`uv.lock`、`Cargo.lock`、`poetry.lock` 等依赖锁文件属于普通数据，不按后缀误判为运行中进程。
- SQLite 文件使用 SQLite backup API，包含已提交 WAL 数据；副本转换为独立数据库，不复制 WAL/SHM/journal 临时侧文件。主数据库与 Bot 的其他 SQLite 数据库都做完整性检查。
- 普通文件按内容哈希校验；源目录在复制前后变化时，备份失败并清理本次未完成目标。该检查配合停机要求使用，不声称 SQLite 与全部会话文件存在跨文件原子事务。
- 符号链接只保存原链接目标文本与哈希，恢复链接本身，绝不跟随链接读取、递归或写入目标。内部相对链接和外部绝对链接均保持原引用；外部目标内容不进入备份。清单中如果有文件或目录位于符号链接父路径之下，校验立即拒绝，避免恢复过程穿越链接写入外部目录。硬链接、设备或 socket 仍不复制，需另行核对保存方式，不能直接删除原条目来绕过检查。
- `--reference` 记录配置文件的绝对位置与哈希，不复制配置内容。备份不会额外读取或导出 Keychain、SIWC 存储、浏览器配置和其他外部账号目录。状态目录内已有的本机连接凭据会随状态保存，备份目录权限为 `0700`，文件仅所有者可访问；文件保留 owner 的读写执行位，只读成果保持只读，不放宽为可写。特殊权限位或 owner 不可读文件会明确报错。

## 停机备份和校验

在原 OpenNova 工程目录执行；如使用自定义 `OPENNOVA_BOT_HOME` 或端口，替换下面的参数。

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
pnpm start -- --stop

mkdir -p "$HOME/.local/share/opennova/backups"
nova_backup_tag="$(date +%Y%m%d-%H%M%S)"
node tools/bot/state-backup.mjs backup \
  --home "$HOME/.local/share/opennova/bot-spike" \
  --destination "$HOME/.local/share/opennova/backups/team-$nova_backup_tag" \
  --port 18560 \
  --reference config/voice.local.json

node tools/bot/state-backup.mjs verify \
  --directory "$HOME/.local/share/opennova/backups/team-$nova_backup_tag"
```

成功备份包含 `manifest.json` 与 `payload/`。Manifest 记录原数据位置、Git HEAD、文件清单、哈希及配置引用；Git HEAD 不代表未提交修改。只有 `verify` 完成后才将该目录视为可用备份。校验检查遗漏、额外文件、内容变化、重复/越界路径和数据库完整性；哈希用于发现损坏，不是对不可信备份发布者的数字签名。

## 恢复到独立目录进行演练

```sh
mkdir -p "$HOME/.local/share/opennova/recovery-tests"
node tools/bot/state-backup.mjs restore \
  --directory "$HOME/.local/share/opennova/backups/team-$nova_backup_tag" \
  --destination "$HOME/.local/share/opennova/recovery-tests/team-$nova_backup_tag"
```

恢复后可以只读核对员工 ID、Task/Run/派工及成果版本、记忆文件与报告内容。原目录仍在，恢复工具不启动模型、任务或语音，也不重写记录内的绝对路径。

任务工作区和验收证据中保存了绝对路径。因此，**恢复副本是 staging，不能直接设置为新的 `OPENNOVA_BOT_HOME` 启动**。副本内的 `.opennova-restore.json` 保存原位置；统一启动入口检查该标记，路径未回到原位置时拒绝启动，防止恢复演练误访问日常任务目录。状态查询和停止命令保留原行为。

## 真正恢复或版本回退

1. 明确选择源码版本与对应备份。数据库格式是否兼容必须验证；不要让旧代码直接接管新版数据库。
2. 停止受影响的 Bot、任务进程和语音客户端，核对清理完成，保存当前版本的额外备份。
3. 先把当前状态目录移到另一个保留目录，确保原位置空出；原数据不要删除。
4. 将已校验的 staging 副本移到 manifest 记录的原绝对位置。保留恢复标记，启动守卫此时才会放行。
5. 配置、授权存储、Keychain 和代码工程路径继续使用原位置。若要跨机器或改变路径，需要另做显式迁移，不能依赖本工具自动替换字符串。
6. 在没有使用共享构建目录的运行实例时构建所选版本，再用统一入口启动。核对身份、任务、成果和记忆，确认暂停/待处理的记录没有变成自动重跑。

## 软件验证

定向测试命令：

```sh
node --test scripts/tests/state-backup.test.mjs
node --test services/bot/tests/team-recovery-runtime.test.mjs
```

工具测试使用仓库外临时数据，覆盖两份 SQLite 数据库及 WAL、员工身份、Task/Run/成果版本、记忆、并发写入拒绝、活动端口/锁、进程清理未确认、损坏与路径攻击、原目录不覆盖，以及 staging 启动保护和回到原路径后的准入。

真实 bundled Bot/Harness 恢复测试创建员工和成果后停机备份，把原目录保留，再将恢复副本移回原绝对位置启动；验证主 Bot、员工、任务会话、成果版本和记忆不变，关闭团队并重启后仍可看历史和使用主助手，重新开启后能沿原任务接续。原目录保留副本和备份哈希不变。实际用户数据的备份、版本回退及真人语音验收在 M3 验证记录中另行列出，不由这些测试代替。
