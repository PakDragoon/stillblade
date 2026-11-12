# Character model credits

## Shipped

| File | Made from | Licence |
|---|---|---|
| `character.glb` (331 KB) | "SWAT" by Quaternius, processed by `tools/blender/characters.py` | CC0 1.0 (public domain) |

What `characters.py` changed: folded the finger bones into the wrists and removed the IK pole
bones (62 bones down to 22); joined the 4 meshes and baked the 4 flat material colours into
vertex colours with a team palette (orange suit), leaving 1 material; decimated from 5,513 to
3,798 triangles; kept 6 of the 24 source clips and renamed them (idle, walk, run, death, slash,
hit); generated 2 new clips (crouch_idle, crouch_walk) from Idle and Walk; turned the model to
face glTF -Z and scaled it to 1.8 m.

## Downloaded source files

Both files were downloaded with a generic HTTP client, with no account. They are stored, git-ignored, under
`tools/blender/source-art/characters/`. The licence is the one shown on each model's poly.pizza page.

| File | URL | Size | Licence | Author | Used |
|---|---|---|---|---|---|
| `quaternius-swat/SWAT.glb` | https://static.poly.pizza/713f6535-f4f3-4367-a4c6-ced126ae0936.glb (page: https://poly.pizza/m/Btfn3G5Xv4) | 1,560,900 bytes | CC0 1.0 | Quaternius | Yes: source of `character.glb` |
| `quaternius-soldier/CharacterSoldier.glb` | https://static.poly.pizza/1083c1d3-d1d4-4682-adf6-bc516d06ac84.glb (page: https://poly.pizza/m/PpLF4rt4ah) | 1,333,700 bytes | CC0 1.0 | Quaternius | No: evaluated, not used (7.9k triangles, many weapon meshes) |

Quaternius: https://quaternius.com. CC0 asks for no attribution; it is given here anyway.
