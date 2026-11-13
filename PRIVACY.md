# Privacy and data handling

Our Pets is self-hosted software. The project does not operate a shared account or messaging service. Each server operator determines their own purposes, lawful basis, access controls, retention, and contact details. This notice describes the software's default behavior; it is not an operator-specific privacy policy or a request for blanket consent.

## Local-network server

The server stores usernames, nicknames, salted password hashes, user/pet/device identifiers, device names, hashed login tokens, pet designs and PNG files, message contents and sender snapshots, recipient/device delivery receipts, and gathering membership. A nickname, presence, selected pet design, and open recruitment are visible to other authenticated users of that server. Selected messages are delivered only to their recipients. Administrators with access to the server database or backups can access stored contents; messages are not end-to-end encrypted.

By default a login lasts 30 days, messages can be delivered for one minute, and messages and server-side sample notifications are retained for one hour. Hourly maintenance removes expired records, so physical cleanup can follow the retention cutoff by up to one maintenance interval. Open gatherings can continue until completion or disconnect. Server operators can change message lifetime and retention; this document does not override their configuration.

Accounts, devices, and uploaded designs do not expire automatically. Account deletion requires the current password and deletes the account, sessions, pet, owned designs, sent messages, recipient receipts, hosted gatherings and memberships, and owned server-side sample connections. Other pets using a deleted account's design return to the cat. Unreferenced PNGs are removed; identical PNGs still referenced by another account are retained. Other people's messages and independent copies are not erased. Backups and copies already delivered to devices require their own retention and deletion procedures.

## This PC

The OS WebView profile holds the selected server address, login token, device identifier, and display preferences. Protect the OS account and profile. Logout clears the active session; it does not delete the account, OS-wide personal connections, caches, or OS notification history. There is no in-app message inbox or offline replay.

Personal Docker, Slack, Codex, and Claude connections run as the current OS user. Connection configuration, sanitized status, quota baselines, and SHA-256 event deduplication fingerprints are stored in `local-notifications.sqlite3` under Tauri's app data directory. Event fingerprints expire after one day. The collector holds pending notification bodies only in process memory for up to 15 seconds until app acknowledgment; they are not written to this database. Pending collector bodies are dropped on process exit, source stop, or source deletion. Delivered cards are rendered in the app; reading input can extend their display time, and renderer state can remain in memory until the next card or view teardown. These queue timings are not a guarantee of memory zeroization. During upgrade, legacy persisted event bodies are removed and SQLite is compacted/checkpointed. This cannot erase old backups, filesystem snapshots, or storage-device remnants.

Slack app tokens are stored in the OS credential store (Keychain, Credential Manager, or Secret Service). A locked or unavailable store prevents saving; there is no plaintext fallback. Deleting a Slack connection removes its local settings and credential. Tokens must also be revoked in Slack if access should end for all applications. The app does not copy Codex authentication files. The Claude status-line bridge receives usage metadata, not conversation text or authentication tokens. Removing a Claude connection and restoring the installed status-line bridge are separate operations.

These sources belong to the OS user, not a LAN account. Deleting a LAN account does not delete shared OS-user connections. Remove sources in Notifications, remove the Claude bridge if installed, and clear OS notification history/profile data when retiring a PC or OS account.

## External services and notifications

Core features do not require external cloud authentication, analytics, advertising, or runtime CDN/font requests. Optional Slack and Codex connections communicate with their providers using the user's configured local authorization. Docker connections communicate with the selected engine; HTTPS/WSS protects supported remote connections, while local sockets use OS access control. Users control whether to enable these integrations and must have permission to access the source data. The project maintainer does not receive personal connector events through the LAN server.

If OS notifications are enabled, sender names, message text, recruitment information, or external notification contents are handed to the OS notification service. The OS may retain or display these on the lock screen according to its settings. App acknowledgment or source deletion does not clear system notification history. Use OS notification/privacy controls on shared or sensitive devices.

On Linux X11, button events are observed in memory to dismiss menus and finish drags. Keyboard contents and pointer movement are not collected or stored by this observer.

## Your choices and requests

Use Account to change your nickname/password or delete the current server account. Use Notifications to stop or delete personal sources and remove the Claude bridge. Contact the operator of the server you joined for data access, corrections, deletion, backup retention, or a failed PNG cleanup. The operator must publish their identity/contact and any legally required server-specific policy. A template is provided in `docs/server-privacy-template.md`.

GitHub issue reports and provider accounts follow their respective services' policies. Do not upload real credentials, personal messages, databases, or sensitive screenshots to public issues. Report security issues privately as described in `SECURITY.md`.
