# OpenNova 文件能力验证

日期：2026-11-16；生成验证补充：2026-11-17。目的：区分 GPT 现有能力、当前授权通道支持、OpenNova 正式入口与工具实际行为，再确定 A2 开发范围。本文第 1–5 节保留接入前的能力验证基线；后续前台接入已完成，实装与新一轮证据见 [A2 文件入口接入](opennova-a2-native-file-entry.md)。从零 Word 与多页 PDF 的新增实测见第 6 节。

## 1. 方法与证据边界

- 使用当前 `gpt-6.1-sol`、`services/agent/chatgpt.mjs` 与已有 SIWC 授权；没有切换账号、重新登录或修改生产 adapter。
- 只发送自行生成的合成资料，不上传用户项目文件。测试提示只给问题和对应附件；答案清单留在本地断言，随机标记不预先放入附件请求的提示中。
- 独立直传探针调用实际 SDK `streamItems`；正式工具探针使用真实 Harness、当前 provider 和临时 Bot/工作目录。两条路径分别记录，不把 SDK 成功当作现有聊天界面已经接通附件。
- 样本含三页中英文字 PDF、无文字层的扫描 PDF、PNG、DOCX、XLSX，以及 TXT、Markdown、JSON、CSV。文字 PDF 含跨页标记与表格，扫描页含文字、数值和条形图。PDF 已渲染目视核对；中文字体已嵌入。
- Codex 的 bundled Python 仅用于制作和核对样本。OpenNova 工具测试排除该运行时，固定日常系统 PATH，不安装解析依赖。测试样本制作能力不计为 OpenNova 自有能力。
- 样本于 11 月 15 日准备，11 月 16 日恢复执行；保留原证据目录 `output/verification/a2-capability-20261115/`。

## 2. 同一授权通道直接输入附件

| 输入 | 真实结果 | 已验证范围 |
| --- | --- | --- |
| 文本对照 | 通过 | 回传随机标记和计算结果，确认通道可用 |
| 三页文字 PDF | 通过 | 中文项目名、表格最优项及对应数值、第三页标记、证据页码 |
| 纯图片 PDF | 通过 | 图片文字、随机标记、数量计算及图表数值；样本没有隐藏文字层 |
| PNG | 通过 | 同一图像内的文字、数量和图表内容 |
| DOCX | 通过 | 正文与简单表格中的字段 |
| XLSX | 通过 | 工作表单元格与按源数据计算合计；不等同运行完整电子表格计算引擎 |

首轮在 Node 22.23.1 下使用同一 SDK/授权完成 6 个请求，32/32 字段断言通过。随后使用生产要求的 Node 24.14.1，对文字 PDF 与扫描 PDF 各复测一次，15/15 断言通过。合计 **8 个真实请求、47/47 字段断言通过**；均 HTTP 200、正常完成，返回模型均为 `gpt-6.1-sol`，没有重试。PNG、DOCX、XLSX 的独立直传结果保留其 Node 22 测试范围，不能写成所有格式都已通过生产 Node 24 入口验收。

PDF、DOCX、XLSX 使用 `input_file` 的 data URI，PNG 使用 `input_image`。没有遇到编码错误，因此未继续尝试 raw base64。服务端未提供的 request ID 保留为空。请求不携带 `previous_response_id`，SDK 使用 `store:false`；没有 mock 或本地答案缓存，不对服务端内部缓存作推断。

证据：`channel-results.json`、`channel-node24-confirmation.json`、`channel-probe.mjs`、`fixture-manifest.json`。这些结果证明该通道支持所测附件及内容理解，未证明任意大文件、复杂排版、所有公式或格式保真编辑均可用；本轮未验证公开 URL、上传 file ID 或模型直接返回二进制成品文件。

## 3. OpenNova 正式工具链

已完成的文字轮使用原生 `read/write/edit`，先分别读取 TXT、Markdown、JSON 和 CSV，再写出新 Markdown、定向修改状态并读回。8 次真实工具调用成功，随机标记和两个合计正确，原样本未修改。

原生 `read` 对 PDF、DOCX、XLSX 返回 `FS_NOT_TEXT / binary file`，这是文本工具的边界。`document_open` 只发送打开请求，也不返回这些文件的正文。模型仍可能通过已有 `bash` 调用系统工具读取或生成文件；这条路径须按真实执行结果单独记载。

校准后的真实工具结果如下。四轮均使用 Node 24.14.1、当前生产 provider 与原生工具，共 31 次工具调用；包含上述文字轮的 8 次调用。

| 用例 | 已执行及核对结果 | 边界 |
| --- | --- | --- |
| 文本读写与编辑 | 39.4 秒，8 次工具；四种文本输入→新 Markdown→定向 edit→read 回核对通过 | 已有能力，直接复用 |
| 文字 PDF 工具读取 | 56.9 秒，8 次工具；`read` 返回二进制后，模型自行编写 Swift 脚本，用系统 PDFKit 提取三页；8 个字段含中文和页码全部匹配 | 未预先提供 PDFKit API 解法，但测试明确要求尝试已有系统工具；这是临时脚本路径可行，不保证任意自然提问都会自动选到同一路径 |
| DOCX/XLSX 读取及定向修改 | 79.8 秒，6 次工具；Python 标准库 ZIP/XML 读取字段，分别修改指定段落和单元格，重新提取核对通过 | 未使用 Office 应用或复杂编辑库，不宣称排版、图表、宏、外链及公式引擎全部可用 |
| PDF 生成与读回 | 63.0 秒，9 次工具；系统 CoreGraphics/CoreText 生成一页 PDF，PDFKit 读回标题与随机标记成功 | 简单文本 PDF 导出；未验证对任意原 PDF 的原位修改或复杂布局保真 |

