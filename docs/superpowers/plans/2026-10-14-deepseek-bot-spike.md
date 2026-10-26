# DeepSeek-Bot Spike Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved plan inline. Track verified progress below.

**Goal:** Deliver an isolated single-Bot experiment with GPT, confirmed file/memory operations and the existing voice client.

**Architecture:** Launch the pinned Harness web profile with an OpenNova wrapper around the real DeepSeek-Bot runtime. An authenticated loopback bridge owns requests independently of clients; existing Python voice code selects this backend explicitly.

**Tech Stack:** Node 24, Harness/Cordis, upstream DeepSeek-Bot, Python asyncio, existing SIWC and voice services.

**Spec:** ../specs/2026-10-14-deepseek-bot-spike-design.md

## Global Constraints

- Preserve existing entry points, credentials, user files and upstream checkouts.
- Pin dependency revisions, use independent runtime storage, permit only a bounded test workspace.
- No alternate model/account fallback; no Shell, delegation or deployment tools.
- Human confirmation is a control action, never a model-supplied boolean.
- Session, request, task and playback identities are distinct.

## Review Focus

- Repeated requests and confirmation after a server crash must not duplicate writes.
- Reject static path escape and detect changed file versions; the experiment owns its directory exclusively and does not claim atomic exclusion of arbitrary external writers.
- Client disconnect must not kill independent tasks or lose final results.
- Corrected/deleted memories must not survive in frozen prompts as current facts.
- Incomplete/failed model responses and stale voice replies must not appear successful.

## Tasks

### Task 1: Runtime and provider

Files: services/bot/{settings,setup,launch,host,policy}.mjs; services/agent/provider.mjs; tools/bot/run.command; services/bot/tests/.

- [x] Test isolated settings, pinned dependencies and explicit tool/model metadata.
- [x] Implement reproducible setup, host wrapper, single Bot and authenticated bridge.
- [x] Start actual Harness web profile and verify healthy Bot; run GPT tool probe.

### Task 2: Work operations and durable requests

Files: services/bot/{operations,requests,http}.mjs; tools/bot/client.mjs.

- [x] Write failing tests for bounded reads, proposals, conflicts, repeated approvals and durable tasks.
- [x] Implement read/propose/confirm, persisted request status and controlled tasks.
- [x] Verify real file edit workflow and reconnect/restart behavior.

### Task 3: Memory and session continuation

Files: services/bot/{host,policy}.mjs; services/bot/tests/.

- [x] Gate upstream memory tools with persisted human approvals; invalidate memory snapshots.
- [x] Test outdated fact filtering and restart with same Bot/current part.
- [x] Verify real remember/replace/forget tool paths against upstream storage.

### Task 4: Voice integration and delivery

Files: tools/voice/{bot_agent,continuous_run,conversation}.py; tools/bot/; docs/research/opennova-bot-spike.md.

- [x] Test backend selection, detach vs cancellation, independent task controls and failure handling.
- [x] Implement opt-in --bot and preserve existing audio/ASR/TTS services.
- [x] Run regression tests, live probes and final code review; document commands and verification limits.

## Execution record

- Baseline: 62 Agent tests pass; tracked checkout clean, unrelated untracked skills/ and tools/video/ preserved.
- Ruling: implementation stays on the existing feature branch with additive experiment files and opt-in changes; no shared branch push or upstream edits.
- Ruling: use a conservative explicit context budget for the experiment, labelled deployment policy rather than a claim about GPT model maximums.

- 2026-10-14: Completed four tasks. Actual upstream runtime uses the existing authorized GPT adapter; native Bot UI/channel is disabled so approvals cannot be bypassed.
- Review repairs: real Cordis effect disposal, late-startup resource ownership, synchronous text admission, shared approval/request admission, canonical tool output, exact memory targets, upstream normalization, durable memory reconciliation based on authoritative state (including failure after rename), and final file hash recheck.
- Verification: 90 Node tests (62 existing Agent + 28 Bot) and 68 voice tests passed. Bot tests include the installed Harness tool-output contract and actual Cordis fiber disposal.
- Live probe: confirmed file edit/duplicate confirmation, remember/replace/recall/forget, controlled task passed. Probes use a fresh synthetic sample identifier to avoid unrelated previous test memories.
- Live restart: same Bot ID and context pass; previous request result retained; task deadline unchanged; foreground cancellation leaves independent task running; explicit task cancellation returns cancelled.
- Live VAD → Doubao ASR → Bot: existing recording asking for the test passphrase returned the passphrase entered in the text client before restart. No microphone capture or TTS playback was performed in this probe.
- Initial acceptance limitation: full voice preflight reported connection refused at the configured Vivian endpoint (127.0.0.1:18000). Follow-up on 2026-10-14: restoring the existing SSH forward resolved preflight, and the user passed a three-turn live voice case covering initial planning, corrections and contextual recall with Vivian playback. Dedicated Bot-mode barge-in, acoustic and long-running acceptance remains separate.
- Credentials remain in ignored local configuration/Keychain. Unrelated skills/ and tools/video/ are untouched. No commit or push performed for this request.
