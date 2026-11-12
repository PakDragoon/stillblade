# Model credits

## Shipped

| File | Made from | Licence |
|---|---|---|
| `character.glb` (353 KB) | "SWAT" by Quaternius, processed by `tools/blender/characters.py` | CC0 1.0 (public domain) |
| `weapons.glb` (60 KB) | The "SMG" and "Knife_1" props of "Character Soldier" by Quaternius, processed by `tools/blender/weapons.py` | CC0 1.0 (public domain) |

What `characters.py` changed: folded the finger bones into the wrists and removed the IK pole
bones (62 bones down to 22); joined the 4 meshes and baked the 4 flat material colours into
vertex colours with a team palette (orange suit), leaving 1 material; decimated from 5,513 to
3,798 triangles; kept 6 of the 24 source clips and renamed them (idle, walk, run, death, slash,
hit); generated 2 new clips (crouch_idle, crouch_walk) from Idle and Walk; generated 2 armed
upper-body clips (aim: a two-handed gun hold solved with arm IK; shoot: a short recoil), because
the source's gun clips (Idle_Gun, Idle_Gun_Pointing, Gun_Shoot, Run_Shoot) are one-handed pistol
poses; added two empty nodes on the right wrist bone (`socket_gun`, `socket_knife`) that the
weapons hang from; turned the model to face glTF -Z and scaled it to 1.8 m.

What `weapons.py` changed: took the two props out of the character file, re-oriented them (-Z
forward, +Y up, origin at the grip), scaled them to real size (gun 0.66 m with its integral
suppressor, knife 0.30 m), baked a dark tactical palette into vertex colours (1 shared material,
no textures), decimated the knife from 687 to 398 triangles (gun kept at 1,006), and added a
`gun_muzzle` node at the front of the suppressor.

## Downloaded source files

Both files were downloaded with a generic HTTP client, with no account. They are stored, git-ignored, under
`tools/blender/source-art/characters/`. The licence is the one shown on each model's poly.pizza page.
No further files were downloaded for the weapons: they come from the second file below, which was
already on disk.

| File | URL | Size | Licence | Author | Used |
|---|---|---|---|---|---|
| `quaternius-swat/SWAT.glb` | https://static.poly.pizza/713f6535-f4f3-4367-a4c6-ced126ae0936.glb (page: https://poly.pizza/m/Btfn3G5Xv4) | 1,560,900 bytes | CC0 1.0 | Quaternius | Yes: source of `character.glb` |
| `quaternius-soldier/CharacterSoldier.glb` | https://static.poly.pizza/1083c1d3-d1d4-4682-adf6-bc516d06ac84.glb (page: https://poly.pizza/m/PpLF4rt4ah) | 1,333,700 bytes | CC0 1.0 | Quaternius | Yes: its "SMG" and "Knife_1" meshes are the source of `weapons.glb` (the character itself is not used) |

Quaternius: https://quaternius.com. CC0 asks for no attribution; it is given here anyway.
