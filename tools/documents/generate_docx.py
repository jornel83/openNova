#!/usr/bin/env python3
"""Generate and structurally verify an editable DOCX with Python's stdlib.

This is a fixed renderer for document_generate's versioned JSON data. It does
not execute document content, load templates, or require a desktop application.
"""
import argparse
import hashlib
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

GENERATOR_VERSION = "docx-1"
MAX_SPEC_BYTES = 512 * 1024
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
NS = {"w": W, "r": R}
PAGES = {"A4": (11906, 16838), "Letter": (12240, 15840)}


class DocumentError(ValueError):
    pass


def require(condition, message="invalid_document_spec"):
    if not condition:
        raise DocumentError(message)


def normalized_text(value):
    return value.replace("\r\n", "\n").replace("\r", "\n")


def checked_text(value, limit=32768, nonempty=False):
    require(isinstance(value, str) and len(value) <= limit)
    require(not nonempty or bool(value.strip()))
    require(all(c in "\t\n\r" or 0x20 <= ord(c) <= 0xD7FF or
                0xE000 <= ord(c) <= 0xFFFD or 0x10000 <= ord(c) <= 0x10FFFF
                for c in value), "invalid_document_character")
    return normalized_text(value)


def validate_spec(data):
    require(isinstance(data, dict))
    require(set(data) <= {"schemaVersion", "title", "subtitle", "blocks", "layout", "sources"})
    require(type(data.get("schemaVersion")) is int and data["schemaVersion"] == 1)
    checked_text(data.get("title"), 512, True)
    if "subtitle" in data:
        checked_text(data["subtitle"], 2000)
    require(isinstance(data.get("blocks"), list) and len(data["blocks"]) <= 512)
    layout = data.get("layout")
    require(isinstance(layout, dict) and set(layout) == {"pageSize", "fontPreset", "header", "footer"})
    require(layout["pageSize"] in PAGES and layout["fontPreset"] == "cjk")
    checked_text(layout["header"], 512)
    require(type(layout["footer"]) is bool)
    if "sources" in data:
        require(isinstance(data["sources"], list))
    total_rows = 0
    for block in data["blocks"]:
        require(isinstance(block, dict))
        kind = block.get("type")
        if kind == "paragraph":
            require(set(block) == {"type", "text"})
            checked_text(block["text"])
        elif kind == "heading":
            require(set(block) == {"type", "text", "level"})
            require(type(block["level"]) is int and 1 <= block["level"] <= 3)
            checked_text(block["text"], 2000, True)
        elif kind == "list":
            require(set(block) == {"type", "ordered", "items"})
            require(type(block["ordered"]) is bool)
            require(isinstance(block["items"], list) and 1 <= len(block["items"]) <= 2000)
            for item in block["items"]:
                checked_text(item)
        elif kind == "table":
            require({"type", "columns", "rows"} <= set(block) <= {"type", "columns", "rows", "summary"})
            columns = block["columns"]
            require(isinstance(columns, list) and 1 <= len(columns) <= 12)
            for value in columns:
                checked_text(value, 512)
            require(isinstance(block["rows"], list))
            total_rows += len(block["rows"])
            require(total_rows <= 2000, "document_resource_limit")
            rows = block["rows"] + ([block["summary"]] if "summary" in block else [])
            for row in rows:
                require(isinstance(row, list) and len(row) == len(columns))
                for value in row:
                    checked_text(value)
        else:
            raise DocumentError("unsupported_document_block")
    require(sum(len(value) for value in all_content_text(data)) <= 200000, "document_resource_limit")
    return data


def all_content_text(data):
    values = [data["title"]]
    if "subtitle" in data:
        values.append(data["subtitle"])
    for block in data["blocks"]:
        if block["type"] in {"heading", "paragraph"}:
            values.append(block["text"])
        elif block["type"] == "list":
            values.extend(block["items"])
        else:
            values.extend(block["columns"])
            for row in block["rows"]:
                values.extend(row)
            values.extend(block.get("summary", []))
    return values


def run(value, bold=False):
    # OOXML represents tabs and newlines as elements, not literal XML spacing.
    items = re.split(r"([\n\t])", normalized_text(value))
    payload = "".join('<w:br/>' if s == "\n" else '<w:tab/>' if s == "\t" else
                      '<w:t xml:space="preserve">' + escape(s) + '</w:t>' for s in items)
    return '<w:r>' + ('<w:rPr><w:b/></w:rPr>' if bold else '') + payload + '</w:r>'


