# OpenNova 图片与 GIF：M0/M1 验收记录

日期：2026-11-18。**历史记录：本文记录切换前的 OpenAI 探针与第一批 M1 验收。用户随后改用 Seedream / Seedance，当前以 [Ark 验收记录](opennova-image-gif-ark-verification.md) 为准。**原设计见 [开发计划](../superpowers/plans/2026-11-18-image-gif-production.md)，原执行说明保存在 [历史 README](../../tools/image/README-openai-legacy.md)。

## 当前结论

- **M1 本地基础已实现**：三工具契约、本地媒体导出、输入冻结、无覆盖保存、幂等重放、重启对账及 GIF/真实首帧交付包。
- **M0 离线部分已通过**：独立依赖安装、官方 SDK 参数编码、凭据读取与脱敏、请求预算及未知状态处理已验证。
- **M0 真实账号调用未完成**：当前没有独立 OpenAI API 凭据，静态编辑与原生 GIF 均为 `unverified`。本次真实图片/GIF API 请求数为 **0**。没有将离线 mock、历史图片或历史 GIF 制作成功当作真实接口验收。
- M2–M5 尚未实施。`image_generate` 和 `gif_generate` 仅有参数契约，执行明确返回尚未实现；OpenNova 前台、后台及 `image-production` skill 尚未开放这些能力。

## OAuth 结论

用户询问能否复用 OpenAI auth。检查 OpenNova 的 `services/agent/chatgpt.mjs` 与 `engine/siwc/packages/local/src/{items,types}.ts` 后，确认现有登录走 Sign in with ChatGPT：资源为 `api.openai.com/v1`，权限为符合条件的 Responses 推理，未暴露 Images API。

