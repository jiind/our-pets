# API v1: real-time pets

Base URL: `http://127.0.0.1:9377/api/v1`. JSON uses camelCase; times are UTC Unix milliseconds unless specified otherwise. IDs are random 32-character hexadecimal strings. Errors use `{"error":"description"}`. Unknown request fields are rejected. Authenticate with `Authorization: Bearer <token>`; never place tokens in URLs or ordinary logs.

`displayName` is the account nickname, used for Pet `name`/`ownerName` and sender/host information. `petName` and registration `name` are compatibility inputs and cannot change the nickname. Pet ID, owner, and design name are distinct.

## HTTP

| Endpoint | Request and response |
| --- | --- |
| `GET /healthz` (outside prefix) | `{status:"ok",service:"our-pets"}` |
| `POST /register` | `{username,password,displayName,invite,deviceName}` → `{token,principal}` |
| `DELETE /me/account` | `{currentPassword}` → `{status:"deleted",pendingFileCleanup}`; password-confirmed, rate-limited self-deletion |
| `POST /login` | `{username,password,deviceId?,deviceName?}` → `{token,principal}` |
| `POST /logout` | Revoke the current session |
| `GET /me` | Current user/device/pet IDs and `petRegistered` |
| `GET /me/account` | Own `{username,displayName}`; excludes password hashes and credentials |
| `PUT /me/account` | `{displayName}` → updated own account; username and user-ID fields are rejected |
| `PUT /me/password` | `{currentPassword,newPassword}` → 200 `{status:"changed"}`; verifies the current password and revokes other sessions while keeping the current session |
| `GET /me/pet` | Own Pet plus `registered`; available before registration |
| `POST /me/pet/registration` | `{designId:"default"|"builtin:dog"|"builtin:gopher"|"builtin:ferris" or an owned design ID}` → 200 registered Pet, preserving ID |
| `GET /me/designs` | Owned designs, including unapplied drafts, excluding deleted or superseded versions |
| `GET /pets` | `{id,userId,ownerName,name,design,online}[]` |
| `POST /designs` | Multipart `image`, `name`, `manifest`, optional `draft="true"`; registration UI uploads a draft and then confirms through registration |
| `GET /designs/{id}` | Design metadata |
| `PUT /designs/{id}` | Owner only: `{name,manifest}` → 200 new immutable Design version using the same PNG; replaces the old entry in the owner's list and their active appearance if selected |
| `DELETE /designs/{id}` | Owner only → 200 `{status:"deleted"}`; removes the list entry and restores the owner's active appearance to the built-in cat if needed, preserving Pet ID |
| `GET /designs/{id}/image` | Authenticated PNG retrieval |
| `PUT /me/pet/design` | `{designId}`; preserves pet ID |
| `POST /messages` | Message below → 201 `{id,petIds,status:"accepted"}` |
| `GET /messages/{id}` | Sender only: `{id,status,recipients:[{petId,receivedAt,deviceCount}]}` |
| `GET /inbox` | Unacknowledged events for the current connection, not a history inbox; empty when offline |
| `POST /inbox/{id}/ack` | Per-device receipt acknowledgment |
| `GET /gatherings` | Public active recruitments and authorized legacy message gatherings |
| `POST /gatherings` | `{kind:"coffee"|"smoke"|"meal"|"chat"|"walk",idempotencyKey:UUID}` → 200 gathering |
| `POST /gatherings/{id}/complete` | Host only → `{completed:true}` |
| `POST /gatherings/{id}/accept` | Join a public recruitment; legacy message gatherings also verify recipient permission |
| `POST /gatherings/{id}/leave` | Leave as a participant; hosts use complete |
| `GET /connectors` | Own server sample connections |
| `POST /connectors` | `{kind:"sample",config:{}}` → 201 connection only; registered pet required |
| `POST /connectors/{id}/test-events` | `{idempotencyKey:UUID}` → 202 `{status:"accepted"}`; explicitly emit one owned sample |
| `DELETE /connectors/{id}` | Delete own sample → 200 `{deleted:true}` |

