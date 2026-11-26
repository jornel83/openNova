# A2 Word／PDF 生成工具接入与验收

日期：2026-11-17（Asia/Shanghai）。本轮完成前台 `document_generate`、Word／PDF 固定执行器及 Agent Harness 接入，范围是基础报告的新建。后台注册、已有文档修改、完整引用定位与原生长文读回仍按 [A2 计划](../superpowers/plans/2026-11-16-a2-research-learning.md)推进。

2026-11-18 更新：用户 TC02 的中文临时目录崩溃已修复，并在实际 `a1-demo` Bot 中用原内容复测成功；服务已加载修复。用户随后确认 PDF 实际打开与重新打开补测通过，本批交付没有剩余手动用例。原因、回归、最终 PDF 证据与用户验收见第 8 节。

后续进展：本文是首版新建工具的历史验收。逐条出处现见[第二批验收](opennova-a2-claim-evidence.md)。第三批加入对 Nova 自有 Word／PDF 的分版修订，行为边界和后续工作以 [M3.3 开发计划](../superpowers/plans/2026-11-16-a2-research-learning.md)为准。

## 1. 已交付行为

更新代码并重启 Bot 后，用户可在工作对话中直接要求“把这些内容整理成 Word，保存到项目目录，再生成同内容的 PDF”。文件输入仍是“直接说文件名或路径”和“引用 Nova 已关联的当前文件”两个入口，不增加上传或格式配置流程。

模型用已有 `write` 准备结构化内容，再调用 `document_generate`；Agent Harness 调度仓库内固定执行器。内容文件由模型准备，用户无需编写 JSON 或生成脚本。生成器按统一内容规范生成标题、段落、列表、表格、页眉及页码，支持 A4／Letter，默认中文字体预设。

首版 `expectedTarget` 仅支持 `absent`，只新建；同名目标返回冲突，不覆盖、删除或自动改名。新文件保存完成后才报告成果。若用户仍处于原项目及原对象上下文，当前文件绑定最终 Word／PDF；若用户已切换，不抢占新选择。保存成果不会自动加入长期项目资料。

## 2. 实现与契约

| 位置 | 职责 |
| --- | --- |
| [generator.mjs](../../services/bot/documents/generator.mjs) | 固定项目／请求绑定、内容快照、来源身份校验、二进制提交、幂等与恢复、成果记录和当前文件绑定 |
| [spec.mjs](../../services/bot/documents/spec.mjs) | 严格数据结构、字段与大小限制、规范化、模型工具说明 |
| [runner.mjs](../../services/bot/documents/runner.mjs) | 固定程序和参数、独立子进程、超时／取消、结构化错误解析 |
| [generate_docx.py](../../tools/documents/generate_docx.py) | Python 标准库生成可编辑 OOXML，并重新打开核对正文、表格和部件关系 |
| [generate_pdf.swift](../../tools/documents/generate_pdf.swift) | macOS CoreText/CoreGraphics 分页及 PDFKit 内容／几何核验 |
| [host.mjs](../../services/bot/host.mjs)／[policy.mjs](../../services/bot/policy.mjs) | 前台工具注册、工作场景准入与生成行为说明；未改动上游 Harness |

完整输入示例、限制及命令见 [工具说明](../../tools/documents/README.md)。关键契约为 `format: docx|pdf`、`specPath`、`outputPath`、`expectedTarget: absent`。模型只提供数据，不能在内容规范内嵌入执行代码或指定任意生成程序。日常交流不会暴露此工具。

保存过程先固定规范化内容和来源版本，在目标目录的独立临时位置执行，再从已经核验的字节建立服务自有提交文件，以不覆盖方式原子发布。目标竞态、符号链接、无效输出、取消及超时均有显式结果；提交后才到达的取消保留“文件已经保存”的事实。重复调用返回原记录，重启对已提交但未完成记录的操作按目标哈希对账，不自动重跑不确定生成。

操作记录保留请求、项目、输入与规范化内容哈希、生成器版本／实现哈希、成果路径、SHA、磁盘版本、核验状态。支持核对实际文件读取或网页观察的身份、版本与项目归属；`locator` 仍标为未核实，不能据此声称页码、摘录及结论引用全部正确。

单份 spec 规范化前后均最多 512 KiB，最多 512 块／200,000 字符，表格数据总计最多 2,000 行、每表 12 列，产物最多 64 MiB，子进程默认 120 秒。PDF 表格行无法与表头一起放入一页时显式失败，不截掉内容。命令／脚本存在检查仅是能力探测，实际执行还会验证系统框架、字体及编译环境。

## 3. 核验状态的含义

