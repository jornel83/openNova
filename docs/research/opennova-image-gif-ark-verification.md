# 图片与 GIF：Ark M0 / M1 验收记录

日期：2026-11-18。当前路线为 Seedream 图片生成/编辑、Seedance 视频生成、本地视频转 GIF。对应 [切换计划](../superpowers/plans/2026-11-18-image-gif-ark-migration.md) 和 [工具说明](../../tools/image/README.md)。

## 结论与完成边界

**M0 真实生成验证通过。** 11 月 18 日使用新的图片/GIF 专用凭据完成 Seedream 5.5 参考图编辑、Seedance 2.5 图生视频、GIF 转换及实际首帧校验。M1 公共基础已通过本地验收。

### 图片和 GIF 专用凭据实测

图片/GIF 使用仓库外的 `~/.config/opennova/ark-image-gif.key`，独立视频宿主仍使用原有 `videoKeyPath`。通过默认网络路径分别提交一次图片编辑和一次用于 GIF 的视频生成。两项测试均使用白底蓝圆作为输入。

| 项目 | 验收结果 |
| --- | --- |
| Seedream 图片编辑 | 1024 × 1024 PNG。圆心 RGB 从 (45, 100, 220) 变为橙色 (254, 125, 27)，背景采样为 (254, 254, 254)。 |
| Seedance 动画素材 | 原始 MP4 全片解码通过，640 × 640，97 帧，24 fps。 |
| GIF 交付 | 512 × 512，4 秒，10 fps，40 个不同画面，无限循环。蓝圆在水平方向移动，首尾圆心横坐标相差约 4 像素。 |
| 首帧 | 从最终 GIF 提取 PNG，逐像素 RGBA 校验通过。导出使用的 MP4 哈希与模型下载回执一致。 |

产物和脱敏回执在 `output/image/verification/ark-key-split-20261118/`。图片为 `image/artifacts/seedream_edit.png`，动画为 `gif/artifacts/seedance.gif`，首帧为同目录的 `first_frame.png`，交付回执为 `bundle.json`。下载时补充了方舟实际返回的精确 CDN 域名 `ark-acg-cn-beijing.tos-cn-beijing.volces.com`，随后从同一个已完成任务取得原视频。

### 原凭据开通后的复测

使用原 Ark 凭据和同一张蓝色圆形参考图，新会话向北京地区的 `/api/v3/images/generations` 提交了 1 次编辑请求。目标模型为 `doubao-seedream-5-5-261028`。服务返回 403，未返回图片或 usage。请求 ID 为 `021794985945835291c0f5a72b510a28c7f913d2f5a6ea9d859b9`。随后停止生成，Seedance 视频提交次数为 0，本轮没有 GIF 或首帧。

