# Package R: the M4 pack's first-person motion on the AK-105

Before = `main` at `321128f` (package O's generated rifle clips). After = this branch (the pack's clips retargeted by
`tools/blender/viewmodel.py`, read by `tools/blender/fpanims.py`).

## Blender previews (`blender-before/`, `blender-after/`)

`viewmodel.py -- --rig rifle --preview <dir>` (Workbench, untextured, every optional sight shown at once because the
preview does not hide them; FOV 74, 1366 x 768 at 60 %). Each frame has `-close` (hands) and `-side` (from the left);
the charging-handle frames also `-right` (from the right, where the AK's handle is).

- before: `rifle-idle`, `rifle-reload-0-hand-in` (0.25 s), `-a` (0.5 s), `-b` (1.15 s), `-c` (1.95 s, bolt)
- after (times in our clips): `rifle-idle` (unchanged), tactical reload `rifle-reload-1-hand-on-mag` (0.46 s),
  `-2-mag-out` (0.80 s), `-3-mag-low` (1.10 s), `-4-mag-in` (1.45 s); empty reload `rifle-empty-1-mag-out` (0.82 s),
  `-2-handle-reach` (1.90 s), `-3-handle-pulled` (2.03 s); `rifle-draw-1` (0.12 s), `-2` (0.25 s); `rifle-fire`
  (1/30 s after a shot).

## In the game (`game-before/`, `game-after/`)

`node tools/fp-anim-shots.mjs --out <dir> --client http://localhost:5194 --server ws://localhost:8094` against a
scratch server and Vite (ports 8094 / 5194; 8098 / 5198 were held by another session). Headless Chrome, SwiftShader
(software GL), practice range, defender, red dot, Low tier, Test Map 1, real key input. "Before" ran this branch's code
with `main`'s `viewmodel_rifle.glb` swapped in (the presenter falls back to the old clips when the new ones are
missing, so it draws what `main` draws; the one difference is that the empty reload now lasts 2.7 s, stretching the
old 2.2 s clip). The rig file was put back afterwards (byte-compared).

Frames are frozen with `app.timeScale = 0` on the first rendered frame past the wanted point. SwiftShader frames are
slow (several simulation ticks each), so frames land late; `frames.json` in each folder has the exact reload and draw
counters of every picture (reload progress = 1 - reload / 132, or / 162 for the empty reload). In `game-after`
`04-draw-1` landed at draw 7 of 24, nearly at the end, so the two draw frames look alike; the Blender previews show
the draw properly.

`01-hip`, `02-reload-{1..4}` (tactical), `03-empty-{1-mag-out,2-mag-in,3-handle-reach,4-handle-pulled}`,
`04-draw-{1,2}`, `05-knife-defender`, `06-knife-ghost` (knife grips: unchanged by this package).

The pack itself (its M4 and its gloved hands) was rendered only to the session's scratch folder for comparison and is
deliberately not in the repository (Fab Standard License: its content is not redistributed).
