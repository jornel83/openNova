# Third-party source and notices

OpenNova original code is distributed under the root Apache-2.0 license. That does not replace the licenses of included or optional components.

| Component | Source directory | Upstream | License |
| --- | --- | --- | --- |
| DeepSeek Harness | `engine/harness/` | https://github.com/deepseek-ai/deepseek-harness | MIT; see `engine/harness/LICENSE` and its third-party notices |
| DeepSeek-Bot | `engine/bot/` | https://github.com/Fei2411/DeepSeek-Bot | Apache-2.0; see `engine/bot/LICENSE` and `engine/bot/ds-bot/LICENSE` |
| Sign in with ChatGPT DevKit | `engine/siwc/` | https://github.com/openai/sign-in-with-chatgpt-devkit | Sign-in with ChatGPT DevKit Noncommercial License v1.0; see `engine/siwc/LICENSE` |

Precise import commits, versions and preserved Harness patches are recorded in `upstream.lock.json`. All included copyright, LICENSE, NOTICE and dependency license files remain part of the source distribution. Harness contains additional third-party software with its own terms; consult `engine/harness/THIRD_PARTY_NOTICES.md` and the files accompanying each package. The upstream repository names and attributions are retained for provenance; OpenNova is an independent integration.

SIWC is included at the revision in `upstream.lock.json`. It has a **noncommercial license**, including restrictions on commercial development, use and redistribution. The root Apache-2.0 license does not replace or expand those rights. Preserve `engine/siwc/LICENSE`, `engine/siwc/THIRD_PARTY_NOTICES.md`, package notices and upstream attribution. OpenNova's SIWC modifications carry source-file change notices and the same SIWC license; see `patches/siwc/README.md` and `patches/siwc/LICENSE`. Bundling source does not grant access to OpenAI services or rights to OpenAI trademarks and branded assets.

Package dependencies are recorded in their respective lockfiles and retain their own licenses.

Audio/model weights, cloud services and account authorization are not distributed with the source. Follow the selected provider or model's terms when obtaining and using them. Existing component-specific notices in `services/`, `tools/` and `videos/` continue to apply.
