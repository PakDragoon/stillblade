# Stillblade — handoff

Written 2026-11-12 at commit `3513823` (branch `main`, pushed to github.com/PakDragoon/stillblade). Updated 2026-11-14 on branch `claude/maps-builder-second-map-385b34` (not merged): several maps, a shared map builder, and a second map, Warehouse. Map-related statements below describe that branch. Updated again 2026-11-15 on branch `claude/weapons-rifle-pistol-e34f67` (not merged): defenders carry a rifle and a pistol, with switching and aim down sights (protocol version 7).

Stillblade is a browser tactical FPS for low-end hardware. Ghosts are invisible while still, shimmer when moving, and carry only knives; they must plant a bomb. Defenders are visible, carry silenced guns, and track ghosts by sound. Round-based, first to 6.

## Where things stand

The game is playable end to end on a local machine: menu, rooms, rounds, bomb, scoring, textured map, animated armed players, synthesised audio. It is **not deployed**. It has **never been played by people**: every check so far was automated tests, or a single browser tab against a scripted bot.

### Verified

- 90 automated tests pass (`npm test`): movement and collision, the wire format, the gun and knife rules (`shared/gun.test.ts`, `shared/knife.test.ts`), rooms and map loading (`server/src/rooms.test.ts`), and the server rules (damage, lag compensation, visibility, information culling, footsteps, knife, ammo and reload, recoil and spread, a client jumping its command numbers gaining neither spread nor knife timing, rounds, bomb, halftime swap, match end).
- **Gun ammo, reload and recoil (branch `claude/gunplay-reload-recoil-af745a`)**, live against bots at `?lag=150`: prediction error stayed 0 and the predicted gun never disagreed with the server (`window.__sb.stats().gunMismatches` = 0) through full-auto fire, an automatic reload on empty, an R reload, and firing until both magazine and reserve were empty. The HUD counter (`#sb-ammo`) showed the same magazine and reserve as the server snapshot at every check. A ghost observer saw a `--shoot` bot's reloads (`reloading` flag) and the bot kept firing across reloads. After merging the maps work, the same checks were repeated on both maps (`?map=greybox` and `?map=warehouse`) at `?lag=150` against a `--shoot` bot: as a defender (R reload, automatic reload, firing out the reserve) and as a ghost holding the knife (12 to 15 swings, one every 0.7 s), prediction error, `gunMismatches` and `knifeMismatches` all stayed 0 and the HUD matched the server's last snapshot. The browser pane was hidden, so frames were driven by firing PlayCanvas `update` from script: nothing was looked at.
- **Rifle and pistol, switching, aim down sights (branch `claude/weapons-rifle-pistol-e34f67`).** Tests cover each weapon's fire interval, magazine, reserve and reload; semi-automatic fire needing a new press; switch timing, a switch cancelling a reload without giving ammunition, per-slot ammunition surviving switches; aim progress and its effect on spread and recoil; per-weapon damage; nothing changing when `seq` jumps; one-byte limits on every counter; wire round trips of the new command bits and the loadout. `server/src/prediction.test.ts` plays a simulated client that predicts exactly like `client/src/main.ts` against the real server through the binary format at 150 ms round trip (and other delays, and with jumping command numbers) for two minutes of random bursts, taps, switches, aiming and reloads: zero weapon or position disagreements. Live in the browser at `?lag=150` against a bot, as a defender on both maps, a scripted run of rifle bursts, an R reload, an automatic reload on empty, holding the pistol trigger (one shot), pistol taps, aimed taps, a pistol reload cancelled by Q, Q back, a full pistol reload, an aimed rifle spray, rapid 2/1/Q/Q switching, and switching while moving, aiming and firing: prediction error 0 and `gunMismatches` 0 (Test Map 1, and Warehouse once frames were driven by a Worker clock; see the hidden-pane note under Known problems). As a ghost watching a `--shoot --pistol --aim` bot: the bot showed as holding the pistol, aiming between shots and reloading (aim drops during a reload), and every shot event named the pistol. The mouse wheel and right mouse were not exercised (they need pointer lock); keys 1, 2, Q, Z and F were.
- CI on GitHub passed for the Milestone 5 commit.
- Live in a browser against a bot: joining, round freeze and release, client prediction with zero error at 150 ms simulated lag, a ghost bot appearing only when in line of sight, footsteps arriving only within range, a defender bot killing the local player and the round ending with the score updating.
- A ten-player room costs the server about 0.06 ms per tick on Test Map 1 and 0.2 ms on Warehouse (345 boxes; collision and rays scan every box) (`npx tsx tools/bench.ts <map>`).
- **Maps (2026-11-14):** both maps build from their definitions and pass verification. In a browser against a bot, on each map: joined via `?map=`; the bot, asking for another map, was put on the room's map; a ghost walked by keyboard to a site and **planted live** (Warehouse site B, Test Map 1 site A). On Warehouse every staircase was walked with keyboard input (S1 down and up, S2 down, S3 up, M1 up and down, M2 up) and both sites reached; dropping from the catwalk into site B works. Unknown map ids are refused (browser shows "Could not join: Unknown map", bot gets close code 1008). Screenshots and plan images: `docs/review/maps/`.

