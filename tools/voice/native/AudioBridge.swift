import Foundation
import AVFoundation
import CoreAudio
import Synchronization
import Darwin

// Single audio-tap producer, single control-queue consumer. No I/O or allocation in push.
@available(macOS 15.0, *)
final class CaptureRing {
    let capacity = 192_000
    let samples: UnsafeMutablePointer<Float>
    let written = Atomic<Int>(0)
    let read = Atomic<Int>(0)
    let overflow = Atomic<Bool>(false)
    let enabled = Atomic<Bool>(true)
    let writing = Atomic<Bool>(false)
    let skipNext = Atomic<Bool>(false)
    init() { samples = .allocate(capacity: capacity) }
    deinit { samples.deallocate() }
    func push(_ data: UnsafePointer<Float>, count: Int, stride: Int) {
        writing.store(true, ordering: .releasing)
        defer { writing.store(false, ordering: .releasing) }
        guard enabled.load(ordering: .acquiring) else { return }
        if skipNext.exchange(false, ordering: .acquiringAndReleasing) { return }
        let w = written.load(ordering: .relaxed)
        let r = read.load(ordering: .acquiring)
        guard count <= capacity - (w-r) else { overflow.store(true, ordering: .releasing); return }
        for i in 0..<count { samples[(w+i) % capacity] = data[i*stride] }
        written.store(w+count, ordering: .releasing)
    }
    func take(_ maximum: Int) -> [Float] {
        let r = read.load(ordering: .relaxed)
        let count = min(maximum, written.load(ordering: .acquiring)-r)
        let result = (0..<count).map { samples[(r+$0) % capacity] }
        read.store(r+count, ordering: .releasing)
        return result
    }
    func discard() { read.store(written.load(ordering: .acquiring), ordering: .releasing) }
    func suspend() -> Bool {
        enabled.store(false, ordering: .releasing)
        // Wait on the control queue only. The audio callback never waits or locks.
        for _ in 0..<1000 {
            if !writing.load(ordering: .acquiring) {
                discard()
                skipNext.store(true, ordering: .releasing)
                return true
            }
            usleep(50)
        }
        return false
    }
}

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, initial: T) -> T {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var result = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &result) {
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
    }
    return status == noErr ? result : initial
}

