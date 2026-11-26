# OpenNova 从零生成 Word 与多页 PDF 验证

> 后续进展（2026-11-17）：正式 `document_generate` 已完成前台新建 Word／PDF 的工具封装和 Harness 接入，见 [工具接入与验收](opennova-a2-document-tools.md)。本文保留之前通过通用工具和临时生成脚本获得的原始证据；下文“尚未实现”指该次能力验证时的状态。

验证开始：2026-11-16；独立验收及计划更新：2026-11-17（Asia/Shanghai）。结论：当前 OpenNova 模型和原生工具在本机已能从零生成可编辑 DOCX 与中文多页 PDF；本轮两份原始成品通过独立内容检查和逐页视觉检查，无需修正文档。生成基础可直接复用，成果交付、当前文件绑定和完整读回可靠性仍需 A2 开发。

## 1. 验证方法与环境

- 通过隔离的真实 OpenNova `/ask` 宿主，使用生产 Node 24.14.1、`services/agent/provider.mjs`、当前 `gpt-6.1-sol` 与既有授权。不是 Codex 代替 OpenNova 编写成品，也不是独立 SDK 成功代替产品调用。
- 提供合成 `source.json`、格式与内容要求，未给生成脚本、模板、实现方法或文档库路径；独立预期值留在验证侧。Word 和 PDF 分别从资料生成，PDF 不使用前一轮 Word 成品。
- 模型仅使用现有 `read/write/edit/bash/document_read`。原生工具未替换；临时工作目录配有路径与命令准入保护。模型没有安装依赖、联网下载、操作桌面应用或读取用户真实资料。真实模型请求正常使用网络。
- 保持原 HOME 和授权路径；子进程使用普通系统 PATH，清除外加 Python/Node 库路径。Codex bundled 文档库、LibreOffice、Poppler、PDFium 仅供独立验证，不在被测 OpenNova 的环境中。
- 本机 Python 3.14.4 没有 `python-docx`、`lxml` 或 `reportlab`；系统 Swift、CoreText/CoreGraphics/PDFKit 可用。模型探测到 Pandoc，但没有用它生成 Word。
- 输入含 4 节、12 段中文正文、中英文字、列表、随机校验标记和 72 条合成数据。Word 要求保留正文与前 12 行摘要；PDF 保留正文与全部 72 行。检查标题、末段、末行、逐值顺序、独立求和、分页、中文和表头，避免只凭扩展名或退出码判断成功。

## 2. 实际结果

| 项目 | 从零 Word | 从零多页 PDF |
| --- | --- | --- |
| 实际方法 | 模型编写 Python 标准库 `zipfile` 脚本，构建 OOXML | 模型编写 Swift，使用系统 CoreText/CoreGraphics 排版输出，PDFKit 读回 |
| 自然生成轮 | 252.6 秒，7 次工具调用 | 429.4 秒，15 次工具调用，包含一次 90 秒读回超时及后续自检 |
| 文件 | `research-brief.docx`，7,989 字节 | `research-report.pdf`，6 页 |
| 可编辑结构／内容 | Title、Heading 1/2、原生项目符号和编号列表、可编辑表格、页眉、PAGE 页码域 | 可检索文字层，中文正文、列表、连续页码和跨页表格 |
| 独立内容核对 | 31 项文本契约均通过，12 行逐值及顺序正确，合计 344 | 同 31 项文本契约均通过，72 行逐值及顺序正确，合计 1966 |
| 独立渲染与视觉 | bundled LibreOffice 渲染为 5 页，逐页检查通过 | bundled PDFium 渲染全部 6 页，逐页检查通过 |
| 分页核对 | 1–5 连续页码；表格在第 3 页；无空白页或内容裁切 | 表格跨第 3–6 页，四页均重复表头，末行 R072 和总计完整；1–6 连续页码 |

总计两轮、22 次工具调用：`read` 4、`bash` 7、`write` 5、`document_read` 5、`edit` 1。Word 的 ZIP CRC、XML 和部件关系有效，独立文档库可重新打开；PDF 与 Word 渲染 PDF 均可提取全部指定文字、字体已嵌入、字符无越界。结构检查不等于完整 OOXML schema 认证。

两份成品在首次生成、独立验证和最终保存之间哈希不变，未向模型发起人工修正轮：

- DOCX：`79af423b4f8c5e494e721096e29c2a39cd9d6e84b4b789b701967c60233aaab2`
- PDF：`67c1dcf93e1b7f1309177833eb0e1236b95e7f97274947c154cec982331967e1`

Word 页数是在本轮 LibreOffice 与字体环境下得到的结果，不保证其他应用逐页一致。样本末页较疏，但正文完整、自然分页、无空白页；本轮通过的是基础生成质量，不是专业出版排版认证。

## 3. 暴露的产品边界