### Never verified — test these first

1. **Audio by ear.** All sounds are synthesised in code (`client/src/audio.ts`). Levels, direction and wall muffling were measured, never listened to. Footsteps measured as only weakly directional. Whether a defender can locate a ghost by sound is the core of the game and is unknown.
2. **Ghost shimmer in a real match.** Seen at visibility 0, 0.35 and 0.7 in a test scene only, never against the textured map. Whether a running ghost at 35% is fair to spot is unknown.
3. **Mouse aiming and movement feel**, now including **weapon feel**: whether the pistol's kick and quick recovery, the aim-down-sights zoom and slowed mouse look, the switch times and the semi-automatic buffering (a press during the fire interval fires as soon as it ends) feel right is unknown. Numbers are as designed and untuned. Automation cannot capture the pointer; all input in testing was keyboard events. This now includes **recoil feel**: whether the pattern is learnable and pull-down feels right, and whether the camera kick reads well, are unknown. The ammo HUD, spread crosshair, first-person reload motion, remote reload pose and the reload/dry-fire sounds were built but never seen or heard (`RELOAD_ROT` in `presenter.ts` and `RELOAD_DIP` in `characters.ts` are guesses).
4. **A live plant and defuse.** Covered by server tests only.
5. **Frame rate on an integrated GPU.** The only machine tested held 75 FPS before the art pass; nothing was measured after it, because the test browser was throttled in the background. The adaptive-resolution step-down has never triggered in a real slow case.
6. **Animation in real time.** Foot sliding and blending were only seen as still frames.
7. **Deployment.** The Dockerfile, the Caddy/compose stack and the GitHub Pages workflow have never been run. See `DEPLOY.md`.

## Match flow, HUD and menus (branch `claude/match-flow-hud-menus-da874f`, protocol 8)

