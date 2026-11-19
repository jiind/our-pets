# User guide

The app supports Korean and English. On first launch it saves Korean if the OS prefers Korean and English otherwise. It reads the OS locale locally.

Open **App language** with the flag button in the upper-right corner of the app window, then select Korean or English. The app applies the language immediately and uses the saved choice on future launches. The setting also controls pet menus, app-generated notifications, and tray commands. Changing language preserves unsaved inputs and current real-time connections. Nicknames, messages, uploaded design names, and provider event content remain in their original language. License documents retain their original wording.

## Invite friends and register a pet

1. Select **Get started** to open a personal pet. The app starts its server on this PC for private use. Under **Settings → Server information**, select **Allow external access** and **Copy invite link**. Send the link to friends on the same local network.
2. Open the invite link or paste it into **Join with an invite link**. On your first visit, enter a nickname and select **Join**. The app remembers your account on that device, and your nickname appears on your pet's nameplate.
3. On the pet page, choose a built-in character or an uploaded PNG and complete registration. Changing appearance preserves the pet's recipient ID.

The room is available while the host app is running with external access enabled. **Block external access** disconnects friends and leaves your personal pet running. The app-hosted room uses HTTP on the local network. Allow the app's host process on the private network if the OS requests firewall access. If the host moves to a different network, restart the app and share its current link.

To use a separately managed server, ask its operator for an invite link. See [deployment](operations.md) for the link format, standalone server setup, TLS, and access restrictions.

## Account settings

Open **Settings → Account information** to change your nickname. Saving it updates your pet's name while preserving its ID. The start screen shows the most recently used pet. The app stores each server's device credentials in the local app profile. Use **Reconnect** after signing out to return to the same pet. Clearing that app profile or using a different PC requires joining again.

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

Bubbles wrap text and grow vertically to fit their content up to the available height limit. Longer content scrolls inside the body while the heading and close button remain visible. A new message starts from its beginning.

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

## Notification cards

External notification titles use `Provider · Connection name · Event title` in both the speech bubble and OS notification; the body contains only the event content. Speech bubbles have a 320 px reading width and grow naturally up to a 320 px total height (or less when screen space is limited). Longer text scrolls only inside the body, leaving the title and red X fixed. Text wraps automatically, including long container identifiers.

Bubbles close after 12 seconds without reading input. Scrolling or keyboard reading restarts that interval; hovering alone does not keep a card open forever. Opening and closing use short motion effects. The existing OS reduced-motion preference skips these effects without adding an app preference. OS notification history/lifetime is controlled by the OS.
