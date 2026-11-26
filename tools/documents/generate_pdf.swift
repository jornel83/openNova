// Fixed local document executor. Content is JSON data, never executable code.
// Usage: /usr/bin/swift generate_pdf.swift --spec content.json --output result.pdf
import Foundation
import CoreGraphics
import CoreText
import PDFKit

struct DocumentError: Error { let code: String; init(_ code: String) { self.code = code } }
struct LayoutSpec: Decodable { let pageSize: String; let fontPreset: String; let header: String; let footer: Bool }
struct Block: Decodable {
    let type: String
    let level: Int?
    let text: String?
    let ordered: Bool?
    let items: [String]?
    let columns: [String]?
    let rows: [[String]]?
    let summary: [String]?
}
struct Spec: Decodable {
    let schemaVersion: Int
    let title: String
    let subtitle: String?
    let blocks: [Block]
    let layout: LayoutSpec
}
func compact(_ text: String) -> String { text.components(separatedBy: .whitespacesAndNewlines).joined() }
func validText(_ text: String, maximum: Int = 32768) -> Bool {
    text.utf16.count <= maximum && !text.unicodeScalars.contains { scalar in
        scalar.value < 32 && ![9, 10, 13].contains(scalar.value) || scalar.value == 0xfffe || scalar.value == 0xffff
    }
}
func validate(_ spec: Spec) throws {
    guard spec.schemaVersion == 1, !spec.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          validText(spec.title), validText(spec.subtitle ?? ""), spec.blocks.count <= 512,
          ["A4", "Letter"].contains(spec.layout.pageSize), spec.layout.fontPreset == "cjk",
          validText(spec.layout.header, maximum: 1024) else { throw DocumentError("invalid_document_spec") }
    var characters = spec.title.utf16.count + (spec.subtitle?.utf16.count ?? 0)
    var totalRows = 0
    for block in spec.blocks {
        switch block.type {
        case "paragraph", "heading":
            guard let text = block.text, validText(text), !compact(text).isEmpty else { throw DocumentError("invalid_document_spec") }
            if block.type == "heading", ![1, 2, 3].contains(block.level ?? 0) { throw DocumentError("invalid_document_spec") }
            characters += text.utf16.count
        case "list":
            guard block.ordered != nil, let items = block.items, !items.isEmpty, items.count <= 2000,
                  items.allSatisfy({ validText($0) && !compact($0).isEmpty }) else { throw DocumentError("invalid_document_spec") }
            characters += items.reduce(0) { $0 + $1.utf16.count }
        case "table":
            guard let columns = block.columns, !columns.isEmpty, columns.count <= 12,
                  columns.allSatisfy({ validText($0) && !compact($0).isEmpty }), let rows = block.rows, !rows.isEmpty,
                  rows.allSatisfy({ $0.count == columns.count && $0.allSatisfy({ validText($0) }) }),
                  block.summary == nil || (block.summary!.count == columns.count && block.summary!.allSatisfy({ validText($0) })) else {
                throw DocumentError("invalid_document_spec")
            }
            totalRows += rows.count
            characters += (columns + rows.flatMap { $0 } + (block.summary ?? [])).reduce(0) { $0 + $1.utf16.count }
        default: throw DocumentError("unsupported_document_block")
        }
    }
    guard characters <= 200000, totalRows <= 2000 else { throw DocumentError("document_content_too_large") }
}

