# LAN deployment and operations

The default server binds to `127.0.0.1:9377` and permits loopback CIDRs only. For LAN deployment, adapt the bind address, allowed CIDRs, and registration code in `examples/server.env.example`. A private IP alone does not authorize access. The server uses `RemoteAddr` and does not trust `X-Forwarded-For`; a reverse proxy must enforce access restrictions itself.

## Server installation

1. In a build environment with dependency access, run `go mod download` and `go build -o bin/our-pets ./cmd/our-pets`. Transfer the server binary and configuration example to the LAN. Go module downloads are not required at runtime.
2. Create an `our-pets` service account and `/var/lib/our-pets` data directory, writable only by that account. Install the binary at `/opt/our-pets/our-pets`.
3. Create `/etc/our-pets/server.env` from the example and restrict access to credentials. Do not put the actual registration code in the repository or command logs.
4. Permit TCP 9377 only from the intended device ranges using host/network firewalls. `OURPETS_ALLOWED_CIDRS` is an additional boundary.
5. Register `examples/our-pets.service` with the service manager, matching its data and environment-file paths to the deployment.
6. Configure a trusted LAN TLS certificate and key together through `OURPETS_TLS_CERT` and `OURPETS_TLS_KEY`. Install the LAN CA into clients' OS trust stores. An `https` server address makes the app use `wss`. HTTP development mode leaves credentials and bodies unencrypted; configure TLS for production transport.

The server does not log raw credentials. `ConnectorConnection.credential_ref` is a reference for provider secrets; the sample has no credentials. Invalid configuration prevents startup. Directories default to 0700 and temporary uploads to 0600; the service uses `UMask=0077`.

## CI and tagged releases

The [release guide](releasing.md) defines PR checks, three-OS packaging, and draft releases from version tags. Source and workflows must be committed and merged for GitHub Actions to use them. Windows/macOS signing and actual desktop validation remain separate steps.

## Client deployment

Prepare Rust, Node, and Tauri prerequisites on the target OS, then run `npm ci` and `npm run tauri -- build --ci -- --locked` from `desktop`. Distribute the native package with fonts and notices. Prepare Windows WebView2 and Linux WebKitGTK/GTK/AppIndicator/X11/compositor dependencies through OS packages or offline installers before entering a disconnected network. macOS uses system WKWebView. See [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/).

Core operation has no external authentication, CDN, cloud, font-server, or broker dependency. Initial build downloads are separate from installed LAN runtime. Personal Slack collection requires outbound HTTPS/WSS from that PC; the LAN server does not proxy it.

On Linux, personal Slack token storage requires an unlocked Secret Service, such as GNOME Keyring or a compatible service. macOS/Windows use their OS credential stores. Missing or locked secure storage causes token saving to fail; there is no plaintext fallback. Personal Slack tokens do not belong in the server environment file. See [connectors](connectors.md) for configuration and local retention.

## Retention and backups

Every hour, the server removes expired sessions, messages/notifications beyond retention, and orphan receipts. Expired messages are excluded from delivery even before cleanup. Old design files and user/device records do not have automatic deletion; monitor disk use.

Copying only the main SQLite file while WAL is active can lose recent transactions. Stop the server and back up the entire data directory, or use a consistent SQLite backup together with a design-directory snapshot. A backup CLI and automatic restore tool are not included.

Logout revokes the token, and its socket closes at the next validation interval. Device-wide revocation, password changes, and per-invite approval management have no UI yet. LAN session tokens use the OS WebView's local storage, not the OS credential store. Protect the OS account and browser profile permissions.
