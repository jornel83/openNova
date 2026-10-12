import Foundation

@main struct QueueTests {
    static func main() {
        let q = PlaybackQueue()
        precondition(q.reserve(generation: 0, count: 24_000), "first PCM must be admitted")
        precondition(!q.reserve(generation: 0, count: 48_001), "queue must be bounded")
        q.paused = true
        q.clear(generation: 1)
        precondition(q.frames == 0 && !q.paused, "clear must flush buffered state")
        precondition(!q.reserve(generation: 0, count: 100), "late old PCM must be rejected")
        precondition(q.reserve(generation: 1, count: 200), "new generation must play")
        q.complete(generation: 0, count: 100)
        precondition(q.frames == 200, "old completion must not consume new credits")
        q.complete(generation: 1, count: 200)
        precondition(q.frames == 0)
        print("Playback queue: 7 checks passed")
    }
}