let black = CGColor(gray: 0, alpha: 1)
func attributed(_ text: String, size: CGFloat, bold: Bool) -> NSAttributedString {
    let font = CTFontCreateWithName((bold ? "HiraginoSansGB-W6" : "HiraginoSansGB-W3") as CFString, size, nil)
    let result = NSMutableAttributedString(string: text, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTLigatureAttributeName as String): 0,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): black
    ])
    // Use a Latin face for Latin runs. PDFKit can collapse tightly spaced
    // repeated Latin glyphs from the CJK CID font when extracting saved text.
    let latin = CTFontCreateWithName((bold ? "Helvetica-Bold" : "Helvetica") as CFString, size, nil)
    let units = Array(text.utf16)
    var index = 0
    while index < units.count {
        if units[index] > 0x024f { index += 1; continue }
        let start = index
        while index < units.count && units[index] <= 0x024f { index += 1 }
        result.addAttribute(NSAttributedString.Key(kCTFontAttributeName as String), value: latin, range: NSRange(location: start, length: index - start))
    }
    return result
}
struct WrappedLine { let line: CTLine; let text: String; let ascent: CGFloat; let descent: CGFloat; let width: CGFloat }
func wrapped(_ text: String, width: CGFloat, size: CGFloat, bold: Bool = false) throws -> [WrappedLine] {
    guard width > 5 else { throw DocumentError("table_columns_too_narrow") }
    if text.isEmpty { return [] }
    let attr = attributed(text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n"), size: size, bold: bold)
    let setter = CTTypesetterCreateWithAttributedString(attr)
    var offset = 0
    var output: [WrappedLine] = []
    while offset < attr.length {
        let length = CTTypesetterSuggestLineBreak(setter, offset, Double(width))
        guard length > 0 else { throw DocumentError("unbreakable_document_text") }
        let line = CTTypesetterCreateLine(setter, CFRange(location: offset, length: length))
        var ascent: CGFloat = 0, descent: CGFloat = 0
        let measured = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, nil)) - CGFloat(CTLineGetTrailingWhitespaceWidth(line))
        guard measured <= width + 0.8 else { throw DocumentError("document_text_overflow") }
        output.append(WrappedLine(line: line, text: (attr.string as NSString).substring(with: NSRange(location: offset, length: length)),
                                  ascent: ascent, descent: descent, width: measured))
        offset += length
    }
    return output
}
struct TextCheck { let page: Int; let box: CGRect; let text: String; let kind: String }
struct CellCheck { let page: Int; let box: CGRect; let text: String }

final class PDFLayout {
    let context: CGContext
    let spec: Spec
    let width: CGFloat
    let height: CGFloat
    let left: CGFloat = 64
    let bottom: CGFloat = 62
    var right: CGFloat { width - left }
    var top: CGFloat { height - 78 }
    var availableWidth: CGFloat { right - left }
    var y: CGFloat = 0
    var page = 0
    var lineChecks: [TextCheck] = []
    var regionOutput: URL?
    var paragraphLineCounts: [Int] = []
    var cellChecks: [CellCheck] = []
    var tableHeaderChecks: [CellCheck] = []
    var drawingBoundsValid = true
    var drawnContentLines = 0
    var pageContentCounts: [Int] = []
    let headerLines: [WrappedLine]

