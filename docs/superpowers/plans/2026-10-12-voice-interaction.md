# Voice Interaction Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox tracking.

**Goal:** Implement the approved four-part desktop voice upgrade while retaining the original turn-taking demo.

**Architecture:** A Python continuous conversation controller consumes native macOS voice-processed PCM, manages ASR turns, and drives a streaming/cancellable Harness bridge. A bounded TTS producer feeds a generation-aware native player while capture remains active.

**Tech Stack:** Python 3.11+, existing Silero/Doubao/FFmpeg, Node 24, pinned DeepSeek Harness/SIWC, Swift AVAudioEngine, existing Studio Vivian HTTP PCM.

**Spec:** `docs/superpowers/specs/2026-10-12-voice-interaction-design.md` (user approved 2026-10-12).

## Global Constraints

- Air built-in microphone/speaker first; no tools, deployment migration, new voice or paid fallback.
- Vivian, existing model revision and voice prompt; 1.5× pitch-preserving playback.
- Final ASR only reaches the model; partial ASR replaces previous text.
- No raw microphone recording by default. Automated verification uses files and simulated boundaries; actual AEC requires live testing.
- Keep original conversation.py mode; new `--continuous` mode opts into new audio/control path.
- Preserve previous runtime fixes and unrelated source-tree changes. User explicitly requested development after design approval; continue implementation in this session.

## Review Focus

- Cancel before session creation / before first model chunk must not leak an old reply.
- Late PCM and completion callbacks after clear must not resurrect audio.
- ASR finishing while muted or superseded must not submit old speech.
- Failed/partial model or TTS output must not replay or stop subsequent turns.
- Native device/permission failure must not silently fall back to non-AEC full duplex.

## Task 1: Harness stream and cancellation

Files: `services/agent/voice-control.mjs`, `stream-worker.mjs`, `stream.patch.yml`, `tests/voice-control.test.mjs`; `tools/voice/stream_agent.py`.

Interfaces: worker JSONL accepts `{type:ask,id,text}` / `{type:cancel,id}` / `{type:close}`. Emits ready, delta(id,text,attemptId), reply(id,text,sessionId), cancelled(id), error(id,code,stage). Only one active request; cancel converges before accepting another ask. Plugin uses a private Unix socket, listens to `agent/assistant-stream`, and calls Agent.cancel + whenIdle.

- [x] RED tests: target scoping, cancelling before stream start, deltas after cancel, clean second turn, socket cleanup.
- [x] Implement plugin and asynchronous stdin dispatch; preserve checked final result and official auth.
- [x] GREEN Node suite; real pinned Harness cancellation + follow-up smoke.

## Task 2: Segmentation and streaming audio

Files: `tools/voice/segments.py`, `tts_stream.py`, `tests/test_streaming.py`.

Interfaces: SentenceBuffer.feed(text)->list[str], finish()->list[str]; async synthesize(text,url,speed)->PCM chunks. Only one TTS request at a time; controller prefetches into at most 2 seconds of native audio, with 8 queued text segments and 160 characters per segment.

- [x] RED: fragmented punctuation, decimal/English boundaries, long text tail, invalid/empty PCM, cancellation closes response/FFmpeg.
- [x] Implement incremental segmentation and asynchronous subprocess PCM transformation.
- [x] GREEN Python tests; real Vivian synthesis smoke without playback.

## Task 3: macOS audio helper

Files: `tools/voice/native/AudioBridge.swift`, `audio_bridge.py`, `tests/test_audio_bridge.py`.

Interfaces: JSONL commands capture(enabled), pcm(generation,segment,data), pause, resume, clear(generation), drain(segment), close. Emits ready(voice_processing), audio(base64 16k PCM), accepted/done, played(segment), error. Bounded buffering; all output routes through the same AVAudioEngine as voice-processed input. Build to ignored output using swiftc. Self-test mode validates routing/generation without microphone.

- [x] RED helper self-test: clear invalidates buffered old generation; pause/resume and playback credits obey bounds.
- [x] Implement Swift audio engine and Python process wrapper; no blocking IPC in input tap.
- [x] GREEN Swift compile/self-test and Python process tests; --check builds helper without starting capture.

## Task 4: Continuous turn controller

Files: `tools/voice/continuous.py`, `turns.py`, `controls.py`, `tests/test_continuous.py`; modify `doubao_asr.py` for optional transcript callback and `conversation.py` for opt-in mode.

Interfaces: continuous controller consumes audio frames and operator commands independently from active Agent/TTS work. Turn capture exposes start, partial, final, failed events carrying input epoch. SpeechGate retains pre-roll; normal silence 800ms, incomplete-text silence 1600ms, configurable within 200–3000ms. Candidate speech pauses output; valid partial/final confirms interruption. Empty/failed candidate restores still-valid output.

- [x] RED: same-turn continuation, ASR revisions, stale final after mute, false candidate resume, interruption invalidates old PCM, model/TTS error then next turn, explicit stop/quit.
- [x] Implement generation-aware controller and terminal line commands `/stop`, `/mute`, `/unmute`, `/end`, `/start`, `/retry`, `/quit`.
- [x] GREEN deterministic tests, file-driven continuous controller integration.

## Task 5: Integration and delivery

Files: voice/agent README, deployment status, launch helper and test fixtures.

- [x] Run ASR, voice, TTS, setup and Node regression suites; inspect results.
- [x] Run real two-turn file path and cancellation recovery; measure first delta/PCM and complete turns separately.
- [x] Review all changes with a fresh reviewer, fix material defects with regression tests.
- [x] Integrate into user's current feature checkout without unrelated changes; document exact launch command and remaining acoustic validation.

## Execution ledger

- Approved design and implementation request received. Worktree created from 4a60b68; pre-existing voice fixes copied as a separate baseline commit. No unrelated files or credentials copied.
- Ruling: implement inline and preserve the user's instruction to proceed; no repeat scope/implementation approval. Native microphone acoustic validation remains separately reported from automated tests.
- Pre-flight: Tasks 2/3 share generation-tagged PCM; Tasks 1/4 share request IDs and cancellation settlement; Task 4 owns all state transitions. No conflicting interfaces.

## Verification after implementation

2026-10-12: Python voice 47, ASR 26, TTS 10, setup 1; Node Agent 16; Swift queue 7 assertions, native helper compilation and no-capture device check passed. Real same-session cancellation and two-turn ASR→GPT→Vivian file tests passed. A six-sentence response delivered first PCM 2.48 s before the model completed. Three material lifecycle/failure review findings and the legacy CLI regression were reproduced and fixed with regression tests. Acoustic AEC/interrupt completeness, voice continuity and Studio GPU cancellation remain pending live validation.

Integrated into the original codex/voice-vad-tts checkout; the same 100 Python/Node tests and 7 Swift queue assertions passed there. Unrelated skills/ and tools/video/ were preserved. Local secrets remain ignored.
