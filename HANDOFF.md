# Stillblade — handoff

## Current playtest release

The 12 role-specific workflows are under `.agents/skills` and exposed to Claude under `.claude/skills`. The playtest release pairs protocol 18 client and server builds. The former protocol 17 deployment notes below are historical. Check [DEPLOY.md](DEPLOY.md#releasing-a-clientserver-protocol-change) before merging or deploying a protocol update.

The owner has paused the lab, accounts and leaderboard, grenades and pistol animation replacement. The next map awaits the owner's drawing.

- Joins to unknown codes return a recovery screen. Creating a room sends a separate intent. The client and server reject mismatched protocol versions before match messages are exchanged.
- The browser uses the saved audio volume on the first menu action. Settings include reduced weapon motion and combat flashes. The practice spawn faces a stationary target on both maps for both teams.
- Spectators receive cues from the server-approved teammate camera. Melee uses historical facing, warmup commands from the prior life cannot move a new player, and weapons stop firing after a round result. Check old recordings against their original commit if corrected combat rules change replay results.
- Carriers prioritize planting. Recovery compares walkable routes between floors. The audit bot runs improved from four to seven total plants, including a Warehouse B plant. Defenders still won all 22 rounds. Human faction balance remains open.
- Recordings are made available once complete. The pull tool verifies gzip and repairs broken copies. Server health reports persistence separately, and expiry also runs while idle. `matchstats.ts` separates human, mixed and bot-only rounds by map.
- The demo knife swings from package V were replaced by synthesized swishes. The licensed impact samples are still used. Source links and attribution are in the asset credits.
- See [the friends playtest](docs/playtest.md) for headphones and integrated graphics, and `?perf=1` for opt-in frame-time capture. The production smoke command compares `/version.json` with server health and connects to an isolated practice room.

Last rewritten 2026-11-15; **status updated 2026-11-19: everything is on `main`, pushed and deployed, protocol 17 (packages A to H, L, M parts 1 and 2, N, O with three follow-ups, P, Q, R with the pack hands), 502 tests, typecheck clean, the game server restarted on protocol 17. Landed 2026-11-19: package Q (visual and feel polish: 4x anti-aliasing on both tiers, players and the gun lit by probes of each map's baked light, metal reflections, weapon bob, look inertia, jump and landing, crouch tilt, spring recoil, a vignette on High) and package R (the owner's downloaded M4 pack's motion on our AK, a 2.7 s empty reload with the AK's charging handle, protocol 17, and the pack's gloved hands on all three rigs). See "Package Q" and "Package R" at the end. Landed later 2026-11-19: package S (a loading screen with real progress, step list, stall note and Try again; 523 tests); the defender's first-person sleeve is now the third-person shirt's own sleeve with folds (still plain; a matched arms pack is the real fix). **Package T (the M4 everywhere) built 2026-11-20, reviewed, merged into `main` and pushed 2026-11-20 on the owner's word; review: tests and typecheck on the branch and on merged `main`, the client diffs read line by line, `git diff main -- shared server` empty, 8 screenshots looked at; reviewer's note: the bare forearms read smooth, pale and plastic and lighter than the soldier's skin (the owner chose to merge as is): the rifle is the M4 from the owner's pack in both views, first person using that pack's own arms, gun and clips as authored, the bolt held open on an empty magazine, our sights on the M4's rail, the AK-105 retired; no protocol change (see "Package T" at the end). Pistol and knife on hold; the knife since built as package V part 1 (2026-11-20, branch `claude/knife-pack-d7d621`, not merged; see "Package V part 1" at the end), the pistol still on hold.** Paused: the character lab page (package U, `/v2_character`, branch `claude/character-lab`, groundwork only; see `docs/review/lab/STATUS.md` there) until the owner has new assets. Open: the cost of 4x anti-aliasing on integrated graphics is unmeasured (compare `?tier=low` with `?tier=low&aa=0`); armor balance and all new motion are untested in real matches.** The live site rebuilds from `main` on every push; the game server runs on the owner's PC behind a Cloudflare Tunnel and must run a `main` with the same protocol as the site. **Nothing from waves 3 to 6 has been played with a mouse, seen on a real GPU or listened to**: animations and models were judged from Blender renders and headless Chrome (software GL) screenshots, sounds from measured levels. Older sections below describe each package as it was when built, so some numbers in them (test counts, protocol versions, "not on `main`") are historical; **"What to do next" near the end is the current summary, read it first.** The owner's live server holds port 8080 on his PC, so `npm run dev` needs that server stopped first.

**If you are a new session:** this file tells you what exists, what has and has not been verified, the rules that must not be broken, and how the owner wants work done. `ROADMAP.md` tells you what to build next and what is already decided. Read both before changing anything. `DEPLOY.md` covers hosting. You need nothing else: no memory files or earlier conversations are assumed.

## What the game is

Stillblade is a browser tactical FPS that must run on low-end laptops. Two teams, round-based, first to 6, sides swap after round 5.

- **Ghosts** are invisible while still and shimmer when moving. They carry only a knife and must plant a bomb at one of two sites.
- **Defenders** are visible, carry a rifle and a pistol, and find ghosts mainly by sound (footsteps, breathing within 8 m).

Built with the PlayCanvas engine as a library, TypeScript and Vite on the client, and an authoritative Node WebSocket server. The client predicts its own player and the server decides everything.

## Where things stand

The game is playable end to end and, since 2026-11-15, **live for testing** at `https://stillblade.orcavalley.com`, with the game server running on the owner's PC behind a Cloudflare Tunnel (see Hosting; it is only up while that PC runs the server). It has **never been played by a person with a mouse**: every check was automated tests, or a browser driven by script against a scripted bot. The owner has not yet played it, and the friends test has not happened.

### What exists

- **Core:** movement and collision, client prediction and reconciliation, lag compensation up to 300 ms, a binary wire format (protocol version 14), anti-wallhack information culling, rooms with room options.
- **Combat:** rifle (automatic) and pistol (semi-automatic) with magazines, reloads, a fixed recoil pattern each, deterministic spread, switching (1, 2, 3, Q, mouse wheel) and aim down sights; a defender knife in slot 3 (weaker than the ghosts'); the ghost knife with a backstab; body-part damage (head, torso, arms, legs); a per-room "suppressed weapons" option (off by default: loud gunshots heard to 60 m, a large muzzle flash, no suppressors on the models).
- **Round and match:** freeze, live, bomb plant and defuse, halftime swap, match to 6, a result card with per-player stats and a most valuable player, automatic rematch, a 60 s hold when a team disconnects.
- **Rooms:** create or join by code, copy invite link, quick play into a public room, a lobby with ready and a creator start, team balance and switching, map chosen per room.
- **Maps:** Warehouse (three levels, the default) and Test Map 1, both generated by Blender scripts with baked lighting.
- **Client utilities (package B, protocol 10):** every key and mouse button is rebindable (Settings, Controls section), hold or toggle for crouch, quiet walk and aim, an aim sensitivity slider, a phone notice, a feedback button and automatic error reports. Details in "Client utilities" below.
- **HUD and menus:** health, ammunition, alive counters, timers, radar (own team only), kill feed, hit markers, damage direction, death recap, scoreboard, text chat (all and team), spectating teammates, pause menu, settings, controls page, loading and error screens.
- **Presentation:** animated third-person characters with weapons, first-person arms and hands holding every weapon with real reloads and knife swings (package F), synthesised spatial audio.

### Verified

- **415 automated tests pass on `main`** (`npm test`; 201 when this list was written, the rest came with packages A to H and L), and `npm run typecheck` is clean. They cover movement and collision, the wire format, gun, loadout and knife rules (including the defender knife slot: timing, Q and wheel-style switching, a windup cancelled by switching, unarmed hold, reset and copy), hit zones standing and crouched at every boundary, room options, rooms and map loading, server combat (damage by zone, the defender knife front and back with its windup sound and lag compensation, lag compensation, visibility, information culling, footsteps, who receives a gunshot at 10, 30 and 70 m with and without line of sight in both room modes), rounds, bomb, halftime, match end, the lobby, chat rules, the idle rule, the disconnect hold and stat restore, and that a client jumping its command numbers gains nothing (guns and knife).
- **`server/src/prediction.test.ts`** plays a simulated client that predicts exactly like `client/src/main.ts` against the real server through the binary format at 150 ms round trip for two minutes of random firing, knife swings, switching between all three slots, aiming and reloading: zero weapon, knife or position disagreements. It must keep passing after any change to shared rules or the wire format.
- **In a scripted browser against bots, on both maps, at `?lag=150`:** prediction error 0 and weapon and knife mismatches 0 (`window.__sb.stats()`) through automatic fire, reloads, pistol taps, switching and aiming; the HUD ammunition matched the server; chat and the pause menu suspended the weapon keys. Re-run for package A on 2026-11-16 (Warehouse and Test Map 1, `?lag=150`, frames driven by a Worker clock because the pane was hidden): drawing the knife with 3, holding the attack for repeated swings, a rifle burst and reload, pistol taps with aim and reload, Q both ways, three mouse-wheel steps through all three slots, a knife windup cancelled by switching, aiming then switching to the knife (aim dropped to 0), and on Test Map 1 also swinging and firing while moving: `error` 0, `gunMismatches` 0 and `knifeMismatches` 0 throughout.
- **One complete real match per map** (120 s rounds, first to 6, halftime swap) reached the result card and the rematch, with one scripted client against a bot that did not fight, so every stat on the card was zero.
- **Maps:** both build from their definitions and pass the automatic layout checks; every Warehouse staircase was walked with keyboard input, both sites reached, and a live plant made on each map.
- **Server cost:** a ten-player room takes about 0.06 ms per tick on Test Map 1 and 0.2 ms on Warehouse (`npx tsx tools/bench.ts <map>`).
- **Server image layout:** the built server starts and lists both maps when run from the image's file layout outside Docker (see Hosting).

### Never verified — test these first

1. **Mouse aiming, movement and weapon feel.** Automation cannot capture the pointer; all input was keyboard events. Recoil, the pistol's kick, aim-down-sights zoom, switch times, mouse wheel and right mouse are untested by hand. All numbers are as designed and untuned.
2. **Audio by ear.** Every sound is synthesised in `client/src/audio.ts`. Levels, direction and wall muffling were measured, never listened to. Footsteps measured as only weakly directional. Whether a defender can locate a ghost by sound is the core of the game and is unknown.
3. **Ghost shimmer in a real match.** Whether a running ghost at 35% visibility is fair to spot against the textured maps is unknown.
4. **Damage direction, death recap and spectating from real events.** Their screenshots were staged by calling the display code; the server messages are tested, the path from a real hit to the screen is not. (The hit marker and kill feed were seen from real hits in package A: a leg hit and a headshot kill.)
5. **A live defuse**, and a match where players actually fight (stats on the result card have only ever been zeros).
6. **Frame rate on integrated graphics**, especially Warehouse (30 k vertices, a 3072² lightmap). The adaptive-resolution step-down has never triggered in a real slow case.
7. **Animation in motion.** Reload, switch, aim and character animations were judged from still frames. Package F's hands, reloads, knife swings, pistol pose, crouch lean and body placement were judged only from Blender renders (`docs/review/animations/`), never in the running game.
8. **Package A by hand and by ear:** the loud unsuppressed gunshots (synthesised, never listened to), how far they carry, the muzzle flash in motion, the defender knife's feel (draw, swing, reach), whether limb damage feels fair, and the hit marker's limb look in play. Zone sizes and multipliers are starting values, untuned.
9. **The always-on deployment.** Docker, Caddy and the VPS route have never been run. The tunnel route is live (see Hosting), but **ping through it is unmeasured**: a throttled test browser on the owner's own PC reported about 320 ms, which is probably inflated; check it with "Show FPS and ping" in settings, from the owner's screen and a friend's. Whether `SB_TRUST_PROXY` is set on the running server is also unconfirmed (it only shows when a seventh player connects).
10. **Pointer lock flows:** Esc to pause, mouse release for chat, the clipboard copy of the invite link, the automatic reconnect.
11. **Client utilities by hand (package B):** rebinding with a real mouse side button (only synthetic events were used), the clipboard copy in the phone notice, a real phone (only the browser pane's mobile emulation was used), the feedback box with an on-screen keyboard, and the HUD "R RELOAD" and "Hold E" hints after a rebinding (read in code, not seen). A real person using the bindings in a match.

## Match flow, HUD and menus in detail

**Server (all JSON, nothing predicted).** `Game` takes `{ lobby: true }` (set by `Rooms`; tests and `tools/bench.ts` leave it off, which keeps the old "start as soon as both teams have a player" behaviour).
- Lobby: a room starts in warmup (everyone walks around and respawns). The round machine leaves warmup when every connected player is `ready` **or** the creator sent `start`, and both teams have a (non-idle) player. Ready flags reset when a round starts and when a match falls back to warmup.
- Held matches: when a team empties mid-match (a disconnect in a 1 v 1) the room falls back to warmup but **keeps score, round count, sides and statistics for `GRACE_MS` = 60 s** (`Game.held`). If both teams have a player again within it the next round starts by itself with no ready-up (the interrupted round is replayed under the same number); after it the match is reset and the room is a fresh lobby. Kills made in that warmup do not count. A player who leaves mid-match is remembered by cleaned name for the same 60 s: rejoining under that name gives back their statistics and side, unless two leavers shared the name or a player with that name is already connected (then nothing is restored). A held match that is not resumed is wiped; finishing a match never holds.
- Creator = longest-connected player (`Game.creatorId`, derived from `joinedAt`, so it passes on by itself when they leave).
- Teams: a new player joins the smaller team (ghosts on a tie). In warmup `{type:'team'}` switches, refused if the teams would then differ by more than one (`MAX_TEAM_GAP`) and refused outside warmup.
- Statistics (`MatchStats` in `shared/protocol.ts`, carried on every `RosterEntry`): kills, deaths, assists (damage within `ASSIST_MS` = 4 s before someone else's kill), headshots (headshot hits), backstabs, damage (health actually removed, plus armor removed since package P), plants, defuses. Reset when a match starts. The roster is re-sent on every kill, round start and round end.
- Match end: the round that reaches 6 sends `summary` (winner, score, every player's stats, `mvp`, `nextAt`) once, holds the result `MATCH_OVER_MS` = 20 s, then starts a fresh match: same room, same map, score and stats zeroed, **players keep their group** (the side they started on, so the roles reset to the first-half roles, not to what they played last). Players joining during the result screen get the stored `summary`, are not spawned, and join the new match. MVP score is documented in `shared/stats.ts` (`mvpScore`).
- Chat (`{type:'chat', team, text}`): `cleanChat` (`shared/chat.ts`) strips control characters, collapses whitespace and caps at 120 characters; 4 lines burst, one more per 1.5 s, extra lines dropped with a `notice`. While a round is on (freeze, live, planted) a dead player's line (a mid-round joiner counts as dead) reaches **only dead players**; team chat reaches only the sender's team; between rounds and in warmup everyone hears everyone.
- Idle: nobody is ever removed mid-round (a ghost standing perfectly still is playing correctly). A player who took part in a round (`inRound`, spawned for it) and produced no input change at all from its freeze to its end (`changedThisRound`; movement, view angles, buttons, weapon slot, swap, aim; not `seq` or `viewTime`) for `IDLE_ROUNDS` = 2 rounds in a row is marked `idle` when the second round ends, told by `notice`, and is not spawned at the next round start (idle players do not hold a team up, so a team that is all idle falls back to warmup and is held). Any input change clears the flag, and they spawn at the following round start. Players who joined mid-round do not count that round.
- Damage events: `dmg` goes to the victim with `dir` (world bearing toward the attacker, yaw convention), `amount`, `kind` (`shot`, `knife`, `backstab`) and, for a shot, `zone` (`head`, `torso`, `arms`, `legs`) and `weapon`; the killing blow adds `by` and `dist`. `hitconfirm` (`kind`, `zone` for shots, `kill`) goes to the attacker. There is no `headshot` kind any more: a headshot is a shot with zone `head` (one source of truth), and the `headshots` statistic counts exactly those. A ghost that stabs a defender is within 2 m, inside the 8 m breathing range, so this adds nothing `knowsAbout` forbids; tests check the keys and that no `pos` appears.
- Kill feed: every kill is broadcast to the whole room as `kill` (`killer`, `victim`, `kind`, `weapon`, `zone`; never a position; the roster already tells everyone who is alive). The client's feed uses only this message, so it no longer depends on who received the shot or slash.
- Shot events (`shot`): a gunshot is a sound. Sent to the shooter, the player hit, and everyone within `GUNSHOT_RANGE` (60 m; `GUNSHOT_RANGE_SUPPRESSED`, 20 m, in a suppressed room); beyond that only to players whose eye has a clear line to the shooter's eye, flagged `silent` (drawn, no sound); otherwise not at all. Slash events: heard within 14 m as before; who was hit (`victim`, `damage`, `backstab`, `killed`) goes only to the two players involved and to those `knowsAbout` the victim, so a defender's knife hit never points a ghost out to other defenders (a ghost's victim is a defender, known to everyone, so ghost slashes are unchanged).
- Client JSON messages are routed by `Game.handleMessage` (text frames; `maxPayload` was raised from 256 to 1024 bytes for chat).

**Room options** (`shared/room-options.ts`, `RoomOptions`): chosen by whoever creates the room, read from the join query (`suppressed=1`) by `parseRoomOptions` only when the room is created (`Rooms.join`), kept on `Game.options`, sent in `welcome.options`. A later joiner's query cannot change them. The menu's "Create room" form has a "Suppressed weapons" checkbox (off); Join and Quick play send no options. The lobby panel shows the option read-only next to the map name. Package D adds more fields here.

**Client.** `client/src/ui.ts` + `ui.css`: menu (create, join, quick play, how-to shown once), loading screen, connection error screens, lobby panel, pause, settings, controls, result card, chat. `settings.ts` stores settings in `localStorage` (`sb-settings`) and notifies listeners; `radar.ts` is the radar; HUD additions (alive pips, bomb and round timer, damage direction, low-health pulse, death recap, spectating label, custom crosshair) are in `presenter.ts` behind `presenter-api.ts`. The death recap and kill feed name the weapon (`dmg.weapon` and the shot event's `weapon`). Hit marker sound and volume controls are in `audio.ts` behind `audio-api.ts`. In `main.ts`: join flow and connection handling, the settings subscription, the spectator camera and radar update.
- Pause: whenever pointer lock is lost with nothing else open (Esc) the pause menu opens and the match keeps running. The mouse is released while typing chat so Esc reaches the chat box.
- Spectating uses only what a dead player is already sent: teammates (always in snapshots, with yaw and pitch), followed in first person; with no living teammate the camera shows the whole map from above (this only lasts through the round-over pause or a planted bomb, since a round ends when the last ghost or defender dies).
- Reconnect: a connection that drops after joining reloads the page once with the room, name and map remembered in `sessionStorage` (`sb-rejoin`); if that fails the error screen has a retry button. Settings survive in `localStorage`.
- Radar: north-up, 24 m radius, boxes of the current floor, own team only, sites, and the planted bomb. It is never given enemies.

**Match flow: gaps (what was and was not checked).** Checked in headless Chrome (driven over the DevTools protocol, software GL) against bots: menu, join by code, lobby panel with ready, chat, HUD in a live round, Tab scoreboard, pause, settings, controls, loading and error screens (server unreachable, unknown map, too many connections); **a complete real match (120 s rounds, first to 6, halftime swap) to the result card and into the rematch on both maps** (about 24 minutes each, a human client against a bot, so the score and statistics were all zeros apart from rounds won; screenshots `wh_result.jpg`, `gb_result.jpg`, `*_rematch.jpg`); at `?lag=150` with the merged weapons: switching with 2 and 1, aiming, a pistol shot, a reload, with chat open and with the pause menu open (weapon keys did nothing in either), ending with `error` 0, `gunMismatches` 0 and `knifeMismatches` 0; and the map overview. The unit tests cover the 90 s of a live round, two quiet rounds, the grace period, restores and chat rules (`server/src/matchflow.test.ts`). Screenshots: `docs/review/match-flow/`.
- **Staged screenshots, not real events:** `damage_direction.jpg` and `hitmarker_headshot.jpg` (widgets called through `__sb.presenter`), `death_recap_weapon.jpg` (the recap line called through the presenter while alive), and `spectate_follow.jpg` / `spectate_overview.jpg` (taken before the idle rule changed, when a still player was moved to spectate; the camera code has not changed since, but the follow view was not re-shot after the weapons merge). Earlier result screenshots that showed 1:2 came from a scratch server with shortened rules edited in temporarily and reverted; no override is in the code.
- **Never seen with real input:** pointer lock (Esc to pause, mouse released for chat and re-captured after), copy invite link (clipboard), the death recap and hit marker from real hits (server events are tested, the client wiring only by reading), the hit sound and the volume sliders by ear, the automatic reconnect after a dropped connection, "Room full" in a browser (local connections hit the per-IP limit first; `rooms.test.ts` covers the rule) and a person playing a long match. (Several earlier headless runs dropped off the server with the machine under heavy load; a lone run held for 24 minutes. The client now logs the close code and the server logs it on leave.)
- Graphics quality now picks the graphics tier (Auto, Low, High; package G) and no longer caps the resolution; the adaptive resolution step runs in both tiers.
- Radar: built from the collision boxes (floors within 0.45 m of the player's feet, solids that block a standing player). It was seen on both maps; multi-floor behaviour on Warehouse stairs was not checked.
- A mid-round joiner counts as dead for chat purposes until the next round.
- Dead players keep seeing enemy ghosts from the spot where they died (existing `knowsAbout` behaviour, unchanged); a spectator does not see through the teammate's eyes for that.
- The old banner still shows "MATCH OVER" under the result card; the card is opaque enough to cover it.

## Client utilities (package B)

Package B, protocol 10 (package A is protocol 9).

- **Bindings.** `client/src/bindings.ts` holds one table, `ACTIONS` (id, label, group, defaults as primary plus optional secondary, context), and pure functions: load and validate (`parseBindings`, each action falls back to its default on bad data), conflicts (`conflictsWith`, `findConflicts`), `assignBinding` (the new binding wins and the other action takes the input the slot held, a swap), display text (`inputLabel`: "Left Shift", "Mouse 4", "G"). **Adding an action is one row.** Package C adds "Drop bomb" (context `round`, default G) as one row; weapon slots 1 to 3 are rows, so package A's key 3 works. Inputs are `KeyboardEvent.code` strings or `Mouse0` to `Mouse4`; Esc is never bindable and the wheel is fixed to weapon cycling. Stored in `localStorage` key `sb-bindings` (separate from `sb-settings`, so "Reset to defaults" in settings does not touch keys; "Reset controls to defaults" does). `bindings()` is the one shared store; `Input`, `Ui`, `main.ts` (spectate keys) and the HUD (`presenter.ts`) read it. `BindingsStore.version` rises on every change so cached HUD text refreshes.
- **Contexts.** `any` (always), `lobby` (warmup only), `round` (outside warmup). Two actions conflict on a shared input only if their contexts can be active together, so G can be both Ready (lobby) and Drop bomb (round). Defaults: W A S D, Space, Left Shift (quiet walk), C and Left Ctrl (crouch), Left Mouse and F (attack), Right Mouse and Z (aim), R, E, Q (previous weapon), 1 to 3, Tab, Enter and Y (chat), Left and Right arrows (follow teammate), G U M L (lobby). Secondary defaults exist for scripted tests (F, Z, Ctrl).
- **Input.** `Input` keeps its public shape (`sample`, `sampleWeapons`, `fire`, `use`, `reload`, `aim`, `scores`, `suspended`, `releaseAll`, float32 yaw). It resolves bindings when they change and keeps pressed inputs in one set; nothing is allocated per tick. Hold or toggle (settings `crouchToggle`, `walkToggle`, `aimToggle`) is input-side only: the toggled state lives in `Input`, is cleared by `releaseAll` (every menu or chat opening) and by `input.clearToggles()` in the `spawn` handler of `main.ts`; the command carries only the resulting `crouch`, `walk`, `aim` bits. `aimSensitivity` (0.25 to 2, default 1) multiplies mouse look while `Input.aim` is true, on top of `lookScale`. Mouse buttons count only while the pointer is captured (as before); the side buttons and middle button have their default browser action suppressed while captured. Mouse binding of lobby and chat actions works only while the pointer is captured; the lobby panel itself takes keys.
- **Rebinding UI** (`ui.ts`): click a column (main or second key), press a key or mouse button; Esc cancels, Backspace or Delete clears the second column; a left click on any button cancels the wait. While waiting, `onCaptureKey` and `onCaptureMouse` run in the capture phase and stop propagation, so the game and menus never see the press. A conflict flags both rows and asks "Use it here" or "Cancel"; confirming swaps. Hints (lobby buttons and strip, controls page, how-to "Keys" line, HUD "Hold E" and "R RELOAD") read the live bindings. "Click to play" has no key in it.
- **Phone notice** (`client/src/phone.ts`): when `(pointer: coarse)` and `(hover: none)` both match, a full-screen message with "Copy page link" (clipboard, else selects a text field) and a small "Continue anyway" replaces startup; `app.start()` and `start()` run only after it. `?desktop=1` skips it. The Application and WebGL context are still created at page load; no map, model, socket or `maps/index.json` request is made until the player continues.
- **Reports.** One new client message `{type:'report', kind:'feedback'|'error', text, stack?, ctx}` (JSON text frame; `decodeClient` checks the shape, the server cleans). Caps in `shared/protocol.ts`: note 500 characters, error 300, stack 1500, user agent and GPU 200, path 100 (counted in characters). `shared/report.ts` has the cleaning and `buildReport`, which also cuts to fit 4096 bytes so an oversize frame can never close the connection (`maxPayload` is now 4096; non-report JSON is still limited to 600 characters). Context the client sends: frame rate, render scale, ping, user agent, GPU string (`WEBGL_debug_renderer_info`), page path without query. The server adds and trusts only its own room, map, team, player id, name, protocol version and time; a name or chat text in a report is never copied. Line breaks survive in notes and stacks; every other control character is stripped.
- **Server** (`server/src/reports.ts`, `report-http.ts`, wired in `main.ts`): per connection 3 feedback notes per 10 minutes and 5 error reports per session; HTTP fallback `POST /report` (body at most 4096 bytes, same `originAllowed` function as the socket, CORS headers and an `OPTIONS` answer only for allowed origins, 5 per 10 minutes per address using the `SB_TRUST_PROXY` logic, no room or player in the line); a server-wide backstop of 120 reports per 10 minutes (added on my judgment, so reconnecting does not reset the limits); reports never reach `Game`. **`SB_FEEDBACK_FILE`** sets the log (default `feedback.log` in the server's working directory, git-ignored; empty means console only; since package W the default is `<SB_DATA_DIR>/feedback.log`, see "Package W"). One JSON line per report, also printed with a `[report]` prefix. A failed write logs a warning and never crashes the server.
- **Reading the log.** `feedback.log` is one JSON object per line: `time`, `kind`, `text`, `stack` (errors), `ctx` (`fps`, `renderScale`, `ping`, `ua`, `gpu`, `path`), `server` (`via` `ws` or `http`, `room`, `map`, `team`, `playerId`, `name`, `protocol`). In PowerShell: `Get-Content feedback.log -Tail 20`. On the owner's PC the file is in the folder the server was started from.
- **Client** (`client/src/report.ts`): `reporter` sends over the open socket, else by HTTP to the address derived from the server URL. `window` `error`, `unhandledrejection` and the canvas `webglcontextlost` send one report each, at most 5 per session, identical messages once. The "Send feedback" panel (pause menu and result card) has a text box with a live count, Send and Cancel, "Thanks, sent" or "Could not send. Try again.", and one line saying what is attached; the panel counts as a menu, so weapon keys and the mouse are suspended while it is open.
- **Gaps.** A note sent over the socket reports "Thanks, sent" as soon as it is handed to the socket: a rate-limited or invalid note is dropped silently by the server (an HTTP send does report failures). There is no moderation or reading UI and notes are not deduplicated. Rebinding was only available in game until package L, which opens Settings from the main menu too. Mouse buttons cannot be bound to chat or lobby actions inside the lobby panel (it needs the cursor). Bindings are not synced between devices. Keys are stored by physical position (`code`), so the labels on a non-QWERTY keyboard can differ from what is printed on the key.

## Wave 2: bomb carrier (package C) and rooms and community (package D)

Combined on branch `wave-2` (built on `wave-1`), protocol 12, 344 tests at the time; on `main` since 2026-11-17. Both build sessions froze at a Browser pane call for hours and the branches were combined from their committed code; the sessions later resumed, checked their packages in a real browser and added screenshots (`docs/review/bomb-carrier/`, `docs/review/rooms/`) and one fix, all now on `wave-3` (see "Checked in a browser afterwards" below). The detailed write-ups the two sessions made are on their own branches (`claude/bomb-carrier-f5f825` commit `15e09ac`, `claude/rooms-community-46c9f3` commit `581a265`, `HANDOFF.md` there).

**Bomb carrier (C, protocol 11).** Rules in `shared/bomb.ts`, glue in `server/src/game.ts`, tests in `shared/bomb.test.ts`, `server/src/bomb-carrier.test.ts` and `server/src/prediction.test.ts`.
- One ghost carries the bomb from the freeze. The carrier is chosen without randomness: living, non-idle ghosts ordered by join time, indexed by the round number, so it rotates (`Game.assignCarrier`). Only the carrier can plant: `canAct` and `movementLocked` in `shared/rules.ts` take a `carrier` flag.
- The carrier drops it with the drop command bit (`NetCmd.drop`, key G, a `round` binding; refused while planting), on death, on leaving, or on going idle. A dropped bomb rests at the feet, or on the first floor straight below when in the air (`restingPoint`). Any living ghost whose hull touches it picks it up (`touchesBomb`); a deliberate dropper cannot for `DROP_REPICK_TICKS` (60) of its own processed commands.
- `stepCarry` runs once per processed command of a living ghost on the server and for every predicted and replayed command on the client (`stepObjective` in `client/src/main.ts`). The self snapshot carries the carry state exactly (carrier flag bit, 1 byte repick wait) and `actionTicks` as an exact count instead of a 0..1 fraction, so the client also predicts the command on which a plant or defuse completes (`phaseOverride`). The command is 26 bytes. `bombMismatches` in the client's debug state must stay 0.
- Who knows what: ghosts get a `bomb` message on every change (carrier id, dropped position, event). A defender gets only the dropped position, only while its eye has a clear line to just above the bomb (`Game.updateBombSight`, run on every snapshot while a bomb is dropped), and never who carries it. Drop and pickup sounds (8 m, quiet) reach defenders with `id` 0.
- **The shot-event leak is fixed** (`Game.sendShot`): a recipient who does not know about the victim gets the shot without `victim`, `zone`, `damage` or `killed`, and with `to` where the ray meets the map alone. `knowsAbout` gained `assumeAlive` for this, so a ghost killed by the shot is judged as the next snapshot would have judged it standing there.
- Bot: `npm run bot -- --plant` and `--drop` (`tools/botpath.ts`).

**Rooms and community (D, protocol 12).** JSON messages only; nothing here is predicted.
- Room options (`shared/room-options.ts`): `suppressed`, `public`, `maxPlayers` (2 to 10), `roundsToWin` (3, 6 or 9; sides swap after `roundsToWin - 1` rounds), `fillBots` (stored and shown only; package E implements it). Read from the join query when the room is created (`suppressed=1&public=1&max=6&rounds=3&bots=1`); the creator can change them in warmup with an `options` message, and everyone gets the new set. `cleanRoomOptions` validates each field on its own.
- Public room list: `GET /rooms` (`server/src/rooms-http.ts`, `roomlist.ts`, cached 1 s, same origin check as the socket) lists public rooms without names or addresses. Quick play (`quick=1`, no room) joins the fullest public room with space, else creates a public one (`quick-xxxx`). `welcome.room` tells the client which room it landed in.
- Vote to kick (`server/src/votes.ts`, pure and tested): needs 3 players, one vote at a time, 30 s, the target cannot vote, caller cooldown 2 min, a target who survived is protected 2 min. A removed player is banned from that room for 10 min by address and by name (`Bans`), closed with code 4001 and told why. In a room of two the creator can remove the other player directly, in warmup only.
- Names and chat (`server/src/namefilter.ts`): a small slur list (whole-word or anywhere, look-alike characters, repeats and separators handled), reserved system names ("Server", "Admin"...), and duplicates numbered "Sam (2)". Blocked names become "Player"; blocked words in chat become asterisks. The first use compiles the patterns (about 100 ms once per process).
- Map vote: on the result card every player picks a map; the vote closes 8 s before the rematch (`MAP_VOTE_LEAD_MS`), most votes wins, ties and no votes keep the map. `Game.swapMap` moves the room (players dead until the round start spawns them; a dropped bomb is cleared). The client gets `map`, and `Net` holds every later message until the new map has loaded (`swapMap` in `client/src/main.ts`); if the download fails it rejoins the room.
- `Player.bot` exists and is skipped for votes and the creator role, ready for package E.
- Client: `client/src/community-ui.ts`, create form, room list, lobby options, vote banner, map vote on the result card (`ui.ts`).

**Checked in a browser afterwards (by the build sessions, on their own branches before wave 3 was added; not re-run on `wave-3`).** C, Test Map 1: carrier assigned, drop, repick wait, pickup, plant with the movement keys held, a disconnected carrier dropping the bomb, a defender told about a dropped bomb only while in sight; `bombMismatches`, `gunMismatches` and `knifeMismatches` stayed 0. Warehouse: only the drop. D: the room list (private room absent), Quick play, options changed in the lobby, a kick vote passing and failing, the kicked screen, the ban refusing a rejoin, and two short matches ending in a map change in both directions. That run found that textures shared between maps were unloaded by the old map, leaving the new one black: fixed in `client/src/maplook.ts` (holders counted per URL).

**Not verified in wave 2:** every new sound by ear; on Warehouse the bomb pickup and plant in a browser; a teammate's pickup seen on screen; `tools/bot.ts --plant`; a slow download during a map change (the 8 s lead is a guess) and its rejoin fallback; more than two players in a map change; the room list through the Cloudflare tunnel; the ban by address behind the tunnel (needs `SB_TRUST_PROXY=1`, otherwise one kick bans every player from that room, since all share the proxy's address).

**Known gaps in wave 2 (the first two were fixed by package L; room codes are still not filtered):** the HUD title reads "FIRST TO 6" in every room whatever `roundsToWin` is (`client/src/presenter.ts` uses the constant); no vote-kick button on the Tab scoreboard; room codes are not passed through the name filter.

## Package E (bots and practice range)

Built 2026-11-16 on branch `claude/bots-practice-046461` (from `wave-2`), protocol 13; reviewed (the information rule, the shared and protocol diffs and the server glue were read line by line; `bots.ts` behaviour and the tests were not) and merged into `wave-3`. **Nothing of it has been seen in a browser** (the build session was told not to use one): the menu buttons, the create-form controls, the lobby "bot" tags and the practice strip were checked by reading and by the type checker only.

**What a bot is.** `server/src/bots.ts`. A bot is a `Player` with `bot = true` and a `BotBrain`; its `Connection` delivers every message into a `BotView` instead of a socket, and every server tick (`Game.tick` calls `stepBots` first) the brain returns one `NetCmd` that goes through `Game.handleCmd` like a person's, so every rule (movement, weapons, bomb, rate credits) applies. `Game.addBot(team, role?, place?)` adds one (returns 0 when the map has no navigation graph). Bots are named "BOT <name>", are always ready, never count for votes, the creator role, room size, Quick play, an empty room or idleness, and carry `bot: true` in the roster.

**What a bot may know (the rule the reviewer should check).** The brain reads only: its own player (`BotSelf`: position, loadout, knife, carry, health), the map and its navigation graph (public), a line test against the map boxes (`Game.clearLine`, geometry only), the team's site choice for the round (`teamSite`, a plan picked from a generator seeded by the room code, carrying no information), and the messages its connection was sent. Enemies come only from snapshots (already filtered by `knowsAbout`), sounds within earshot, slash events, damage taken, the kill feed and the bomb messages (a defender bot learns of a dropped bomb only from the message sent while it is in sight, and never who carries it). Positions are copied when a message arrives, because the snapshot holds live references to other players' state arrays. A defender bot shoots only at a ghost in its newest snapshot. Tests: `server/src/bots.test.ts` checks every snapshot a bot receives against `knowsAbout`, that every shot a defender bot fires follows a snapshot that showed it a living ghost, that no contact position is a live state array, that a still ghost behind a wall beyond 8 m is never shot, and that a defender's dropped-bomb knowledge always equals the last bomb message.

**Determinism.** No `Math.random`, wall-clock time or client `seq` in anything bots do: every timer counts the brain's own think calls (one per tick), variation comes from `BotRng` (mulberry32) seeded from the room code and the bot's number and stepped once per think. A test runs the same room twice and compares positions, health and statistics.

**Navigation.** `tools/blender/mapkit.py` `nav_graph` builds it from the verifier's walk graph (0.25 m spots): spots joined by walking moves inside 1 m blocks become one node (on the spot nearest their middle); two nodes are linked when a fine move joins their blocks **and** a player walking the straight line between the two node points stays on spots of the walk graph using its moves (`_trace_line`), so a bot steering straight at the next node never cuts a corner or climbs a stair from the side. Edge kinds walk, step, jump, drop, and since Trailer Park crouch (file value 8, two-way 12, so older files read the same; a walking link whose line passes a crouch-only spot, costed 2.6 times its length; a bot holds crouch along it and from a metre before it). The verifier fails the build if any spawn cannot reach a site (or a site cannot get back to a spawn) over the graph. Written into `<id>.json` as `nav` (`cell`, flat `nodes` x y z, flat `edges` from to kind, kind + 4 when the same link goes both ways): Test Map 1 1,481 nodes and 5,457 links (109 KB of JSON), Warehouse 3,388 nodes and 11,307 links (244 KB of JSON; the client downloads it with the map and ignores it). `shared/nav.ts` `NavGraph`: flat typed arrays, bucket lookup of the nearest node, A* with a per-node cost (bots use it for route variety and, for ghosts, to keep clear of defenders) and a weight (`PATH_GREED` 1.6) that cuts the search about three times. Bots follow the nodes without skipping any (skipping caused bots to walk into wall ends), jump on jump links, and replan when stuck for a second (twice: drop the goal). Both maps were rebuilt with `npm run map -- <id> --no-bake`: the full bake needs the source HDRI in the git-ignored `tools/blender/source-art/`, which this worktree does not have; `--no-bake` reuses the shipped lightmap, and the GLBs came out byte-identical (only the JSONs changed).

**Behaviour.** Defenders: split over the sites (by bot order and the round's plan), hold a spot looking along the way ghosts come, move to another spot every 8 to 16 s, turn toward and investigate sounds (only those near their spot or within 9 m; they stop 5 m short and watch), turn toward damage, spot a ghost by eye only inside a 110 degree field of view and only when its visibility clears the level's threshold (which grows past 10 m), hear breathing all round within the level's range and turn to it, shoot with a reaction delay and a settling aim error, fire bursts and pause for the recoil (the pistol with separate presses), reload when out of a fight, switch to the pistol when the rifle runs dry in a fight, to the knife when both are empty, go to a planted bomb and defuse it, watch a dropped bomb they can see. Ghosts: take varied routes to the round's site (per-bot area costs) with costs rising within 10 m of every defender (ghosts always know where defenders are), run when no defender is near, walk within 25 m, crouch within 12 m or when one has a line to them; stand still while a defender looks their way (up to the level's patience); back out of a facing defender's breathing range; stalk a defender who looks away toward a point behind its back, crouched until the last steps; strike when within reach, when close to a defender who is not looking and not moving, or once hit; the carrier plants only where no defender can see (planting makes a ghost visible), waiting at most 10 s for such a spot, and anywhere in the site in the last 55 s; the nearest ghost bot fetches a dropped bomb; after a plant they guard 5 to 8 m from the bomb and go for a defender who defuses.

**Difficulty** (`botLevel` room option, `level=easy|normal|hard` in the join query, a "Bot skill" select in the create form and lobby; changing it replaces the fill bots): reaction 0.7 / 0.4 / 0.22 s; first aim error 7 / 3.5 / 1.6 degrees, settling 3 / 5 / 8 % per tick; turn rate 240 / 420 / 720 degrees per second; react to sounds within 50 / 80 / 100 % of their range; spot visibility 0.22 / 0.12 / 0.07; shoot at a breathing (invisible) ghost within 0 / 4 / 8 m; head-aim chance 0 / 15 / 35 %; burst 4 / 6 / 8; ghost patience 2.5 / 6 / 10 s; stalking range 9 / 13 / 17 m. All untuned starting values in `LEVELS`.

**Fill with bots** (`fillBots`, now live; `Game.fillWithBots`): each team is kept at `botTeamSize` = half of `maxPlayers` (at least one) with bots, never more than `maxPlayers` in all. Only bots added by the option (`Player.filler`) are added or removed by it, so bots added by hand (tests, tools) stay. Bots are added at any time (a bot added mid-round waits for the next round like a person); they are removed only in warmup or at a round start, so a person who joins mid-round takes a bot's place at the next round start. A switch of team in a filled room counts only people for the "teams uneven" rule. A map without a graph gets no bots. The room list shows `bots` beside `players` (people only).

**Practice range.** Menu buttons "Practice range: defender" / "Practice range: ghost" (on the map chosen above); the join query `practice=1&side=defenders|ghosts` (also with `?auto=1`). The server makes a fresh private room `practice-xxxx` (`Rooms.join(..., practice)`, `Game({ practice: true })`): rounds off (warmup forever, respawn after 3 s), nobody else may join, `welcome.practice` is set. Five targets on the other side (3 standing, 2 strafing, never firing), placed 6 to 28 m from the person's spawn where its eye sees them, facing it, spawning there again 3 s after a kill (`Player.spawnAt`); ghost targets are drawn fully visible (`vis` 1). The team key (M) switches side and the targets follow. **Unlimited reserve**: `fillReserves` (`shared/gun.ts`) after every `stepLoadout` of a defender in a practice room, on the server and in the client's prediction and replay (from `welcome.practice`), so the reserve always reads full and prediction agrees. Every hit's damage comes back in `hitconfirm.damage` (all rooms; the shooter could already work it out from the zone and weapon); in the practice range the top strip lists the last five ("34 body, 68 head (down)"). There is no lobby panel in the practice range.

**Protocol 13** (all JSON): `RosterEntry.bot`, `HitConfirmMsg.damage`, `welcome.practice`, `RoomOptions.botLevel`. Snapshots and commands unchanged; `prediction.test.ts` still at zero disagreements (it does not exercise the practice reserve fill; that rule is one line on each side and covered by a server test).

**Tools.** `npx tsx tools/botmatch.ts <map> [--level easy|normal|hard] [--per-team 5] [--rounds 6] [--quiet]`: a whole bot-versus-bot match in-process, seconds of real time. `npx tsx tools/bench.ts <map> --bots`: ten bots in real rounds for two simulated minutes. `npx tsx tools/bottrace.ts <map>`: one round with a line per second per player, every kill and every defender engagement (debugging). `tools/bot.ts` (the scripted network test player) is unchanged and still type-checks.

**Numbers (2026-11-16, this PC, final code).** Bench, ten bots on Warehouse: 0.245 ms per tick on average, median 0.127, 99th percentile 1.8 ms, worst 11.6 ms (20.4 ms in the first second while the graph is built and the code warms up); Test Map 1: 0.106 ms average, worst 15.3 ms. For comparison ten people running and firing on Warehouse (the old bench): 0.22 ms. Path searches are most of the bots' cost (about 0.45 ms each, roughly 6 per second for ten bots), which is what the spikes are. Full bot-versus-bot matches (normal, five a side, first to 6): Test Map 1 finished 6:5 after 13.1 minutes of game time (3.6 s real), Warehouse 6:5 after 12.6 minutes (9.5 s real). **Every round on normal was won by the defender side** (Test Map 1: 9 by elimination, 2 plants defused; Warehouse: 8 and 3), so the score is the sides swapping at halftime. On hard the same; on easy ghost bots won 2 of 9 rounds on Warehouse. Earlier tuning runs looked the same.

**Not verified / known gaps.**
- Anything in a browser: menu, create form, lobby tags, practice strip, a person playing against bots, prediction in the practice range with real lag.
- **Ghost bots are weak against defender bots.** They plant and occasionally win a knife fight but almost never win a round on normal or hard. Against people this likely makes bot defenders hard and bot ghosts easy; the numbers in `LEVELS` and the ghost rules above are the place to tune once the owner has played.
- Bots do not use teammates' calls (no chat), do not lead moving targets, do not compensate recoil, do not jump except on jump links or when stuck, and do not take the bomb from a teammate. Defender bots' field of view and hearing are simple models, not the client's real rendering of a shimmer.
- Bot path planning causes tick spikes of a few milliseconds (worst seen 11.6 ms on Warehouse after warm-up), within the 16.7 ms tick but visible in a busy server.
- The navigation graph adds 244 KB (uncompressed) to Warehouse's JSON download; it could move to a server-only file if that matters.
- Moving practice targets strafe without regard to walls (they turn back when blocked).

## Known problems

- **Phase edges and the gun.** The client decides "armed" (not frozen, hands free) from its own view of the round phase, which arrives late under lag. A trigger held across the freeze-to-live edge can fire on the server before the client predicts it; the snapshot corrects the gun state (one `gunMismatches` tick), but that shot's tracer and sound are not shown locally. Same as before this change for firing; never seen in testing.
- **Spread is predictable, by design.** The client must predict it, so a modified client can know the next shot's spread (256 seeds per player id, repeating) and compensate its aim; it can no longer choose a small spread. Only server-side randomness the client cannot predict would remove this, at the cost of predicted tracers not matching.
- **Warehouse has only been seen by its author.** Its layout passes every automatic check, but nobody has played it: balance, how readable the three levels are, and whether the car park and catwalk sightlines (up to 30 m) favour defenders are unknown. Frame rate on it was not measured on an integrated GPU: it is 7 world draw calls plus the sky, as the budget allows, but 30 k vertices and a 3072² lightmap (about 48 MB of GPU memory with mipmaps).
- **Third-person hands are rigid** (the finger bones are folded into the wrists to keep characters cheap), so they do not wrap the grip; the one-handed pistol is small in the hand from some angles. The remote switch dip and aim raise (`characters.ts`) were never seen on screen. The rifle's aimed view shows a chunky gun body under the sight (the model's proportions). Pistol and switch sounds (`audio.ts`) were never listened to. First-person poses per weapon live in one table in `presenter.ts` (screenshots in `docs/review/weapons/`); they were tuned from still frames only. The pistol model is the "Pistol" prop already in Quaternius's `CharacterSoldier.glb`, with a generated suppressor (nothing new downloaded).
- **A hidden browser pane throttles timers**, and `?lag=` delays every command with `setTimeout`. Commands then arrive in bunches, the server drops the ones beyond its 12-command credit, and the client's prediction of those commands is corrected (seen as `gunMismatches` and position error). This is the existing rate limit, not a weapon rule: a server-side count of dropped commands matched every mismatch, and with frames driven by a Worker clock the same run had none. Expect the same on a real player's machine whenever the tab stalls.
- **Browser tests ran with the browser pane hidden**, so `requestAnimationFrame` never fired; the test harness called `app.tick` from a timer. Movement and rules are unaffected, but frame-rate numbers from those runs mean nothing.
- **The menu shows a dark, empty scene** behind it: the map is loaded only once the server says which map the room uses.
- **Stale dev modules.** After many rapid file edits Vite has served an old copy of a client file. If the HUD looks frozen or a function is "not a function", restart `npm run dev`.
- **Adaptive resolution reacts to a throttled tab.** A browser tab running in the background can make it step down to 90%. Harmless in a visible tab; `?res=1` pins it.
- **A remote ghost's flinch is still inferred** from the visibility spike a hit causes (there is no other signal for it); its knife swing is driven by the real windup and slash events since package F.
- **The crouch is a deep squat** (a 0.6 m drop); with a weapon the back now leans forward (package F), but the squat itself is unchanged.
- **Art flaws:** bomb-site letters are blocky, pale inner walls are flat, stair steps are hard to tell apart, baked accent lights barely show in sunlight, the gun model is dark and looks large in a narrow window.
- **Node 20.11** is older than current Vite and Vitest support, so they are pinned to Vite 6 and Vitest 3.
- **The switch motion is still procedural** in first person (the arms rise with the gun from below); there is no holster clip.
- **(Fixed by package C, `Game.sendShot`; kept for the record.) Shot events gave a hit ghost's position to everyone who received them.** A shot that hits a ghost carries `victim` and `to` (the point on the ghost's body). Before package A that went to every player in the room; it now goes only to those in earshot or with a line of sight to the shooter, but a defender in earshot who cannot perceive the ghost is still told where it was hit. Suggested fix: for a recipient for whom `knowsAbout(recipient, victim)` is false, send the shot without `victim`, `zone`, `damage` and `killed`, and with `to` replaced by where the shot would have ended without players (`rayWorld` only), so the tracer passes through without stopping on the ghost. Left for review because it changes what other players see (the tracer no longer stops at the ghost for them) and the brief asked for a report, not a silent fix.
- **Ghost breathing is quieter up close (changed by measurement, needs the owner's ear).** The owner found it far too loud next to a ghost. `BREATH_RANGE` (8 m) is unchanged. The breathing panner now only gives direction (HRTF, rolloff 0) and a separate gain applies `breathDistanceGain` (`client/src/audio.ts`): flat inside 2.5 m, easing to the old level at 6 m, the old curve from 6 m to silence at 8 m. Measured 2026-11-16 by rendering white noise through the old and new nodes in an `OfflineAudioContext` (HRTF, emitter at head height straight ahead), in dB relative to the old level at 1 m: 0.5 m +0.3 → -9.6; 1 m 0 → -9.6; 2.5 m -2.1 → -9.6; 5 m -7.4 → -10.5; 6 m -10.9 → -10.9; 7 m -16.9 → -16.9; 8 m silent → silent. Exertion, occlusion and direction are unchanged. Not heard by anyone, and not run in a live match with a ghost nearby.
- **Suppressed gunshots now fade out at 20 m** (`GUNSHOT_RANGE_SUPPRESSED`), where the server stops sending them; they used to fade out at 45 m in `audio.ts`. The synthesised sound itself is unchanged.
- **The bare SMG has a short generated barrel stub** (`tools/blender/weapons.py`): the source model's suppressor is integral and the receiver ends flush without it. The stub sits inside the suppressor's collar, so the suppressed look is unchanged (44 hidden triangles more).
- **No per-zone statistics.** Only `headshots` exists (now counted by zone); arms and legs hits are not counted separately, because the result card (package B's) would need a change to show them.
- (Fixed by package C: only the bomb carrier can plant.)
- **Warmup respawn edge (found in package M, not fixed).** A dead player's client keeps sending commands; the server simulates the ones it receives after the respawn, while the client starts its prediction from the fresh spawn state when the `spawn` message arrives. A player who holds movement keys or aim across a warmup respawn gets one small correction on the first snapshot (position, or the loadout's aim counter). Round starts are not affected (the freeze roots everyone). The prediction tests keep still around respawns for this reason.
- **The scripted bot (`tools/bot.ts`) does not fight.** It walks, strafes and can hold fire; it is a test tool, not an opponent. Real opponents are the server bots of package E.

## Running it

```bash
npm install
```

```bash
npm run dev
```

This starts the game server (ws://localhost:8080) and the web client (http://localhost:5173). Each browser tab is a player. A new player joins the smaller team (ghosts on a tie). A room waits in its lobby until every player is ready or the room creator starts it; bots ready themselves.

- `npm run bot` adds a scripted player (walks in, then strafes). `npm run bot -- --shoot` makes it hold fire; add `--pistol` to make it hold the pistol (one tap every 12 commands) and `--aim` to make it aim down sights; `--knife` holds the knife (slot 3) and keeps swinging; `--suppressed` creates its room with suppressed weapons (only if the bot creates the room). To play as a defender alone, start the bot before opening the page.
- `npm run bot -- --map warehouse --room test --still` (the map only matters if the bot creates the room). Bots press ready on joining and again whenever a room falls back to warmup; `--unready` stops that.
- URL options: `?auto=1` skips the menu and the lobby panel (and `?quiet=1` only the pause menu, click hint and lobby panel: for scripted runs), `?name=`, `?room=`, `?map=` (`warehouse`, `greybox`, `trailerpark`), `?lag=150` (simulated round-trip latency), `?res=0.7` (pin render resolution), `?server=ws://host:port`.
- Keys (defaults; all rebindable in Settings, see "Client utilities"): WASD move, mouse look, left click attack (F also attacks, useful without pointer lock), right mouse held aims down sights (defenders; Z also aims, useful without pointer lock), 1 rifle, 2 pistol, 3 knife (defenders), Q previous weapon, mouse wheel cycles through all three, R reload, E plant or defuse, Tab scoreboard, Space jump, Shift quiet walk, C crouch, Enter all chat, Y team chat, Esc pause menu (Esc cancels chat), left/right arrows follow another teammate when dead, and in warmup G ready, U start (room creator), M switch team, L open the lobby panel. Chat, the pause menu and every panel suspend the weapon keys, mouse buttons and wheel.
- `npm test`, `npm run typecheck`, `npm run build`.
- In the browser console, `window.__sb` exposes `app`, `state`, `loadout`, `knife`, `input`, `net`, `match`, `mapData`, `presenter`, `audio` and `stats()` (`stats().gunMismatches` counts snapshots where the replayed weapon state, any field of the loadout including the defender knife, differed from the prediction; `stats().knifeMismatches` the same for the knife timing, the ghost's or the defender's; both should stay 0. `stats().loadout` copies the whole loadout, `stats().gun` the gun in hand (null with the knife), `stats().held` names the slot in hand).
- Browser checks with the pane hidden: `requestAnimationFrame` never fires, so drive frames from a Worker (`setInterval` in a Blob worker posting to the page, which calls `__sb.app.tick(performance.now())`); page timers are throttled too, so steer or time inputs inside an `app.on('update')` handler, not with `setTimeout`. To capture a short effect (muzzle flash, hit marker), set `__sb.app.timeScale = 0` on the frame it appears: taking a screenshot draws one more frame, and with time frozen it shows the same moment.
- `npm run bot -- --shoot` fires 10-round bursts, pauses, and presses R between bursts when under 12 rounds (5 with `--pistol`); it logs when it runs out of ammunition (until its next spawn).

## How it is put together

| Path | What it is |
|---|---|
| `shared/` | Code run by both client and server. `movement.ts` + `collision.ts`: deterministic box-hull movement. `weapons.ts`: the table of every defender gun's numbers, and the defender knife (`DEFENDER_KNIFE`, slot 3) beside it. `gun.ts`: the loadout (switching between three slots, aim, trigger edge, the defender knife's timing) and each gun's ammunition, reload, recoil pattern and spread. `knife.ts`: knife windup and cooldown (ghosts', and inside the loadout for defenders). `zones.ts`: body-part zones and damage multipliers. `room-options.ts`: per-room options. `rules.ts`: round phases, timings, plant/defuse eligibility. `visibility.ts`: ghost visibility curve. `protocol.ts`: message types and the binary wire format. `constants.ts`: every tuning number. |
| `server/src/game.ts` | The authoritative match. No socket code, so it is tested directly (`game.test.ts`). |
| `server/src/main.ts` | WebSocket transport, rooms, rate limits, `/health`. |
| `client/src/main.ts` | Game loop: fixed 60 Hz simulation, prediction and reconciliation, menu, adaptive resolution. |
| `client/src/net.ts` | Connection, clock estimate, interpolation of other players. |
| `client/src/presenter.ts` | Everything visual except the map: HUD, viewmodel, tracers, bomb. Implements `presenter-api.ts`. |
| `client/src/characters.ts`, `weapons.ts` | Animated player models and weapon attachment. `weapons.ts` builds each gun's suppressed mesh (gun plus its suppressor child, merged into one mesh at load, so a gun is one draw call either way) and switches mesh and muzzle node by the room option. |
| `client/src/viewmodel.ts`, `corpse.ts` | First-person arms rigs (load, clip sampling by time) and where a body lies (package F). |
| `client/src/audio.ts` | Synthesised spatial audio. Implements `audio-api.ts`. |
| `client/src/maplook.ts` | Map shader (albedo × baked light) and sky. |
| `tools/blender/` | Headless Blender scripts that generate the shipped assets. Characters `soldier.py` + `clips.py` (package O), weapons `weapons.py`, first-person arms `viewmodel.py` (run `weapons.py` first, then `viewmodel.py`, then `soldier.py`), shared posing helpers `rigkit.py`, review renders `review.py` (with `tools/review-animations.mjs`). Maps: `mapkit.py` (definitions and verification, plain Python), `mapbuilder.py` (Blender side), `build_map.py` (entry), `maps/<id>.py` (one per map), `mapplan.py` (plan images). |
| `server/src/rooms.ts`, `maps.ts` | Room registry (one map per room) and map loading. |
| `server/src/game.ts` (match flow part) | Lobby, stats, chat, idle rule, disconnect hold, damage messages: JSON only, tested in `matchflow.test.ts`. |
| `shared/stats.ts`, `chat.ts`, `maps.ts` | Most-valuable-player score, chat cleaning, map ids and the default map. |
| `client/src/ui.ts`, `ui.css`, `settings.ts`, `radar.ts` | Menus and panels, saved settings, the radar. |
| `client/src/loading.ts`, `loading-ui.ts`, `fetch-progress.ts`, `tools/asset-sizes-plugin.ts` | The loading screen (package S): progress maths, the card, the streamed fetch that feeds PlayCanvas, and the build-time size manifest `virtual:asset-sizes`. |
| `client/src/bindings.ts`, `phone.ts`, `report.ts` | Key bindings (action table, conflicts, storage), the phone notice, feedback and error reporting. |
| `server/src/reports.ts`, `report-http.ts`, `shared/report.ts` | Report validation, limits and the log file; the HTTP route; the shared text cleaning. |
| `tools/bot.ts`, `tools/bench.ts` | Scripted test player and the server cost benchmark (`--bots`: ten server bots). |
| `server/src/bots.ts`, `shared/nav.ts` | Server bots (perception from messages only, behaviour, difficulty) and the navigation graph search (package E). |
| `tools/botmatch.ts`, `tools/bottrace.ts` | A whole bot-versus-bot match in-process; a per-second trace of one round for debugging bots. |
| `server/src/game-events.ts`, `datastore.ts`, `matchlog.ts`, `recording.ts`, `replay.ts`, `roomdata.ts`, `shared/privacy.ts` | Package W: the data folder, match records, input recordings and their replay, the privacy text and retention limits. |
| `tools/data.ts`, `matchstats.ts`, `replay.ts` | Reading the server's data from the owner's PC over SSH; balance numbers from match records; checking a recording replays exactly. |
| `docs/review/` | Screenshots saved by build sessions for review. |
| `ROADMAP.md` | What to build next, with decisions and briefs. |
| `DEPLOY.md`, `Dockerfile`, `deploy/`, `.github/workflows/` | Deployment, never run for real. See Hosting. |

### Rules that keep it working

- **Client and server must simulate identically.** Movement, the movement lock and attack timing live in `shared/` and are counted in commands the server actually processed for that player, not wall-clock time and never by comparing the client-chosen `seq` (a modified client can skip ahead in `seq`; `seq` only orders commands and acknowledges them, and must not be made strictly consecutive, because commands dropped for lack of credits are never acknowledged). Change a rule in one place and both sides follow; never reimplement one on only one side.
- **The wire format must be exact for anything the client predicts with.** The local player's state travels as float64, and the client rounds its view angles with `Math.fround` before using them. Breaking this makes prediction drift. The loadout (slot, previous slot, draw ticks left, aim ticks, trigger edge, per gun: magazine, reserve, reload ticks left, cooldown, burst index, commands since the last shot, shot count; then the defender knife's cooldown and windup) travels as one byte each, followed by the ghost knife's two bytes, so every counter in `shared/weapons.ts`, including `DEFENDER_KNIFE`, must stay at or below 255 (a test checks every gun and the knife). The binary command carries the weapon request: a slot byte (1 to 3), and Q and aim bits.
- **The loadout is stepped by `stepLoadout` on every command a living defender simulates**, on the server and in the client's prediction and replay; the client keeps per-command `live`/`armed` flags so the replay steps exactly what was predicted. It handles the weapon request, the draw timer, aim progress and the trigger edge, then steps every gun with `stepGun` (the ones not in hand with no input, so their recoil still recovers) and the defender knife with `stepKnife` (its timers always run; a swing starts and lands only while the knife is drawn and armed; switching away cancels a windup in progress; the knife has no aim, and aim drops to 0 on switching to it). `stepLoadout` returns `MELEE_SWING` when a windup starts (the server sends the same `windup` sound as a ghost's) and `MELEE_SLASH` when it lands (the server resolves it with the ghost knife's `slash`, reach, cone, wall test and lag compensation, at the defender knife's damage). Semi-automatic fire uses `LoadoutState.trigger`, set when the trigger did something and cleared on release: stepped state, never wall-clock input. Spread comes from an integer hash of the weapon's shot count (`GunState.shots`, one byte, wrapping, reset at spawn) plus 256 times the slot, and the shooter id, never `Math.random` or `seq`. Aim scales spread and recoil inside `shotDirectionFor`, which both sides call. `server/src/prediction.test.ts` must keep passing after any change to these rules or the wire format. The ghost knife works the same way: `stepKnife` (`shared/knife.ts`) counts the windup and cooldown per processed command, the snapshot carries both counters exactly, and the client replays them (`stats().knifeMismatches` should stay 0). Recoil is drawn as an offset added to the camera on top of the view angles; it is never written into `input.yaw`/`input.pitch`, so commands keep carrying the player's own aim and the server adds the same pattern.
- **Collision is axis-aligned boxes only.** Anything a player can stand on, hide behind or be blocked by must be a box in the map's definition (`tools/blender/maps/<id>.py`). Ramps, round or rotated solids need new collision code first. Since Trailer Park an angled shape may keep its look: an oriented visual-only box (`MapDef.visual(..., yaw=, pitch=)`, drawn with its own faces by `mapbuilder.py`, tested against players exactly by the verifier) over hidden axis-aligned collision boxes that follow it (`tools/blender/mapshapes.py` `cover`, one `group`). A ramp is real 0.2 m stairs (hidden) under visual boards whose top stays at or under every step.
- **Maps are generated, not hand-edited.** Each map is a definition file in `tools/blender/maps/` (data only) built by the shared builder: `npm run map -- <id>` (`greybox` = Test Map 1, about 2.5 minutes; `warehouse`, about 6 minutes; the Cycles bake uses the GPU, OptiX then CUDA, else CPU). `--no-bake` reuses the lightmap, `--verify-only` runs only the checks. It rewrites `<id>.glb`, `<id>.json`, `<id>_baked.webp`, the shared textures and `maps/index.json`. Visual-only boxes (pipes, shelving, vehicles) need no collision; a collision box can be drawn only by the visual boxes inside it (`hide=("all",)`).
- **The build fails if a map fails verification** (`tools/blender/mapkit.py`, also `python tools/blender/mapkit.py <id>` without Blender): duplicate names, stair rises, treads and widths, every flight climbable on foot from its bottom step, walkway gaps (solids touch or leave 1.4 m), a walk/step/jump flood fill over the boxes (every spawn and site reachable, no reachable spot that cannot get back to the ghost spawn, 2.0 m headroom everywhere reachable, visual-only boxes clear of player space), no ghost spawn eye point seeing a defender spawn eye point, and per map the longest eye-to-eye sightline (`max_sightline`) and distinct routes to each site (`route_gates`). It prints path lengths from each spawn to each site. **Per-map exceptions, added for Trailer Park (none on the other two maps, whose checks and nav graphs come out unchanged):** a named list of allowed low ceilings (`MapDef.low_ceiling(name, mn, mx, clearance, crouch)`): reachable spots inside need only that clearance; in a `crouch` zone the walk graph uses the crouched hull (1.2 m), so the space is passable only crouched (moves onto or off those crouch-only spots are tested with the crouched hull, no jump starts or lands there), and a zone that covers no spot under 2.0 m, or a standing zone under 1.8 m, fails; boxes given the same `group` (the collision steps of one angled shape) are not gap-checked against each other; categories in `m.floor_categories` are floors for the gap check (Trailer Park's pit rim and pit stairs).
- **A stair can only be entered from its bottom end.** From the side, the 0.6 m hull spans two 0.4 m treads, more than the 0.35 m step height. Keep open floor in front of every first step; the verifier checks this.
- **Rooms choose the map.** The server loads every map JSON in `client/public/maps/` at start; the first player's `map` query picks a new room's map (default `DEFAULT_MAP` in `shared/maps.ts`, `SB_DEFAULT_MAP` overrides); everyone is told the room's map in `welcome` and the client loads it before simulating. Room logic lives in `server/src/rooms.ts`, without socket code.
- **Never send a defender a ghost it cannot perceive.** `Game.knowsAbout` in `server/src/game.ts` is the anti-wallhack rule: a ghost is sent only if in line of sight with visibility above 0.01, or within breathing range (8 m). Sound events are sent only within earshot.
- **Presenter and audio are behind fixed interfaces** (`presenter-api.ts`, `audio-api.ts`) and never touch game or network state. Change the interface file first, then both sides.
- **Performance budgets (two tiers, package G; `client/src/graphics.ts`).** Both: no per-frame allocations in `frame()` paths; at most 2 draw calls per armed player in the main pass; every effect goes through the pooled batches of `client/src/effects.ts` (never one draw call per effect); nothing an effect shows may come from information `Game.knowsAbout` withholds.
  - **Both, since package Q:** 4x multisampling (Low: the WebGL screen; High: the CameraFrame target); players and the first-person weapon lit by the map's light probes (`lighting.ts`), no realtime sun.
  - **Low** (integrated graphics, the default whenever unsure; target 60 FPS at 720p on Intel UHD 620): world at most 8 draw calls (one per surface material plus the sky; the paint decals are one of them), unlit, **2 texture reads per pixel**; fog and colour grade only as arithmetic inside the map shader (`maplook.ts`), never an extra pass; effects at most 3 more draw calls (additive, alpha, decal batches, each drawn only while it has something in it) at 1 texture read per effect pixel, capped at 160 particles and 48 bullet holes; no realtime lights, no shadows, no post-processing, no depth prepass. Weapons and characters: 3 texture reads per pixel (albedo, normal, the map's environment sphere).
  - **High** (a graphics card): Low plus one CameraFrame (linear HDR target, a depth prepass of the opaque scene, ambient occlusion at half resolution, bloom, a neutral tone curve without a toe), at most 4 dynamic lights in the map shader plus one realtime omni light for players and the weapon, the map's prefiltered environment atlas on metal (5 texture reads per weapon or character pixel), a soft vignette in the compose pass, blob shadows and floor clutter (one more draw call), 480 particles and 160 bullet holes. Measured: about 22 draw calls more than Low with no effects on screen (the prepass repeats the world and players, the post passes are about 14 full-screen quads).

### Tuning numbers worth knowing (`shared/constants.ts`, `shared/rules.ts`)

- Speeds: run 5.2 m/s, quiet walk 2.6, crouch 2.0; jump clears a 1 m crate.
- Ghost visibility: 0 still, about 0.10 crouch-walking, 0.17 walking, 0.35 running; spikes to 0.6 on a swing or while planting, 0.8 when hit.
- Weapons (`shared/weapons.ts`; every defender spawns with all three, full, every round, rifle in hand; no buying or pickups; ghosts keep only their knife):

  | | Rifle (slot 1) | Pistol (slot 2) | Knife (slot 3, defenders) |
  |---|---|---|---|
  | Fire | automatic, 10 per second (6 commands) | semi-automatic: one shot per press, at most one per 150 ms (9 commands) | swings while held: 0.2 s windup (12 commands), a new swing every 0.7 s (42), 2 m reach, 40 degree cone; the windup is heard 14 m away |
  | Damage (head 2x, torso 1x, arms and legs 0.5x) | head 68, torso 34, arms and legs 17 | head 52, torso 26, arms and legs 13 | 35 from the front, 70 from behind (no zones) |
  | Magazine + reserve | 30 + 90 | 12 + 36 | none |
  | Reload | 2.2 s (132 commands) | 1.4 s (84 commands) | none |
  | Draw (switching to it) | 0.4 s (24 commands) | 0.25 s (15 commands) | 0.3 s (18 commands) |
  | Spread still / crouched / added at full run / air (rad) | 0.004 / 0.002 / 0.035 / 0.06 | 0.003 / 0.0015 / 0.02 / 0.05 |
  | Recoil | 30-row pattern climbing to 4.75 degrees, then right, left, right; recovers from 9 commands after the last shot, a row every 2 | 12-row pattern, 0.85 degrees on the second shot climbing to 4.1; recovers from 10 commands after the last shot, a row every command (measured taps stay on target, spamming climbs) |
  | Aim down sights | 1.5x zoom, 12 commands in or out, spread x0.5, recoil x0.8 | 1.2x zoom, 8 commands, spread x0.6, recoil x0.85 |

  Reload starts on R with a partial magazine and some reserve, or by firing on empty; firing is blocked meanwhile; switching weapon, death and round reset cancel it (a cancelled reload gives nothing), movement does not. Nothing fires or reloads during a draw. Aiming needs the weapon drawn and not reloading, does not change movement speed, and slows mouse look by the zoom. Empty with no reserve: a dry click at most every 15 commands. Reload sound carries 10 m and says which weapon. Ghost knife: 0.2 s windup, 2 m reach, 55 front, 100 from behind. No aim with the defender knife; switching away from it mid-windup cancels the swing.
- Footsteps carry 18 m running, about 5 m walking, about 3 m crouched. Breathing 8 m.
- Round: 4 s freeze, 120 s live, 35 s bomb, 3 s to plant, 5 s to defuse, first to 6, sides swap after round 5.
- Health 100 and armor 100 (package P, `shared/armor.ts`; reset at every spawn, no pickups): a torso, arm or leg shot or a front knife hit puts `floor(amount x 0.5)` (`ARMOR_ABSORB`) on the armor while it lasts and the rest on health; headshots and back-stabs go straight to health. Hit box: 0.6 m wide, 1.8 m tall (1.2 m crouched), one box for movement and the ray test. Zones (`shared/zones.ts`; multipliers decided by the owner on 2026-11-16, "2x on head, 1x on body and 0.5x on arms/legs", untuned): head = the top 0.28 m (`HEAD_ZONE`, x2.0); legs = the bottom 45% of the current height (x0.5); arms = in the band between, more than 0.2 m from the vertical centre line measured across the shot (x0.5; measured across the shot because the hit point on a box face is always at least 0.3 m from the centre); torso = the rest (x1.0). All four multipliers are in one table (`ZONE_MULTIPLIER`) applied to the gun's `bodyDamage` and rounded; guns have no separate head damage any more. **No gun kills with one shot**: a full-health player takes two rifle headshots, or a headshot and a body shot. Knife hits ignore zones. Standing: legs below 0.81 m, head from 1.52 m; crouched: legs below 0.54 m, head from 0.92 m. No damage falloff with distance, no bullet penetration.
- Gunshots (`GUNSHOT_RANGE`, `GUNSHOT_RANGE_SUPPRESSED` in `shared/constants.ts`, untuned): heard to 60 m, or 20 m in a suppressed room; beyond that seen (flash and tracer, no sound) by players with a line of sight to the shooter. The client's gunshot sounds fade to silence exactly at those ranges.
- Ghost breathing (`BREATH_RANGE`): inside 8 m a defender hears it and is sent the ghost's position, through walls and even if the ghost is motionless.
- Match flow: result card held 20 s, disconnect hold 60 s, idle after 2 silent rounds, assists within 4 s, chat 120 characters with 4 lines burst and one more per 1.5 s.

## Maps

| Map | Id | Levels | Spawn to site paths (walking, A / B) | Download | Bake |
|---|---|---|---|---|---|
| Test Map 1 | `greybox` | 1, open air | ghosts 30.6 / 30.5 m, defenders 11.0 / 10.8 m | 1.2 MB | 3072², 1024 samples, 150 s |
| Warehouse | `warehouse` | basement car park and plant room (site A); ground loading bay, racks, offices, lobby (site B); mezzanine and catwalk | ghosts 38.6 / 39.3 m, defenders 14.8 / 15.4 m | 2.9 MB | 3072², 1024 samples, 365 s |
| Trailer Park | `trailerpark` | open air, 64 x 67 m: closed barracks (site A in the north one), a dug pit 1.2 m deep (site B), roof 6 at 2.0 m, raised east walkway at 1.2 m, a house | ghosts 52.4 / 56.8 m (48.8 to B dropping into the pit), defenders 35.2 / 43.7 m | 2.57 MB | 4096², 1024 samples, 300 s |

Warehouse routes from the ghost spawn: to A through the yard stair and service corridors (tight), the loading-bay stair and car park (long sightlines), or the office stair; to B through the rack aisles (tight), the main aisle, the offices, lobby, mezzanine and catwalk drop, or back up from the basement. The verifier proves each is a separate way in. The original map's bake took 333 s on CPU at 2048² / 256 samples; the same settings take 19 s on the RTX 4060.

**Trailer Park** (built 2026-11-27 on `claude/trailerpark-map-a50e9f`, not reviewed or merged; the owner's drawing `docs/maps/trailer-park.webp`, notes `docs/maps/trailer-park-notes.md`, the approved preview `tools/blender/previews/trailer_park.py`; the build's own write-up, pictures and every departure from the preview in `docs/review/maps/trailerpark/README.md`). Ways into site A: main entrance 25, crouch openings 8 (north) and 9 (south barrack, then the passage), box 10 onto roof 6 and down hole 7 (one way); the east window over box 16 is a way out only. Site B: three stairs, or a drop off the rim anywhere. Longest sightline 63.4 m (`max_sightline` 64), down the west lane. 437 collision boxes (183 hidden steps under angled shapes), 23 k vertices, 7 world draw calls with the sky. Departures the owner should know about: planks 14 and 15 are 2.25 m wide and 2.25 m long stairs under boards (not 1 m by 4.5 m ramps: a narrower plank leaves a slot, a longer one lets players jump in through the east window); crouch opening 9 widened to 1.4 m; the pit's three stair channels are 1.7 m; the ground pocket between the plank tops is filled to walkway height; several crates and blocks pushed against walls to close slots under 1.4 m.

## Assets and licences

Maps: CC0 textures and sky from Poly Haven, listed in `client/public/maps/CREDITS.md`. Models (`client/public/models/CREDITS.md`): since package O the characters and first-person arms are the Fab "Quantum Modular Character Free Sample" by Quantum Assets (Fab Standard License: its source files must never be shipped or committed, only the processed models), animated with clips retargeted from the Quaternius "SWAT" character (CC0); since package M part 2 the weapons are CC-BY models from Fab (Makarov PM by TaigaForest; the AK-105 by SpatialNeglect until package T, Tactical Knife and Red Dot Sight by Gerardo Justel, and since package O the AR Scope by Scape), whose authors must stay credited. Since package T the **rifle in both views is the M4** from the Fab "M4 - FPS Weapon Animations Pack FREE (v.1)", with that pack's own first-person arms and clips (the AK-105 no longer ships). Since package R the first-person **gloved hands and their textures** come from the same pack (Fab Standard License, seller BarcodeGames): processed hands and resampled textures ship inside the game files, the downloaded zip never does. Raw downloads live in the git-ignored `tools/blender/source-art/`; the Blender scripts fall back to the shipped files if it is missing, but rebuilding characters or weapons from source needs those files present.

## Hosting

Live for testing since 2026-11-15. Checked that day from a browser: the page loaded, joined a room through the tunnel, downloaded Warehouse and reached the warmup lobby with no console errors; a connection from another origin was refused.

- **Client (live):** a Cloudflare Workers Builds project named `stillblade`, connected to the GitHub repository, serving static files at `https://stillblade.orcavalley.com`. Cloudflare's current form is the Workers one, not classic Pages: build command `npm run build:client`, deploy command `npx wrangler deploy`, path `/`, and the output folder comes from `wrangler.jsonc` in the repo (`assets.directory` = `./dist/client`; its `name` must match the project name). Build variables (under Settings, Build, "Build variables and secrets", not runtime variables): `VITE_SERVER_URL=wss://stillblade-server.orcavalley.com` and `NODE_VERSION=22`. Every push to `main` rebuilds it. If the variable is missing the page guesses `wss://<page host>:8080` and cannot connect; `?server=wss://stillblade-server.orcavalley.com` in the URL overrides it. The owner's games home page at `play.orcavalley.com` should get a card linking to it (not done).
- **Server, old route (retired 2026-11-20):** the owner's PC behind a Cloudflare Tunnel named `stillblade` (the `cloudflared` Windows service, installed at `C:\Program Files (x86)\cloudflared\`). The tunnel has one "Published application" route: `stillblade-server.orcavalley.com` to `http://localhost:8080` (plain `http`; Cloudflare adds the encryption and created the DNS record itself). The server must be started with `SB_TRUST_PROXY=1` (so the per-IP connection limit sees real addresses through the tunnel) and `SB_ALLOWED_ORIGINS=https://stillblade.orcavalley.com`. In PowerShell from the project folder: `$env:SB_TRUST_PROXY='1'; $env:SB_ALLOWED_ORIGINS='https://stillblade.orcavalley.com'; npm run server`, and keep that window open. Check `https://stillblade-server.orcavalley.com/health`. A 502 there means the server on the PC is not running. No Docker, Caddy or VPS is involved in this route.
- **Server (live since 2026-11-20): an always-on VPS.** AWS Lightsail, Mumbai (ap-south-1a), Ubuntu 24.04, 1 GB RAM, 2 vCPU, static IP `52.66.56.184`, user `ubuntu` with the owner's SSH key (`~/.ssh/id_ed25519` on his PC). Hardened as `DEPLOY.md` B4 (keys only, ufw 22/80/443, unattended upgrades), 2 GB swap, Docker; the repo is cloned at `~/stillblade` and the Compose stack runs from `~/stillblade/deploy` with `SB_DOMAIN=stillblade-server.orcavalley.com` (Let's Encrypt certificate obtained by Caddy; the first test used `52-66-56-184.sslip.io`) and `SB_ALLOWED_ORIGINS=https://stillblade.orcavalley.com`. The Docker setup worked on the first run. **Switched 2026-11-20:** the owner deleted the Cloudflare tunnel route and added the A record `stillblade-server` -> `52.66.56.184`, DNS only; health and a real join checked at `wss://stillblade-server.orcavalley.com`. **Updating the server:** `ssh ubuntu@52.66.56.184`, then `cd stillblade && git pull && cd deploy && SB_COMMIT=$(git rev-parse --short HEAD) sudo -E docker compose up -d --build` (a Caddyfile change also needs `sudo docker compose restart caddy`); data lives in `~/stillblade/deploy/data` (package W), read it from the owner's PC with `npm run data -- feedback|matches|recordings|pull` (after any protocol change, together with the push that redeploys the site). The owner's PC no longer runs the game server. Measured 2026-11-20 from the owner's home: VPS connect round trip min 93-106 ms, median about 160 ms, but nearby sites (1.1.1.1, Google) had medians of 260-350 ms and peaks over 1 s at the same time, so the in-game 150-400 ms seen then was the home connection's jitter, not the VPS (its CPU sat 98% idle, no steal).
- **Server, always-on:** a small VPS running the Compose stack in `deploy/` (game server plus Caddy for the certificate), with the same name as a DNS-only record. `DEPLOY.md` has the steps. Candidates priced on 2026-11-15: AWS Lightsail 1 GB with IPv4 at $7 a month, DigitalOcean 1 GB at $6; plain EC2 costs about twice as much. Region by ping from Pakistan: UAE or Bahrain, Singapore, or Mumbai.
- **What was tested:** the `Dockerfile` got a fix (the server bundle is an ES module and needs a `package.json` saying so), verified by running the image's file layout with Node outside Docker. Docker itself could not run on the owner's PC because hardware virtualization is off, so the image build, Compose, Caddy and the certificate are untested.
- Cloudflare's "Workers VPC" and its tunnels are not servers; the owner looked into both.
- After a protocol change the server must be restarted along with any client redeploy: an old server refuses a new client.

## Working method

- **The owner** (Hassan) has no game development experience, decides what the game should be, and expects every basic feature an FPS player takes for granted. Explain things in plain language, recommend rather than list options, and tell him what you added on your own judgment.
- **The main session plans, writes briefs and reviews. Building happens in separate sessions** in their own worktrees: Opus 5.5 for shared simulation, wire format, server rules, netcode and heavy art pipelines; Sonnet 5.5 for menus, HUD, JSON-only server features, tooling and documents. `ROADMAP.md` has the full method and the review checklist. (An older preference, that the main session writes correctness-critical code itself, was replaced by this on 2026-11-14.)
- **Merging and pushing happen only when the owner says so.** He has approved each merge to `main` and each push individually so far.
- **Usage matters.** The owner has hit his usage limit; do not run several large builds on guesses, and do not have builds repeat long real-time checks.
- **Downloads** are approved for CC0 art from Poly Haven, ambientCG, Quaternius, Kenney and KayKit, and (owner, 2026-11-17, for realistic guns, soldiers and sounds) Sketchfab models licensed CC0 or CC-BY (the author credited), Mixamo characters and animations, and Freesound files licensed CC0. **Sketchfab refuses every connection from Pakistan (CloudFront 403 on the site and API, checked from the owner's PC 2026-11-17), so models come from Fab (fab.com, Epic; approved by the owner 2026-11-17): free listings under CC-BY or the Fab Standard License.** Every file is recorded in a `CREDITS.md`. All three new sites need a login, so the owner downloads; sessions give him an exact list. Anything else needs asking.
- **Accounts, sign-ins, payments, DNS and API tokens are the owner's to handle.** Never ask for a token or password.
- **Build sessions can freeze on the Browser pane.** When the owner is away (Remote Control), a build session's `preview_start` waits for an approval he cannot see; two sessions sat there for 7 hours and the main session cannot stop or answer them. Briefs for unattended builds must say: no `preview_start`, no Browser pane or Chrome tools, and never touch ports 8080 or 5173 (the owner's live server); check through tests, in-process tools and Blender renders, and report that nothing was seen in a browser. When the owner is at the PC, browser checks are fine, on a scratch port (8090 and up), one session at a time.
- **Stacking waves on integration branches** (`wave-1`, `wave-2`, `wave-3`: each wave's reviewed packages merged onto the previous one, the next wave cut from it) worked while the owner was away; `main` was merged and pushed only on his word. Those three branches are now in `main` and can be deleted.
- **What only the owner can check:** how it plays with a mouse, how it sounds, how it looks in motion, and frame rate on a laptop without a dedicated GPU.

## Package A (combat core) in detail

Built on `claude/combat-core-c154af`, 2026-11-16. Screenshots: `docs/review/combat-core/`.

- **Defender knife:** described under Rules and the weapon table above. Decisions: the knife sits beside the gun table (`DEFENDER_KNIFE`, `SLOT_KNIFE` = 2) rather than giving `WeaponDef` a kind, so code that walks guns uses `GUN_COUNT` and code that walks slots uses `SLOT_COUNT` (the old `WEAPON_COUNT` is gone, so every consumer was revisited); its timing reuses `stepKnife` with the ghost knife's windup and cooldown; a held attack keeps swinging, like the ghost knife (no trigger edge), but a swing does set the trigger edge so a pistol drawn with the button still held does not fire. HUD: all three slots listed bottom right with the held one highlighted; with the knife, no magazine, reload line or spread ticks. First person reuses the ghost knife model and pose with a draw motion; third person shows the knife in the right hand (`socket_knife`, the defender's material) with no gun pose, and plays the "slash" clip when that player's windup sound arrives.
- **Body-part damage:** zones above. The zone travels in `shot`, `dmg`, `hitconfirm`, `kill`; the hit marker is red for a headshot, light blue and shorter for an arm or leg, and larger for a kill; the death recap says "(headshot)", "(arm shot)" or "(leg shot)"; the kill feed shows the weapon and "(HS)" for headshots.
- **Suppressor option:** room options above; gunshot audience under match flow. Unsuppressed: louder, longer synthesised shots per gun (`synthLoudRifle`, `synthLoudPistol` in `audio.ts`), a star-shaped flash (one mesh, one draw call, from the pooled flashes as before), bare muzzles. Suppressed: the old sound, box flash and models. The model has both muzzle points (`*_muzzle`, `*_muzzle_bare`) so the script that builds it is the one place that knows where each variant's muzzle is.
- **Wire format (protocol 9):** self snapshot grew by 2 bytes (defender knife cooldown, windup) after the guns; `welcome.options`; `shot.zone` and `shot.silent` (the old `shot.head` is gone); `dmg.zone`; `hitconfirm` is now `{ kind, zone?, kill }`; new `kill` message; `DamageKind` lost `headshot`.
- **Screenshots and how they were made** (browser driven by script against `tools/bot.ts`; frames from a Worker clock; time frozen with `app.timeScale = 0` on the frame of interest): real events, not staged: `knife_first_person`, `knife_third_person` and `knife_third_person_swing` (a bot holding slot 3 and swinging; the swing frame frozen 24 frames after its windup sound), all eight gun views `{rifle,pistol}_{suppressed,unsuppressed}_{flash_first_person,third_person_flash}` (real predicted shots, and real bot shots in third person, frozen on the frame of the shot), `lobby_suppressed_option` (a room created by a bot with `--suppressed`, joined without the option), `create_room_checkbox`, `hitmarker_limb_real` (a real server-confirmed leg hit on a strafing ghost bot on Test Map 1; the marker's DOM class was checked to be `limb`), `headshot_kill_feed_real` (a real headshot kill: kill marker and the feed line from the new `kill` message; taken before the owner's 2x head multiplier, when a headshot did 100, so today the same shot would only wound), and `hud_three_slots_knife_zoom` (a crop of the HUD). Nothing in this set was staged by calling the presenter directly.
- **Not verified:** any sound by ear; the flash and swings in motion; the bot never fought back, so no defender was knifed or shot by a player; the death recap with a zone was not seen (it is in the server tests and the code path only); no full match was played; the arm zone was only hit in unit and server tests, not in the browser; frame rate was not measured.

## Package F (hands and animations) in detail

Built on `claude/hands-animations-672638` (from `wave-2`), 2026-11-16; reviewed (the `main.ts` and presenter interface diffs read, four render sheets looked at; the Blender scripts, `viewmodel.ts` and `characters.ts` were not read) and merged into `wave-3`. Reviewer's note from the renders: in the third-person pistol reload sheet the pistol is hard to make out in the hand. Client presentation and art only: no message, no `PROTOCOL_VERSION` change, `git diff wave-2 -- shared/` is empty. 352 tests (8 new). **Nothing was seen running in the game**: the build session was not allowed to open a browser; every look was judged from headless Blender renders in `docs/review/animations/` (see its README).

- **First-person hands** (`tools/blender/viewmodel.py` → `client/public/models/viewmodel_{rifle,pistol,knife}.glb`, 336 + 325 + 447 KB, no new downloads: the SWAT arms and the shipped weapon meshes). Each rig is ONE skinned mesh (sleeves, gloves, the weapon and its moving parts), so a gun in hand is still one draw call (plus the muzzle flash while firing, as before) and the knife one. Rifle and pistol rigs sit where the bare gun sat (origin = grip at the hip pose), so aiming, draw, kick and sway in `presenter.ts` move them unchanged; the knife rig hangs from the camera. Defenders get orange sleeves and coyote gloves, ghosts a dark suit (the knife file holds both meshes; one is shown). Until a rig loads, or if it fails, the old bare model or boxes stand in.
- **Clips are sampled, not played** (`client/src/viewmodel.ts`): the reload clip is posed at `reload progress × length` every frame, so it follows the predicted reload exactly and snaps away if it is cancelled; the knife swing's windup is stretched to the rule's windup and the rest plays in real time. Rifle reload 2.2 s: magazine out 0.3 s, new one seated 1.4 s, cocking knob (a generated knob at the front left of the receiver) pulled 1.9 and released 2.07 s. Pistol 1.4 s: magazine drops 0.15 s, seated 0.7 s, slide pulled 1.0 and released 1.17 s. These are the times of the existing synthesised reload sounds. The procedural reload tilt and jolts remain only for the fallback without arms.
- **Suppressors** are hidden by shrinking the rig's `sup` bone after each sample (no mesh swap, no extra draw call); the tracer and flash start from the rig's `muzzle` or `muzzle_bare` node by the room option. Seen correct in the renders (`fp_*_idle` against `fp_*_idle_suppressed`), not in the game.
- **Reload sound cut-off** (`audio-api.ts`): `reload(pos, isLocal, weapon, id)` remembers each player's sequence; `cancelReload(id)` (called by `main.ts` when the local reload stops early) and `frame` (a remote defender dead, or no longer `reloading` after it had been) fade what is playing in 20 ms and drop what has not started. A reload within 0.15 s of its end is treated as completed and not cut. A remote whose `reloading` flag never shows up within 0.35 s of the sound is treated as already over (snapshots are interpolated about 100 ms behind the sound event).
- **Third person** (`characters.py` → `character.glb`, `characters.ts`): one-handed `pistol` hold and `pistol_shoot`; `reload_rifle` and `reload_pistol` on the upper body from the first frame of `RemoteView.reloading`, time-synced to the rule (layer time set every frame, so locomotion speed does not stretch them) and cut back to the hold if the reload ends early; `knife_hold` and `knife_swing` for the defender knife; ghosts use the same swing. The swing starts on the windup sound (`remoteSwing`, which now covers ghosts) and jumps to its strike on the server's slash event (new `presenter.remoteSlash`, called by `main.ts` for other players' slashes), so it never depends on visibility spikes. The source's "slash" (sword) clip is no longer shipped. Hands stay rigid.
- **Armed crouch:** `characters.ts` leans Abdomen and Chest forward 25 degrees while crouched with a weapon and turns the neck and both upper arms back by the same amount, so the weapon and head stay level (`CROUCH_LEAN`; `review.py` applies the same numbers).
- **Bodies in walls:** the death clip is recentred in `characters.py` (head about 1.3 m behind, feet 0.6 m in front, instead of 1.75 m and 0.1 m), and `client/src/corpse.ts` (`corpseYaw`, tested) turns the body at death toward the nearest direction where four rays at 0.35 m height (head, both arms, feet) are clear of the map's boxes, else the roomiest. The presenter gets the boxes from the new `presenter.setWorld(boxes)` (the array `main.ts` already keeps). Looks only.
- **Draw calls:** first person unchanged (gun rig 1, +1 flash while firing; knife rig 1); third person unchanged (at most 2 per armed player). No per-frame allocation in the new `frame()` paths (sampling writes into the bones in place; clip names are built once).
- **Rebuilding:** `blender --background --factory-startup --python tools/blender/characters.py -- <SWAT.glb> client/public/models/character.glb`, then `--python tools/blender/viewmodel.py -- --swat <SWAT.glb>` (reads `weapons.glb`, so run `weapons.py` first if that changes). `client/src/models.test.ts` checks the files carry every clip the client asks for and that the reload clips are as long as the rules.
- **Not verified:** anything in the running game (no browser was used): how the hands look at real screen sizes and with the real map lighting, aiming with hands, the draw and kick with hands, the reload sync against the sound by ear, the reload cut-off by ear, the knife swing timing against a real slash, a ghost's swing over its walk in a real match, the corpse turning near real walls, and frame rate. The first-person hands are large and close at the bottom of the view (cartoon proportions, thinned and scaled 0.8 in the clips); the pistol's support hand and the rifle's bolt pull read only roughly from the renders. The pistol's one-handed third-person pose and the knife swing were judged at render size only.

## Package G (graphics tiers and effects) in detail

Built 2026-11-17 on `claude/graphics-tiers-875df2` (from `main` at `91e9671`). Client and map art only: `git diff main -- shared server` is empty, no protocol change, 380 tests (8 new in `client/src/graphics.test.ts`). Screenshots and how they were made: `docs/review/graphics/README.md` (headless Chrome with software GL, so frame rate is unmeasured).

**Choosing the tier** (`client/src/graphics.ts`). The one existing control, Settings, "Graphics quality", now offers Auto (default), Low and High (stored values `auto`, `low`, `gpu`; an old stored `low`/`medium` becomes Low and the old default `high` becomes Auto). It **no longer caps the resolution**: both tiers let the adaptive step run between 100% and 50%, which is what actually saves frames on a slow GPU; `?res=` still pins it. Auto decides from the GPU's name first (Intel HD/UHD/Iris, AMD "Radeon Graphics"/Vega APUs, phone chips and software renderers are Low; GeForce/RTX/GTX except MX, Radeon RX, Intel Arc are High) and only for an unknown chip measures: 2.5 s of an 8-layer full-screen load drawn behind the menu or loading screen (output is almost exactly the clear colour), High only if the median frame stays under 17.5 ms and the 90th percentile under 22 ms; the result is kept for the browser session. `?tier=low` / `?tier=high` override everything. The tier switches live when the setting changes. "Show FPS and ping" now reads e.g. `60 fps  Low (auto)  9 draws`.

**Low** (`maplook.ts`, same single world pass, same 2 texture reads): a colour grade (contrast around mid grey, saturation, a warm/cool gain) and distance fog computed in the map shader and the sky shader (sky hazes into the fog at the horizon), per map in `LOOK_TUNING` (open-air blue haze on Test Map 1, dusty warm-grey depth haze in Warehouse); the scene fog is set to match for players and weapons. Sharper baked light: Warehouse's lightmap went from 3072² to 4096² and the packer now gives ceilings, undersides and faces wholly above head height half density (pad 4 → 3): **5.1 → 3.2 cm per texel** where players look. Test Map 1 stays 3072² (2.1 cm; it was 1.8 cm before the new wall copings took atlas space). Effects (`client/src/effects.ts`): every tracer, impact, dust puff, spark, glow and bullet hole now goes into three pooled batches (additive, alpha, decal) drawn only while non-empty, from one procedural atlas (no download); caps 160 particles, 48 holes (25 s, fading). Before, every tracer and impact box was its own draw call (a burst added 12 to 18).

**High**: Low plus one `pc.CameraFrame` (linear HDR target, depth prepass, SSAO "combine" at half resolution, bloom, a neutral tone curve without the engine's toe offset, which had darkened the basement far below Low), up to 4 dynamic point lights inside the map shader (flat normals from derivatives; muzzle flashes, the blinking bomb, the explosion) plus one omni light for players and the first-person weapon, blob shadows under living players, up to 256 dark floor stains and cracks as static clutter (one draw call), 480 particles and 160 holes. The map shader writes the prepass's linear depth itself (`PREPASS_PASS`); without the prepass, SSAO saw only the weapon because the viewmodel layer clears depth.

**Effects** (presenter interface first: `setTier`, `setMapLook`, `footstep`, `knifeHit`): muzzle flash (existing meshes, plus High light and glow, plus a smoke wisp), tracer, impact by surface from the map box's category (concrete and wood: dust and chips; metal: sparks; a hole decal on the face), a puff on a player when a shot ends on someone drawn, knife hit (slash arc and puff on the victim, only if drawn), footstep dust under remote players, the bomb's red glow (both tiers) and light (High), and the explosion (fireball, smoke, sparks, scorch decal, High flash light) on `over` + `exploded`. **Information rule:** effects use only events already received; footstep dust and knife hits are drawn only on a player the presenter is drawing this frame, so a ghost that was not sent gets none; under an enemy ghost, dust and the blob shadow are scaled by its shimmer opacity (none under a still ghost).

**Ghost shimmer**, tuned against the baked maps: same opacity curve, but the outermost edge now turns dark, so a running ghost reads as an outline on sunlit concrete as well as in the dark basement (the pale-only rim vanished on bright floors); both ghost shaders now go through the camera's tone map and gamma, so they look the same in both tiers.

**Maps** (definitions only, collision and nav graph unchanged: the rebuilt JSONs equal `main`'s): both get diagonal warning stripes inside each bomb site border (`MapDef.hazard_band`), pale sign panels behind the wall letters, a dark band on every stair riser under the yellow nosing; Test Map 1 also gets alternating step tints and nosing (it had none), yellow edges on the platform, copings on every wall top, cable trays, six wall lamps with baked lights, lane arrows ("A >", "B >") and floor stains; Warehouse gets tyre marks and oil stains, and three yard floodlights. One GPU bake each (Test Map 1 153 s, Warehouse 446 s, RTX 4060).

**Numbers** (`docs/review/graphics/*/drawcalls.json`; draw calls per frame at 1280 x 720, viewmodel included):

| | Today | Low | High |
|---|---|---|---|
| World, no effects (Test Map 1 / Warehouse) | 8 / 9 | 8 / 9 (+1 while bullet holes exist) | 29–31 / 30–32 |
| Per armed player | 2 | 2 | 4 (drawn again in the prepass) |
| Firing a burst (whole frame, Test Map 1 / Warehouse) | 24 / 30–31 | 16 / 19 | 37 / 41 |
| Texture reads per world pixel | 2 | 2 | 2 in the scene, plus about 6–8 per screen pixel in the post passes |
| Post passes | 0 | 0 | depth prepass, SSAO + blur (half res), bloom (5 levels down and up), compose |
| Download, Test Map 1 / Warehouse | 1.31 / 3.30 MB | 1.42 / 3.51 MB | same as Low |

Warehouse's lightmap on the GPU grows from about 48 MB to 85 MB with mipmaps (the cost of the sharper bake; reads per pixel unchanged).

**Decisions taken on my own judgment:** the quality control no longer caps resolution (adaptive resolution does it for both tiers); High is never chosen when unsure; known integrated chips skip the measurement; floor clutter is dark decals only (decals are unlit, pale ones glowed in the dark); effect dust is mid-dark for the same reason; High's tone curve is the neutral curve without its toe; the explosion is drawn from the existing round message, no new event.

**Not verified:** frame rate anywhere (software GL); **the owner should open `https://stillblade.orcavalley.com/?tier=low` on a laptop without a graphics card**, switch on Settings, "Show FPS and ping", and watch the top-left line in a busy firefight on Warehouse: it should stay near 60 fps with `res` absent or high, and say `Low (address)`; then remove `?tier=low` to see what Auto picks (`(auto)`). Also not seen: any effect in motion, footstep dust and knife hits from real events (code path only), the explosion from a real detonation (staged), the bomb glow and light on a real plant, the Auto measurement on a real unknown GPU, High on a real graphics card, dynamic lights on players, and whether the darker ghost edge changes how fair spotting is (needs a real match).

## What to do next

**Waiting for review (2026-11-27): the Trailer Park greybox** on `claude/trailerpark-map-a50e9f` (HANDOFF "Maps", `docs/review/maps/trailerpark/README.md`): a new map, shared nav code (`shared/nav.ts` crouch links), the bots' crouch handling in `server/src/bots.ts`, and checker and builder changes in `tools/blender/`; no protocol change. For the reviewer: read the `shared/nav.ts` and `bots.ts` diffs line by line, run `npm test` (one `datastore.test.ts` case fails on this PC on the branch's base commit too) and `python tools/blender/mapkit.py trailerpark`; the owner plays it before the realistic art package.

**State on 2026-11-19, when the owner moved to a new session (read this first; the bullets after it are older history):**

- **Live:** everything is on `main` (`476e8a7` plus this docs commit), pushed and deployed: protocol 17, 523 tests, typecheck clean. Landed 2026-11-18/19: O with three follow-ups, P (armor), Q (visual and feel polish), R (the M4 pack's motion on the AK, the 2.7 s empty reload, the pack's gloved hands, the defender sleeve from the soldier's shirt), S (loading screen). The game server was found **stopped** on 2026-11-19 (tunnel up, 502 behind it) and was started again from `main` in a PowerShell window titled "Stillblade game server" (command under Hosting); if it keeps dying, find out why.
- **Package T reviewed, merged into `main` and pushed 2026-11-20 on the owner's word; review: tests and typecheck on the branch and on merged `main`, the client diffs read line by line, `git diff main -- shared server` empty, 8 screenshots looked at; reviewer's note: the bare forearms read smooth, pale and plastic and lighter than the soldier's skin (the owner chose to merge as is); 524 tests; no protocol change, so the server needs no restart; the site redeploys from the push** (see "Package T" at the end; pictures in `docs/review/m4/`). The plan it followed:
- **Package T, the M4 everywhere** (ROADMAP "T"). The owner's reasoning, agreed with the main session: first person looked plain because its arms were cut from the third-person soldier, a model made to be seen small and far away, and because the M4's motion was fitted onto a different gun. Decided:
  1. Third person keeps our Quantum soldier.
  2. First person never takes arms from the soldier again: it uses dedicated arms. For the rifle that is the M4 pack's own arms, M4 and animations, used exactly as authored.
  3. The rifle becomes the M4 in both views (what you hold is what others see), replacing the AK-105; game rules unchanged; our red dot and 2x scope move onto the M4.
  4. Pistol and knife stay as they are (with the pack's hands) and are **on hold** until the owner picks a matched pack (package V).
- **Package V part 1 (the knife from the owner's "Knife FPS Animations" pack) built 2026-11-20, reviewed, merged into `main` and pushed 2026-11-20 on the owner's word (review: tests and typecheck on the branch and on merged `main`, the client diffs read line by line, `git diff main -- shared server` empty, 4 screenshots looked at; reviewer's note: the defender's knife arms wear orange camouflage sleeves while the M4 shows bare forearms); no protocol change, no server rebuild needed.** The knife in both views for both teams is the pack's karambit; first person uses the pack's own hands, skeleton and clips as authored (idle, quick draw, four chained swings), drawn with the pack's own 34.5-degree view; coyote gloves and orange sleeves for defenders, dark for ghosts; the pack's swing recordings are the slash sound. The pistol stays on hold. See "Package V part 1" at the end; pictures in `docs/review/knife/`.
- **Paused: package U, the character lab** (`/v2_character`): a standalone page with the soldier, rifle, pistol and knife, every view (first person as in the game, third person with orbit), every animation with play/pause/speed/scrub, debug overlays, a "current vs candidate" side-by-side, no map. Branch `claude/character-lab` holds shared groundwork only (`54b2dd6`, no game change, and `ffd56f7`, `docs/review/lab/STATUS.md` with what is left). Resume it when the owner has new assets; the full brief is in that session and summarised in ROADMAP "U".
- **Buying art (owner):** send the links to the main session before buying. What to look for is in ROADMAP's decisions ("How to choose art packs"). Candidates already seen: Bugrimov's "FPS Pistol And Knife Animations" ($34.99, Unity/Unreal: ask the seller whether FBX animations are included), the free "Knife FPS Animations" (karambit), KINEMATION's "Tactical FPS Shooter Pack" ($99.99, has an AK-105, no knife; set aside).
- **For the owner to do or check:**
  - Frame rate on his laptop: compare `?tier=low` with `?tier=low&aa=0` (package Q's 4x anti-aliasing cost on integrated graphics is unmeasured).
  - Play: armor balance (rifle torso now 6 hits, pistol limbs 15, ghost front stab 4); how package Q's bob, sway, landing and recoil feel; whether the 1.75x-speed draw looks rushed; the loading screen on a slow connection.
- **Housekeeping (done 2026-11-20 on the owner's word):** every merged worktree under `.claude/worktrees/` and its branch is deleted. Left: `character-lab` (paused, package U), the knife build's worktree (package V part 1), and two unmerged branches kept without worktrees because this file cites their write-ups: `claude/bomb-carrier-f5f825` and `claude/rooms-community-46c9f3`. The source art that package R's worktree held is complete in the main checkout's `tools/blender/source-art/` (only extracted and build folders differed). The owner's reference stills from package O are in the git-ignored `docs/review/viewmodel/reference/`. An empty `m4-everywhere-465728` folder may remain until the idle package T session is archived.
- **Sessions:** no build session is running. The ones used on 2026-11-18/19 (O, P, Q, R, S, lab) are idle; a new main session does not need them, since this file and ROADMAP hold everything.

Follow `ROADMAP.md`. **State on 2026-11-17, when the owner moved to a new session:** everything through wave 4 is built, reviewed, merged into `main` and pushed: waves 1 to 3 (packages A to F), G (graphics tiers and effects), L (menus and settings redesign plus a scoreboard ping column, protocol 14) and H (recorded sounds). 415 tests, protocol 14. No build session is running and no branch is waiting for review; the old worktrees and branches under `.claude/worktrees/` are all merged and can be deleted when the owner says so. **The game server on the owner's PC must be restarted from `main` to match protocol 14** (start command under Hosting).

- **Package M part 2 (2026-11-18, realistic AK-105, Makarov, knife, red dot, a generated 2x scope; no protocol change): merged into `main` on the owner's word 2026-11-18 after a hip-pose fix; pushed 2026-11-18.** Review: `git diff main -- shared server` empty; the build's numbers read (Low download 3.15 MB, one draw call per gun in hand); about 10 screenshots looked at, which found the canted hip pose (fixed in `34d439e`); tests and typecheck run on the branch and on merged `main` (457 with package N). The first-person arms are still the cartoon SWAT arms (package O). The 2x scope model still needs the owner's download ("AR Scope (Game-Ready)" by Scape into `tools/blender/source-art/realistic/scope2x/`). See "Package M part 2" at the end.
- **Package M part 1 (2026-11-17, protocol 15): merged into `main` on the owner's word; pushed 2026-11-18 with the server restarted on protocol 15.** Rifle sights (iron, 1x red dot, 2x scope) chosen in a Loadout page and mounted at the next spawn, and the stuck-aim fix. Review: the shared, protocol, server and input diffs were read line by line; tests (447) and typecheck run on the branch and on merged `main`; two of 19 screenshots looked at. Reviewer's notes: the 2x scope blacks out everything outside its circle like a sniper scope, which should become an ACOG-style sight picture with part 2's real model; the warmup respawn edge (Known problems) predates this package. Part 2 waits for the owner's downloads. See "Package M part 1" below.
- **Package N (real gunshots and breathing, 2026-11-18): merged into `main` on the owner's word 2026-11-18, pushed 2026-11-18; client audio only, no protocol change, 453 tests.** Review: `git diff main -- shared server` empty, `audio.ts` diff read (breathing keeps distance gain, occlusion, panner; recorded breaths add one source and gain node per breath, every couple of seconds per ghost), variant files checked distinct, tests and typecheck run on the branch and on merged `main`. The owner's sound files live in `tools/blender/source-art/realistic/sound/` in the main checkout; `tools/process-audio.mjs` reads `tools/audio-source/freesound/`, so copy them there before re-running it. Real AK-47 recordings (Freesound, CC0) are the gunshots, with a distant tail and filtered suppressed versions; the pistol is still an AK stand-in until the owner downloads real pistol files; ghost breathing is two real recordings cut into single breaths; hurt stays synthesised. Nothing has been listened to. See "Package N" below.
- **Package O (2026-11-18, realistic soldiers and stealth ghosts, real first-person arms, the downloaded AR Scope; no protocol change): built on `claude/realistic-soldiers-bcc8fb`, NOT reviewed or merged.** For the reviewer: `git diff main -- shared server` is empty; read `client/src/characters.ts`, the character part of `presenter.ts` (`loadCharacters`) and `weapons.ts` (`character()`), then `tools/blender/soldier.py` and `clips.py`; look at `docs/review/soldiers/`. The owner should look at the soldiers in a match and check Low's frame rate on his laptop. See "Package O" at the end.
- **Recommended next step:** the owner plays and listens to waves 3 and 4 before any new package is built; his findings come first and will likely change the briefs for K, I and J.
- **How wave 4 was built (it worked; repeat it):** the main session started each build with a self-contained brief, in its own worktree, with no Browser pane; builds checked their screens with headless Chrome driven by script on scratch ports (8090 and up for the server, 5190 and up for Vite; `tools/graphics-shots.mjs` and `tools/sound-check.mjs` are examples). Follow-ups went to the same build session. Parallel packages were told which files the other owned and merged simulation-side first.
- **Downloads from kenney.nl cannot be scripted** (the site answers 403 and build sessions must not work around it): the owner downloads packs by hand and unzips them into the git-ignored `tools/audio-source/` (one folder per pack). The five audio packs he fetched on 2026-11-17 are in `tools/audio-source/` of the main checkout (copied from the package H worktree), so `node tools/process-audio.mjs` can be re-run there; a fresh worktree does not have them.
- **Package H (recorded sounds) is also on `main` (415 tests, no protocol change, pushed 2026-11-17):** reviewed by tests, typecheck, the interface and entry-point diffs and the credits table; `audio.ts` and `soundtest.ts` were not read line by line and nothing has been listened to. The owner listens at `https://stillblade.orcavalley.com/?soundtest=1` with headphones (checklist in "Package H" below). Gunshots are still the synthesised shot under a recorded thump: a real gunshot recording needs the owner to approve another CC0 source.
- **Left to build:** K voice chat (can start; a paid relay is the owner's call), I grenades (the owner must confirm the design first), J accounts (needs the always-on server, which the owner sets up).
- **Review of wave 4 (main session):** tests and typecheck run on both branches and on `main` after each merge; L's protocol, server and presenter diffs and G's `maplook.ts`, `main.ts`, `settings.ts` and interface diffs were read; about 11 of 90 screenshots looked at. Not read: G's `effects.ts`, `graphics.ts` and most of its `presenter.ts` changes, L's `ui.ts` and `community-ui.ts`. Nothing of wave 4 has been seen on a real GPU, in motion, or with a mouse.
- **For the owner to check by playing:** frame rate on a laptop with `?tier=low` (Warehouse's lightmap now takes about 85 MB of GPU memory instead of 48); whether High's muzzle-flash light is too strong (it tints a whole lane yellow in the screenshot); whether the darker ghost outline changes how fair spotting is; the Vote out button with a real mouse; ping values through the tunnel (only 1 to 5 ms on the same PC were seen). The before/after stills of G differ only modestly.
- **The lag report (2026-11-17, "so much lag" from his office against the server on his home PC):** the owner says it is most probably his home internet, which he knows is bad. Not measured. The scoreboard Ping column (package L) now shows it per player; the real fix is the always-on VPS.
- **Open:** the first-person rifle hands (package F) show spiky fingers in G's screenshots; ghost bots almost never win a round against defender bots on normal or hard; the server should run with `SB_TRUST_PROXY=1` behind the tunnel. The wave 2 gaps "FIRST TO 6" and the missing vote-kick button are fixed by package L.
- The owner's own play and the friends test can happen at any time and should feed back into tuning.

## Package L (menus and settings) in detail

Built on `claude/menus-redesign-bad369` (from `main` at `91e9671`), 2026-11-17. Client UI plus one added feature (scoreboard ping, below) that bumps `PROTOCOL_VERSION` to 14; apart from that `git diff main -- shared server` is empty. 383 tests (7 new in `client/src/menu-logic.test.ts`, 4 in `server/src/ping.test.ts`), typecheck clean.

- **Home page.** `showMenu` (`client/src/ui.ts`) is now a short screen: the name field, then Quick play (the primary button), Rooms, Practice range, Settings, How to play. An invite link (`?room=`) adds a primary "Join <code>" button above Quick play. Each choice opens its own page; Back or Esc goes back one page (`PageNav` in `client/src/menu-logic.ts`, pure, tested); Esc on the home page does nothing. The how-to page opens first on a first visit (the `sb-howto` flag, set by "Got it" or by joining) and is reachable any time from the home page.
- **Rooms page.** The public list as a table (room code, map, players with bots named, capacity, lobby or match score) with Refresh and a Join (or Full) button per row, an empty state with a "Create a public room" shortcut, an error state with "Try again", a "Join by code" box (Enter submits) and a primary "Create room" button. `roomListView` is in `client/src/community-ui.ts`.
- **Create room page.** "Who can join": Private (default) or Public as two big side-by-side choices, then map, most players (2 to 10), rounds to win (3, 6, 9), suppressed weapons, fill with bots, bot skill (disabled until fill is on). The button reads "Create private room" or "Create public room". **The lobby uses the same function (`optionControls`) in the same order**, so the creator edits the same fields in warmup (the map is shown as a fixed name there, because the server only changes maps by the vote); other players see the same grid read-only (`optionSummary`, order from `describeOptions`, tested). The old chips (`optionChips`) are gone.
- **Practice page.** Map, side as a two-way choice (defender or ghost), Start.
- **Settings in four tabs** (General, Controls, Video, Audio), one panel built once (`renderSettings`) that lives in the menu's Settings page before a match and in the in-game settings screen during one, so both always show the same thing. Every setting is in exactly one tab: General (show FPS and ping, send feedback when in a match, "Reset to defaults"), Controls (mouse sensitivity, aim sensitivity, invert vertical, hold or toggle for crouch, quiet walk and aim, the key bindings list that scrolls inside its tab, "Reset controls to defaults"), Video (graphics quality as one self-contained block `qualityControl` for package G, field of view, crosshair style, colour, size), Audio (master, effects, footsteps). The panel is a fixed 620 px tall card; no tab needed a page scroll at 1366x768 (checked by script). Rebinding code (`onCaptureKey`, `onCaptureMouse`, conflict swap) is untouched. Arrow keys move between tabs.
- **The old Controls page is gone.** It only repeated the bindings list plus three fixed inputs; the pause menu's "Controls" button now opens Settings on the Controls tab, and the fixed inputs (mouse look, wheel, Esc) are named in the tab's help line.
- **FIRST TO N.** `MatchView.roundsToWin` (new field, `presenter-api.ts`), filled from the welcome's options and updated by the options message in `main.ts`; `presenter.ts` reads it for the scoreboard title (the `ROUNDS_TO_WIN` import there is gone). Seen as "FIRST TO 3" in a room created with `rounds=3`.
- **Vote-kick on the Tab scoreboard.** New `Presenter.setVoteKick(kick | null)`; `main.ts` sets it from `Ui.canVoteKick` (`canCallVoteKick`, tested: three or more people, bots not counted, no vote running) after every roster and vote change. Rows of other human players get a small "Vote out" button that sends the existing `votekick` message. **Limit that matters: the scoreboard is shown while Tab is held and the mouse is captured, so in normal play the buttons cannot be clicked** (they work when the pointer is free, as in the headless run; the pause menu's player list, which already had "Vote out", is the way to do it in practice). A real fix needs a mouse-free scoreboard mode (for example a toggle key), which is a design decision for the owner. G owns `presenter.ts`: my edits there are the import, the title line, one cache variable, the button in `renderScores`, `setVoteKick`, and one CSS rule.
- **Look.** One panel style for every page, one primary button per page, secondary buttons plain, `color-scheme: dark` for scrollbars and checkboxes, visible keyboard focus everywhere (including the new tabs and two-way choices), room list and options collapse to one column below 640 px.
- **Decisions I took on my own.** The home-page invite button instead of landing on the Rooms page; the first-visit how-to as a page instead of a side card; the in-game and menu settings sharing one element; the Controls page folded into the tab; no "hit sound" setting (none exists; the Audio tab has the three volumes); the player name is not a setting (it is on the home page and fixed once in a room); Quick play still passes the chosen map (as before).
- **Verified** in headless Chrome (software GL, scratch ports 8090 and 5190, driven over the DevTools protocol; the owner's 8080 and 5173 were not touched): every page and every settings tab at 1366x768 and 1920x1080 (`docs/review/menus/`, files `<width>-NN-<page>.png`); first visit lands on the how-to, "Got it" goes home, Esc steps back page by page, create form defaults to Private, Public changes the button, bot skill enables with fill on; each settings tab fits its card at both sizes; rebinding Reload to V then "Reset controls to defaults" back to R in the menu; a private room made from the form is not listed and a public one is (list shows 1 row, then Join lands in its lobby); creator's and joiner's lobby panels; the pause menu and in-game settings on the Controls tab, Esc returning to the pause menu; the invite home page; "FIRST TO 3"; the scoreboard's vote buttons with three people, a click starting a vote (banner on the other clients), and the buttons disappearing while it runs. 
- **Not verified.** Real pointer lock (so the scoreboard buttons by mouse in play, Esc as pause, the mouse released for menus), the phone notice, `sb-rejoin` after a dropped connection (code untouched, not run), `?auto=1` runs of the practice range and Quick play from the new buttons (the choice they return is built exactly as before; only the lobby and room pages were joined), the feedback panel from the General tab, the map vote on the result card (untouched), a real person using the keyboard only, a real touch screen, and the look on a real GPU. Several game pages at once lose their WebGL context in software GL (as in earlier packages); the flows were run with `?res=0.3` and one or two game pages at a time.
- **Scoreboard ping column (protocol 14; the server must be restarted together with the client).** New JSON message `{type:'pings', pings:[[playerId, ms], ...]}` (`PingsMsg`, `PING_MAX` 999 in `shared/protocol.ts`), a separate message rather than a roster field so the roster is not re-sent every few seconds. `server/src/main.ts` sends a WebSocket ping to every connection every 2 s (one outstanding at a time) carrying a 4-byte token (`PingProbe`, `server/src/ping-probe.ts`); only a pong echoing that token gives a sample, so the keep-alive heartbeat's own pings and pongs are never mistaken for it. The sample goes to `Game.setPing`; `smoothPing` (`server/src/game.ts`) keeps about the last three samples, whole milliseconds, 0 to 999; every 3 s each room's `Game.sendPings()` broadcasts every measured human (bots and unmeasured players are absent). Transport measurement only: no rule, timer or snapshot reads it, and the binary formats are unchanged (`prediction.test.ts` passes). A client cannot set it: no client message carries a ping (tested that `decodeClient` rejects `pings` and `ping`). Client: `Presenter.setPings`, a right-aligned PING column on both teams on the Tab scoreboard, "BOT" for bots and "-" until measured. The Vote out button sits in its own grid column inside the panel (empty for yourself and for bots); screenshot `docs/review/menus/1366-15-scoreboard-ping-and-vote-out.png`. Seen in headless Chrome against the scratch server (localhost reads 0 to 5 ms); real internet values were not seen.

## Package H (recorded sounds) in detail

Built on branch `claude/recorded-sounds-3cfd34` (client audio only: `git diff main -- shared server` is empty, `PROTOCOL_VERSION` stays 14, 415 tests, typecheck clean). **Nothing here has been listened to by anyone.** Everything below was checked by script, by measurement and by reading. The owner's ears are the missing half.

### What changed

- `client/src/audio-logic.ts` (new, pure, tested): the sample manifest (`SAMPLE_SETS`, 53 files), `pickVariant` (never the same file twice running), the fallback rule `useRecorded`, `stepVariation` (level and pitch of a footstep), `surfaceUnder` (which surface a step is on), the reload cue times, and `SAMPLE_GAIN` (the per-set mix knobs).
- `client/src/audio.ts`: every event is now a `Synth` wrapper that plays a sample when `Voice.pick` finds one and the old synthesised sound otherwise. Distance, HRTF, wall muffling, ranges, volumes, voice stealing and the breathing loop are untouched (`breathDistanceGain` has tests that pin its curve; 8 m range unchanged). Gunshots are the synthesised shot with the recorded sample layered over it. Reloads play three recorded parts at 0.3 / 1.4 / 1.9 s (rifle) and 0.15 / 0.7 / 1.0 s (pistol), all in one voice, so `cancelReload` cuts them off exactly as before. A reload is all recorded or all synthesised (never half and half).
- `client/src/audio-api.ts`: added `uiClick()`, `whenLoaded()`, `sampleStatus()`, `setSoundMode()` (test page only), and an optional second argument to `createAudio` (`context`, `loadDelayMs`) used by the test page and the measuring script. `step`, `impact` and the rest keep their signatures: the surface is found inside the audio layer from the map boxes it already holds (steps: the box whose top the feet stand on; impacts: `faceAt`, the same lookup package G's decals use; concrete when nothing is found).
- Loading: after the first `unlock()` (a click or key press) the engine waits 1.5 s, then fetches and decodes the files six at a time in the background. A file that is missing, answered with an HTML page by a dev server, or will not decode is skipped and its sound stays synthesised. Nothing blocks the loading screen.
- Every `<button>` in the game now makes a quiet click (`main.ts`: one document-level listener calling `audio.uiClick()`).
- `client/src/entry.ts` (new) is the page's script: `?soundtest=1` loads `client/src/soundtest.ts`, anything else loads `main.ts` as before. `index.html` points at `entry.ts`.
- Tools: `tools/process-audio.mjs` (raw packs to shipped files; needs ffmpeg), `tools/audio-map.json` (which raw file becomes which sound; a test checks it names exactly the manifest's sets), `tools/sound-check.mjs` (level measurements and the screenshot in headless Chrome). Raw packs live in `tools/audio-source/` (git-ignored), one folder per unzipped pack.

### Format and size

Mono MP3, 64 kbit/s, 44.1 kHz, trimmed of leading silence, cut to a per-sound length with a 30 ms fade, peak-normalised to -4.5 dBFS. MP3 because every current browser decodes it (Ogg Vorbis only arrived in Safari 18.4). **53 files, 138,076 bytes (134.8 KiB) in all**, well under the 1.5 MB aim, plus `client/public/audio/CREDITS.md` (every file, its Kenney pack and original file, CC0, what was done). Re-run `node tools/process-audio.mjs` to rebuild everything; it also rewrites CREDITS.md.

### Every event: sample or synthesised, and why

Packs used: Impact Sounds (IS), RPG Audio (RPG), Interface Sounds (UI), Digital Audio (DA), Sci-Fi Sounds (SF). All CC0. Sizes are per file in bytes (variants listed as n x size).

| Event | Sound | Source and size |
| --- | --- | --- |
| Footstep, concrete | recorded, 4 variants | IS `footstep_concrete_000..003`; 1.3-1.5 KB each |
| Footstep, wood | recorded, 4 | IS `footstep_wood_000..003`; 2.6-2.8 KB each |
| Footstep, metal | recorded, 4 (**a stand-in**) | IS `impactPlate_light_000..003`, slowed to 0.9x and low-passed at 7 kHz; the packs have no metal footstep, so this is a plate knock; 3.0 KB each |
| Own footsteps | same sets, quieter (`0.3` base level as before) | as above |
| Bullet impact, concrete / metal / wood | recorded, 3 variants each | IS `impactMining`, `impactMetal_medium`, `impactWood_light`; 1.5-2.8 KB each |
| Gunshot, unsuppressed rifle / pistol | synthesised shot **plus** recorded layer, 2 variants each | IS `impactPunch_heavy` (rifle, slowed 0.8x) and `impactPunch_medium` (pistol); 4.2 KB and 3.4 KB each |
| Gunshot, suppressed rifle / pistol | synthesised shot **plus** a quiet recorded layer | IS `impactSoft_heavy_000` and `impactSoft_medium_000`; 2.6 KB, 1.5 KB |
| Reload, rifle (out, in, bolt) | recorded, 3 parts | RPG `metalClick`, RPG `metalLatch`, IS `impactMetal_heavy_000`; 2.6 / 2.8 / 1.9 KB |
| Reload, pistol (out, in, slide) | recorded, 3 parts | RPG `metalClick` and `metalLatch` sped up 1.1x, IS `impactMetal_light_000` sped up; 2.1 / 2.6 / 2.6 KB |
| Knife windup | recorded | RPG `drawKnife1`; 3.0 KB |
| Knife slash (miss / hit) | recorded slash, 2 variants; hit adds a recorded hit at +50 ms, 2 variants | RPG `knifeSlice`, `knifeSlice2`; IS `impactSoft_heavy_000..001`; 3.0 / 2.6 KB each |
| Bomb planted announcement | recorded | DA `threeTone1`; 6.7 KB |
| Bomb beep (the ticking) | recorded | DA `tone1`; 1.5 KB |
| Bomb defused | recorded | DA `highUp`; 3.8 KB |
| Bomb exploded | recorded | SF `explosionCrunch_000`; 6.7 KB |
| Bomb dropped / picked up | recorded | IS `impactSoft_heavy_000` (3.0 KB); RPG `beltHandle1` (2.8 KB) |
| Hit marker body / head / kill | recorded | UI `tick_001` (0.9 KB), `tick_002` (0.7 KB), `confirmation_001` (3.0 KB) |
| Dry fire | recorded | RPG `metalClick`; 1.5 KB |
| Weapon switch rifle / pistol / knife | recorded | RPG `handleSmallLeather2`, `handleSmallLeather`, `drawKnife1`; 2.6 / 3.0 / 3.0 KB |
| UI click | recorded, 2 variants | UI `click_001`, `click_003`; 1.3 / 0.7 KB |
| Ghost breathing | **synthesised** | none of the packs has a breath; the loop is shaped per exertion in real time and its distance curve is pinned by tests |
| Hurt | **synthesised** | no suitable sound in the packs (a felt-not-heard thump) |
| Round start, round won, round lost | **synthesised** | short melodic cues; Kenney's Digital Audio could do them if the owner dislikes the synthesised chimes |
| Gunshot body itself | **synthesised under the layer** | the five packs contain no gunshot (impact punches and thumps only); a real recording needs an approved source (Kenney's separate "Shooting Sounds" or similar is not in the five packs the owner supplied) |

### Measured levels (not heard)

`node tools/sound-check.mjs` renders each event through the real engine (HRTF, wall, compressor, volumes) into an `OfflineAudioContext` and prints peak and RMS in dBFS. Straight ahead, listener standing, run of 2026-11-17 (the synthesised sounds use random noise, so repeat runs differ by about 3 dB):

| Case | Synthesised peak | Recorded peak |
| --- | --- | --- |
| Running step, concrete, 1 m / 5 m / 10 m / 15 m / 17.5 m | -19.6 / -21.1 / -23.6 / -32.8 / -48.5 | -22.1 / -22.8 / -26.1 / -33.7 / -50.0 |
| Walking step 2 m / 5 m (5.4 m is its limit) | -25.5 / -41.1 | -28.6 / -44.8 |
| Crouched step 1.5 m / 3 m (3.2 m is its limit) | -28.6 / -42.5 | -30.1 / -48.8 |
| Running step 5 m: metal / wood / behind a wall | -18.6 / -20.1 / -29.1 | -22.6 / -17.4 / -30.9 |
| Rifle, unsuppressed, 5 / 20 / 50 / 59 m | -11.7 / -15.3 / -27.8 / -46.1 | -10.9 / -11.2 / -21.1 / -43.4 |
| Rifle, suppressed, 5 / 15 m | -23.8 / -34.2 | -22.7 / -33.4 |
| Pistol unsuppressed / suppressed, 5 m | -14.4 / -27.0 | -12.2 / -25.2 |
| Rifle reload 3 m / 9 m | -5.8 / -25.7 | -6.3 / -23.3 |
| Knife windup 5 m / 13 m | -8.4 / -27.3 | -10.0 / -28.1 |
| Bullet impact 5 m / 20 m | -31.6 / -42.7 | -26.9 / -37.7 |
| Bomb beep 10 m / 30 m | -11.5 / -25.5 | -10.6 / -24.8 |

Reading it: a recorded running step at 5 m is about 11 dB louder than at 15 m and silent at the 18 m limit; a wall costs about 8 dB; an unsuppressed rifle shot at 50 m is about 10 dB below the same shot at 5 m and fades to near silence by 59 m; a suppressed rifle shot sits about 12 dB below an unsuppressed one at the same range (the first mix put the suppressed layer 10 dB too hot, so `SAMPLE_GAIN` pulls the gun layers, impacts and reloads down and the knife windup up; these gains are measured, not heard). Footsteps peak around -22 dBFS while a gunshot peaks around -11: that 11 dB gap is the same as it was synthesised, and is the number to judge by ear.

### What the owner should listen for

Open `http://localhost:5173/?soundtest=1` (or the same query on the hosted address) with headphones on, click anything once (the browser needs a click), and wait for the status line to say 53 of 53 loaded. No server and no map are needed. In order of importance:

1. **Can a defender tell where a ghost is?** Set Step to run, then walk, then crouch; Distance 3, 6, 10, 15 m; Direction front, left, right, behind. Press "Six steps in a row". Judge: can you point to it with your eyes shut, and can you tell run from walk from crouch by sound alone (running should be clearly the loudest and brightest; walking audible only to about 5 m; crouching only to about 3 m)? Try all three surfaces; metal is a stand-in (a plate knock) and the most likely to need replacing.
2. **Breathing** (it is still synthesised): switch on "Ghost breathing" at 2 m, 5 m and 8 m, standing and running. It should be unmistakable at 2 m, faint but findable at 5 m, barely there at 8 m, and gone beyond. Tick "Behind a wall": it should get duller and quieter.
3. **Gunshots**: Suppressed off, rifle shot at 5 m and 50 m: loud and punchy but not painful, a clear fade by 60 m. Suppressed on: much quieter, gone by 20 m. Untick "Gunshot layer" to hear the old synthesised shot alone and decide which you prefer; the layer is only a thump over the old shot because the packs contain no gunshot. If neither is convincing, a real gunshot recording is the single most valuable sound still missing, and it needs the owner's approval to download.
4. **Reloads against the animation**: Rifle reload then Pistol reload: three clicks and clunks at 0.3 / 1.4 / 1.9 s and 0.15 / 0.7 / 1.0 s. Then in a practice match watch your own reload (R) and the first-person hands: does the magazine click when it comes out, clunk when it goes in, and clack with the bolt or slide? "Reload, cut off after 1 s" must go completely silent at once. The files are trimmed at the start but their internal timing was never matched to the animation by eye or ear.
5. **Harsh, too quiet or too alike**: hit markers (body, head and kill should be three clearly different ticks), UI clicks (quiet, not annoying after fifty), knife windup versus slash (the windup must stand out as a warning), bomb beep (ticks at 1 s, speeding up), explosion, impacts on the three surfaces (concrete and wood should differ), "Five impacts" and "Six steps" (variants should not sound like a machine gun of the same sample). Untick "Recorded samples" to compare every sound with the old synthesised one.
6. **In a match** (practice range with bots is enough): can you hear a bot ghost behind a wall; do your own footsteps stay subdued; is anything missing or startlingly loud when many things happen at once?

If a sound is too loud or quiet, the knob is `SAMPLE_GAIN` in `client/src/audio-logic.ts` (one number per sound set, 1 = as normalised). If a sound is the wrong one, change its patterns in `tools/audio-map.json`, run `node tools/process-audio.mjs`, and `tools/sound-check.mjs` will print the new levels.

### What was not verified

- Nothing was heard, ever. The mapping of raw files to events was chosen by file name and by duration and level measurements, not by listening.
- Whether the recorded reload parts line up with the animation, and whether the metal-footstep stand-in sounds like metal.
- Safari and Firefox (decoding MP3 through `decodeAudioData` is standard, but only Chrome was run). iOS is not a target.
- Loading inside a real match was not timed; the test page's own engine loaded all 53 files (checked by script), and the game boots with no console errors at `?auto=1` against a scratch server. The game's own `audio` instance reaching "53 of 53" in a live match was not checked.
- Level numbers come from an offline render of one event at a time at the listener's feet, standing, straight ahead; many overlapping sounds and the player's volume sliders were not measured.
- Voice stealing (24 voices) was left unchanged; recorded sounds hold a voice only as long as the sample (0.1 to 2 s).

## Package N (real gunshots and breathing) in detail

Built on branch `claude/recorded-sounds-2-8c2c8a`, client audio and tools only (`git diff main -- shared server` is empty, protocol unchanged, 453 tests, typecheck clean). **Nothing here has been listened to by anyone.** Levels were measured with `tools/sound-check.mjs`; the cut points came from waveforms, not ears.

### What changed

- **Sources (all CC0, Freesound; raw files in git-ignored `tools/audio-source/freesound/`, credited per file in `client/public/audio/CREDITS.md`):** 136399 felixblume (close AK-47 at a range; single shots cut out, wind avoided), 520934 ninebilly (one shot), 855843 serutonin-deprivd (the distant tail), 767046 ThabzMalik (exerted breathing, 3 cycles), 361869 Unstoppable0 (calm breathing, 4 cycles). 520935 (ninebilly burst) is present but **unused**: its shots are about 30 ms apart in one block and cannot be cut into single shots.
- **Gunshots (`audio.ts`, `recordedShot`):** the recorded shot is now the whole sound. Rifle: 5 close variants (4 from 136399, 1 from 520934 turned down 8 dB because it is much denser than the others), 2 distant variants (855843 and a low-passed 136399 shot). The close/distant mix is `gunBlend` in `audio-logic.ts` (equal power; all close up to 8 m, all tail from 80 % of the range, a 10 % whisper of the tail up close); the fade to silence at 60 m / 20 m is still the voice's distance panner, unchanged. Variants never repeat back to back; every shot has about +-1 dB and +-4 % pitch variation. **Suppressed** = the same shots high-passed at 80 Hz, low-passed at 1.6 kHz, 0.22 s long, 4 ms fade-in (2 variants), about 14 dB under the loud shot at the same distance. **Pistol is a stand-in:** the AK shots sped up 1.4x (higher, shorter), high-passed at 150 Hz, 0.3 s; its distant tail is 855843 sped up 1.3x.
- **Breathing:** the two recordings are cut into one breath cycle per file. Per ghost, every cycle picks the next breath at random (never the one just played), calm with probability 1 - exertion and exerted with probability exertion, so a ghost that starts running turns from calm to panting breath by breath, not as two overlapping people; level (x1.0 to x1.5), the pause between breaths (0.45 s down to 0.1 s) and playback rate (up to +8 %) also follow exertion (`pickBreathSet`, `breathLevel`, `breathGap`, `breathRate`). Recorded breaths enter after the synthesis filters, straight into the existing occlusion, fade, `breathDistanceGain` and HRTF panner stage, so all of those are untouched (the `breathDistanceGain` tests pass unchanged; 8 m range unchanged; per-ghost random phase and fade in/out kept). It costs one source and one gain node per ghost every 2 s or so.
- **Fallback:** a missing or undecodable file falls back to package H's sound (synthesised shot under the old thump; synthesised breathing). Breathing uses recordings only when both breath sets are loaded.
- **Hurt stays synthesised:** neither breathing file holds a usable grunt (they are breaths; a sigh when hit would read wrongly and could not be judged without listening).
- **Sound test page (`?soundtest=1`):** new checkbox "New recordings (guns, breathing)": off plays package H's versions for comparison ("Old gunshot layer" then picks the synthesised shot with or without the thump). The old Kenney thumps are kept as sets `thump_*` (16 KB) for exactly this. The ghost selector now offers calm / half exerted / running.
- **Tools:** `tools/process-audio.mjs` gained `cuts` (several cuts from one long file), `prefer` (a real pistol recording wins over the stand-in when its files exist), `hp`, `denoise`, `fadeIn`, `fade`, `headroom`, and Freesound credits. `tools/sound-check.mjs` measures breathing and averages gunshots over 6 random variants; `--only gun|breath` and `--grep <regex>` select cases.
- **Size:** 75 files, 318.6 KiB for all audio (the 53 old files are byte-identical; 22 new).

### Measured levels (not heard)

Peak / RMS in dBFS at the listener (3 s render, loudest peak and mean RMS of 6 random shots), straight ahead, standing; "H" is package H's sound, "N" the new recording, same run:

| Case | H peak | N peak | N RMS |
| --- | --- | --- | --- |
| Rifle loud 5 / 20 / 35 / 50 / 59 m | -7.8 / -9.7 / -13.8 / -23.2 / -42.9 | -7.7 / -9.6 / -15.4 / -24.9 / -45.0 | -34.5 / -37.0 / -43.1 / -49.4 / -75.0 |
| Rifle suppressed 5 / 10 / 15 / 19 m | -21.5 / -25.2 / -32.5 / -46.2 | -22.0 / -26.5 / -31.3 / -45.9 | -48.4 / -51.4 / -56.8 / -71.1 |
| Pistol loud 5 / 20 / 35 / 50 / 59 m | -11.2 / -13.6 / -17.1 / -25.5 / -44.7 | -13.0 / -15.1 / -19.2 / -27.2 / -47.2 | -38.5 / -41.5 / -45.6 / -53.2 / -73.0 |
| Pistol suppressed 5 / 15 / 19 m | -22.2 / -35.3 / -47.0 | -25.0 / -35.2 / -48.8 | -52.2 / -61.9 / -75.6 |
| Rifle loud 20 m behind a wall | -17.2 | -18.8 | -44.6 |

`SAMPLE_GAIN` was set to land within 1 to 3 dB of package H at every distance (the first mix put the distant tail 10 dB too hot at 20 m and one close variant 11 dB hotter than the rest; both fixed by measurement). Suppressed is about 14 dB under loud. Everything is silent at the range.

Breathing, same method (10 s render, first second skipped; calm and exerted ghost):

| Distance | N calm peak / RMS | N exerted peak / RMS | H (synthesised) calm RMS / exerted RMS |
| --- | --- | --- | --- |
| 1 m | -15.7 / -34.5 | -9.1 / -26.4 | -34.2 / -25.1 |
| 2.5 m | -16.5 / -34.9 | -8.1 / -26.4 | -33.8 / -25.2 |
| 5 m | -17.5 / -36.1 | -9.8 / -27.4 | -34.9 / -26.3 |
| 7 m | -22.7 / -42.9 | -15.7 / -33.7 | -41.4 / -32.7 |
| 8 m | silent | silent | silent |

Behind a wall: calm 2 m -24.0 / -42.4, calm 5 m -25.5 / -43.9 (about 8 dB quieter, duller). **Caution about "faint at 5 m, barely there at 8 m":** the existing `breathDistanceGain` curve (which had to stay exactly) is flat to 2.5 m and only 1 dB lower at 5 m, then falls to silence at 8 m, so 5 m is not much quieter than 2 m; only 7 m and beyond fall away (-7 dB at 7 m, silent at 8 m). The recorded calm breath is set to the same loudness as the synthesised one, so it is no louder than before. If 5 m is too present, change the curve in `audio.ts` (and its tests) deliberately.

### What the owner should listen for

Open `?soundtest=1` with headphones, click once, wait for "75 of 75 loaded".

1. **Gunshots:** Rifle shot at 5 m, 20 m, 50 m (suppressed off): real and punchy at 5 m, becoming a rolling distant boom by 35 to 50 m, gone at 60 m. "Rifle, 5 shots": the variants should not sound like one sample repeated. Listen for wind or hiss in the tails. Toggle "New recordings" to compare with the old thump and decide which you prefer.
2. **Suppressed:** a duller, much quieter shot gone by 20 m. This is a filtered AK, not a real suppressor: it may sound like a muffled rifle rather than a "pfft"; say so if it does.
3. **Pistol:** it is the AK sped up, so it will probably sound like a small rifle. Expected; see the candidate list.
4. **Breathing:** switch on "Ghost breathing" at 2 m, "calm", then "running". Calm should be slow, steady, quiet; running clearly heavier, faster and louder, switching breath by breath. Check for obvious repetition (4 calm and 3 exerted breaths, random order), clicks between breaths, hiss in the exerted ones (the source was very quiet and was denoised), and the wall.
5. **Hurt** is still the synthesised thump.

If a sound is too loud or quiet: `SAMPLE_GAIN` (`shot_*`, `breath_*`) in `client/src/audio-logic.ts`. To change a cut: the `cuts` in `tools/audio-map.json`, then `node tools/process-audio.mjs`.

### Real pistol recordings (waiting for the owner)

Put 3 files into `tools/audio-source/freesound/` and run `node tools/process-audio.mjs`: any file whose Freesound id is 569174, 855652, 703342, 427592, 828786 or 386745, or whose name contains makarov, pistol, handgun, 9mm or glock, becomes the pistol (loud, distant and suppressed) automatically; the AK stand-in covers whatever is missing. The first shot of each file is used, so a file that starts with silence or talk should be trimmed first. Candidates (CC0 per the Freesound CC0 filter on the search pages; whether each is a real recording was not confirmed, nobody listened): 569174 "Makarov Shoot" by coolabc, 855652 "A Glock handgun being shot 3x" by serutonin-deprivd (same author as the distant tail), 703342 "S&W M&P9 Shield, one round fired at night, no processing" by AnthonyChan0, 828786 "Glock 19X" by areniporgen, 427592 "9mm pistol shot" by michorvath (167 s long: cut the first shot out). Links: `https://freesound.org/s/<id>/`.

### What was not verified

- Nothing was heard. Cut points and the level of every variant come from waveforms and measurements.
- The pistol is not a real pistol; suppressed shots are filtered rifle shots.
- Safari and Firefox decoding; only headless Chrome loaded all 75 files.
- Several ghosts breathing at once and many overlapping shots were not measured; no game match was run.

## Package M part 1 (rifle sights and the stuck-aim fix) in detail

Built 2026-11-17 on branch `claude/sights-aimfix-f78887` (from `main` at `5a54bda`); **merged into `main` 2026-11-17, not pushed**. **Protocol 15**
(the server and client must be updated together), 447 tests (32 new), typecheck clean. Part 2 (the realistic AK-103,
pistol, knife and real sight models) waits for the owner's downloads. Screenshots and how they were made:
`docs/review/sights/README.md` (headless Chrome, software GL, scratch ports 8092 and 5192).

**Stuck aim (`client/src/input.ts`, `client/src/mouse-buttons.ts`).** The cause was never reproduced (no real mouse).
What reading the code found:
- Hold mode: aim is "Mouse2 is in the held set". If the browser never delivers the `mouseup` (pointer lock gained or
  lost mid-press, a native menu taking the release, focus moving between press and release), Mouse2 stays in the set
  and aim stays on **until the next right-click and release** (the press itself was ignored because the button already
  counted as held). This matches "sometimes stays stuck".
- Toggle mode: the same lost release made the next press do nothing (swallowed toggle).
- Nothing else latches it: `releaseAll` (every menu, the chat box, suspension) clears held buttons and toggles; a
  spawn clears toggles; `blur` clears held keys; keys are released on `keyup` wherever focus is; the simulation takes
  aim fresh from every command and the presenter from the predicted aim counter.
- Fix: every `mousedown`, `mouseup` and `mousemove` reconciles the held `Mouse0`..`Mouse4` with `MouseEvent.buttons`
  (`releaseMissingButtons`; note `buttons` bits are 1 left, 2 right, 4 middle, 8 back, 16 forward, not `button`'s
  order), and `pointerlockchange` releases every held mouse button. Reconciling starts only once the browser has shown a
  `mousedown`/`mouseup` whose `buttons` agrees with it, so a browser that reports `buttons` as 0 inside pointer lock can
  never cancel aim on every move. A press of a button still counted as held is treated as release then press. No
  allocation per event (`mouseInput` no longer builds a string per event). Tests: `client/src/mouse-buttons.test.ts`.

**Sights: the rule (`shared/weapons.ts`, `shared/gun.ts`).**
- One table, `SIGHTS`: iron 1.3x zoom and 12 commands to aim in, 1x red dot 1.4x and 12, 2x scope 2.0x and 16.
  **Starting values, untuned** (the rifle's old 1.5x is gone; iron is now 1.3x as the brief asked). Only a gun with
  `takesSights` (the rifle) uses them; the pistol keeps its own aim (1.2x, 8). Spread, recoil and their aim
  multipliers stay per weapon. Mouse look while aimed still scales by the zoom.
- `LoadoutState.sight` is the mounted sight. It is set **only** by `resetLoadout(l, sight)` at a spawn and never by a
  command; it travels as one byte in the self snapshot and is compared by `sameLoadout`. Aim time is
  `adsTicksOf(slot, sight)`, used by `stepLoadout` and `aimFraction`; zoom is `adsZoomOf`.
- Server (`server/src/game.ts`): `Player.sightPending` is the latest choice (join query `sight=N`, cleaned by
  `cleanSight`, so the very first spawn already uses it; then `{type:'sight', sight}` messages). `spawn()` mounts it.
  A choice mid-life changes nothing until the next spawn and sends nothing (repeating it is harmless; the normal
  message credit limit applies). Bots never ask, so they use iron sights (a `sight` message for a bot is ignored).
- Wire (protocol 15): self snapshot loadout block 5 to 6 bytes (`sight` after `trigger`); `spawn` gains `sight` (the
  client predicts with it until the first snapshot); `RosterEntry.sight` (the active sight, for drawing it on that
  player's gun; no position, nothing `knowsAbout` withholds; the roster is re-sent at the end of a tick in which a
  spawn mounted a different sight); new client message `sight` (`decodeClient` takes only an integer 0..2).
- `server/src/prediction.test.ts`: new runs with every sight held for a whole session, and with the sight changing
  mid-life and dying 0.5 s later, every life (iron, red dot, scope, round again), at four delays and with jumping
  command numbers: zero disagreements. In those runs the script keeps still from death until one round trip after it
  hears of the respawn (see Known problems, the warmup respawn edge). Server rule tests: `server/src/sights.test.ts`.

**Sights: what you see.**
- Loadout page (`client/src/ui.ts`, package L's panel style, `segmented` stacked): from the home menu ("Loadout",
  hint "Rifle sight: ...") and from the pause menu (a Loadout screen, Back or Esc returns to the pause menu). Three
  choices, one line each. Saved in `localStorage` `sb-loadout` as `{"sight":"reddot"}` (by id, so reordering the table
  never swaps a choice; `client/src/loadout.ts`, tested). In a match the note says "Mounted on your rifle now" or
  "Applies at your next spawn. This life keeps the ...".
- `main.ts` puts the choice in the join query and sends a `sight` message after the welcome and on every change.
- Presenter (`presenter-api.ts` first: `LocalView.sight`, and `RosterEntry.sight` documented on `roster`): while the
  rifle is aimed with a red dot, a red reticle at the screen centre; with the 2x scope, a scope ring with a dark edge
  and a thin duplex reticle. Both are DOM elements over the canvas (no draw call), fade in from 55 % aim, and hide the
  hip crosshair and spread ticks once half in. Iron sights keep the old crosshair behaviour. The aimed rifle is lowered
  by the sight's optical axis height minus the iron line (`SIGHT_EYE` in `presenter.ts`: 0.226 m iron and red dot,
  0.236 m scope), and fully into the 2x scope (92 % aim) the first-person gun is hidden: the overlay is the view.
- Models (stand-ins, generated, nothing downloaded; `tools/blender/weapons.py` `RIFLE_SIGHTS`): `gun_sight_reddot`
  (a short tube red dot on a low mount, 188 triangles) and `gun_sight_scope2x` (a scope with bells and turrets on two
  rings, 736 triangles), children of `gun` in `weapons.glb`. Third person (`client/src/weapons.ts`): every suppressor
  and sight combination is merged into one mesh at load (`looks`, 6 for the rifle), so a gun is still one draw call;
  `Character.setSight` from the roster. First person (`tools/blender/viewmodel.py`, rifle rig rebuilt): bones
  `sight_reddot` and `sight_scope2x` follow the gun in both clips; `VmRig.setSight` shrinks the ones not mounted like
  the suppressor. Still one skinned mesh (`viewmodel_rifle.glb` 336 to 395 KB, 3,486 triangles). Pistol and knife
  rigs and `character.glb` were not rebuilt. Rebuilt with the sources in the main checkout's git-ignored
  `tools/blender/source-art/`; `weapons.py` was first checked to reproduce the shipped `weapons.glb` byte for byte.
- **For part 2 (re-pointing):** a new rifle needs nodes named `gun_sight_<SightId>` (or bones `sight_<SightId>` in its
  rig) and the optical axis heights in `SIGHT_EYE`; the table and every rule are model-independent.

**Measured (headless, `docs/review/sights/report.json`):** aim counter 12 / 12 / 16 when fully aimed; field of view
60.2 / 56.6 / 41.3 degrees; draw calls with other players hidden 9 at the hip with every sight (a sight costs no draw
call), fully aimed 9 / 9 / 7.

**Decisions taken on my own judgment:** the join query also carries the sight (so a player's first life already has
it; the brief named only the message); the active sight travels both in the `spawn` message and in the snapshot byte;
the roster is re-sent only when a spawn changes someone's sight; the sight is saved by id, not index; the iron sight
also sets the rifle's own `adsTicks`/`adsZoom` (for code with no loadout); the red dot's axis sits on the iron line so
its aimed pose does not move; the 2x scope hides the gun when fully in; the overlays start at 55 % aim; the pause menu
got a "Loadout" button between Resume and Settings.

**Not verified:** anything with a real mouse or in a real browser window (so the stuck-aim fix is untested against the
real fault, which was never reproduced; `buttons` behaviour inside pointer lock was not checked on Chrome, Firefox or
Safari); how the zoom amounts and aim-in times feel; whether the reticle and ring read well on a real screen and GPU;
the sights in motion (reload with a sight mounted, switching, sway, kick); third-person sights on moving or aiming
players (only standing scripted players were seen) and whether the scope clips the helmet in some poses; the
Loadout page by keyboard only; a sight change through a real death in a real round (the server rule and the respawn
are tested in-process; the browser run changed it mid-life and checked the note and that the mounted sight stayed).

## Package M part 2 (realistic weapons) in detail

Built 2026-11-18 on branch `claude/realistic-weapons-804056` (from `main` at `97c342d`); **not merged, not pushed**.
Art and presentation only: `git diff main -- shared server` is empty, no message change, protocol stays 15. 451 tests
(4 new in `client/src/models.test.ts`), typecheck clean. Screenshots and how they were made:
`docs/review/realistic-weapons/README.md` (headless Chrome, software GL, scratch ports 8094 and 5194). **Nothing was
seen on a real GPU, in motion or with a mouse.** Package N (recorded sounds) ran in parallel and owns the audio files;
this package touched none of them.

**What changed for the player.** The rifle is an AK-105 (SpatialNeglect), the pistol a Makarov PM (TaigaForest), the
knife (ghosts' and defenders') the "Tactical Knife" (Gerardo Justel), the 1x red dot the "Red Dot Sight" (Gerardo
Justel), all CC-BY from Fab, credited in `client/public/models/CREDITS.md`. The 2x scope is generated (an ACOG-like
combat scope) until the owner downloads "AR Scope (Game-Ready)" by Scape (below). Both suppressors are generated cans
(the AK's slips over its muzzle brake). Sights stand on the Picatinny rail of the AK-105's dust cover. First and third
person, both tiers.

**Pipeline** (`tools/blender/`; run `weapons.py` then `viewmodel.py`, about 25 s and 2 min; Node must be on the PATH):
- `realistic.py` (new, shared): imports the downloads from the git-ignored `source-art/realistic/<item>/` (zips are
  extracted into `source-art/realistic/build/unzipped/`), puts them in the shipped frame, reduces them with
  `decimate()` (collapse, then the source's own normals copied back with a data-transfer step, so the normal maps still
  shade as baked), and builds **one atlas per gun** (`Atlas`, layouts in `LAYOUTS`): each source material gets a
  rectangle and its UVs are scaled into it; generated parts and the arms use flat swatches whose colour comes from the
  vertex colour. Writes `client/public/models/textures/<gun>_albedo_<size>.webp` (RGB base colour with ambient
  occlusion multiplied in and metal lifted by `METAL_LIFT`; alpha = one "surface value" s, smoothed and stepped, read by
  the client as both gloss and metalness: metal about 0.6 to 0.9, polymer 0.1 to 0.35) and `<gun>_normal_<size>.webp`
  (OpenGL normal map; all four sources were checked to be OpenGL-style by rendering both ways), each at 2048 (High) and
  1024 (Low).
- `weapons.py` (rewritten): writes `weapons.glb` (third person: reduced meshes, the same node names as before plus
  `gun_aim_<sight>` / `pistol_aim_iron`) and the git-ignored `source-art/realistic/build/weapons_fp.glb` (full-detail
  parts, landmark empties `mark_*`, aim points) that `viewmodel.py` now builds the rigs from (it no longer reads
  `weapons.glb`). Constants at the top: real sizes, triangle budgets, eye positions (`EYE_BEHIND_GRIP`,
  `REDDOT_EYE_RELIEF`, `SCOPE_EYE_RELIEF`), the third-person pistol scale.
- `viewmodel.py`: the rifle's moving parts are the real magazine and bolt carrier (charging handle on the right); the
  pistol's the real slide (with its safety) and magazine (with its follower). The left hand holds the AK's handguard (it
  held the magazine like a foregrip before) and racks the charging handle from under the gun (the gun rolls to show its
  right side). Same cue times as before (rifle 0.3 / 1.4 / 1.9 to 2.07 s, pistol 0.15 / 0.7 / 1.0 to 1.17 s). Arms
  unchanged apart from their UVs (a white swatch) and their vertex alpha (0: alpha is the emission channel now). The
  armature is named `rig_<weapon>` (see the bug below).
- `tools/quantize-glb.mjs` (new, run by both scripts): stores normals, UVs, colours and skin weights as small integers
  (`KHR_mesh_quantization`; PlayCanvas reads them directly), about 40 % smaller files.
- `tools/weapon-shots.mjs` (new): the review screenshots.

**The 2x scope download (for the owner):** on Fab, "AR Scope (Game-Ready)" by Scape
(fab.com/listings/346c6bbd-a204-4317-9e10-b25c653821a8). Put the downloaded file as it comes (the .zip, or the .glb /
.gltf / .fbx inside it) into `tools/blender/source-art/realistic/scope2x/` of the main checkout; a session then runs
`weapons.py` and `viewmodel.py` and looks at the result: the importer guesses the orientation (longest side = optical
axis, wider end = front, the mount below) and drops glass and lens meshes. This path has **never run** (no file yet), so
expect to check it. Credit Scape in `CREDITS.md` then.

**Client** (`weapons.ts`, `characters.ts`, `presenter.ts`, `viewmodel.ts`):
- `WeaponMaterials` (weapons.ts): one StandardMaterial per atlas (rifle, pistol, knife), shared by first person, third
  person and the arms. Per pixel: the albedo atlas (colour; its alpha drives gloss and metalness), the normal map, and a
  64x64 studio sphere map generated in code (no download) for metal reflections: **3 texture reads per weapon pixel on
  both tiers**; Low and High differ only in atlas size. The atlases load on the first `setTier` (1024 on Low, 2048 on
  High) and swap when the tier changes; until then the guns are flat dark grey. Emission = vertex alpha x red: only the
  red dot's reticle glows.
- Aiming: the presenter puts the sight's aim point (from `weapons.glb`) on the camera, so any model's sight lines up
  without constants (`SIGHT_EYE` is gone; a fallback stands in until the model loads). **The 2x scope no longer hides
  the gun or blacks out the screen:** the eye sits 6.8 cm behind the eyepiece, the scope's own ring frames a lens about
  half the screen high, the zoom is unchanged (2x, applied to the whole view; no second render pass on either tier), and
  a DOM chevron reticle fades in from 80 % aim. The scope's tube has no inner wall and nothing faces the eye inside its
  lens cone, so the lens shows the world. The red dot needs no DOM reticle any more (its reticle is on the glass); the
  DOM dot remains only while no model is loaded.
- `Character.setWeapons(model, materials)`: third-person guns and the defender's knife use the textured materials; the
  ghost's knife keeps the ghost shimmer.
- **Bug fixed on the way:** the knife rig's armature was also named `vm_knife`, so `setVariant('vm_knife')` never
  matched and a defender's knife drew both arm meshes (the ghost's dark sleeves over the orange ones, and one extra draw
  call). The armature is now `rig_<weapon>`; a test checks the names.

**Numbers** (before = `main` at `97c342d`):

| | Before | After |
|---|---|---|
| Rifle rig (first person) triangles | 3,486 | 16,324 (AK about 12,000 incl. magazine and bolt, red dot 2,182, 2x scope about 650, suppressor 576, arms 1,500; the parts not mounted are scaled away but still processed) |
| Pistol rig | 2,546 | 13,582 (Makarov 11,578, suppressor 504, arms 1,500) |
| Knife rig (two meshes, one drawn) | 1,898 each | 4,099 each |
| Third person (`weapons.glb`) | rifle 876, red dot 188, scope 736, pistol 990, knife 398 | rifle 3,198, red dot 380, scope 284, pistol 1,697, knife 800, suppressors 216 each |
| Textures | none (vertex colours) | 3 atlases x (albedo + normal): Low 1024², 850 KB together; High 2048², 1.97 MB together |
| Files | 1.31 MB (4 GLBs) | GLBs 2.30 MB (weapons 291 KB, rifle 856 KB, pistol 612 KB, knife 542 KB); a Low player downloads 3.15 MB, a High player 4.27 MB |
| Draw calls, gun in hand | 1 (+1 flash) | 1 (+1 flash); frames measured with the other players hidden: 9 hip / 8 aimed with every sight, pistol 8, knife 10 (11 before the knife fix) |
| Third person | at most 2 per armed player | unchanged |

`models.test.ts` keeps the Low download (4 GLBs + the 1024 atlases) under 4 MB. High is slightly over 4 MB.

**Decisions taken on my own judgment:** one material per gun, shared with the arms (they point at a white swatch and
keep their vertex colours); gloss and metalness from one channel; textures as separate WebP files loaded by tier rather
than inside the GLBs (a Low player never downloads the 2048 set); a generated studio reflection (`sphereMap`) so dark
gun metal reads as metal without a scene environment map, and metal's base colour lifted (`METAL_LIFT` 0.7) for the
same reason; the AK-105's raised cheek rest left out of first person only (with iron sights it stood 1 cm under the
sight line right in front of the eye); the iron-sight eye 44 cm behind the grip (over the end of the stock), the red
dot's 26 cm behind its glass, the scope's 6.8 cm behind its eyepiece; both sights on the dust-cover top rail (the model
has one; a side mount would be a part the source does not have); the support hand on the handguard and the charging
handle racked from under the gun; the third-person pistol drawn 1.35x (the cartoon fist swallowed a real-size Makarov;
its muzzle points follow; first person stays real size); the generated 2x scope modelled on an ACOG (housing,
fibre-optic pipe, rail clamp with thumb nuts) with an amber chevron; the red dot's reticle 1.1 mm on the glass; vertex
alpha as the emission channel; glTF quantization to stay near the download budget.

**Hip pose follow-up (review, owner-approved, 2026-11-18):** at the hip the AK sat small in the lower right, canted
with its barrel pointing up and left at about 45 degrees, and the support arm ran diagonally across the screen. Now the
rifle's hip pose is `[0.15, -0.165, -0.40, 0, 3, -3]` (was `[0.17, -0.32, -0.5, 4, 6, -6]`; `presenter.ts` VM_LOOKS and
`viewmodel.py` HIP, which must match): higher and closer, no upward pitch, 3 degrees inward, so the barrel runs toward
the crosshair and the receiver, magazine and handguard show. The support hand grips the handguard nearer the receiver
(22 % along it instead of 42 %), and the left shoulder moved to `(0.06, 0.47, -0.34)` so the forearm comes in from the
bottom edge. The reload's tilted poses were lowered and flattened (no muzzle-up pitch; magazine out and in and the
charging handle still in view), and the belt point moved closer so the arm stays in reach. Pistol hip `[0.11, -0.15,
-0.33, 0, 3, -2]` (was `[0.12, -0.175, -0.34, 2, 4, -3]`), same reasoning, smaller change. The knife was fine and is
unchanged. The aimed poses come from the aim points and did not move. Every first-person screenshot (10 to 43) was
re-taken. The folding stock now shows in the bottom right corner at the hip, as on a real AK held at the hip.

**Not verified:** anything on a real GPU or in motion (software GL only); frame rate; how metal and polymer read on a
real screen and in Warehouse's dark corners; the scope's lens size on other screen shapes (fixed geometry: wider
screens show more scope body); the red dot reticle's visibility at 1080p and above; the reloads by ear against the
sounds (same cue times as before); whether the left hand clips the magazine while racking the handle; the third-person
support hand (the character's aim clip still holds the old SMG's magazine spot, which on the longer AK is the magazine
well, not the handguard; package O rebuilds the characters); the downloaded-scope path (never ran); and
`tools/blender/review.py` (its Blender renders assume vertex colours, so the new guns render untextured there). The
arms are still the cartoon SWAT arms; package O replaces them. There is no in-game credits page: the CC-BY credits
live in `client/public/models/CREDITS.md`, which the site serves at `/models/CREDITS.md`.

## Package O (realistic soldiers) in detail

Built 2026-11-18 on branch `claude/realistic-soldiers-bcc8fb` (from `main` at `f899118`); **not merged, not pushed**.
Art and presentation only: `git diff main -- shared server` is empty, no message change, protocol stays 15. 460 tests,
typecheck clean. Screenshots and how they were made: `docs/review/soldiers/README.md` (headless Chrome, software GL,
scratch ports 8098 and 5198). **Nothing was seen on a real GPU, in motion or with a mouse.** No downloads were made
(the owner's Fab files were used; Mixamo was not needed, see "Animations").

**What changed for the player.** Defenders are the Fab "Quantum Modular Character" soldier (cap, rolled-up shirt dyed
the team orange, plate carrier with pouches, holster, jeans and boots); ghosts are the same body as a close-fitting dark
suit with a balaclava and boots (no cap, no vest), a very different silhouette, still drawn only through the shimmer
shader. First-person arms are the soldier's real forearms and hands with the orange rolled sleeves (defenders) or dark
suit sleeves and gloves (a ghost's knife), fingers closed round the AK's grip and handguard, the Makarov's grip (two
hands) and the knife. Third person: the rifle is shouldered with the left hand on the handguard (it held the old SMG's
magazine spot), the pistol is real size (the 1.35x scale-up is gone) and held in two hands, the knife sits in the right
hand. The downloaded "AR Scope (Game-Ready)" by Scape replaces the generated ACOG on the AK (first and third person).

**Pipeline** (`tools/blender/`; order: `weapons.py` (30 s), `viewmodel.py` (10 s), `soldier.py` (45 s); sources in
the git-ignored `source-art/`, see `client/public/models/CREDITS.md`):
- `soldier.py` (new, model-agnostic: everything specific to this model is in its tables `BONES`, `PARTS`, `BUDGET`,
  `MATERIALS`, `REGIONS`): imports `SKM_Character.fbx` and `SKM_Body_Full.fbx` (Blender's FBX importer crashes on these
  files with a KeyError in `link_hierarchy`; `patch_fbx_importer` works round it), builds the 51-bone skeleton with
  SWAT-style names (root, hips, three spine bones, neck, head; per side shoulder, upper arm, forearm, wrist, three
  bones per finger and thumb, thigh, shin, foot; twist, corrective, face, metacarpal and toe bones folded into their
  kept ancestor), reduces each part to the tier's budget (plain smooth normals afterwards: the per-corner normals
  copied back by `realistic.decimate`, right for guns, made reduced skin and cloth look faceted), joins each look into ONE mesh
  with ONE material, and writes `character_high.glb` / `character_low.glb` (both looks, `char_defender` and
  `char_ghost`, on one skeleton) and the atlas `textures/character_{albedo,normal}_{2048,1024}.webp` (each source
  material's 4K maps cropped to the part the mesh uses; normal maps at WebP quality 60).
  It also provides the first-person arms (`fp_sources`, `fp_arms`) and their atlas regions (`fp_regions`).
- `clips.py` (new): retargeting and the generated clips, sockets, export (24 fps, rotation keys only except the hips,
  bones that do not move in a clip keep 2 keys).
- `viewmodel.py`: arms from `soldier.fp_*` instead of SWAT (5,000 triangles for the defender's, 4,500 for the ghost's, 70 % in the hands); hands at real size; shoulders moved for real arm lengths
  (the rifle's left shoulder forward, a bladed stance, so the support hand reaches the handguard). Clip names, cue
  times, the hip poses and the aimed poses are unchanged.
- `weapons.py`: each gun atlas gets the arms' regions (`realistic.ARM_LAYOUTS`; the AK, Makarov and knife textures
  were moved up to make room: the AK region is now 1536 x 1536 instead of 1536 x 2048 at High); the pistol is drawn
  real size; the downloaded scope is imported in an explicit frame (`SCOPE_DL`: it is a compact 60 mm optic on a riser,
  so "longest side = optical axis" guessed the vertical axis), its lens tube is dropped so the aimed view looks through
  the housing, its four other materials get their own cropped rectangles of the rifle atlas, and the eye sits 4.5 cm
  behind its eyepiece (`SCOPE_EYE_RELIEF`; 6.8 cm framed the lens at about a third of the screen height, 4.5 cm at
  about half). The generated ACOG stays as the fallback when the file is absent.
- `realistic.py`: atlas regions can crop their source maps and recolour (`Region(crop=, post=)`), `uv_crop`.
- `characters.py` and the old `character.glb` are removed (the SWAT pipeline). `review.py` (package F's Blender
  renders) now points at `character_high.glb` but was not re-run.
- `tools/soldier-shots.mjs` (new): the review screenshots.

**Animations.** No Mixamo: the existing Quaternius clips (idle, walk, run, death, hit, from `SWAT.glb`) were retargeted
onto the new skeleton in Blender (`clips.Retarget`: per bone a rest alignment from the source's T-pose to the target's
A-pose, world rotation changes copied, hips scaled by the leg-length ratio 1.07, feet put back on the source's
footprints by two-bone IK; the shoulders take motion only, because the cartoon source's sloping shoulder bones hunched
the real clavicles). Crouch idle and walk are derived as before (the idle's forward foot pulled under the hips: it made
a lunge). Aim, shoot, pistol, pistol_shoot, both reloads, knife hold and swing are generated from the guns' landmarks
with the fingers closed round the grips (the same curl tables as first person). Judged from stills only: walk and run
looked natural, idle stands slightly knock-kneed with a forward lean (the source's cartoon idle), death falls back and
lies flat. Clip ground speeds for `characters.ts`: walk and crouch walk 1.45 m/s, run 3.22 m/s. **If the owner finds the
motion poor in play**, a follow-up can replace the five source clips with Mixamo ones; the list would be: "Rifle Idle",
"Walking" (in place), "Running" (in place), "Dying" (Death From The Front), "Hit Reaction", downloaded **without
skin**, FBX for Unity, 24 fps, "In Place" ticked for the locomotion; `clips.RETARGET` then maps them (Mixamo's skeleton
needs its own `DIRS` and bone names). Not needed now.

**Client** (`characters.ts`, `presenter.ts`, `weapons.ts`; `presenter-api.ts` unchanged):
- The character file follows the graphics tier: `presenter.setTier` loads `character_<tier>.glb` (the first call
  loads it; boxes stand in until then); a later tier change loads the other file and rebuilds every character from it.
- `Character` shows `char_defender` with the new character material (`WeaponMaterials.character()`: the atlas loaded by
  tier like the weapon atlases, gloss from the albedo alpha, no metalness) or `char_ghost` with the shimmer; both
  meshes carry vertex colours; an old single-mesh file still works.
- Weapons: rifle in `socket_gun`, pistol in the new `socket_pistol` (falls back to `socket_gun`), knife in
  `socket_knife`.
- Unchanged and still working (code paths read, seen in staged stills): the crouch lean, switch dip and aim raise
  (bones `Abdomen`, `Chest`, `Neck`, `UpperArm.*` kept), the upper-body mask (`Abdomen`), reload sync, swing and slash,
  suppressor and sight on remote guns, corpses turned away from walls (the death clip is recentred as before), footstep
  dust and blob shadows (the soldier is about as wide as the old one at the shoulders, so their sizes were kept).

**Numbers** (before = `main` at `f899118`):

| | Before | After, Low | After, High |
|---|---|---|---|
| Third person, triangles per look | 3,798 (one mesh, both teams) | defender 6,641, ghost 5,500 | defender 12,966, ghost 10,500 |
| Bones | 22 | 51 | 51 |
| Character texture | none (vertex colours) | 1024² atlas: albedo 195 KB, normal 121 KB | 2048² atlas: albedo 500 KB, normal 538 KB |
| Character file | `character.glb` 395 KB | `character_low.glb` 656 KB | `character_high.glb` 935 KB |
| Draw calls per armed player (measured, practice range, 5 players) | at most 2 | 1.8 a player (some culled) | 2.8 a player (High draws players again in the depth prepass; G's budget is 4) |
| First-person arms, triangles | 1,500 (cartoon) | defender 5,000, ghost 4,500 | same |
| Rigs (triangles, whole mesh; files) | rifle 16,324 (855 KB), pistol 13,582 (613 KB), knife 4,099 (542 KB) | rifle 22,183 (scope 3,000; 1,003 KB), pistol 17,081 (615 KB), knife 7,598 / ghost 7,099 (572 KB) | same |
| Draw calls per rig | 1 (+1 flash) | 1 (+1 flash) | same |
| Model download per player (GLBs and atlases, MB = 10^6 bytes) | Low 3.55 MB, High 4.67 MB | 4.27 MB | 6.65 MB |

A Low frame with ten players draws about 66,000 character triangles with 51-bone skinning (texture-based bone
matrices) and three texture reads per character pixel (albedo, normal, the studio sphere map), against about 38,000
untextured before. That should stay comfortable on Intel UHD 620, but **frame rate was not measured** (software GL).
`models.test.ts` keeps everything a Low player downloads for models under 4.5 MiB (4.72 MB; it was 4 MiB without the characters).

**Decisions taken on my own judgment:** both looks in one file per tier (one skeleton and clip set; a Low player never
downloads the High file); the ghost made from the bare body with its face and feet smoothed into a balaclava and boots,
pointing at a dark swatch (it is only ever drawn with the shimmer, so a texture would never show); no gear on the ghost
(the "drop" part is the vest's magazine pouches and hangs in mid-air without the vest); the holstered pistol, the
"QUANTUM ASSETS" back patch, the cap flag, teeth and lashes left out; the team orange as a dyed shirt (it reads at a
glance from front, back and side); the pistol held in two hands in third person (it was one-handed); a bladed stance for
the rifle (chest turned 22° right, head turned back) so the real-length left arm reaches the handguard; character
normal maps at WebP quality 60; character materials without metalness; the downloaded scope's frame set by constants
rather than guessed; eye relief 4.5 cm; the arm textures inside each gun's atlas (one draw call per rig) at the cost of
a quarter of the AK texture's height.

**Not verified:** anything on a real GPU or in motion (software GL stills only); frame rate on the owner's laptop; the
retargeted clips in motion (feet sliding, the idle's lean); how the shirt orange reads against the real maps at a
distance and in Warehouse's dark corners; the tier switch rebuilding characters during a match (code read, not run);
remote characters during real fights (all third-person poses in the screenshots are staged on practice targets); the
first-person arms at real screen sizes with sway, kick and draw (in the software-GL stills the hands still look a little angular when the pistol brings them close); whether the left hand clips the AK's magazine during
the reload; the aimed 2x view on other screen shapes; `review.py`.

### Package O follow-up: first-person arms rebuilt (2026-11-18)

The owner's play test: "the hand looks awful while holding gun, the left arm seems broken; the gun needs to come a
little closer and to the left; same for the ghost's knife". Built on the same branch after the merge (no protocol
change, `git diff main -- shared server` empty, 461 tests, typecheck clean). Before and after screenshots at the
default and the widest field of view: `docs/review/viewmodel/` (software GL stills only).

- **Why the arm looked broken:** the left shoulder sat in front of the camera, so the arm crossed the view sideways
  with the rolled sleeve big at the bottom; and the forearm had no twist bones, so every bit of wrist roll twisted the
  whole forearm (`twist_forearm` 0.8) and wrung the skin at the elbow.
- **Arms** (`viewmodel.py`): each arm is now placed by its forearm direction and upper-arm direction at the idle hold
  (`ARMS`, camera space); the shoulder and elbow pole follow from them, off screen. Each forearm comes in from a bottom
  corner as one straight line to the hand. Two forearm twist bones per arm (`ForeTwist1/2`, from the soldier's
  `lowerarm_twist_02/01`, first person only, `soldier.FP_TWIST`) take 50% and 85% of the hand's roll, the forearm 10%
  (`TWIST_SHARE`). The build log prints each clip's largest wrist bend and roll.
- **Grips:** rifle support hand cradling the handguard from below (`support_frame`: palm up leaning 20 degrees toward
  the left, fingers over the far side, thumb along the near side, turned halfway toward the forearm's line); index
  finger on the trigger; pistol thumbs forward with the support hand cupping from below (`PISTOL_SUPPORT`); the knife's
  handle lies diagonally in the palm (`KNIFE_DIAGONAL` 45 degrees), blade forward and slightly up, and the shoulder
  reaches into the slash. Hands get 80% of the arms' triangles (the sleeves now barely show); the budget is unchanged
  (5,000 defender, 4,500 ghost).
- **Framing** (matched to a reference screenshot the owner sent from another tactical shooter): the gun is big and
  close, filling the right half of the screen; the optic sits just right of and below the crosshair; the muzzle points
  in toward the centre; the stock runs off the bottom-right. The left forearm comes nearly straight up from the bottom
  edge to the handguard (no elbow or long arm on screen) and the right hand sits low on the grip. Rifle hip 0.21 m in
  front of the eye (was 0.40), turned 15 degrees in; pistol 0.18 m (was 0.33), turned 12 degrees in, 2 degrees down,
  both forearms from the bottom edge; knife closer and further left. During the rifle reload the gun is lifted and
  tipped up (and the shoulders follow) so the magazine change happens in view. `viewmodel.py HIP` and
  `presenter.ts VM_LOOKS.hip` match.
- **Aimed arms:** new one-frame clips `<rig>_aim_<sight>` hold the same grip with the arms solved from shoulders that
  keep their place relative to the eye (leaning toward a hand only when it would be out of reach, `AIM_REACH`);
  `presenter.ts` lays them over the idle pose by the aim progress (`VmRig.blend`). The gun's aimed position is computed
  exactly as before (the aim point on the eye), so the sight picture is unchanged.
- **Field of view:** the settings' field of view did nothing (`main.ts` reset the camera to 74 every frame); it now sets
  the base and aiming zooms from it. The weapon is drawn as if at 74 degrees whatever the setting (`presenter.ts
  VM_FOV`): its root is scaled across the view by tan(fov/2) / tan(37 degrees), which projects exactly like a 74-degree
  camera, keeps the screen centre (aimed sights) and keeps the muzzle where tracers start; no second camera, so the
  High tier's post-processing is untouched. The arms' skinned normals use the matrix's cofactor so the scale does not
  bend the lighting (`weapons.ts fovLockNormals`, an override of the engine's `normalCoreVS` chunk for the three weapon
  materials; it warns and falls back if a future engine words that line differently).
- **2x scope:** when aimed the housing gets only 35% of the scope's zoom (`VM_SCOPE_ZOOM_SHARE`), so it covers about
  two thirds of what it did; the lens and reticle stay centred.
- **Third person:** looked at in the existing stills (`docs/review/soldiers/60-62`); the left hand reaches the AK's
  handguard and nothing reads as broken at play distance, so it was not changed.
- **Previews:** `viewmodel.py -- --rig <name> --preview <dir>` renders each rig's poses in Blender from the eye at 74
  degrees, a close-up of the hands and a view from the left (about 10 s a rig), for tuning without the game.

**Not verified:** anything on a real GPU, in motion or with a mouse; sway, kick and draw with the new framing; whether
the aimed-arms blend looks smooth while aiming in and out (only the end states were captured); the reload clips at the
new framing beyond the three frozen frames per gun; the hands are still a little angular close up (the pistol shows it
most; more triangles would need a bigger budget); the knife swing's slash frame in the game (the capture froze after
it); other screen shapes than 1366 x 768; the lighting on the arms at the widest field of view on a real GPU (the
normal fix is in the shader, seen only in SwiftShader).

### Package O second follow-up: roll, the thin aimed gun, knife fingers (2026-11-18)

After the owner played `main` d2d5098. Branch `claude/realistic-soldiers-bcc8fb`, merged into `main` and pushed 2026-11-18; no protocol
change, `shared/` and `server/` untouched, 461 tests, typecheck clean. Screenshots before and after at fields of view
60, 74, 90 and 110: `docs/review/viewmodel/before2/` and `after2/` (README there).

- **"The gun looks like a thin piece of paper when aiming":** the rifle's iron-sight eye point was 0.44 m behind the
  grip, past the stock's end, so the aimed camera saw the AK end-on (a 5 cm strip). Same at every field of view, so the
  field of view lock was not the cause. `weapons.py EYE_BEHIND_GRIP['rifle']` is now 0.20 (a cheek weld): the stock
  passes under the eye and the receiver's top shows. Only `weapons.glb` changed (aim points); atlases unchanged.
- **Roll:** `viewmodel.py HIP` and `presenter.ts VM_LOOKS.hip` roll the rifle and pistol -1 degree (were -6 and -3),
  the knife's spine is level; the rifle reads upright like the owner's reference.
- **Fingers:** `viewmodel.py Rig.pose_arm` curls each finger about its own hinge (its direction crossed with the palm's
  normal, from the hand as posed, not the grip frame): every joint bends toward the palm in its own plane. The knife's
  diagonal handle had bent fingers sideways with the old shared axis. `THUMB_KNIFE` wraps the thumb over the handle.
  Checked frame by frame through the swing in Blender previews (idle and seven swing frames, close and side views).
- **Reload untouched** (to be replaced by a bought animation pack, per the owner); timings unchanged.

**Not verified:** anything on a real GPU, in motion or with a mouse; the aim-in blend in motion; the ghost's and the
defender's swing in the game frame by frame (the in-game capture freezes one frame; the Blender previews cover the
swing); the hands are still a little angular close up.

### Package O third follow-up: framing matched to the owner's reference stills (2026-11-18)

After `main` 96834ae (package P). Branch `claude/realistic-soldiers-bcc8fb`, **reviewed, merged into `main` and pushed 2026-11-18**; no protocol
change, `shared/` and `server/` untouched, 481 tests, typecheck clean. The owner sent seven stills from another
shooter's gameplay video (`docs/review/viewmodel/reference/`, kept **out of the repository** by a `.gitignore`, as are
the side-by-side images in `compare3/`). **Legal line:** only where things sit on screen, how big they are, their
angles and roughly how they move were matched; those are common shooter conventions. Nothing of that game's models,
skins, sights, animations or HUD was copied: our AK, hands, red dot and HUD are our own.

Pictures (`tools/soldier-shots.mjs --only ref`, headless Chrome, software GL, scratch ports 8099 and 5199, still frames):
`docs/review/viewmodel/before3/` (main at 96834ae, FOV 74) and `after3/` (FOV 60, 74, 90, 110); side by side with
the references (reference | before | after, FOV 74) in `compare3/` (local only).

| Reference | Measured there (fraction of width / height from top-left) | Ours after |
|---|---|---|
| Hip (`hip-still`, `hip-moving`) | muzzle 0.52 / 0.55; optic x 0.61-0.76, y 0.40-0.65; left sleeve bottom centre x 0.48-0.59; receiver off the bottom-right | muzzle 0.53 / 0.56; red dot x 0.64-0.77, y 0.48-0.61; left forearm x 0.55-0.62; receiver off the bottom-right; the same at FOV 60-110 |
| Aimed (`ads`) | window x 0.42-0.58, y 0.38-0.60, dot on the centre, housing to the bottom edge | window x 0.43-0.57, y 0.40-0.60, dot on the centre, the receiver's top rail to the bottom edge |
| Reload (`reload-1-hand-in`, `reload-2-mag`) | gun raised at the right edge, muzzle up, rolled clockwise; left hand up from the bottom centre, open | the same shape: gun upright at x 0.73-0.95, magazine well toward the left hand, hand up from the bottom centre and the magazine taken away down and to the left |
| Knife (`knife-inspect`) | fist low right, blade up, fingers wrapped, thumb over | fist low right, fingers and thumb closed round the handle (unchanged; our blade leans further left, the owner's earlier 45-degree choice) |
| Lowered (`lowered-run`) | gun at the bottom centre canted about 30 degrees counter-clockwise | not adopted: our draw already rises from below canted counter-clockwise (`VM_LOOKS.draw`); it cannot be frozen in the capture tool |

What changed:
- **Hip** (`viewmodel.py HIP['rifle']` = `presenter.ts VM_LOOKS.rifle.hip`): (0.155, -0.168, -0.155) at (2, 11, -1),
  was (0.155, -0.155, -0.21) at (2, 15, -1): about 35% closer, so the gun is bigger and its barrel steeper on screen,
  the muzzle still just right of and below the crosshair.
- **Aimed red dot** (`weapons.py REDDOT_EYE_RELIEF` 0.175, was 0.26): the window is taller and wider; the sight
  picture is still exact (aim point on the optical axis). Iron and 2x unchanged; only `weapons.glb` changed.
- **Reload** (`viewmodel.py RELOAD_MAG`, `RELOAD_BOLT`, `RELOAD_BELT`): the gun now rises, its muzzle tips up and to
  the right and it rolls clockwise (was lowered and canted the other way); the left hand leaves the handguard as the gun
  rises, comes up open under the magazine well, carries the old magazine away down-left and brings the new one back
  up. Key times unchanged (magazine out 0.3 s, seated 1.4 s, bolt 1.97-2.07 s), so the sound jolts still line up.
  `VM_LOOKS.rifle.reload` (only without the arms rig) follows the same shape. The bought animation pack, if the owner
  buys it, replaces this.

**Not verified:** anything on a real GPU, in motion or with a mouse; the reload played through in the game (frozen
frames and Blender previews only); the draw against the lowered still (see the table); the pistol and knife framing
against the references (none were sent for the pistol; the knife only for its grip).

## Package P (armor) in detail

Built 2026-11-18 on `claude/armor-d76a28` (from `main` at `d2d5098`), **protocol 16**, 481 tests (20 new), typecheck
clean; `server/src/prediction.test.ts` passes unchanged. Reviewed (protocol, server and rule diffs read line by line), merged into `main` and pushed 2026-11-18 with the game server restarted on protocol 16. Rule approved by the owner 2026-11-18.

**The rule** (`shared/armor.ts`, the only place it lives; `MAX_ARMOR` 100 and `ARMOR_ABSORB` 0.5 in `shared/constants.ts`).
Every player (defenders, ghosts, bots and practice targets alike) spawns with 100 health and 100 armor: round starts,
warmup respawns and practice respawns all go through `Game.spawn`, which resets both. A torso, arm or leg shot, or a
knife hit from the front: `absorbed = min(armor, floor(amount x 0.5))`, armor loses `absorbed`, health loses the
rest. A headshot or a knife back-stab ignores armor (health takes it all, armor unchanged). Death is still health 0,
whatever armor is left. `applyDamage(vitals, amount, kind, zone, out)` changes a `{ health, armor }` in place and
writes what it removed; `Game.damage` calls it for every hit (shots and both knives), so bots and targets follow it
too. Nothing on the client predicts damage, so the client never runs the rule; it only shows what the server sends.

**Bomb explosion:** the explosion deals no damage today (the round simply ends with `exploded`), so there was nothing
to apply armor to. Decided for when explosion damage is added: treat it as a body hit (armor takes half), through the
same `applyDamage`.

**What travels where (information rule).**
- Self snapshot: the player's own armor is one byte at offset 15, right after health; everything after it moved one
  byte (`SNAP_LOADOUT` 75 to 76). Other players' entries (`PlayerSnap`) carry no armor, so nobody is ever sent an
  enemy's or a teammate's armor (allies' armor was not needed).
- `dmg` (sent only to the victim): `amount` is now the health the hit removed, and a new `armor` field (absent when
  0) is what it took from the victim's own armor.
- `hitconfirm` (to the attacker): `damage` stays the hit's full amount. In a match nothing about armor is added. In
  the practice range only, `armor` says how much of it went to the target's armor; the top strip reads
  `34 body (17 armor / 17 health)` or `68 head (all health)`.
- Shot and slash events still carry the full `damage`, as before; they say nothing about armor.
- `stats.damage` counts health plus armor removed (health capped at what the victim had), so it is about twice what
  it was for body hits, and `mvpScore` (`damage / 100`) weighs damage a little more than before.

**Client.** Interfaces first: `LocalView.armor` (`presenter-api.ts`) and `AudioEngine.armorHit()` (`audio-api.ts`).
HUD (`presenter.ts`): a shield and the armor number beside health in the same 52 px type, light blue; on a drop it
flashes white for 0.18 s and fades back over 0.3 s; at 0 the shield and number dim to 28 %. The spectator view shows no
teammate health today, so it shows no armor either. Sound (`audio.ts`): when a `dmg` carries armor, the victim hears
the recorded metal bullet impact (package H's sample set; the synthesised impact until it loads), non-positional, on
top of the usual hurt sound; the attacker hears nothing new. The sound test page (`?soundtest=1`) has "Hurt with
armor hit". `main.ts` takes armor from the self snapshot and lowers it at once when a `dmg` says so (the next
snapshot confirms it).

**Hits to kill from a fresh spawn** (checked by `shared/armor.test.ts`; "after" is while the armor lasts, which is the
whole fight for a single attacker):

| Weapon, zone | Damage (armor + health) | Before | After |
|---|---|---|---|
| Rifle head | 68 (0 + 68) | 2 | 2 |
| Rifle torso | 34 (17 + 17) | 3 | 6 |
| Rifle arms or legs | 17 (8 + 9) | 6 | 12 |
| Pistol head | 52 (0 + 52) | 2 | 2 |
| Pistol torso | 26 (13 + 13) | 4 | 8 |
| Pistol arms or legs | 13 (6 + 7) | 8 | 15 |
| Defender knife, front | 35 (17 + 18) | 3 | 6 |
| Defender knife, behind | 70 (0 + 70) | 2 | 2 |
| Ghost knife, front | 55 (27 + 28) | 2 | 4 |
| Ghost knife, behind | 100 (0 + 100) | 1 | 1 |

Mixed: a rifle headshot followed by body shots needed 1 body shot before and needs 2 now (68 + 17 + 17).

**Balance, flagged for the owner (nothing retuned):**
- **Time to kill doubles for body shots.** Rifle torso goes from 3 shots (0.2 s at 10 per second) to 6 (0.5 s). Long
  sprays climb with recoil, so in practice more shots miss; headshots matter much more than before because they skip
  the armor.
- **A pistol cannot kill with arm or leg shots from one magazine** (15 hits needed, 12 in the magazine).
- **The ghosts' front stab nearly stops working:** 4 swings 0.7 s apart (about 2.3 s within 2 m of an armed
  defender) instead of 2. Ghosts now depend almost entirely on the back-stab, which is unchanged (one hit). Ghosts
  also gain armor against guns, so they survive being found for longer; which effect wins is unknown until it is
  played. Ghost bots already lose almost every round against defender bots (package E); no bot match was measured
  after this change.
- **The defender knife** needs 6 front hits (about 3.7 s) and is now nearly useless from the front.
- `stats.damage` and the MVP score rise for body damage (armor counts), so result cards before and after are not
  comparable.

**Tests** (20 new): `shared/armor.test.ts` (every zone for both guns, both knives front and back, armor running out
mid-hit, odd amounts rounding toward health, a 1-damage hit, the cap at the health there was, hits to kill);
`shared/protocol.test.ts` (armor 0 to 100 round-trips next to health, every self field survives the shift, protocol
16); `server/src/armor.test.ts` (full armor at spawn and in the own snapshot; reset at a round start for a hurt ghost;
a 2-a-side fight in which every message each player receives is checked as it is sent: the self snapshot carries
only the recipient's own armor, no other player's entry has one, `dmg` armor only to the player hit, no `hitconfirm`
armor in a match, and `stats.damage` equals all health and armor the victims lost; the practice range's split, and the
target and the person respawning with full armor; a bot-versus-bot run where armor goes down, never below 0, and is
full at every round start). Existing tests that assumed three rifle shots kill now fire six; the bot determinism
check includes armor.

**Screenshots:** `docs/review/armor/` (README there), by `tools/armor-shots.mjs` on scratch ports 8092 and 5192.
Real: the HUD at full armor, four practice hits listed with their split. Staged: the HUD at 42 and at 0 armor.

**Not verified:** anything with a mouse or on a real GPU; the armor flash (not caught on a still); the armor dropping
from a real hit on the local player in a browser (the server and wire path are tested, the HUD was only fed staged
values); the armor-hit sound by ear (nobody listened; its level 0.6 is a guess); a full match or a bot match measured
for balance after the change; the practice strip at narrow window widths (five long entries). The warmup respawn edge
(Known problems) is unchanged.

## Package Q (visual and feel polish) in detail

Built 2026-11-18/19 on branch `claude/nostalgic-chebyshev-629c37` (from `main` at `321128f`), **reviewed, merged into `main` and pushed 2026-11-19 together with package R**. Client only: `git diff main -- shared server` is empty, no message change, protocol stays 16. 493 tests (12 new in `client/src/polish.test.ts`), typecheck clean. Pictures and how they were made: `docs/review/polish/README.md` (headless Chrome, SwiftShader software GL, scratch ports 8097 / 5197 / 5196). **Nothing was seen on a real GPU, in motion, or with a mouse.** No downloads.

**What changed for the player.**
- **Anti-aliasing on both tiers.** Low: the WebGL screen is created with 4x multisampling (`main.ts`, `antialias`). High: the CameraFrame's scene target is 4x multisampled (`rendering.samples = 4`) with a light sharpen (0.25). The first-person layer is drawn into the same target by the same camera, so the gun and arms are anti-aliased too (its depth clear does not change that). `?aa=0` turns both off (for comparing cost; the WebGL context is created once, so it is an address option, not a setting). TAA was not used (see below).
- **The gun and the players are lit by where they stand.** The fixed realtime sun and flat ambient that lit every player and the gun the same everywhere are gone. `client/src/probes.ts` + `client/src/lighting.ts` build light probes from each map's own baked look at load: CPU copies of the lightmap (512²), the sky strip and each material's average albedo; every axis-aligned triangle of the map mesh is bucketed by its plane, so a ray hitting a collision box face reads the light leaving that face (lightmap at its UV times the surface colour). A probe (1 m grid over the map bounds, computed lazily on first use into preallocated arrays, 48 rays against the collision boxes) stores an ambient cube (light from six directions) and the share of the sun reaching it (6 sun rays from points around it, so shadow edges are soft). A sample blends 8 probes, skipping probes buried in solids. Measured at the review spots on Warehouse (luminance, linear): yard up 0.40, sides 0.28, below 0.30, sun 100%; basement up 0.03, sides 0.05, below 0.08 (after the readability lift), no sun.
- **One shader hook** (`useProbeLighting`) on the weapon, character and stand-in materials replaces the engine's `ambientPS` (the ambient cube; a key light: the sun where it reaches, otherwise a soft light from the brightest side, wrapped a little; a rim light from the view angle so silhouettes read in the dark) and tints reflections by the local light in `reflectionEnvPS` / `reflectionSpherePS` (plus a sharp highlight from the key). Values are a 10 x vec3 uniform `sbLight`: the weapon materials' own values are the first-person gun's (sampled at the eye every frame, eased at 5/s, taken at once after the camera jumps 3 m); each character sets its own on its mesh instances (sampled at chest height, lower when dead). A readability floor (`MIN_AMBIENT` 0.075, `MIN_RIM` 0.03) keeps the gun from going black in the darkest corner while staying clearly darker than outdoors. GLSL only (WebGPU keeps the engine lighting with a warning); the chunk text is checked against engine 2.24 and falls back with a warning if a future engine words it differently.
- **Metal reflects the map, not a studio.** Per map an environment is made from its sky (above), its ground's average light (below, darkened to 45% so a gun shows a horizon line) and its fog colour, at 30% saturation: on High a prefiltered atlas generated on the GPU once per map (`pc.EnvLighting`, 512², 256 samples), on Low a 64 x 64 sphere map of the same picture by height with a soft bright patch (one texture read, as before). Reflection strength follows the local light (dim in the basement). Weapon reflectivity 0.55 to 0.75.
- **The gun moves with you** (`client/src/vmfeel.ts`; presenter interface first: `LocalView.vel`, `onGround`, `crouched`, `pitch`, and `Presenter.setLighting`). Walk and run bob from the real horizontal speed and a step phase (1.8 m a step: one dip per step, one side swing per two), a lean into strafing, look inertia (the weapon trails mouse turns by up to 4 degrees and 1.2 cm and springs back with a little overshoot), a lift on jumping and a dip on landing scaled by the fall speed, a 5-degree tilt and 1.2 cm drop when crouched. All reduced to 15% when fully aimed (landing still shows a little). Applies to the guns and the knife rig. No lowered sprint pose: the game has no sprint (running is the normal speed), so a run pose would be on whenever moving.
- **Recoil feel.** Each local shot kicks damped springs (`VM_LOOKS[..].recoil`): push back, lift, muzzle up, a sideways yaw and a roll, each varied per shot by an integer hash of the presenter's own shot count (no `Math.random`), so the gun settles like a gun coming back to rest; 55% of it when aimed. A camera roll and pitch flick of 0.35 / 0.1 degrees (rifle) and 0.5 / 0.18 (pistol) is added to the camera after the game set it and is gone within about 0.15 s; the game core's recoil offset, which the crosshair follows, is untouched, as are the shared spread and recoil rules.
- **High:** a soft vignette in the compose pass High already runs (no extra pass).

**Numbers** (`docs/review/polish/{before,after}/report.json`; Warehouse, 1366 x 768; frame time = wall-clock between 60 frames under SwiftShader, that is CPU software rendering, not a GPU):

| View | Draw calls before / after | Software frame ms: before / after / after with `?aa=0` |
|---|---|---|
| Low, yard, hip | 20 / 20 | 360 / 302 / 208 |
| Low, basement, hip | 11 / 11 | 274 / 216 / 160 |
| Low, yard, third person | 13 / 13 | 288 / 254 / 167 |
| Low, basement, third person | 13 / 13 | 214 / 162 / 119 |
| High, yard, hip | 42 / 40 (what was in view) | 509 / 495 / 309 |
| High, basement, hip | 33 / 33 | 405 / 373 / 246 |
| High, yard, third person | 39 / 39 | 496 / 407 / 283 |
| High, basement, third person | 39 / 39 | 367 / 301 / 213 |

No draw call was added (still one per viewmodel rig; the probes, the shader hook and the environment add none). In the software renderer the new lighting alone made frames about 40% cheaper than before (the realtime sun's light loop is gone) and 4x multisampling cost about 45% on top; **neither ratio says anything about a real GPU**. Texture reads per weapon or character pixel: Low 3 as before (albedo, normal, sphere map); High 5 (albedo, normal, 3 reads of the environment atlas). Memory: the High environment atlas 1 MB, the Low sphere 16 KB, the CPU lightmap copy 1 MB, the probes up to about 1.7 MB of floats on Warehouse if every probe is visited. Map load does a little more work (reading the map mesh, a 512² downscale of the lightmap, a few GPU passes for the atlas); not timed on a real machine.

**Considered and rejected:**
- TAA on High: ghosting on the fast-moving first-person weapon and jitter with a layer that clears depth; MSAA is cleaner for a shooter's hard edges.
- A colour grade in High's CameraFrame: the world already has a per-map grade inside its shader on both tiers; a second grade would double it on the world and apply once on players.
- A vignette on Low: needs a full-screen pass or a CSS overlay blended every frame; Low has no post-processing by rule.
- Blob (contact) shadows on Low: one more alpha-blended draw call and fill per player; left for after the owner's frame-rate check.
- Specular anti-aliasing (smoothing gloss where normals vary) for metal shimmer at distance: a further shader change; MSAA does not fix shading aliasing. A candidate if the owner sees shimmering metal.
- Baking the probes in Blender with the maps: needs a map rebuild and a format change; the runtime build reads only what each map already ships.
- A lowered sprint pose: the game has no sprint.

**Decisions taken on my own judgment:** probes from collision boxes (visual-only geometry such as pipes is not seen by the rays); a readability floor in the dark; the camera flick per shot (mostly roll, so the crosshair's point does not move); the Low reflection a by-height picture with a fixed bright patch (a sphere map turns with the view); 4x MSAA on Low by default with `?aa=0` as the way out.

**Not verified:** anything on a real GPU, in motion, or with a mouse. In particular: **the cost of 4x multisampling on Intel UHD 620** (the owner should compare `https://stillblade.orcavalley.com/?tier=low` against `?tier=low&aa=0` with "Show FPS and ping" on, in a firefight on Warehouse; if Low drops below 60 the adaptive resolution steps down, and making `aa` follow the tier at page load is a one-line change); whether the bob, inertia, landing and recoil feel right in motion (only two frozen frames were captured; the sizes are first guesses, all in the constants at the top of `vmfeel.ts` and `VM_LOOKS[..].recoil` in `presenter.ts`); the light easing as a player walks from the yard into the building; the Low tier's gun looks a lighter grey than High's in the yard (different reflection path and tone curve); probes on Test Map 1 (only Warehouse was captured); the knife rig's motion; the map swap rebuilding the lighting (code read, not run); WebGPU (not used by the game).
## Package R (the M4 animation pack on the AK) in detail

Built 2026-11-18 on `claude/happy-shannon-6d78bd` (from `main` at `321128f`), **protocol 17**; reviewed, merged into `main` and
pushed 2026-11-19 together with package Q and the hands commit below; the game server was restarted on protocol 17. Package Q (visual and feel polish) was built at the same time in another worktree and owns `presenter.ts`
frame motion, lighting and materials. Pictures: `docs/review/viewmodel/after4/` (README there). **Nothing was seen on a
real GPU, in motion, with a mouse or by ear.**

**The pack.** "M4 - FPS Weapon Animations Pack FREE (v.1)" (Fab Standard License), downloaded by the owner as
`tools/blender/source-art/realistic/fp-anims/m4_animations_gltf.zip` (git-ignored; credited in
`client/public/models/CREDITS.md`, where the owner should add the seller's name, which is not in the download). Checked:
one glTF scene with one 10 s timeline holding five consecutive clips: Reload 0.03-3.67 s, Reload_Empty 3.70-7.50,
Fire 7.53-8.33, Holster 8.37-8.93, Draw 8.97-10.0. Its eye never moves, its right hand never moves on the gun; the
tactical reload pulls the magazine and seats the same one; the empty reload starts with the M4's bolt locked back and
the left palm slaps the bolt catch at about 2.6 s. **Only motion is used**: none of its meshes or textures ship.

**Decisions taken on my own judgment.**
- **Hands: ours kept.** The pack's hands are fingerless camo gloves on bare forearms with no sleeves. Our team looks
  depend on the sleeves (defenders' orange rolled sleeves with coyote gloves, the ghost's dark suit), a tint on bare
  skin would read as orange skin, and ours already match the third-person soldiers. So the pistol and knife are
  untouched (the knife grip still closes; `game-after/05`, `06`).
- **Hip and aim poses: ours kept.** The pack holds its M4 dead centre and close, mostly its rear sight in view; our
  framing was matched to the owner's reference stills. (The pack's own framing was rendered only to scratch, not
  committed, since the pack must not be redistributed.)
- **How the motion is moved** (`tools/blender/fpanims.py` reads the glTF with the standard library and mathutils;
  `viewmodel.py` `PackRetarget`): the gun's motion relative to the eye, as a change from the pack's idle hold about
  its grip, applied to our gun at our hip pose; the magazine's motion relative to the gun, pivoted at the top of the
  well, its travel along the M4's axis put along the AK's (raked) axis, plus an **AK rock** of 18 degrees about the
  front of the well over the first 3.5 cm (`MAG_ROCK`); the left hand's motion relative to the handguard, then
  relative to the magazine while it holds it (blended by `PACK_MAG_KEYS`), applied to our own grips; finger curls are
  our grip tables plus the pack's change in each joint's bend; the shoulders follow the hands by 35 % and lean in when
  out of reach. The last 8 % of each clip blends exactly onto the idle hold.
- **Our gun sits closer and lower than the pack's**, so the magazine well would have been changed below the screen
  edge: during the magazine change the gun also rises 5.5 cm and comes in 2.5 cm (`PACK_RELOAD_LIFT`), as in the
  owner's reference reload.
- **Empty reload, the AK's charging handle** (`PACK_BOLT_*`): the M4 bolt-catch slap (2.2-3.05 s in the pack) is
  replaced by an **overhand rack**: the left hand goes over the top of the receiver, fingers over its right edge onto
  the handle (the `rifle_handle` mark), pulls it back 7 cm and lets it go; the AK rolls its top 25 degrees left and
  dips its muzzle so the eye looks down onto the hand. Rolling or turning the AK far enough to show its right side from
  this close made it point straight at the eye (tried and dropped). Seen from the right in
  `blender-after/rifle-empty-3-handle-pulled-right.jpg`; from the eye the forearm and hand cross over the receiver
  (`game-after/03-empty-3`, `-4`). Our AK's bolt stays forward on an empty magazine (an AK has no hold-open), so it
  only moves when the hand pulls it.

**Timing (the clips fit the rules, never the other way round).**

| Our clip | From the pack | Our length (rule) | Speed-up |
|---|---|---|---|
| `rifle_reload` | Reload 0-2.95 s (its motion ends there, then it holds) | 2.2 s (`reloadTicks` 132) | 1.34x |
| `rifle_reload_empty` | Reload_Empty 0-3.45 s | 2.7 s (`reloadEmptyTicks` 162, new) | 1.28x |
| `rifle_draw` | Draw 0-0.70 s | 0.4 s (`drawTicks` 24) | 1.75x |
| `rifle_fire` | Fire 0-0.30 s (kick, bolt back and forward) | 0.1 s (`fireInterval` 6) | 3x |
| `rifle_holster` | Holster, whole | 0.567 s (no rule) | 1x; **no longer exported** since the sleeve follow-up (`SB_PACK_HOLSTER=1`) |

The tactical reload stays under the 1.4x line, so 2.2 s is kept and no change is recommended. **The draw is 1.75x**:
fast but it reads as a quick raise; if the owner finds it rushed, 0.55 s (`drawTicks` 33) would make it 1.27x, a rule
change for him to decide. The holster clip was never played (a switch only draws the new weapon; the rule has no
holster time) and was dropped from the file in the sleeve follow-up to keep the Low download under its budget.

**The empty reload (shared rule, protocol 17).** `WeaponDef.reloadEmptyTicks` (rifle `ticks(2700)` = 162; the pistol's
equals its `reloadTicks`, it has no separate empty reload). `stepGun` starts a reload from an empty magazine with
`reloadEmptyTicks` (both by R and by pulling the trigger on empty), otherwise `reloadTicks` (`reloadTicksOf`). The
magazine does not change while a reload runs, so `emptyReload(g)` (reload running and magazine 0) tells the kind at any
moment and the snapshot needs no new field; `reloadProgress(g, def)` is the 0..1 the client shows. Counted in processed
commands like every timer (162 fits the byte). The only message change: the reload `sound` event carries `empty: true`
for an empty reload (same recipients as before, no position added), so other players hear the bolt; hence protocol 17
(16 before). The local player's `LocalView` has `reloadEmpty` (presenter interface changed first) and
`AudioEngine.reload` takes an `empty` flag (audio interface first). **The game server must be restarted with the
client when this lands.**

**Sounds** (`audio-logic.ts RELOAD_CUES`, `audio.ts`): tactical: magazine out 0.71 s, in 1.55 s, **no bolt** (a round
is chambered); empty: out 0.74 s, in 1.63 s, charging handle 1.94 s (the synthesised bolt slams home 0.125 s later,
`RELOAD_BOLT_SLAM`). The times come from the pack's events at the speed-ups above (`viewmodel.py` logs them as
"pack cues"). The recorded bolt sample (`reload_rifle_bolt`) now plays only in the empty reload. The sound test page
has "Rifle empty reload (2.7 s)". Pistol unchanged.

**`presenter.ts` changes (all of them; frame motion, lighting, environment and anti-aliasing untouched):**
`VM_LOOKS` gains `joltsEmpty` and the rifle's `jolts` are re-timed (1.55 s; empty 1.63 and 2.07 s; used only without
the arms rig); `SLOT_LOOKS` turns both into fractions (`joltsOf`, `joltsEmptyOf`); clip names `RELOAD_EMPTY_CLIP`,
`DRAW_CLIP`, `FIRE_CLIP`; in `updateViewmodel` the rig's clip is chosen as reload (the empty clip when
`local.reloadEmpty`) by progress, else the draw clip by draw progress (and then the procedural draw offset `d` is 0),
else the fire clip by `vmFireT` (seconds since the last local shot, reset in `shot()`), else idle; `d0` moved up for
that. A rig without the new clips (the pistol, an older file) behaves exactly as before.

**Tests** (490 in all): `shared/gun.test.ts` (the empty reload's length per gun, R on empty versus partial, the kind and
the progress through every command, unarmed commands still count, a switch cancels it for nothing, every counter in its
byte), `server/src/empty-reload.test.ts` (162 commands from empty with `empty: true` heard by players in range and not
the shooter, 132 for a tactical one without the flag, no shortening by jumping command numbers),
`server/src/prediction.test.ts` now also requires empty reloads among its reloads (zero disagreements),
`client/src/models.test.ts` (the new clips' lengths equal the rules'), `audio-logic.test.ts` (cue times inside each
reload). Two timing-sensitive tests (`bots.test.ts`' 11 s fight, `namefilter.test.ts`' 200 ms scan) failed once each in
a full run while the PC was busy and pass on their own; they were not touched.

**Numbers.** `viewmodel_rifle.glb` 1.10 -> 1.29 MB (five new clips); one skinned mesh, one draw call as before; no
textures changed; the Low download stays under `models.test.ts`' budget. No per-frame allocation added (clip lookups
are `Map.get` on prebuilt names).

**Rebuilding.** `viewmodel.py` uses the pack whenever the zip is present (`SB_FP_PACK=0` forces package O's generated
rifle clips, kept as the fallback). It needs `source-art/realistic/build/weapons_fp.glb` and the soldier sources as
before (this worktree used a junction to `realistic-soldiers-bcc8fb`'s `source-art`, into which the pack zip was
copied). The rifle rebuild is deterministic (checked: an unchanged build reproduced `main`'s file byte for byte).
Review pictures: `tools/fp-anim-shots.mjs`.

**Not verified:** anything in motion on a real GPU, with a mouse or by ear (Blender Workbench stills and SwiftShader
frozen frames only); whether the 1.34x and 1.75x speed-ups feel rushed; the fire clip under real automatic fire (it is
replaced by the aimed-arms pose when aiming, so the bolt does not cycle visibly while aimed); the hand passing through
the red dot or 2x scope during the overhand rack (not seen in the pictures, not checked frame by frame); the
magazine's rock against the AK's well frame by frame; third person: a remote player's empty reload still plays the
2.2 s third-person clip and then holds until the 2.7 s reload ends; the in-game draw frames landed late (see the README
there); the seller's name for the credits.

### Package R, second commit: the pack's gloved hands (a trial, 2026-11-19)

The owner asked to try the pack's gloved hands on all three rigs, saw the comparisons and had them merged and pushed 2026-11-19 (the defender sleeve is to be improved next). **It is one commit on top of package R so it can be
dropped** (`git revert` it, or rebuild with `SB_PACK_HANDS=0`: `weapons.py`, then `viewmodel.py`). No rule, message,
client code or protocol change: art and Blender scripts only (`presenter.ts` and `weapons.ts` untouched). Pictures:
`docs/review/viewmodel/after5/` (README there): old and new side by side for every moment in `compare-blender/` and
`compare-game/`.

**How** (`tools/blender/packhands.py`, called by `viewmodel.py` and `weapons.py`):
- **Skeleton:** our rig keeps its arms; its finger and thumb bones are moved onto the pack's hand skeleton (its bind
  pose), fitted rigidly to our wrist by the two hands' frames (wrist, knuckles, the line across the knuckles). Every
  grip, curl and clip reads the bones, so the rifle (idle, aimed, both reloads, draw, fire), pistol (idle, reload) and
  knife (idle, swing) grips refit by themselves; no grip constant was changed.
- **Size:** the pack's hands are about 1.4 times our soldier's (12.7 cm wrist to knuckles against 9.0, a 10 cm cuff),
  so they are drawn at 0.71 (`PACK_HAND_SCALE`): our guns, grips and third-person characters are sized for our hand.
- **Mesh:** the pack's glove (2,412 triangles) and skin (only the fingertips and the wrist under the cuff are kept; its
  bare forearm above the glove's cuff is cut away), skin weights renamed onto our bones (its hand to `Wrist`, finger
  joints 1-3 to our 2-4, its forearm to the wrist-end twist bone). Still one skinned mesh and one draw call per rig.
- **Sleeves:** defenders get a generated tube from just over the glove's cuff to past the elbow, skinned along the
  forearm twist bones, textured with a plain patch of the Quantum shirt's orange fabric (the whole fabric crop streaked
  along the tube; the rolled cuff mesh no longer fits a full sleeve and is dropped). Ghosts keep their suit forearm
  (the Quantum body), its own hand cut away, reduced to 1,200 triangles.
- **Team looks:** the glove's colour is recoloured coyote in the atlas (its light and dark kept); a ghost's glove is
  tinted near-black by vertex colour and its bare fingertips darkened to 45 %. The pack's ORM blue channel reads fully
  metallic although its materials set metalness 0: it is ignored.
- **Atlases** (`realistic.ARM_LAYOUTS_PACK`): the arms' skin rectangle becomes `glove` (a quarter of the atlas height)
  and `handskin` (the fingertip crop of the skin map); `sleeve` and `ghostarms` unchanged; 2048 for High, 1024 for Low as
  before.

**Numbers.** Arms: defender 4,678 triangles (was 5,000), ghost 4,213 (was 4,500). `viewmodel_*.glb` sizes within 1 KB
of before (rifle 1,293,056, pistol 654,276, knife 583,816 bytes). Atlases (the six albedo and normal files per tier):

| | Before | After | Change |
|---|---|---|---|
| Low (1024) | 801,794 bytes | 904,932 bytes | +103 KB |
| High (2048) | 2,179,830 bytes | 2,482,014 bytes | +302 KB |

`models.test.ts`' Low download budget still passes; 490 tests and typecheck pass.

**What looks better (judged from SwiftShader stills only):** the coyote gloves read as real tactical gloves, with
stitching, knuckle padding and a wrist strap, where our old hands were bare skin; the fingers wrap the AK grip, the
Makarov and the knife convincingly; the ghost's near-black glove on the dark suit is a clean, readable silhouette; the
overhand AK handle pull shows a gloved hand over the receiver.

**What looks worse or is weaker:** the defender's sleeve is a plain smooth tube (no folds, a slightly darker
burnt-orange than the third-person shirt) where the old rifle view showed the soldier's rolled sleeve; the glove's
texture is softer than the guns at High (1024 source in a 512-pixel rectangle); the knife's thumb rests along the spine
rather than wrapping over the fingers (the fist itself is closed round the handle, checked from the side in
`compare-blender/knife-idle-side.jpg`); the bare fingertips are small and can look like skin-coloured blobs at a
distance.

**Not verified:** anything on a real GPU, in motion or with a mouse; the glove and sleeve lighting on High and in
Warehouse; whether the pack's normal map is the right handedness (glTF requires OpenGL style and it was used as is;
not checked by rendering both ways); fingertips poking through the guns frame by frame during the clips (none seen in
the stills); the third-person characters, which still have the soldier's own hands (first person only changed); the
seller's name for the credits.

### Package R follow-up: the defender's sleeve from the soldier's own shirt (2026-11-19)

The owner's review of the hands trial: the orange sleeve was a plain smooth tube, blotchy, with no folds, not matching
the third-person shirt, ending abruptly at the glove. Built on `claude/happy-shannon-6d78bd` after merging `main` at
`3a5f2e7` (packages Q and R); reviewed, merged into `main` and pushed 2026-11-19 on the owner's word (no server restart needed). Art and Blender scripts only (no simulation, protocol or client
logic; one comment in `presenter.ts` about the holster clip). Pictures: `docs/review/viewmodel/after6/` (README there),
Low and High, lit and dark, under package Q's lighting.

**What it is now** (`tools/blender/packhands.py` `sleeve_from_shirt`, used by `viewmodel.py`; `SB_SHIRT_SLEEVE=0` brings
back the tube). The Quantum kit has only the rolled-up shirt (no long sleeve), but its upper-arm sleeve is real shirt
geometry with folds, textured with the same maps as the third-person shirt (already in each gun atlas's `sleeve`
region, dyed the same orange). Per arm that sleeve is cut out with two planes (from 22 % to 75 % of the upper arm, above
the rolled cuff and below the armpit) and laid along the forearm: its elbow end at the wrist, its shoulder end 10 cm past
our elbow (that part follows the upper arm, so the open end never comes into view). Each vertex keeps its angle round the
arm and its fold relative to the cloth; the radius is fitted so the outer folds (85th percentile) meet the glove's strap
plus 2.5 mm at the wrist, loosening to 8 mm over 3.5 cm and growing 1.65 times toward the elbow. The source is subdivided
once and given **compression folds** just above the cuff (ridges 3.5 mm high, 16 mm apart, slanting round the arm,
fading over 5 cm), then reduced to 600 triangles per arm. The **cuff** is cut on a 7-degree slant (lower under the arm),
starts 3 mm onto the strap and takes 12 % of the hand's motion at its very edge, so it sits on the strap when the wrist
bends; the cloth rides mostly on the half-roll twist bone (loose cloth turns less than skin). The pack's wrist skin (under
the glove; it poked through the cuff in the overhand handle pull) is no longer in the mesh, only the fingertips' skin.

**Bytes and triangles.** The atlases are unchanged. Defender arms 5,091 triangles (were 4,678 with the tube), ghost 4,147
(4,213: only the wrist skin went). To stay under `models.test.ts`' Low budget (4.5 MiB; `main` was 7 KB under it and the
sleeves add about 15 KB per rig) the rifle's **holster clip is no longer exported**: nothing played it, the rule has no
holster time (`SB_PACK_HOLSTER=1` adds it back). Files: rifle 1,293,056 -> 1,264,716 bytes, pistol 654,276 -> 662,324,
knife 583,816 -> 589,480: **14.6 KB less in all**, on both tiers. 502 tests and typecheck pass.

**Ghosts:** unchanged. Their sleeve is the Quantum body's own forearm as a suit (real geometry, not a tube; it already
meets the near-black glove), so it does not have the tube's problem.

**Better (SwiftShader stills):** the sleeve has the shirt's fabric, shading and fold texture, and real folds bunched at
the wrist; the cuff closes onto the glove's strap on a slant, with no gap and no ring, in the hip, aimed, handle-pull,
pistol and knife views, Low and High, lit and dark; the old blotchy stretched patch and the bare wrist in the handle
pull are gone.

**Still weak:** the colour still varies along the sleeve (the shirt texture's own baked shading, the same as third person
up close, but more visible this large); when aiming, a narrow strip of the left sleeve shows below the rail with a
slightly ragged fold edge; the fold geometry is modest (the source shirt has about 270 faces per sleeve section);
nothing cloth-like moves (it is skinned, not simulated).

**Not verified:** anything on a real GPU, in motion or with a mouse; the draw and both reloads in motion with the new
sleeve (only the handle-pull frame was captured in game; the Blender previews cover the reload, draw and knife frames as
stills); the ghost's sleeve under package Q's lighting (not re-shot); the High tier on a real graphics card.
## Package S (loading screen with real progress) in detail

Built on branch `worktree-loading-screen` (2026-11-19); **reviewed, merged into `main` and pushed 2026-11-19** (no server restart needed). No protocol, `shared/` or server change; 523 tests (21 new in `client/src/loading.test.ts`). Pictures and the network log: `docs/review/loading/` (`log.json` lists every shot with its percentage and line, and every request per scenario).

**What the player sees.** Joining a room (from the menu, by link, the practice range, or a rejoin) shows one card: the map's name and room code, one bar with a percentage, a line saying what is loading right now ("Map: Warehouse (lighting) 2.4 / 3.5 MB", "First-person hands 1.2 / 2.5 MB", "Sounds 18 / 74", "Building lighting…", "Connecting to server…"), and the steps ticked off with their downloaded and total sizes (a file that came from the browser cache says "cached"). A map change between matches shows the same card over the game with only the map and its lighting. On the menu a quiet "Preparing game files · 41 %" line under the card follows the models downloading in the background. If the current step makes no progress for 10 s: "This is taking longer than usual…" (and **Play now** when only optional things are left: the box stand-ins and synthesised sounds cover them until they arrive). A failed download shows "Download failed", **Try again**, and **Continue without them** (only optional steps failed) or **Back to menu** (the map failed). Only assets and connection steps are shown, never anything about players.

**How it works.**
- `client/src/loading.ts` (pure, tested): a `LoadTracker` of steps (`connect`, `graphics`, `map`, `lighting`, `weapons`, `characters`, `hands`, `sounds`). Download steps weigh by bytes; time-only steps by a fixed share of the bar (connect 5 %, graphics check 4 %, lighting 4 %), creeping toward 90 % of their share while running. A `LoadScreen` reads a chosen list of steps: the shown bar never goes backwards, stays at 99 % at most until every step has finished, and reaches 100 % exactly when all are done, skipped or given up. Optional steps (weapons, characters, hands, sounds) can be given up; the map, connecting and the graphics check cannot.
- Sizes come from `virtual:asset-sizes`, a Vite plugin (`tools/asset-sizes-plugin.ts`) that measures every file in `client/public` and lists each map's files from its JSON at build time (a few KB in the script, no extra download), so totals are known before a byte arrives and a compressing server changes nothing. A file it does not know uses its Content-Length when uncompressed, else a 512 KB guess that grows with what arrives.
- `client/src/fetch-progress.ts`: `fetchTracked` fetches a file once with a streamed body (counting decoded bytes) and, on a network or HTTP failure, waits for Try again or giving up while a loading screen holds failures (`LoadTracker.holding`); with no screen up it gives up at once and the loader falls back as before. `loadAssetTracked` replaces `app.assets.add + load`: it fetches the bytes itself and hands them to PlayCanvas through `asset.file.contents` (the engine's own loaders read them, so the file is never downloaded twice), and a file the engine already holds (a texture two maps share) counts as cached without a fetch. Without a tracker everything loads exactly as before.
- Wired through the interfaces: `CreatePresenter(app, camera, loads?)` and `AudioOptions.loads` (`presenter-api.ts`, `audio-api.ts`). `weapons.ts`, `characters.ts`, `viewmodel.ts`, `maplook.ts`, `audio.ts` (samples) and `main.ts` (`loadMap`, the map JSON) report through it. The samples now load as soon as audio unlocks (the join, on the loading screen; `loadDelayMs: 0`) instead of 1.5 s into the game. `buildMapLighting` blocks the page for a moment, so the screen paints "Building lighting…" first (`yieldToPaint`).
- The join waits for every step it lists (the models and sounds usually finished during the menu) before entering the game; a map change waits for the map and its lighting. UI: `client/src/loading-ui.ts` (the card, redrawn only when something changed, polled 5 times a second), `Ui.showProgress` / `hideProgress` / `setPreparing`, styles in `ui.css` (package L's card; `min(460px, 100vw - 32px)` wide, checked at 390 px).

**Checked** with `node tools/loading-shots.mjs` (headless Chrome, SwiftShader, scratch ports 8098 and 5198, Chrome's network throttled to 4 Mbit/s and 60 ms): a cold first load through the menu and Quick play (98 files, 8.57 MB, every file requested once), a warm room join by link (98 requests, 0.01 MB over the wire: all answered by the cache), a map change to Test Map 1 (7 files, 1.24 MB, the textures it shares with Warehouse not fetched again), the lightmap blocked then Try again (the lightmap requested twice, by design), and the rifle hands held back 12 s at phone width (the note and Play now). `vite build` includes the manifest.

**Not verified:** a real slow or flaky connection (only Chrome's throttling), Cloudflare's live headers (sizes come from the manifest, so they should not matter), a real GPU, the map change after a real match (the screenshot delivered the room's map message to the page's own handler from warmup), the graphics check step (screenshots force `?tier=low`, which skips it), HTTP/2 ordering on the live site (the local dev server is HTTP/1.1, so the map's files queue behind the models for a moment on a cold join), and a failure inside the map change ("Back to menu" there rejoins the room, as before).


## Package T (the M4 everywhere) in detail

Built 2026-11-20 on branch `claude/m4-everywhere-465728` (from `main` at `af09e9c`); **reviewed, merged into `main` and pushed 2026-11-20 on the owner's word; review: tests and typecheck on the branch and on merged `main`, the client diffs read line by line, `git diff main -- shared server` empty, 8 screenshots looked at; reviewer's note: the bare forearms read smooth, pale and plastic and lighter than the soldier's skin (the owner chose to merge as is).** No
rule, number or message change: `git diff main -- shared server` is empty, protocol stays 17, no server restart needed.
524 tests (`models.test.ts` covers the new rig's parts and clips), typecheck clean. Pictures: `docs/review/m4/` (README there: before and after,
Low and High, lit and dark, every sight, both reloads, the locked bolt, the draw, a shot, third person, pistol and
knife). **Nothing was seen on a real GPU, in motion, with a mouse, or heard**: Blender Workbench stills and SwiftShader
frozen frames only.

**What the player gets.**
- **First person, rifle:** the owner's M4 pack exactly as authored: its own bare forearms and fingerless gloves (glove
  recoloured coyote like the pistol and knife hands), its own skeleton and bind pose, its own M4 and its own clips,
  only resampled to the rules: reload 2.2 s (pack 0-2.95 s, 1.34x), empty reload 2.7 s (pack 0-3.45 s, 1.28x), draw
  0.4 s (pack 0-0.70 s, 1.75x), one shot 0.1 s (pack 0-0.30 s, 3x: trigger pull, bolt cycle, kick). Package Q's bob,
  sway, inertia, landing and spring recoil still move the whole rig. No retargeting, no AK.
- **Bolt hold-open:** when the last round is fired the bolt stays back on the bolt catch (`rifle_fire_empty`, then
  `rifle_idle_empty` while the magazine is empty); the empty reload starts from that pose and the left palm slaps the
  catch at 2.04 s, the bolt home at 2.09 s. From the hip the open bolt is on the gun's far (right) side, as on a real
  M4; the raised catch shows on the left (`blender/ours-bolt-locked-right.jpg` shows the open port).
- **Magazine:** in the gun at all times except during the swap (the pack's own: it drops the magazine and seats it
  again; its second magazine never moves and is not shipped). While empty, the magazine's top round is lowered as the
  pack authored.
- **Trigger:** moves on every shot (in the pack's Fire clip).
- **Reload framing:** at the game's fixed 74-degree weapon view the pack's magazine change happened below the screen
  edge (with the pack's own framing as well as ours), so during a reload the whole rig rises 7 cm and comes 3 cm
  closer, blended in and out over the first and last 20 % of the reload (`VM_LOOKS.rifle.rigReload`, presenter.ts).
  The clip itself is untouched.
- **Sights on the M4:** the red dot on the upper receiver's rail ahead of the rear sight, the 2x scope's eyepiece over
  the rail's rear end; the M4's folding rear sight (cut out of the pack's mesh into its own bone, `rearsight`) folds
  away (is shrunk) in first person whenever an optic is mounted. Iron sights are the M4's own (rear aperture, front
  post); the red dot co-witnesses the front post. Aim eye points (shipped gun frame, metres): iron (0, -0.12, 0.198),
  red dot (0, -0.051, 0.185), 2x (0, -0.065, 0.207); `SIGHT_EYE_FALLBACK` re-measured (red dot -0.013, 2x +0.009).
- **Third person:** the soldier holds the same M4 (3,200 triangles, magazine in, its rear sight up) instead of the
  AK-105. Third-person clips unchanged; the hands land on the M4's grip and handguard as they did on the AK (front,
  right and left views in the pictures); no fix was made.
- **Sounds:** `RELOAD_CUES` re-timed to the pack's events at our speeds (tactical: out 0.63, in 1.52; empty: out
  0.69, in 1.62, bolt catch 2.04, `RELOAD_BOLT_SLAM` 0.05 so the synthesised bolt lands at 2.09); the synthesised
  empty reload plays a catch click instead of a charging-handle scrape. `VM_LOOKS.rifle.jolts` re-timed the same way
  (used only without the rig).
- **Pistol, knife, ghosts:** unchanged. Their meshes in `weapons.glb`, their rigs and their atlases are byte for byte
  as before (checked); `after/low-pistol-*` and `low-knife-*` show them.
- **The AK-105 is retired:** nothing of it ships; its credit is removed from `client/public/models/CREDITS.md` (its
  zip is listed as no longer used). The M4 pack's seller is BarcodeGames (filled in 2026-11-20).

**Decisions taken on my own judgment.**
- **Hip framing: ours kept** (the owner's approved hip pose, package O third follow-up). The pack's own placement
  (`blender/pack-idle.jpg`: the gun dead centre, close, seen from behind) was rendered against ours (`ours-idle.jpg`:
  the gun's left side, bigger, the muzzle just right of the crosshair, as in the owner's reference stills). Ours reads
  better as a shooter's view and is what the owner approved. For the pack's placement set `VM_LOOKS.rifle.hip` to
  `[0.0678, -0.2031, -0.154, 0, 0, 0]` (fpm4.py logs it).
- **No aimed-arms clips:** the pack has no aim pose, so aiming moves the whole rig onto the sight line (the arms come
  with it). This replaces package O's aimed-arms clips for the rifle only.
- **Reload lift** (above): a framing offset of the whole rig, not a change to the animation.
- **Holster not used:** a switch has no holster time in the rules (the new weapon starts drawing at once), so the
  pack's 0.57 s Holster could only play by delaying the new weapon or by a rule change; the current switch is kept.
- **Iron eye 12 cm behind the grip** (the AK used 20; on the M4 that made the gun small; 8 cm made the rear sight fill
  the view). `blender/aim-iron.jpg` against `aim-iron-eye20.jpg`.
- **The M4's colour lifted 2.4x:** the pack's M4 base colour is very dark (median 0.11 stored) and has no roughness or
  metal maps; unlifted it was a black silhouette in a first capture, even in the sunlit yard. Its surface value is a
  constant 0.5 (metal-like, so package Q's reflections read), the round's 0.6 (brass) (`weapons.py M4_LIFT`, `M4_S`,
  `BRASS_S`).
- **Glove coyote, forearm skin as the pack's:** the same glove colour as the pistol and knife hands, so switching
  weapons does not change gloves.
- **Optics' first-person triangles trimmed** (2x scope 3,000 -> 1,800, red dot body 1,300 -> 900) to keep the Low
  download under `models.test.ts`' 4.5 MiB budget after the colour lift enlarged the rifle albedo.
- **Grip origin** of the M4 (the point the hand holds, shared by first person, third person and the aim points): a
  third of the way down its pistol grip, measured from the mesh like the AK's (`m4.py`).
- **The bolt-catch sound** uses the recorded bolt sample (a heavy metal impact) at the catch slap, 50 ms before the
  bolt is home.

**Numbers.** First-person rifle: one skinned mesh, 17,916 triangles (the pack's arms 4,480, its M4 7,524 + rear sight
582 + magazine, round, bolt, catch and trigger 1,176, the red dot, 2x scope and suppressor), 51 bones (the AK rig: 22,275 triangles, 46 bones), one draw call.
Third-person M4: 3,200 triangles; its sight and suppressor are merged into it at load as before, so still at most 2
draw calls per armed player. Draw calls in the captured views: Low 20 (lit) / 10 (dark), High 42 / 32 (before: see
the review README). Sizes: Low model download 4,696,976 -> 4,662,534 bytes, High 7,273,572 -> 7,203,930;
`viewmodel_rifle.glb` 1,264,716 -> 1,285,024; `weapons.glb` 302,944 -> 320,076; rifle atlases 1024: 290,256 ->
218,374, 2048: 740,742 -> 633,660. No per-frame allocation added (two more prebuilt clip-name arrays; `local.mag` read).

**Files.** `tools/blender/m4.py` (new: the pack's M4 read as data, its grip frame, parts, landmarks),
`tools/blender/fpm4.py` (new: the rifle rig; `--preview <dir>` renders the Blender pictures, `--aim` the aimed views,
`--no-export` leaves the file alone), `weapons.py` (the M4 instead of the AK; `-- --rifle-only` rebuilds without the
soldier's 1.2 GB texture zip and leaves the pistol and knife atlases alone), `realistic.py` (rifle atlas layout: M4,
red dot, scope, round, glove, the pack's arm skin), `viewmodel.py` (now builds only the pistol and knife; its AK rifle
code is left in but no longer runs), `client/src/viewmodel.ts` (the `rearsight` bone), `presenter.ts`
(empty-magazine clips, `rigReload`, fallbacks, jolts), `audio-logic.ts`, `audio.ts`, `audio-api.ts`, `soundtest.ts`
(cue times), `weapons.ts` (comments), `models.test.ts`, `CREDITS.md`, `tools/m4-shots.mjs` (the review capture).
Rebuild order: `weapons.py`, then `fpm4.py`; the rig rebuild is deterministic (checked byte for byte).

**What the owner must check by playing** (none of it was seen): the reloads, draw and shots in motion (the 1.34x,
1.28x and 1.75x speed-ups, the 3x shot under automatic fire, the reload lift easing in and out); whether the bare
forearm's skin looks right on a real GPU (it reads smooth and pale in software GL); the M4's lifted colour in the yard
and the basement; the aimed views with all three sights at his field of view; the bolt-catch and magazine sounds
against the motion; the third-person M4 in a real match; Low frame rate (draw calls unchanged; the rifle rig has 17,916
triangles where the AK rig had 22,275).

**Not verified:** anything on a real GPU, in motion, with a mouse or by ear; the draw played with an empty magazine
(the draw clip has the bolt forward, so the bolt jumps back when it ends; small, left as is); a remote player's empty
reload in third person (unchanged: the 2.2 s third-person clip, then a hold); the right hand's fingers against the
trigger frame by frame; the pack's normal map handedness (used as is, as in package R); the seller's name.

## Package V part 1 (the knife from the owner's knife pack) in detail

Built 2026-11-20 on branch `claude/knife-pack-d7d621` (from `main` at `ec84382`); **reviewed, merged into `main` and pushed 2026-11-20 on the owner's word (review: tests and typecheck on the branch and on merged `main`, the client diffs read line by line, `git diff main -- shared server` empty, 4 screenshots looked at; reviewer's note: the defender's knife arms wear orange camouflage sleeves while the M4 shows bare forearms).** No rule,
number or message change: `git diff main -- shared server` is empty, protocol stays 17, no server restart needed. 524
tests (`models.test.ts` covers the knife rig's clips against the rules, its joints and its two looks), typecheck clean.
Pictures: `docs/review/knife/` (README there). **Nothing was seen on a real GPU, in motion, with a mouse, or heard**:
Blender Workbench stills and SwiftShader frozen frames only.

**The pack.** "Knife FPS Animations" on Fab (free, Fab Standard License; the seller's name is not in the download:
`[SELLER NAME]` in `client/public/models/CREDITS.md` for the owner to fill in), downloaded by the owner as
`tools/blender/source-art/realistic/fp-anims/knife_fps_animations.unitypackage` (177 MB, git-ignored, in the main
checkout). A Unity package: `tools/blender/knifepack.py` reads it as data (standard-library tar, only a whitelist of
FBX, PNG and WAV files written, paths checked) into `source-art/realistic/build/unzipped/knife-pack/`; its C# scripts,
prefabs and scenes are never run (two were read as text to learn how the pack wires things). Measured (logged by
`fpknife.py`):
- Hands `Hands_rig.fbx`: one skinned mesh, 10,606 triangles, 5,337 vertices, **full-finger gloves and camouflage
  sleeves to the upper arm, no bare skin**; a UE-style skeleton of 63 joints (52 from the upper arms down); the knife
  socket `weapon_r` under `hand_r` (6.9, 2.8, 5.2 cm and 116 degrees from it at idle; the clips move it against the
  hand only in the draw and the inspect).
- Knife `SKM_Knife.fbx`: a karambit ("ViperFANG"), 4,300 triangles, 22.6 cm, skinned to its own bone `spin`; the pack's
  script parents it to the socket at identity, which is what we do.
- Clips (60 fps): idle 5.33 s (a 2.67 s loop twice), draw 1.0, quick_draw 0.5, swing_0 0.667, swing_1/2/3 0.5,
  holster 0.667, inspect 4.83, sprint 0.667, sprint_prepare 0.333, strike_prepare 0.633 + strike_hit / strike_miss (a
  heavy stab), empty. Its animator (`.controller`, read as text) plays swings at 1.1x and chains Swing_0 -> Swing_1 ->
  Swing_3 while the attack is held, then returns through Quick_draw; Swing_2 is in the pack but not in its animator.
  Each swing's "TraceHit" event is at 50.2 % of the clip.
- The eye: its camera hangs from the head bone (6.93 cm along it), **vertical field of view 34.5 degrees**; the head
  bone never moves and turns by at most about 3 degrees.
- Textures 2k (used) and 4k (not): hands and knife colour, normal (OpenGL style, used as is), occlusion-roughness-metal.

**What the player gets.**
- **First person, both teams:** the pack's hands and karambit on its own skeleton, bind pose and clips, nothing
  retargeted (`viewmodel_knife.glb`, `tools/blender/fpknife.py`). Drawn from the pack's own eye with **the pack's own
  34.5-degree view** (presenter.ts `KNIFE_VM_ZOOM`, through the existing viewmodel zoom: at the game's 74 degrees the
  hands were small in the middle of the screen, `blender/vm74-idle.jpg` against `pack-idle.jpg`). Package Q's sway and
  movement feel stay on top, scaled down by the zoom.
- **Idle:** the pack's idle loop (2.67 s), looped.
- **Draw (defender knife, 0.3 s):** the pack's quick_draw (0.5 s) at 1.67x, by the predicted draw progress. Ghosts
  have no switch.
- **Swings:** four clips. Each one's wind-up, from its start to **the moment its blade crosses the middle of the view**,
  fills the rule's 0.2 s windup, so the blade passes the crosshair when the slash lands; the rest plays at the pack's
  1.1x (swing_0: 0-0.265 s in 0.2 s (1.33x), 0.57 s long; swing_1/2/3: 0-0.15/0.17/0.16 s in 0.2 s (0.77-0.83x, a
  little slower than authored), 0.5 s long; all shorter than the 0.7 s between swings). While the attack is held they
  chain as the pack's animator does, **0, 1, 2, 1, 3, 1, 2, ...** (swing_1 starts within 8-10 cm of where 0, 2 and 3
  end, and 2 and 3 where 1 ends; a 0.06 s crossfade hides that gap), chosen by a per-rig counter in the presenter (no
  randomness, no clock). The swing's last pose is held while the attack is held; on release (or 0.8 s after a swing
  with none following) the knife comes back up through the pack's quick_draw at its own speed with a 0.2 s crossfade,
  as the pack returns through Quick_draw. A new swing always starts with that crossfade from whatever is showing.
  Everything is driven by the existing `knifeSwing` event (the predicted windup), as before.
- **Defender look:** gloves coyote (the M4 rig's colour), sleeves the defenders' orange; **ghost look:** dark gloves and
  sleeves. The knife atlas holds the hands in grey (glove and sleeve each normalised; the camouflage pattern muted to
  45 % of its contrast) and the rig's vertex colours tint them; the two looks are two mesh nodes sharing all vertex
  data but the colours (`vm_ghost` reuses `vm_knife`'s accessors), so one draw call and almost no extra bytes.
- **Third person:** the karambit (800 triangles) replaces the Tactical Knife in `weapons.glb` for defenders and ghosts,
  placed in `socket_knife` the way the pack's own hand holds it (its grip frame, built like clips.py's, measured on the
  pack's hand at idle). The third-person clips are unchanged. Still at most 2 draw calls per armed player.
  It reads small from a few metres: the karambit is 22.6 cm and curls out of the fist's pinky side, where the Tactical
  Knife stuck forward 30 cm (`after/low-third-person-defender-close.jpg`). Not scaled up (kept as authored).
- **Sound:** the knife slash sound (`knife_slash_1..4.mp3`) is now the pack's four swing recordings (mono, MP3 64
  kbit/s, through `tools/process-audio.mjs`; the source files go in `tools/audio-source/knife-pack/`). Measured mean
  -20.5 to -21.4 dB against the old Kenney slashes' -19.5 to -20.5 dB (peaks -1.7 to -2.1 against -0.9 and -4.2). The
  windup sound, its range and who hears it are unchanged. No audio interface change was needed (same event, more
  variants: `SAMPLE_SETS.knife_slash` 2 -> 4).
- **Unchanged:** the M4 and pistol rigs and atlases (byte for byte), the gun and pistol meshes in `weapons.glb` (checked
  node by node against `main`), every rule.

**Decisions taken on my own judgment.**
- **The pack's 34.5-degree view for the knife** instead of the game's 74 degrees (above). The guns keep 74.
- **The strike lands where the blade crosses the middle of the view, not at the pack's own hit event:** with the pack's
  view, its "TraceHit" comes 0.07-0.1 s later, when the blade is already at or past the edge (swing_1's knife is off the
  right edge then). This slows the wind-up of swings 1-3 slightly (0.77-0.83x) instead of speeding it up.
- **Clips used:** idle, quick_draw (as the 0.3 s draw: the full draw is a 1 s flourish that would run 3.3x), swing_0..3,
  quick_draw again as the recovery. **Not used:** draw (too long, above), holster (a switch has no holster time in the
  rules), inspect (no inspect key or rule), sprint and sprint_prepare (no sprint rule: running is the normal pace, and a
  lowered knife would look unready), strike_prepare/hit/miss (the knife has one attack), empty.
- **All four swings used**, including swing_2, which the pack's own animator leaves out (it fits the chain: it starts
  where swing_1 ends).
- **Defender sleeves orange**, the team colour and the third-person shirt's: the pack has camouflage sleeves and no
  bare skin, so the M4's bare forearm cannot be matched; gloves coyote like the M4's. The camouflage pattern is muted,
  not removed (it still shows as light and dark orange patches; see `after/low-defender-swing1-strike.jpg`).
- **The M4's bare forearms (reviewer's note):** the knife pack has no skin texture at all, so it offers nothing to
  replace them with. The M4 rig is unchanged.
- **Faces the pack's camera never sees are dropped** (10,606 -> 8,327 hand triangles: the upper arms, mostly), tested
  over every exported frame with a 25 % margin and aspects up to 2.4:1.
- **Vertex weld after quantising** (`fpknife.py weld`): Blender's exporter wrote one vertex per corner because custom
  normals come back slightly different per corner; once stored as bytes they are identical and are merged (17,601 ->
  8,562 vertices). The pack's normals are kept as authored.
- **The knife atlas re-laid out** (karambit 0.375 of the width, hands 0.625, swatches): it no longer needs the
  soldier's texture zip, so `weapons.py` now always writes it; new switch `--knife-only` writes only it (rifle and
  pistol atlases untouched).

**Numbers.** First-person knife: one skinned mesh per look, 12,627 triangles (hands 8,327, karambit 4,300), 53 bones
(52 arm joints and `weapon`), 8,562 vertices in the file, one draw call (checked: only `vm_knife` drawn). Before:
the soldier-arms rig with the Tactical Knife. Third-person karambit 800 triangles. Draw calls in the captured views
(`docs/review/knife/*/report.json`): first person with the knife Low 20 (before 19; only one knife mesh is drawn, the
difference is elsewhere in the scene), High 42 (42); third person unchanged within one. Sizes:
`viewmodel_knife.glb` 589,480 -> 676,596; `weapons.glb` 320,076 -> 321,928; knife atlases 1024: albedo 158,898 -> 62,166,
normal 112,450 -> 104,748; 2048: 368,990 -> 146,750, 429,044 -> 394,920. **Low model download 4,662,534 -> 4,647,068
bytes** (budget 4,718,592), **High 7,203,930 -> 7,036,534**. Sounds +7.8 KB. No per-frame allocation added (the
presenter's knife state is numbers; clips are looked up once at load).

**Files.** New: `tools/blender/knifepack.py` (the safe extractor), `knifekit.py` (the pack read in Blender: meshes,
poses, eye, grip frame, glove/sleeve islands, the grey hands and the tints), `fpknife.py` (the rig; `--preview <dir>`,
`--no-export`; the GLB weld and ghost passes), `tools/knife-shots.mjs` (the review capture; `--quick` for a check).
Changed: `weapons.py` (the karambit, `--knife-only`), `realistic.py` (knife layout), `viewmodel.py` (pistol only now),
`client/src/presenter.ts` (the knife rig: zoom, clips, chain, recovery), `viewmodel.ts` and `weapons.ts` (comments),
`audio-logic.ts` (4 slash variants), `models.test.ts`, `tools/process-audio.mjs` and `audio-map.json` (the swing
recordings, a licence column that is not always CC0), both `CREDITS.md`. Rebuild order: `weapons.py -- --knife-only`,
then `fpknife.py` (deterministic: rebuilt twice, byte for byte the same).

**What the owner must check by playing** (none of it was seen in motion): the swings at full speed with the attack held
(the chain 0, 1, 2, 1, 3 and its 0.06 s crossfades), whether the blade crossing the crosshair feels like the moment of
the hit, the recovery after letting go, the 0.3 s draw (the quick draw at 1.67x), the 34.5-degree framing at his field
of view and screen shape, the orange sleeves with their muted camouflage, the ghost's dark hands in a dark corner, the
karambit in other players' hands, and the new slash sounds by ear.

**Not verified:** anything on a real GPU, in motion, with a mouse or by ear; the "before" swing pictures were taken
with an earlier version of the capture (full game speed), so some of their strike frames fall after the old swing;
the seller's name; whether the pack's normal maps are meant to be read as they are (no flip in its shader, used as is).

## Package W (persistent server data: feedback, match records, input recordings) in detail

Built 2026-11-20 on branch `claude/match-data-dbe9ea` (from `main` at `efa150d`); reviewed, merged into `main`, pushed and deployed to the VPS 2026-11-20 on the owner's word (review: the `shared/protocol.ts`, `game.ts`, `main.ts` and `rooms.ts` diffs read line by line (protocol change is a byte-identical refactor), `roomdata.ts`/`datastore.ts` error handling read, tests and typecheck on the branch and merged `main`, a 12-minute 10-bot Warehouse match recorded and replayed by the reviewer with all 733 checkpoints matching (7.1 MB gzip); the bench not re-run; on the VPS `deploy/data` created owned by uid 1000, the container writes `/data`, `npm run data -- matches|feedback` reaches it; Caddy's access log was turned off in the same deploy so player IPs are not logged). **No rule, simulation, timing or wire-format change; protocol still 17.** 546 tests pass (524 before), typecheck clean, `prediction.test.ts` unchanged and passing. Nothing was seen in a browser (the privacy page was checked by tests and the type checker only), and nothing touched the live VPS.

**What it is, in plain words.** The server now keeps three things in one folder that survives rebuilds: what players send with "Send feedback" and the automatic error reports (as before, but no longer lost), a record of every round and match (who won, how, who killed whom with what, where), and a recording of every match's inputs that can be played back through the server's own code to get exactly the same match again (for replays, for checking bugs, and later for teaching bots to play like people). The owner reads it from his PC with `npm run data -- ...` (DEPLOY.md "Everyday tasks"). The main menu has a "Privacy" link saying what is kept and for how long.

### Where things live

| Path (in `SB_DATA_DIR`: `./data` locally, `/data` in the container = `~/stillblade/deploy/data` on the VPS) | What |
|---|---|
| `feedback.log` | Reports, unchanged format (package B, "Reading the log"). `SB_FEEDBACK_FILE` still overrides the path ('' = console only). |
| `matches/<YYYY-MM>.jsonl` | Match records, one JSON line each (below). Month by UTC time of writing. |
| `recordings/<YYYY-MM-DD>-<room>-<n>.sbrec.gz` | One input recording per match (below). `n` counts from 1 and never overwrites (files are opened with `wx`). |

Code: `server/src/game-events.ts` (the `GameObserver` interface), `game.ts` (only `this.observer?.x?.(...)` calls added, 20 places), `datastore.ts` (folder, async append queue, recording files through gzip, retention), `matchlog.ts` (match records), `recording.ts` (recorder and format), `replay.ts` (parser and replay), `roomdata.ts` (per-room wiring; each observer is wrapped so an exception switches it off with one warning instead of breaking a tick), `rooms.ts` (attaches it to every new room except practice ranges; tells it when the room closes), `main.ts` (config, startup folder check, finishing recordings on SIGTERM; about 15 lines), `shared/protocol.ts` (`encodeCmd` split into exported `writeCmd`/`readCmd`, which write and read the same 26 bytes; `CMD_BYTES` exported), `shared/privacy.ts` (retention defaults and the privacy text: one source for the server and the page). Tools: `tools/data.ts`, `matchstats.ts`, `matchsummary.ts`, `reportformat.ts`, `replay.ts`; `botmatch.ts --record <folder>`, `bench.ts --bots --record`. Client: `client/src/ui.ts` (the Privacy page and a small link under the menu buttons), `ui.css`, `menu-logic.ts` (the `privacy` page id). Deploy: `Dockerfile` (`SB_DATA_DIR=/data`, `/data` owned by `node`, `SB_COMMIT` build argument), `deploy/docker-compose.yml` (`./data:/data`, `SB_DATA_DIR`, the `SB_COMMIT` argument). `.gitignore`: `/data/`, `/deploy/data/`, `/vps-data/`.

### Match records (`matches/*.jsonl`)

Every line has `type`, `time` (written, ISO UTC), `started` (its match's start; with `room` it names the match), `room`, `map`, `options` (the room options). Types:
- `round`: `round`, `ghostSide` (0 or 1: which fixed side played ghosts), `winner`, `reason` (`eliminated`, `exploded`, `defused`, `time`), `seconds` (live start to end), `score` (by role) and `sideScore` (by fixed side) after the round, `plant` and `defuse` (`by`, `name`, `site`, `pos`, `at` seconds into the live round; or null), `kills` (`at`, killer and victim ids and names, `killerTeam`, `weapon` `rifle`/`pistol`/`knife`/`ghost knife`, `kind` `shot`/`knife`/`backstab`, `zone` for shots, both positions to the cm, `dist` in m), `players` (everyone who took part: `id`, `name` (the shown, already filtered name), `team`, `side`, `bot`, `damageDealt`, `damageTaken` (health plus armor removed), `alive`, `left` if they left mid-round).
- `match`: `rounds`, `winner`, `winnerSide`, `score`, `sideScore`, `seconds` (game time), `mvp`, `mvpName`, `players` (every player's `MatchStats` with `team`, `side`, `bot`), `recording` (file name or null).
- `abandoned`: `why` (`hold expired` = the disconnect hold ran out, `room closed` = everyone left, `server stopped`), `rounds`, `sideScore`, `seconds`, `recording`.

Not recorded: warmup, practice ranges, kills and damage after a round was decided (the 5 s result pause; they still count in `MatchStats`), addresses, chat, report texts. A whole Warehouse bot match (11 rounds) is 32 KB of lines. Lines are turned into text off the tick (`setImmediate`) and appended in order per file.

### Input recordings (`recordings/*.sbrec.gz`)

The layout is in `server/src/recording.ts`'s top comment: `SBREC1\n`, a JSON header (format, protocol, commit, start time, room, map and a hash of its boxes, spawns and sites, room options, tick rate, the tick the match began in, the next player id, and every player: id, name, cleaned requested name, team, side, bot, fill-bot flag, join time, idle flag, chosen sight, their last command before the match, and for an idle player sitting out their position and health), then records: `TICK` (8-byte time), `CMD` (player id and the 26-byte wire command, exactly as received), `CMDX` (the same with every number as float64; used only when the wire format cannot hold a command exactly, which in practice means the server's own bots, whose commands are computed at full precision and never cross the wire), `EVENT` (JSON: joins, leaves, lobby and vote messages, warmup team switches, spawns with position, yaw and sight, deaths, round start with the carrier, phases, plant, defuse, round end, halftime swap, hold, end), and `CHECK` once a second (phase, rounds, score, carrier, then per player alive/onGround/crouched/team, position, health and armor as float64, and a 32-bit hash of the whole loadout, ghost knife and bomb carry).

**Ticks are recorded from the match start to its end, not only the live part** (my decision): freeze, live, planted, the 5 s pause between rounds and warmup during a hold all have commands that move players and count down weapon timers, so an exact replay needs them.

**Replay** (`npx tsx tools/replay.ts <file...>`, `server/src/replay.ts`): a fresh `Game` with the recorded map and options gets the recorded players with their exact ids (spare ids used up by placeholder bots), each bot's mind replaced by a playback of its recorded commands; then each TICK runs `Game.tick` with that tick's bot commands queued, each person's command goes to `Game.handleCmd`, and joins, leaves and lobby messages go where `Rooms` and the socket send them; bots the fill option adds or removes are added and removed by the replayed `Game` itself. Every CHECK is compared exactly. It reports `all N checkpoints match` or the first that differs, with what differs. **Nothing beyond the commands was missing**: lag-compensation view times are in the command, and the server's position history is rebuilt by the replay. What the replay relies on: the same code (the header names the commit; a different protocol version is warned about) and the same map build (refused if the map hash differs). Known limits (edge cases, not seen): a returning player's restored statistics are not reproduced exactly when two people in the room asked for the same name (statistics are not in checkpoints anyway); a kick vote already running when the match began is not carried over; commands with non-boolean button fields from in-process callers would be recorded as booleans (real clients and bots always send booleans).

**Verified by replay (all checkpoints match):** test scenario A (two scripted people on a test map: a plant that explodes, shots into the sky, a reload, knife swings, a rifle kill, a ghost knife kill, halftime, 5 rounds, the match won 3:2; 86 checkpoints), scenario B (Test Map 1 through `Rooms`, fill bots three a side, a person joining after round 1 and leaving mid-round 3, ended by everyone leaving), a hold that ran out (`datastore.test.ts`, written to and read from disk), a full 12.2-minute ten-bot Warehouse match from `tools/botmatch.ts --record` (733 checkpoints, 439,339 commands, 11 rounds, replayed in 3.4 s), and a real local server on port 8090 with two `tools/bot.ts` players over WebSocket (`--plant --knife` and `--shoot`; 45 checkpoints; those commands came over the real wire). A changed recording (Dan's first shots of round 2 dropped) is caught at the first checkpoint after it.

**Passive and cheap.** Every hook is `this.observer?.x?.(...)`; with no observer nothing else runs. The recorder appends to one reused 256 KB buffer (a command is a `fitsWire` check and `writeCmd` into it; no allocation per command; the per-player "last command" copy is assigned field by field; the guard and fan-out wrappers take fixed parameters, not `...args`) and hands a copy to the gzip stream at the end of a tick once it is three quarters full; gzip runs in libuv's thread pool and the file is written by a stream. Event JSON (spawns, kills, round events) is the only allocation, a few per round. A test runs scenario A with and without the observer and checks that every message every player received is identical.

**Bench** (`npx tsx tools/bench.ts warehouse --bots`, ten bots, two simulated minutes, this PC, three runs each):

| | average ms/tick | median | 99th percentile | worst (after the first second) |
|---|---|---|---|---|
| Before (`main`) | 0.182 / 0.169 / 0.159 | 0.098 / 0.091 / 0.087 | 1.25 / 1.10 / 1.08 | 6.93 / 7.13 / 5.91 |
| After, no observer | 0.157 / 0.159 / 0.156 | 0.085 / 0.086 / 0.086 | 1.03 / 1.05 / 1.06 | 7.73 / 5.85 / 5.87 |
| After, records and recording on (`--record`) | 0.163 / 0.162 / 0.163 | 0.089 / 0.090 / 0.090 | 1.07 / 1.07 / 1.08 | 6.18 / 6.94 / 5.60 |

So recording costs about 0.005 ms per tick for a full room (about 3%), within the spread between runs; the worst ticks are the bots' path searches, as before.

**Size** (measured on the Warehouse bot match): bots 193 KB raw, **57 KB gzipped per player-minute** (their full-precision `CMDX` commands); the same commands converted to the wire format real players use: 102 KB raw, **26 KB gzipped per player-minute** for the commands alone, so about 108 KB raw and 28 KB gzipped with ticks, events and checkpoints in a ten-player room (an estimate from that conversion: no recording of ten real people exists yet). A twelve-minute match of ten bots is 7.1 MB; of ten people about 3.4 MB. At the 2000 MB cap that is roughly 1,200 player-hours of people.

**Retention** (`DataStore.prune`, at startup and after each recording closes): recordings older than `SB_RECORD_KEEP_DAYS` (90) are deleted, then the oldest until the folder is under `SB_RECORD_MAX_MB` (2000); match files older than `SB_MATCH_KEEP_MONTHS` (12, whole months by file name) are deleted. `feedback.log` is never trimmed (the owner reads it; the privacy page says it is kept until he deletes it; my decision). `SB_RECORD=0` turns recordings off and keeps match records. Bot-only rooms cannot exist on the server (a room closes when its last person leaves); `tools/botmatch.ts` records only with `--record <folder>`, `tools/bench.ts` only with `--record`.

**Failures.** The folder is created at startup (synchronously, before the loop) and a failure is logged as `[data] data folder ... cannot be created or written`; every later write is asynchronous, and a failure warns at most once a minute per kind and never throws; an exception inside an observer switches that room's observer off with one warning. The live run found and fixed one real bug: the recording file's handle was garbage-collected and closed under the stream (`EBADF`) after a few seconds; the stream now owns the handle (the in-process tests were too short to show it).

### Reading it (owner's PC)

`npm run data -- feedback | matches | recordings | pull` over SSH to `ubuntu@52.66.56.184` (`--host` or `SB_VPS_HOST`; `--dir` or `SB_VPS_DATA`, default `stillblade/deploy/data`; `--out`, default `vps-data/`, git-ignored; `--local <folder>` reads a folder on the PC). It uses `ssh` and `scp` with `BatchMode=yes`, so it never asks for or stores a password. `npx tsx tools/matchstats.ts <jsonl...>` prints win rate per side and per map, how rounds are won, average round length, plants and defuses, and kills by weapon and zone (`--json` for numbers). Run on the bot match it showed what package E found: defenders won 11 of 11 (8 by elimination, 3 by defuse); 96% of kills by rifle, 37% headshots.

### Privacy page

Main menu: a small "Privacy: what the game keeps, and for how long" link under How to play (a link, not a ninth big button, so the home card does not grow; my decision). The text is in `shared/privacy.ts`: kept (name, movement and button presses during matches, hits, kills, plants, defuses, results, feedback notes, error reports with browser, graphics card, frame rate, ping, room and map), not kept (IP addresses only while connected, for connection limits and the 10-minute vote-kick ban, never written into records, recordings or reports; no chat; nothing from the practice range or warmup; no accounts, emails or tracking cookies), why (bugs, balance, bots), how long (recordings 90 days, sooner past 2 GB; match records 12 months; feedback until the developer deletes it). A test checks that the page states the same numbers the server uses. **Not seen in a browser.** Note: before this package `feedback.log` was written to `/app` in the container, which belongs to root while the server runs as `node`, so on the VPS it was probably never written at all (only the `[report]` lines in `docker compose logs game`); see the deploy steps.

### Deploying it (for the main session, after review, merge and push)

On the VPS (`ssh ubuntu@52.66.56.184`):

```bash
cd ~/stillblade && git pull
cd deploy && mkdir -p data && sudo chown 1000:1000 data
docker compose logs --no-log-prefix game 2>/dev/null | grep '^\[report\] ' | sed 's/^\[report\] //' >> data/feedback.log
docker compose cp game:/app/feedback.log ./old-feedback.log 2>/dev/null && cat old-feedback.log >> data/feedback.log; rm -f old-feedback.log
sudo chown -R 1000:1000 data
SB_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose logs game | tail -5
ls -l data data/matches data/recordings
```

The third and fourth lines rescue reports the old container printed or wrote (the rebuild replaces the old container and its log; the `cp` most likely finds no file, see above). The startup line must read `data /data (recordings on, commit <hash>)`, with no `[data]` warning. No protocol change: the client needs no matching restart, and the push redeploys the site with the privacy page. Then from the PC: `npm run data -- feedback` and, after a match, `npm run data -- matches`.

### Tests

New: `server/src/matchdata.test.ts` (10: scenarios A and B, the lines, privacy, identical messages, replays, a changed recording caught, the format), `server/src/datastore.test.ts` (6: config defaults, real files on disk with a hold that ran out and a replay from disk, numbering, an unwritable folder, retention, `SB_RECORD=0`), `tools/matchsummary.test.ts` (3), `client/src/privacy.test.ts` (3). `vite.config.ts` now also runs `tools/**/*.test.ts`.

### Not verified

Docker: the image build, the `/data` mount and its ownership on the VPS, `SB_COMMIT` through Compose (Docker cannot run on the owner's PC); `tools/data.ts` against the real VPS over SSH (only `--local` was run; the remote commands are `tail`, `cat`, `ls`, `find -printf` and `scp`, which Ubuntu has); a recording of real people playing in a browser; the privacy page on screen; behaviour when the disk is actually full; the size estimate for people (from bot commands converted to the wire format).