- `generation`：是否完成生成并实际提交文件。
- `contentValidation`：保存文件的正文与结构是否和输入规范一致；不代替事实判断或任意表格的业务合计计算。
- Word `layoutValidation`：只有页面配置和结构检查，没有运行时渲染器，状态为 `not_checked`。
- PDF `layoutValidation`：实际页面尺寸、文字边界、页码和表格区域等自动几何核验；不等于逐页视觉检查。
- 两种格式的 `layoutValidation.visual.status` 均保持 `not_checked`。本轮独立 QA 的视觉结论仅适用于检查过的样本。

本地核验不调用整份 `document_read`，因此不会把内部预览设为当前文件，也不因已有原生读回超时而重复生成。既有一般预览引用问题和长文读回超时未由本次工作全面解决。

## 4. 真实模型与问题复测

通过隔离的真实 OpenNova `/ask`、生产 Node 24.14.1、当前 `gpt-6.1-sol` 与既有授权验证。准入只允许 `read`、JSON `write` 和 `document_generate`，没有给模型生成脚本、模板或 Codex 文档库；未允许 Bash、桌面应用和后台任务。输入为包含随机标记、正文、列表、24 行明细与独立预期合计 614 的合成资料。

| 轮次 | 观察与结果 |
| --- | --- |
| 首轮，119.6 秒 | 6 次工具调用：read 1、write 2、document_generate 3。模型第一次汇总行列数错误被拒绝，随后自行修正，成功生成 Word 和 3 页 PDF。发现最终对象 `diskStatus=changed`：提交临时硬链接清理改变 ctime，记录版本过早；此项当时未通过。 |
| 修复后真实复测，106.9 秒 | 同为 6 次调用，汇总行错误再次被模型自行修正。两份成果已保存；最终当前文件为 PDF、`diskStatus=unchanged`，两份成果记录的 size／mtime／ctime／inode 与磁盘一致，SHA 匹配。 |
| 后续格式与错误说明收尾 | 为汇总行补充明确的完整列示例及 `document_summary_columns_mismatch`／`errorDetails`；不是另一次真实模型验收。Word 普通记录跨页拆行加入 `w:cantSplit`，使用复测冻结 spec 直接重新生成新样本；原模型产物保持不变，最终 Harness 离线测试和执行器测试重新通过。 |

Word 与 PDF 的实际生成耗时远短于整轮模型请求，但以上两轮包含内容组织和一次参数纠正，不能当作稳定性能基准。模型参数被正确拒绝不计为一次生成成功。

## 5. 独立内容与视觉检查

独立 QA 使用 bundled Python 文档库、LibreOffice 和 PDFium，只用于验收，不是 OpenNova 运行依赖。复用此前已校准的中文字体配置；不使用有 Adobe-GB1 数据路径问题的 bundled Poppler 输出判定产品缺字。

| 样本 | 独立结果 |
| --- | --- |
| 最终 Word：复测冻结 spec，经修复后执行器重新生成 | 4 页，19 项指定文本及全部 24 行明细完整，顺序与合计 614 正确；ZIP/XML、可编辑结构、连续页码和跨页表头通过；普通记录跨页拆行为 0。全部 4 页视觉检查通过。 |
| 复测真实模型 PDF | 3 页，同一资料的文本、24 行明细、合计 614 和结束标记完整；页码、表头、嵌入字体和页面边界通过；全部 3 页视觉检查通过。 |
| 额外长表格 PDF：固定执行器样本 | 72 行、6 页、合计 2628；逐值顺序、连续页码、重复表头与末行完整，全部 6 页视觉检查通过。此项是执行器验收，不冒充额外真实模型调用。 |

复测原 Word 在 T012、T024 两条记录出现跨页拆行，已保留原样本及证据；修复后新样本无该问题。末页内容较少属于自然分页，未用空白页凑页数。页面检查未见中文缺字、正文裁切或重叠；不保证 Word、WPS 及其他系统逐页一致，也未验证复杂图表、修订、公式或超大表格的专业排版。

最终样本 SHA-256：

- Word：`5c34bd1829451f2315593e95b4febfe9daf70987ed1366b977e363a6892eed26`。
- PDF：`e743f2146500e89ce295925e183dd5a6ce9253489cb79f9330a730033885fbc9`。

## 6. 自动回归与构建

全量入口 `scripts/test.mjs` 已通过：**1,066 项 JavaScript + 265 项 Python**；文档执行器测试已纳入该入口。此轮全量运行在 ctime 修复之后、最后汇总行说明及 Word 拆行修复之前。

最后改动后重新执行：

```sh
node --test services/bot/tests/document-generator.test.mjs services/bot/tests/document-spec.test.mjs services/bot/tests/document-generation-runtime.test.mjs
python3 -m unittest discover -s tools/documents/tests -v
node scripts/project.mjs build
node scripts/project.mjs doctor
```

