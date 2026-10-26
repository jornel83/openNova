# SIWC local changes

`0001-stream-items.patch` is already applied to the tracked `engine/siwc` source. It adds authenticated structured Responses streaming while reusing upstream credential refresh and encrypted storage. Do not apply it again during installation or startup.

OpenNova modifications to SIWC are distributed under the SIWC Noncommercial License v1.0 in this directory and `engine/siwc/LICENSE`, including its copyright and patent grants. Modified source files carry change notices. The root Apache-2.0 license does not replace this license.

For an upstream sync, merge the subtree, reconcile the modifications, update this patch against the selected upstream base and update `upstream.lock.json` with its SHA-256. Test text and structured-item streaming before updating the original project.
