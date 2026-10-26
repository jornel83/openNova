# Contributing to OpenNova

Use Node 24 and pnpm 11.28.5. On macOS install Xcode Command Line Tools, Python 3.11, uv and FFmpeg. Run from the repository root:

```sh
pnpm run setup
pnpm run build
pnpm test
pnpm run test:bot
```

Read [development notes](docs/development.md) for architecture, optional model setup, source archives and upstream synchronization. Default tests use local fixtures; no account or microphone is required. Do not commit credentials, machine configuration, runtime databases or model weights.

Keep OpenNova behavior in `services/` and `tools/` where practical. `engine/harness/` and `engine/bot/` contain full subtree imports: retain upstream structure, licenses and Git subtree metadata. Read their local AGENTS.md before modifying those components. Keep engine changes in focused commits and document their upstream provenance in `upstream.lock.json`.

For a pull request, describe the user-visible behavior, affected source boundary and checks you ran. Add a regression test for behavioral changes; report platform or live-service checks that were not performed. Changes to dependencies must update the relevant lockfile and pass frozen installation. Source-level changes must be followed by a rebuild before starting the assistant.

OpenNova original code is licensed under Apache-2.0; imported components retain their respective licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).