**23 项 JavaScript + 13 项 Python 全部通过，无跳过。** 覆盖真实 Harness 搭配确定性模型 fixture 和真实格式执行器、A4／Letter、多页长表格、内容保留、项目切换、现有目标与竞态、提交前后取消、超时错误回执、快照完整性、重复请求／重启对账，以及执行器错误解析。服务单元测试中的替身文件用于验证保存状态，不能替代上述真实格式和模型证据。

构建成功；doctor 返回 `sources=true`、`build.ready=true`，Node 24.14.1。构建摘要：`9392b8157c98219d34169b351d227a8e38f25e3e64a168dcd6b368a69ed73d12`。没有重启用户正在运行的 Bot；用户下一次加载新代码时需要重启 Bot 服务，启动参数不变。

## 7. 证据与后续

本地证据不作为生产依赖：

- `output/verification/a2-document-tools-20261117/`：全量回归、最终定向回归、Python 测试、build 和 doctor。
- `output/verification/a2-tool-runtime-20261117/`：首轮真实模型请求、工具回执、原始成果及独立核验；`compact-results.json` 保留 ctime 问题。
- 同目录 `followup/`：修复后真实复测，`compact-results.json` 记录最终对象、两份成果磁盘版本／哈希、输入未变及清理状态；原模型文件在 `artifacts/`。
- 同目录 `followup/final-docx/`：冻结 spec 重生成的最终 Word、执行器回执、独立报告和 4 页 PNG；不是第三次模型请求。
- 同目录 `visual-verification.json`：已检查样本、文件哈希、页数和本次视觉结论；保留原回执的未视觉核验状态。

两次真实验证输入均未改变，前后后台任务均为 0；隔离宿主已停止，临时 Bot／工作目录已删除。没有使用真实项目资料或改变音频设备。生成流程只依赖现有系统 Python／Swift，不依赖 Codex 的验证工具。

下一步按计划补 M1 读回范围／超时与一般预览引用边界、M2 精确来源，再完成成果打开／修改冲突和后台工具注册、输入快照继承。前台基础新建已交付，不代表整个 A2 完成。

## 8. 2026-11-18：TC02 中文路径失败修复与实际复测

### 故障证据与修复

用户在「验收-A」生成 `A2-TC02-物资清单.pdf` 时，固定工具在约 183 ms 内返回 `document_generator_failed`，状态 `failed / not_committed`。原失败操作 `document-generate-0f394debf171da656dff1fcae04ef896d8266770` 保留原状；当时未保存最终 PDF。

用失败操作的冻结 spec 进行环境对照：ASCII 临时路径下，同一内容生成 3 页 PDF；`TMPDIR` 含中文时，Swift driver 在执行生成脚本前以 `SIGTRAP` 退出，stdout／stderr 为空。进一步拆分确认：中文 cwd 搭配 ASCII TMPDIR 可以执行，ASCII cwd 搭配中文 TMPDIR 仍崩溃；仅模块缓存含中文则可以执行。因此根因是本机 Swift 对非 ASCII 临时路径的兼容问题，旧 runner 将临时目录放进中文项目下触发了它。此次故障发生在模型完成授权、调用固定工具之后，与前次话题识别授权失败不同。

修复在 `services/bot/documents/runner.mjs`：PDF 编译临时文件和模块缓存改用权限 `0700` 的独立 ASCII 目录，优先系统临时目录，不满足条件时回退 `/private/tmp`。用户的中文项目、内容文件及成品路径保持可用；成品仍经原目标目录 staging 校验及禁止覆盖的原子提交。子进程关闭后清理私有运行目录，覆盖成功、失败、取消和超时强杀。信号崩溃单独记录为 `document_generator_crashed`，错误详情保留安全的退出码／信号，不暴露原始 stderr。

### 自动验证与加载

- 28 项定向 JavaScript 回归、13 项 Python 执行器测试全部通过，无跳过。新增 5 项 runner 测试覆盖中文／空格／emoji 输入输出路径、非 ASCII 系统 TMPDIR、运行目录权限与清理、异常退出、取消及超时强杀。
- 原有真实 Harness 集成测试的项目临时路径也改为含中文和空格，覆盖工具注册、调用、提交与当前文件关联；此前 ASCII 路径测试没有覆盖这次缺陷。
- 构建成功，doctor `build.ready=true`，Node 24.14.1。加载时构建摘要为 `30cd806d12d8597665de5ab8077fdfc9c37c3a2c7a52b6e35045810278cfdbdf`。
- 确认前台空闲、后台活动任务为 0 后重启实际 `a1-demo` Bot。新 runtime 为 `2d03134c-aa83-46b9-9be9-8e8f7ccf8184`；文字就绪，语音连接为 standby、`audioEnabled=false`，未启用麦克风和播放。

