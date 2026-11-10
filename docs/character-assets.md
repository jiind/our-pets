# Built-in characters and attribution

The built-in pets are a cat, dog, Gopher, and Ferris. Runtime artwork is the bundled `cel-v4.png`: non-pixel 2D sprites with thin colored lines and restrained shading. Each transparent PNG has four columns, four rows, and sixteen poses.

| Character | Artwork | Generation prompt |
| --- | --- | --- |
| Cat | [cat/cel-v4.png](../desktop/src/assets/builtin/cat/cel-v4.png) | [Prompt](../desktop/src/assets/builtin/cat/cel-v4.prompt.txt) |
| Dog | [dog/cel-v4.png](../desktop/src/assets/builtin/dog/cel-v4.png) | [Prompt](../desktop/src/assets/builtin/dog/cel-v4.prompt.txt) |
| Gopher | [gopher/cel-v4.png](../desktop/src/assets/builtin/gopher/cel-v4.png) | [Prompt](../desktop/src/assets/builtin/gopher/cel-v4.prompt.txt) |
| Ferris | [ferris/cel-v4.png](../desktop/src/assets/builtin/ferris/cel-v4.png) | [Prompt](../desktop/src/assets/builtin/ferris/cel-v4.prompt.txt) |

The [cat style master](../desktop/src/assets/builtin/cat/cel-v4-master.png) and [master prompt](../desktop/src/assets/builtin/cat/cel-v4-master.prompt.txt) define the visual reference. Artwork was generated/edited with image_gen. Gopher and Ferris retain separate original-design attribution and license conditions.

## Rendering and authoring

`desktop/src/default-pet.ts` and `desktop/src/builtin-pets.ts` select actions. Walking follows actual travel distance and uses common opaque bounds and foot, head, and hand anchors. Frames are not independently resized. Only selected artwork is decoded; alpha cleanup happens in rendering memory.

New built-in characters should preserve the grid, foot baseline, action order, and visual style. Keep the PNG, exact prompt, reference inputs, attribution, license, and SHA-256 together. User uploads follow the [pet-design specification](pet-design.md).

## Original designs and reference assets

| Material | Source and terms |
| --- | --- |
| Runtime cat and dog artwork | Characters generated for this project |
| Original Go Gopher design | [Renée French](https://go.dev/wiki/Gopher), CC BY 4.0. Adapted into non-pixel 2D artwork; credit, license, and modification notice are retained |
| Original Ferris design | [Karen Rustad Tölva](https://rustacean.net/), CC0 1.0 |
| Retained dog reference sprites | [Jason of GDN, Dog Spritesheets](https://opengameart.org/content/dog-spritesheets), CC0 |
| Retained Gopher reference sprites | [Egon Elbre, gophers](https://github.com/egonelbre/gophers), CC0, with original-design attribution retained |
| Retained Ferris reference sprites | Marc Duiker, [vscode-pets](https://github.com/tonybaloney/vscode-pets), MIT. The original design is CC0; project copyright notices are retained |

Keep the [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), and [MIT text](../desktop/src/assets/licenses/vscode-pets-MIT.txt). Reference sprites are separate from runtime artwork.

Distribution notices are maintained in [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md), and file attribution/hashes in [provenance.json](../desktop/src/assets/builtin/provenance.json). `scripts/prepare_notices.py` collects the required source texts and attribution for packaging. Public fan sprites or an open-source code license alone do not establish redistribution permission for the original character.
