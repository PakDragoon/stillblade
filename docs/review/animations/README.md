# Package F animation review (rendered, not recorded)

**Nothing here was seen running in the game.** Every image and video was rendered in headless Blender by
`tools/blender/review.py` from the shipped model files, then tiled and encoded by `tools/review-animations.mjs`:

```bash
"C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup --python tools/blender/review.py -- <frames dir> all
node tools/review-animations.mjs <frames dir> docs/review/animations
```

- `fp_*`: first person, from the game camera (vertical field of view 74 degrees, the default), each gun rig at the hip
  pose `client/src/presenter.ts` uses, the knife rig at the camera. Grey background, no map. Aiming, the draw, firing
  kick and sway are added by the presenter in the game and are not in these renders.
  - `fp_rifle_idle`, `fp_pistol_idle` (bare muzzle) and `*_suppressed`: the suppressor bone hidden or shown, as the
    room option does it.
  - `fp_rifle_reload` (2.2 s): magazine out at 0.3 s, new one seated at 1.4 s, cocking knob pulled 1.9 to 2.07 s.
  - `fp_pistol_reload` (1.4 s): magazine drops at 0.15 s, new one seated at 0.7 s, slide pulled 1.0 to 1.17 s.
  - `fp_knife_swing` (defender) and `fp_ghost_swing` (ghost suit): 0.2 s windup, 0.12 s slash, 0.2 s recovery.
- `tp_*`: third person, `character.glb` with `weapons.glb` in its hand sockets; upper-body clip over the legs of a
  base clip as `client/src/characters.ts` layers them; crouch frames include the crouch lean the client adds.
  - holds: `tp_rifle_hold`, `tp_pistol_hold` (one-handed), `tp_knife_hold`; crouched: `tp_*_crouch`.
  - `tp_rifle_reload`, `tp_pistol_reload` (seen from the front left, the support-hand side), `tp_pistol_shoot`.
  - `tp_knife_swing` (defender, standing), `tp_ghost_swing` (the same clip over the walk).
  - `tp_death`: the recentred fall (the game also turns the body toward open floor, `client/src/corpse.ts`; not shown).

`.jpg` files are a single frame or up to 12 frames in reading order; `.mp4` files are every frame at 30 fps.
