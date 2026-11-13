# Privacy, licensing, and distribution

Our Pets project code remains Apache-2.0. This document describes implemented distribution safeguards and operator responsibilities; it is not a legal opinion covering every jurisdiction or a certification of compatibility for arbitrary future dependencies.

## Where users find notices

Account → Information and notices opens privacy, project license, character/font, GSAP, and code-dependency notices without leaving the app or using a CDN. The PNG registration form contains a short rights reminder beside the file guidance. Account deletion is placed separately at the bottom of Account and requires the current password plus confirmation of the deletion scope. No blanket-consent checkbox is added to ordinary setup.

[PRIVACY.md](../PRIVACY.md) is publicly available with the repository and included in packages. An independently hosted server must publish its own actual operator/contact, purposes, lawful basis, configured retention, backup procedure, and request handling. Use the [operator template](server-privacy-template.md); do not publish placeholders as a completed policy. In Korea, applicability depends on the operator's processing and the Personal Information Protection Act, including Articles 2, 21, 29 and 30. Free software and private network addresses do not determine exemption.

## Data lifecycle

Personal notification bodies are memory-only and expire after 15 seconds or app acknowledgment. The upgrade removes the legacy disk queue, enables SQLite secure deletion, compacts the database, and truncates WAL. Deduplication stores SHA-256 event fingerprints for one day. Connection settings, sanitized statuses and usage baselines remain on disk. Slack tokens remain in the OS credential store. This does not control OS notification history, swap/hibernation, backups, storage-device remnants, or independently retained copies.

Account deletion is authenticated and password-confirmed. It removes server account/session/device/pet/design data, sent messages, recipient receipts, gathering state and owned sample connections in one transaction. Other people's messages are preserved. Deleted design references fall back to the cat. PNG files are removed only when no remaining design references their hash; file mutation is serialized with upload. A failed file removal is reported, and hourly maintenance retries old unreferenced PNGs. Password changes racing deletion cause deletion to roll back. Server operators must separately expire backups and reapply deletion after restoring a backup.

LAN account deletion does not revoke provider credentials or delete OS-user-wide connectors. Users remove these from Notifications; Claude bridge removal and provider-side authorization revocation remain separate actions. No user/provider credentials should be posted to GitHub issues.

## Dependency notices

`desktop/public/licenses/dependency-inventory.json` records locked Rust/Go packages and npm runtime packages, original expressions, source URLs, checksums and distributed notice/source hashes. The inventory includes build- and target-only packages, so inclusion does not claim that every package is linked on every OS. `dependencies.txt` preserves original license/copyright/author notices, including vendored subcomponent notices. Missing crate notices are recovered from the exact upstream source commit, with provenance in `scripts/license-overrides/provenance.json`. Canonical MPL text supplements crates whose source headers reference MPL without packaging its full text.

For multi-license components, use an applicable permissive alternative where offered; retain the original notices. Mandatory MPL code retains MPL and its corresponding original source archives are shipped in `licenses/sources/`. This does not relicense it as Apache. The GLib Rust wrapper uses the existing documented MIT security backport; the native C libraries are separate components.

After dependency changes:

```bash
go mod download all
cd desktop
npm ci
cargo fetch --locked --manifest-path src-tauri/Cargo.toml
cd ..
python3 scripts/dependency_notices.py --update
python3 scripts/dependency_notices.py
```

Review newly introduced conditions and original notices. CI rejects stale lock fingerprints, missing Cargo entries, unknown Rust license expressions, changed/missing notice or source archives, and missing required distribution texts. Regeneration itself is not a substitute for reviewing a new license. Do not apply commercial-use restrictions to Apache-licensed project code or claim all bundled material is Apache.

## GSAP

The MIT-licensed GSAP Skills repository and GSAP runtime are separate. The runtime uses the Standard No Charge License; its original notices and a snapshot of the official conditions are distributed separately. Vite retains a post-minification GSAP copyright/terms banner and emits bundled frontend dependency notices. Current use is UI/pet motion; do not expand this into a competing visual animation-building product without reviewing GSAP's restrictions. The app's sprite-frame configuration does not expose GSAP animation authoring.

## Linux AppImage

AppImage contains native GTK/WebKit and related distribution libraries in addition to Rust crates. Their licenses are not replaced by the `glib` Rust wrapper's MIT license. The release collector traces actual ELF files to the build runner's installed package using ELF build IDs, preserves package copyright/common-license texts, and downloads the exact Ubuntu source packages. It also identifies the AppImage runtime commit and includes the runtime source/build scripts/patches, upstream-pinned FUSE and squashfuse sources and AppRun notice. An unknown native origin or unavailable exact source fails collection rather than silently producing an incomplete release.

Distribute `our-pets-linux-native-sources-<version>.zip` with the AppImage and notice ZIP. Preserve the source archives and their original conditions when mirroring a release. The source collector requires Ubuntu `deb-src` repositories, enabled only on the ephemeral release runner. It does not change users' repository configuration or firewall. The source release tag supplies Our Pets code and build instructions. Extracted AppDir libraries can be replaced; this project imposes no additional reverse-engineering restriction on LGPL debugging or relinking. Follow the runtime's original build instructions when rebuilding its static FUSE linkage.

DEB system dependencies installed independently are supplied under the distribution's terms. macOS system frameworks and Windows WebView2 follow their respective vendors' terms; OS signing/notarization and store submission are separate distribution tasks. New store distribution, paid hosting, analytics, or integrations require a fresh review.

## Artwork and uploads

Gopher retains Renée French's attribution, CC BY 4.0 link, and a modification notice. Ferris retains Karen Rustad Tölva's CC0 attribution and the MIT notices of reference sprites. Pretendard remains OFL 1.1 and is bundled unmodified. AI-generated adaptation does not cancel the original design's rights or establish exclusive rights to generated artwork. See [character assets](character-assets.md).

Uploaded files remain subject to their original rights. Registration allows their storage and display within the selected server for the requested feature; it does not assign ownership to the maintainer or apply the project's code license. Use only images you have the necessary rights to use/share. There is no official endorsement or affiliation with Docker, Slack, OpenAI, Anthropic, Go, Rust, or their owners. Provider names identify supported integrations.

## Primary references

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt)
- [GSAP Standard License](https://gsap.com/community/standard-license/)
- [Slack App Developer Policy](https://docs.slack.dev/developer-policy/)
- [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/)
- [GNU LGPL distribution FAQ](https://www.gnu.org/licenses/gpl-faq.html#LGPLStaticVsDynamic)
- [Korean Personal Information Protection Act](https://www.law.go.kr/법령/개인정보보호법)
