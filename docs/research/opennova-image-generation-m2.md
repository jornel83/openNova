# M2 项目对话图片生成与改稿

2026-11-18。OpenNova 的工作对话已接入 Seedream 5.5。用户可以生成静态图片、修改当前图、另存新版本、预览并重新选择历史版本。图片/GIF 使用专用 Ark 凭据。GIF 的正式对话入口属于 M3。

## 工具和前台

- [图片执行器](../../tools/image/generation.py)负责文生图和参考图编辑。它在提交前冻结参考图、记录操作和调用状态，并校验实际响应的图片字节。画面生成尺寸和最终交付像素可以分别指定。同步请求结果未知时，重放同一操作会取回已有状态。
- [项目宿主](../../services/bot/images/generator.mjs)绑定请求所属项目，核对当前文件和参考图版本，调用固定的 Python 程序。新稿保存成功后，若用户仍处于原项目和原文件上下文，选中这次成果。重启对账可以从已保存的模型输出继续本地交付。
- [图片预览](../../services/bot/images/preview.mjs)和[对话图片卡片](../../services/bot/web/generated-image.jsx)通过当前项目的成果记录读取图片。打开原图或选择旧版继续改稿会核对磁盘文件。安装说明见 [工具 README](../../tools/image/README.md)。

## 验收

1. 离线两轮集成使用真实 Harness、宿主、Python 执行器及本地文件，模型返回使用测试图片。第一轮通过 `/ask` 文生图。第二轮省略参考文件，使用当前稿保存为 1024 × 512 的新图。重启后两版都能选择，相同请求重放仍只有两条生成记录。[两轮集成测试](../../services/bot/tests/image-generation-runtime.test.mjs)
2. Chromium 使用本地 PNG 验证对话预览、旧版选择、当前文件和输入焦点。测试材料见 `output/playwright/m2-image/preview-and-selection.png`。
3. 言昕真实验收通过隔离的 OpenNova 实例运行生产聊天模型，项目指向 `workspaces/自媒体IP/小昕`。第一轮使用用户确认的定稿分身，原图 SHA-256 为 `659cbe70d2ec92f583c11824e241ff7b47cee39b84bb7f668a1d1d221eac0322`。方舟请求 ID 为 `0217949946911636b3b42eb0dccc67d054a95217969ba779ee05b`。执行器标记 `unknown`，未取得可保存的图片。计费情况及响应解析失败的具体原因未知。复用同一前台请求 ID 得到 `duplicate:true`，没有新增生成操作。浏览器实测截图在 `output/playwright/m2-image/yanxin-live-first-attempt.png`。
4. 首次真实回执未保留响应类型及长度。执行器现会检查响应截断，解码 gzip/deflate，并记录 HTTP 状态、响应类型和字节数。正式生图使用方舟返回的签名链接下载原图。下载遇到可重试的网络错误时，只重取同一张图一次。签名链接仅在内存中使用。
5. 用户授权重新生成一次首稿，再基于成功稿改衣服。第一次对话把模型名填写错误，执行器在提交前返回 `unsupported_image_model`。工具契约现将可选的模型字段限定为已验证的模型 ID，默认省略。随后两轮项目对话各成功提交一次，返回真实 PNG。验收通过后，复用两轮各自的请求 ID 均命中已有回执，生成操作数保持不变。

| 成片 | 实际参考图 | 保存尺寸 | 方舟请求 ID |
| --- | --- | --- | --- |
| [冰蓝针织衫首稿](../../workspaces/自媒体IP/小昕/assets/表情包/言昕_元气满满_Seedream_M2_v1.png) | 言昕定稿分身 | 1536 × 1024 | `02179499734966836a85968bdbb8a949a5bf709eb7d71bc902060` |
| [白色圆领卫衣改稿](../../workspaces/自媒体IP/小昕/assets/表情包/言昕_元气满满_Seedream_M2_v2.png) | 冰蓝针织衫首稿 | 1536 × 768 | `021794997468227662416cb134b03a75ced1088172443608437cb` |

两次输入的 SHA-256 均与各自的参考文件一致。目视核对了深色长发、五官、双拳动作和“元气满满”文字。第二版换成了白色圆领无帽卫衣，画面为 2:1 横版。两版右下角均带模型生成标识。

Chromium 刷新后，两张图片卡片均以实际尺寸解码。依次选择“用这版继续改”可将当前文件切回首稿、再切回白色卫衣版。重启验收实例后，当前文件仍为第二版，两版的文件哈希与回执均一致。[双版本界面截图](../../output/playwright/m2-image/yanxin-live.png) · [两轮输入、输出及重放记录](../../output/image/verification/m2-yanxin-retry-20261118/acceptance.json)

模型参数契约和签名下载修复后的全库 `pnpm test` 通过，包含 1086 项 Node 测试及七个 Python 测试组。图片组共 174 项，其中 173 项通过，1 项可选旧 SDK 测试跳过。最终构建和 `pnpm run doctor` 通过。本轮日志保存在 `output/image/verification/m2-yanxin-retry-20261118/`。先前的独立 `pnpm run test:bot` 共通过 521 项，日志保存在 `output/image/verification/m2-yanxin-20261118/`。
