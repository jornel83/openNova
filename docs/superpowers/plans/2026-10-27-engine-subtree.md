# OpenNova Engine Subtree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver OpenNova with source-contained Harness/Bot and reproducible root commands.

**Architecture:** Import complete upstream trees with git subtree --squash. Preserve Harness's build boundary, centralize runtime paths, and coordinate existing product plugins from the OpenNova root.

**Tech Stack:** Node 24, pnpm 11.28.5, Python 3.11+, Swift/macOS audio, SQLite, React/esbuild.

**Spec:** docs/superpowers/specs/2026-10-27-engine-subtree-design.md

## Global Constraints

- Harness base d743267388641bc76f17c45ce8b4c231aed1d32c; preserve bf89008192 and cccbe9cb47 separately.
- Bot 20ebc9213cbbde7249d71786765f86be00dc6663; retain licenses and complete development sources.
- No user state migration, private credentials, microphone, or paid model requests in default verification.
- Use a managed worktree based on the preserved working-tree snapshot. Do not change the original checkout.
- User approved implementation; continue inline without another planning approval round.

## Review Focus

- Fresh checkout/ZIP without a neighboring Harness or Git metadata must resolve bundled source and build.
- Legacy harness_root configuration must not silently reintroduce external code.
- Same-process Bot and Harness must share Cordis peers and frontend React identities.
- Rebuild metadata must detect stale source without mistaking the parent repository HEAD for an upstream revision.
- Existing SQLite, sessions, permissions and cancellation behavior must remain unchanged.

---

### Task 1: Source import and source contracts

**Files:** Create `upstream.lock.json`, `services/runtime/sources.mjs`, `scripts/tests/sources.test.mjs`; import `engine/harness/`, `engine/bot/`.

**Interfaces:** Produces `runtimeSources(root?)` and `checkEngineSources(root?)`, returning repository-local Harness/Bot paths and validated source metadata.

- [ ] Write tests for source paths, missing source, non-Git export and legacy external configuration.
- [ ] Run `node --test scripts/tests/sources.test.mjs` and observe missing interface failure.
- [ ] Import Harness base and Bot subtree; apply two existing Harness fixes as separate commits.
- [ ] Implement source paths/metadata checks and switch Agent/Bot settings to them.
- [ ] Run source/settings tests; commit passing changes.

### Task 2: Repository-local runtime and build integration

**Files:** Modify `services/bot/{setup,launch,resolve}.mjs`, `services/bot/web/build.mjs`, `tools/setup/bootstrap.py`, `config/{runtime-versions,voice.example}.json`; create root `package.json`, lockfile, `scripts/project.mjs`, build verification tests.

**Interfaces:** Consumes source paths; produces setup/build/doctor commands and a built local engine that existing plugins can load.

- [ ] Add failing tests for source-only setup without git, entry validation, explicit build dependency and unknown commands.
- [ ] Replace external repository checkout/HEAD assumptions and generated Bot wrapper.
- [ ] Declare esbuild; retain one Harness React instance; pin Node/pnpm and implement root orchestration.
- [ ] Install locked dependencies and build the included Harness/Bot/web; verify focused tests.
- [ ] Commit integration after real local tool contract tests pass.

### Task 3: Offline verification and open-source delivery

**Files:** Create `scripts/test.mjs`, clean-source smoke tests, `.github/workflows/ci.yml`, `CONTRIBUTING.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `docs/development.md`; update current setup docs and launchers.

**Interfaces:** Root test command runs Node/Python suites; CI and contributors use the same setup/build/test commands.

- [ ] Add tests that run command help/doctor in an isolated source copy, with hostile legacy path configuration and no .git.
- [ ] Implement offline runner and clean-source build smoke; document optional SIWC setup and paid live tests.
- [ ] Verify both subtree imports, clean-source dependency installation/build, original regressions and selected upstream Bot contracts.
- [ ] Commit delivery changes and request a fresh whole-branch review; fix important findings with regression tests.
- [ ] Record commands, outcomes, preserved original checkout and remaining platform/live-service limits.
