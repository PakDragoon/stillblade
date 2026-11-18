# First-person arms fix (package O follow-up): before and after

Taken 2026-11-18 by `tools/soldier-shots.mjs --only fp --quick --fov <74|110>` in **headless Chrome with software GL
(SwiftShader)**, scratch game server on port 8099 and Vite on 5199 (never the owner's 8080 / 5173), 1366 x 768, Low tier,
Test Map 1's practice range, real input (keys dispatched on the page). Reloads and swings are frozen mid-way. **Nothing
here was seen on a real GPU, in motion or with a mouse.**

`before/` is `main` at 52e0096 (package O as merged); `after/` is this fix. Each picture exists at the default field of
view (`-fov74`) and the widest the settings allow (`-fov110`). In `before/` the two are identical: the field of view
setting had no effect (the frame loop reset the camera to 74 degrees every frame; fixed in `after/`).

| Files | What |
|---|---|
| `10-rifle-{iron,reddot,scope2x}-hip-*` | The AK at the hip with each sight |
| `11-rifle-{iron,reddot,scope2x}-aimed-*` | Fully aimed with each sight (the sight on the screen centre) |
| `12-rifle-reload-{a,b,c}-*` | Rifle reload: magazine out, new magazine, charging handle pulled |
| `20-pistol-hip-*`, `21-pistol-aimed-*`, `22-pistol-reload-*` | The Makarov, two hands, thumbs forward |
| `30-knife-idle-*`, `31-knife-swing-*` | A defender's knife |
| `32-ghost-knife-idle-*`, `33-ghost-knife-swing-*` | A ghost's knife (the dark suit arms and gloves) |
| `10-rifle-reddot-hip-fov74` | The rifle hip view framed like the owner's reference screenshot (compare side by side; the reference is not in the repository) |
| `report-fp.json` | Draw calls with the other players hidden (unchanged: one per rig plus the flash) |

The knife "swing" pictures freeze when the swing's cooldown passes a fixed count, which can land after the slash; the
slash itself is easier to judge in the Blender previews (`viewmodel.py --preview <dir>`).

## Second follow-up (roll, the thin aimed gun, knife fingers)

`before2/` is `main` at d2d5098; `after2/` is this fix. Every first-person picture at four fields of view: `-fov60`,
`-fov74`, `-fov90`, `-fov110` (same file names as above). Same method: headless Chrome, software GL, scratch ports
8099 and 5199, still frames only.

- **Thin aimed gun (`11-rifle-iron-aimed-*`):** the iron sight's eye point was 0.44 m behind the grip, past the end of
  the stock, so aimed the camera saw the AK exactly end-on, a 5 cm strip (the folding stock's butt edge-on). It was the
  same at every field of view: the field of view lock (`presenter.ts VM_FOV`) projects exactly like a 74-degree camera
  and was not the cause. The eye now sits 0.20 m behind the grip (a cheek weld; `weapons.py EYE_BEHIND_GRIP`): the stock
  passes under the eye and the receiver's top leads to the front post. Red dot and 2x scope eye points are unchanged.
- **Roll:** rifle and pistol hip poses rolled -1 degree instead of -6 and -3; the knife's spine is level.
- **Fingers:** every finger now bends in its own plane, toward the palm, about the hand's own knuckle line (they used
  the grip's axis, which for the knife's diagonal handle bent them sideways); the knife's thumb wraps over the handle.
