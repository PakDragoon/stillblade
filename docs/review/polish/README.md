# Package Q review pictures (visual and feel polish)

Made by `tools/polish-shots.mjs` (headless Chrome, SwiftShader software GL, scratch ports 8097 / 5197; the "before"
set from a temporary checkout of `main` at `321128f` served on 5196) and composed by `tools/compare-shots.mjs`.
Warehouse, 1366 x 768, red dot sight, practice range.

- `before/`, `after/`: the same views. `lit` = the yard in sunlight, `dark` = the basement car park at site A.
  `hip`, `aimed` (frozen fully aimed), `running` (frozen 0.45 s into a forward run; the camera is held at the spot,
  the weapon shows the bob and lean from the player's real 5.2 m/s), `firing` (frozen on the frame of a burst's third
  shot), `third-person` (a practice target STAGED at the spot by replacing its position and pose in the frame the
  presenter receives; the first-person layer hidden).
- `compare/`: before | after side by side; for first-person views also a 3x nearest-neighbour crop of the rifle's
  top edge and the red dot (anti-aliasing: staircase edges before, smooth after).
- `report.json` in each set: draw calls, the frame time measured as wall-clock time between 60 frames (software
  rendering: the CPU's cost of drawing, NOT a GPU's), and in `after/` the probe light at each spot.

These are still frames from a software renderer. Nothing here was seen on a real GPU, in motion, or with a mouse.
The before/after comparison is not byte-gateable (lighting, reflections and anti-aliasing change every weapon pixel
on purpose): it is a side-by-side review.
