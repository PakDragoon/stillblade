# Model credits

## Shipped

| File | Made from | Licence |
|---|---|---|
| `character_high.glb` (938 KB), `character_low.glb` (657 KB; a player downloads one) | The soldier (defenders) and the stealth suit (ghosts) made from "Quantum Modular Character Free Sample" by Quantum Assets (below), with animation clips retargeted from "SWAT" by Quaternius (CC0) and generated ones, processed by `tools/blender/soldier.py` and `clips.py` | Fab Standard License (the character); CC0 (the SWAT clips) |
| `textures/character_{albedo,normal}_{1024,2048}.webp` | The Quantum character's texture maps, cropped and resampled into one atlas, the shirt dyed orange | Fab Standard License |
| `weapons.glb` (322 KB) | Third-person weapons: the M4 from "M4 - FPS Weapon Animations Pack FREE (v.1)" (the rifle, package T; below), "Makarov Pistol (PM)" by TaigaForest, the karambit from "Knife FPS Animations" (the knife, package V; below), "Red Dot Sight" by Gerardo Justel, "AR Scope (Game-Ready)" by Scape (below) and generated suppressors, processed by `tools/blender/weapons.py`, `m4.py` and `knifekit.py` | Fab Standard License (the M4, the karambit); CC-BY (the other three models; see below) |
| `textures/{rifle,pistol,knife}_{albedo,normal}_{1024,2048}.webp` | One atlas per gun by `tools/blender/realistic.py`: the rifle's holds the M4 pack's M4, round, glove (recoloured coyote) and arm skin maps with the red dot's and the AR Scope's maps (package T); the pistol's holds its model's maps, the pack's glove and fingertip skin, and the sleeve fabric from the Quantum character; the knife's (package V) holds the knife pack's karambit maps and its hands' maps in grey (the rig's vertex colours give the defender's coyote gloves and orange sleeves and the ghost's dark ones) | Fab Standard License (M4, arms, gloves, karambit, knife hands); CC-BY (the other weapons) |
| `viewmodel_rifle.glb` (1.37 MB) | Package T: the M4 pack's own first-person arms (bare forearms, gloves), skeleton, M4 and clips (Reload, Reload_Empty, Fire, Draw), used as authored and only resampled to the game's reload, draw and fire times, by `tools/blender/fpm4.py`; with our red dot, 2x sight and suppressor on the M4 | Fab Standard License (arms, M4, motion) and CC-BY (sights) |
| `viewmodel_knife.glb` (668 KB) | Package V: the knife pack's own first-person hands (gloves and sleeves), skeleton, karambit and clips (idle, quick draw, the four swings), used as authored and only resampled to the game's draw and swing times, by `tools/blender/fpknife.py` (reading the pack with `knifepack.py` and `knifekit.py`); recoloured per team | Fab Standard License |
| `viewmodel_pistol.glb` (662 KB) | The first-person arms holding the full-detail pistol, processed by `tools/blender/viewmodel.py` and `packhands.py`: the gloved hands are the mesh of "M4 - FPS Weapon Animations Pack FREE (v.1)" (below), reshaped onto our skeleton; defenders' sleeves are the Quantum shirt's own upper-arm sleeve moved onto the forearm (`packhands.sleeve_from_shirt`); the ghost's forearms are the Quantum body as a suit | Fab Standard License (arms, gloves) and CC-BY (weapons) |

### The rifle and the first-person hands (Fab Standard License, packages R and T)

**"M4 - FPS Weapon Animations Pack FREE (v.1)"** on Fab by **BarcodeGames** (https://www.fab.com/sellers/BarcodeGames) (downloaded by the owner,
2026-11-18, as `m4_animations_gltf.zip`; free under the Fab Standard License, Personal and Professional use, which
allows using it inside a game but not redistributing the source files). Used since package T (2026-11-20): **its M4**
(the rifle in both views: the full model with its moving magazine, top round, bolt, bolt catch and trigger in first
person; reduced to 3,200 triangles in third person; its folding rear sight split off so it folds away under an optic),
**its arms** (the `Hand_Mesh` glove and skin on its own skeleton and bind pose, the glove recoloured coyote) and **its
clips** Reload, Reload_Empty, Fire and Draw as authored, resampled to the game's 2.2 s and 2.7 s reloads, 0.4 s draw
and 0.1 s shot (`tools/blender/fpm4.py`, reading the pack with `fpanims.py` and `m4.py`). For the pistol
(package R): the `Hand_Mesh` (glove and fingertip skin)
reshaped onto our skeleton by `tools/blender/packhands.py` (scaled to 0.71, the bare forearm cut away, the glove
recoloured coyote for defenders and tinted near-black for ghosts), and its `Glove_D` and `Hand_D` colour, ORM and
normal maps resampled into our gun atlases. These processed models and textures **ship inside our game files**
(`weapons.glb`, `viewmodel_*.glb`, `textures/{rifle,pistol,knife}_*.webp`) as part of the game, which the licence
allows. Not used: its second magazine and the Holster clip. The downloaded zip stays in the git-ignored
`tools/blender/source-art/realistic/fp-anims/` and must not be committed or redistributed.

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

### The knife and its first-person hands (Fab Standard License, package V)

**"Knife FPS Animations"** on Fab by **[SELLER NAME]** (the owner fills in the seller's name; it is not in the
download) (downloaded by the owner as `knife_fps_animations.unitypackage`, a Unity package; free under the Fab Standard
License, which allows using it inside a game but not redistributing the source files). Used since package V
(2026-11-20): **its karambit "ViperFANG"** (the knife of defenders and ghosts in both views: the full 4,300-triangle
model in first person, reduced to 800 triangles in third person, placed in the hand as the pack's own hand holds it),
**its first-person hands** (`Hands_rig`: gloves and sleeves on its own skeleton and bind pose; faces the pack's camera
never sees are left out; recoloured: coyote gloves and orange sleeves for defenders, dark ones for ghosts), **its clips**
idle, quick_draw and swing_0 to swing_3 as authored, resampled to the game's 0.3 s draw and 0.2 s swing windup, and
**its four swing recordings** (`SW_Swing_0` to `3`, as the knife slash sound: `client/public/audio/knife_slash_*.mp3`).
Its 2k colour, normal and occlusion-roughness-metal maps are resampled into our knife atlas. Not used: its draw,
holster, inspect, sprint and heavy-stab clips, its other sounds, its C# scripts, scenes and 4k textures. The download
stays in the git-ignored `tools/blender/source-art/realistic/fp-anims/` and must not be committed or redistributed.

### Attribution (CC-BY)

The game's weapons are made from these models, downloaded by the owner from Fab (fab.com) on 2026-11-17, each listed
there under a Creative Commons Attribution licence (the licence version was not checked by the build session; see each
listing):

- **"Makarov Pistol (PM)"** by **TaigaForest**: https://www.fab.com/listings/6af98baa-bc87-4a38-ae33-db73ca1c855c (the pistol)
- **"Tactical Knife"** by **Gerardo Justel**: https://www.fab.com/listings/33452f11-fc65-479e-8d6e-75bf8be1c0ff (the knife until package V; **no longer used**: nothing of it ships since the karambit replaced it)
- **"Red Dot Sight"** by **Gerardo Justel**: https://www.fab.com/listings/3a8c2a97-481e-403b-a61b-aef09a96debe (the 1x red dot)
- **"AR Scope (Game-Ready)"** by **Scape**: https://www.fab.com/listings/346c6bbd-a204-4317-9e10-b25c653821a8 (the 2x sight;
  package O: oriented and placed on the rifle's rail by script (the M4's since package T), its lens tube left out so the aimed view looks through
  it, reduced to 3,000 triangles in first person and 380 in third person, its five materials' maps cropped into the
  rifle atlas)

