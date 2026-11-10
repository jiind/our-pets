# Security policy

The current beta is maintained against the latest main and release. Long-term security support for older versions is not provided.

## Known upstream advisory

The Linux GTK 3 stack includes `glib 0.18.5`, affected by [GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429](https://github.com/advisories/GHSA-wrw7-89jp-8q8g). Its `VariantStrIter` implementation has an unsound FFI out-pointer argument that can cause undefined behavior or a null-pointer crash. Upstream fixes start at `glib 0.20.0`.

Our Pets does not directly call `VariantStrIter` or `array_iter_str`. This is not a claim that every transitive runtime path has been proven unaffected. GTK/GDK/WebKitGTK dependencies currently require the 0.18 series, so upgrading this package independently is not a compatible fix. The dependency warning remains unresolved and is disclosed for the beta; it has not been suppressed or treated as a successful remediation.

## Private reporting

Report authentication bypasses, unauthorized message access, file-processing vulnerabilities, or exposed credentials through [GitHub private vulnerability reporting](https://github.com/jiind/our-pets/security/advisories/new). Do not publish exploit details or real tokens in ordinary issues. If private reporting is unavailable, ask publicly only for a private contact method, without disclosing details.

Include affected version, OS, minimal reproduction, expected impact, and evidence with secrets removed. Do not attack production servers or collect other people's data. Reproduction, impact assessment, fixes, and disclosure timing are coordinated with the reporter. No fixed response deadline or support commitment for old versions is implied.

## Operational boundaries

Private IPs alone do not establish access control. Configure allowed CIDRs, registration codes, TLS, and OS profile permissions as described in [deployment](docs/operations.md). Personal Slack tokens stay in the OS credential store and are not sent to the LAN server. LAN-session WebView storage and personal-source secure storage are separate boundaries.

Do not commit real environment files, keys, databases, messages, or personal-source stores, or attach them as CI artifacts. Dependency updates require review and CI; they are not automatically merged.