A session is required except for registration, login, health, and the WebSocket authentication handshake. CIDR/Origin checks apply before authentication. Usernames contain 3–32 lowercase ASCII letters, digits, `_`, or `-`; passwords are 10–256 bytes. Display/design names are at most 80 bytes. Sessions expire after 30 days. Optional registration `petName` is a compatibility field; pet registration is separate. Signup sets `active=0`; pet registration sets `active=1`.

Design editing accepts JSON metadata only; PNG/image-hash replacement fields are rejected. Only uploaded PNG designs can be edited or deleted. Built-in pets are protected. Repeated edits/deletes of an old version return 409. Retired designs remain retrievable for existing message snapshots and other pets already using them, but cannot be newly selected. Physical PNG files are retained, including content shared by other designs.

## Messages

```json
{
  "senderPetId": "own-pet-id",
  "mode": "selected",
  "petIds": ["friend-pet-id"],
  "kind": "text",
  "body": "Coffee together? ☕",
  "idempotencyKey": "client-request-uuid"
}
```

- Omit `proposalKind` for ordinary messages. Emoji belong in the `text` body.
- Gatherings use `/gatherings`. Creating a new message with `proposalKind` returns 400; old events retain that field for compatibility reads.
- `selected` accepts 1–1000 input IDs, deduplicates them, and sends only to connected pets. A selected offline target returns 409. Broadcast uses `mode:"all",petIds:[]`, snapshotting other connected pets at acceptance and excluding the sender.
- Sender and targets use stable pet IDs. Sending as another user's pet is rejected.
- Bodies contain 1–2000 nonblank Unicode code points. Request keys are 8–128 bytes; changing content for an existing key returns 409.
- Replies set `replyToMessageId` and target only the original sender pet. Unauthorized original-message access or a different target returns 404; broadcast replies return 400.
- `kind:"interaction"` uses one recipient with `body:"wave"` or `"highfive"`. `kind:"emoji"` remains compatibility-only; the app uses text containing emoji.

## WebSocket

Connect to `/api/v1/ws` and send `{"type":"auth","token":"..."}` within 5 seconds. After registering the device connection, the server sends `{"type":"ready","deviceId":"..."}`. A new socket replaces the old connection for the same device only; other devices continue receiving.

Unregistered accounts get 403 from message/gathering HTTP endpoints. After initial WebSocket authentication they close with 1008 `pet registration required`. They do not count as online pets before registration.

Only unexpired messages created after the current connection are delivered. Reconnection does not replay the previous connection's pending messages. Retries within one connection and message-ID deduplication remain active. ACK does not mean the user read the message.

```json
{
  "id": "message-id",
  "type": "message",
  "kind": "text",
  "body": "Coffee? ☕",
  "sender": {
    "userId": "user-id", "userName": "Sam",
    "petId": "pet-id", "petName": "Sam", "designId": "design-id"
  },
  "createdAt": 1790000000000,
  "expiresAt": 1790000060000
}
```

Ordinary messages omit `proposalKind`; built-in designs omit `designId`. Replies optionally include `replyToMessageId`. External events use `type:"notification",kind:"external"` with `notification:{schemaVersion,eventId,sourceKind,connectionId,occurredAt,title,body,resource?,data?}`. Provider credentials and executable commands are excluded.

Clients persist deduplication IDs/expiry rather than message bodies, then send `{"type":"ack","id":"..."}`. The server retries unacknowledged events every 5 seconds on the same connection. Client cards wait at most 15 seconds. Muted content is not replayed later as an inbox.

## Current gathering state

When state changes, the socket sends a snapshot rather than a message-history entry:

```json
{
  "type": "gatherings",
  "gatherings": [{
    "id": "gathering-id",
    "hostPetId": "host-pet-id",
    "kind": "coffee",
    "origin": "recruitment",
    "host": {"userId":"user-id","userName":"Sam","petId":"host-pet-id","petName":"Sam"},
    "status": "open",
    "expiresAt": 0,
    "members": [{"petId":"member-id","petName":"Alex","userName":"Alex"}]
  }]
}
```

`origin:"recruitment"` identifies a public gathering; kinds are `coffee`, `smoke`, `meal`, `chat`, and `walk`. `expiresAt:0` means no automatic expiry. These gatherings persist independently of messages/recipients and survive server restarts, disconnects, and message cleanup. Reconnection synchronizes current state only. Each PC calculates coordinates locally.

