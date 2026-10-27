# Native Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Complete M1–M4 using native DSH networking while retaining OpenNova voice and desktop UX.
**Architecture:** Native tools and Agent loop execute unchanged. A session-event observer records product status and evidence; legacy middleware remains opt-in for rollback.
**Tech Stack:** Node 24, Cordis/DSH cccbe9cb, existing Bot bridge and React UI.
**Spec:** docs/superpowers/specs/2026-10-25-native-research-design.md

## Global Constraints
- Reuse the attached desktop-browser-m0 worktree; preserve all pre-existing modifications.
- Native search timeout 60000ms, native fetch default 30000ms; no additional research counts/deadlines.
- Existing whole-turn timeout 600000ms and cancellation remain active.
- Keys stay in ignored local files; probes use disposable homes, never reset daily history.

## Review Focus
- Late events after cancellation or a Bot session handoff must not attach to another request.
- Recording failures must not replace/throw over native tool results.
- Native non-2xx and title-only/empty content cannot be marked verified body evidence.
- Legacy rollback and old historical sources must still work without activating legacy tools by default.
- The launcher must detect old service version/mode; no real-mode swap during a live request.

### Task 1: M1 native baseline and configuration
**Files:** research/config.mjs, research/plugins.mjs; tests/research-native.test.mjs; tools/bot/native-research-probe.mjs.
**Interfaces:** loadResearchConfig() yields mode native|legacy; researchPlugins() emits native plugin definitions without auxiliary model overrides.
- [x] Add failing configuration/real-tool boundary tests.
- [x] Implement native-default config and opt-in legacy configuration; verify real DSH registrations and source mapping.
- [x] Capture isolated native provider baseline and full existing Bot suite with correct Node/Harness paths.

### Task 2: M2 native event observer
**Files:** research/runtime.mjs, research/legacy-runtime.mjs, research/native-runtime.mjs, research/instructions.mjs, host.mjs, controls.mjs.
**Interfaces:** installResearch keeps begin/finish/reply/refresh/sourceTool/health/tools/close shape. Native observation takes session tool/call and tool/result events and never installs execution or tool-list middleware.
- [x] Add failing tests for error preservation, third-query availability, cancelled/stale events, empty excerpts, recording failure isolation.
- [x] Implement observer, source persistence and native instructions; keep legacy runtime reachable only explicitly.
- [x] Run native tests and legacy lifecycle tests.

### Task 3: M3 UI, voice and compatibility
**Files:** research/sources.mjs, web/research-view.mjs, tools/voice/start.mjs; tests/research-native.test.mjs; launcher and voice tests.
**Interfaces:** research phase/status and source response fields remain compatible; link-only sources have an honest label. Launcher reports mode/version mismatch.
- [x] Add failing tests for source labels, old-source replay and startup mismatch.
- [x] Wire product events, original errors, rollback health and short speech.
- [x] Verify Bot/desktop/voice adapter regressions.

### Task 4: M4 live acceptance and delivery
**Files:** tools/bot/native-research-probe.mjs, docs/research/opennova-native-research-test-cases.md, architecture/deployment docs.
**Interfaces:** probe --scenario baseline|acceptance|cancel uses isolated homes and writes ignored JSON evidence.
- [x] Run real native queries and Agent acceptance, validate browser isolation and source follow-up.
- [x] Review complete diff, fix important findings and run affected tests.
- [x] Upgrade idle daily Bot; verify health, startup check and rollback configuration.
- [x] Publish startup commands, test cases, evidence and actual limitations.