官方 SIWC 当前预览明确排除图片生成，因此现有 ChatGPT/Codex 登录不能替代图片接口凭据。平台 WIF 属于另行配置项目/服务身份的认证方案，本阶段没有将其接入，也没有读取登录缓存或复用此前的 Ark key。[SIWC 限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [模型与推理范围](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) · [WIF](https://developers.openai.com/api/docs/guides/workload-identity-federation)

## 实现与验证边界

| 模块 | 实现及已验证行为 |
| --- | --- |
| `schema.py` / `tool-definitions.json` | 三个公开工具契约；拒绝未知字段、错误格式/尺寸组合；宿主项目/请求身份不进入模型参数 |
| `tool.py` | 固定 JSON stdin/文件入口，1 MiB 上限；普通文件校验，不被 FIFO 阻塞；结构化回执 |
| `export.py` | PNG/JPEG/WebP/GIF 全帧解码，首帧提取、等比精确画布、显式裁剪、GIF 优化和帧序列编码；保留帧时间与循环 |
| `operations.py` | 冻结输入/hash/执行器版本，阶段持久化，无覆盖发布；发布前后身份和字节核验；记账失败返回已保存事实，重放补账 |
| `bundle.py` | 最终 GIF + 实际首帧 + 父 manifest；稳定子操作；部分提交可对账；终态取消/失败不偷偷继续 |
| `providers/openai_provider.py` / `probe.py` | 私有 API 凭据读取，固定官方 Images 编辑端点，有预算且不重发的静态/GIF 探针，失败分类及能力范围 |
| `requirements.lock.txt` | 完整 15 个依赖版本；独立环境安装验证及 `pip check` 通过 |
| `scripts/test.mjs` | 加入本地图片测试，可用 `OPENNOVA_IMAGE_PYTHON` 指定隔离解释器；保留已有 documents 测试接入 |

M1 公共记录包含 Python/Pillow 版本与执行器源文件哈希。若 `prepared` 状态恢复需要重新渲染，但 Pillow/执行器已变更，返回 `media_runtime_changed`；已有渲染或已提交成果可复用，不要求重新生成。视觉检查仍单独标记 `not_checked`，不能由格式检查推导“人物动作正确”。

GIF 的多个文件不是一次原子提交。交付包明确记录 `partial` 和失败/取消状态；第一次导出 GIF 成功后发生中断，仅允许恢复本地未完成步骤。保存之后记账不可用时使用 `bookkeepingPending`，不将已保存文件说成生成失败。

## M0 SDK 与依赖

隔离运行环境：`output/image/runtime/py311-sdk354`。实际检查结果保存在 `output/image/verification/m0-m1-20261118/environment.json`。

| 项目 | 实测结果 |
| --- | --- |
| 系统 | macOS / Darwin 25.3.0 / arm64 |
| Python | 3.11.15 |
| OpenAI Python SDK | 3.54.0 |
| Pillow | 13.0.0 |
| FFmpeg | 7.1.1；M1 使用 Pillow，不要求 FFmpeg 编码 |
| 仓库 Node | 24.14.1，显式选用 Node 24；默认 shell 的 Node 22 不用于仓库验收 |
| 凭据 | missing；不输出 key 或私有文件路径 |
| 静态编辑 / 原生 GIF | unverified / unverified |

真实 SDK 使用本地 `httpx2.MockTransport`，同时阻断 socket/DNS，验证 multipart 图片字段与 GIF 的 `output_format=gif`、`frame_count=2`、`frame_duration_ms=200`。这验证了客户端编码，并未验证账号权限。实际 API 客户端构造为固定官方地址、120 秒超时、`max_retries=0`、`follow_redirects=False`。

探针测试覆盖超时/500 的 `unknown`、403/额度/审核/明确不支持的不同类别、跳转拒绝、客户端关闭、发送前持久占用预算、同 session 不重复发送、原预算不能提高。未知远端结果不会换模型、换路线或自动重试。

## 言昕真实素材的本地验收

源文件：`workspaces/自媒体IP/小昕/assets/表情包/言昕_元气满满_圆领卫衣_横版_OpenAI逐帧_v1.gif`。

- 原始尺寸 **640×320**，**12 帧**，总时长 **2000 ms**，循环 `0`（无限），803651 字节。
- SHA-256：`7aadf16c127c71664132df6e443da33bc0e72c5e34151fe655b7086dd80970a8`。验收前后相同，原素材未修改。
- 每帧时间：`[500,120,60,80,60,100,120,120,120,120,120,480]` ms。
- 使用正式 `tool.py --request -` 处理，未绕过工具自行调用编码器；每份回执 `generation.remoteCalls=0`。

| 导出 | 结果 |
| --- | --- |
| 首帧 PNG | 640×320 / 220927 字节；与 GIF 实际第 0 帧及原已保存首帧的 RGBA 逐像素一致 |
| GIF 默认优化 | 640×320 / 803651 字节；重编码会变大，正确保留原始紧凑字节；不虚报压缩收益 |
| GIF 缩小 | 320×160 / 497933 字节；仍是 12 帧、2000 ms，逐帧延时与循环均保留 |
| 首帧 WebP | 640×320 / 35826 字节；可解码 |
| 同一操作重放 | 返回相同回执与哈希，复用已保存结果 |

详细回执：`output/image/verification/m0-m1-20261118/local-acceptance.json`。验收产物和状态仅保存在 `output/image/verification/`，未污染用户角色素材目录。

另用同一真实 GIF 验收交付包：在 GIF 已发布而父步骤尚未完成记账时模拟进程崩溃，恢复时捕获到唯一渲染动作 `first_frame`，没有再次编码 GIF；最终 GIF 与首帧逐像素一致，重复调用得到相同回执。详见 `output/image/verification/m0-m1-20261118/bundle-acceptance.json`；父 manifest 位于该目录的 `state/.gif-bundles/yanxin-gif-bundle/manifest.json`。

## 回归与故障注入

命令：

```sh
output/image/runtime/py311-sdk354/bin/python -m unittest discover -s tools/image/tests -v
env PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
  OPENNOVA_IMAGE_PYTHON="$PWD/output/image/runtime/py311-sdk354/bin/python" pnpm test
env PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm run build
env PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm run doctor
```

全仓回归：1069 项 Node 测试通过，352 项 Python 测试通过（其中当时的图片组为 87 项），无失败或跳过。之后增加交付包恢复测试，完整图片组最终 **108 项全部通过，无跳过**：媒体编码 22、持久操作 29、探针/真实 SDK 33、CLI 3、交付包 21。完整日志位于 `output/image/runtime/pnpm-test.log` 和 `output/image/runtime/m0-m1-final-tests.log`。

最终源文件完成后重新执行 `pnpm run build` 成功，随后 `pnpm run doctor` 返回 `build.ready=true`。日志为 `output/image/runtime/pnpm-build-final.log` 与 `output/image/runtime/opennova-doctor-final.log`。构建前的旧缓存曾被 doctor 正确识别为 `source_or_runtime_changed`，已通过正式构建更新；未手工绕过构建新鲜度校验。

保存故障注入覆盖：参数/绑定冲突、重复调用、冻结原输入后外部修改、目标抢先创建、目标父目录被替换、暂存输入被改写、发布临时文件被替换、并发重入、发送前/处理中取消、渲染后或发布后崩溃、完成记录单次及持续写入失败、已提交成果被改写、FIFO 非普通输入。真实 SDK 验证与本地故障注入均无付费模型请求。

## 尚未验收的内容

M0 尚缺真实账号下的一次静态编辑与一次小尺寸原生 GIF 请求。独立 API 凭据配置后，使用同一稳定 session 和最多两次请求预算继续验证；无权限或返回未知必须如实保留，不能通过修改记录再次发送。

当前不会在 OpenNova 聊天中直接生图/生成 GIF。前台工具接入、角色配置、固定文字层、真正模型生成、skill 快照、后台任务、全动画视觉审阅等均在后续里程碑。尚未验证 Windows、网络文件系统或跨平台安装，本地 state 目录仍由可信宿主管理。
