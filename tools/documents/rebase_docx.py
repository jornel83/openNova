"""Recover basic Word text edits only if the fixed renderer can reproduce the package."""
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

# Isolated Python ignores the working directory. Load just the sibling fixed helpers.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_docx import build_parts, element_text, NS, W
from office_evidence import Parts, Tree

w = '{' + W + '}'
word14 = '{http://schemas.microsoft.com/office/word/2010/wordml}'
ignorable = '{http://schemas.openxmlformats.org/markup-compatibility/2006}Ignorable'
metadata = {'{http://purl.org/dc/terms/}' + k for k in ('created', 'modified')} | {
    '{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}' + k
    for k in ('lastModifiedBy', 'lastPrinted', 'revision')
}


def signature(node):
    # Prefix choices, indentation, and revision-session IDs do not affect the document.
    attrs = tuple(sorted((key, val) for key, val in node.attrib.items()
                         if not key.startswith(w + 'rsid') and key not in (word14+'paraId', word14+'textId',ignorable)
                         and not (node.tag == w+'t' and key == '{http://www.w3.org/XML/1998/namespace}space')))
    text = node.text or ''
    if not text.strip() and node.tag != w + 't':
        text = ''
    children = []
    for child in node:
        if child.tag in metadata or child.tag in (w+'proofErr', w+'lastRenderedPageBreak'):
            continue
        if node.tag == w+'settings' and child.tag in (w+'zoom',w+'view',w+'proofState',w+'rsids'):
            continue
        value = signature(child)
        if node.tag == w+'r' and value[0] == w+'rPr' and not any(value[1:]):
            continue
        # Word/WPS can split the user's words into several identically styled
        # runs/word-text nodes when spell-checking or saving a selection.
        if node.tag == w+'p' and child.tag == w+'r' and not value[1] and not value[2]:
            elements = list(value[3])
            style = elements.pop(0) if elements and elements[0][0] == w+'rPr' else None
            if all(x[0] in (w+'t',w+'br',w+'tab') and not x[1] and not x[3] for x in elements):
                content = ''.join(x[2] if x[0] == w+'t' else '\n' if x[0] == w+'br' else '\t' for x in elements)
                if not content:
                    continue
                if children and children[-1][:2] == ('textRun',style):
                    content = children.pop()[2] + content
                value = ('textRun',style,content)
        children.append(value)
    if node.tag in ('{http://schemas.openxmlformats.org/package/2006/relationships}Relationships',
                    '{http://schemas.openxmlformats.org/package/2006/content-types}Types'):
        children.sort()
    return (node.tag, attrs, text, tuple(children))


def values(spec):
    yield ['title']
    if 'subtitle' in spec:
        yield ['subtitle']
    for i, block in enumerate(spec['blocks']):
        key = ['blocks', i]
        if block['type'] in ('heading', 'paragraph'):
            yield key + ['text']
        elif block['type'] == 'list':
            for n in range(len(block['items'])):
                yield key + ['items', n]
        elif block['type'] == 'table':
            for n in range(len(block['columns'])):
                yield key + ['columns', n]
            for r, row in enumerate(block['rows']):
                for c in range(len(row)):
                    yield key + ['rows', r, c]
            for n in range(len(block.get('summary', []))):
                yield key + ['summary', n]


def retained_column_widths(rendered, saved, original):
    # The renderer chooses widths from the longest cell in each column.
    # Editors usually keep the existing widths when a user extends one cell.
    # Accept that original grid as well, but never waive a manual grid resize.
    for template, actual, old in zip(rendered.findall('.//w:tbl',NS),saved.findall('.//w:tbl',NS),original.findall('.//w:tbl',NS)):
        def dimensions(table):
            return table.findall('w:tblGrid/w:gridCol',NS) + table.findall('w:tr/w:tc/w:tcPr/w:tcW',NS)
        target,live,previous = map(dimensions,(template,actual,old))
        if len(target) == len(live) == len(previous) and all(n.get(w+'w') == p.get(w+'w') for n,p in zip(live,previous)):
            for n,p in zip(target,previous):
                n.set(w+'w',p.get(w+'w'))


def same_parts(archive, spec, baseline=None):
    parts = Parts(archive)
    expected = build_parts(spec)
    files = {item.filename for item in archive.infolist() if not item.is_dir()}
    if 'docProps/app.xml' in files:
        # Editors add recalculated view statistics. User-authored metadata such
        # as a Company, a Manager, links or a custom template stays protected.
        app_ns = '{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}'
        stats = {app_ns + key for key in ('Application','AppVersion','TotalTime','Pages','Words',
                 'Characters','CharactersWithSpaces','Lines','Paragraphs','DocSecurity','ScaleCrop',
                 'LinksUpToDate','SharedDoc','HyperlinksChanged')}
        app = parts.xml('docProps/app.xml')
        if app.tag != app_ns+'Properties' or any(child.tag not in stats or len(child) for child in app):
            raise ValueError()
        files.remove('docProps/app.xml')
        package = parts.xml('_rels/.rels')
        for item in list(package):
            if item.get('Type') == 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties' and item.get('Target','').lstrip('/') == 'docProps/app.xml':
                package.remove(item)
        types = parts.xml('[Content_Types].xml')
        for item in list(types):
            if item.get('PartName') == '/docProps/app.xml' and item.get('ContentType') == 'application/vnd.openxmlformats-officedocument.extended-properties+xml':
                types.remove(item)
    if files != set(expected):
        raise ValueError()
    for name, template in expected.items():
        saved = parts.xml(name)
        rendered = ET.fromstring(template, parser=ET.XMLParser(target=Tree()))
        if name == 'docProps/core.xml':
            # The document properties title can still describe the original, even
            # after the user changed the visible title. It is checked separately.
            continue
        if name == 'word/document.xml' and baseline is not None:
            retained_column_widths(rendered,saved,baseline.xml(name))
        if signature(saved) != signature(rendered):
            raise ValueError()


def read(spec, old, new):
    # Rebuilding is safe only for the OpenNova structure actually used as a base.
    original = Parts(old)
    # A previously verified rebased snapshot may still have the retained column
    # widths of its first edition. Its exact bytes are pinned by the caller.
    same_parts(old, spec, original)
    latest = Parts(new)
    initial = original.xml('docProps/core.xml')
    actual = latest.xml('docProps/core.xml')
    document = latest.xml('word/document.xml')
    paras = document.find('w:body', NS).findall('.//w:p', NS)
    paths = list(values(spec))
    if len(paras) != len(paths):
        raise ValueError()
    for path, para in zip(paths, paras):
        parent = spec
        for token in path[:-1]:
            parent = parent[token]
        parent[path[-1]] = element_text(para)
    spec['layout']['header'] = element_text(latest.xml('word/header1.xml'))
    # Preserve all representable formatting. An added drawing, a user style,
    # comments, tracked changes or an unknown part must never be lost.
    same_parts(new, spec, original)
    rendered_core = ET.fromstring(build_parts(spec)['docProps/core.xml'])
    if signature(actual) not in (signature(initial), signature(rendered_core)):
        raise ValueError()
    return spec


if __name__ == '__main__':
    try:
        spec = json.loads(Path(sys.argv[1]).read_bytes())
        with zipfile.ZipFile(sys.argv[2]) as old, zipfile.ZipFile(sys.argv[3]) as new:
            json.dump(read(spec, old, new), sys.stdout, ensure_ascii=False, separators=(',', ':'))
    except Exception:
        sys.exit(1)
