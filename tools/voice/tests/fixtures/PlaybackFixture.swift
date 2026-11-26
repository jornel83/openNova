// Uses the production queue with controlled playback callbacks. No AVFoundation,
// input device, output device, microphone permission or network access.
import Foundation

@main struct PlaybackFixture {
    static func main() {
        let queue = PlaybackQueue()
        var pending: [(Int, Int, Int)] = []
        func emit(_ value: [String: Any]) {
            let data = try! JSONSerialization.data(withJSONObject: value)
            FileHandle.standardOutput.write(data + Data([10]))
        }
        emit(["type":"ready", "voice_processing":true, "input":"fixture", "output":"fixture"])
        while let line = readLine() {
            let request = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
            let kind = request["type"] as! String
            var accepted = true
            switch kind {
            case "clear": queue.clear(generation: request["generation"] as! Int)
            case "pause": queue.paused = true
            case "resume": queue.paused = false
            case "pcm":
                let generation = request["generation"] as! Int
                let count = Data(base64Encoded: request["data"] as! String)!.count/2
                accepted = queue.reserve(generation: generation, count: count)
                if accepted { pending.append((generation, request["segment"] as! Int, count)) }
            case "fixture_receipt":
                if !pending.isEmpty {
                    let (generation,segment,count) = pending.removeFirst()
                    queue.complete(generation: generation,count: count)
                    emit(["type":"played","generation":generation,"segment":segment,"frames":queue.frames,
                          "playback":queue.frames == 0 ? "idle" : "playing"])
                }
            default: break
            }
            emit(["type":"ack", "rid":request["rid"]!, "accepted":accepted,
                  "generation":queue.generation, "frames":queue.frames,
                  "playback":queue.frames == 0 ? "idle" : queue.paused ? "paused" : "playing"])
        }
    }
}