    init(context: CGContext, spec: Spec, width: CGFloat, height: CGFloat) throws {
        self.context = context; self.spec = spec; self.width = width; self.height = height
        headerLines = try wrapped(spec.layout.header, width: width - 128, size: 8.5)
        guard headerLines.count <= 2 else { throw DocumentError("document_header_too_long") }
        let regular = CTFontCreateWithName("HiraginoSansGB-W3" as CFString, 11.5, nil)
        let bold = CTFontCreateWithName("HiraginoSansGB-W6" as CFString, 11.5, nil)
        guard (CTFontCopyPostScriptName(regular) as String).contains("HiraginoSansGB"),
              (CTFontCopyPostScriptName(bold) as String).contains("HiraginoSansGB") else { throw DocumentError("document_font_unavailable") }
    }
    func draw(_ line: WrappedLine, x: CGFloat, baseline: CGFloat) {
        context.textMatrix = .identity
        context.textPosition = CGPoint(x: x, y: baseline)
        CTLineDraw(line.line, context)
        let bounds = CTLineGetBoundsWithOptions(line.line, .useGlyphPathBounds).offsetBy(dx: x, dy: baseline)
        if !bounds.isEmpty && (bounds.minX < left - 1 || bounds.maxX > right + 1 || bounds.minY < 18 || bounds.maxY > height - 18) {
            drawingBoundsValid = false
        }
    }
    func newPage() throws {
        if page > 0 { context.endPDFPage() }
        guard page < 400 else { throw DocumentError("document_page_limit") }
        page += 1
        pageContentCounts.append(0)
        context.beginPDFPage(nil)
        for (index, line) in headerLines.enumerated() { draw(line, x: left, baseline: height - 34 - CGFloat(index) * 13) }
        if !headerLines.isEmpty {
            context.setStrokeColor(CGColor(gray: 0.75, alpha: 1)); context.setLineWidth(0.4)
            context.move(to: CGPoint(x: left, y: height - 57)); context.addLine(to: CGPoint(x: right, y: height - 57)); context.strokePath()
        }
        if spec.layout.footer {
            let line = try wrapped("第 \(page) 页", width: availableWidth, size: 9)[0]
            draw(line, x: (width - line.width) / 2, baseline: 31)
        }
        y = top
    }
    func paragraph(_ text: String, size: CGFloat = 11.5, bold: Bool = false, after: CGFloat = 9,
                   indent: CGFloat = 0, kind: String = "paragraph") throws {
        let lines = try wrapped(text, width: availableWidth - indent, size: size, bold: bold)
        if regionOutput != nil { paragraphLineCounts.append(lines.count) }
        let leading = max(size + 6.5, (lines.map { $0.ascent + $0.descent }.max() ?? size) + 3)
        if y - CGFloat(min(2, lines.count)) * leading < bottom { try newPage() }
        for (index, line) in lines.enumerated() {
            if y - leading < bottom || (lines.count - index == 2 && y - 2 * leading < bottom) { try newPage() }
            let baseline = y - line.ascent
            draw(line, x: left + indent, baseline: baseline)
            lineChecks.append(TextCheck(page: page, box: CGRect(x: left + indent - 0.4, y: baseline - line.descent - 0.4,
                                                                 width: availableWidth - indent + 0.8, height: line.ascent + line.descent + 0.8),
                                        text: line.text, kind: kind))
            if !compact(line.text).isEmpty { drawnContentLines += 1; pageContentCounts[page - 1] += 1 }
            y -= leading
        }
        y -= after
    }
    func heading(_ text: String, level: Int) throws {
        if y - 85 < bottom { try newPage() }
        y -= 8
        try paragraph(text, size: CGFloat(18 - level * 2), bold: true, after: 8, kind: "heading")
    }
    func columnWidths(columns: [String], rows: [[String]]) -> [CGFloat] {
        // Prefer more room for descriptive text without allowing data-driven columns to starve one another.
        let n = columns.count
        let minimum = min(CGFloat(48), availableWidth / CGFloat(n))
        let free = max(0, availableWidth - minimum * CGFloat(n))
        var weights: [CGFloat] = []
        for index in 0..<n {
            let maxLength = ([columns[index]] + rows.prefix(100).map { $0[index] }).map { min($0.count, 50) }.max() ?? 1
            weights.append(CGFloat(max(4, maxLength)))
        }
        let sum = weights.reduce(0, +)
        return weights.map { minimum + free * $0 / sum }
    }
    func table(columns: [String], rows: [[String]], summary: [String]?) throws {
        let widths = columnWidths(columns: columns, rows: rows)
        func prepare(_ cells: [String], bold: Bool) throws -> ([[WrappedLine]], CGFloat, CGFloat) {
            let lines = try zip(cells, widths).map { try wrapped($0.0, width: $0.1 - 12, size: 11, bold: bold) }
            let leading = max(CGFloat(16), (lines.flatMap { $0 }.map { $0.ascent + $0.descent }.max() ?? 11) + 2)
            let rowHeight = max(27, CGFloat(lines.map { max(1, $0.count) }.max() ?? 1) * leading + 12)
            return (lines, rowHeight, leading)
        }
        let header = try prepare(columns, bold: true)
        guard header.1 < top - bottom - 30 else { throw DocumentError("table_header_too_tall") }
        func drawRow(_ cells: [String], prepared: ([[WrappedLine]], CGFloat, CGFloat), header: Bool = false, total: Bool = false) {
            let (lines, rowHeight, leading) = prepared
            let rowTop = y
            if header || total {
                context.setFillColor(CGColor(gray: header ? 0.93 : 0.97, alpha: 1))
                context.fill(CGRect(x: left, y: rowTop - rowHeight, width: availableWidth, height: rowHeight))
            }
            context.setStrokeColor(CGColor(gray: 0.68, alpha: 1)); context.setLineWidth(0.4)
            var x = left
            for column in cells.indices {
                context.stroke(CGRect(x: x, y: rowTop - rowHeight, width: widths[column], height: rowHeight))
                for (index, line) in lines[column].enumerated() {
                    draw(line, x: x + 6, baseline: rowTop - 6 - line.ascent - CGFloat(index) * leading)
                }
                let check = CellCheck(page: page, box: CGRect(x: x + 2, y: rowTop - rowHeight + 1, width: widths[column] - 4, height: rowHeight - 2), text: cells[column])
                if header { tableHeaderChecks.append(check) } else { cellChecks.append(check) }
                x += widths[column]
            }
            pageContentCounts[page - 1] += 1
            y -= rowHeight
        }
        let first = try prepare(rows[0], bold: false)
        guard first.1 + header.1 <= top - bottom else { throw DocumentError("table_row_too_tall") }
        if y - header.1 - first.1 < bottom { try newPage() }
        drawRow(columns, prepared: header, header: true)
        for (index, cells) in (rows + (summary.map { [$0] } ?? [])).enumerated() {
            let isTotal = index == rows.count
            let prepared = try prepare(cells, bold: isTotal)
            guard prepared.1 + header.1 <= top - bottom else { throw DocumentError("table_row_too_tall") }
            if y - prepared.1 < bottom { try newPage(); drawRow(columns, prepared: header, header: true) }
            drawRow(cells, prepared: prepared, total: isTotal)
        }
        y -= 12
    }
    func finish() { context.endPDFPage(); context.closePDF() }
}