def paragraph(value, style="Normal", properties="", bold=False):
    return f'<w:p><w:pPr><w:pStyle w:val="{style}"/>{properties}</w:pPr>{run(value, bold)}</w:p>'


def styles():
    result = ('<w:docDefaults><w:rPrDefault><w:rPr>'
              '<w:rFonts w:ascii="Helvetica" w:hAnsi="Helvetica" w:eastAsia="Hiragino Sans GB"/>'
              '<w:color w:val="000000"/><w:sz w:val="23"/><w:szCs w:val="23"/>'
              '<w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>'
              '<w:pPrDefault><w:pPr><w:widowControl/>'
              '<w:spacing w:after="140" w:line="300" w:lineRule="auto"/>'
              '</w:pPr></w:pPrDefault></w:docDefaults>')

    def style(sid, name, properties="", formatting="", default=False):
        return (f'<w:style w:type="paragraph" w:styleId="{sid}"' + (' w:default="1"' if default else '') +
                f'><w:name w:val="{name}"/>' + ('' if default else '<w:basedOn w:val="Normal"/>') +
                '<w:next w:val="Normal"/><w:qFormat/>' +
                f'<w:pPr>{properties}</w:pPr><w:rPr>{formatting}</w:rPr></w:style>')

    result += style('Normal', 'Normal', default=True)
    result += style('Title', 'Title', '<w:keepNext/><w:spacing w:after="180"/>', '<w:b/><w:sz w:val="40"/>')
    result += style('Subtitle', 'Subtitle', '<w:keepNext/><w:spacing w:after="160"/>', '<w:sz w:val="26"/>')
    for level, size in [(1, 30), (2, 26), (3, 24)]:
        result += style(f'Heading{level}', f'heading {level}',
                        '<w:keepNext/><w:keepLines/><w:spacing w:before="220" w:after="100"/>' +
                        f'<w:outlineLvl w:val="{level - 1}"/>', f'<w:b/><w:sz w:val="{size}"/>')
    result += style('ListParagraph', 'List Paragraph', '<w:spacing w:after="70"/>')
    result += style('TableText', 'Table Text', '<w:spacing w:before="0" w:after="0" w:line="276" w:lineRule="auto"/>', '<w:sz w:val="22"/>')
    result += style('Header', 'header', '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', '<w:sz w:val="18"/>')
    result += style('Footer', 'footer', '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/>', '<w:sz w:val="18"/>')
    return XML + f'<w:styles xmlns:w="{W}">{result}</w:styles>'


def numbering(lists):
    abstract, instances = [], []
    for identifier, ordered in lists:
        fmt, label = ('decimal', '%1.') if ordered else ('bullet', '•')
        abstract.append(f'<w:abstractNum w:abstractNumId="{identifier}"><w:multiLevelType w:val="singleLevel"/>'
                        '<w:lvl w:ilvl="0"><w:start w:val="1"/>' +
                        f'<w:numFmt w:val="{fmt}"/><w:lvlText w:val="{label}"/><w:lvlJc w:val="left"/>'
                        '<w:pPr><w:tabs><w:tab w:val="num" w:pos="420"/></w:tabs>'
                        '<w:ind w:left="420" w:hanging="300"/></w:pPr></w:lvl></w:abstractNum>')
        instances.append(f'<w:num w:numId="{identifier}"><w:abstractNumId w:val="{identifier}"/>'
                         '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>')
    return XML + f'<w:numbering xmlns:w="{W}">' + ''.join(abstract + instances) + '</w:numbering>'


def table_widths(block, total):
    rows = [block["columns"]] + block["rows"] + ([block["summary"]] if "summary" in block else [])
    # A bounded content-based width allocation, with enough room for every column.
    def length(value):
        return max((sum(2 if ord(c) > 255 else 1 for c in line) for line in value.splitlines()), default=0)
    weights = [max(6, min(34, max(length(row[index]) for row in rows))) for index in range(len(block["columns"]))]
    minimum = 480  # cell padding plus at least one full-width 11pt character
    remaining = total - minimum * len(weights)
    widths = [minimum + int(remaining * weight / sum(weights)) for weight in weights]
    widths[-1] += total - sum(widths)
    return widths


