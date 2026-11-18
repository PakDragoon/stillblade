# The defender's first-person sleeve: generated tube -> the soldier's own shirt

Old = `main` at `3a5f2e7` (package R's hands trial: a generated tube with a stretched patch of shirt fabric). New =
this branch (`packhands.sleeve_from_shirt`: the third-person Quantum shirt's upper-arm sleeve moved onto the forearm).
**Open `compare/` first: old on the left, new on the right, same frame.**

## In the game (`game-old/`, `game-new/`, `compare/`)

`node tools/sleeve-shots.mjs --out <dir>` (built on package Q's `tools/polish-shots.mjs`) against a scratch server and
Vite on ports 8094 / 5194: headless Chrome with SwiftShader (software GL), Warehouse, package Q's two spots (`lit`, the
spot Q calls lit; `dark`, the basement car park at site A) with the camera moved there inside `presenter.frame` so the
weapon is lit by that spot's probes, Low and High tiers, the practice range as a defender with the red dot. "Old" ran
the same code with `main`'s three `viewmodel_*.glb` swapped in (the atlases are identical in both), then the new files
were put back and byte-compared.

Per tier and spot: `1-hip`, `2-handle-pull` (the empty reload frozen at the AK charging-handle pull, the left forearm
across the view), `3-pistol`; at the lit spot also `1-aimed` (red dot) and `4-knife` (the defender's knife).

## Blender previews (`blender-new/`)

`viewmodel.py -- --rig <rifle|pistol|knife> --preview docs/review/viewmodel/after6/blender-new`: Workbench, untextured
(the shape and folds only), the same moments as `after5` (whose `blender-new/` is the old tube, so the two folders
compare directly).
