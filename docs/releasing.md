# CI and releases

## Pull request checks

`.github/workflows/ci.yml` runs on pull requests, pushes to main, manual dispatch, and reusable calls from releases. It has no path filter that could leave a required check pending indefinitely. Contributor PRs receive read-only repository permissions, and checkout credentials are not persisted. Contributor code does not run under `pull_request_target`. Actions are pinned to full commit SHAs; Dependabot proposes updates.

- **Secret scan:** a fixed Gitleaks version, verified by checksum, scans current files and full Git history. Secrets are redacted; findings and execution errors fail the job.
- **Repository checks:** six version declarations, packaging contracts, public-file exclusion rules, and distribution notices.
- **Go checks:** module verification, vet, race tests, and build.
- **Frontend checks:** locked installation, TypeScript/Vite, UI test type-checking, Vitest, and Playwright using installed Chrome. No extra browser download is needed. Test servers use loopback and temporary databases.
- **Native:** Rust unit tests and Tauri CLI builds on Linux, Windows, and macOS, including JS/Rust SDK version compatibility checks. GUI validation is separate.
- **CI required:** succeeds only when every dependency succeeds. Failure, cancellation, or skipping is not converted into success.

Remote CI runs after source/workflows are committed and pushed and the corresponding event occurs. Check results in GitHub Actions. Real user authentication, Slack tokens, and Docker engines are not used in CI.

Gitleaks failure blocks `CI required` and subsequent tagged-release packaging. The CLI works for external PRs without a separate token or organization license. Update the official archive's SHA-256 when changing its pinned version. Personal paths and email addresses need review beyond secret detection.

## Repository settings

Main requires a PR, successful `CI required`, an up-to-date base, and resolved conversations. Force pushes and deletion are disabled; history is linear. The configuration uses zero required third-party approvals so a sole maintainer can merge their own PR. Increase approvals when adding maintainers. Use squash merging and delete merged branches automatically.

Use private vulnerability reporting. Keep secret scanning, push protection, vulnerability alerts, and Dependabot security updates enabled. Weekly Go/npm/Cargo/Actions updates start after `.github/dependabot.yml` is on the default branch. Dependabot auto-merge is not enabled. Repository settings require administrator access; adding the JSON files alone does not apply them to GitHub.

## Versioning and tags

1. Update `desktop/package.json`, both root and `packages[""]` versions in `desktop/package-lock.json`, the app version in `desktop/src-tauri/Cargo.toml` and `Cargo.lock`, and `tauri.conf.json` together.
2. Run `python3 scripts/check_versions.py`. Merge to main after PR CI succeeds.
3. Create and push a version tag such as `v0.1.0` at that main commit. Releases reject tags that differ from the source version or point outside main history. Never overwrite a used tag.
4. After full CI succeeds, build Linux x64 DEB/AppImage, Windows x64 NSIS, and macOS universal DMG on their respective OSes. Build server ZIPs for Linux amd64/arm64, Windows amd64, and macOS amd64/arm64.
5. Only after every target succeeds, create a **draft GitHub release** containing installers, server ZIPs, notice ZIPs, and `SHA256SUMS.txt`. Tags such as `v0.1.0-beta.1` are marked as prereleases. A failed target prevents a partial release. A rerun updates only the same draft; published releases are not overwritten.
6. Review installers, OS behavior, and notices before publication. The workflow does not automatically publish drafts.

Desktop assets use `our-pets-desktop-<version>-<platform>.<extension>` with no spaces, so GitHub uploads preserve the filenames referenced by `SHA256SUMS.txt`. Packaging rejects duplicate bundle types instead of silently collecting stale installers.

Only the final release job uses `contents: write`; it uses `github.token` rather than a personal PAT. Tags include committed source only, not local untracked files.

## Signing and validation

Windows code signing and Apple Developer ID signing/notarization are not configured. Do not put credentials in examples or the repository. Producing DMG/NSIS files is separate from trusted signing and real OS execution. Before publishing, follow the [platform requirements and validation checklist](platforms.md). Native Linux Wayland window control is unsupported.

Fonts, characters, GSAP, and other dependencies retain terms separate from the project's Apache-2.0 license. Tauri resource mappings include project/font/asset notices in installers, and the same notices are supplied as release ZIPs. This does not establish a completed legal review of every transitive dependency. Add original notices and check redistribution terms when introducing libraries.

## License and privacy artifacts

Before tagging, run `python3 scripts/dependency_notices.py` and `python3 scripts/prepare_notices.py --check`. Regenerate and review notices after dependency updates. Packages include PRIVACY.md, operator policy template, code-dependency notices and corresponding MPL sources. Linux packaging additionally traces the actual AppImage native libraries and downloads exact distro/runtime sources; failed origin/source verification must block publishing. Keep the generated Linux native-source ZIP alongside the AppImage when publishing or mirroring. See [distribution safeguards](legal.md).
