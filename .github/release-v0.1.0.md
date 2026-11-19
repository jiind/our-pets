## Get started

Our Pets brings a companion to your desktop. Choose **Get started** to open your own pet. To play with friends on the same network, open **Settings → Server information**, allow external access, and copy the invite link. Friends can join with the link and a nickname. The app remembers their device for future visits.

## Highlights

- One app bundles the server and the desktop pet. It displays the available LAN address while sharing is enabled.
- Room members can choose designs from a shared PNG catalog. The start screen remembers the last selected pet, including downloaded PNG designs.
- Choose Korean or English from the flag menu. The choice is saved in the app.
- WebKit now stores and restores PNG previews reliably and keeps menu and dialog focus working.

## Downloads

| Platform | Desktop installer |
| --- | --- |
| Windows x64 | `.exe` |
| macOS, Apple Silicon and Intel | `.dmg` |
| Linux x64 | `.deb` or `.AppImage` |

Standalone server ZIPs are available for Linux amd64 and arm64, Windows amd64, and macOS amd64 and arm64. Check each download against `SHA256SUMS.txt`. Automated release builds passed on all three platforms. Manual desktop installation and runtime checks were skipped. See the [user guide](https://github.com/jiind/our-pets/blob/v0.1.0/docs/usage.md) and [platform requirements](https://github.com/jiind/our-pets/blob/v0.1.0/docs/platforms.md).

## Deployment notes

- For an existing standalone server, back up its data and update the server before using the new desktop app's invite and device sign-in flow. The desktop app includes the updated server for app-hosted rooms. See the [deployment guide](https://github.com/jiind/our-pets/blob/v0.1.0/docs/operations.md).
- Windows and macOS installers may show security warnings because publisher signing and macOS notarization are unconfigured. Linux desktop use requires X11 or XWayland.
- For Linux AppImage redistribution, keep the native-source ZIP and platform notices with the installer. The release includes platform notice ZIPs and source archives.
