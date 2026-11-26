// The host keeps this helper alive so an app switch to Nova's browser has a witnessed predecessor.
// Capture reads document/window metadata only. No Apple Events or permission prompts are issued.
import AppKit
import ApplicationServices
import Darwin
import Foundation

struct Issue: Error {
    let status: String
    let reason: String
    init(_ reason: String, _ status: String = "unavailable") { self.status = status; self.reason = reason }
}

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}

func documentURL(_ value: CFTypeRef?) -> URL? {
    if let url = value as? URL { return url }
    guard let string = value as? String, !string.isEmpty else { return nil }
    return string.hasPrefix("/") ? URL(fileURLWithPath: string) : URL(string: string)
}

struct LocalFile: Equatable {
    let path: String
    let device: dev_t
    let inode: ino_t
    init(_ url: URL) throws {
        guard url.isFileURL, ["", "localhost"].contains(url.host ?? ""), url.path.hasPrefix("/") else {
            throw Issue("not_a_local_file", "unsupported")
        }
        let path = url.resolvingSymlinksInPath().path
        var st = stat()
        guard stat(path, &st) == 0, st.st_mode & S_IFMT == S_IFREG else { throw Issue("document_file_missing") }
        self.path = path; device = st.st_dev; inode = st.st_ino
    }
}

// WPS on macOS supplies the filename on its focused window, but sometimes no AXDocument.
// Only inspect this exact PID's live file descriptors, never search disks or recent-file lists.
func wpsFile(pid: pid_t, title: String) throws -> LocalFile {
    guard title == (title as NSString).lastPathComponent, !(title as NSString).pathExtension.isEmpty else {
        throw Issue("no_document_path")
    }
    let stride = MemoryLayout<proc_fdinfo>.stride
    let bytesNeeded = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
    guard bytesNeeded > 0, Int(bytesNeeded)/stride < 16384 else { throw Issue("open_file_identity_unavailable") }
    var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(bytesNeeded)/stride + 32)
    let bytes = fds.withUnsafeMutableBytes { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, $0.baseAddress, Int32($0.count)) }
    guard bytes > 0, Int(bytes) < fds.count * stride, Int(bytes) % stride == 0 else {
        throw Issue("open_file_identity_unavailable")
    }
    var match: LocalFile?
    for fd in fds.prefix(Int(bytes)/stride) where fd.proc_fdtype == PROX_FDTYPE_VNODE {
        var vnode = vnode_fdinfowithpath()
        let count = withUnsafeMutableBytes(of: &vnode) {
            proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDVNODEPATHINFO, $0.baseAddress, Int32($0.count))
        }
        guard count == MemoryLayout<vnode_fdinfowithpath>.size else {
            if errno == EBADF || errno == ENOENT { continue } // FD closed during enumeration.
            throw Issue("open_file_identity_unavailable")
        }
        let st = vnode.pvip.vip_vi.vi_stat
        guard st.vst_mode & S_IFMT == S_IFREG else { continue }
        let path = withUnsafeBytes(of: &vnode.pvip.vip_path) {
            String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        guard path.hasPrefix("/"), (path as NSString).lastPathComponent == title else { continue }
        let file = try LocalFile(URL(fileURLWithPath: path))
        guard st.vst_dev == file.device, st.vst_ino == file.inode else { throw Issue("open_file_identity_changed") }
        if let previous = match, previous != file { throw Issue("same_name_open_files", "ambiguous") }
        match = file
    }
    guard let file = match else { throw Issue("no_document_path") }
    return file
}

func focusedWindow(_ app: AXUIElement, browserSurface: Bool = false) throws -> AXUIElement {
    guard let ref = attribute(app, kAXFocusedWindowAttribute), CFGetTypeID(ref) == AXUIElementGetTypeID() else {
        throw Issue("no_document_window")
    }
    let window = ref as! AXUIElement
    // Chrome exposes ordinary tabs and popup/app-style chat windows with varying subroles.
    // The document window itself must always be verified as a non-minimized standard window.
    guard attribute(window, kAXRoleAttribute) as? String == kAXWindowRole,
          browserSurface || attribute(window, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole,
          browserSurface ? attribute(window, kAXMinimizedAttribute) as? Bool != true : attribute(window, kAXMinimizedAttribute) as? Bool == false,
          attribute(window, kAXModalAttribute) as? Bool != true else { throw Issue("no_document_window") }
    return window
}

struct ViewedFile {
    let window: AXUIElement
    let file: LocalFile
}
func viewedFile(_ app: NSRunningApplication) throws -> ViewedFile {
    guard AXIsProcessTrusted() else { throw Issue("accessibility_required", "permission_required") }
    guard !app.isTerminated, !app.isHidden, app.activationPolicy == .regular else { throw Issue("no_document_window") }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 0.3)
    let window = try focusedWindow(element)
    let file: LocalFile
    if let url = documentURL(attribute(window, kAXDocumentAttribute)) {
        file = try LocalFile(url)
        guard documentURL(attribute(window, kAXDocumentAttribute)) == url else { throw Issue("document_window_changed") }
    } else if app.bundleIdentifier == "com.kingsoft.wpsoffice.mac", let title = attribute(window, kAXTitleAttribute) as? String {
        guard let windows = attribute(element, kAXWindowsAttribute) as? [AXUIElement] else { throw Issue("no_document_window") }
        if windows.contains(where: { !CFEqual($0, window) && attribute($0, kAXTitleAttribute) as? String == title }) {
            throw Issue("same_name_open_windows", "ambiguous")
        }
        file = try wpsFile(pid: app.processIdentifier, title: title)
        guard attribute(window, kAXTitleAttribute) as? String == title else { throw Issue("document_window_changed") }
    } else { throw Issue("no_document_path") }
    guard CFEqual(window, try focusedWindow(element)) else { throw Issue("document_window_changed") }
    return ViewedFile(window: window, file: file)
}

