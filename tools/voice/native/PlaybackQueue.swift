import Foundation

final class PlaybackQueue {
    var generation = 0
    var frames = 0
    var paused = false
    let limit = 48_000
    func reserve(generation: Int, count: Int) -> Bool {
        guard generation == self.generation, count > 0, frames + count <= limit else { return false }
        frames += count
        return true
    }
    func complete(generation: Int, count: Int) {
        if generation == self.generation { frames = max(0, frames - count) }
    }
    func clear(generation: Int) {
        self.generation = generation
        frames = 0
        paused = false
    }
}