Changes made (all by script, `tools/blender/weapons.py`, `realistic.py`, `viewmodel.py`): re-oriented, scaled to real
size and centred on the grip; reduced in triangles (the knife from 22,578 to 4,398; the red dot from 23,281 to 2,172 without its
screws and glass; the Makarov kept at 11,578 without its loose cartridges and two internal spring meshes; third person
reduced further), split into moving parts (Makarov slide, magazine), joined with generated
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
| `realistic/rifle/ak105fbx.zip` (FBX + 4K maps for two materials) | 60,139,447 bytes | SpatialNeglect ("AK-105", CC-BY) | No longer (the rifle until package T; nothing of it ships) |
| `realistic/pistol/source.zip` (`SM_PM_Ammo_9x18.fbx` + 4K maps) | 82,911,353 bytes | TaigaForest | The pistol |
| `realistic/knife/tactical_knife_gltf.zip` (glTF + 4K maps) | 26,344,712 bytes | Gerardo Justel | No longer (the knife until package V; nothing of it ships) |
| `realistic/fp-anims/knife_fps_animations.unitypackage` (Unity package: FBX meshes and clips, 2k and 4k PNG maps, WAV sounds, C# scripts never run) | 177,644,194 bytes | see "The knife and its first-person hands" | The knife in both views, its first-person hands and clips, the knife slash sounds (package V) |
| `realistic/reddot/red_dot_sight.glb` (4K maps embedded) | 76,141,388 bytes | Gerardo Justel | The red dot |
| `realistic/scope2x/ar_scope_game_ready_gltf.zip` (glTF, 5 materials, 4K maps) | 56,855,445 bytes | Scape | The 2x sight |
| `realistic/soldier/fbx_all_assets.zip` (FBX parts) | 34,856,279 bytes | Quantum Assets | The soldier, the ghost and the first-person arms |
| `realistic/soldier/pbr_textures.zip` (121 4K PNGs) | 1,210,534,656 bytes | Quantum Assets | Their textures (BaseColor, OcclusionRoughnessMetallic, Unity_Normal; the Arms normal map is DirectX-style and is flipped) |
| `realistic/fp-anims/m4_animations_gltf.zip` (one glTF scene: M4, hands, 5 clips on one 10 s timeline) | 7,987,134 bytes | see "The rifle and the first-person hands" | The M4 in both views, the rifle's first-person arms and clips (package T), the gloved hands on the pistol and knife (package R) |

Earlier downloads (packages A and F), with a generic HTTP client and no account, licence as shown on poly.pizza:

| File | URL | Size | Licence | Author | Used |
|---|---|---|---|---|---|
| `characters/quaternius-swat/SWAT.glb` | https://static.poly.pizza/713f6535-f4f3-4367-a4c6-ced126ae0936.glb (page: https://poly.pizza/m/Btfn3G5Xv4) | 1,560,900 bytes | CC0 1.0 | Quaternius | Its animation clips only (idle, walk, run, death, hit), retargeted onto the soldier |
| `characters/quaternius-soldier/CharacterSoldier.glb` | https://static.poly.pizza/1083c1d3-d1d4-4682-adf6-bc516d06ac84.glb (page: https://poly.pizza/m/PpLF4rt4ah) | 1,333,700 bytes | CC0 1.0 | Quaternius | No longer (the old weapons) |

Quaternius: https://quaternius.com. CC0 asks for no attribution; it is given here anyway.