func verify(url: URL, spec: Spec, layout: PDFLayout) throws -> [String: Any] {
    // Derive coverage from the input independently of which drawing methods ran.
    // Region checks alone could otherwise pass after accidentally omitting a block.
    var expectedText = [spec.title]
    if let subtitle = spec.subtitle, !subtitle.isEmpty { expectedText.append(subtitle) }
    var expectedCells: [String] = []
    for block in spec.blocks {
        switch block.type {
        case "paragraph", "heading": expectedText.append(block.text!)
        case "list":
            expectedText.append(contentsOf: block.items!.enumerated().map { (block.ordered! ? "\($0.offset + 1). " : "• ") + $0.element })
        case "table": expectedCells.append(contentsOf: block.rows!.flatMap { $0 } + (block.summary ?? []))
        default: throw DocumentError("unsupported_document_block")
        }
    }
    guard compact(expectedText.joined()) == compact(layout.lineChecks.map { $0.text }.joined()),
          expectedCells == layout.cellChecks.map({ $0.text }) else { throw DocumentError("pdf_content_coverage_mismatch") }
    guard let pdf = PDFDocument(url: url), let cg = CGPDFDocument(url as CFURL), pdf.pageCount == layout.page,
          cg.numberOfPages == pdf.pageCount, pdf.pageCount > 0 else { throw DocumentError("pdf_reopen_failed") }
    var charCount = 0
    var boundsCount = 0
    for index in 0..<pdf.pageCount {
        guard let page = pdf.page(at: index) else { throw DocumentError("pdf_page_missing") }
        let media = page.bounds(for: .mediaBox)
        guard abs(media.width - layout.width) < 0.2, abs(media.height - layout.height) < 0.2,
              page.rotation == 0, layout.pageContentCounts[index] > 0, !(page.string ?? "").isEmpty else { throw DocumentError("pdf_page_validation_failed") }
        if spec.layout.footer {
            let footer = page.selection(for: CGRect(x: 0, y: 20, width: layout.width, height: 27))?.string ?? ""
            guard compact(footer) == "第\(index + 1)页" else { throw DocumentError("pdf_page_number_mismatch") }
        }
        if !spec.layout.header.isEmpty {
            let header = page.selection(for: CGRect(x: layout.left - 1, y: layout.height - 54, width: layout.availableWidth + 2, height: 34))?.string ?? ""
            guard compact(header) == compact(spec.layout.header) else { throw DocumentError("pdf_header_mismatch") }
        }
        charCount += page.numberOfCharacters
        for n in 0..<page.numberOfCharacters {
            let box = page.characterBounds(at: n)
            if box.isNull || box.isEmpty { continue }
            boundsCount += 1
            guard box.minX >= layout.left - 1.5, box.maxX <= layout.right + 1.5,
                  box.minY >= 18, box.maxY <= layout.height - 18 else { throw DocumentError("pdf_character_out_of_bounds") }
        }
    }
    guard layout.drawingBoundsValid else { throw DocumentError("pdf_drawing_out_of_bounds") }
    for check in layout.lineChecks where !compact(check.text).isEmpty {
        let actual = pdf.page(at: check.page - 1)?.selection(for: check.box)?.string ?? ""
        guard compact(actual) == compact(check.text) else { throw DocumentError("pdf_text_readback_mismatch") }
    }
    for check in layout.cellChecks + layout.tableHeaderChecks {
        let actual = pdf.page(at: check.page - 1)?.selection(for: check.box)?.string ?? ""
        guard compact(actual) == compact(check.text) else { throw DocumentError("pdf_table_readback_mismatch") }
    }
    return [
        "generation": ["status": "completed", "executor": "swift-coretext-pdf", "version": "1"],
        "contentValidation": ["status": "passed", "method": "saved_pdf_pdfkit_region_readback", "textLines": layout.lineChecks.count,
                              "tableCells": layout.cellChecks.count, "repeatedHeaderCells": layout.tableHeaderChecks.count,
                              "checks": ["input_block_and_cell_coverage", "all_ordered_text_regions_match", "all_table_cells_match", "saved_pdf_reopened"]],
        "layoutValidation": ["status": "passed", "scope": "automatic_geometry_only",
                             "automatic": ["status": "passed", "characterBoundsChecked": boundsCount,
                                           "checks": ["page_dimensions", "continuous_page_numbers_if_enabled", "header_if_enabled", "no_blank_pages", "drawing_and_character_bounds"]],
                             "visual": ["status": "not_checked", "reason": "visual_inspection_not_run"]],
        "pageCount": pdf.pageCount, "characterCount": charCount,
        "limitations": ["Automatic geometry and text checks do not prove glyph appearance or cross-reader layout.", "Table rows must fit a page with the repeated header; oversized rows fail explicitly."]
    ]
}

