# Third-party notices

The project's Apache-2.0 license applies to its own code. Fonts, artwork, and dependencies retain their individual terms. This document and the original notice texts are included in distribution packages; it is not a completed legal compatibility review of every Go, Rust, and npm transitive dependency.

## Font

Pretendard Variable is bundled without modification. The UI uses the local font without runtime font-server/CDN requests.

- Source: https://github.com/orioncactus/pretendard
- File: `desktop/public/fonts/PretendardVariable.woff2`
- SHA-256: `9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4`
- License: SIL Open Font License 1.1; original copyright and terms: `desktop/public/fonts/OFL.txt`.
- Preserve the notice when distributing the app. The font must not be sold by itself.

Native title bars, tray rendering, and emoji appearance are supplied by the OS. Dependency versions are recorded in the relevant lock/sum files.

## GSAP

- GSAP 3.15.1: https://gsap.com
- Runtime package terms: Standard “No Charge” License, https://gsap.com/standard-license
- The MIT license for GSAP Skills documentation is separate from the runtime license.
- Only the used core is bundled; the app does not load GSAP from a CDN.
- Original copyright/terms references are also retained in `desktop/public/licenses/GSAP-NOTICE.txt`.

## Character artwork and references

Runtime characters use `desktop/src/assets/builtin/<id>/cel-v4.png` for cat, dog, Gopher, and Ferris. These non-pixel 2D sheets were generated/edited with image_gen using thin colored lines and restrained cel shading. `cat/cel-v4-master.png` is the shared style reference. Original PNGs, prompts, reference inputs, and hashes are retained with the assets and in `provenance.json`.

The cat and dog are project-generated characters. The Gopher adapts Renée French's original Go Gopher with new rendering and poses; original attribution, CC BY 4.0 terms, and modification notices are retained. Ferris adapts Karen Rustad Tölva's original design and retains its source and reference-sprite notices.

| Material | Creator and terms | Source |
| --- | --- | --- |
| Original Go Gopher | Renée French, CC BY 4.0 | https://go.dev/wiki/Gopher and https://creativecommons.org/licenses/by/4.0/ |
| Original Ferris | Karen Rustad Tölva, CC0 1.0 | https://rustacean.net/ |
| Retained dog sprites | Jason of GDN, CC0 1.0 | https://opengameart.org/content/dog-spritesheets |
| Retained Gopher sprites | Egon Elbre, CC0 1.0 | https://github.com/egonelbre/gophers |
| Retained Ferris animations | Marc Duiker, vscode-pets, MIT; Copyright © 2022 Anthony Shaw | https://github.com/tonybaloney/vscode-pets |

Reference pixel sprites and generated intermediate artwork remain in the source tree but are distinct from runtime `cel-v4.png` files. Retained GIF frames were packed into a PNG atlas without changing their pixels. Runtime low-alpha cleanup occurs in rendering memory. The original cat reference is `desktop/src/assets/ginger-companion-v2.png`, with its generation prompt beside it. No eSheep, Shimeji, VPet, or Godot-pet images/models are included.

File paths, source commits, and SHA-256 values are recorded in `desktop/src/assets/builtin/provenance.json`. Original CC0/MIT texts are in `desktop/public/licenses/`. The app also displays character credits, modification notices, license URIs, and the MIT text. Downloaded projects' code, sounds, trademarks, and background images are not included. See [character attribution](docs/character-assets.md).

## OS notifications

- `tauri-plugin-notification` 2.4.0: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/notification — Apache-2.0 OR MIT.
- `notify-rust` 4.18.2: https://github.com/hoodie/notify-rust — MIT OR Apache-2.0.
- Actual versions and transitive dependencies follow `desktop/src-tauri/Cargo.lock`. Runtime uses native OS notification APIs.

## Linux X11 input observation

- `x11rb` and `x11rb-protocol` 0.13.2: https://github.com/psychon/x11rb — MIT OR Apache-2.0; MIT notice included.
- `gethostname` 1.1.0: https://codeberg.org/swsnr/gethostname.rs — Apache-2.0; original text included.
- `gdkx11` 0.18.2: https://github.com/gtk-rs/gtk3-rs — MIT; used for GTK 3 X11 user-input timestamps, with its notice included.

Button events are processed in memory for menu dismissal and drag release. Keyboard and pointer-motion events are not collected or stored. Without X11 RECORD, pointer-state polling is used and can miss very short clicks.

## Distribution

Tauri resource mappings include `LICENSE`, these notices, Pretendard OFL, and asset/library notices in installers. Releases also include notice ZIPs prepared by `scripts/prepare_notices.py`. Keep the original license texts and attribution when redistributing.
