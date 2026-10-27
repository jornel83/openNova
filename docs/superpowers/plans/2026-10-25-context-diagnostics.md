# Context Maintenance and Diagnostics Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, inline implementation and one final fresh review.

**Goal:** Restore native background summaries and preserve actionable model errors through all OpenNova clients.
**Architecture:** A scoped model gate admits owned compaction; provider errors become native LlmError, then sanitized durable diagnostics at request settlement.
**Tech Stack:** Node 24, Python 3.11, current pinned DSH/Bot.
**Spec:** docs/superpowers/specs/2026-10-25-context-diagnostics-design.md

## Global Constraints
- Preserve existing worktree edits and persistent user conversations. No dependency upgrade, model budget change, or automatic tool replay.
- Diagnostic fields are allowlisted; never log raw SDK responses, credential values or prompts.

## Review Focus
- Idle compaction is allowed only for an existing part of the main Bot, not arbitrary session/purpose.
- Retried or cancelled turns cannot execute a maintenance tool call.
- Native Harness normalization must retain actual HTTP status and request ID.
- Unknown errors and malformed diagnostic fields do not expose private text.
- UI/voice report failed turns without speaking partial answers or attributing every 403 to VPN.

### Task 1: Scoped native maintenance
**Files:** services/bot/model-gate.mjs; services/bot/host.mjs; services/bot/tests/model-gate.test.mjs; services/agent/responses-protocol.mjs and tests.
**Interfaces:** installModelGate(ctx,{rt,bot,getActive,onMaintenance}); compaction output is text-only, history retained.
- [x] Write failing cases for idle owned compaction, unrelated session/purpose, cancellation and forbidden summary tool outputs.
- [x] Observe RED; implement gate and sanitized maintenance lifecycle logging.
- [x] Run model gate/protocol/project/requests tests.

### Task 2: Structured diagnostics
**Files:** services/agent/errors.mjs; provider.mjs; provider-core.mjs; responses-protocol.mjs; result.mjs; services/bot/requests.mjs; host.mjs; web/api.mjs; web/app.jsx; tools/voice/bot_agent.py; tools/bot/client.mjs; relevant tests.
**Interfaces:** errorEvent(error,stage) produces safe code/stage/status/requestId; safeError wraps it; native adapter converts to LlmError; failed request stores diagnostic.
- [x] Write failing end-to-end native LLM boundary / completedReply / Requests cases for 403, 429, network errors and private data.
- [x] Observe RED; preserve safe fields through provider, terminal event, persistent result and clients.
- [x] Verify web and voice display status and actionable hints, while cancelled/unknown results remain correct.

### Task 3: Runtime validation and delivery
**Files:** tools/bot/context-diagnostics-probe.mjs; docs/research/opennova-context-diagnostics.md.
- [x] Run Agent/Bot and affected voice suites; build web assets.
- [x] Use isolated native Bot to verify handoff note, fresh part, retained context and error path without mutating daily history.
- [x] Fresh code review, address important findings, document tests/limits.
- [x] Restart idle daily Bot with same home/session and deliver unchanged launch instructions.
