# OpenNova Voice Conversation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run repeated VAD → Doubao ASR → DeepSeek Harness / GPT-6.1 Sol → Vivian turns, retaining conversation context and the selected 1.5× voice.

**Architecture:** A bounded Python desktop demo captures one utterance on Air, closes capture, waits for the final ASR result, submits it to a persistent Harness session, and streams Vivian from Studio. The first demo uses turn-taking; microphone capture resumes only after playback and a short echo-tail pause. Harness and the official SIWC client run on Air for this demo, where independent OpenNova authorization and Keychain storage work; migration to the planned Studio service remains separate.

**Tech Stack:** Existing Silero / Doubao Python adapters, Harness SDK profile and external provider plugin, official SIWC DevKit, MLX HTTP PCM, FFmpeg atempo.

**Spec:** `docs/research/opennova-voice-pipeline-design.md`, `docs/research/opennova-mvp-development-deployment.md`, user request to connect the complete conversation.

## Global Constraints

- GPT-6.1 Sol only; OpenNova's own official subscription authorization, no copied Codex credentials or automatic paid fallback.
- Vivian, Chinese, existing voice instructions and model revision; client tempo 1.5.
- Single active turn. Final ASR only enters the Agent; no assistant echo enters ASR during playback.
- First demo supports conversation and context; shell, file mutations and model tool calling are disabled explicitly.
- No microphone activation during automated tests. User starts the live microphone command. No audio saved unless an output directory is explicitly selected.
- Reuse current `codex/voice-vad-tts` checkout, preserve unrelated changes and root README. No commits containing secrets.

## Review Focus

- ASR interim/final revisions: only the verified final transcript reaches Harness.
- Provider failure or incomplete response: never present partial/stale text as a successful reply.
- Ctrl+C / source failure: close microphone, websocket, playback and owned child processes.
- Playback echo: close capture while thinking/speaking and wait before reopening.
- Multiturn context: same Harness session, real second-turn recall; never claim a fixture is live LLM evidence.

### Task 1: Harness subscription adapter

Files: `services/agent/{chatgpt,provider,worker}.mjs`, `services/agent/voice.patch.yml`, focused Node tests.

- [x] Test text-history projection, rejection of unsupported tools/content, failed stream cleanup and complete response requirement.
- [x] Register an external provider via a shipped `sdk-minimal` profile; use the official DevKit for token refresh/inference and protected storage.
- [x] Run a real two-turn Harness conversation and inspect persisted session text.

### Task 2: Voice turn controller and playback

Files: `tools/voice/{conversation,capture,playback}.py`, focused Python tests.

- [x] Test silence creates no request, finalization closes capture before response, partial utterance cancellation, and ordered multi-turn submission/playback.
- [x] Add microphone/file input, final ASR handoff, persistent Agent subprocess, bounded output and explicit states; reuse existing VAD and atempo.
- [x] Test cancellation and failure cleanup; support file-driven end-to-end verification without recording the user.

### Task 3: Integration and usage

- [x] Run owned audio through actual VAD, paid Doubao API, authorized Harness / GPT-6.1 Sol, and Studio Vivian; save explicit test artifacts.
- [x] Review the new integration and address material defects.
- [x] Document exact prerequisites, startup command, measured status and demo limitations. Update authorization and deployment records without claiming Studio Agent migration or AEC is finished.

## Execution ledger

- 2026-10-12: independent ChatGPT authorization completed; `gpt-6.1-sol` listed and actual inference reached `response.completed` (3.254 s). Existing Air Harness is built at `ddefc45fbc7f8e46dd73185e68295696d1297887`; no upstream files will be edited. Studio TTS health check passed.
- Ruling: use existing Air Harness for this bounded integration demo because Studio authorization storage is unavailable under SSH. Cost: this demo is not the final Studio-resident deployment.

- Task 1: complete — 6 Node tests pass; real Harness two-turn recall passed, plus post-review real completion check (2.825 s).
- Task 2: complete — 10 voice tests pass; existing ASR 26 and TTS 9 regressions pass. Tests include source truncation, silence, ASR failure, partial model rejection, silent TTS and orphan-child cleanup.
- Task 3: complete — real two-turn file-input chain saved under `output/voice/complete-loop-20261012/`; no microphone recorded. Fresh review found three material issues; all reproduced as failing tests and fixed. Live microphone interaction remains user-driven verification.
- Review fixes: verify completed Harness turn and uninterrupted message; terminate the owned process group after graceful shutdown; reject all-zero PCM.
