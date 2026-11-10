# Pet designs and animation

## Registration and display

Choose a cat, dog, Gopher, Ferris, or your own design on the pet page. Initial registration requires selecting a character and completing registration. Subsequent character selections are saved immediately. Each user has one representative pet; appearance changes preserve its ID. Nameplates, messages, and gatherings use the account nickname.

The add-pet dialog takes a name and one PNG file. Added designs appear in the selection list. For a registered pet, the chosen design can be applied immediately; before initial registration, add it to the list and then complete registration. Visibility, peer visibility, and size are PC-local settings shared with the tray. Size ranges from 80 to 240px.

The character-prompt section offers text for a single-image PNG or a sprite sheet. Copy the read-only text and customize the character description in your image tool. The app does not send prompts to an external generation service. Built-in character attribution is available in the pet page's character credits section and [asset documentation](character-assets.md).

## PNG format

- Supply one PNG image or a grid-based sprite-sheet PNG. ZIP uploads and APNG are unsupported.
- Maximum file size: 8 MiB. Decoded width and height: at most 2048px each.
- The server validates the PNG signature and decodes pixels; a filename or extension alone is insufficient.
- A regular PNG is one frame. Walking artwork is not generated automatically.
- Frame width and height must divide the PNG dimensions exactly. At most 256 frames are allowed.
- `idle`, `walk`, and `react` animations are optional and run at 1–24 FPS. Frame indices start at zero, proceeding left to right, then onto the next row.
- A missing action falls back to `idle`, or the first frame if `idle` is absent.

For example, a 256×128px PNG with 64×64px frames has four columns, two rows, and eight frames (0–7). The dialog explains the grid and previews idle, walk, and reaction actions, reflecting display size and reduced-motion settings.

Example stored manifest:

```json
{
  "schemaVersion": 1,
  "displaySize": 160,
  "frameWidth": 128,
  "frameHeight": 128,
  "animations": {
    "idle": { "frames": [0, 1], "fps": 4 },
    "walk": { "frames": [2, 3, 4, 5], "fps": 8 },
    "react": { "frames": [6, 7], "fps": 8 }
  }
}
```

Uploading creates a design draft; registration chooses the design for the representative pet. If the upload succeeds but refreshing the list fails, retrying the dialog does not upload the same file again. The server stores PNGs by content hash and manages design IDs and versions. Authenticated users can retrieve registered designs but cannot overwrite another user's originals. Downloaded PNGs are cached in IndexedDB so already-cached artwork remains available during a temporary outage. Initial signup and uncached downloads still require the server.

Uploaded pets have edit and delete icons beside their radio choices. Editing opens the registration form with the saved name, cell dimensions, frame order, and playback speeds. The original PNG is fixed and cannot be replaced. Saving creates a new immutable design version and removes the previous version from the owner's choices. Deleting the owner's current appearance restores the built-in cat without deleting their Pet or changing its ID. Built-in choices have no edit/delete controls. Existing message references and appearances used by other users remain intact; deletion removes the catalogue entry rather than erasing shared PNG bytes.

## Animation and rendering

A single PNG remains one drawing; the app can supply movement, sway, and jumps. Sprite-sheet `walk` frames follow movement distance. Previews and pet windows use the same renderer. A shared opaque bounding region across registered frames compensates for transparent margins without resizing each drawing independently. This does not guarantee that the supplied artwork has correct contact points or animation quality.

Uploaded artwork is assumed to face right. The renderer mirrors it for leftward movement and to face the other pet during paired reactions. A regular PNG follows the same direction rule.

Enter the size of one cell and the frame order for each action. The generated-prompt example uses a 1024×1024px, four-by-four sheet: sixteen 256px cells, with idle 0–3, walk 4–11, and reaction 12–15. If the actual output dimensions differ, use cell dimensions that divide the real PNG exactly.

Opening the animation settings for the first time fills the example's 4×4 layout automatically: idle frames 0–3 at 4 FPS, walk frames 4–11 at 8 FPS, and reaction frames 12–15 at 6 FPS. Cell dimensions follow the selected PNG dimensions divided by four until edited manually. Reopening the section preserves edits. For a regular single-image PNG, leave this section unopened; its animation settings remain empty.