Creation is idempotent by UUID request key. Reusing a key with another kind returns 409. Creating an already-open own gathering of the same kind returns the existing object. Retrying a completed key returns the closed original; use a new key for a new gathering. Only the host can complete; participants can leave themselves. One pet joins one gathering, and unrelated actions do not automatically close an active gathering. Legacy `origin:"message"` gatherings retain recipient authorization, 30-minute expiry, and closure on last-device disconnect or server restart.

## Local IPC

| Command | Responsibility |
| --- | --- |
| `desktop_state` | `{visible,showOthers,petSize}` |
| `set_desktop_preferences` | Update optional `visible`, `showOthers`, and `petSize` |
| `pet_control` | `show`, `hide`, `toggle`, `others`, `restore`, `settings`, `quit` |
| `sync_peers` | Create/remove windows using connected peer IDs only |
| `set_pet_registered` | `{registered:boolean}`; registration/logout gate independent of visibility preference |
| `sync_gatherings` | `{localPetId,groups}` for gathering locks and adjacent placement |
| `local_list_sources` | Settings window: list own personal sources |
| `local_save_source` | `{draft:{id?,name,config,appToken?}}` |
| `local_enable_source` | `{id,enabled}` |
| `local_remove_source` | Delete source and credentials |
| `local_refresh_codex` | Settings only `{id}`; manual query returning public `CodexUsage` |
| `local_refresh_claude` | Settings only `{id}`; inspect latest bridge value, no remote query |
| `local_claude_bridge_info` | Settings only; installation/settings path, session fingerprints, public usage |
| `local_configure_claude_bridge` | Settings only `{enabled}`; explicitly install/restore status-line integration |
| `local_notifications` | Own pet only, `pending:true`; retrieve current temporary events |
| `local_ack_notification` | Delete acknowledged temporary body |

Personal sources are not registered with the LAN server. Slack tokens remain in OS credential storage. Codex delegates authentication to the CLI rather than reading authentication files or forwarding tokens. `desktop-preferences-changed` synchronizes app/tray state. `pet-motion` sends actual gait/direction to its window only. `dismiss-pet-menu` closes menus on outside clicks while preserving transparent non-focusable windows and input to underlying apps.

Codex config is `{kind:"codex",executable:"codex",mode:"interval",usagePercent:10,pollSeconds:60,notifyExhausted:true,notifyRecovered:true,notifyOnRefresh:true}`. Modes are `interval|once`; usage is an integer from 1–100 and polling from 30–3600 seconds. The executable must be `codex` or an absolute path, with no extra command arguments. Only settings can manage or refresh sources; peer windows cannot.

Source queries may return `codexUsage:{checkedAt,ordinaryUsageAllowed,windows:[{key,label,usedPercent,resetsAt,windowDurationMins}]}`. `checkedAt` uses milliseconds; provider `resetsAt` uses Unix seconds. Optional values may be null; unknown permission is not treated as true. `local-sources-updated` sends a payload-free change signal to settings, which re-queries public data. Personal `sourceKind:"codex"` uses the shared bubble/OS/ACK path. Threshold state and generated events commit in one local SQLite transaction; quota data is not stored on the LAN server.

The current PC's `outgoing-message` confirmation does not add the sender to server recipients/history. It uses `outgoing:{mode,recipientCount}` and `id:"sent:<messageId>"`.

A registered pet can retain its currently shared design reference during compatible name updates. Newly selected registration/appearance IDs must be owned designs. The shared-design compatibility path in `PUT /me/pet/design` remains available. `draft=true` never immediately applies to registered pets; ordinary uploads for unregistered pets also only store a design.

Local `pet-hover` reports a boolean only when the pointer enters/leaves that window's actual input region. It drives nameplates, not LAN events or another input hook. Nameplates are excluded from input regions.

## Gathering activity events

`gathering_activity` is a one-shot WebSocket event separate from the `gatherings` state snapshot. It contains `id`, `action`, public `actor` identity, the gathering/members at the change, `createdAt`, and `expiresAt`. It does not use message ACK/read state.

| Action | Recipients |
| --- | --- |
| `started` | Every currently connected device of other pets, excluding the host |
| `joined` | Currently connected devices of the host pet |
| `completed` | Currently connected devices of participants at completion commit |