let browsers: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "com.google.chrome.for.testing",
    "com.microsoft.edgemac", "com.brave.Browser", "com.apple.Safari", "org.mozilla.firefox",
    "company.thebrowser.Browser"
]
func browser(_ app: NSRunningApplication?) -> Bool { browsers.contains(app?.bundleIdentifier ?? "") }

final class Tracker {
    var active = NSWorkspace.shared.frontmostApplication
    var previous: NSRunningApplication?
    var previousView: Result<ViewedFile, Error>?
    var observer: NSObjectProtocol?
    var lastActivation = Date.distantPast

    func start() {
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            self?.activated(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
        }
    }
    func activated(_ next: NSRunningApplication?) {
        guard next?.processIdentifier != active?.processIdentifier else { return }
        lastActivation = Date()
        previous = nil; previousView = nil
        if browser(next), let old = active, !browser(old) {
            previous = old
            previousView = Result { try viewedFile(old) }
        }
        active = next
    }
    func capture(fromWeb: Bool, port: Int?, sentMs: Double) throws -> [String: Any] {
        activated(NSWorkspace.shared.frontmostApplication)
        let now = Date().timeIntervalSince1970 * 1000
        guard sentMs >= floor(lastActivation.timeIntervalSince1970 * 1000), now - sentMs < 300, now >= sentMs else {
            throw Issue("document_window_changed")
        }
        guard let front = active else { throw Issue("no_frontmost_app") }
        // A real web submission originates in Nova's browser. If another app has
        // already taken focus since sending, never bind to its newly opened document.
        if fromWeb && !browser(front) { throw Issue("browser_not_showing_nova") }
        let app: NSRunningApplication
        let view: ViewedFile
        if browser(front) {
            guard AXIsProcessTrusted() else { throw Issue("accessibility_required", "permission_required") }
            let element = AXUIElementCreateApplication(front.processIdentifier)
            AXUIElementSetMessagingTimeout(element, 0.3)
            let window = try focusedWindow(element, browserSurface:true)
            if let browserURL = documentURL(attribute(window, kAXDocumentAttribute)) {
                guard browserURL.scheme == "http", ["localhost","127.0.0.1","::1"].contains(browserURL.host ?? ""),
                      port != nil, browserURL.port == port, browserURL.path == "/" || browserURL.path.isEmpty else {
                    throw Issue("browser_not_showing_nova")
                }
            } else if !fromWeb { throw Issue("browser_not_showing_nova") }
            guard let prior = previous, let snapshot = previousView else { throw Issue("no_witnessed_document") }
            let before = try snapshot.get()
            let now = try viewedFile(prior)
            guard CFEqual(before.window, now.window), before.file == now.file else { throw Issue("document_window_changed") }
            app = prior; view = now
        } else { app = front; view = try viewedFile(front) }
        guard front.processIdentifier == NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            throw Issue("document_window_changed")
        }
        return ["status": "available", "path": view.file.path, "device": String(view.file.device),
                "inode": String(view.file.inode), "app": app.localizedName ?? app.bundleIdentifier ?? ""]
    }
}

func runTracker() {
    let tracker = Tracker()
    tracker.start()
    FileHandle.standardOutput.write(Data("{\"ready\":true}\n".utf8))
    // stdin is a private pipe from this Bot. EOF also terminates the helper on host crash.
    DispatchQueue.global().async {
        while let line = readLine() {
            guard let item = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
                  let id = item["id"] as? Int, let sentMs = item["sentMs"] as? Double else { continue }
            DispatchQueue.main.async {
                var output: [String: Any]
                do { output = try tracker.capture(fromWeb: item["web"] as? Bool == true, port: item["port"] as? Int, sentMs: sentMs) }
                catch let issue as Issue { output = ["status": issue.status, "reason": issue.reason] }
                catch { output = ["status": "unavailable", "reason": "desktop_document_unavailable"] }
                output["id"] = id
                if var data = try? JSONSerialization.data(withJSONObject: output) {
                    data.append(10); FileHandle.standardOutput.write(data)
                }
            }
        }
        DispatchQueue.main.async { exit(0) }
    }
    RunLoop.main.run()
}
#if !ACTIVE_DOCUMENT_TEST
runTracker()
#endif