验证过程保留了两项环境干扰的记录：首次并行构建删除 Harness lib，造成同时运行的测试模块缺失；构建完成后串行重跑上述 28 项全部通过。其后另一开发任务修改 `tools/image` 源文件令首次构建过期；再次完整构建并确认 doctor 通过后才启动 Bot。本次没有修改构建新鲜度检测，也不把这些中间结果记为产品测试通过。

### 原 TC02 实际复测

通过用户实际 Bot 的 `/ask` 提交请求 `a2-tc02-retest-9308e531-58a1-4fcc-a76b-51531562742e`，要求直接复用原 `.a2-tc02-pdf-spec-20261118.json`，不改写内容、不编写生成脚本、不创建后台任务、不调用整份 `document_read`。真实模型调用一次 `document_generate`，操作 `document-generate-97d901a40e12582c7effacc23b35fdcdb792ea97` 在约 4.1 秒完成，状态 `completed / committed`。

| 核验项 | 结果 |
| --- | --- |
| 原内容一致 | 规范化 spec SHA-256 为 `3d520ed7454ad52695f04c9f9bed61bd0c502b3d4f3949d597550bc96d795952`，与失败操作冻结内容一致；原 JSON 未改动 |
| 实际成品 | `~/Documents/OpenNova-A1-验收/A-代码项目/A2-TC02-物资清单.pdf`，1,361,792 字节，3 页 A4 |
| 成品 SHA-256 | `f5285e1b7f48b826e288d05aa6e710818d282f9be02b7d3af03600b8ca433bd5`；磁盘内容和成果记录匹配 |
| 内容完整性 | 60 条明细逐单元格、逐行顺序匹配；合计 1830；末尾 `A2-PDF-验收结束。` 完整 |
| 独立内容／几何 QA | 11 项检查通过：多页、指定正文、全部明细与汇总、重复表头、连续页码、页眉、无空白页、A4 尺寸、文字不越界等 |
| 逐页视觉 QA | PDFium 2 倍渲染后检查全部 3 页，中文可读，无裁切或重叠；跨页表头、页码、最后一行及合计／结束标记可见 |
| 当前文件 | 已绑定该 PDF，`diskStatus=unchanged`；成果记录的 size／mtime／ctime／inode 与磁盘一致，staging 已清理 |
| 项目与原资料 | 仍为验收-A，项目 revision 43；原 TC01 Word 哈希未变；后台任务总数前后均为 4，活动任务均为 0 |

运行时回执仍如实保留 `layoutValidation.visual.status=not_checked`。上述逐页视觉结论记录在独立 QA 文件中，只适用于此次 SHA 对应的 TC02 成品，不代表工具已具备通用视觉核验能力，也不代表全部 A2 验收完成。

本轮证据目录：`output/verification/a2-pdf-tc02-20261118/`。主要文件为 `environment-isolation.json`、`tmp-vs-cache.json`、`final-regression.log`、`python-tests.log`、`final-build.log`、`final-doctor.json`、`restart.json`、`real-runtime-retest.json`、`final-state.json`，以及 `final-qa/independent-qa.json`、`final-qa/visual-verification.json` 和 3 页 PNG。复测成品已经保存，无需为确认修复再次生成同名文件。

### 用户实际应用打开补测：通过

2026-11-18，用户按本轮剩余手动用例执行后反馈：“PDF 打开补测通过”。验收范围为在验收-A 对话中打开 `A2-TC02-物资清单.pdf`，在本机 PDF 阅读器中确认文件名、翻页和中文显示正常，再关闭文件并通过 Nova 文件卡片的“重新打开”再次打开同一成品。

日志中两次 `document_open` 均为 `dispatched`，路径均指向该 TC02 PDF：

- 对话请求 `ea038b49-5f46-46e8-92c7-9440d824bbd0`，操作 `bf75de15-14b0-4315-bdbf-c3a9d670ba16`。
- 文件卡片直接打开，操作 `2b9c9733-a92d-407d-bc0f-b9915b865797`。

应用确实显示与阅读体验通过的依据是用户反馈；日志只证明两次打开请求已发送，不将 `dispatched` 改写为应用显示证明。与已有生成、内容、几何和逐页视觉结果合并，本批前台文档生成交付的手动验收已结束，无需重复 TC01／TC02 或重新核对表格。整份长 PDF 原生读回、精确引用、已有成果继续修改和后台接入仍为后续开发与验收范围。