Only actual creation, new participation, and first completion emit events after commit; idempotent retries do not. Events expire after 15 seconds and are not replayed by reconnects or historical queries. Per-device activity queues are capped at 128; overflow is dropped without blocking required message delivery.

## Manual sample connections

Adding, listing, refreshing, or restarting connections does not emit events. Explicit emission uses common notification storage, WebSocket, bubbles, and OS notifications. Connection ID/request key deduplicate retries; keys are 8–128 bytes. Another user's emission/deletion or emission from a deleted connection returns 404. Disabling samples blocks emission but permits deletion of owned connections.

`intervalSeconds` is read for compatibility but does not schedule emissions. `fail=true` returns 503 on manual emission without automatic retry. Deletion removes configuration, credential references, and subscriptions, excluding the connection from listing, restoration, and pending delivery. Existing in-flight receipt relationships remain until retention cleanup removes events and deletion markers.

## Built-in character selection

Public Pet/message/gathering identities include `builtinId`: `cat`, `dog`, `gopher`, or `ferris`. Uploaded `design` takes precedence. Registration/design application accepts `default` or `builtin:cat|dog|gopher|ferris` to clear the uploaded-design reference and choose a built-in character. Pet IDs, devices, and recipient relationships remain unchanged. `pets.builtin_id` defaults to `cat`; PNGs and message snapshots are stored separately. Artwork and animations are bundled, with no runtime download. Other PCs need an app version supporting the selected ID.

## Claude personal source

Claude config is `{kind:"claude",sessionKey:"<SHA-256-session-fingerprint>",mode:"interval",usagePercent:10,notifyExhausted:true,notifyRecovered:true,notifyOnRefresh:true}`. Mode is `interval|once`; usage is an integer from 1–100. `claudeUsage` uses the same public usage shape as `codexUsage`, with `ordinaryUsageAllowed:null` and `checkedAt` equal to actual status-line receipt time. UI remaining quota is `100 - usedPercent`. Raw session IDs, credentials, and saved commands are not exposed.

`local_claude_bridge_info` returns `{installed,settingsPath,sessions:[{sessionKey,usage}]}`. Bridge install/restore is settings-only and fixed to the app data path. Ordinary/peer webviews cannot choose paths or request authentication files. Raw data stays on the PC.

## Pet menus and paired interactions

The server retains selected-ID lists for compatibility. UI sends only `mode:all` from the own pet or `mode:selected,petIds:[peerId]` from a clicked peer. Replies target one sender. Sends reuse idempotency and local outgoing confirmation; there is no multi-select menu.

`pair-reaction` optionally includes `leftID` so both characters face each other according to local placement. For wave/high-five, `toID` stays fixed and `fromID` approaches and returns. Sender/recipient roles do not reverse across PCs; both poses use the same local clock. Own-pet menus omit these interactions.

## Sender-pet message bubbles

Message input/send controls are at the menu bottom. Own-pet menus broadcast and peer menus target that peer; stable server sender/recipient relationships are unchanged.

`register_message_bubbles({ready})` lets a peer window register only its own readiness. `route_message_bubble({recipientPetId,senderPetId,message})` is representative-pet-only. It validates sender ID, expiry, size, and incoming-message status, then sends `sender-message-bubble({recipientPetId,message})` only to the ready `peer-<senderPetId>` window on this PC. Peers recheck recipient and displayed sender IDs. External source notifications do not use this route.

The recipient's representative pet requests one OS notification; the sender window only displays the bubble. If the sender is hidden, offline, beyond the window cap, or not ready, only OS delivery remains. The message never moves to the recipient's pet or forces a hidden sender to appear. Recent IDs are deduplicated in each window's memory and expired events are not displayed. Replies address the bubble's sender. Server recipients, ACK, per-device delivery, OS notification preferences, and OS permissions remain in force.

Personal external notifications optionally include `connectionName`. New local events populate it from the current configured source name. Both native OS and bubble titles follow `Provider · Connection name · Event title`; legacy events without the optional field omit that segment. Notification bodies are held only in process memory; durable local storage contains configuration, baselines and hashed event keys.
