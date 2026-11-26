import Foundation
import PDFKit
import Darwin

func stop(_ code: String, pageCount: Int? = nil) -> Never {
    var receipt: [String: Any] = ["error": code]
    if let count = pageCount { receipt["pageCount"] = count }
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: receipt))
    exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 1 || args.count == 4 else { stop("pdf_pages_failed") }
let input = URL(fileURLWithPath: args[0])
guard let source = PDFDocument(url: input) else { stop("pdf_unreadable") }
guard !source.isEncrypted && !source.isLocked else { stop("pdf_encrypted") }
let pageCount = source.pageCount
guard pageCount > 0 else { stop("pdf_unreadable") }
if args.count == 4 {
    guard let first = Int(args[1]), let last = Int(args[2]), first >= 1, first <= last,
          last <= pageCount else { stop("pdf_page_range_out_of_bounds", pageCount: pageCount) }
    guard last - first + 1 <= 256 else { stop("pdf_page_range_too_large") }
    let selected = PDFDocument()
    for number in first...last {
        guard let page = source.page(at: number - 1), let copy = page.copy() as? PDFPage else { stop("pdf_unreadable") }
        selected.insert(copy, at: selected.pageCount)
    }
    let output = URL(fileURLWithPath: args[3])
    var limit = rlimit(rlim_cur: 20 * 1024 * 1024, rlim_max: 20 * 1024 * 1024)
    guard setrlimit(RLIMIT_FSIZE, &limit) == 0, selected.write(to: output),
          let reopened = PDFDocument(url: output), reopened.pageCount == last - first + 1 else { stop("pdf_pages_failed") }
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: ["pageCount": pageCount]))
