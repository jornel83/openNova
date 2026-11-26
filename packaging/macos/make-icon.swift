import AppKit
import Foundation

// Original, code-drawn OpenNova icon. No fonts or external image assets.
// Usage: swift make-icon.swift /path/OpenNova.icns (or /path/OpenNova.png)
func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
}

func render(size: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "OpenNova.Icon", code: 1)
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    defer { NSGraphicsContext.restoreGraphicsState() }
    context.imageInterpolation = .high
    context.shouldAntialias = true
    context.cgContext.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    let square = NSBezierPath(roundedRect: NSRect(x: 88, y: 88, width: 848, height: 848), xRadius: 188, yRadius: 188)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = color(2, 8, 26, 0.32)
    shadow.shadowBlurRadius = 32
    shadow.shadowOffset = NSSize(width: 0, height: -14)
    shadow.set()
    color(10, 22, 49).setFill()
    square.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(colors: [color(9, 18, 43), color(18, 43, 73)])!.draw(in: square, angle: 52)
    NSGraphicsContext.saveGraphicsState()
    square.addClip()
    NSGradient(starting: color(43, 188, 206, 0.24), ending: color(25, 80, 122, 0))!
        .draw(fromCenter: NSPoint(x: 750, y: 785), radius: 0,
              toCenter: NSPoint(x: 750, y: 785), radius: 590, options: .drawsAfterEndingLocation)
    NSGraphicsContext.restoreGraphicsState()
    let rim = NSBezierPath(roundedRect: NSRect(x: 91, y: 91, width: 842, height: 842), xRadius: 185, yRadius: 185)
    rim.lineWidth = 3
    color(183, 235, 255, 0.13).setStroke()
    rim.stroke()

    let nova = NSBezierPath()
    nova.move(to: NSPoint(x: 327, y: 327))
    nova.line(to: NSPoint(x: 327, y: 680))
    nova.line(to: NSPoint(x: 624, y: 344))
    nova.line(to: NSPoint(x: 624, y: 650))
    nova.lineCapStyle = .round
    nova.lineJoinStyle = .round
    nova.lineWidth = 102
    color(28, 210, 218, 0.08).setStroke()
    nova.stroke()
    nova.lineWidth = 72
    color(94, 234, 229).setStroke()
    nova.stroke()
    nova.lineWidth = 48
    color(151, 248, 236, 0.22).setStroke()
    nova.stroke()

    let star = NSBezierPath()
    star.move(to: NSPoint(x: 719, y: 844))
    star.curve(to: NSPoint(x: 837, y: 720), controlPoint1: NSPoint(x: 739, y: 751), controlPoint2: NSPoint(x: 753, y: 739))
    star.curve(to: NSPoint(x: 719, y: 596), controlPoint1: NSPoint(x: 752, y: 700), controlPoint2: NSPoint(x: 738, y: 688))
    star.curve(to: NSPoint(x: 601, y: 720), controlPoint1: NSPoint(x: 700, y: 689), controlPoint2: NSPoint(x: 686, y: 700))
    star.curve(to: NSPoint(x: 719, y: 844), controlPoint1: NSPoint(x: 687, y: 741), controlPoint2: NSPoint(x: 701, y: 752))
    star.close()
    NSGraphicsContext.saveGraphicsState()
    let glow = NSShadow()
    glow.shadowColor = color(100, 244, 240, 0.48)
    glow.shadowBlurRadius = 28
    glow.shadowOffset = .zero
    glow.set()
    color(221, 255, 249).setFill()
    star.fill()
    NSGraphicsContext.restoreGraphicsState()
    color(135, 223, 243, 0.65).setFill()
    NSBezierPath(ovalIn: NSRect(x: 236, y: 749, width: 16, height: 16)).fill()
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "OpenNova.Icon", code: 2)
    }
    return data
}

func run() throws {
    guard CommandLine.arguments.count == 2 else {
        FileHandle.standardError.write(Data("Usage: swift make-icon.swift /path/OpenNova.icns|png\n".utf8))
        exit(2)
    }
    let destination = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
    try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    if destination.pathExtension.lowercased() == "png" {
        try render(size: 1024).write(to: destination, options: .atomic)
        return
    }
    guard destination.pathExtension.lowercased() == "icns" else {
        throw NSError(domain: "OpenNova.Icon", code: 3, userInfo: [NSLocalizedDescriptionKey: "Output must end in .icns or .png"])
    }
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("opennova-icon-" + UUID().uuidString, isDirectory: true)
    let iconset = temporary.appendingPathComponent("OpenNova.iconset", isDirectory: true)
    try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temporary) }
    for base in [16, 32, 128, 256, 512] {
        try render(size: base).write(to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
        try render(size: base * 2).write(to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
    process.arguments = ["--convert", "icns", "--output", destination.path, iconset.path]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw NSError(domain: "OpenNova.Icon", code: Int(process.terminationStatus)) }
}
do { try run() }
catch { FileHandle.standardError.write(Data("OpenNova icon: \(error.localizedDescription)\n".utf8)); exit(1) }
