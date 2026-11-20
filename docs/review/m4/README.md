# Package T review pictures: the M4 everywhere

Made 2026-11-20 on branch `claude/m4-everywhere-465728`.

- `after/` and `before/`: the game in headless Chrome with **SwiftShader (software GL)**, 1366 x 768, Warehouse
  practice range, taken by `node tools/m4-shots.mjs` (scratch ports: server 8091, Vite 5191 for after and 5192 for
  `main` at `af09e9c` for before). Frozen frames, real keyboard input. `report.json` lists every frame's gun state and
  draw calls. The "before" run is the shorter `--short` set (fewer reload phases).
- `blender/`: Workbench renders of the new rifle rig by `tools/blender/fpm4.py --preview` (grey vertex colours, no
  textures; for poses only). `pack-*` = the pack's own placement of the gun, `ours-*` = the hip pose the owner
  approved for the AK (package O third follow-up, kept). `aim-*` = the camera at each sight's aim point;
  `aim-iron-eye20` is the AK's old iron eye distance, for comparison (the M4 uses 12 cm).

**Nothing here was seen on a real GPU, in motion, with a mouse, or heard.**

## What to look at

| Moment | After | Before |
|---|---|---|
| Hip, lit / dark (Low, High) | `after/{low,high}-{lit,dark}-hip.jpg` | `before/` same names |
| Aimed, red dot, lit / dark | `after/{low,high}-{lit,dark}-aimed-reddot.jpg` | same |
| Aimed, iron sights | `after/{low,high}-lit-aimed-iron.jpg` | same |
| Aimed, 2x scope | `after/{low,high}-lit-aimed-scope2x.jpg` | same |
| Hip with iron sights (rear sight up; it folds away under an optic) | `after/low-lit-hip-iron.jpg` | same |
| A shot (trigger pulled, bolt cycling, kick) | `after/low-fire.jpg` | same |
| Tactical reload: start, magazine out, magazine low, magazine in | `after/low-reload-{1-start,2-mag-out,3-mag-low,4-mag-in}.jpg` | `before/low-reload-{2-mag-out,4-mag-in}.jpg` |
| Bolt locked back after the last round (left side: the catch is up; the open bolt is on the right side) | `after/low-bolt-locked.jpg`, `blender/ours-bolt-locked-right.jpg` vs `blender/ours-bolt-closed-right.jpg`, `blender/ours-bolt-locked-left.jpg` | `before/low-bolt-locked.jpg` (the AK had no hold-open) |
| Empty reload: magazine out, magazine in, palm on the bolt catch | `after/low-empty-{1-mag-out,2-mag-in,3-bolt-catch}.jpg` | `before/low-empty-{1-mag-out,3-bolt-catch}.jpg` (the AK's charging-handle pull) |
| Draw (switching back to the rifle) | `after/low-draw-{1,2}.jpg` | same |
| Pistol and knife (unchanged) | `after/low-pistol-{hip,reload}.jpg`, `after/low-knife-{defender,ghost}.jpg` | same |
| Third person, front / right side / left side | `after/{low,high}-third-person-{front,side,left}.jpg` | same |
| The pack's own framing against ours | `blender/pack-*.jpg` against `blender/ours-*.jpg` | |

## Draw calls (main pass, from `report.json`)

| View | Before | After |
|---|---|---|
| Low, lit, hip | 20 | 20 |
| Low, dark, hip | 10 | 10 |
| High, lit, hip | 42 | 42 |
| High, dark, hip | 32 | 32 |
| Low, third person front / side / left | 11 / 15 / 13 | 12 / 15 / 14 |
| High, third person front / side / left | 37 / 43 / 41 | 37 / 43 / 41 |

The two Low third-person views that differ by one have other practice targets walking in the background (they move
between runs); the script's attempt to count a view without the staged player did not remove it (the count stayed the
same), so the per-player cost was not measured directly.

The first-person rifle is still one skinned mesh (one draw call); an armed player is still the character mesh plus
one gun mesh (the gun, its sight and its suppressor are merged into one mesh at load, as before).

## Sizes (bytes)

| | Before | After |
|---|---|---|
| `viewmodel_rifle.glb` | 1,264,716 | 1,285,024 |
| `weapons.glb` | 302,944 | 320,076 |
| `textures/rifle_albedo_1024.webp` + `rifle_normal_1024.webp` | 290,256 | 218,374 |
| `textures/rifle_albedo_2048.webp` + `rifle_normal_2048.webp` | 740,742 | 633,660 |
| **Low model download** (weapons, three rigs, Low characters, 1024 atlases) | 4,696,976 | **4,662,534** (34 KB less; the test budget is 4,718,592) |
| **High model download** (same with High characters and 2048 atlases) | 7,273,572 | **7,203,930** (70 KB less) |
