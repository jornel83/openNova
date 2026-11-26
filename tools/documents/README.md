# Word／PDF 固定生成工具

`document_generate` 已通过 OpenNova 前台工具扩展接入 Agent Harness。模型组织内容并选择格式，Harness 调度工具，仓库内固定执行器负责生成和本地核验。每次生成不需要模型重新编写 Python／Swift 脚本。

更新代码并重启 OpenNova 后，用户可以直接说“把这些内容整理成 Word，保存到项目目录”或“生成包含完整明细的多页 PDF”。用户无需运行生成器。资料输入仍沿用“直接说文件名或路径”和“引用 Nova 已关联的当前文件”两个入口。

前台 Agent 可以新建 Word／PDF，也可以继续修改本项目内 Nova 生成的文档，在同目录另存新版。后台文件研究任务可以使用同一工具新建研究报告。默认交付到任务目录，用户在提交任务时也可以指定新文件的位置。后台采用提交时的资料副本，切换项目前后使用同一版本。详见[后台文件研究](../../docs/research/opennova-a2-background-research.md)。

## 继续修改已有成果

用户可以说「把当前报告的标题改为《活动执行计划》，其他内容不变」。工具按本轮关联的当前文件、成果编号或成品路径定位。必要时先 `{"action":"inspect","current":true}` 查看底稿，再调用：

```json
{"action":"revise","current":true,"patch":{"title":"活动执行计划"}}
```

该操作返回待确认的对照。`path`、`artifactId`、`current:true` 只能择一，格式沿用原件。修改带引用的结论时会重新核对引文。用户可在修改卡上确认或放弃，也可以在后续对话中说“就按这个改”。后续对话通过 `document_proposal_decide` 处理同一修改编号。确认后会在同一目录得到 `活动计划.v2.docx`。重复提交同一决定沿用原回执。

若确认前用户在编辑器里保存过改动，Nova 会核对手改文件，保留旧方案，在可可靠还原时提供基于手改版本的新对照。例如数量已由用户改成 68，原方案建议 75，新卡显示 68 → 75。再次确认才发布新版。文件缺失、版式或批注无法可靠保留时，可恢复或核对文件后重试。正式输出仅可新建，已占用的目标路径会报告冲突。

## 调用契约

模型先用现有 `write` 工具准备 UTF-8 JSON 内容文件，再调用：

```json
{
  "format": "docx",
  "specPath": "report.spec.json",
  "outputPath": "report.docx",
  "expectedTarget": "absent"
}
```

生成 PDF 时使用 `"format": "pdf"` 和以 `.pdf` 结尾的 `outputPath`。一个内容文件可分别用于两次调用。相对路径按本轮冻结的项目工作目录解析，也可使用本机绝对路径；项目、请求和取消信号由宿主提供。

`expectedTarget` 可省略，默认 `absent`。已有目标返回 `document_target_exists`，不会覆盖、删除或自动重命名。替换参数返回 `document_replace_not_supported`；需要另一份成果时按用户要求选择新的输出路径。

可复制的 `report.spec.json`：

```json
{
  "schemaVersion": 1,
  "title": "项目研究简报",
  "subtitle": "样本整理与后续安排",
  "blocks": [
    {"type": "heading", "level": 1, "text": "研究范围"},
    {"type": "paragraph", "text": "本简报整理两组样本，保留中文、数值和后续工作。"},
    {"type": "list", "ordered": false, "items": ["核对原始资料", "保留完整记录"]},
    {"type": "list", "ordered": true, "items": ["整理内容", "生成成果", "检查实际文件"]},
    {
      "type": "table",
      "columns": ["编号", "说明", "数量"],
      "rows": [["A01", "第一组样本", "10"], ["A02", "第二组样本", "12"]],
      "summary": ["合计", "两组样本", "22"]
    },
    {"type": "paragraph", "text": "后续根据真实资料继续补充分析。"}
  ],
  "layout": {
    "pageSize": "A4",
    "fontPreset": "cjk",
    "header": "项目研究简报",
    "footer": true
  },
  "sources": []
}
```

`blocks` 按顺序接受 heading（层级 1–3）、paragraph、list 和 table。所有表格单元格必须为字符串；每行及 `summary` 的单元格数量必须与 `columns` 一致。`summary` 是完整汇总行，不是摘要说明；不需要时省略，表后说明另用 paragraph。工具核对保存内容与输入一致，不替模型判断事实或计算任意表格的合计。

汇总行列数错误返回 `document_summary_columns_mismatch`，`errorDetails` 包含出错字段、期望列数和实际列数。模型应根据回执修改内容数据后重新调用；错误参数被拒绝不等于成功生成。

`layout` 可省略，默认 A4、`cjk` 字体预设、标题页眉和连续页码；`pageSize` 也支持 `Letter`。`header: ""` 关闭页眉，`footer: false` 关闭页码。内容、字体预设和版式字段均按数据处理，不接受任意脚本、Shell 或 OOXML 代码。

`sources` 可省略或为空。已有证据可按 `{sourceId, sha256?, observationId?, locator?}` 引用；宿主核对实际来源及项目归属，保存版本，但具体定位和引文仍标为未核实。无来源的新写作不需要编造来源。

## 实现与运行环境