def table(block, width):
    widths = table_widths(block, width)
    borders = ''.join(f'<w:{side} w:val="single" w:sz="4" w:color="999999"/>' for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'))
    result = (f'<w:tbl><w:tblPr><w:tblW w:w="{width}" w:type="dxa"/>'
              f'<w:tblBorders>{borders}</w:tblBorders><w:tblLayout w:type="fixed"/>'
              '<w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>'
              '<w:bottom w:w="90" w:type="dxa"/><w:right w:w="100" w:type="dxa"/>'
              '</w:tblCellMar></w:tblPr><w:tblGrid>' +
              ''.join(f'<w:gridCol w:w="{column}"/>' for column in widths) + '</w:tblGrid>')
    rows = [block["columns"]] + block["rows"] + ([block["summary"]] if "summary" in block else [])
    for index, row in enumerate(rows):
        # Keep ordinary records together when a page has insufficient room;
        # otherwise a continuation page may show description text without its
        # identifier. No exact heights/noWrap clip content. Rows taller than a
        # complete page remain subject to the consuming application's layout.
        result += '<w:tr><w:trPr><w:cantSplit/>' + ('<w:tblHeader/>' if index == 0 else '') + '</w:trPr>'
        for value, column_width in zip(row, widths):
            result += f'<w:tc><w:tcPr><w:tcW w:w="{column_width}" w:type="dxa"/>'
            if index == 0:
                result += '<w:shd w:val="clear" w:fill="EEEEEE"/>'
            result += '</w:tcPr>'
            alignment = '<w:jc w:val="right"/>' if index and re.fullmatch(r'[-+]?\d+(?:[.,]\d+)*%?', value) else ''
            result += paragraph(value, 'TableText', alignment, index == 0 or 'summary' in block and index == len(rows) - 1)
            result += '</w:tc>'
        result += '</w:tr>'
    return result + '</w:tbl>'


def build_parts(data):
    page_width, page_height = PAGES[data['layout']['pageSize']]
    body = paragraph(data['title'], 'Title')
    if 'subtitle' in data:
        body += paragraph(data['subtitle'], 'Subtitle')
    lists = []
    for block in data['blocks']:
        kind = block['type']
        if kind in {'paragraph', 'heading'}:
            body += paragraph(block['text'], 'Normal' if kind == 'paragraph' else f'Heading{block["level"]}')
        elif kind == 'list':
            identifier = len(lists) + 1
            lists.append((identifier, block['ordered']))
            props = f'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{identifier}"/></w:numPr>'
            body += ''.join(paragraph(item, 'ListParagraph', props) for item in block['items'])
        else:
            body += table(block, page_width - 2880)
    footer = data['layout']['footer']
    body += ('<w:sectPr><w:headerReference w:type="default" r:id="rId4"/>' +
             ('<w:footerReference w:type="default" r:id="rId5"/>' if footer else '') +
             f'<w:pgSz w:w="{page_width}" w:h="{page_height}" w:orient="portrait"/>'
             '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="600" w:footer="600"/>'
             '</w:sectPr>')
    parts = {'word/document.xml': XML + f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}</w:body></w:document>',
             'word/styles.xml': styles(), 'word/numbering.xml': numbering(lists),
             'word/header1.xml': XML + f'<w:hdr xmlns:w="{W}">' + paragraph(data['layout']['header'], 'Header') + '</w:hdr>',
             'word/settings.xml': XML + f'<w:settings xmlns:w="{W}"><w:updateFields w:val="true"/>'
                '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>'
                '</w:compat></w:settings>'}
    if footer:
        parts['word/footer1.xml'] = (XML + f'<w:ftr xmlns:w="{W}"><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>' +
                                    run('第 ') + '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>' +
                                    run(' 页') + '</w:p></w:ftr>')
    relationships = [(1, 'styles', 'styles.xml'), (2, 'numbering', 'numbering.xml'),
                     (3, 'settings', 'settings.xml'), (4, 'header', 'header1.xml')]
    if footer:
        relationships.append((5, 'footer', 'footer1.xml'))
    parts['word/_rels/document.xml.rels'] = XML + f'<Relationships xmlns="{REL}">' + ''.join(
        f'<Relationship Id="rId{i}" Type="{R}/{kind}" Target="{target}"/>' for i, kind, target in relationships) + '</Relationships>'
    parts['_rels/.rels'] = (XML + f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{R}/officeDocument" Target="word/document.xml"/>'
                           '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
                           'Target="docProps/core.xml"/></Relationships>')
    parts['docProps/core.xml'] = (XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
                                'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + escape(data['title']) +
                                '</dc:title><dc:creator>OpenNova</dc:creator></cp:coreProperties>')
    types = {'document': 'document.main', 'styles': 'styles', 'numbering': 'numbering', 'settings': 'settings', 'header1': 'header'}
    if footer:
        types['footer1'] = 'footer'
    parts['[Content_Types].xml'] = (XML + f'<Types xmlns="{CT}">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>' + ''.join(
            f'<Override PartName="/word/{name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"/>'
            for name, kind in types.items()) +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>')
    return parts


def element_text(element):
    result = []
    for item in element.iter():
        if item.tag == f'{{{W}}}t':
            result.append(item.text or '')
        elif item.tag == f'{{{W}}}br':
            result.append('\n')
        elif item.tag == f'{{{W}}}tab':
            result.append('\t')
    return ''.join(result)


def verify_saved(path, spec):
    """Read the saved package, independently comparing ordered block contents."""
    checks = {}

    def check(name, value):
        checks[name] = bool(value)
        require(value, 'document_validation_failed:' + name)

    with zipfile.ZipFile(path) as archive:
        check('zip_crc', archive.testzip() is None)
        names = set(archive.namelist())
        check('no_duplicate_members', len(names) == len(archive.namelist()))
        roots = {name: ET.fromstring(archive.read(name)) for name in names if name.endswith(('.xml', '.rels'))}
        check('xml_parse', len(roots) == len(names))
        for name, root in roots.items():
            if not name.endswith('.rels'):
                continue
            base = '' if name == '_rels/.rels' else posixpath.dirname(posixpath.dirname(name))
            relations = root.findall(f'{{{REL}}}Relationship')
            check('relationship_ids_' + name, len({r.get('Id') for r in relations}) == len(relations))
            for relation in relations:
                check('internal_relationship_' + name + '_' + relation.get('Id'), relation.get('TargetMode') != 'External' and
                      posixpath.normpath(posixpath.join(base, relation.get('Target', ''))) in names)
        document = roots['word/document.xml']
        body = document.find('w:body', NS)
        actual = []
        for child in body:
            if child.tag == f'{{{W}}}p':
                style = child.find('w:pPr/w:pStyle', NS).get(f'{{{W}}}val')
                number = child.find('w:pPr/w:numPr/w:numId', NS)
                actual.append(('paragraph', style, element_text(child), number.get(f'{{{W}}}val') if number is not None else None))
            elif child.tag == f'{{{W}}}tbl':
                actual.append(('table', [[element_text(cell) for cell in row.findall('w:tc', NS)] for row in child.findall('w:tr', NS)]))
        expected = [('paragraph', 'Title', normalized_text(spec['title']), None)]
        if 'subtitle' in spec:
            expected.append(('paragraph', 'Subtitle', normalized_text(spec['subtitle']), None))
        list_index = 0
        table_count = 0
        for block in spec['blocks']:
            if block['type'] in {'heading', 'paragraph'}:
                expected.append(('paragraph', 'Normal' if block['type'] == 'paragraph' else f'Heading{block["level"]}', normalized_text(block['text']), None))
            elif block['type'] == 'list':
                list_index += 1
                expected.extend(('paragraph', 'ListParagraph', normalized_text(text), str(list_index)) for text in block['items'])
            else:
                table_count += 1
                rows = [block['columns']] + block['rows'] + ([block['summary']] if 'summary' in block else [])
                expected.append(('table', [[normalized_text(value) for value in row] for row in rows]))
        check('ordered_content_and_table_cells', actual == expected)
        style_root = roots['word/styles.xml']
        style_defs = {item.get(f'{{{W}}}styleId'): item for item in style_root.findall('w:style', NS)}
        used_styles = {item.get(f'{{{W}}}val') for item in document.findall('.//w:pStyle', NS)}
        check('paragraph_styles_resolve', used_styles <= set(style_defs))
        check('heading_outline_levels', all(style_defs[f'Heading{level}'].find('w:pPr/w:outlineLvl', NS).get(f'{{{W}}}val') == str(level - 1)
                                            for level in (1, 2, 3)))
        defaults = style_root.find('w:docDefaults/w:rPrDefault/w:rPr', NS)
        check('body_font_configuration', defaults.find('w:rFonts', NS).get(f'{{{W}}}eastAsia') == 'Hiragino Sans GB' and
              defaults.find('w:sz', NS).get(f'{{{W}}}val') == '23')
        check('repeated_table_headers', len(document.findall('.//w:tblHeader', NS)) == table_count)
        check('ordinary_table_rows_kept_together', len(document.findall('.//w:trPr/w:cantSplit', NS)) == len(document.findall('.//w:tbl/w:tr', NS)))
        check('no_fixed_row_heights_or_nowrap', not document.findall('.//w:trHeight', NS) and not document.findall('.//w:noWrap', NS))
        check('no_forced_page_breaks', not document.findall('.//w:pageBreakBefore', NS) and
              all(item.get(f'{{{W}}}type') != 'page' for item in document.findall('.//w:br', NS)))
        section = body.find('w:sectPr', NS)
        size = section.find('w:pgSz', NS)
        check('page_size', (int(size.get(f'{{{W}}}w')), int(size.get(f'{{{W}}}h'))) == PAGES[spec['layout']['pageSize']])
        margins = section.find('w:pgMar', NS)
        check('page_margins', all(margins.get(f'{{{W}}}{side}') == '1440' for side in ('top', 'right', 'bottom', 'left')))
        available = PAGES[spec['layout']['pageSize']][0] - 2880
        for index, item in enumerate(document.findall('.//w:tbl', NS)):
            widths = [int(column.get(f'{{{W}}}w')) for column in item.findall('w:tblGrid/w:gridCol', NS)]
            check('table_width_' + str(index), sum(widths) == available and all(width > 200 for width in widths) and
                  all([int(cell.find('w:tcPr/w:tcW', NS).get(f'{{{W}}}w')) for cell in row.findall('w:tc', NS)] == widths
                      for row in item.findall('w:tr', NS)))
        check('header_content', element_text(roots['word/header1.xml']) == normalized_text(spec['layout']['header']))
        check('page_field', bool(spec['layout']['footer']) == ('word/footer1.xml' in names and
              any(field.get(f'{{{W}}}instr', '').strip() == 'PAGE' for field in roots['word/footer1.xml'].iter(f'{{{W}}}fldSimple'))))
        starts = roots['word/numbering.xml'].findall('w:num/w:lvlOverride/w:startOverride', NS)
        check('list_restarts', len(starts) == list_index and all(item.get(f'{{{W}}}val') == '1' for item in starts))
        check('no_embedded_code_or_media', not any(name.startswith('word/media/') or name.endswith('.bin') for name in names))
    return checks


def generate(spec, output):
    validate_spec(spec)
    output = Path(output)
    parts = build_parts(spec)
    # The service owns publication and replacement. This executor only creates
    # a new staging file and never overwrites an existing destination.
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o600 << 16
            archive.writestr(entry, content.encode('utf-8'))
    checks = verify_saved(output, spec)
    return {'generation': {'status': 'completed', 'generatorVersion': GENERATOR_VERSION},
            'contentValidation': {'status': 'passed', 'checks': checks, 'scope': 'saved_docx_structure_and_ordered_content'},
            'layoutValidation': {'status': 'not_checked', 'reason': 'docx_render_not_available',
                'automatic': {'status': 'passed', 'scope': 'page_size_style_table_width_configuration_only'},
                'visual': {'status': 'not_checked'}},
            'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        path = Path(args.spec)
        require(path.stat().st_size <= MAX_SPEC_BYTES, 'document_resource_limit')
        raw = path.read_bytes()
        require(len(raw) <= MAX_SPEC_BYTES, 'document_resource_limit')
        spec = json.loads(raw)
        report = generate(spec, args.output)
        print(json.dumps(report, ensure_ascii=False, separators=(',', ':')))
    except (OSError, ValueError, TypeError, KeyError, ET.ParseError, zipfile.BadZipFile) as error:
        code = str(error) if isinstance(error, DocumentError) else 'document_generation_failed'
        print(json.dumps({'generation': {'status': 'failed'}, 'error': code}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
