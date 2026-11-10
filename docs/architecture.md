# Architecture

Our Pets is a standalone desktop application for people on the same local network. The Go server manages accounts, pets, messages, and gatherings. The Tauri application manages desktop windows, rendering, interactions, and personal notification sources. Core features do not require cloud authentication, a CDN, or internet access.

## Components

The server is a modular monolith running in one Go process. It uses SQLite in WAL mode and a PNG file store addressed by SHA-256. A single database connection serializes writes. No external message broker is required.

| Location | Responsibility |
| --- | --- |
| `internal/identity` | Local accounts, registration code, passwords, devices, and sessions |
| `internal/pets` | Stable pet IDs, design versions, PNG validation, and file storage |
| `internal/messaging` | Sender authorization, idempotency, and recipient snapshots |
| `internal/delivery` | Per-device real-time delivery, acknowledgments, and WebSocket |
| `internal/gatherings` | Recruitment, participation, completion, and current state |
| `internal/connectors` | Server connector contract and manual sample |
| `internal/notifications` | Server connections, subscriptions, notifications, and deduplication |
| `internal/server` | HTTP, CIDR and Origin restrictions, input limits, and errors |
| `internal/database` | SQLite schema and ordered migrations |
| `desktop/src-tauri` | Transparent windows, tray, input regions, coordinates, and movement |
| `desktop/src-tauri/src/connectors` | Personal sources, OS credential storage, and temporary notifications |
| `desktop/src` | Settings UI, Canvas, message composition, bubbles, and interactions |

## Data relationships

- `User 1—N Device 1—N Session`: session and connection lifetimes are separate from users and pets.
- `User 1—1 Pet`: each user has one representative pet, registered separately after account creation. The account nickname is displayed on the nameplate.
- `User 1—N PetDesign`, `Pet → currentDesign`: designs are immutable versions with uploader ownership checks. Identical files can share content-addressed storage.
- `Message → senderPet`, `Message 1—N MessageRecipient → Pet`: sender identity and design are snapshotted when sending; recipients reference stable pet IDs.
- `MessageRecipient` and `device_receipts`: the pet's first app receipt and each device's receipt are tracked separately. Neither is a read receipt.
- `Gathering → hostPet`, `Gathering 1—N GatheringMember → Pet`: gathering and membership state is stored independently of messages.
- `ConnectorConnection 1—N NotificationSubscription → Pet`: server connections and subscription targets are separate. `ExternalNotification(connectionId,eventId)` identifies duplicate events.

Changing a design, signing out, or losing a connection does not change the pet ID. The base schema is `internal/database/schema.sql`; later changes live in `internal/database/migrations/` and are applied in order using `schema_versions` at startup.

## Message delivery

HTTP accepts sends and WebSocket delivers events. The server obtains the sender from the authenticated session and verifies pet ownership. The sender pet and idempotency key identify one request; reusing a key with different content is rejected.

| Policy | Behavior or setting |
| --- | --- |
| UI targets | Own pet: everyone; friend's pet: that friend. The server retains the selected-ID list API for compatibility |
| Broadcast scope | Valid pets connected when the request is accepted, excluding the sender |
| Offline behavior | Selected offline recipients are rejected. Reconnection and new devices do not replay old messages |
| Message lifetime | `OURPETS_MESSAGE_TTL`, default `1m`; only events created after the current connection qualify |
| Server retention | `OURPETS_RETENTION`, default `1h`; no user inbox is provided |
| Multiple devices | Each connected device receives and acknowledges independently. A new socket replaces only the previous socket for the same device |
| Retries | Unacknowledged events are retried after 5 seconds on the same connection; clients deduplicate by ID and expiry |
| Local display | New cards wait at most 15 seconds. Message bodies are not retained in localStorage |

One device's acknowledgment does not remove another device's delivery. Clients persist deduplication IDs before acknowledging. Deleting an expired stored message also removes its idempotency key; keys are not retained permanently.

Replies target only the original sender pet. A successful send creates a local confirmation on the sending PC without adding the sender to server recipients. Incoming text appears above the sender's pet and through OS notifications. If that pet is hidden or unavailable, only the OS notification is used.

## Desktop behavior

Settings and non-focusable transparent pet windows are separate. The representative pet window owns one LAN socket and forwards local events to peer windows. Offline peer windows are removed. Coordinates and animation frames are computed locally and are not sent to the server.

Left-click petting is local for any pet. Dragging changes position and height; release makes the pet land. Right-click opens messaging, gatherings, and peer interactions. For greetings and high-fives, the sender approaches the recipient, both react, and the sender returns. Those roles are identical on both PCs.

Gatherings support coffee, smoke breaks, meals, chats, and walks. The host stops; accepting pets stay beside it until the host completes or a member leaves. Reconnection synchronizes current gathering state without replaying old activity notifications.

Rust `desktop_controls` owns visibility, peer visibility, and size, synchronizing the app, tray, and windows. Messages never force hidden pets to appear. Canvas uses shared frame bounds and foot/head anchors; walk frames follow actual movement distance. Idle and hidden states reduce unnecessary rendering. See [platform requirements](platforms.md) for input and focus constraints.

## Personal notification boundary

Docker, Slack, Codex, and Claude sources run directly on the signed-in PC and are not registered in the LAN server's connection table. Ordinary configuration and temporary events use the app's `local-notifications.sqlite3`; Slack tokens use the OS credential store. Personal events target only this PC's own pet.

Collectors normalize provider events and independently handle deduplication, reconnects, and errors. Pet designs and bubbles do not interpret provider APIs. External control, command execution, and Slack message writing are not exposed. The optional server sample is a separate development path. See [connectors](connectors.md) and the [HTTP, WebSocket, and IPC specification](api.md).
