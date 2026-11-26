import AppKit
import Foundation

// This small native controller keeps the existing Chrome-based OpenNova interface.
// Bundled code is immutable; the Node controller owns its per-user state and children.
final class OpenNovaDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private let statusLabel = NSTextField(wrappingLabelWithString: "正在准备 OpenNova…")
    private let asrKey = NSSecureTextField()
    private let ttsKey = NSSecureTextField()
    private let proxyField = NSTextField()
    private let logView = NSTextView()
    private var controller: Process?
    private var controllerInput: FileHandle?
    private var stdoutBuffer = Data()
    private let outputQueue = DispatchQueue(label: "local.opennova.controller-output")
    private var pendingTermination = false
    private var logsURL: URL
    private var dataURL: URL
    private var runnerURL: URL
    private var nodeURL: URL
    private var statusItem: NSStatusItem?

    override init() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        dataURL = ProcessInfo.processInfo.environment["OPENNOVA_APP_DATA"].map { URL(fileURLWithPath: $0) }
            ?? home.appendingPathComponent("Library/Application Support/OpenNova", isDirectory: true)
        logsURL = dataURL.appendingPathComponent("logs", isDirectory: true)
        let resources = Bundle.main.resourceURL!
        runnerURL = resources.appendingPathComponent("app/packaging/macos/runner.mjs")
        nodeURL = resources.appendingPathComponent("runtime/bin/node")
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenu()
        buildWindow()
        launchController()
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setupMenu() {
        let menu = NSMenu()
        let root = NSMenuItem()
        let app = NSMenu()
        app.addItem(withTitle: "显示 OpenNova 控制面板", action: #selector(showWindow), keyEquivalent: "0").target = self
        app.addItem(NSMenuItem.separator())
        app.addItem(withTitle: "隐藏 OpenNova", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(NSMenuItem.separator())
        app.addItem(withTitle: "退出 OpenNova", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        root.submenu = app
        menu.addItem(root)
        let editRoot = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editRoot.submenu = edit
        menu.addItem(editRoot)
        NSApp.mainMenu = menu
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem?.button?.title = "Nova"
        let statusMenu = NSMenu()
        statusMenu.addItem(withTitle: "显示控制面板", action: #selector(showWindow), keyEquivalent: "").target = self
        statusMenu.addItem(withTitle: "打开 OpenNova 对话", action: #selector(openChat), keyEquivalent: "").target = self
        statusMenu.addItem(NSMenuItem.separator())
        statusMenu.addItem(withTitle: "退出 OpenNova", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        statusItem?.menu = statusMenu
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        return button
    }

    private func row(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 10
        return stack
    }

    private func fieldRow(_ title: String, _ field: NSTextField) -> NSStackView {
        let label = NSTextField(labelWithString: title)
        label.widthAnchor.constraint(equalToConstant: 128).isActive = true
        field.widthAnchor.constraint(greaterThanOrEqualToConstant: 380).isActive = true
        field.heightAnchor.constraint(equalToConstant: 25).isActive = true
        return row([label, field])
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "OpenNova · 内部测试版"
        window.minSize = NSSize(width: 640, height: 720)
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        let title = NSTextField(labelWithString: "OpenNova")
        title.font = .systemFont(ofSize: 30, weight: .semibold)
        let intro = NSTextField(wrappingLabelWithString: "在这台 Mac 上登录、配置并启动你的助手。首次启动使用文字模式，语音由对话窗口中的开关控制。")
        intro.textColor = .secondaryLabelColor
        intro.font = .systemFont(ofSize: 13)
        statusLabel.font = .systemFont(ofSize: 13, weight: .medium)
        statusLabel.textColor = .secondaryLabelColor
        let instructions = NSTextField(wrappingLabelWithString: "首次使用：① 登录 ChatGPT  ② 启动服务并打开对话  ③ 配对 Chrome 扩展。\n需要语音时保存下方密钥，再到对话窗口点击“开启语音”。")
        instructions.font = .systemFont(ofSize: 13)
        let voiceTitle = NSTextField(labelWithString: "语音与网络设置")
        voiceTitle.font = .systemFont(ofSize: 15, weight: .semibold)
        asrKey.placeholderString = "豆包 ASR API Key"
        ttsKey.placeholderString = "选填；留空可使用 ASR 密钥的 TTS 权限"
        proxyField.placeholderString = "可选，例如 http://127.0.0.1:7897"
        let keyNote = NSTextField(wrappingLabelWithString: "密钥只保存到本机用户配置；已有密钥不会显示，留空保留。修改代理后请停止服务再启动。")
        keyNote.font = .systemFont(ofSize: 11)
        keyNote.textColor = .secondaryLabelColor
        let footer = NSTextField(wrappingLabelWithString: "关闭此窗口会保留服务；使用“退出 OpenNova”停止本次启动的服务。浏览器需安装 Google Chrome。")
        footer.font = .systemFont(ofSize: 11)
        footer.textColor = .secondaryLabelColor
        let logTitle = NSTextField(labelWithString: "运行状态")
        logTitle.font = .systemFont(ofSize: 13, weight: .medium)
        let scroll = NSScrollView()
        scroll.borderType = .bezelBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        logView.isEditable = false
        logView.isSelectable = true
        logView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        logView.textContainerInset = NSSize(width: 8, height: 8)
        logView.autoresizingMask = [.width]
        logView.isVerticallyResizable = true
        logView.isHorizontallyResizable = false
        logView.textContainer?.widthTracksTextView = true
        scroll.documentView = logView
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 120).isActive = true
        let stack = NSStackView(views: [title, intro, statusLabel,
            row([button("启动服务", #selector(startService)), button("打开 OpenNova 对话", #selector(openChat)), button("停止服务", #selector(stopService))]),
            row([button("登录 ChatGPT", #selector(authorize)), button("连接浏览器扩展", #selector(pairBrowser))]),
            instructions, voiceTitle, fieldRow("豆包 ASR 密钥", asrKey), fieldRow("豆包 TTS 密钥", ttsKey),
            fieldRow("网络代理", proxyField), keyNote,
            row([button("保存设置", #selector(saveSettings)), button("打开数据目录", #selector(openData)), button("打开日志", #selector(openLogs))]),
            logTitle, scroll, footer])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -22),
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            intro.widthAnchor.constraint(equalTo: stack.widthAnchor),
            instructions.widthAnchor.constraint(equalTo: stack.widthAnchor),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor),
            keyNote.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        window.makeKeyAndOrderFront(nil)
    }

    private func launchController() {
        guard FileManager.default.isExecutableFile(atPath: nodeURL.path), FileManager.default.fileExists(atPath: runnerURL.path) else {
            statusLabel.stringValue = "安装文件不完整，请重新复制 OpenNova.app。"
            return
        }
        let process = Process()
        let input = Pipe(), output = Pipe(), errors = Pipe()
        process.executableURL = nodeURL
        process.arguments = [runnerURL.path]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        process.environment = ProcessInfo.processInfo.environment
        process.currentDirectoryURL = runnerURL.deletingLastPathComponent()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            self?.outputQueue.async { [weak self] in self?.consume(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { [weak self] in self?.appendLog(text) }
        }
        process.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.controller = nil
                self.controllerInput = nil
                if self.pendingTermination { NSApp.reply(toApplicationShouldTerminate: true) }
                else { self.statusLabel.stringValue = "应用控制器已退出（\(child.terminationStatus)），请重新打开 OpenNova。" }
            }
        }
        do {
            try process.run()
            controller = process
            controllerInput = input.fileHandleForWriting
        } catch {
            statusLabel.stringValue = "无法启动 OpenNova。"
            appendLog(error.localizedDescription)
        }
    }

    private func consume(_ data: Data) {
        stdoutBuffer.append(data)
        while let newline = stdoutBuffer.firstIndex(of: 10) {
            let line = Data(stdoutBuffer[..<newline])
            stdoutBuffer.removeSubrange(...newline)
            if let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                DispatchQueue.main.async { [weak self] in self?.receive(event) }
            } else if !line.isEmpty {
                let text = String(decoding: line, as: UTF8.self)
                DispatchQueue.main.async { [weak self] in self?.appendLog(text) }
            }
        }
        if stdoutBuffer.count > 1_000_000 { stdoutBuffer.removeAll() }
    }

    private func receive(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "status":
            statusLabel.stringValue = event["text"] as? String ?? ""
            statusLabel.textColor = (event["state"] as? String == "ready") ? .systemGreen : .secondaryLabelColor
        case "settings":
            proxyField.stringValue = event["proxy"] as? String ?? ""
            asrKey.placeholderString = (event["hasAsrKey"] as? Bool == true) ? "已保存；留空保留" : "豆包 ASR API Key"
            ttsKey.placeholderString = (event["hasTtsKey"] as? Bool == true) ? "已保存；留空保留" : "选填；留空可使用 ASR 密钥的 TTS 权限"
        case "paths":
            if let path = event["data"] as? String { dataURL = URL(fileURLWithPath: path) }
            if let path = event["logs"] as? String { logsURL = URL(fileURLWithPath: path) }
        case "pairing": showPairing(event)
        case "open-url":
            if let raw = event["url"] as? String, let url = URL(string: raw), url.scheme == "http", url.host == "127.0.0.1", url.path == "/login" {
                NSWorkspace.shared.open(url)
            }
        case "notice":
            appendLog(event["text"] as? String ?? "")
        case "error":
            let message = event["text"] as? String ?? "操作未完成。"
            appendLog(message)
            statusLabel.stringValue = message
            statusLabel.textColor = .systemOrange
        default: appendLog(event["text"] as? String ?? "")
        }
    }

    private func appendLog(_ text: String) {
        guard !text.isEmpty else { return }
        let stamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        logView.textStorage?.append(NSAttributedString(string: "[\(stamp)] \(text)\n", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)]))
        if logView.string.utf16.count > 80000 {
            logView.textStorage?.deleteCharacters(in: NSRange(location: 0, length: logView.string.utf16.count - 60000))
        }
        logView.scrollToEndOfDocument(nil)
    }

    private func send(_ action: String, extra: [String: Any] = [:]) {
        guard let input = controllerInput, controller?.isRunning == true else {
            statusLabel.stringValue = "控制器未运行，请退出并重新打开应用。"
            return
        }
        var message = extra
        message["action"] = action
        do {
            var data = try JSONSerialization.data(withJSONObject: message)
            data.append(10)
            try input.write(contentsOf: data)
        } catch { appendLog("无法发送应用操作，请重新打开 OpenNova。") }
    }

    private func showPairing(_ event: [String: Any]) {
        let code = event["code"] as? String ?? ""
        let service = event["url"] as? String ?? ""
        let extensionPath = event["extensionPath"] as? String ?? ""
        let alert = NSAlert()
        alert.messageText = "连接 Chrome 扩展"
        alert.informativeText = "在 Chrome 打开 chrome://extensions，开启开发者模式，点击“加载已解压的扩展程序”并选择扩展目录。\n\n在扩展的选项页面填入服务地址和一次性配对码。配对码有效期 60 秒；过期后重新点击“连接浏览器扩展”。"
        let details = NSTextView(frame: NSRect(x: 0, y: 0, width: 500, height: 130))
        details.isEditable = false
        details.isSelectable = true
        details.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        details.string = "服务地址：\(service)\n\n配对码：\(code)\n\n扩展目录：\(extensionPath)"
        alert.accessoryView = details
        alert.addButton(withTitle: "复制配对码并显示扩展目录")
        alert.addButton(withTitle: "关闭")
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
                NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: extensionPath)
            }
        }
    }

    @objc private func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc private func startService() { send("start") }
    @objc private func openChat() { send("open") }
    @objc private func stopService() { send("stop") }
    @objc private func authorize() { send("authorize") }
    @objc private func pairBrowser() { send("pair") }
    @objc private func openData() { NSWorkspace.shared.open(dataURL) }
    @objc private func openLogs() { NSWorkspace.shared.open(logsURL) }
    @objc private func saveSettings() {
        send("save-settings", extra: ["asrKey": asrKey.stringValue, "ttsKey": ttsKey.stringValue, "proxy": proxyField.stringValue])
        asrKey.stringValue = ""; ttsKey.stringValue = ""
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard controller?.isRunning == true else { return .terminateNow }
        if pendingTermination { return .terminateLater }
        pendingTermination = true
        statusLabel.stringValue = "正在退出并清理本次启动的服务…"
        send("quit")
        DispatchQueue.main.asyncAfter(deadline: .now() + 35) { [weak self] in
            guard let self = self, self.pendingTermination else { return }
            self.controller?.terminate()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

if CommandLine.arguments.contains("--diagnose") {
    let resources = Bundle.main.resourceURL!
    let process = Process()
    process.executableURL = resources.appendingPathComponent("runtime/bin/node")
    process.arguments = [resources.appendingPathComponent("app/packaging/macos/runner.mjs").path, "--diagnose"]
    process.standardOutput = FileHandle.standardOutput
    process.standardError = FileHandle.standardError
    do { try process.run(); process.waitUntilExit(); exit(process.terminationStatus) }
    catch { FileHandle.standardError.write(Data("OpenNova 安装文件不完整：\(error.localizedDescription)\n".utf8)); exit(1) }
}
let app = NSApplication.shared
let delegate = OpenNovaDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