**Server (all JSON, nothing predicted).** `Game` takes `{ lobby: true }` (set by `Rooms`; tests and `tools/bench.ts` leave it off, which keeps the old "start as soon as both teams have a player" behaviour).
- Lobby: a room starts in warmup (everyone walks around and respawns). The round machine leaves warmup when every connected player is `ready` **or** the creator sent `start`, and both teams have a (non-idle) player. Ready flags reset when a round starts and when a match falls back to warmup; a team emptying mid-match also zeroes the score and statistics.
- Creator = longest-connected player (`Game.creatorId`, derived from `joinedAt`, so it passes on by itself when they leave).
- Teams: a new player joins the smaller team (ghosts on a tie). In warmup `{type:'team'}` switches, refused if the teams would then differ by more than one (`MAX_TEAM_GAP`) and refused outside warmup.
- Statistics (`MatchStats` in `shared/protocol.ts`, carried on every `RosterEntry`): kills, deaths, assists (damage within `ASSIST_MS` = 4 s before someone else's kill), headshots (headshot hits), backstabs, damage (health actually removed), plants, defuses. Reset when a match starts. The roster is re-sent on every kill, round start and round end.
- Match end: the round that reaches 6 sends `summary` (winner, score, every player's stats, `mvp`, `nextAt`) once, holds the result `MATCH_OVER_MS` = 20 s, then starts a fresh match: same room, same map, score and stats zeroed, **players keep their group** (the side they started on, so the roles reset to the first-half roles, not to what they played last). Players joining during the result screen get the stored `summary`, are not spawned, and join the new match. MVP score is documented in `shared/stats.ts` (`mvpScore`).
- Chat (`{type:'chat', team, text}`): `cleanChat` (`shared/chat.ts`) strips control characters, collapses whitespace and caps at 120 characters; 4 lines burst, one more per 1.5 s, extra lines dropped with a `notice`. While a round is on (freeze, live, planted) a dead player's line (a mid-round joiner counts as dead) reaches **only dead players**; team chat reaches only the sender's team; between rounds and in warmup everyone hears everyone.
- Idle: a living player whose commands change nothing (movement, view angles, buttons; not `seq` or `viewTime`) for `IDLE_MS` = 90 s of a live or planted round is killed silently (no death counted), flagged `idle` in the roster, told by `notice`, and left out of the team counts so the round can end. Any input change clears the flag; they spawn again at the next round start. The clock only runs while a round is live.
- Damage events: `dmg` goes to the victim with `dir` (world bearing toward the attacker, yaw convention) and `amount` only; the killing blow adds `by` and `dist`. `hitconfirm` (`body`, `head`, `kill`) goes to the attacker. A ghost that stabs a defender is within 2 m, inside the 8 m breathing range, so this adds nothing `knowsAbout` forbids; tests check the keys and that no `pos` appears. `shot` and `slash` events are unchanged.
- Client JSON messages are routed by `Game.handleMessage` (text frames; `maxPayload` was raised from 256 to 1024 bytes for chat).

**Client.** `client/src/ui.ts` + `ui.css`: menu (create, join, quick play, how-to shown once), loading screen, connection error screens, lobby panel, pause, settings, controls, result card, chat. `settings.ts` stores settings in `localStorage` (`sb-settings`) and notifies listeners; `radar.ts` is the radar; HUD additions (alive pips, bomb and round timer, damage direction, low-health pulse, death recap, spectating label, custom crosshair) are in `presenter.ts` behind `presenter-api.ts`. Hit marker sound and volume controls are in `audio.ts` behind `audio-api.ts`. In `main.ts`: join flow and connection handling, the settings subscription, the spectator camera and radar update.
- Pause: whenever pointer lock is lost with nothing else open (Esc) the pause menu opens and the match keeps running. The mouse is released while typing chat so Esc reaches the chat box.
- Spectating uses only what a dead player is already sent: teammates (always in snapshots, with yaw and pitch), followed in first person; with no living teammate the camera shows the whole map from above (this only lasts through the round-over pause or a planted bomb, since a round ends when the last ghost or defender dies).
- Reconnect: a connection that drops after joining reloads the page once with the room, name and map remembered in `sessionStorage` (`sb-rejoin`); if that fails the error screen has a retry button. Settings survive in `localStorage`.
- Radar: north-up, 24 m radius, boxes of the current floor, own team only, sites, and the planted bomb. It is never given enemies.

**Match flow: gaps (what was and was not checked).** Checked in headless Chrome (driven over the DevTools protocol, software GL) against bots, on both maps: menu, join by code, lobby panel with ready, chat (all and team), HUD in a live round, Tab scoreboard, pause, settings, controls, loading and error screens (server unreachable, unknown map, too many connections), a complete match to the result card with its countdown and the rematch (on a scratch server with shortened rules: 10 s rounds, 2 rounds to win; the real 120 s rounds and 6-round match were only covered by `server/src/matchflow.test.ts`), idle move to spectate then first-person follow of a teammate and the map overview, and the hit marker and damage direction widgets (called through `__sb.presenter`, not from a real fight). Screenshots: `docs/review/match-flow/`.
- **Never seen with real input:** pointer lock (Esc to pause, mouse released for chat and re-captured after), copy invite link (clipboard), the death recap and hit marker from real hits (server events are tested, the client wiring only by reading), the hit sound and the volume sliders by ear, the automatic reconnect after a dropped connection, "Room full" in a browser (local connections hit the per-IP limit first; `rooms.test.ts` covers the rule), and a long real match: a headless client dropped off the server after a few minutes in several runs, cause not found (it was a throttled headless page; no server error was logged), so a human playing 13 minutes is untested.
- Graphics quality only caps the adaptive resolution step (low 60%, medium 80%, high 100%).
- Radar: built from the collision boxes (floors within 0.45 m of the player's feet, solids that block a standing player). It was seen on both maps; multi-floor behaviour on Warehouse stairs was not checked.
- A mid-round joiner counts as dead for chat purposes until the next round.
- Dead players keep seeing enemy ghosts from the spot where they died (existing `knowsAbout` behaviour, unchanged); a spectator does not see through the teammate's eyes for that.
- The old banner still shows "MATCH OVER" under the result card; the card is opaque enough to cover it.

## Known problems

- **Phase edges and the gun.** The client decides "armed" (not frozen, hands free) from its own view of the round phase, which arrives late under lag. A trigger held across the freeze-to-live edge can fire on the server before the client predicts it; the snapshot corrects the gun state (one `gunMismatches` tick), but that shot's tracer and sound are not shown locally. Same as before this change for firing; never seen in testing.
- **Spread is predictable, by design.** The client must predict it, so a modified client can know the next shot's spread (256 seeds per player id, repeating) and compensate its aim; it can no longer choose a small spread. Only server-side randomness the client cannot predict would remove this, at the cost of predicted tracers not matching.
- **A reload sound plays to the end** even if the reload is cancelled by death, because one sound event schedules the whole sequence.
- **Warehouse has only been seen by its author.** Its layout passes every automatic check, but nobody has played it: balance, how readable the three levels are, and whether the car park and catwalk sightlines (up to 30 m) favour defenders are unknown. Frame rate on it was not measured on an integrated GPU: it is 7 world draw calls plus the sky, as the budget allows, but 30 k vertices and a 3072² lightmap (about 48 MB of GPU memory with mipmaps).
- **The pistol uses the rifle's two-handed character pose**, so on other players it is mostly hidden between the hands; a one-handed pistol animation would fix it. The remote switch dip and aim raise (`characters.ts`) were never seen on screen. The rifle's aimed view shows a chunky gun body under the sight (the model's proportions). Pistol and switch sounds (`audio.ts`) were never listened to. First-person poses per weapon live in one table in `presenter.ts` (screenshots in `docs/review/weapons/`); they were tuned from still frames only. The pistol model is the "Pistol" prop already in Quaternius's `CharacterSoldier.glb`, with a generated suppressor (nothing new downloaded).
- **A hidden browser pane throttles timers**, and `?lag=` delays every command with `setTimeout`. Commands then arrive in bunches, the server drops the ones beyond its 12-command credit, and the client's prediction of those commands is corrected (seen as `gunMismatches` and position error). This is the existing rate limit, not a weapon rule: a server-side count of dropped commands matched every mismatch, and with frames driven by a Worker clock the same run had none. Expect the same on a real player's machine whenever the tab stalls.
- **Browser tests ran with the browser pane hidden**, so `requestAnimationFrame` never fired; the test harness called `app.tick` from a timer. Movement and rules are unaffected, but frame-rate numbers from those runs mean nothing.
- **The menu shows a dark, empty scene** behind it: the map is loaded only once the server says which map the room uses.
- The Test Map 1 spawn-to-spawn sightline (defender at spawn shooting down mid at x = -4 into the ghost spawn) is fixed by a cover wall in front of the defender spawn, and the verifier now fails any map with such a line.
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
- Team voice, a map vote or rotation after a match, kick and ban, bots that fill a lobby, player-chosen key bindings, a graphics setting beyond render resolution.
- Particle effects, decals beyond a simple impact mark and map paint, a "High" graphics setting. Maps can be picked in the menu; there is no map vote or rotation.
- Recorded audio (everything is synthesised).


## Running it

```bash
npm install
```

```bash
npm run dev
```

This starts the game server (ws://localhost:8080) and the web client (http://localhost:5173). Each browser tab is a player. The first to join is a ghost, the second a defender, alternating.

- `npm run bot` adds a scripted player (walks in, then strafes). `npm run bot -- --shoot` makes it hold fire; add `--pistol` to make it hold the pistol (one tap every 12 commands) and `--aim` to make it aim down sights. To play as a defender alone, start the bot before opening the page.
- `npm run bot -- --map warehouse --room test --still` (the map only matters if the bot creates the room). Bots press ready on joining and again whenever a room falls back to warmup; `--unready` stops that.
- URL options: `?auto=1` skips the menu and the lobby panel (and `?quiet=1` only the pause menu, click hint and lobby panel: for scripted runs), `?name=`, `?room=`, `?map=` (`warehouse`, `greybox`), `?lag=150` (simulated round-trip latency), `?res=0.7` (pin render resolution), `?server=ws://host:port`.
- Keys: WASD move, mouse look, left click attack (F also attacks, useful without pointer lock), right mouse held aims down sights (defenders; Z also aims, useful without pointer lock), 1 rifle, 2 pistol, Q previous weapon, mouse wheel cycles weapons, R reload, E plant or defuse, Tab scoreboard, Space jump, Shift quiet walk, C crouch, Enter all chat, Y team chat, Esc pause menu (Esc cancels chat), left/right arrows follow another teammate when dead, and in warmup G ready, U start (room creator), M switch team, L open the lobby panel. Chat, the pause menu and every panel suspend the weapon keys, mouse buttons and wheel.
- `npm test`, `npm run typecheck`, `npm run build`.
- In the browser console, `window.__sb` exposes `app`, `state`, `loadout`, `knife`, `input`, `net`, `match`, `mapData`, `presenter`, `audio` and `stats()` (`stats().gunMismatches` counts snapshots where the replayed weapon state, any field of the loadout, differed from the prediction; `stats().knifeMismatches` the same for the knife; both should stay 0. `stats().loadout` copies the whole loadout, `stats().gun` the weapon in hand).
- `npm run bot -- --shoot` fires 10-round bursts, pauses, and presses R between bursts when under 12 rounds (5 with `--pistol`); it logs when it runs out of ammunition (until its next spawn).

## How it is put together

| Path | What it is |
|---|---|
| `shared/` | Code run by both client and server. `movement.ts` + `collision.ts`: deterministic box-hull movement. `weapons.ts`: the table of every defender weapon's numbers. `gun.ts`: the loadout (switching, aim, trigger edge) and each weapon's ammunition, reload, recoil pattern and spread. `knife.ts`: knife windup and cooldown. `rules.ts`: round phases, timings, plant/defuse eligibility. `visibility.ts`: ghost visibility curve. `protocol.ts`: message types and the binary wire format. `constants.ts`: every tuning number. |
| `server/src/game.ts` | The authoritative match. No socket code, so it is tested directly (`game.test.ts`). |
| `server/src/main.ts` | WebSocket transport, rooms, rate limits, `/health`. |
| `client/src/main.ts` | Game loop: fixed 60 Hz simulation, prediction and reconciliation, menu, adaptive resolution. |
| `client/src/net.ts` | Connection, clock estimate, interpolation of other players. |
| `client/src/presenter.ts` | Everything visual except the map: HUD, viewmodel, tracers, bomb. Implements `presenter-api.ts`. |
| `client/src/characters.ts`, `weapons.ts` | Animated player models and weapon attachment. |
| `client/src/audio.ts` | Synthesised spatial audio. Implements `audio-api.ts`. |
| `client/src/maplook.ts` | Map shader (albedo × baked light) and sky. |
| `tools/blender/` | Headless Blender scripts that generate the shipped assets. Maps: `mapkit.py` (definitions and verification, plain Python), `mapbuilder.py` (Blender side), `build_map.py` (entry), `maps/<id>.py` (one per map), `mapplan.py` (plan images). |
| `server/src/rooms.ts`, `maps.ts` | Room registry (one map per room) and map loading. |
| `DEPLOY.md`, `Dockerfile`, `deploy/`, `.github/workflows/` | Deployment, untested. |

### Rules that keep it working

- **Client and server must simulate identically.** Movement, the movement lock and attack timing live in `shared/` and are counted in commands the server actually processed for that player, not wall-clock time and never by comparing the client-chosen `seq` (a modified client can skip ahead in `seq`; `seq` only orders commands and acknowledges them, and must not be made strictly consecutive, because commands dropped for lack of credits are never acknowledged). Change a rule in one place and both sides follow; never reimplement one on only one side.
- **The wire format must be exact for anything the client predicts with.** The local player's state travels as float64, and the client rounds its view angles with `Math.fround` before using them. Breaking this makes prediction drift. The loadout (slot, previous slot, draw ticks left, aim ticks, trigger edge, and per weapon: magazine, reserve, reload ticks left, cooldown, burst index, commands since the last shot, shot count) travels as one byte each, so every counter in `shared/weapons.ts` must stay at or below 255 (a test checks every weapon). The binary command carries the weapon request: a slot byte, and Q and aim bits.
- **The loadout is stepped by `stepLoadout` on every command a living defender simulates**, on the server and in the client's prediction and replay; the client keeps per-command `live`/`armed` flags so the replay steps exactly what was predicted. It handles the weapon request, the draw timer, aim progress and the trigger edge, then steps every weapon with `stepGun` (the ones not in hand with no input, so their recoil still recovers). Semi-automatic fire uses `LoadoutState.trigger`, set when the trigger did something and cleared on release: stepped state, never wall-clock input. Spread comes from an integer hash of the weapon's shot count (`GunState.shots`, one byte, wrapping, reset at spawn) plus 256 times the slot, and the shooter id, never `Math.random` or `seq`. Aim scales spread and recoil inside `shotDirectionFor`, which both sides call. `server/src/prediction.test.ts` must keep passing after any change to these rules or the wire format. The ghost knife works the same way: `stepKnife` (`shared/knife.ts`) counts the windup and cooldown per processed command, the snapshot carries both counters exactly, and the client replays them (`stats().knifeMismatches` should stay 0). Recoil is drawn as an offset added to the camera on top of the view angles; it is never written into `input.yaw`/`input.pitch`, so commands keep carrying the player's own aim and the server adds the same pattern.
- **Collision is axis-aligned boxes only.** Anything a player can stand on, hide behind or be blocked by must be a box in the map's definition (`tools/blender/maps/<id>.py`). Ramps, round or rotated solids need new collision code first.
- **Maps are generated, not hand-edited.** Each map is a definition file in `tools/blender/maps/` (data only) built by the shared builder: `npm run map -- <id>` (`greybox` = Test Map 1, about 2.5 minutes; `warehouse`, about 6 minutes; the Cycles bake uses the GPU, OptiX then CUDA, else CPU). `--no-bake` reuses the lightmap, `--verify-only` runs only the checks. It rewrites `<id>.glb`, `<id>.json`, `<id>_baked.webp`, the shared textures and `maps/index.json`. Visual-only boxes (pipes, shelving, vehicles) need no collision; a collision box can be drawn only by the visual boxes inside it (`hide=("all",)`).
- **The build fails if a map fails verification** (`tools/blender/mapkit.py`, also `python tools/blender/mapkit.py <id>` without Blender): duplicate names, stair rises, treads and widths, every flight climbable on foot from its bottom step, walkway gaps (solids touch or leave 1.4 m), a walk/step/jump flood fill over the boxes (every spawn and site reachable, no reachable spot that cannot get back to the ghost spawn, 2.0 m headroom everywhere reachable, visual-only boxes clear of player space), no ghost spawn eye point seeing a defender spawn eye point, and per map the longest eye-to-eye sightline (`max_sightline`) and distinct routes to each site (`route_gates`). It prints path lengths from each spawn to each site.
- **A stair can only be entered from its bottom end.** From the side, the 0.6 m hull spans two 0.4 m treads, more than the 0.35 m step height. Keep open floor in front of every first step; the verifier checks this.
- **Rooms choose the map.** The server loads every map JSON in `client/public/maps/` at start; the first player's `map` query picks a new room's map (default `DEFAULT_MAP` in `shared/maps.ts`, `SB_DEFAULT_MAP` overrides); everyone is told the room's map in `welcome` and the client loads it before simulating. Room logic lives in `server/src/rooms.ts`, without socket code.
- **Never send a defender a ghost it cannot perceive.** `Game.knowsAbout` in `server/src/game.ts` is the anti-wallhack rule: a ghost is sent only if in line of sight with visibility above 0.01, or within breathing range (8 m). Sound events are sent only within earshot.
- **Presenter and audio are behind fixed interfaces** (`presenter-api.ts`, `audio-api.ts`) and never touch game or network state. Change the interface file first, then both sides.
- **Performance budget:** world at most 8 draw calls, unlit, 2 texture reads per pixel; at most 2 draw calls per armed player; no realtime shadows or post-processing; no per-frame allocations in `frame()` paths.

### Tuning numbers worth knowing (`shared/constants.ts`, `shared/rules.ts`)

- Speeds: run 5.2 m/s, quiet walk 2.6, crouch 2.0; jump clears a 1 m crate.
- Ghost visibility: 0 still, about 0.10 crouch-walking, 0.17 walking, 0.35 running; spikes to 0.6 on a swing or while planting, 0.8 when hit.
- Weapons (`shared/weapons.ts`; every defender spawns with both, full, every round, rifle in hand; no buying or pickups; ghosts keep only the knife):

  | | Rifle (slot 1) | Pistol (slot 2) |
  |---|---|---|
  | Fire | automatic, 10 per second (6 commands) | semi-automatic: one shot per press, at most one per 150 ms (9 commands) |
  | Damage body / head | 34 / 100 | 26 / 100 |
  | Magazine + reserve | 30 + 90 | 12 + 36 |
  | Reload | 2.2 s (132 commands) | 1.4 s (84 commands) |
  | Draw (switching to it) | 0.4 s (24 commands) | 0.25 s (15 commands) |
  | Spread still / crouched / added at full run / air (rad) | 0.004 / 0.002 / 0.035 / 0.06 | 0.003 / 0.0015 / 0.02 / 0.05 |
  | Recoil | 30-row pattern climbing to 4.75 degrees, then right, left, right; recovers from 9 commands after the last shot, a row every 2 | 12-row pattern, 0.85 degrees on the second shot climbing to 4.1; recovers from 10 commands after the last shot, a row every command (measured taps stay on target, spamming climbs) |
  | Aim down sights | 1.5x zoom, 12 commands in or out, spread x0.5, recoil x0.8 | 1.2x zoom, 8 commands, spread x0.6, recoil x0.85 |

  Reload starts on R with a partial magazine and some reserve, or by firing on empty; firing is blocked meanwhile; switching weapon, death and round reset cancel it (a cancelled reload gives nothing), movement does not. Nothing fires or reloads during a draw. Aiming needs the weapon drawn and not reloading, does not change movement speed, and slows mouse look by the zoom. Empty with no reserve: a dry click at most every 15 commands. Reload sound carries 10 m and says which weapon. Knife: 0.2 s windup, 2 m reach, 55 front, 100 from behind.
- Footsteps carry 18 m running, about 5 m walking, about 3 m crouched. Breathing 8 m.
- Round: 4 s freeze, 120 s live, 35 s bomb, 3 s to plant, 5 s to defuse, first to 6, sides swap after round 5.

## Assets and licences

All third-party art is CC0. Maps: textures and sky from Poly Haven, listed in `client/public/maps/CREDITS.md`. Models: Quaternius "SWAT" character and the SMG and knife from "Character Soldier", via poly.pizza, listed in `client/public/models/CREDITS.md`. Raw downloads live in the git-ignored `tools/blender/source-art/`; the Blender scripts fall back to the shipped files if it is missing, but rebuilding characters or weapons from source needs those files present.

## Working preferences from this project

- The owner asked that the main session plan and write correctness-critical code itself (shared simulation, server rules, netcode), and hand self-contained pieces (art, Blender scripts, HUD, audio, packaging) to Opus subagents with a precise written brief, to conserve usage.
- Pushing to `main` on GitHub has been the norm after each finished piece of work.
- Downloads were approved for CC0 art from Poly Haven, ambientCG, Quaternius, Kenney and KayKit, with every file recorded in a `CREDITS.md`.
- Accounts, sign-ins and anything paid are the owner's to do.

## Maps

| Map | Id | Levels | Spawn to site paths (walking, A / B) | Download | Bake |
|---|---|---|---|---|---|
| Test Map 1 | `greybox` | 1, open air | ghosts 30.6 / 30.5 m, defenders 11.0 / 10.8 m | 1.2 MB | 3072², 1024 samples, 150 s |
| Warehouse | `warehouse` | basement car park and plant room (site A); ground loading bay, racks, offices, lobby (site B); mezzanine and catwalk | ghosts 38.6 / 39.3 m, defenders 14.8 / 15.4 m | 2.9 MB | 3072², 1024 samples, 365 s |

Warehouse routes from the ghost spawn: to A through the yard stair and service corridors (tight), the loading-bay stair and car park (long sightlines), or the office stair; to B through the rack aisles (tight), the main aisle, the offices, lobby, mezzanine and catwalk drop, or back up from the basement. The verifier proves each is a separate way in. The original map's bake took 333 s on CPU at 2048² / 256 samples; the same settings take 19 s on the RTX 4060.

## Suggested order of work

1. Playtest with a second person, headphones on, and note what feels wrong (items 1–4 under "Never verified"). Try Warehouse: it is now the default map.
2. Check frame rate on Warehouse on an integrated GPU.
3. Tune from the playtest: audio direction, ghost visibility, plant and defuse times.
4. Check frame rate on an Intel UHD or AMD Vega laptop.
5. Deploy by following `DEPLOY.md`, starting with a local `docker build`.