1. **生成成功与原生读回成功须分别记录。** Word 的 `document_read` 在 55.5 秒后返回 `partial`：正文可核对，但未能验证实际渲染、字体和样式；本轮由独立结构与渲染补齐。6 页 PDF 的整份原生读取在 90 秒触发 `agent_timeout`，不能算作读取通过。模型仍使用本机 PDFKit 完整核对内容，并对第 1、4、6 页 PNG 原生视觉抽查成功；验证侧另核对全部 6 页。
2. **内部核验会改变当前文件。** 模型读取预览 PNG 后，实际宿主快照的当前对象变成 `pdf-page-06.png`，而非交付 PDF。后续“继续改这份文件”可能指向错误对象。需要区分内部核验文件与用户成果，并在交付时绑定最终成果；不能靠回复里的文件名掩盖实际引用状态。
3. **可生成不等于稳定交付已完成。** 本轮在隔离工作目录输出，尚未完成正式保存位置、成果与项目/资料版本关联、打开回执、修改冲突、重启后接续等端到端交付验收。
4. **范围限于基础中文报告和本机能力。** 未验证 Microsoft Word/WPS 的实际编辑保存、跨系统字体与布局一致性、复杂图表/公式、批注修订、专业模板、原 PDF 原位编辑或任意长度文件。PDF 的当前生成路径依赖 macOS 系统框架，不能由此声称其他执行节点已具备同样能力。

## 4. 独立验证环境校准

验证侧两次渲染问题均保留原失败证据，不能计为生成文件缺陷：

- bundled LibreOffice 默认字体发现未加载本机中文字库，首次渲染缺少中文且页数不正确。仅为验证进程提供 `qa-fonts.conf`，加入系统字体及当前 Font8 目录后，同一 DOCX 正确渲染为 5 页。未修改成品或系统配置，也未使用用户安装的 LibreOffice。
- bundled Poppler 的编译数据目录指向构建机路径，输出 `Missing language pack for 'Adobe-GB1' mapping`，退出码为 0 但 PNG 文字缺失；设置 `POPPLER_DATADIR` 仍未生效。保留失败日志，改用已有 bundled `pypdfium2 5.13.0 / PDFium 153.0.7999.0` 独立渲染，同一 PDF 全部 6 页中文与表格正常。未安装新依赖或修改 PDF。

这些工具仅为本轮独立验收服务。若未来产品采用渲染核验，应单独验证实际安装环境、字体和数据资源，不能隐含依赖 Codex 的工具包。

## 5. 对 A2 开发顺序的调整

2026-11-17 用户进一步确认：把本次可复用流程沉淀为正式工具，避免日常生成时每次重新编写生成器。该决定不改变上述原始验证方法与结果，也不代表工具已经实现。

1. 定义 `document_generate` 契约与结构化内容，补二进制保存、版本/幂等和内部核验不激活当前对象；同步定位原生读回超时，生成工具的本地基础核验不依赖整份模型读回。
2. 依次封装固定 Word 和 PDF 执行器，接入前台 Harness，由模型组织内容并选择调用。生产实现不依赖本证据目录或 Codex bundled 工具。
3. 继续 M2 的来源与版本关联，以及 M3 的成果保存、最终引用、打开和继续修改。
4. 单独接入后台工具与固定输入快照，验收取消恢复、跨项目及重启接续；用更长资料和复杂排版检查可靠范围，遇到实证缺口再评估新增文档库。

工具职责与契约见 [文档生成方案](../superpowers/specs/2026-11-17-a2-document-generation-design.md)，详细任务见 [A2 开发计划](../superpowers/plans/2026-11-16-a2-research-learning.md)。本轮只新增验证证据与更新方案/计划，没有实现以上正式工具及产品修复，也没有重新宣称整个 A2 已完成。

## 6. 证据与清理

证据目录：`output/verification/a2-generation-20261116/`（本地验证产物，不作为生产依赖）。

- 请求、方法与原始工具回执：`generation-probe.mjs`、`generation-report.json`、`generation-tool-trace.jsonl`、`tool-metrics.json`。
- 输入与独立预期：`source.json`、`expected.json`。
- 未修正的成品与模型自检脚本：`natural-artifacts/`；交付副本：`artifacts/`。
- 独立内容与结构：`independent-verify.py`、`independent-final-verification.json`。
- 当前对象边界：`current-object-audit.json`。
- 最终逐页视觉证据：`rendered/docx-fonts/`、`rendered/pdf-pdfium/`、`visual-verification.json`；PDF 复现脚本 `render-pdf-independent.py`。
- 环境校准：`qa-fonts.conf`、`docx-render.log`、`docx-render-fonts.log`、`pdf-render.log`、`pdf-render-cmap.log`；失败渲染另存，未覆盖。

输入 SHA-256 在前后保持 `8f6b003680e80af681f293aaecce71d97e07f3edb4b38b449b33492734f8a3f7`。前后后台任务均为 0；隔离宿主已停止，临时 Bot/工作目录已删除，证据副本保留。未改动生产实现、依赖、用户 Bot 数据或音频设备，因此本轮不重跑与此次文档更新无关的全量回归。
