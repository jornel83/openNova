# SIWC Subtree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Bundle SIWC in OpenNova while retaining external user state.
**Architecture:** Third source subtree, tracked extension patch, single built local SDK for text/tools; root orchestration owns install/build.
**Tech Stack:** Node 24, npm lockfile, pnpm 11.28.5, Python 3.11, existing macOS Keychain helper.
**Spec:** docs/superpowers/specs/2026-10-27-siwc-subtree-design.md

## Global Constraints

- SIWC revision 0a36fefeb913055c8c7a1a29b63d82b96b2e841a, version 0.1.0; retain noncommercial license and modification notices.
- Source engine/siwc; authorization, sessions, memory and helper configuration unchanged.
- Original project receives final reviewed integration. Preserve .playwright-cli and local configurations; do not modify the other desktop worktree.
- User already requested execution of the established integration approach; no additional design approval is needed.

## Review Focus

- No stale SIWC path/overlay can select an external SDK at runtime, including tests.
- A source archive with spaces and no Git metadata builds/loads the same SDK.
- Credentials and model authorization are not touched by install/build/tests; helper preparation preserves existing executable.
- Source and generated adapter changes invalidate build freshness; missing items.js is actionable.
- License, modified-file notices and local patch provenance survive subtree synchronization.

### Task 1: Source import and runtime ownership

**Files:** engine/siwc; upstream.lock.json; services/runtime/sources.mjs; services/agent/{settings,chatgpt,siwc}.mjs; source/settings tests.
**Interfaces:** runtimeSources returns siwcRoot; checkEngineSources validates three components; siwcModule(root?) resolves local built SDK only.

- [x] Write/run failing tests for bundled source selection with hostile legacy config and unchanged storage/helper overrides. Expected: old external path or missing siwcModule fails.
- [x] Import pinned subtree, apply existing patch, add modification notices and provenance; commit source additions separately.
- [x] Switch all SDK loading to local distribution and delete external overlay fallback; update manifest fixtures. Run source/settings/SDK resolution tests. Expected: pass. Commit integration after Task 2 closes build dependencies.

### Task 2: Build, regression and delivery

**Files:** scripts/{project,build-record,test}.mjs; tools/setup/bootstrap.py and tests; config/templates; package commands; CI; README/development/notices.
**Interfaces:** setup/build include the local SDK, tests consume built SDK, bootstrap only prepares/checks helper and local dependencies.

- [x] Add/run failing build-plan/artifact tests and helper-preservation checks. Expected: old steps or absent SIWC outputs fail.
- [x] Remove obsolete Git overlay builder, redundant runtime version config; integrate locked SDK install/build and default adapter tests; update docs/CI/licenses.
- [x] Install/build; run product, Bot, SIWC upstream and adapter tests. Expected: all pass with no account access.
- [x] Export ordinary source outside repositories (space in path), install/build/test with nonexistent legacy SIWC path. Expected: pass without .git or old SDK.
- [x] Fresh whole-change review; fix important findings with regression tests, commit. Merge original directory, rebuild and verify authorization/startup with original data preserved. Expected: existing Bot/history/memory/config survive; standard service ready.
