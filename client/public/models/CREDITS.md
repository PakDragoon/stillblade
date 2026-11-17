# Model credits

## Shipped

| File | Made from | Licence |
|---|---|---|
| `character.glb` (353 KB) | "SWAT" by Quaternius, processed by `tools/blender/characters.py` | CC0 1.0 (public domain) |
| `viewmodel_rifle.glb` (336 KB), `viewmodel_pistol.glb` (325 KB), `viewmodel_knife.glb` (447 KB) | The arms, gloves and finger rig of "SWAT" by Quaternius (the same `SWAT.glb` as `character.glb`) with the shipped `weapons.glb` meshes, processed by `tools/blender/viewmodel.py` | CC0 1.0 (public domain) |
| `weapons.glb` (100 KB) | The "SMG", "Pistol" and "Knife_1" props of "Character Soldier" by Quaternius, processed by `tools/blender/weapons.py` | CC0 1.0 (public domain) |

What `characters.py` changed: folded the finger bones into the wrists and removed the IK pole
bones (62 bones down to 22); joined the 4 meshes and baked the 4 flat material colours into
vertex colours with a team palette (orange suit), leaving 1 material; decimated from 5,513 to
3,798 triangles; kept 6 of the 24 source clips and renamed them (idle, walk, run, death, slash,
hit); generated 2 new clips (crouch_idle, crouch_walk) from Idle and Walk; generated 2 armed
upper-body clips (aim: a two-handed gun hold solved with arm IK; shoot: a short recoil), because
the source's gun clips (Idle_Gun, Idle_Gun_Pointing, Gun_Shoot, Run_Shoot) are one-handed pistol
poses; added two empty nodes on the right wrist bone (`socket_gun`, `socket_knife`) that the
weapons hang from; turned the model to face glTF -Z and scaled it to 1.8 m.

What `weapons.py` changed: took the three props out of the character file, re-oriented them (-Z
forward, +Y up, origin at the grip), scaled them to real size (gun 0.66 m with its integral
suppressor, pistol 0.20 m, knife 0.30 m), gave the pistol a generated 12-sided suppressor (0.11 m),
baked a dark tactical palette into vertex colours (1 shared material, no textures), decimated the
knife from 687 to 398 triangles (gun kept at 1,006, pistol 1,034 with the suppressor), and added
`gun_muzzle` / `pistol_muzzle` nodes at the front of each suppressor.
Package M part 1 added two rifle sights generated in `weapons.py` from boxes and tubes (no third-party
source): `gun_sight_reddot` (a 1x red dot, 188 triangles) and `gun_sight_scope2x` (a 2x scope on two rings, 736
triangles). They are stand-ins until part 2 replaces the rifle with a realistic model.

What `viewmodel.py` does (package F, first-person hands): cuts both arms (upper arm to fingertips, 2,426
triangles, decimated to 1,500) out of the SWAT body with their skin weights, thins the sleeves toward the bone
axis (the cartoon forearms filled the screen), recolours them (orange sleeves and coyote gloves for defenders, a dark
suit for ghosts), rebuilds the arm and finger bones at the 1.8 m scale, and joins them with one weapon from
`weapons.glb` into one skinned mesh per weapon. The guns are split into moving parts by their loose pieces (rifle
magazine; pistol slide and base plate); a magazine body for the pistol and a cocking knob for the rifle are generated
boxes. Hands are posed with two-bone IK and per-finger curls; clips are generated, not taken from the source.
Characters (`characters.py`, package F): the "Sword_Slash" clip is no longer shipped; six upper-body clips (pistol,
pistol_shoot, reload_rifle, reload_pistol, knife_hold, knife_swing) are generated, and the "Death" clip is recentred.

## Downloaded source files

Both files were downloaded with a generic HTTP client, with no account. They are stored, git-ignored, under
`tools/blender/source-art/characters/`. The licence is the one shown on each model's poly.pizza page.
No further files were downloaded for the weapons (including the pistol): they come from the second
file below, which was already on disk. Nothing was downloaded for the first-person hands either (package F): they
come from the first file below.

| File | URL | Size | Licence | Author | Used |
|---|---|---|---|---|---|
| `quaternius-swat/SWAT.glb` | https://static.poly.pizza/713f6535-f4f3-4367-a4c6-ced126ae0936.glb (page: https://poly.pizza/m/Btfn3G5Xv4) | 1,560,900 bytes | CC0 1.0 | Quaternius | Yes: source of `character.glb` |
| `quaternius-soldier/CharacterSoldier.glb` | https://static.poly.pizza/1083c1d3-d1d4-4682-adf6-bc516d06ac84.glb (page: https://poly.pizza/m/PpLF4rt4ah) | 1,333,700 bytes | CC0 1.0 | Quaternius | Yes: its "SMG", "Pistol" and "Knife_1" meshes are the source of `weapons.glb` (the character itself is not used) |

Quaternius: https://quaternius.com. CC0 asks for no attribution; it is given here anyway.
