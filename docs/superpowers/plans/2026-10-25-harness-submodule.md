# Harness Submodule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the maintained DSH fork an editable, pinned OpenNova submodule with reproducible installation.
**Architecture:** The gitlink pins DSH; JSON records source and build metadata. Python bootstrap and Node launch consume the same dependency resolver. Existing external checkouts remain supported as explicit overrides.
**Tech Stack:** Git submodules, Node 24, Python 3.11, pnpm 11.28.5.
**Spec:** docs/superpowers/specs/2026-10-25-harness-submodule-design.md

## Global Constraints
- Target third_party/deepseek-harness at cccbe9cb4763f597bfb83129ca03345c3fbead1b; preserve original checkout and existing worktree edits.
- No official version upgrade, VPN change, credentials in Git, or overwrite of a shared branch.
- Daily persistent conversations survive; validation first uses isolated runtime data.

## Review Focus
- Empty submodule directories must initialize correctly without accepting the parent's Git HEAD.
- Wrong/dirty existing dependency checkouts must remain untouched.
- A changed dependency commit must not silently reuse old lib artifacts.
- Gitlink version must agree across bootstrap and runtime, including explicit external paths.
- A new clone must obtain the referenced commit from the fork without local object alternates.

### Task 1: Publish and attach pinned source
**Files:** .gitmodules; third_party/deepseek-harness (gitlink).
**Interfaces:** Produces an independently versioned DSH checkout reachable from the fork.
- [x] Record baseline; inspect the two existing commits and run their HTTP tests.
- [x] Push only codex/opennova-research-http, add the submodule at its pinned commit, verify no object alternates.
- [x] Verify remote ref and a fresh checkout can reach the pinned commit.

### Task 2: Resolve, initialize and build the dependency
**Files:** services/agent/dependencies.mjs; services/agent/settings.mjs; services/bot/settings.mjs; services/bot/setup.mjs; config/runtime-versions.json; tools/setup/bootstrap.py; focused Node/Python tests.
**Interfaces:** harnessDependency(root) returns path/url/pnpm/revision from metadata + gitlink; runtime and installer use it.
- [x] Write failing tests for default nested path, gitlink validation, missing/dirty/wrong checkout behavior and stale build receipts.
- [x] Run targeted Node and Python tests and observe intended failures.
- [x] Implement minimal path/resolver/installer/runtime changes; preserve explicit path overrides.
- [x] Run focused tests; install and build the pinned source with a revision-aware receipt.

### Task 3: Verify runtime and document maintenance
**Files:** README.md; services/agent/README.md; docs/research/opennova-harness-development.md; relevant deployment/status documentation.
**Interfaces:** Existing launcher commands keep working; source/update workflows are documented.
- [x] Verify dependency checks, Bot module import/build and an isolated real tool-enabled request using nested source.
- [x] Update source ownership, upstream merge/testing/pinning/rollback and fresh-clone setup instructions.
- [x] Review only migration diff, preserve unrelated edits, commit migration files and gitlink without bundling prior work.
- [x] Report validation, commit, dependency branch and unchanged startup command.