用同一凭据只读查询 `GET /api/v3/models` 返回 200，列表中同时出现 Seedream 5.5 和 Seedance 2.5。该接口反映账号的模型可见性。具体是哪项权限拒绝了生图仍待查明，核对位置为密钥所属资源项目、可调用 Model ID 及启用的 IP 白名单。控制台权限页面需要登录。参见 [Models API](https://console.volcengine.com/ark/region%3Acn-beijing/docs/models-api) 和 [API Key 权限说明](https://docs.volcengine.com/docs/ark/manage-api-keys?lang=zh)。

本次证据位于 `output/image/verification/ark-m0-20261118-activated/`，其中 `live-submit.json` 为生成回执，`models-readonly.json` 为可见性检查结果。

### VPN 与直连对照

2026-11-18 使用同一把 Ark key、同一模型和相同的编辑请求体进行对照。默认 Python HTTPS 配置使用本地代理端口 7897，系统到方舟地址的常规路由经过 `utun9`。直连测试单独禁用请求代理，并将 TLS 连接底层的 TCP socket 绑定到 `en0`，连接后读回网卡绑定。直连对端为 `14.103.169.114:443`，TLS 按官方域名校验。

| 请求 | 默认路径 | 绑定 en0 直连 |
| --- | --- | --- |
| 查询模型列表 | 本次 HTTP 200，Seedream 5.5 可见 | 本次 HTTP 200，Seedream 5.5 可见 |
| Seedream 5.5 图片编辑 | 上次 HTTP 403 `AccessDenied` | 本次 HTTP 403 `AccessDenied` |

直连生成提交 1 次，视频提交 0 次。方舟仅说明调用方对目标资源无访问权限，未给出具体规则。绕过本机 VPN 后仍能复现，下一步应核对 key 所属项目、可调用的 Model ID 和已启用的 IP 白名单。直连生成请求 ID 为 `021794987202034af77c6bdcb28310871ba6ee41ea156a6f709bd`。两份模型查询回执和直连生成回执保存在 `output/image/verification/ark-m0-20261118-direct/`。

`image_generate` / `gif_generate` 当前只有契约，正式执行会返回 `media_generation_not_implemented`。前台、人物配置、正式 skill 和后台任务接入属于后续 M2–M5。本轮没有生成新的言昕动画，也没有改写已确认的人物素材。

## 首次真实 Ark 请求（开通前）

凭据复用仓库外的默认文件 `~/.config/opennova/ark.key`。探针只持久保存凭据指纹，不保存密钥原文；指纹不等于已验证的账号身份。没有进行新的 ChatGPT OAuth 认证。

本轮仅运行一次以下受控命令：

```sh
output/image/runtime/ark-py311/bin/python -m tools.image.ark_probe --live \
  --session-dir output/image/verification/ark-m0-m1-20261118/probe \
  --image-model doubao-seedream-5-5-261028 \
  --video-model doubao-seedance-2-5-260628 \
  --max-requests 2
```

| 项目 | 实际结果 |
| --- | --- |
| Seedream | `doubao-seedream-5-5-261028`，简单圆形参考图编辑，1024×1024 PNG |
| 请求结果 | HTTP 404，`ModelNotOpen`，分类 `permission` |
| 生成请求数 | 1 / 2；提交前已预留预算，失败后停止 |
| Seedance | 未提交，0 次视频生成请求 |
| 模型产物 | 无图片/视频产物；图片、视频能力保持 `unverified` |
| 费用数据 | 服务未返回 usage，保持 unknown/null，不能据此断言零费用 |
| 自动重试/换模型 | 未执行 |

请求 ID：`021794980654582d2ec6088cd57f16be69183642d63bc77936f11`。

原始脱敏回执：`output/image/verification/ark-m0-m1-20261118/live-submit.json`；稳定会话及预算记录：同目录 `probe/`。原始回执中的 `network=not_attempted` 是初版报告沿用离线字段造成的记录缺陷，与实际请求计数冲突；判断真实请求以 `live_requests_sent=1`、operation 的 HTTP 状态和 request ID 为准。保留原始证据，不用再次付费请求修正历史字段。现已修复：当前调用只要尝试 POST/GET（含失败）便记为 `attempted`，并增加 `network_scope=current_invocation`；无请求重放仍为 `not_attempted`。相关回归测试通过。

首次开通前的失败会话保留。开通后的结果见上方复测记录。

官方参考：[Seedream 5.5](https://ark.volcengine.com/region:cn-beijing/docs/seedream-5-5)、[图片生成 API](https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api)、[Seedance 2.5](https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5)、[模型开通管理](https://console.volcengine.com/ark/region%3Acn-beijing/openManagement?LLM=%7B%7D&OpenTokenDrawer=false&tab=LLM)。

## M1 本地验收

验收源是 FFmpeg 生成的合成测试视频，**不是 Seedance 输出**，本地流程没有模型请求。文件保存在 `output/image/verification/ark-m0-m1-20261118/local/`。

| 检查 | 结果 |
| --- | --- |
| CLI `media_export(video_to_gif)` | 成功，320×160，40 帧，每帧 100 ms，总长 4000 ms，10 fps，无限循环 |
| GIF 体积 | 560,048 bytes |
| GIF + 首帧交付包 | 成功；PNG 来自最终 GIF 的第 0 帧，RGBA 精确一致 |
| 同一 operation 重放 | 返回相同回执，无重复转换和覆盖 |
| 模型调用 | 0；回执明确 `sourceKind=synthetic_local_ffmpeg_fixture_not_seedance_output` |
| 视觉验收 | 未进行人物/动作审阅，`visualReview=not_checked` |

证据：`local/acceptance.json`、`local/local_video_export.gif`、`local/local_bundle.gif`、`local/local_bundle_first_frame.png`。最终 GIF SHA-256：`3aaa0efccf0a591513c206deeebc837be09e112c6743016417a74ddd37377114`。

运行环境：macOS arm64，Python 3.11.15，Pillow 13.0.0，FFmpeg / ffprobe 7.1.1。Ark HTTP 使用 Python 标准库；生产依赖不再包含 OpenAI SDK。旧 SDK 探针、依赖锁定及说明作为可选历史回归保留。

保留了冻结输入、无覆盖发布、冲突检查、状态恢复和真实首帧校验。视频转换支持时段/fps/画布/体积限制，受本地协议、超时及解码像素限制；执行器版本指纹包含视频转换代码，只有视频动作才冻结 FFmpeg / ffprobe 文件身份。

## 回归检查

日志位于 `output/image/runtime/`。

- 图片/GIF 最终套件：153 项测试运行，结果 OK，跳过 1 个可选旧 OpenAI SDK 测试类；当前 Ark 环境不安装旧 SDK。最终日志为 `ark-python-remaining.log`；较早的 152 项运行保存在 `ark-image-tests-final.log`。
- Ark 探针离线测试：修正网络回执后 23 项通过；视频转换 19 项、操作恢复 31 项通过，均没有真实 API 调用。
- 首次全库回归：1069 个 Node 测试中 1067 通过，2 个语音启动/控制测试失败，未进入后续 Python 组；两项单独复测均通过。保留日志 `ark-pnpm-test.log` 和 `ark-voice-targeted-recheck.log`，未修改相关语音实现/测试。
- 全库重跑：1069 个 Node 测试全部通过；ASR 26 项通过。语音 Python 组运行 179 项，其中 `test_process.ProcessTests.test_exited_process_pipes_and_cancelled_prefetch_close_before_loop_gc` 因子进程 30 秒超时出现 1 个 error；全库命令退出 1。日志 `ark-pnpm-test-final.log`。因此不将本轮全库回归表述为全部通过。
- 补跑被语音组中断的后续套件：TTS 19、setup 4、video 24、documents 13、image 153 均返回成功（image 含上述可选跳过）；日志 `ark-python-remaining.log`。
- 语音 Python 失败用例独立复测：同一子进程再次在 30 秒超时，1 项运行 / 1 error；日志 `ark-voice-python-targeted-recheck.log`。未修改语音代码/测试，保留为本轮全库回归的未解决项；未重复运行全库。
- `pnpm run build`：通过，`OpenNova build ready`；日志 `ark-pnpm-build.log`。
- `pnpm run doctor`：通过，`sources=true`、`build.ready=true`、Node 24.14.1；日志 `ark-doctor.log`。构建 sourceDigest 为 `24a2e0985e59c7c71050d6bdbd60c22ed0608ff70657ccd184c4d2fc268fa864`。
- 本次变更范围 `git diff --check` 通过；文档相对链接检查通过；新图片工具及 Ark 文档扫描没有发现使用中的 Ark 凭据原文。

原 OpenAI 路线的验收保留在 [历史记录](opennova-image-gif-m0-m1-verification.md)，不作为 Ark 实际生成成功的证据。
