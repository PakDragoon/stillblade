# Stillblade — handoff

Written 2026-11-12 at commit `3513823` (branch `main`, pushed to github.com/PakDragoon/stillblade). Everything below describes that commit.

Stillblade is a browser tactical FPS for low-end hardware. Ghosts are invisible while still, shimmer when moving, and carry only knives; they must plant a bomb. Defenders are visible, carry silenced guns, and track ghosts by sound. Round-based, first to 6.

## Where things stand

The game is playable end to end on a local machine: menu, rooms, rounds, bomb, scoring, textured map, animated armed players, synthesised audio. It is **not deployed**. It has **never been played by people**: every check so far was automated tests, or a single browser tab against a scripted bot.

### Verified

- 54 automated tests pass (`npm test`): movement and collision, the wire format, and the server rules (damage, lag compensation, visibility, information culling, footsteps, knife, rounds, bomb, halftime swap, match end).
- CI on GitHub passed for the Milestone 5 commit.
- Live in a browser against a bot: joining, round freeze and release, client prediction with zero error at 150 ms simulated lag, a ghost bot appearing only when in line of sight, footsteps arriving only within range, a defender bot killing the local player and the round ending with the score updating.
- A ten-player room costs the server about 0.05 ms per tick (`npx tsx tools/bench.ts`).

### Never verified — test these first

1. **Audio by ear.** All sounds are synthesised in code (`client/src/audio.ts`). Levels, direction and wall muffling were measured, never listened to. Footsteps measured as only weakly directional. Whether a defender can locate a ghost by sound is the core of the game and is unknown.
2. **Ghost shimmer in a real match.** Seen at visibility 0, 0.35 and 0.7 in a test scene only, never against the textured map. Whether a running ghost at 35% is fair to spot is unknown.
3. **Mouse aiming and movement feel.** Automation cannot capture the pointer; all input in testing was keyboard events.
4. **A live plant and defuse.** Covered by server tests only.
5. **Frame rate on an integrated GPU.** The only machine tested held 75 FPS before the art pass; nothing was measured after it, because the test browser was throttled in the background. The adaptive-resolution step-down has never triggered in a real slow case.
6. **Animation in real time.** Foot sliding and blending were only seen as still frames.
7. **Deployment.** The Dockerfile, the Caddy/compose stack and the GitHub Pages workflow have never been run. See `DEPLOY.md`.

## Known problems

- **Spawn-to-spawn sightline.** A defender at its spawn can shoot straight down the left lane (x ≈ -4) and hit a ghost at the ghost spawn about 34 m away. A scripted bot firing level killed the local player twice this way. Needs a wall or cover near the spawns: edit the box list in `tools/blender/greybox.py` and rebuild.
- **Stale dev modules.** After many rapid file edits Vite has served an old copy of a client file. If the HUD looks frozen or a function is "not a function", restart `npm run dev`.
- **Adaptive resolution reacts to a throttled tab.** A browser tab running in the background can make it step down to 90%. Harmless in a visible tab; `?res=1` pins it.
- **Remote ghost knife animation is inferred** from visibility spikes, so it can play the wrong clip.
- **Death animation falls backward about 1.8 m**, so bodies can end up partly inside walls.
- **Armed crouch keeps the back upright**; the crouch itself is a deep squat.
- **No first-person hands**; character hands are rigid and do not wrap the grip.
- **Art flaws:** bomb-site letters are blocky, pale inner walls are flat, stair steps are hard to tell apart, baked accent lights barely show in sunlight, the gun model is dark and looks large in a narrow window.
- **Node 20.11** is older than current Vite and Vitest support, so they are pinned to Vite 6 and Vitest 3.

## Not built

- WebRTC transport (WebSockets only).
- Desktop wrapper.
- Accounts, matchmaking across servers, more than one region.
- A second map, map detail props, particle effects, decals beyond a simple impact mark, a "High" graphics setting.
- Recorded audio (everything is synthesised).
- A spectator camera: dead players keep their death view until the next round.

## Running it

```bash
npm install
```

```bash
npm run dev
```