Office 修改独立核验确认：DOCX 仅 `word/document.xml` 中的目标文本改变；XLSX 仅 `xl/worksheets/sheet1.xml` 中的目标数值改变，其余 ZIP 成员逐字节一致，CRC/XML 有效，公式 `SUM(B3:B4)` 保留。验证侧另用 bundled 文档库重新打开输出，目标段落、单元格、未改表格及公式均正确；这些库没有提供给被测 OpenNova。生成 PDF 也经独立提取、渲染目视核对，标题和标记可见。未执行 Word/Excel 实际打开或公式引擎重算。

现有清洁系统环境没有 pdftotext、mutool 及所探测的常见 Python PDF 库；模型使用系统 Swift/PDFKit 和 Python 标准库完成工作，没有安装依赖。真实模型调用使用网络，测试 Shell 未联网下载、访问用户资料或修改生产文件。样本输入哈希保持一致，无后台任务；临时宿主、目录及子进程均已清理。

探针曾有两类本地校准失败：临时 HOME 导致授权路径变化，以及包装命令时试图修改冻结工具参数；另有初始沙箱 smoke 未通过。均保留记录，不计作模型或文档能力失败。首次成功的文字轮保留原证据，修复探针后仅复测受影响的三轮。最终原生 `bash` 没有被替换为自制解析器或参数改写器，工具保护仅作路径/命令准入与记录。

证据：`harness-probe-report.json`、`harness-tool-trace.jsonl`、`harness-first-run-report.json`、`harness-first-run-tool-trace.jsonl`、`harness-office-independent-verification.json`、`artifact-independent-check.json`、`harness-artifacts/` 和 `rendered/`。本轮不重跑 A1 全量回归，生产实现未修改。

## 4. 接入前产品入口的限制（基线）

1. `services/agent/provider.mjs` 当前仅声明文本输入；`provider-core.mjs` 和 `responses-protocol.mjs` 拒绝非文本内容块。四项离线检查均返回 `unsupported_content`。
2. `/ask` 当前提交文本，工作文件 context 被序列化为文本引用。知道路径不等于该文件已作为附件送入模型。
3. Harness 的 `FileBlock` 被消息组装层转换为文件名、大小和只读路径句柄；当前契约不会将它原样传给 provider。因此只修改 adapter 的类型检查或模态声明不足以完成接入。
4. 输入内容、工具结果、历史回放和原生摘要换段都要保持附件的身份及版本。附件传递方式需要与当前 Harness 契约共同验证，不能把独立 SDK 探针替代这一工作。

关键代码：`services/bot/controls.mjs`、`services/bot/desktop/tools.mjs`、`services/agent/provider.mjs`、`services/agent/responses-protocol.mjs`；上游只读核对位置为 `engine/harness/packages/llm/llm/src/types.ts`、`content.ts`、`index.ts`。本轮未修改这些生产文件。

该限制在后续实现中通过 `document_read` 的独立原生只读调用解决：主 provider 保持文本声明，主会话接收有来源工具结果，不直接透传 Harness FileBlock。

## 5. 对 A2 计划的影响

- GPT 的理解、讲解、归纳、比较和撰写直接复用；已有文本文件工具不重建。
- PDF 及简单 Office 文件也能通过现有 Shell 和本机系统工具完成读写样本，不能再将其笼统列为“模型/Agent 完全不会”。这些临时脚本路径保留为可用基础，产品接入改善的是一致性、可预期性和证据关联。
- 已验证原生附件可用，优先接通文件定位、实际内容传递和消息组装，不预先建设专用 PDF 解析/OCR 框架。2026-11-16 用户确认文件入口仅保留“直接说文件名或路径”和“引用 Nova 已关联的当前文件”；选择/拖拽上传和从项目资料选用不作为新增对话入口。该交互决定不改变上述底层 `input_file` 实测结论。
- 扫描 PDF 与基础 Office 读取已有通道证据，可纳入接入设计；复杂 Office 编辑、公式重算、布局保真及通用撤销仍需独立验收，不能由读取成功推导。
- A2 的新增工作集中于：实际入口可用、项目/版本绑定、可回查引用、成果实际保存与接续，以及失败和长文件边界。

具体顺序见 [A2 开发计划](../superpowers/plans/2026-11-16-a2-research-learning.md)。

## 6. 从零 Word 与多页 PDF 补充验证

2026-11-16 至 17 日，使用当前生产 Node 24、真实 OpenNova `/ask`、同一模型和原生工具，从合成资料分别创建全新 DOCX 与 6 页中文 PDF。没有模板、安装依赖或向被测模型提供 Codex bundled 文档工具。Word 实际使用 Python 标准库构造 OOXML；PDF 使用系统 Swift/CoreText/CoreGraphics 生成。

独立验收确认：Word 可重新打开，标题层级、原生列表、可编辑表格、页眉和页码域齐全，渲染为 5 页；PDF 文字可检索，跨页表格重复表头、页码连续。两份文件均完整保留 31 项文本契约，Word 的 12 行及合计 344、PDF 的 72 行及合计 1966 均正确，全部页面视觉检查通过。原始产物未修正。

这扩展了第 3 节的一页 PDF／Office 局部修改基线，证明基础生成可直接复用。不能据此宣称正式导出闭环已完成：Word 原生读回只覆盖内容、返回 partial；整份 PDF 的 `document_read` 曾 90 秒超时，独立本地验证成功；内部预览读取还会把当前对象切为 PNG。A2 因而优先补读回边界、最终成果绑定、来源与保存接续，而不新建通用生成引擎。具体方法、验证环境校准、成品证据与限制见 [文档生成验证](opennova-document-generation-verification.md)。
