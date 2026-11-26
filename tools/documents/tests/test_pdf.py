"""Native PDF executor regression tests; only macOS system Python/Swift needed."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

EXECUTOR = Path(__file__).resolve().parents[1] / "generate_pdf.swift"


def specimen(page="A4", footer=True, header="生成测试 Header"):
    return {
        "schemaVersion": 1,
        "title": "中文研究报告 <>&",
        "subtitle": "Content, tables and natural pagination",
        "layout": {"pageSize": page, "fontPreset": "cjk", "header": header, "footer": footer},
        "blocks": [
            {"type": "heading", "level": 1, "text": "第一节：资料范围"},
            {"type": "paragraph", "text": "Hello, office, affine, ff, ii, ll! <>& \'\" 中文与符号。\n新段行保持完整。"},
            {"type": "list", "ordered": False, "items": ["第一项资料", "第二项数据"]},
            {"type": "list", "ordered": True, "items": ["读取", "保存", "核对"]},
        ],
    }


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swift"), "requires system Swift/PDFKit")
class PDFExecutorTests(unittest.TestCase):
    def invoke(self, spec):
        with tempfile.TemporaryDirectory(prefix="nova-pdf-test-") as directory:
            base = Path(directory)
            source, output = base / "spec.json", base / "result.pdf"
            source.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf8")
            process = subprocess.run(
                ["/usr/bin/swift", str(EXECUTOR), "--spec", str(source), "--output", str(output)],
                capture_output=True, text=True, timeout=120,
            )
            self.assertTrue(process.stdout.strip(), process.stderr)
            receipt = json.loads(process.stdout)
            data = output.read_bytes() if output.exists() else b""
            self.assertEqual(json.loads(source.read_text()), spec, "source changed")
            return process.returncode, receipt, data

    def test_a4_multipage_table_keeps_every_cell_and_header(self):
        spec = specimen()
        spec["blocks"].extend([
            {"type": "table", "columns": ["编号", "说明", "数量"],
             "rows": [[f"R{i:03}", f"第{i}条中文样本说明，可自动换行且保留全部文字。", str(i)] for i in range(1, 73)],
             "summary": ["合计", "72 条", "2628"]},
            {"type": "paragraph", "text": "结束标记 END-72"},
        ])
        code, result, data = self.invoke(spec)
        self.assertEqual(code, 0, result)
        self.assertTrue(data.startswith(b"%PDF-"))
        self.assertGreaterEqual(result["pageCount"], 4)
        self.assertEqual(result["contentValidation"]["tableCells"], 73 * 3)
        self.assertGreaterEqual(result["contentValidation"]["repeatedHeaderCells"], 4 * 3)
        self.assertEqual(result["layoutValidation"]["automatic"]["status"], "passed")
        self.assertEqual(result["layoutValidation"]["visual"]["status"], "not_checked")

    def test_letter_long_paragraph_multiple_tables_without_header_footer(self):
        spec = specimen("Letter", False, "")
        spec["title"] = "第二组独立内容"
        spec["blocks"].extend([
            {"type": "paragraph", "text": "自然分页应当保持全部内容。English sentence with repeated letters: Hello office. " * 70},
            {"type": "heading", "level": 2, "text": "两张不同的表格"},
            {"type": "table", "columns": ["项目", "数值"], "rows": [["A", "12"], ["B", ""], ["C", "31"]]},
            {"type": "table", "columns": ["单列长字段"], "rows": [["长字段自动换行。" * 12], ["最后的记录"]]},
            {"type": "paragraph", "text": "第二组结束 SECOND-END"},
        ])
        code, result, _ = self.invoke(spec)
        self.assertEqual(code, 0, result)
        self.assertGreaterEqual(result["pageCount"], 3)
        self.assertEqual(result["contentValidation"]["tableCells"], 8)

    def test_row_that_cannot_fit_is_explicit_failure(self):
        spec = specimen()
        spec["blocks"] = [{"type": "table", "columns": ["编号", "说明"], "rows": [["R1", "不能静默裁切。" * 1500]]}]
        code, result, _ = self.invoke(spec)
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "table_row_too_tall")

    def test_invalid_table_shape_is_rejected(self):
        spec = specimen()
        spec["blocks"] = [{"type": "table", "columns": ["A", "B"], "rows": [["missing"]]}]
        code, result, data = self.invoke(spec)
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "invalid_document_spec")
        self.assertEqual(data, b"")

    def test_header_overflow_is_not_silently_truncated(self):
        spec = specimen(header="超长页眉" * 90)
        code, result, _ = self.invoke(spec)
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "document_header_too_long")


if __name__ == "__main__":
    unittest.main()
