# Desktop Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Original OpenNova includes the desktop branch and opens its right-side interaction window from unified startup.
**Architecture:** Merge desktop source/history into existing engine subtrees. Root orchestration owns dependency/build/test contracts; Bot home and browser profile remain external.
**Tech Stack:** Node 24, pnpm 11.28.5, Chrome MV3, Python 3.11, Swift, bundled Harness/Bot/SIWC.
**Spec:** docs/superpowers/specs/2026-10-27-desktop-integration-design.md

## Global Constraints
- Preserve original machine settings, SIWC registration, helper trust and live Bot history; backups and browser profile stay outside Git/source.
- No submodule or external private source dependency. Honor bundled source/build version contracts.
- Do not send real model requests, paid TTS or collect microphone audio for automated validation.
- Reuse existing isolated integration worktree; deploy via fast-forward into original project after passing verification.

## Review Focus
- Imported source must not restore submodule checks, external SDK overlays, cache-specific esbuild or generated plugins in the data directory.
- Default/headless/check startup and existing Bot reuse must open at most one UI and not silently attach to another project.
- UI setup must preserve browser profile and use external credential storage; first connection/reconnection must be authenticated.
- Desktop/research hooks must work with the currently bundled Harness rather than assume private experimental changes.
- Original state and browser pairing must survive deployment/restart; voice errors must not close the usable chat UI.

### Task 1: Merge source and preserve standalone dependency contracts
**Files:** desktop branch merge, services/agent/{provider,settings,dependencies}.mjs, services/bot/{launch,configuration,settings,resolve,setup}.mjs, scripts/{project,test,build-record}.mjs.
**Interfaces:** runtimeSources/requireBuiltHarness remain the only source roots; commandPlan setup installs services/bot/desktop package lock; runtimePatch accepts desktop/research options; root tests include extensions/browser/tests.
- [ ] Write and run integration regressions for default UI, desktop composition and dependency setup; observe failures.
- [ ] Merge branch, resolve content conflicts preserving current engine architecture and imported interaction behavior; remove legacy gitlink/version checker.
- [ ] Run product/imported tests and bundled runtime smoke; diagnose actual upstream interface differences; build/audit pass; commit merge.

### Task 2: Unified startup and external browser settings
**Files:** services/bot/launch.mjs, tools/{voice,desktop}/start.mjs, tools/desktop/settings.mjs, config/voice.example.json, README.md and focused launcher tests.
**Interfaces:** default UI unless --no-ui or check/list/help; browser executable/profile resolved from explicit env then desktop machine config, profile outside repository. Server path can be started without opening UI by voice orchestrator.
- [ ] Test default/headless/check, reuse, external profile boundary and CLI/env/config precedence; observe RED.
- [ ] Implement defaults and root Bot window-opening coordination; preserve authentication/fallback handling and voice synchronizer.
- [ ] Run focused/default tests and clean archive setup/build/test/audit; commit.

### Task 3: Review, original deployment and live UI verification
**Files:** verification report, local deployment/config only.
**Interfaces:** original Bot on 18560/18561 remains live history; legacy desktop state backed up separately; bridge/extension profile points at original repo after migration.
- [ ] Independent fresh-context review; fix important findings with RED→GREEN and full suite.
- [ ] Back up original and legacy state externally; stop only idle task-owned instances and preserve browser data before migration.
- [ ] Fast-forward original, install/build, migrate profile and pair extension, start desktop Bot and open window through unified entrypoint.
- [ ] Verify bridge connected, right window visible and reusable, local browser fixture actions, health/session/records/config preservation; record evidence and commit docs.
