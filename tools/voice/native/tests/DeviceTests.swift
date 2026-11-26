import Foundation

@main struct DeviceTests {
    static func main() throws {
        let devices = [
            AudioDevice(id: 1, name: "MacBook Air麦克风", uid: "builtin-mic", inputChannels: 1, outputChannels: 0, builtin: true),
            AudioDevice(id: 2, name: "SRS-XB100", uid: "bluetooth-mic", inputChannels: 1, outputChannels: 0, builtin: false),
            AudioDevice(id: 3, name: "SRS-XB100", uid: "bluetooth-speaker", inputChannels: 0, outputChannels: 2, builtin: false),
            AudioDevice(id: 4, name: "USB Mic A", uid: "usb-mic-a", inputChannels: 1, outputChannels: 0, builtin: false),
            AudioDevice(id: 5, name: "USB Mic B", uid: "usb-mic-b", inputChannels: 1, outputChannels: 0, builtin: false),
            AudioDevice(id: 6, name: "USB Mic A", uid: "usb-mic-a-other", inputChannels: 1, outputChannels: 0, builtin: false)
        ]
        let input = try selectDevice("SRS-XB100", input: true, defaultID: 1, devices: devices)
        precondition(input.id == 2, "Same-name Bluetooth input/output must resolve by direction")
        let output = try selectDevice("SRS-XB100", input: false, defaultID: 3, devices: devices)
        precondition(output.id == 3)
        let builtin = try selectDevice("MacBook Air 麦克风", input: true, defaultID: 2, devices: devices)
        precondition(builtin.id == 1, "Device names tolerate spaces")
        let fallback = try selectDevice(nil, input: true, defaultID: 2, devices: devices)
        precondition(fallback.id == 2, "Omitted input follows system default")
        let sameName = try selectDevice("uid:usb-mic-a-other", input: true, defaultID: 1, devices: devices)
        precondition(sameName.id == 6, "Stable UID distinguishes identical device names")
        let uidOutput = try selectDevice("uid:bluetooth-speaker", input: false, defaultID: 1, devices: devices)
        precondition(uidOutput.id == 3, "Stable UID selects the exact output")
        for (name, direction) in [("missing", true), ("MacBook Air麦克风", false), ("USB Mic", true),
                                  ("USB Mic A", true), ("uid:bluetooth-speaker", true),
                                  ("uid:usb-mic-a", false), ("uid:disconnected", true)] {
            do {
                _ = try selectDevice(name, input: direction, defaultID: 1, devices: devices)
                preconditionFailure("Missing, wrong-direction or ambiguous device must not fall back")
            } catch {}
        }
        print("Audio device selection: 13 checks passed")
    }
}
