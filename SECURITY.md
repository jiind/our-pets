# Security policy

The current beta is maintained against the latest main and release. Long-term security support for older versions is not provided.

## GLib iterator security backport

The Linux GTK 3 stack uses a vendored `glib 0.18.5` with the official fix for [GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). The vulnerable implementation passed an immutable output pointer to a mutating C function, causing undefined behavior and optimized-build crashes. Our snapshot backports the [upstream two-line correction](https://github.com/gtk-rs/gtk-rs-core/commit/05dff0ee696f9bcd8617cd48c4b812d046d440cb) and retains the GTK 3-compatible API.

Cargo overrides this package throughout the desktop dependency graph. CI verifies the source hashes, exact backport, lockfile origin and license notices, and executes all affected iterator methods through actual GLib FFI in a release build. See the [patch provenance and maintenance instructions](desktop/src-tauri/vendor/glib-0.18.5/PATCH.md). Version-only scanners can still identify the original version number; the local source and optimized regression results establish the applied fix. The unpatched registry release must not re-enter the graph. Replace the snapshot when the complete GTK dependency graph supports an upstream patched release.

## Private reporting

Report authentication bypasses, unauthorized message access, file-processing vulnerabilities, or exposed credentials through [GitHub private vulnerability reporting](https://github.com/jiind/our-pets/security/advisories/new). Do not publish exploit details or real tokens in ordinary issues. If private reporting is unavailable, ask publicly only for a private contact method, without disclosing details.

Include affected version, OS, minimal reproduction, expected impact, and evidence with secrets removed. Do not attack production servers or collect other people's data. Reproduction, impact assessment, fixes, and disclosure timing are coordinated with the reporter. No fixed response deadline or support commitment for old versions is implied.

## Operational boundaries

Private IPs alone do not establish access control. Configure allowed CIDRs, registration codes, TLS, and OS profile permissions as described in [deployment](docs/operations.md). Personal Slack tokens stay in the OS credential store and are not sent to the LAN server. LAN-session WebView storage and personal-source secure storage are separate boundaries.

Do not commit real environment files, keys, databases, messages, or personal-source stores, or attach them as CI artifacts. Dependency updates require review and CI; they are not automatically merged.
