# Model credits

## Shipped

| File | Made from | Licence |
|---|---|---|
| `character_high.glb` (938 KB), `character_low.glb` (657 KB; a player downloads one) | The soldier (defenders) and the stealth suit (ghosts) made from "Quantum Modular Character Free Sample" by Quantum Assets (below), with animation clips retargeted from "SWAT" by Quaternius (CC0) and generated ones, processed by `tools/blender/soldier.py` and `clips.py` | Fab Standard License (the character); CC0 (the SWAT clips) |
| `textures/character_{albedo,normal}_{1024,2048}.webp` | The Quantum character's texture maps, cropped and resampled into one atlas, the shirt dyed orange | Fab Standard License |
| `weapons.glb` (302 KB) | Third-person weapons: "AK-105" by SpatialNeglect, "Makarov Pistol (PM)" by TaigaForest, "Tactical Knife" and "Red Dot Sight" by Gerardo Justel, "AR Scope (Game-Ready)" by Scape (all five below) and generated suppressors, processed by `tools/blender/weapons.py` | CC-BY (the five models; see below) |
| `textures/{rifle,pistol,knife}_{albedo,normal}_{1024,2048}.webp` | The same five models' texture maps, resampled into one atlas per gun by `tools/blender/realistic.py`, plus the first-person arms' skin and sleeve (and on the knife the ghost's suit) from the Quantum character | CC-BY (weapons); Fab Standard License (arms) |
| `viewmodel_rifle.glb` (1.29 MB), `viewmodel_pistol.glb` (575 KB), `viewmodel_knife.glb` (498 KB) | The first-person arms (from the Quantum character: forearms, hands and rolled sleeves; the ghost's suit arms) holding the full-detail weapons above, processed by `tools/blender/viewmodel.py`. Since package R the rifle's reload, empty reload, draw, fire and holster clips are motion retargeted from "M4 - FPS Weapon Animations Pack FREE (v.1)" (below) | Fab Standard License (arms, rifle motion) and CC-BY (weapons) |

### The rifle's first-person motion (Fab Standard License, package R)

**"M4 - FPS Weapon Animations Pack FREE (v.1)"** on Fab (downloaded by the owner, 2026-11-18, as
`m4_animations_gltf.zip`; free under the Fab Standard License, Personal and Professional use; the seller's name is not
inside the download: **the owner should add it here from the Fab listing**). Only its **motion** is used: the rifle's,
the magazine's and the hands' movement in its Reload, Reload_Empty, Fire, Holster and Draw clips is measured relative
to its rifle by `tools/blender/fpanims.py` and put onto our AK-105 and our arms by `tools/blender/viewmodel.py`
(time-scaled to the game's rules; the M4's bolt-catch slap replaced by an AK charging-handle pull; the magazine path
rocked like an AK's). **None of its meshes or textures ship**: not the M4, the magazines, the bullets or its gloved
hands. The downloaded zip stays in the git-ignored `tools/blender/source-art/realistic/fp-anims/` and must not be
committed or redistributed.

### The soldier (Fab Standard License)

**"Quantum Modular Character Free Sample"** by **Quantum Assets**: https://www.fab.com/listings/8e200050-3158-4762-b297-f785b5b1533d
(downloaded by the owner from Fab, 2026-11-17; free under the Fab Standard License, which allows using it in a game
but **not redistributing the source files**: only the processed models and textures built from them ship with the
game, and the downloaded FBX and PNG files stay in the git-ignored `tools/blender/source-art/realistic/soldier/`).
Changes made (by script): the defender keeps the cap, head, eyes, rolled-up shirt (dyed the defenders' orange), plate
carrier with pouches, holster, jeans with boots, forearms and hands (left out: the holstered pistol, the back and cap
patches, teeth and eyelashes); the ghost is the bare body reshaped into a close-fitting suit with a balaclava and boots
(face and feet smoothed). Reduced from 162,882 triangles and 15 meshes to one mesh of about 13,000 (High) or 6,600
(Low) triangles per look, the 275-bone skeleton to 51 bones, the 4K maps cropped and resampled into one 2048 / 1024
atlas; first-person arms cut from the same meshes.

### Attribution (CC-BY)

The game's weapons are made from these models, downloaded by the owner from Fab (fab.com) on 2026-11-17, each listed
there under a Creative Commons Attribution licence (the licence version was not checked by the build session; see each
listing):

- **"AK-105"** by **SpatialNeglect**: https://www.fab.com/listings/9b9836c5-b73c-4216-a389-a61549eb3a74 (the rifle)
- **"Makarov Pistol (PM)"** by **TaigaForest**: https://www.fab.com/listings/6af98baa-bc87-4a38-ae33-db73ca1c855c (the pistol)
- **"Tactical Knife"** by **Gerardo Justel**: https://www.fab.com/listings/33452f11-fc65-479e-8d6e-75bf8be1c0ff (the knife, ghosts' and defenders')
- **"Red Dot Sight"** by **Gerardo Justel**: https://www.fab.com/listings/3a8c2a97-481e-403b-a61b-aef09a96debe (the 1x red dot)
- **"AR Scope (Game-Ready)"** by **Scape**: https://www.fab.com/listings/346c6bbd-a204-4317-9e10-b25c653821a8 (the 2x sight;
  package O: oriented and placed on the AK's rail by script, its lens tube left out so the aimed view looks through
  it, reduced to 3,000 triangles in first person and 380 in third person, its five materials' maps cropped into the
  rifle atlas)

Changes made (all by script, `tools/blender/weapons.py`, `realistic.py`, `viewmodel.py`): re-oriented, scaled to real
size and centred on the grip; reduced in triangles (first person: the AK-105 from 17,568 to 11,998 with its raised
cheek rest left out of first person; the knife from 22,578 to 4,398; the red dot from 23,281 to 2,172 without its
screws and glass; the Makarov kept at 11,578 without its loose cartridges and two internal spring meshes; third person
reduced further), split into moving parts (AK magazine and bolt carrier; Makarov slide, magazine), joined with generated
parts; each gun's texture maps resampled into one atlas (base colour with ambient occlusion and a lifted metal colour;
roughness and metalness folded into one surface value; normal map) and saved as WebP; a glowing reticle added on the red
dot's glass.

Not from a download: both suppressors, the reticle dot, the studio reflection the client generates, and the
fallback 2x scope `weapons.py` generates when the AR Scope file is absent.

### Earlier (packages A, F, M part 1; the SWAT character and arms were replaced in package O)

What `characters.py` changed: folded the finger bones into the wrists and removed the IK pole
bones (62 bones down to 22); joined the 4 meshes and baked the 4 flat material colours into
vertex colours with a team palette (orange suit), leaving 1 material; decimated from 5,513 to
3,798 triangles; kept 6 of the 24 source clips and renamed them (idle, walk, run, death, slash,
hit); generated 2 new clips (crouch_idle, crouch_walk) from Idle and Walk; generated 2 armed
upper-body clips (aim: a two-handed gun hold solved with arm IK; shoot: a short recoil), because
the source's gun clips (Idle_Gun, Idle_Gun_Pointing, Gun_Shoot, Run_Shoot) are one-handed pistol
poses; added two empty nodes on the right wrist bone (`socket_gun`, `socket_knife`) that the
weapons hang from; turned the model to face glTF -Z and scaled it to 1.8 m.

What `viewmodel.py` does (package F, first-person hands): cuts both arms (upper arm to fingertips, 2,426
triangles, decimated to 1,500) out of the SWAT body with their skin weights, thins the sleeves toward the bone
axis, recolours them (orange sleeves and coyote gloves for defenders, a dark suit for ghosts), rebuilds the arm and
finger bones at the 1.8 m scale, and joins them with one weapon into one skinned mesh per weapon. Hands are posed with
two-bone IK and per-finger curls; clips are generated, not taken from the source.
Characters (`characters.py`, package F): the "Sword_Slash" clip is no longer shipped; six upper-body clips (pistol,
pistol_shoot, reload_rifle, reload_pistol, knife_hold, knife_swing) are generated, and the "Death" clip is recentred.

Until package M part 2 the weapons were the "SMG", "Pistol" and "Knife_1" props of "Character Soldier" by Quaternius
(CC0); they are no longer shipped.

## Downloaded source files

Stored, git-ignored, under `tools/blender/source-art/`. The realistic weapons (owner's downloads from Fab, 2026-11-17,
in `realistic/`):

| File | Size | Author | Used |
|---|---|---|---|
| `realistic/rifle/ak105fbx.zip` (FBX + 4K maps for two materials) | 60,139,447 bytes | SpatialNeglect | The rifle |
| `realistic/pistol/source.zip` (`SM_PM_Ammo_9x18.fbx` + 4K maps) | 82,911,353 bytes | TaigaForest | The pistol |
| `realistic/knife/tactical_knife_gltf.zip` (glTF + 4K maps) | 26,344,712 bytes | Gerardo Justel | The knife |
| `realistic/reddot/red_dot_sight.glb` (4K maps embedded) | 76,141,388 bytes | Gerardo Justel | The red dot |
| `realistic/scope2x/ar_scope_game_ready_gltf.zip` (glTF, 5 materials, 4K maps) | 56,855,445 bytes | Scape | The 2x sight |
| `realistic/soldier/fbx_all_assets.zip` (FBX parts) | 34,856,279 bytes | Quantum Assets | The soldier, the ghost and the first-person arms |
| `realistic/soldier/pbr_textures.zip` (121 4K PNGs) | 1,210,534,656 bytes | Quantum Assets | Their textures (BaseColor, OcclusionRoughnessMetallic, Unity_Normal; the Arms normal map is DirectX-style and is flipped) |
| `realistic/fp-anims/m4_animations_gltf.zip` (one glTF scene: M4, hands, 5 clips on one 10 s timeline) | 7,987,134 bytes | see "The rifle's first-person motion" | The rifle's first-person motion only (package R) |

Earlier downloads (packages A and F), with a generic HTTP client and no account, licence as shown on poly.pizza:

| File | URL | Size | Licence | Author | Used |
|---|---|---|---|---|---|
| `characters/quaternius-swat/SWAT.glb` | https://static.poly.pizza/713f6535-f4f3-4367-a4c6-ced126ae0936.glb (page: https://poly.pizza/m/Btfn3G5Xv4) | 1,560,900 bytes | CC0 1.0 | Quaternius | Its animation clips only (idle, walk, run, death, hit), retargeted onto the soldier |
| `characters/quaternius-soldier/CharacterSoldier.glb` | https://static.poly.pizza/1083c1d3-d1d4-4682-adf6-bc516d06ac84.glb (page: https://poly.pizza/m/PpLF4rt4ah) | 1,333,700 bytes | CC0 1.0 | Quaternius | No longer (the old weapons) |

Quaternius: https://quaternius.com. CC0 asks for no attribution; it is given here anyway.
