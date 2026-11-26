"""DOCX executor contract tests; Python standard library only."""
import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET

SCRIPT = Path(__file__).resolve().parents[1] / 'generate_docx.py'
module_spec = importlib.util.spec_from_file_location('opennova_docx', SCRIPT)
docx = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(docx)
NS = {'w': docx.W}


def specimen(page='A4'):
    return {'schemaVersion': 1, 'title': '可编辑中文研究报告 <&>', 'subtitle': '保存后的内容核对',
            'layout': {'pageSize': page, 'fontPreset': 'cjk', 'header': '研究报告 & 原始资料', 'footer': True},
            'blocks': [
                {'type': 'heading', 'level': 1, 'text': '方法与样本'},
                {'type': 'paragraph', 'text': '保留 <标签> & "引号"。\n第二行\t制表符\r\n末行。'},
                {'type': 'list', 'ordered': True, 'items': ['读取资料', '核对结果']},
                {'type': 'heading', 'level': 2, 'text': '后续步骤'},
                {'type': 'list', 'ordered': True, 'items': ['重新从一开始', '继续']},
                {'type': 'list', 'ordered': False, 'items': ['要点甲', '要点乙']},
                {'type': 'table', 'columns': ['编号', '说明', '数量'],
                 'rows': [['R001', '含 &、<、> 和中文', '17'], ['R002', '第二项\n换行', '23']],
                 'summary': ['合计', '两项', '40']},
                {'type': 'heading', 'level': 3, 'text': '最终结论'},
                {'type': 'paragraph', 'text': '完整末段 FINAL-2026'}]}


class DocxTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='nova-docx-test-')
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def document(self, data, name='result.docx'):
        path = self.root / name
        receipt = docx.generate(data, path)
        with ZipFile(path) as package:
            parts = {name: ET.fromstring(package.read(name)) for name in package.namelist()}
        return path, receipt, parts

    def test_editable_a4_structure_and_literal_content(self):
        path, receipt, parts = self.document(specimen())
        self.assertGreater(path.stat().st_size, 1000)
        self.assertEqual(receipt['contentValidation']['status'], 'passed')
        self.assertEqual(receipt['layoutValidation']['status'], 'not_checked')
        self.assertNotIn('pageCount', receipt)
        document = parts['word/document.xml']
        paragraphs = document.findall('w:body/w:p', NS)
        texts = [docx.element_text(p) for p in paragraphs]
        self.assertEqual(texts[0], '可编辑中文研究报告 <&>')
        self.assertIn('保留 <标签> & "引号"。\n第二行\t制表符\n末行。', texts)
        self.assertEqual(texts[-1], '完整末段 FINAL-2026')
        self.assertGreater(len(document.findall('.//w:br', NS)), 0)
        self.assertEqual(len(document.findall('.//w:tab', NS)), 1)
        heading_ids = {p.find('w:pPr/w:pStyle', NS).get(f'{{{docx.W}}}val') for p in paragraphs}
        self.assertTrue({'Title', 'Heading1', 'Heading2', 'Heading3'} <= heading_ids)
        rows = document.findall('.//w:tbl/w:tr', NS)
        self.assertEqual([[docx.element_text(c) for c in r.findall('w:tc', NS)] for r in rows],
                         [['编号', '说明', '数量'], ['R001', '含 &、<、> 和中文', '17'],
                          ['R002', '第二项\n换行', '23'], ['合计', '两项', '40']])
        self.assertEqual(len(document.findall('.//w:tblHeader', NS)), 1)
        self.assertEqual(len(document.findall('.//w:trPr/w:cantSplit', NS)), len(rows))
        section = document.find('w:body/w:sectPr', NS)
        self.assertEqual(section.find('w:pgSz', NS).get(f'{{{docx.W}}}w'), '11906')
        self.assertIn('PAGE', parts['word/footer1.xml'].find('.//w:fldSimple', NS).get(f'{{{docx.W}}}instr'))

    def test_each_native_list_restarts_without_manual_number_text(self):
        _, _, parts = self.document(specimen())
        numbering = parts['word/numbering.xml']
        self.assertEqual([n.find('w:lvlOverride/w:startOverride', NS).get(f'{{{docx.W}}}val')
                          for n in numbering.findall('w:num', NS)], ['1', '1', '1'])
        self.assertEqual([n.find('w:lvl/w:numFmt', NS).get(f'{{{docx.W}}}val')
                          for n in numbering.findall('w:abstractNum', NS)], ['decimal', 'decimal', 'bullet'])
        list_paragraphs = [p for p in parts['word/document.xml'].findall('w:body/w:p', NS)
                           if p.find('w:pPr/w:numPr', NS) is not None]
        self.assertEqual([docx.element_text(p) for p in list_paragraphs],
                         ['读取资料', '核对结果', '重新从一开始', '继续', '要点甲', '要点乙'])

    def test_different_letter_report_retains_long_rows_and_no_forced_paging(self):
        data = {'schemaVersion': 1, 'title': 'Second report',
                'layout': {'pageSize': 'Letter', 'fontPreset': 'cjk', 'header': '', 'footer': False},
                'blocks': [{'type': 'paragraph', 'text': '中文长段落，' * 250},
                           {'type': 'table', 'columns': ['Record', '说明'],
                            'rows': [[f'ID-{n:03}', ('跨行长单元格 ' * 80 if n == 20 else f'记录{n}')] for n in range(100)]},
                           {'type': 'paragraph', 'text': 'LAST-ROW-AND-PARAGRAPH'}]}
        _, receipt, parts = self.document(data)
        document = parts['word/document.xml']
        self.assertEqual(receipt['generation']['status'], 'completed')
        self.assertNotIn('word/footer1.xml', parts)
        self.assertEqual(len(document.findall('.//w:tbl/w:tr', NS)), 101)
        self.assertFalse(document.findall('.//w:trHeight', NS))
        self.assertEqual(len(document.findall('.//w:trPr/w:cantSplit', NS)), 101)
        self.assertFalse(document.findall('.//w:noWrap', NS))
        widths = [int(c.get(f'{{{docx.W}}}w')) for c in document.findall('.//w:tblGrid/w:gridCol', NS)]
        self.assertEqual(sum(widths), 9360)
        self.assertEqual(docx.element_text(document.findall('w:body/w:p', NS)[-1]), 'LAST-ROW-AND-PARAGRAPH')

    def test_saved_content_tampering_fails_verification(self):
        data = specimen()
        path, _, _ = self.document(data)
        with ZipFile(path) as archive:
            parts = {name: archive.read(name) for name in archive.namelist()}
        parts['word/document.xml'] = parts['word/document.xml'].replace(b'FINAL-2026', b'LOST-2026')
        with ZipFile(path, 'w') as archive:
            for name, raw in parts.items():
                archive.writestr(name, raw)
        with self.assertRaisesRegex(docx.DocumentError, 'ordered_content_and_table_cells'):
            docx.verify_saved(path, data)

    def test_invalid_structure_and_xml_characters_are_rejected_before_writing(self):
        invalid = []
        for change in [lambda s: s.update(schemaVersion=2),
                       lambda s: s['blocks'].append({'type': 'script', 'text': 'print(1)'}),
                       lambda s: s['blocks'].append({'type': 'paragraph', 'text': 'bad\x00text'}),
                       lambda s: s['blocks'].append({'type': 'table', 'columns': ['A', 'B'], 'rows': [['only one']]}),
                       lambda s: s['blocks'].append({'type': 'heading', 'level': True, 'text': 'Invalid'}),
                       lambda s: s['layout'].update(fontPreset='/untrusted/font')]:
            data = specimen()
            change(data)
            invalid.append(data)
        for index, data in enumerate(invalid):
            with self.subTest(index=index):
                target = self.root / f'invalid-{index}.docx'
                with self.assertRaises(docx.DocumentError):
                    docx.generate(data, target)
                self.assertFalse(target.exists())

    def test_cli_does_not_execute_content_or_overwrite_an_existing_file(self):
        data = specimen()
        sentinel = self.root / 'must-not-exist'
        payload = f"__import__('pathlib').Path({str(sentinel)!r}).write_text('bad'); $(touch {sentinel})"
        data['blocks'].append({'type': 'paragraph', 'text': payload})
        spec = self.root / 'spec.json'
        output = self.root / 'result.docx'
        spec.write_text(json.dumps(data, ensure_ascii=False), encoding='utf8')
        result = subprocess.run([sys.executable, str(SCRIPT), '--spec', str(spec), '--output', str(output)],
                                capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['generation']['status'], 'completed')
        self.assertFalse(sentinel.exists())
        original = output.read_bytes()
        again = subprocess.run([sys.executable, str(SCRIPT), '--spec', str(spec), '--output', str(output)], capture_output=True, text=True)
        self.assertNotEqual(again.returncode, 0)
        self.assertEqual(output.read_bytes(), original)
        with ZipFile(output) as package:
            self.assertIn(payload, docx.element_text(ET.fromstring(package.read('word/document.xml'))))

    def test_generation_is_deterministic_for_identical_normalized_content(self):
        data = specimen()
        first, _, _ = self.document(data, 'one.docx')
        second, _, _ = self.document(copy.deepcopy(data), 'two.docx')
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_twelve_columns_keep_positive_usable_widths(self):
        data = specimen()
        data['blocks'] = [{'type': 'table', 'columns': ['短'] + ['较长的列标题' * 4] * 11,
                          'rows': [['1'] + ['长内容' * 40] * 11]}]
        _, receipt, parts = self.document(data)
        self.assertEqual(receipt['contentValidation']['status'], 'passed')
        widths = [int(c.get(f'{{{docx.W}}}w')) for c in parts['word/document.xml'].findall('.//w:gridCol', NS)]
        self.assertEqual(sum(widths), 9026)
        self.assertGreaterEqual(min(widths), 480)


if __name__ == '__main__':
    unittest.main()
