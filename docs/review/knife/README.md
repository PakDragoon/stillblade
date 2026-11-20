# Package V part 1: the knife from the owner's knife pack

All pictures are stills: **nothing here was seen in motion, on a real GPU, with a mouse or by ear.**

## How they were made

- `before/` (`main` at `ec84382`) and `after/` (this branch): `tools/knife-shots.mjs` in headless Chrome with
  SwiftShader (software GL) against a scratch game server (port 8092) and Vite (5192), Warehouse practice range,
  1366 x 768, frames frozen with `app.timeScale = 0` on the predicted knife state. Real key input only.
  - `after/` swings were captured with game time slowed to 0.1x so the frozen frame lands on the moment (a slash crosses
    the view in about 0.07 s, and software GL draws a frame only every 0.1 s or more of game time). **`before/` was
    taken at full speed**, so some of its strike frames fall after the old swing: compare windup to windup loosely.
  - Windup frames: 5 of the 12 windup commands done (about 0.08 s into the 0.2 s windup). Strike frames: the command the
    slash lands on.
  - `report.json`: knife state and draw calls per picture.
- `blender/`: Workbench renders by `tools/blender/fpknife.py --preview` (vertex colours only, no textures), from the
  pack's eye: `pack-*` at the pack's own 34.5-degree view (what the game now uses for the knife), `vm74-idle` at the
  game's 74-degree weapon view without the zoom (why: the hands are small in the middle of the screen, and the upper
  arms the pack's camera never sees are missing).

## Files

| Picture | What to look at |
|---|---|
| `{low,high}-rifle-hip`, `-pistol-hip` | The M4 and pistol, unchanged (their files are byte for byte `main`'s) |
| `{low,high}-defender-draw-1`, `-2` | The 0.3 s draw (the pack's quick draw at 1.67x): draw-1 with 7 of 18 draw commands left; draw-2 was caught only as the draw ended (software GL frames are too coarse) |
| `{low,high}-defender-idle`, `-idle-dark` | Coyote gloves, orange sleeves (the camouflage muted, not removed), the karambit; lit yard and dark basement |
| `{low,high}-ghost-idle` | The ghost's dark gloves and sleeves |
| `{tier}-{defender,ghost}-swing{0,1,2,1-again,3}-{windup,strike}` | Five swings with the attack held: the chain 0, 1, 2, 1, 3. Strike = the blade crossing the middle of the view. The chained swings' early windup is off screen (they start where the previous swing ended, low at the screen's edge), as the pack authored |
| `{tier}-third-person-defender-*` (seen by a ghost), `-ghost-*` (seen by a defender) | The karambit in the soldier's right hand, front, side and close. Small from a distance: the karambit is 22.6 cm and curls out of the fist's pinky side, where the old Tactical Knife stuck forward 30 cm |
| `blender/pack-swing*-2-strike` | The strike of each swing from the pack's eye |

## Numbers

- Draw calls (Low / High, first person with the knife): 20 / 42 (before 19 / 42; only one knife mesh is drawn, checked).
  Third person: unchanged within one call either way.
- Download: Low 4,662,534 -> 4,647,068 bytes, High 7,203,930 -> 7,036,534 (`viewmodel_knife.glb` 589,480 -> 676,596;
  the knife atlases shrank more).

## For the owner to check by playing

The swings at full speed with the attack held, whether the blade crossing the crosshair feels like the hit, the
recovery after letting go, the draw, the 34.5-degree framing on his screen, the sleeves' muted camouflage, the ghost's
hands in the dark, the karambit in other players' hands, and the new slash sounds.
