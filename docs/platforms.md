# Platforms and runtime requirements

Linux, macOS, and Windows are target platforms. Actual desktop pets run in the Tauri app. A browser preview or successful CI compilation does not establish correct transparency, input, or focus behavior.

## Windows and input

Pet windows are transparent, undecorated, always on top, and non-focusable. Closing settings hides it to the tray. Only opaque pet pixels and interactive menu/bubble regions accept input; surrounding space passes input to the application underneath. Focus is requested only for explicit actions that need it, such as text input.

| Environment | Implementation and requirements |
| --- | --- |
| Linux X11 | GTK/GDK input shapes reflect Canvas alpha and shared UI regions. Requires X11 and a compositor |
| Linux Wayland + XWayland | Uses the X11 path through `GDK_BACKEND=x11`; placement, stacking, and scaling depend on compositor policy |
| Native Linux Wayland | No dedicated window-control implementation. X11 or XWayland is required |
| macOS | Compares global cursor position with input regions to switch click-through. Uses WKWebView and `macos-private-api` for transparency |
| Windows | Compares global cursor position with input regions to switch click-through. Requires WebView2 |

Cursor-based switching on Windows/macOS has polling latency. Check fast boundary clicks and dragging on the target OS. See the [Tauri window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/) and [Tao Window](https://docs.rs/tao/latest/tao/window/struct.Window.html) for platform constraints.

## Linux X11 and Wayland

X11 stacking still follows window-manager policy. Behavior can differ across GNOME, KDE, tiling WMs, and XWayland combinations. Native Wayland restrictions on global placement, stacking, and cursor access require a separate implementation such as layer-shell or desktop extensions.

Outside-menu clicks use X11 RECORD button press/release events on a separate connection. The observer does not collect keyboard or pointer-motion events, consume input, or grab it. Menu generations and GTK server input times reject stale clicks.

When RECORD is unavailable or disconnected, pointer-state polling is used. This fallback and Windows/macOS polling can miss very short clicks. Position is queried just after receipt, so rapid click-then-move races are possible; events sharing a millisecond timestamp can be conservatively ignored.

## Monitors, scaling, and lifting

Physical window coordinates and logical UI coordinates are converted using monitor scale. Work areas and monitor lists are refreshed to recover offscreen positions, including when window size is unchanged. Automatic alignment avoids competing with an active drag or lift.

Height dragging uses the global cursor, work area, and physical coordinates. Pet windows retain work-area height to reduce WebView resizing during dragging. The shadow stays on the ground and is excluded from the input region while the pet is airborne. Releasing makes it fall and land.

## OS notifications

The Tauri notification plugin's Rust API is called through a dedicated command. Only the representative pet window can request notifications after event-ID and expiry validation; general plugin permissions are not exposed to webviews. The OS notification preference is PC-local, and a native ID index limits duplicate requests.

Windows notifications must be checked using an installed app. Linux needs a desktop notification service. Permissions, Do Not Disturb, and service policy affect visible banners; a successful request is not proof of display. See the [Tauri notification plugin](https://v2.tauri.app/plugin/notification/).

## Before distribution

Check transparency, surrounding click-through, pet/menu input, typing in another app, outside-click dismissal, tray behavior, and OS notifications on each target OS and desktop environment. Exercise multiple monitors, negative coordinates, mixed scaling, and recovery after monitor removal. Linux X11 results do not establish macOS, Windows, or XWayland behavior. See [releases](releasing.md) for signing and notarization conditions.
