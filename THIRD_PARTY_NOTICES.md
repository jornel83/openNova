# Third-party source and notices

OpenNova original code is distributed under the root Apache-2.0 license. That does not replace the licenses of included or optional components.

| Component | Source directory | Upstream | License |
| --- | --- | --- | --- |
| DeepSeek Harness | `engine/harness/` | https://github.com/deepseek-ai/deepseek-harness | MIT; see `engine/harness/LICENSE` and its third-party notices |
| DeepSeek-Bot | `engine/bot/` | https://github.com/Fei2411/DeepSeek-Bot | Apache-2.0; see `engine/bot/LICENSE` and `engine/bot/ds-bot/LICENSE` |

Precise import commits, versions and preserved Harness patches are recorded in `upstream.lock.json`. All included copyright, LICENSE, NOTICE and dependency license files remain part of the source distribution. Harness contains additional third-party software with its own terms; consult `engine/harness/THIRD_PARTY_NOTICES.md` and the files accompanying each package. The upstream repository names and attributions are retained for provenance; OpenNova is an independent integration.

The optional Sign in with ChatGPT DevKit is downloaded separately at the version in `config/runtime-versions.json`. Its license and notices remain with that checkout and the generated overlay. `patches/siwc/` records OpenNova's local extension. Package dependencies are recorded in their respective lockfiles and retain their own licenses.

Audio/model weights, cloud services and account authorization are not distributed with the source. Follow the selected provider or model's terms when obtaining and using them. Existing component-specific notices in `services/`, `tools/` and `videos/` continue to apply.
