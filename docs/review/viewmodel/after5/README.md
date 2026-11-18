# Package R, hands trial: the pack's gloved hands against our old hands

Old = package R's first commit (our soldier's hands). New = the second commit (the pack's gloves, `packhands.py`).
**Open `compare-blender/` and `compare-game/` first: each image is old on the left, new on the right, same moment.**

## Blender previews (`blender-old/`, `blender-new/`, `compare-blender/`)

`viewmodel.py -- --rig <rifle|pistol|knife> --preview <dir>`: Workbench, untextured (vertex colours only, so the
gloves look grey here), every optional rifle sight shown at once, FOV 74. Each moment also has `-close` (hands) and
`-side` (from the left); the AK handle pull also `-right`.

- Rifle: `rifle-idle`, tactical reload `rifle-reload-1-hand-on-mag`, `-2-mag-out`, `-3-mag-low`, `-4-mag-in`; empty
  reload `rifle-empty-1-mag-out`, `-2-handle-reach`, `-3-handle-pulled`; `rifle-draw-1`, `-2`; `rifle-fire`.
- Pistol: `pistol-idle`, `pistol-reload-a` (magazine out), `-c` (slide).
- Knife: `knife-idle` and `knife-swing-10` to `-50` (the file holds both the defender's and the ghost's arms; the
  preview draws both on top of each other). The closed fist round the handle shows best in `knife-idle-side`.

## In the game (`game-old/`, `game-new/`, `compare-game/`)

`node tools/fp-anim-shots.mjs --out <dir>` against a scratch server and Vite on ports 8094 / 5194 (headless Chrome,
SwiftShader, practice range, red dot, Low tier, Test Map 1, real key input; frames frozen with `app.timeScale = 0`,
which lands a little late on slow software frames: `frames.json` has the exact counters).

`01-hip`, tactical reload `02-reload-1..4`, empty reload `03-empty-1-mag-out`, `-2-mag-in`, `-3-handle-reach`,
`-4-handle-pulled`, `04-draw-1`, `-2`, `05-pistol-idle`, `05-pistol-reload-a-mag-out`, `-b-mag-in`, `-c-slide`,
`06-knife-defender`, `07-knife-ghost`.
