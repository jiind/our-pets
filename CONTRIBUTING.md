# Contributing

Our Pets is a standalone desktop companion app for people on the same local network. Start with [README](README.md) for setup, the [user guide](docs/usage.md) for behavior, and [platform requirements](docs/platforms.md) for limitations.

## Proposing changes

- For bugs, include reproduction steps, expected/actual behavior, app version, OS, and Linux desktop/X11/Wayland details. Do not attach passwords, tokens, personal messages, or raw databases.
- For features, explain the use case and desired behavior. Report security issues through the [private policy](SECURITY.md).
- Use lowercase English issue titles in `<type>: <summary>` form. The maintainer's issue workflow uses Korean bodies; reuse existing labels/types and assign newly created issues to the authenticated user. Do not create labels without agreement.
- Branches use lowercase English kebab-case: `<number>-<type>-<slug>` with an issue, otherwise `<type>/<slug>`. Link issue branches in GitHub Development.

## Code and checks

Project documentation is in English. Explanatory code comments follow the repository's Korean-comment convention. Explicit functions/methods/constructors have a role comment above the declaration; multistep bodies also have numbered comments separated by blank lines. Expand brace-delimited blocks onto multiple lines. Preserve module boundaries and avoid unrelated restructuring.

```bash
go test -race ./...
go vet ./...
cd desktop
npm ci
npm test
npm run build
npm run check:ui-types
npm run test:ui
npm run tauri -- build --debug --no-bundle --ci -- --locked
cd src-tauri
cargo test --locked
```

UI checks use installed Chrome without downloading another browser. Test servers use loopback and temporary databases, not real user accounts, Docker, Slack, or CLI authentication. If a work session explicitly pauses tests, respect that pause and distinguish compilation from unexecuted checks in the PR.

Successful CI builds on three OSes do not establish transparency, click-through, focus, or walking behavior. Distinguish actual execution, builds, and unverified platforms. Message/notification history and offline replay are outside the current product scope.

CI scans current files and full Git history with Gitleaks. Findings are redacted and fail required status. Revoke/rotate actual leaked credentials and remove them from files/history. Personal paths/emails require additional review because secret scanning does not identify every privacy issue.

## Pull requests

Describe the problem, resulting behavior, related issue, performed checks, and remaining gaps. Include only relevant source, lockfiles, migrations, and documentation. For assets, preserve creator/source/license/modification notices; the project's Apache-2.0 license does not replace third-party terms. Follow the [release guide](docs/releasing.md) for versions and distribution.