func run() throws {
    let args = Array(CommandLine.arguments.dropFirst())
    guard (args.count == 4 || (args.count == 6 && args[4] == "--regions")), args[0] == "--spec", args[2] == "--output" else { throw DocumentError("invalid_generator_arguments") }
    let input = URL(fileURLWithPath: args[1]), output = URL(fileURLWithPath: args[3])
    guard input.standardizedFileURL != output.standardizedFileURL else { throw DocumentError("invalid_output_path") }
    let data = try Data(contentsOf: input, options: .mappedIfSafe)
    guard data.count <= 1024 * 1024 else { throw DocumentError("document_spec_too_large") }
    let spec = try JSONDecoder().decode(Spec.self, from: data)
    try validate(spec)
    let width: CGFloat = spec.layout.pageSize == "A4" ? 595.276 : 612
    let height: CGFloat = spec.layout.pageSize == "A4" ? 841.89 : 792
    var media = CGRect(x: 0, y: 0, width: width, height: height)
    guard let context = CGContext(output as CFURL, mediaBox: &media, [kCGPDFContextTitle as String: spec.title, kCGPDFContextAuthor as String: "OpenNova"] as CFDictionary) else { throw DocumentError("pdf_output_unavailable") }
    var closed = false
    defer { if !closed { context.closePDF() } }
    let layout = try PDFLayout(context: context, spec: spec, width: width, height: height)
    if args.count == 6 { layout.regionOutput = URL(fileURLWithPath: args[5]) }
    try layout.newPage()
    try layout.paragraph(spec.title, size: 21, bold: true, after: 10, kind: "title")
    if let subtitle = spec.subtitle, !subtitle.isEmpty { try layout.paragraph(subtitle, size: 13, after: 12, kind: "subtitle") }
    for block in spec.blocks {
        switch block.type {
        case "paragraph": try layout.paragraph(block.text!)
        case "heading": try layout.heading(block.text!, level: block.level!)
        case "list":
            for (index, item) in block.items!.enumerated() { try layout.paragraph((block.ordered! ? "\(index + 1). " : "• ") + item, after: 4, indent: 10, kind: "list") }
        case "table": try layout.table(columns: block.columns!, rows: block.rows!, summary: block.summary)
        default: throw DocumentError("unsupported_document_block")
        }
    }
    layout.finish(); closed = true
    let receipt = try verify(url: output, spec: spec, layout: layout)
    if let regionOutput = layout.regionOutput {
        // Reuse the exact saved-text validation boxes when aligning a manually edited PDF.
        func region(_ page: Int, _ box: CGRect) -> [CGFloat] {
            [CGFloat(page), box.minX, box.minY, box.width, box.height]
        }
        let groups: [String: Any] = [
            "lineCounts": layout.paragraphLineCounts,
            "lines": layout.lineChecks.map { region($0.page, $0.box) },
            "cells": layout.cellChecks.map { region($0.page, $0.box) }
        ]
        try JSONSerialization.data(withJSONObject: groups).write(to: regionOutput)
    }
    print(String(data: try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!)
}
do { try run() }
catch {
    let code = (error as? DocumentError)?.code ?? (error is DecodingError ? "invalid_document_spec" : "pdf_generation_failed")
    let result: [String: Any] = ["generation": ["status": "failed"], "error": code]
    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) { print(line) }
    exit(1)
}