This starts the game server (ws://localhost:8080) and the web client (http://localhost:5173). Each browser tab is a player. The first to join is a ghost, the second a defender, alternating.

- `npm run bot` adds a scripted player (walks in, then strafes). `npm run bot -- --shoot` makes it hold fire. To play as a defender alone, start the bot before opening the page.
- URL options: `?auto=1` skips the menu, `?name=`, `?room=`, `?lag=150` (simulated round-trip latency), `?res=0.7` (pin render resolution), `?server=ws://host:port`.
- Keys: WASD move, mouse look, left click attack (F also attacks, useful without pointer lock), E plant or defuse, Tab scoreboard, Space jump, Shift quiet walk, C crouch.
- `npm test`, `npm run typecheck`, `npm run build`.
- In the browser console, `window.__sb` exposes `app`, `state`, `input`, `net`, `match`, `mapData`, `presenter`, `audio` and `stats()`.

## How it is put together

| Path | What it is |
|---|---|
| `shared/` | Code run by both client and server. `movement.ts` + `collision.ts`: deterministic box-hull movement. `rules.ts`: round phases, timings, plant/defuse eligibility. `visibility.ts`: ghost visibility curve. `protocol.ts`: message types and the binary wire format. `constants.ts`: every tuning number. |
| `server/src/game.ts` | The authoritative match. No socket code, so it is tested directly (`game.test.ts`). |
| `server/src/main.ts` | WebSocket transport, rooms, rate limits, `/health`. |
| `client/src/main.ts` | Game loop: fixed 60 Hz simulation, prediction and reconciliation, menu, adaptive resolution. |
| `client/src/net.ts` | Connection, clock estimate, interpolation of other players. |
| `client/src/presenter.ts` | Everything visual except the map: HUD, viewmodel, tracers, bomb. Implements `presenter-api.ts`. |
| `client/src/characters.ts`, `weapons.ts` | Animated player models and weapon attachment. |
| `client/src/audio.ts` | Synthesised spatial audio. Implements `audio-api.ts`. |
| `client/src/maplook.ts` | Map shader (albedo × baked light) and sky. |
| `tools/blender/` | Headless Blender scripts that generate the shipped assets. |
| `DEPLOY.md`, `Dockerfile`, `deploy/`, `.github/workflows/` | Deployment, untested. |

### Rules that keep it working

- **Client and server must simulate identically.** Movement, the movement lock and attack timing live in `shared/` and are counted in the player's own commands (`seq`), not wall-clock time. Change a rule in one place and both sides follow; never reimplement one on only one side.
- **The wire format must be exact for anything the client predicts with.** The local player's state travels as float64, and the client rounds its view angles with `Math.fround` before using them. Breaking this makes prediction drift.
- **Collision is axis-aligned boxes only.** Anything a player can stand on, hide behind or be blocked by must be a box in the list in `greybox.py`. Ramps, round or rotated solids need new collision code first.
- **The map is generated, not hand-edited.** `npm run map:greybox` (about 7 minutes; append `-- -- --no-bake` to skip the bake) rewrites the GLB, the collision JSON, the lightmap and the textures. Hand edits to `client/public/maps/greybox.glb` are overwritten. Decoration that needs no collision can be added as visual-only geometry in the script.
- **Never send a defender a ghost it cannot perceive.** `Game.knowsAbout` in `server/src/game.ts` is the anti-wallhack rule: a ghost is sent only if in line of sight with visibility above 0.01, or within breathing range (8 m). Sound events are sent only within earshot.
- **Presenter and audio are behind fixed interfaces** (`presenter-api.ts`, `audio-api.ts`) and never touch game or network state. Change the interface file first, then both sides.
- **Performance budget:** world at most 8 draw calls, unlit, 2 texture reads per pixel; at most 2 draw calls per armed player; no realtime shadows or post-processing; no per-frame allocations in `frame()` paths.

### Tuning numbers worth knowing (`shared/constants.ts`, `shared/rules.ts`)

- Speeds: run 5.2 m/s, quiet walk 2.6, crouch 2.0; jump clears a 1 m crate.
- Ghost visibility: 0 still, about 0.10 crouch-walking, 0.17 walking, 0.35 running; spikes to 0.6 on a swing or while planting, 0.8 when hit.
- Gun: 34 body, 100 head, 10 shots per second. Knife: 0.2 s windup, 2 m reach, 55 front, 100 from behind.
- Footsteps carry 18 m running, about 5 m walking, about 3 m crouched. Breathing 8 m.
- Round: 4 s freeze, 120 s live, 35 s bomb, 3 s to plant, 5 s to defuse, first to 6, sides swap after round 5.

## Assets and licences

All third-party art is CC0. Maps: textures and sky from Poly Haven, listed in `client/public/maps/CREDITS.md`. Models: Quaternius "SWAT" character and the SMG and knife from "Character Soldier", via poly.pizza, listed in `client/public/models/CREDITS.md`. Raw downloads live in the git-ignored `tools/blender/source-art/`; the Blender scripts fall back to the shipped files if it is missing, but rebuilding characters or weapons from source needs those files present.

## Working preferences from this project

- The owner asked that the main session plan and write correctness-critical code itself (shared simulation, server rules, netcode), and hand self-contained pieces (art, Blender scripts, HUD, audio, packaging) to Opus subagents with a precise written brief, to conserve usage.
- Pushing to `main` on GitHub has been the norm after each finished piece of work.
- Downloads were approved for CC0 art from Poly Haven, ambientCG, Quaternius, Kenney and KayKit, with every file recorded in a `CREDITS.md`.
- Accounts, sign-ins and anything paid are the owner's to do.

## Suggested order of work

1. Playtest with a second person, headphones on, and note what feels wrong (items 1–4 under "Never verified").
2. Fix the spawn sightline.
3. Tune from the playtest: audio direction, ghost visibility, plant and defuse times.
4. Check frame rate on an Intel UHD or AMD Vega laptop.
5. Deploy by following `DEPLOY.md`, starting with a local `docker build`.