func deviceInfo(_ selector: AudioObjectPropertySelector) -> (AudioObjectID, String, Bool) {
    let id: AudioObjectID = property(AudioObjectID(kAudioObjectSystemObject), selector, initial: 0)
    let name: CFString = property(id, kAudioObjectPropertyName, initial: "unknown" as CFString)
    let transport: UInt32 = property(id, kAudioDevicePropertyTransportType, initial: 0)
    return (id, name as String, transport == kAudioDeviceTransportTypeBuiltIn)
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

@available(macOS 15.0, *)
final class AudioBridge {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let ring = CaptureRing()
    let queue = PlaybackQueue()
    let outputFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    var sourceFormat: AVAudioFormat!
    var captureFormat: AVAudioFormat!
    var converter: AVAudioConverter!
    var timer: DispatchSourceTimer?
    var inputID: AudioObjectID = 0
    var outputID: AudioObjectID = 0
    var epoch = 0
    var alive = true
    var checkTick = 0
    var hasTap = false

    func start() throws {
        let input = deviceInfo(kAudioHardwarePropertyDefaultInputDevice)
        let output = deviceInfo(kAudioHardwarePropertyDefaultOutputDevice)
        guard input.2 && output.2 else { throw NSError(domain: "builtin_route_required", code: 1) }
        inputID = input.0; outputID = output.0
        try engine.inputNode.setVoiceProcessingEnabled(true)
        guard engine.inputNode.isVoiceProcessingEnabled else { throw NSError(domain: "voice_processing_unavailable", code: 1) }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: outputFormat)
        let hardware = engine.inputNode.outputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0, hardware.commonFormat == .pcmFormatFloat32 else {
            throw NSError(domain: "input_format_unavailable", code: 1)
        }
        sourceFormat = AVAudioFormat(standardFormatWithSampleRate: hardware.sampleRate, channels: 1)!
        captureFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
        converter = AVAudioConverter(from: sourceFormat, to: captureFormat)
        guard converter != nil else { throw NSError(domain: "capture_converter_unavailable", code: 1) }
        let ring = self.ring
        engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: hardware) { buffer, _ in
            guard let data = buffer.floatChannelData?[0] else { return }
            ring.push(data, count: Int(buffer.frameLength), stride: buffer.format.isInterleaved ? Int(buffer.format.channelCount) : 1)
        }
        hasTap = true
        engine.prepare()
        try engine.start()
        player.play()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(10))
        timer.setEventHandler { [weak self] in self?.drainCapture() }
        timer.resume(); self.timer = timer
        emit(["type":"ready", "voice_processing":true, "input":input.1, "output":output.1, "sample_rate":16000])
    }

    func fail(_ code: String) {
        guard alive else { return }
        ring.enabled.store(false, ordering: .releasing)
        player.stop(); engine.stop(); timer?.cancel()
        alive = false
        emit(["type":"error", "code":code])
    }

    func drainCapture() {
        guard alive else { return }
        if ring.overflow.load(ordering: .acquiring) { fail("capture_overflow"); return }
        checkTick += 1
        if checkTick % 100 == 0 {
            if deviceInfo(kAudioHardwarePropertyDefaultInputDevice).0 != inputID ||
               deviceInfo(kAudioHardwarePropertyDefaultOutputDevice).0 != outputID || !engine.isRunning {
                fail("audio_route_changed"); return
            }
        }
        let samples = ring.take(4096)
        guard !samples.isEmpty, ring.enabled.load(ordering: .acquiring) else { return }
        let input = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(samples.count))!
        input.frameLength = input.frameCapacity
        samples.withUnsafeBufferPointer { input.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        let capacity = AVAudioFrameCount(ceil(Double(samples.count) * 16000 / sourceFormat.sampleRate) + 32)
        let output = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: capacity)!
        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return input
        }
        if error != nil { fail("capture_conversion_failed"); return }
        if output.frameLength > 0 {
            let pcm = Data(bytes: output.int16ChannelData![0], count: Int(output.frameLength)*2)
            emit(["type":"audio", "epoch":epoch, "data":pcm.base64EncodedString()])
        }
    }

    func command(_ request: [String: Any]) {
        let rid = request["rid"] as? Int ?? 0
        let type = request["type"] as? String ?? ""
        var response: [String: Any] = ["type":"ack", "rid":rid, "frames":queue.frames]
        if type == "close" { shutdown(); exit(0) }
        guard alive else { emit(["type":"error", "rid":rid, "code":"audio_unavailable"]); return }
        switch type {
        case "capture":
            let enabled = request["enabled"] as? Bool ?? false
            guard ring.suspend() else { fail("capture_transition_failed"); return }
            converter.reset()
            epoch = request["epoch"] as? Int ?? epoch+1
            ring.enabled.store(enabled, ordering: .releasing)
        case "pause": queue.paused = true; player.pause()
        case "resume": queue.paused = false; player.play()
        case "clear":
            let generation = request["generation"] as? Int ?? queue.generation+1
            guard generation >= queue.generation else { emit(response); return }
            queue.clear(generation: generation)
            player.stop(); player.play()
        case "pcm":
            guard let generation = request["generation"] as? Int,
                  let encoded = request["data"] as? String, let data = Data(base64Encoded: encoded),
                  !data.isEmpty, data.count % 2 == 0, data.count <= 8192 else {
                emit(["type":"error", "rid":rid, "code":"invalid_pcm"]); return
            }
            let count = data.count/2
            guard queue.reserve(generation: generation, count: count) else {
                response["accepted"] = false; response["frames"] = queue.frames; emit(response); return
            }
            let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(count))!
            buffer.frameLength = buffer.frameCapacity
            data.withUnsafeBytes { bytes in
                for i in 0..<count {
                    let value = Int16(bitPattern: UInt16(bytes[i*2]) | UInt16(bytes[i*2+1]) << 8)
                    buffer.floatChannelData![0][i] = Float(value)/32768
                }
            }
            let segment = request["segment"] as? Int ?? 0
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self = self, generation == self.queue.generation else { return }
                    self.queue.complete(generation: generation, count: count)
                    emit(["type":"played", "generation":generation, "segment":segment, "frames":self.queue.frames])
                }
            }
            if !queue.paused && !player.isPlaying { player.play() }
            response["accepted"] = true
        default: emit(["type":"error", "rid":rid, "code":"invalid_audio_command"]); return
        }
        response["frames"] = queue.frames
        response["generation"] = queue.generation
        emit(response)
    }

    func shutdown() {
        timer?.cancel(); ring.enabled.store(false, ordering: .releasing)
        player.stop(); engine.stop()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        alive = false
    }
}

@main struct Main {
    static func main() {
        guard #available(macOS 15.0, *) else { emit(["type":"error", "code":"macos_15_required"]); exit(1) }
        if CommandLine.arguments.contains("--check") {
            let input = deviceInfo(kAudioHardwarePropertyDefaultInputDevice)
            let output = deviceInfo(kAudioHardwarePropertyDefaultOutputDevice)
            emit(["type":"check", "input":input.1, "output":output.1, "builtin_route":input.2 && output.2,
                  "authorization":AVCaptureDevice.authorizationStatus(for: .audio).rawValue, "capture_started":false])
            return
        }
        let bridge = AudioBridge()
        let start = {
            do { try bridge.start() }
            catch { emit(["type":"error", "code":(error as NSError).domain]); exit(1) }
        }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: start()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { allowed in
                DispatchQueue.main.async {
                    if allowed { start() } else { emit(["type":"error", "code":"microphone_permission_denied"]); exit(1) }
                }
            }
        default: emit(["type":"error", "code":"microphone_permission_denied"]); exit(1)
        }
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                guard line.utf8.count < 32_768, let data = line.data(using: .utf8),
                      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    DispatchQueue.main.async { bridge.fail("invalid_audio_protocol") }; continue
                }
                DispatchQueue.main.async { bridge.command(value) }
            }
            DispatchQueue.main.async { bridge.shutdown(); exit(0) }
        }
        signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { bridge.shutdown(); exit(0) }; term.resume()
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        interrupt.setEventHandler { bridge.shutdown(); exit(0) }; interrupt.resume()
        RunLoop.main.run()
    }
}
