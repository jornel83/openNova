import Foundation

@main struct DeviceTests {
    static func main() throws {
        let devices = [
            AudioDevice(id: 1, name: "MacBook Air麦克风", inputChannels: 1, outputChannels: 0, builtin: true),
            AudioDevice(id: 2, name: "SRS-XB100", inputChannels: 1, outputChannels: 0, builtin: false),
            AudioDevice(id: 3, name: "SRS-XB100", inputChannels: 0, outputChannels: 2, builtin: false),
            AudioDevice(id: 4, name: "USB Mic A", inputChannels: 1, outputChannels: 0, builtin: false),
            AudioDevice(id: 5, name: "USB Mic B", inputChannels: 1, outputChannels: 0, builtin: false)
        ]
        let input = try selectDevice("SRS-XB100", input: true, defaultID: 1, devices: devices)
        precondition(input.id == 2, "Same-name Bluetooth input/output must resolve by direction")
        let output = try selectDevice("SRS-XB100", input: false, defaultID: 3, devices: devices)
        precondition(output.id == 3)
        let builtin = try selectDevice("MacBook Air 麦克风", input: true, defaultID: 2, devices: devices)
        precondition(builtin.id == 1, "Device names tolerate spaces")
        let fallback = try selectDevice(nil, input: true, defaultID: 2, devices: devices)
        precondition(fallback.id == 2, "Omitted input follows system default")
        for (name, direction) in [("missing", true), ("MacBook Air麦克风", false), ("USB Mic", true)] {
            do {
                _ = try selectDevice(name, input: direction, defaultID: 1, devices: devices)
                preconditionFailure("Missing, wrong-direction or ambiguous device must not fall back")
            } catch {}
        }
        print("Audio device selection: 7 checks passed")
    }
}
