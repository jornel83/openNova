import Foundation
import CoreAudio

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, initial: T) -> T {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var result = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &result) {
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
    }
    return status == noErr ? result : initial
}

struct AudioDevice {
    let id: AudioObjectID
    let name: String
    let inputChannels: Int
    let outputChannels: Int
    let builtin: Bool
    var json: [String: Any] {
        ["id":id, "name":name, "input_channels":inputChannels,
         "output_channels":outputChannels, "builtin":builtin]
    }
}

func channels(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let storage = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { storage.deallocate() }
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, storage) == noErr else { return 0 }
    return UnsafeMutableAudioBufferListPointer(storage.assumingMemoryBound(to: AudioBufferList.self))
        .reduce(0) { $0 + Int($1.mNumberChannels) }
}

func audioDevices() -> [AudioDevice] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size)/MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.map { id in
        let name: CFString = property(id, kAudioObjectPropertyName, initial: "unknown" as CFString)
        let transport: UInt32 = property(id, kAudioDevicePropertyTransportType, initial: 0)
        return AudioDevice(id: id, name: name as String,
            inputChannels: channels(id, scope: kAudioDevicePropertyScopeInput),
            outputChannels: channels(id, scope: kAudioDevicePropertyScopeOutput),
            builtin: transport == kAudioDeviceTransportTypeBuiltIn)
    }
}

func defaultDevice(_ input: Bool) -> AudioObjectID {
    property(AudioObjectID(kAudioObjectSystemObject), input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice, initial: 0)
}

func selectDevice(_ requested: String?, input: Bool, defaultID: AudioObjectID, devices: [AudioDevice]) throws -> AudioDevice {
    let eligible = devices.filter { input ? $0.inputChannels > 0 : $0.outputChannels > 0 }
    guard let requested else {
        guard let device = eligible.first(where: { $0.id == defaultID }) else {
            throw NSError(domain: "audio_device_not_found", code: 1)
        }
        return device
    }
    func normalized(_ text: String) -> String { text.filter { !$0.isWhitespace }.lowercased() }
    let name = normalized(requested)
    guard !name.isEmpty else { throw NSError(domain: "audio_device_not_found", code: 1) }
    let exact = eligible.filter { normalized($0.name) == name }
    let matches = exact.isEmpty ? eligible.filter { normalized($0.name).contains(name) } : exact
    guard matches.count == 1 else {
        throw NSError(domain: matches.isEmpty ? "audio_device_not_found" : "audio_device_ambiguous", code: 1)
    }
    return matches[0]
}

struct DeviceOptions {
    var input: String?
    var output: String?
    var check = false
    var list = false
    init(_ arguments: [String]) throws {
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--check": check = true
            case "--list-devices": list = true
            case "--device", "--output-device":
                guard index + 1 < arguments.count else { throw NSError(domain: "invalid_device_arguments", code: 1) }
                if arguments[index] == "--device" { input = arguments[index + 1] }
                else { output = arguments[index + 1] }
                index += 1
            default: throw NSError(domain: "invalid_device_arguments", code: 1)
            }
            index += 1
        }
    }
    func resolve() throws -> (AudioDevice, AudioDevice) {
        let devices = audioDevices()
        return (try selectDevice(input, input: true, defaultID: defaultDevice(true), devices: devices),
                try selectDevice(output, input: false, defaultID: defaultDevice(false), devices: devices))
    }
}
