# OpenNova ChatGPT 订阅授权接入验证

更新：2026-10-12。目标模型：`gpt-6.1-sol`。状态：用户已在 Air 完成 OpenNova 独立官方授权；模型目录与真实推理通过，DeepSeek Harness 两轮上下文及 VAD → ASR → Agent → Vivian 文件输入闭环通过。Studio 的独立授权与钥匙串问题仍待解决。

## 1 结论与适用范围

OpenAI 已提供 Sign in with ChatGPT，符合条件的 ChatGPT Plus / Pro 用户可以授权应用使用订阅完成 Responses API 请求，不需要为该路径提供 API Key。身份登录与订阅调用权限分别授权，成功登录并不自动代表获得推理权限。[官方快速入门](https://developers.openai.com/siwc/quickstart)

当前官方文档覆盖开源及本地托管应用，私有客户端存在开放范围限制；付费或远程托管应用需要另行申请。OpenNova 当前个人工作站验证可以按官方流程检查实际资格，不能据此承诺未来商用产品直接继承订阅权限。[适用范围](https://developers.openai.com/siwc/token-sharing-open-source)

当前账号已完成授权、模型目录查询和 GPT-6.1 Sol 真实推理。本次证据来自 OpenNova 的独立注册及实际请求；没有读取或复制 Codex 现有登录凭据。

## 2 本次已执行的验证

| 项目 | 实际结果 |
| --- | --- |
| 执行主机 | 经 `agent-control` 连接 Mac Studio，arm64，Node 24.21.0 |
| 官方组件 | Sign in with ChatGPT DevKit，固定提交 `0a36fefeb913055c8c7a1a29b63d82b96b2e841a`；仅安装本地 SDK 所需依赖 |
| 构建与自检 | `@siwc/local` 构建成功；本地 SDK 的 57 项测试全部通过。自检不代表真实账号已授权 |
| 授权发现服务 | Studio 请求 OpenAI OIDC 配置返回 HTTP 200，issuer 与授权地址匹配官方来源 |
| 公共 API 连通性 | 未携带凭据请求模型目录返回 HTTP 401；仅说明已到达服务，不能证明模型权限 |
| Studio 凭据存储 | macOS Keychain 返回 `-25308`，当前 SSH 执行上下文不允许所需交互；未绕过系统存储保护 |
| Air 独立验证准备 | 同一提交的官方 SDK 构建通过；Keychain 加密往返与篡改拒绝检查通过；Node 22.23.1 |
| 真实账号授权 | 用户在 Air 官方页面完成授权；独立客户端状态为 `connected`、`sharing=true` |
| 可用模型目录 | 当前账号可见 `gpt-6.1-sol` |
| 真实推理 | 完整收到 `response.completed`，返回 `OpenNova subscription verification OK`；首个文本增量 3.250 秒、完成 3.254 秒 |
| Harness 接入 | 自有模型插件通过官方 DevKit 调用；真实两轮对话共用一个会话，第二轮正确回忆“蓝色水滴” |
| 完整语音文件测试 | Silero → 豆包 → Harness / GPT → Studio Vivian 1.5 倍速通过；真人麦克风连续对话仍需现场试用 |

临时验证程序放在 Studio `~/AgentWorkstation/tmp/opennova-siwc-probe/`，官方源码放在同级 `opennova-siwc-devkit/`。这些程序用于可行性验证，不是生产接入实现。新凭据计划保存在 Studio `~/AgentWorkstation/config/opennova/siwc/`，由本机 Keychain 保护的密钥加密；凭据、原始登录回调和运行日志均不进入 Git。

Air 初始探针位于 `/tmp/opennova-siwc-probe/`，本次独立登录状态保存在 `~/.config/opennova-siwc-probe/`，使用本机 Keychain 保护。正式 Demo 已将 SDK 放到 `~/.local/share/opennova/siwc-devkit/`，加密辅助程序放到同目录体系的 `bin/siwc-keychain`，不依赖临时目录运行。继续沿用同一个 OpenNova 注册与受保护凭据；Studio 需完成自身的授权和推理验证。

可重复启动的授权入口、模型插件和 Harness 桥接程序见 [Agent 运行说明](../../services/agent/README.md)。已关闭本次临时授权进程；后续失效时可运行 `node services/agent/authorize.mjs` 重新登录。

## 3 完整验证步骤

1. 使验证主机的安全凭据存储可用。Studio 需本机处理钥匙串交互；也可先在 Air 独立验证账号资格，之后为 Studio 单独授权，不跨设备复制登录凭据。
2. 为 OpenNova 保存稳定的主机 ID，启动回环回调服务，再打开官方授权页。使用 OAuth PKCE、state、nonce，并验证返回的 ID Token 和订阅调用权限。
3. 使用本次授权获得的访问令牌请求 `GET https://api.openai.com/v1/models`，检查可见模型中是否包含 `gpt-6.1-sol`；不替换成其他模型来报告成功。
4. 向 `POST https://api.openai.com/v1/responses` 发送一句无项目数据的测试文本，设置 `store: false`、`stream: true`，记录完整结束事件、返回文字及延迟。失败则只记录脱敏错误码和失败阶段。
5. 基础验证成功后再开发 Harness 适配，追加工具调用与回传、图片输入、令牌刷新和配额错误验证。

Studio 授权时，Air 可通过 SSH 回环端口转发访问 Studio 的授权入口和回调；授权码由 Studio 兑换，令牌无需跨设备转移。本次 Studio 临时转发已停止，当前入口与回调直接运行于 Air。临时端口为 14555（OAuth 回调）、14556（验证入口），均仅绑定 `127.0.0.1`；授权有十分钟有效期，结束验证后关闭临时监听。

官方依据：[登录与存储](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型发现与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。

## 4 对 DeepSeek Harness 接入的影响

Harness 选型继续采用 DeepSeek Harness。需要在模型适配层加入 OpenNova 自己的 ChatGPT 授权、受保护存储、刷新与错误处理，并将获得的令牌用于官方 Responses 接口。不能仅设置模型名称便假定已支持订阅登录。

订阅路径的请求约束与普通 API Key 路径分别处理：HTTP 请求使用流式返回、不存储响应、完整传入本轮需要的历史；不依赖 `previous_response_id`。工具按当前官方支持的 namespace / `additional_tools` 形式适配，工具执行仍由 Harness 承担。[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

本次已验证文字模型调用、Harness 多轮上下文和文件输入语音闭环。当前适配只支持文字，明确关闭执行工具并拒绝图片输入；图片、工具回传、长期运行和配额恢复仍需独立验证。

## 5 额度与恢复

订阅调用受账号资格、应用授权和订阅额度限制。Plus 用户的五小时额度由应用共享，不能按每个应用各有一份计算；具体用量和应用限制在 ChatGPT 设置中查看。[账号与用量](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

遇到资格不足、权限拒绝或用量限制时，保留明确的错误状态，不自动切换为付费 API Key。令牌刷新失败按官方错误类型处理，不重复注册客户端或循环登录来规避限制。[错误处理](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
