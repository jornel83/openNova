# Repository-contained SIWC

User requests SIWC adapter source/dependencies inside OpenNova, with authorization, sessions and memory remaining outside. Continue the approved subtree/source-contained architecture in the existing integration worktree, then fast-forward the original project and validate its service.

Import the complete pinned SIWC tree (0a36fefeb913055c8c7a1a29b63d82b96b2e841a, version 0.1.0) into engine/siwc with git subtree --squash. Apply the existing streamItems extension as a separate tracked local change, including prominent modification notices and the upstream noncommercial license. Preserve upstream update metadata in upstream.lock.json. Do not relabel SIWC as Apache-2.0.

Both text and tool adapters load the built engine/siwc/packages/local distribution. Ignore old siwc_root / OPENNOVA_SIWC_ROOT source overrides, just as for Harness. Keep storageDir, Keychain identity/helper configuration, Bot home and all user data unchanged. The helper's source already belongs to OpenNova; its installed executable and OS Keychain retain current locations and access behavior.

Root setup installs locked SIWC local-workspace dependencies; root build builds that package; root default tests include its adapter contracts. --chatgpt remains an optional Keychain-helper preparation flag. Eliminate Git-dependent overlay export/build and old output/deps/siwc runtime fallbacks. Add SIWC source and artifacts to build freshness checks. Source ZIP builds require no Git metadata or sibling/user-directory SDK checkout.

Verify stale source configuration is ignored while credential/data configuration remains supported, missing/stale local builds fail, upstream/local protocol tests pass, source archive works with spaces and without .git, then merge/build original project and restart only its idle standard Bot. Do not generate a paid reply, open a microphone, remove old external checkouts or affect the separate desktop experiment.
