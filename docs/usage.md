# User guide

The current app UI is in Korean. Control names below are described in English.

## Connect and register a pet

1. Open the app and enter the server address supplied by its operator. For the default server on the same PC, use `http://127.0.0.1:9377`.
2. Create an account or sign in. The server operator supplies the registration code. Your nickname appears on your pet's nameplate.
3. On the pet page, choose a built-in character or an uploaded PNG and complete registration. Changing appearance preserves the pet's recipient ID.

See [deployment](operations.md) for server setup and access restrictions, and [README](../README.md) for development startup.

## Account settings

Open the account menu to view your username and edit your nickname or password. Usernames cannot be changed. Saving a nickname updates your pet's displayed name while preserving user and pet IDs. Password changes require the current password and matching new-password fields. The current login remains active; other login sessions are revoked and their real-time connections close when the server next checks session validity. Password fields are masked, support a visibility toggle, and are cleared after a successful change.

## Pet controls

| Action | Behavior |
| --- | --- |
| Left-click | For uploaded artwork, randomly play one registered animation except the entries assigned to idle and walking; otherwise use the existing petting expression |
| Left-drag | Move or lift it; release to land on the ground |
| Right-click | Open that pet's messaging, gathering, and interaction menu |
| Hover | Show its nickname below its feet |

Greeting and high-five are available on another pet's menu. Your pet approaches that pet, both react, and yours returns. These options are not shown on your own pet. Offline friends disappear from the desktop.

## Messages and replies

Enter text and emoji in the input at the bottom of a pet's right-click menu. Your own pet sends to all other connected pets; a friend's pet sends only to that friend. There is no multi-select recipient screen.

Incoming messages appear above the sender's pet and as OS notifications. Reply from the bubble to address the original sender. If friends are hidden or the sender window is unavailable, only the OS notification is shown; the message is not moved to your own pet.

Bubbles grow vertically to fit their content without scrollbars. Text that exceeds the available screen height uses previous/next controls. Resizing preserves the current reading position, and a new message starts from its beginning.

Each connected device receives messages independently. Messages received while offline are not replayed on reconnect, and there is no inbox. App receipt is not a user read receipt.

## Gatherings

Use the flag menu to choose coffee, a smoke break, a meal, a chat, or a walk. The host stops moving, and accepting pets gather beside it. The host completes the gathering; participants can leave.

Starting a gathering notifies other connected users, joining notifies the host, and completion notifies the participants. Current gatherings synchronize after reconnecting, but old activity notifications do not replay.

Gathered pets reserve space for their artwork and nickname and use additional rows when one row is full. If the selected size cannot fit everyone on the screen, the host's badge and gathering panel show how many participants are temporarily not displayed. They remain members and reappear when space becomes available or the gathering ends. Reducing the pet size can make more participants visible.

## Display and notification settings

On the pet page, show/hide pets, show only your own or include friends, and adjust size. Display options synchronize with the tray and apply to this PC. Selecting a character applies it immediately. Add PNG designs through the add-pet dialog; see [PNG and animation registration](pet-design.md).

Signing out temporarily hides all desktop pets without changing this PC's display preference. After signing in again, pets reappear if they were shown before sign-out. If you explicitly hid them, they stay hidden until you choose to show them.

The desktop displays up to 32 online peer pets at a time, prioritizing your active gathering and recruitment hosts. Messages from a sender without a visible window can still produce OS notifications; they do not force that pet to appear.

On the notifications page, use the + beside external connections to add Docker, Slack, Codex, or Claude. Sources run on this PC and are not automatically shared with friends or other devices. See [connector setup](connectors.md) for credentials, permissions, and query behavior.

Turning connected alerts off mutes bubbles and OS notifications from external sources. Turning OS notifications off mutes all OS banners, including messages and gatherings, while leaving bubbles enabled. Muted events are not queued for later playback. OS permissions and Do Not Disturb also affect banner visibility.
