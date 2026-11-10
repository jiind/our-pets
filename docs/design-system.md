# UI and motion guidelines

Settings, authentication, connection dialogs, pet menus, bubbles, and gatherings use consistent styling for equivalent roles. `desktop/src/ui.css` owns color, typography, size, spacing, and states. `style.css` and `workspace.css` own layout, scrolling, and responsiveness. Avoid duplicating equivalent control styles across screens.

## Shared elements

| Role | Rule |
| --- | --- |
| Font | Free/open-source Pretendard, bundled locally |
| Buttons and inputs | 14px, minimum 44px height, 8×12px padding, 8px radius; button weight 600 |
| Primary action | Shared green `primary` background with white content for send/join/complete/add |
| Selected state | Shared accent background, border, text, and pressed state |
| Icon buttons | Normally 32px with a 16px SVG; title, accessible name, and focus indicator |
| Close | Center SVG X in a circular button; PNG upload uses top-row cancel/add actions |
| Body and labels | 14px; label weight 600 |
| Secondary text | 12px secondary color; error color only for actual errors |
| Headings | Page 26px, section 18px, subsection 16px; pet panels 14px/600 |
| Spacing | 4px multiples, normally 8/12/16/24/32px; 20px between form fields |

Buttons retain a visible surface/border that distinguishes them from text. Transparent image buttons still need hover and keyboard focus. Distinguish loading, failure, and disabled states; preserve input and retries after failure. Server indicators use green `#22c55e`, yellow `#eab308`, red `#ef4444`, and gray while waiting. The address does not repeat visible status text, but accessible names/tooltips convey meaning.

## Settings and responsive layout

The app frame follows window height. The sidebar stays independent of content length; the main area scrolls. Sidebar width is mouse-resizable and collapsible, with names retained for collapsed icons. There is no separate right inspector. Navigation resets content scroll without letting heading focus move the outer frame.

Pet/notification navigation names match page headings. Server address/status are above pet navigation; copyright is below logout. Collapsed navigation hides secondary text. Use a paw SVG for pets and a bell for notifications.

The pet page opens directly to visibility/peer controls, preview, and character selection. Inside the preview, size/action labels align left and their controls align right. At content widths of 600px or more, preview and editor use two columns; narrower content stacks. Character selection has refresh and primary add icons on the right. Registered-pet selection applies immediately, without redundant success messages or save/cancel controls.

Notification-source and OS-alert toggles align with the page title. Refresh/add icons align with the external-source heading. Creation/editing share one dialog, with heading association, Escape/backdrop dismissal, and consistent field spacing.

## PNG dialog

Cancel/add actions sit at the top right of the dialog heading. Inputs are ordered name, PNG, animation. Explain regular PNG versus sprite sheet and that both use one file. The file picker uses a 32px button, 16px gap before the filename, and left-aligned limit text 8px below at 85% opacity.

Character prompts sit below PNG help and above the animation divider. The animation summary matches the PNG label's size, weight, and color. Group width/height beneath the cell-size heading. Keep heading/help spacing at 4px; a preview button must not stretch that gap.

## Pet UI

Left-click pets, dragging moves/lifts, and right-click opens the menu. Menus and message inputs execute directly above the pet rather than opening settings. Message composition is at the menu bottom. Greetings/high-fives appear only on peer menus. Gatherings use a flag entry and emoji choices with accessible names.

Nicknames are normally hidden and appear below the feet on hover/menu display. Nameplates are excluded from input regions and truncate long text. Bubbles follow character anchors and screen edges. Appearance/size changes preserve relative UI spacing and grounding.

## Motion and accessibility

`desktop/src/motion.ts` uses GSAP for per-window effects, card entrance, media preferences, and cleanup. Rust moves actual windows. Message targets, delivery results, and gathering state are independent of animation.

- Menus/bubbles accept pointer and keyboard input from their first visible moment; do not wait for animation completion.
- New actions replace previous timelines. Dragging, hiding, and unmounting clean up effects/listeners without globally stopping other windows.
- Respect `prefers-reduced-motion` while preserving content, state, and controls.
- Prefer short transform/opacity effects, reduce hidden rendering, and tie walking to actual distance.
- Reflect Canvas transforms and alpha bounds in input regions; do not make surrounding rectangles intercept clicks.
- Keep bubbles open while hovered or keyboard-focused for reading/replying. Text remains immediately readable and copyable.
- Avoid scroll hijacking, parallax, and forced scroll pinning. Preserve keyboard focus, Escape return, and accessible form names.

The GSAP runtime and skills documentation have separate licenses. See [third-party notices](../THIRD_PARTY_NOTICES.md).
