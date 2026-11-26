# 火山方舟操作与费用经验

本文件主要是本项目截至 2026-11-06 的实操记录，迁移整理于 2026-11-13。型号、参数、价格、权限和界面均可能变化；新的付费调用前阅读官方文档与本账号状态，不把历史快照当作永久规则。

## 注册充值与开通

- 火山引擎注册：官网或 `https://signin.volcengine.com/auth/signup`，按页面手机验证。账号管理中完成符合实际主体的个人或企业实名认证。
- 充值路径：费用中心 → 账户总览 → 充值汇款 → 在线充值，按页面选择微信、支付宝或网银。对公汇款从用户自己的控制台获取收款信息。
- 历史官方开通指南的账户余额路径为可用余额达到 200 元；另有满足条件的节省计划或资源包路径，不需要全部购买。新操作按实时校验。充值本身不等于视频生成消费。
- 本项目用企业账号的人像能力。历史指南有免费 Entry 档，50 个素材与 50 个素材组；是否能使用，以当前账号要求为准。不要默认推荐万元级权益。
- 账号、账单、项目和素材必须对应；不能因页面开着就认为已登录，也不替用户虚构企业能力、承诺或认证资料。

## 人像入库 实操成功路径

早期外部生成的人像直接传 Fast 被提示“可能包含真人”。后来企业账号下两张虚拟图成功入库，并使用 asset ID 成功生成。应记录这个状态演变。

1. 打开北京地域方舟视频体验页，进入“我的 → 虚拟人像 → 管理资产”。窄屏可能隐藏“我的”，可展开面板或全屏。不要未经观察反复让用户登录／拉宽。
2. 创建资产组并上传第一张图，完成相应提交；打开组内详情。
3. 添加第二张图，再提交。每一张图都有自己的素材 ID，即使是同一个人物也不能拿另一个文件的 ID 代替。
4. 两张各自显示“已入库”才继续。历史返回中的 Active 可对应审核可用；“上传成功”只是文件上传完成。
5. 请求中引用 `asset://<asset_id>`。素材与 API Key 需同账号同项目。新电脑同账号资产可复用；换账号需重新核对或重新入库。

普通 Ark API Key 不是素材管理接口的 AK/SK。浏览器上传与 API 上传是两条不同路径。真人资料走相应授权与人像审核；不能因为长得真实就把真人资料标为虚拟人。

## 已实测的视频请求

```json
{
  "model": "doubao-seedance-2-0-fast-260128",
  "content": [
    {"type": "text", "text": "与首帧一致的完整提示词"},
    {"type": "image_url", "image_url": {"url": "asset://已审核素材ID"}, "role": "first_frame"}
  ],
  "resolution": "480p",
  "ratio": "9:16",
  "duration": 4,
  "generate_audio": false,
  "watermark": true,
  "return_last_frame": true
}
```

历史基址 `https://ark.cn-beijing.volces.com/api/v3`；创建 `POST /contents/generations/tasks`，查询 `GET /contents/generations/tasks/{id}`。请求头用 `Authorization: Bearer <ARK_API_KEY>`，不把密钥写进共享脚本。纯文生视频不添加假图片引用，使用文本内容即可。

本次 480p 原片实际返回 496×864、24fps，本地成片统一为 480×854、30fps。不要把画质档位等同于固定输出像素，不要不检测就报告规格。

历史 2.5 编辑型号记录为 `doubao-seedance-2-5-260628`，用于原 Fast 源片局部外观编辑。具体输入类型与 URL 条件必须按当前接口核验；不能仅凭名字推断比 Fast 更适合所有任务。

## 提交和重试约定

- 请求与 prompt 先保存，创建前写提交标记，成功后立即保存 task ID。
- `queued`／`running` 继续查询同一任务；`succeeded` 下载并验证；`failed` 记录错误码后判断是否修正。
- 网络超时且没有拿到 ID 属于“结果不确定”，先核对服务端或控制台；不重复创建。
- 同一原因的参数、权限或入库错误没有新信息时不连续重试。修复明确问题后只重提受影响片段，记录新旧任务关系。
- 视频下载失效或中断先重新获取既有结果，不自动重新生成。保留 `.partial` 或临时文件，完整下载后改名。
- 包内 `projects/face_pair_480p_20261105/generate.mjs` 是历史成功任务的参考实现；其中 `task.json` 防止重发，`submission_started.json` 阻止不确定提交重复收费。它不会自动执行。新项目应另建目录和 plan，不能在旧目录覆盖成果。

## 语音支线

用户给过独立语音入口 `https://openspeech.bytedance.com/api/v3/tts/create`，示例模型 `seed-audio-1.0`，鉴权字段为 `X-Api-Key`。这是独立凭证体系，不能把 Ark 视频密钥和语音密钥混用。历史早期鉴权失败与后来 19 镜使用成功语音的记录要区分。

当用户要对话时，按角色和情绪拆句，允许呼吸和短停顿；不要用一整段平直播音腔。语音、视频、口型、字幕分别验证。用户说“只验证”不能扩成完整配音；最近几次静音 Demo 不调用 TTS。新电脑没有带任何历史语音密钥；重新使用时核验当前语音文档、模型与账号。

## 费用核算

按 task ID 去重，优先保存 API 返回的 usage；同一任务多次查询不重复累加。分清请求生成秒数、实际返回时长和剪辑后时长，被剪掉的已生成内容仍可能计费。

历史成功示例：4 秒 40594 tokens + 7 秒 70726 tokens = 111320 tokens。按当期无视频输入单价 37 元／百万 tokens 得 4.11884 元。原视频在本地参与拼接，不会使这两次请求自动变成“有参考视频输入”的价格档。

当前账号账单才是实扣依据。旧折扣、资源包标价、充值余额、API token 数和聊天 token 不能混算。新任务费用表写明模型、输入类型、单价核验日期、实际 usage、估算与实扣状态。

## 官方链接

- 注册：https://docs.volcengine.com/docs/account-related/account-registration-process?lang=zh
- 实名认证：https://docs.volcengine.com/docs/account-related/basic-introduction?lang=zh
- 充值：https://docs.volcengine.com/docs/billing-center/top-up?lang=zh
- 模型开通：https://docs.volcengine.com/docs/ark/seedance-model-activation-usage-and-refund?lang=zh
- 权益：https://docs.volcengine.com/docs/ark/seedance-2-0-purchase-guide?lang=zh
- API Key：https://docs.volcengine.com/docs/ark/manage-api-keys?lang=zh
- 虚拟人像：https://docs.volcengine.com/docs/ark/private-virtual-avatar-library-guide-preview?lang=zh
- 视频 API：https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
- 定价：https://docs.volcengine.com/docs/ark/model-pricing?lang=zh
