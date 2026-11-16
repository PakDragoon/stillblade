# Graphics tiers (package G): review screenshots

All images are **headless Chrome screenshots** (1280 x 720, render resolution pinned to 100% with `?res=1`) of the real
client against a scratch game server, taken by `tools/graphics-shots.mjs` (see its header for how to run it). Chrome ran
with SwiftShader (software GL), so **frame rates from these runs mean nothing**; only the draw calls in
`drawcalls.json` are measured. No Blender renders are used here.

- `before/` is `main` at `91e9671` (no tiers: the address has no `tier=`), shot before any package G change.
- `after/` is this branch with `?tier=low` and `?tier=high`, with the rebuilt maps (new bake).

Each map is shot in a practice range (`practice=1`), so there are real server-side players in some views:

| File | What it shows |
|---|---|
| `<map>_<tier>_players_defenders.jpg` | As a ghost at the spawn: five defender practice targets (lit characters; High adds blob shadows). |
| `<map>_<tier>_<view>.jpg` | Fixed camera views of the map (camera placed on the nearest walkable spot at eye height): Test Map 1 `mid`, `site_a`, `stairs`, `site_b_close`; Warehouse `yard`, `site_b`, `stairs_s2`, `site_a`. |
| `<map>_<tier>_ghosts_running.jpg` | As a defender facing the ghost practice targets, every ghost drawn at a running ghost's visibility (0.35) by overriding the presenter's input. The shimmer as an enemy defender would see it. |
| `<map>_<tier>_firing.jpg` | A real predicted rifle burst into the floor, frozen on the fourth shot (`app.timeScale = 0`): tracer, flash, dust, holes. Frame time was clamped to 20 ms during the burst so the flash survives SwiftShader's slow frames. |
| `<map>_<tier>_explosion_staged.jpg` | **Staged**: the presenter was handed one frame of "round over, bomb exploded" at site A's centre (no real plant or detonation), then frozen 0.3 s in. |

`drawcalls.json` lists, per view, the total draw calls (`all.total`, PlayCanvas `app.stats`) and the same frame with the
remote players removed from the presenter's input (`noPlayers.total`).
