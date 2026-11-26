# OpenNova macOS internal package

The internal distribution is a locally signed arm64 application in a DMG. It is not Developer ID signed or notarized. The native AppKit control panel starts the existing OpenNova services and Chrome integration. It has a separate account store, Bot home, workspace and default ports (19560/19561).

Build on Apple Silicon macOS with the repository dependencies and engines already built, standalone uv-managed Python 3.11.15, uv, FFmpeg/ffprobe, Xcode tools, and Git. Build tools are not required on the destination machine.

```sh
pnpm run build
python3.11 scripts/macos/build.py
```

`python3.11` must refer to the uv-managed standalone interpreter, not a Homebrew framework interpreter. The builder supports `--phase runtime|assemble|finalize|dmg` for diagnosis. It stages Git-visible source from the current working tree, including uncommitted source changes, plus an explicit engine build-output allowlist. Local configuration, credentials, workspaces, user output, caches and tests are excluded. The engine artifacts must correspond to the current source before staging. Product web assets are rebuilt with the build machine's toolchain and copied into staging.

The application is assembled under `output/macos/stage/OpenNova.app`; distributables go to `output/macos/release`. Run `python3.11 -B scripts/macos/smoke.py output/macos/stage/OpenNova.app` before the `dmg` phase. The runtime contains checksum-verified Node 24.14.1, standalone Python with a hashed dependency lock, native Swift helpers, the Silero model, FFmpeg and its relocated dynamic libraries, Git, and ripgrep. The runtime phase prepares pinned macOS 15 Homebrew bottles from `compat-bottles.json` without changing global installations. Finalization rejects native dependencies requiring macOS newer than 15.0 or absolute non-system library paths. Build source records stay outside the application. No Developer ID or signing account is required.

`stage-node.mjs` traverses the installed production workspace dependency graph, including peer and optional dependencies. It preserves internal relative links and rejects external or broken links. It does not run dependency installers on the destination machine. The app retains the source resources used by runtime package exports and executor hashes.

All runtime writes belong in `~/Library/Application Support/OpenNova/`. `OPENNOVA_APP_DATA` and both port variables can be overridden for isolated tests. The controller defaults to text mode, never starts authorization automatically, and only stops the Bot process it started. Configured secrets are stored in private files and are not sent over its UI event stream.

Use the included Chinese installation guide for first launch, Chrome extension pairing and optional service configuration. The package does not include a Chrome browser, personal project assets, account tokens, or local TTS model weights.
