"""Local excerpt checks for a conservative subset of ISO transitional DOCX/XLSX.

Only named package members are parsed, never extracted, fetched, evaluated or launched.
"""
import json
import os
import posixpath
import re
import struct
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
X = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"
CT = "{http://schemas.openxmlformats.org/package/2006/content-types}Override"


class Reject(Exception):
    pass


class Tree(ET.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.count = self.depth = 0

    def start(self, tag, attrs):
        self.count += 1
        self.depth += 1
        if self.count > 75000 or self.depth > 128:
            raise Reject("office_resource_limit")
        return super().start(tag, attrs)

    def end(self, tag):
        self.depth -= 1
        return super().end(tag)

    def doctype(self, *args):
        raise Reject("office_package_unreadable")


class Parts:
    def __init__(self, archive):
        self.archive = archive
        infos = archive.infolist()
        if len(infos) > 2048 or sum(p.file_size for p in infos) > 64 * 1024**2:
            raise Reject("office_resource_limit")
        if len({p.filename for p in infos}) != len(infos):
            raise Reject("office_package_unreadable")
        self.cache = {}
        self.total = 0

    def xml(self, name):
        if name not in self.cache:
            info = self.archive.getinfo(name)
            if info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise Reject("office_unsupported_content")
            self.total += info.file_size
            if info.file_size > 4 * 1024**2 or self.total > 16 * 1024**2:
                raise Reject("office_resource_limit")
            data = self.archive.read(info)
            self.cache[name] = ET.fromstring(data, parser=ET.XMLParser(target=Tree()))
        return self.cache[name]


def relationship(parts, relpart, owner, kind, rid=None):
    rels = [r for r in parts.xml(relpart).findall(REL)
            if r.get("Type") == R + "/" + kind and (rid is None or rid == r.get("Id"))]
    if len(rels) != 1 or rels[0].get("TargetMode", "Internal") != "Internal":
        raise Reject("office_unsupported_content")
    t = rels[0].get("Target", "")
    if not re.fullmatch(r"/?[A-Za-z0-9_. /-]+", t) or any(s in ("", ".", "..") for s in t.lstrip("/").split("/")):
        raise Reject("office_unsupported_content")
    return t[1:] if t.startswith("/") else posixpath.join(posixpath.dirname(owner), t)


def check_main(parts, kind):
    expected, ct = (("word/document.xml", "wordprocessingml") if kind == "docx" else ("xl/workbook.xml", "spreadsheetml"))
    if relationship(parts, "_rels/.rels", "", "officeDocument") != expected:
        raise Reject("office_unsupported_content")
    values = [e.get("ContentType") for e in parts.xml("[Content_Types].xml").findall(CT) if e.get("PartName") == "/" + expected]
    if values != ["application/vnd.openxmlformats-officedocument." + ct + (".document.main+xml" if kind == "docx" else ".sheet.main+xml")]:
        raise Reject("office_unsupported_content")


def matched(candidate, source, whole=False):
    if len(source) > 128 * 1024:
        raise Reject("office_resource_limit")
    words = candidate.split()
    pattern = r"\s+".join(map(re.escape, words))
    hit = (re.fullmatch if whole else re.search)(pattern, source) if words else None
    if not hit or len(hit.group().encode("utf-16-le")) > 2400:
        raise Reject("office_quote_not_found")
    return {"verified": True, "quote": hit.group()}


def word(parts):
    root = parts.xml("word/document.xml")
    body = root.find(W + "body")
    if root.tag != W + "document" or body is None:
        raise Reject("office_package_unreadable")
    paragraphs = []
    # Count top-level, nonempty body paragraphs; never count paragraphs in tables,
    # text boxes, headers or footers. Field results/revisions are not literal prose.
    for p in body.findall(W + "p"):
        pieces = []
        unsupported = False
        children = list(p)
        for child in children:
            if child.tag == W + "pPr":
                continue
            runs = list(child) if child.tag == W + "hyperlink" else [child]
            for run in runs:
                if run.tag in (W+"bookmarkStart", W+"bookmarkEnd", W+"proofErr"):
                    continue
                if run.tag != W+"r":
                    unsupported = True
                    continue
                for node in run:
                    if node.tag == W+"t":
                        pieces.append(node.text or "")
                    elif node.tag in (W+"tab", W+"br", W+"cr"):
                        pieces.append("\t" if node.tag == W+"tab" else "\n")
                    elif node.tag == W+"rPr":
                        if any(it.tag in (W+"vanish", W+"webHidden", W+"rPrChange") for it in node.iter()):
                            unsupported = True
                    elif node.tag != W+"lastRenderedPageBreak":
                        unsupported = True
        value = "".join(pieces)
        if unsupported:
            # The display state of fields/revisions can change whether this is
            # a nonempty paragraph. Do not assign ordinals beyond that point.
            paragraphs.append(None)
            break
        if value.strip():
            paragraphs.append(value)

    def find(locator, quote):
        num = locator["paragraph"]
        if paragraphs and paragraphs[-1] is None and num >= len(paragraphs):
            raise Reject("office_unsupported_content")
        if num < 1 or num > len(paragraphs):
            raise Reject("office_location_not_found")
        return matched(quote, paragraphs[num - 1])
    return find


def point(addr):
    m = re.fullmatch(r"([A-Z]{1,3})([1-9]\d{0,6})", addr)
    if not m:
        raise Reject("office_invalid_locator")
    col = 0
    for c in m[1]:
        col = col * 26 + ord(c) - 64
    row = int(m[2])
    if col > 16384 or row > 1048576:
        raise Reject("office_invalid_locator")
    return col, row


def rich(si):
    out = []
    for child in si:
        if child.tag == X+"t":
            out.append(child.text or "")
        elif child.tag == X+"r":
            out.extend(t.text or "" for t in child.findall(X+"t"))
        elif child.tag not in (X+"phoneticPr", X+"rPh"):
            raise Reject("office_unsupported_content")
    return "".join(out)


def excel(parts):
    wb = parts.xml("xl/workbook.xml")
    sheets = wb.findall(X+"sheets/"+X+"sheet")
    relpart, owner = "xl/_rels/workbook.xml.rels", "xl/workbook.xml"

    def find(loc, quote):
        addr = loc["cell"]
        x, y = point(addr)
        matches = [s for s in sheets if s.get("name") == loc["sheet"]]
        if len(matches) != 1:
            raise Reject("office_location_not_found")
        rid = matches[0].get("{"+R+"}id")
        if not rid:
            raise Reject("office_unsupported_content")
        sheet = parts.xml(relationship(parts, relpart, owner, "worksheet", rid))
        if sheet.tag != X+"worksheet":
            raise Reject("office_unsupported_content")
        if sheet.find(X+"extLst") is not None:
            raise Reject("office_unsupported_content")
        cells = []
        for row in sheet.findall(X+"sheetData/"+X+"row"):
            for c in row.findall(X+"c"):
                for f in c.findall(X+"f"):
                    area = f.get("ref")
                    if area:
                        bounds = area.split(":")
                        a, b = point(bounds[0]), point(bounds[-1])
                        if a[0] <= x <= b[0] and a[1] <= y <= b[1]:
                            raise Reject("office_formula_not_supported")
                if c.get("r") == addr:
                    if row.get("r", str(y)) != str(y):
                        raise Reject("office_unsupported_content")
                    cells.append(c)
        if len(cells) != 1:
            raise Reject("office_location_not_found")
        c = cells[0]
        if c.find(X+"f") is not None:
            raise Reject("office_formula_not_supported")
        typ, val = c.get("t", "n"), c.findtext(X+"v")
        if typ == "inlineStr" and c.find(X+"is") is not None:
            return matched(quote, rich(c.find(X+"is")))
        if typ == "s" and re.fullmatch(r"\d{1,8}", val or ""):
            shared = parts.xml(relationship(parts, relpart, owner, "sharedStrings")).findall(X+"si")
            i = int(val)
            if i < len(shared):
                return matched(quote, rich(shared[i]))
        if typ == "n" and c.get("s", "0") == "0" and val and re.fullmatch(r"-?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?", val):
            return matched(quote, val, whole=True)
        raise Reject("office_unsupported_content")
    return find


def failure(why):
    return {"verified": False, "reason": why}


def check_directory(path):
    # ZipFile creates one Python object per central-directory entry immediately.
    # Bound the directory itself before handing the archive to the stdlib.
    size = os.stat(path).st_size
    with open(path, "rb") as f:
        f.seek(max(0, size - 65557))
        tail = f.read(65557)
    pos = tail.rfind(b"PK\x05\x06")
    if pos < 0 or len(tail) - pos < 22:
        raise Reject("office_package_unreadable")
    disk, start_disk, count_disk, count, cd_size, offset, comment = struct.unpack_from("<HHHHIIH", tail, pos + 4)
    if count > 2048 or cd_size > 1024**2:
        raise Reject("office_resource_limit")
    if (disk or start_disk or count_disk != count or pos + 22 + comment != len(tail) or
            offset + cd_size != size - (len(tail) - pos) or tail[max(pos - 20, 0):pos - 16] == b"PK\x06\x07"):
        raise Reject("office_unsupported_content")


def main():
    kind = sys.argv[1]
    if kind not in ("docx", "xlsx") or os.stat("items.json").st_size > 256 * 1024 or os.stat("source.zip").st_size > 20 * 1024**2:
        raise ValueError()
    with open("items.json", encoding="utf-8") as handle:
        items = json.load(handle)
    if not isinstance(items, list) or len(items) > 32:
        raise ValueError()
    try:
        check_directory("source.zip")
        with zipfile.ZipFile("source.zip") as package:
            parts = Parts(package)
            check_main(parts, kind)
            find = word(parts) if kind == "docx" else excel(parts)
            result = []
            for item in items:
                if item is None:
                    result.append(failure("office_invalid_locator"))
                    continue
                try:
                    result.append(find(item["locator"], item["quote"]))
                except Reject as e:
                    result.append(failure(str(e)))
    except Reject as e:
        result = [failure(str(e)) for _ in items]
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, ET.ParseError, RuntimeError):
        result = [failure("office_package_unreadable") for _ in items]
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