| 组件 | 实际职责与依赖 |
| --- | --- |
| [生成服务](../../services/bot/documents/generator.mjs) | 固定内容快照，执行生成，核对文件类型/大小/哈希，以二进制方式提交新成果，记录请求与项目归属 |
| [内容规范](../../services/bot/documents/spec.mjs) | 校验并规范化 JSON，统一两种执行器输入 |
| [执行适配](../../services/bot/documents/runner.mjs) | 以固定脚本和独立参数启动子进程，管理执行时限、取消与结果解析 |
| [Word 执行器](generate_docx.py) | Python 3 标准库 ZIP／XML；生成可编辑标题、列表、表格、页眉及页码域，无第三方 Python 库或 Word 应用依赖 |
| [PDF 执行器](generate_pdf.swift) | macOS `/usr/bin/swift`、可工作的 Swift 编译环境及系统 CoreText/CoreGraphics/PDFKit；中文使用系统 Hiragino Sans GB，拉丁字符使用 Helvetica |

Python 按 `/opt/homebrew/bin/python3`、`/usr/local/bin/python3`、`/usr/bin/python3` 顺序探测。命令和脚本存在检查不等于编译环境或字体已完整验收；实际执行器确认运行条件，缺失时返回失败。PDF 当前依赖 macOS；Word 文件指定中文字体，但实际应用可能替换字体，跨 Word/WPS 或跨系统排版一致性未在此工具内保证。

运行不安装第三方生成依赖，不读取 `output/verification/` 中的历史脚本，也不依赖 Codex bundled Python、LibreOffice、PDFium 等独立 QA 工具。PDF 的 Swift 临时运行目录及编译缓存使用独立、私有的 ASCII 系统临时路径，结束后清理；用户项目、内容文件和输出文件仍支持中文路径，成果继续在目标文件系统暂存并原子提交。内部 spec／预览不作为最终当前文件。

## 回执、核验与保存

成功回执包含 `artifact` 的实际路径、格式、大小、SHA、项目与保存版本，以及独立的 `generation`、`contentValidation`、`layoutValidation`。只有完成提交且存在实际成果，才能报告已生成。

- Word 会重新打开保存的 ZIP／XML，核对部件关系、顺序正文、表格单元格、样式、列表和页码字段。没有内置 DOCX 渲染器，`layoutValidation.status` 为 `not_checked`；结构中的页面设置不能证明真实 Word 页数或视觉效果。
- PDF 会通过系统 PDFKit 重新读取成品，核对文字和表格区域、页数、页眉页码、页面尺寸及字符边界。`layoutValidation` 的通过范围是自动几何检查，不等于人工或模型逐页视觉验收。
- 两种格式均返回 `layoutValidation.visual.status = "not_checked"`。独立 QA 的视觉检查结果不能冒充运行时每次生成都已完成的检查。
- 基础核验在本地执行，不强制用 `document_read` 再次读取整份输出。原生长文读回的超时问题另行处理，不因读回失败重复生成已经保存的文件。

生成服务先在临时位置生成和检查，再提交新文件。已有目标、提交前取消或核验失败均不会用半成品覆盖用户文件；重复调用与重启记录用于复用和对账，不自动重跑不确定操作。若文件已经提交后才收到取消，回执保留文件已保存的事实。

仅在原请求与当前选择仍有效时绑定最终 Word／PDF；用户已切换项目或对象时不抢占新选择。保存成果记录不会自动加入长期项目资料。`document_open` 的打开请求回执也不等于正文或版式核验。

## 限额与显式失败

| 项目 | 当前上限 |
| --- | --- |
| spec 文件（规范化前后） | 512 KiB |
| 内容块 | 512 个 |
| 标题、副标题与内容块总长度 | 200,000，按 JavaScript 字符串长度计 |
| 所有表格的数据行合计 | 2,000 行，不含各表列名及可选汇总行 |
| 每张表格 | 12 列 |
| 单个段落／列表项／表格单元格 | 32,768 字符 |
| 每份最终产物 | 64 MiB |
| 生成子进程 | 默认 120 秒 |
| PDF 页面 | 400 页 |

标题最多 500 字符，副标题及章节标题最多 2,000 字符，列名最多 500 字符；单个列表最多 1,000 项，页眉最多 200 字符，来源最多 100 条。超过限制返回错误，不静默截掉正文或记录。

PDF 表格行需要能与重复表头一起放入一页，过高行返回 `table_row_too_tall`；表头过高返回 `table_header_too_tall`。页眉实际换行后超过两行返回 `document_header_too_long`，而不是截断。可按内容需要缩短页眉、将长表格说明改成段落或拆分记录后重新调用。其他不可排版、字体或读回问题也返回实际失败，不冒充已生成。

原生生成进程被信号终止时返回 `document_generator_crashed`，安全诊断包含退出码／信号，不回显原始 stderr 或文档内容。普通非零退出与可识别的结构化排版错误分别保留；取消、超时仍使用对应错误码。

## 开发验证

在工程根目录、项目要求的 Node 24 与可用 Python 环境执行：

```sh
node --test services/bot/tests/document-spec.test.mjs services/bot/tests/document-generator.test.mjs services/bot/tests/document-generation-runtime.test.mjs
python3 -m unittest discover -s tools/documents/tests -v
```

第一组包含 schema、保存状态与真实 Harness 的离线集成；模型使用确定性 fixture，生成器实际运行。Python 测试覆盖两种固定执行器，PDF 测试在非 macOS／缺少 Swift 的环境会跳过。它们不是当前模型通道的真实调用验收，参数错误被正确拒绝也不能记作真实模型生成通过。

完整项目回归使用 `pnpm test`，文档执行器测试已纳入该入口。真实模型调用、独立渲染和用户体验证据另见 [A2 开发计划](../../docs/superpowers/plans/2026-11-16-a2-research-learning.md)及对应验收记录。
