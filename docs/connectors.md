# Personal notification sources

Personal sources run directly in the desktop app under the current OS user. After signing in, use the + beside external connections on the notifications page to add Docker, Slack, Codex, or Claude. Sources can be paused, resumed, edited, and deleted. A browser-only settings preview cannot run them.

## Docker

1. Select Docker and set a display name. The default endpoint, `local`, finds the OS Docker socket or named pipe.
2. Alternatively specify `unix:///var/run/docker.sock`, `unix:///Users/<user>/.docker/run/docker.sock`, `npipe:////./pipe/docker_engine`, `http://<host>:2375`, `https://<host>:2376`, or `tcp://<host>:2375`. HTTP/HTTPS/TCP endpoints allow only host and port, not credentials, API paths, queries, or fragments.
3. Optionally restrict containers by comma-separated name or ID; empty means all containers. Default actions are start, die, restart, health-status change, stop, and destroy. Select individual actions or explicitly select all.

The collector negotiates the Docker API version and reads Events API data. It does not control containers, run commands, or change images. Each stream connection starts at the current time; events from disconnected periods are not replayed. Remote HTTPS certificate configuration follows the local Docker certificate environment. Per-endpoint certificate selection and Docker CLI context switching have no UI.

## Slack

Slack requires internet access. Enable Socket Mode for your Slack app and create an `xapp-` App-Level Token with `connections:write`; an `xoxb-` bot token cannot replace it. Install the app in the workspace and grant the required event subscriptions and read scopes. Enter a display name, workspace ID (`T…`), at least one conversation ID (`C…`, `D…`, `G…`), and token. Choose messages, app mentions, reaction additions, or reaction removals.

| Content | Example event subscription | Example read scope |
| --- | --- | --- |
| Public-channel messages | `message.channels` | `channels:history` |
| Private-channel messages | `message.groups` | `groups:history` |
| Direct/group messages | `message.im`, `message.mpim` | `im:history`, `mpim:history` |
| App mentions | `app_mention` | `app_mentions:read` |
| Reactions | `reaction_added`, `reaction_removed` | `reactions:read` |

Only selected conversations and events are stored. Events are persisted before the Socket Mode envelope is acknowledged; persistence failure causes reconnection without acknowledgment. Slack message/reply/reaction write APIs are not called. Duplicate App-Level Tokens are rejected on one PC. Slack can distribute events among other PCs or collectors using the same token, so identical notification delivery to every collector is not guaranteed.

## Codex usage

Install Codex CLI on this PC and sign in to the intended ChatGPT account with `codex login`, then add a connection. API-key and organization billing usage are not queried. The default alert interval is 10% usage and polling interval is 60 seconds. Set usage thresholds from 1–100% and polling from 30–3600 seconds. If `codex` cannot be found, enter its absolute executable path. One Codex connection is allowed per PC.

Interval mode establishes a baseline on the first query: starting at 27% yields the next notification at 30% for a 10% interval. Once mode alerts once per quota cycle when the threshold is reached. Exhaustion, explicit recovery, and manual-refresh result alerts can be toggled individually. The UI displays **remaining quota** (`100 - usedPercent`); thresholds use consumed quota, not the current conversation's context usage. Each provider-supplied quota window is shown without assuming a fixed duration. Decreasing usage or an estimated reset time alone does not prove recovery when explicit usage permission is absent.

The app uses the CLI's local `app-server` for account/quota queries. It only performs allowed reads, not model tasks or authentication changes. CLI login and queries require internet access.

## Claude Code usage

Choose Claude and apply the status-line bridge. The app preserves the user's existing status-line command while receiving usage from Claude Code. Removing the bridge restores the saved command. If settings changed externally or cannot be parsed as JSON, they are not overwritten automatically. After activity in Claude Code, refresh sessions, choose the session, and save the source. Sessions from multiple accounts are not combined.

Configure interval or once-per-cycle usage alerts, exhaustion/recovery, and latest-value notifications. Latest-value checking reads the last bridge payload, not Claude's remote servers. An estimated reset time alone does not trigger recovery. Removing the bridge and deleting a source are separate actions.

## Local storage and privacy

Connection settings, status, quota baselines, and temporary events live in `local-notifications.sqlite3` beneath the OS user's Tauri app data directory. Personal notifications target this PC's own pet and are not synchronized to the LAN server or friends. Pending events live at most 15 seconds; acknowledgment deletes bodies. App restart does not replay old pending bodies.

Slack tokens use macOS Keychain, Windows Credential Manager, or Linux Secret Service. If secure storage is unavailable, saving fails; no plaintext fallback is used. The ordinary database stores only a duplicate-detection fingerprint. The app does not copy Codex authentication files. The Claude bridge does not collect conversation bodies or authentication tokens.

Connections belong to the OS user. Use separate OS accounts on shared PCs. The app cannot expand permissions beyond the Docker engine, Slack app, Codex login, or Claude configuration.

## Authoring a connector

Implement personal sources in `desktop/src-tauri/src/connectors/`. Add configuration and validation to `types.rs`'s `SourceConfig` and connect a provider collector to the `Engine` lifecycle. A cancellation token stops collection and reconnect waits. `Engine.status` reports sanitized state/errors. Provider failure must not stop the LAN message socket or other collectors.

Normalize events to a common `Notification` and call `Engine.publish`. Fields are `schemaVersion`, `eventId`, `sourceKind`, `connectionId`, `occurredAt`, `title`, `body`, and optional `resource`/`data`. Keep provider-specific fields in `data`; exclude credentials and executable commands. If no stable event ID exists, define a provider-specific fingerprint using content, time, and resource. The store deduplicates connection/event IDs and retains deduplication keys for one day. New sources must not require pet-design or bubble-renderer changes.

The server-side contract is `internal/connectors.Connector`: `Descriptor()` describes kind/version/configuration; `Validate()` checks configuration; `Run(context,connection,sink,reporter)` collects, emits normalized events, and reports status. Context cancellation stops it. Connections and subscription targets remain separate. Server credentials use `credentialRef`, not ordinary events. Personal sources do not register with this server contract.

## Manual development sample

Enable `OURPETS_SAMPLE_ENABLED=true` on the server to use the manual sample. There is no sample registration UI. Authenticate and POST `{"kind":"sample","config":{}}` to `/api/v1/connectors`, then POST a unique `idempotencyKey` to that connection's `/test-events` endpoint to emit one event. Creation, queries, and restart do not emit automatically. Reusing the key does not create duplicates.

`config:{"fail":true}` deliberately fails explicit emission. Delete your connection with `DELETE /api/v1/connectors/{id}`. Ownership/subscription checks apply; disabling samples still allows deleting an owned connection. This development delivery check is separate from real personal Docker/Slack collectors. See the [API specification](api.md).
