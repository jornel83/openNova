// Extract only at the fixed renderer's verified locations. The caller then
// reconstructs the proposed base and verifies it against the entire saved PDF.
import Foundation
import CoreGraphics
import PDFKit

enum Check: Error { case unsupported }

func keys(_ dictionary: CGPDFDictionaryRef?) -> Set<String> {
    guard let dictionary = dictionary else { return [] }
    var result = Set<String>()
    CGPDFDictionaryApplyBlock(dictionary, { key, _, _ in
        result.insert(String(cString: key))
        return true
    }, nil)
    return result
}

func bitmap(_ page: CGPDFPage, _ box: CGRect) throws -> Data {
    guard box.width > 0 && box.height > 0 && box.width <= 850 && box.height <= 1100 else { throw Check.unsupported }
    let scale: CGFloat = 1.5
    let w = Int(ceil(box.width * scale)), h = Int(ceil(box.height * scale))
    var result = Data(count: w * h * 4)
    try result.withUnsafeMutableBytes { bytes in
        guard let context = CGContext(data: bytes.baseAddress, width: w, height: h, bitsPerComponent: 8,
            bytesPerRow: 4 * w, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw Check.unsupported }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: w, height: h))
        context.scaleBy(x: scale, y: scale)
        context.drawPDFPage(page)
    }
    return result
}

func compare(_ a: URL, _ b: URL) throws {
    guard let left = PDFDocument(url:a), let right = PDFDocument(url:b),
          let cgA = CGPDFDocument(a as CFURL), let cgB = CGPDFDocument(b as CFURL),
          left.pageCount == right.pageCount, left.pageCount <= 300,
          !cgA.isEncrypted, !cgB.isEncrypted,
          keys(cgB.catalog).isSubset(of:["Type","Pages"]), keys(cgA.catalog).isSubset(of:["Type","Pages"]),
          keys(cgB.info).isSubset(of:["Author","Title","Producer","CreationDate","ModDate"]) else { throw Check.unsupported }
    for key in [PDFDocumentAttribute.authorAttribute, .titleAttribute] {
        if left.documentAttributes?[key] as? String != right.documentAttributes?[key] as? String { throw Check.unsupported }
    }
    for index in 0..<left.pageCount {
        try autoreleasepool {
            guard let p = left.page(at:index), let q = right.page(at:index),
                  let x = cgA.page(at:index+1), let y = cgB.page(at:index+1),
                  keys(y.dictionary).isSubset(of:["Type","Parent","Resources","MediaBox","Contents","Rotate","CropBox","TrimBox","BleedBox","ArtBox"]),
                  q.annotations.isEmpty, p.rotation == q.rotation, p.string == q.string else { throw Check.unsupported }
            for box in [PDFDisplayBox.mediaBox, .cropBox, .bleedBox, .trimBox, .artBox] {
                guard p.bounds(for:box) == q.bounds(for:box) else { throw Check.unsupported }
            }
            guard try bitmap(x,p.bounds(for:.mediaBox)) == bitmap(y,q.bounds(for:.mediaBox)) else { throw Check.unsupported }
        }
    }
}

func run() throws {
    let args = Array(CommandLine.arguments.dropFirst())
    guard args.count >= 3 else { throw Check.unsupported }
    let old = URL(fileURLWithPath:args[1]), new = URL(fileURLWithPath:args[2])
    if args[0] == "verify" { try compare(old,new); return }
    guard args[0] == "regions", args.count == 4, let a = PDFDocument(url:old), let b = PDFDocument(url:new),
          a.pageCount > 0, a.pageCount == b.pageCount, a.pageCount <= 300,
          let data = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:args[3]))) as? [String:Any]
    else { throw Check.unsupported }
    var output: [String:[[String]]] = [:]
    for key in ["lines","cells"] {
        guard let regions = data[key] as? [[CGFloat]] else { throw Check.unsupported }
        output[key] = try regions.map { coords in
            guard coords.count == 5, let oldPage = a.page(at:Int(coords[0])-1), let newPage = b.page(at:Int(coords[0])-1) else { throw Check.unsupported }
            let box = CGRect(x:coords[1],y:coords[2],width:coords[3],height:coords[4])
            return [oldPage.selection(for:box)?.string ?? "", newPage.selection(for:box)?.string ?? ""]
        }
    }
    try FileHandle.standardOutput.write(contentsOf:JSONSerialization.data(withJSONObject:output))
}
do { try run() } catch { exit(1) }
