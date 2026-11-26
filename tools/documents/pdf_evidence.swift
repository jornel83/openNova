import Foundation
import PDFKit

// Only the requested physical pages are consulted. There is no OCR, inferred
// page mapping or model-assisted text correction in a "verified" quotation.
struct Candidate: Decodable { let page: Int; let quote: String }
typealias Receipt = [String: Any]
func unavailable(_ item: Candidate, _ reason: String) -> Receipt {
    return ["verified": false, "page": item.page, "reason": reason]
}
func output(_ receipts: [Receipt]) -> Never {
    guard let data = try? JSONSerialization.data(withJSONObject: receipts) else { exit(2) }
    FileHandle.standardOutput.write(data)
    exit(0)
}
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 2, let argsData = FileManager.default.contents(atPath: args[1]),
      let items = try? JSONDecoder().decode([Candidate].self, from: argsData), items.count <= 32,
      items.allSatisfy({ $0.page > 0 && !$0.quote.isEmpty && $0.quote.utf16.count <= 1200 }) else { exit(2) }
guard let pdf = PDFDocument(url: URL(fileURLWithPath: args[0])), pdf.pageCount > 0 else {
    output(items.map { unavailable($0, "pdf_unreadable") })
}
guard !pdf.isEncrypted && !pdf.isLocked else { output(items.map { unavailable($0, "pdf_encrypted") }) }

func match(_ item: Candidate, _ text: NSString) -> Receipt {
    // Only layout whitespace can vary. Match case and punctuation verbatim;
    // return the original substring including its original line breaks.
    let words = item.quote.split(whereSeparator: { $0.isWhitespace })
    guard !words.isEmpty else { return unavailable(item, "pdf_quote_not_found") }
    let pattern = words.map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: "\\s+")
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let found = regex.firstMatch(in: text as String, range: NSRange(location: 0, length: text.length)) else {
        return unavailable(item, "pdf_quote_not_found")
    }
    guard found.range.length <= 1200 else { return unavailable(item, "pdf_quote_too_long") }
    return ["verified": true, "page": item.page, "quote": text.substring(with: found.range)]
}

var receipts = items.map { unavailable($0, "pdf_page_range_out_of_bounds") }
for (number, indices) in Dictionary(grouping: items.indices, by: { items[$0].page }) {
    guard number <= pdf.pageCount, let page = pdf.page(at: number - 1) else { continue }
    autoreleasepool {
        guard page.numberOfCharacters <= 128 * 1024 else {
            for i in indices { receipts[i] = unavailable(items[i], "pdf_text_limit") }; return
        }
        guard let content = page.string, !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            for i in indices { receipts[i] = unavailable(items[i], "pdf_no_text_layer") }; return
        }
        let text = content as NSString
        guard text.length <= 128 * 1024 else {
            for i in indices { receipts[i] = unavailable(items[i], "pdf_text_limit") }; return
        }
        for i in indices { receipts[i] = match(items[i], text) }
    }
}
output(receipts)
