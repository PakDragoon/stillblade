# Stillblade — roadmap

Written 2026-11-15 at commit `51aa489`. This is the plan for everything that is decided but not built. `HANDOFF.md` describes what exists; this file says what to build next, in what order, and what was already decided so nobody has to ask the owner again.

The owner has no game development experience and expects the game to have every basic feature a player would expect from an FPS. When a package below is missing something any FPS has, add it and tell the owner what you added.

## How to work through this

- **The main session plans, briefs and reviews. Builds happen in separate sessions**, each in its own git worktree on its own branch. A build session never pushes or merges to `main`.
- **Model per package:** Opus 5.5 for anything that touches shared simulation, the binary wire format, server combat rules, netcode, or heavy art pipelines. Sonnet 5.5 for menus, HUD panels, JSON-only server messages, tooling and documentation. Each package below names its model.
- **A brief must stand alone.** The build session has not seen any conversation. Give it: what exists (name the files), what is decided, where each change goes, what must not change, and what "done" means. Tell it which other package is running in parallel and which files that one owns.
- **Review before merge, every time.** Read the diff of `shared/`, `server/src/game.ts`, `shared/protocol.ts` and the prediction loop in `client/src/main.ts` line by line. Run `npm test` and `npm run typecheck` yourself in the worktree. Check `git merge-tree --write-tree --name-only main <branch>` for conflicts. Look at the screenshots the build saved under `docs/review/`. Do not accept a build's own claims as verification; say in the report to the owner what you checked and what you did not.
- **Merge only when the owner says so**, with `git merge --no-ff`, then run the tests on `main`, then push if the owner said to push.
- **Two packages in one wave may run at the same time.** Merge the Opus (simulation) branch first; the other branch then merges `main` into itself, resolves conflicts with the simulation side winning for anything predicted or binary, and is reviewed again.
- **Protocol version:** each package that changes any message bumps `PROTOCOL_VERSION` by one. When two run in parallel, assign the numbers in the briefs (the one merging first gets the lower number).
- **Do not ask a build to play full-length matches repeatedly.** One real match to the result card is 24 minutes. Ask for one where it matters, and short scripted checks otherwise.
- **Things only the owner can do:** accounts, payments, DNS, Cloudflare and VPS setup, BIOS settings, listening to audio, playing with a mouse, testing on a laptop without a dedicated GPU. Never ask for or accept an API token or password.

## Decisions already made (do not reopen without the owner)

| Topic | Decision |
|---|---|
| Audience | As many players as possible, in a browser. Must run on laptops with integrated graphics (Intel i5 8th to 10th gen); a "High" tier for machines with a GPU. |
| Loadout | Defenders spawn with rifle, pistol and (to build) a knife. No buy menu, no money, no pickups. Ghosts carry only the knife. |
| Defender knife | Slot 3, weaker than the ghost's: 35 from the front, 70 from behind (ghost: 55 and 100). |
| Body-part damage | Multipliers on the gun's body damage: head 2x, torso 1x, arms and legs 0.5x (owner, 2026-11-16: "2x on head, 1x on body and 0.5x on arms/legs"); no one-shot headshots. Knife hits ignore zones. Untuned. |
| Suppressors | Removed by default. The room creator can switch "suppressed weapons" on when creating the room. |
| Recoil | Fixed learnable pattern per weapon plus deterministic spread. |
| Not wanted now | Slower movement while aiming, and bullets passing through thin cover. The owner will think about them. |
| Accounts | Guest play always works. Optional account with username and password, stats in SQLite on the game server, leaderboard. |
| Client hosting | Its own Cloudflare Pages project at `https://stillblade.orcavalley.com`; the owner's games home page at `play.orcavalley.com` links to it. |
| Server hosting | First test: the owner's PC behind a Cloudflare Tunnel at `stillblade-server.orcavalley.com`. Later: a small VPS (AWS Lightsail $7 or DigitalOcean $6 plan), region chosen by ping from Pakistan (UAE/Bahrain, Singapore, or Mumbai). Steps are in `DEPLOY.md`. |
| Idle players | Never removed mid-round: standing still is how ghosts play. |

## Order of work

| Wave | Package | Model | Depends on |
|---|---|---|---|
| 1 | A. Combat core: defender knife, body-part damage, suppressor option (**built and reviewed; merged into branch `wave-1`, protocol 9; on `main` since 2026-11-17**) | Opus 5.5 | nothing |
| 1 | B. Client utilities: key bindings, phone notice, feedback button, error reports (**built and reviewed; merged into branch `wave-1`, protocol 10; on `main` since 2026-11-17**) | Sonnet 5.5 | nothing |
| 2 | C. Bomb carrier (**built and reviewed; merged into branch `wave-2`, protocol 11; on `main` since 2026-11-17; checked in a browser by its build session**) | Opus 5.5 | A merged |
| 2 | D. Rooms and community: room list, room options, vote kick, name filter, map vote (**built and reviewed; merged into branch `wave-2`, protocol 12; on `main` since 2026-11-17; checked in a browser by its build session**) | Sonnet 5.5 | A merged |
| 3 | E. Bots that fight, and a practice range (**built and reviewed; merged into branch `wave-3`, protocol 13; on `main` since 2026-11-17; never seen in a browser**) | Opus 5.5 | C merged |
| 3 | F. Hands and animations: first-person hands, real reloads, pistol pose, knife (**built and reviewed; merged into branch `wave-3`, no protocol change; on `main` since 2026-11-17; seen only in Blender renders, never in the game**) | Opus 5.5 | A merged |
| 4 | L. Menus and settings redesign, scoreboard ping column (owner's feedback on waves 1 to 3) (**built and reviewed; protocol 14; on `main` since 2026-11-17**) | Sonnet 5.5 | nothing |
| 4 | G. Graphics tiers and effects (**built and reviewed; no protocol change; on `main` since 2026-11-17; frame rate unmeasured**) | Opus 5.5 | F merged |
| 4 | H. Recorded sounds (**built and reviewed; no protocol change; on `main` since 2026-11-17; nobody has listened to it; gunshots still synthesised under a recorded layer**) | Sonnet 5.5 | A merged |
| 5 | M. Realistic rifle, pistol and knife; sights (iron, 1x red dot, 2x scope); the stuck-aim fix (**part 1, sights and the stuck-aim fix, reviewed and merged into `main` on 2026-11-17, protocol 15; part 2, the realistic models with the hip-pose fix, reviewed and merged into `main` 2026-11-18, no protocol change; neither pushed until the owner can restart his server; the downloaded 2x scope model (AR Scope by Scape) still to come, a generated ACOG-style scope stands in; the first-person arms stay cartoon until package O**) | Opus 5.5 | owner's downloads |
| 5 | N. Real recorded gunshots, breathing and hurt sounds (**merged into `main` 2026-11-18, not pushed, no protocol change; pistol shots are real since 2026-11-18 (Freesound CC0 569174 Makarov by coolabc and 828786 Glock 19X by areniporgen; `SAMPLE_GAIN` set by measurement to about the rifle's peak at 5 m, 4.7 dB lower RMS); hurt still synthesised; nobody has listened**) | Sonnet 5.5 | owner's downloads |
| 6 | O. Realistic soldiers (defenders) and stealth operatives (ghosts), first-person arms to match, Mixamo animations | Opus 5.5 | M merged, owner's downloads |
| later | J. Accounts, saved stats, leaderboard | Opus 5.5 | always-on server (the owner is still comparing VPS offers) |
| later | I. Grenades | Opus 5.5 | not a priority (owner, 2026-11-17) |
| later | K. Voice chat | Opus 5.5 | not a priority (owner, 2026-11-17) |

**Owner's feedback, 2026-11-17, which set waves 5 and 6:** the rifle, the characters and the synthesised sounds look and sound cartoonish; he wants a realistic AK (AK-103 or AK-47) with sight choices (1x red dot, 2x), real recorded sounds, and soldiers with helmet, vest, boots, gloves and uniform. Holding to aim sometimes stays stuck aiming. Voice and grenades are not a priority. New download sources approved (see `HANDOFF.md`, Working method): Sketchfab CC0 or CC-BY, Mixamo, Freesound CC0.

The owner's first friends test can happen at any point; after wave 2 is best, because the feedback button and error reports are in. Its results should adjust waves 4 and 5.

Housekeeping folded into package A: the unused `IDLE_MS` is deleted on its branch. Before package J: move the project to Node 22 (the Docker image already uses it; local Node is 20.11, which is why Vite and Vitest are pinned to old majors).

---

## A. Combat core (Opus 5.5)

**Status (2026-11-16): built, reviewed and merged into branch `wave-1` (protocol 9); on `main` since 2026-11-17. What was built, every decision taken, and what was not verified are in `HANDOFF.md` ("Package A (combat core) in detail"). Open point for the reviewer: the existing shot-event position leak and its suggested fix (`HANDOFF.md`, Known problems). Package B merges after it.** The specification below is kept as written.

Three changes to the same combat code, so one package. Shared simulation and binary format: read the rules in `HANDOFF.md` first, and keep `server/src/prediction.test.ts` passing.

**Defender knife.** Slot 3 in the loadout (key 3, included in Q and mouse-wheel cycling). Melee, no ammunition. Reuse the timing model of `shared/knife.ts` (windup, cooldown counted in processed commands) with its own numbers: same 0.2 s windup and 2 m reach, 35 from the front, 70 from behind, draw time about 0.3 s. It lives in the loadout state so the client predicts it and it travels in the snapshot. `WEAPONS` in `shared/weapons.ts` is currently guns only: either add a `kind: 'gun' | 'melee'` to the definition or keep melee beside it, but every consumer (`stepLoadout`, the wire format, the HUD, `characters.ts`, `tools/bot.ts`) must handle three slots. A defender's swing makes the same windup sound as a ghost's. Model: the existing knife from `weapons.glb`.

**Body-part damage.** Today a player is one axis-aligned box (0.6 m wide, 1.8 m tall, 1.2 m crouched) and the top 0.28 m (`HEAD_ZONE`) is the head. Keep the box for movement and for the ray test, and classify the hit point into zones on the server:
- Head: the top 0.28 m. Multiplier 2.0 (superseded on 2026-11-16 by the owner; this replaced "the weapon's `headDamage`, 100": see the decisions table).
- Legs: the bottom 45% of the current hull height. Multiplier 0.5 (was 0.7 before the owner's 2026-11-16 decision).
- Arms: in the remaining torso band, a hit whose horizontal distance from the hull's vertical centre line is more than 0.2 m. Multiplier 0.5 (was 0.8).
- Torso: everything else. Multiplier 1.0 (the weapon's `bodyDamage`).
Put the zone function and the multipliers in `shared/` (a table next to the weapons) so bots and tests share it. Damage is rounded to an integer. The shot event, the `dmg` message, `hitconfirm`, the death recap and the kill feed carry the zone; the hit marker gets a distinct look for limbs. Knife hits ignore zones. Add stats per zone only if cheap. Starting numbers are untuned: say so in the handoff.

**Suppressor option.** A per-room boolean chosen by the creator, default off (unsuppressed). This package introduces the room options object (`RoomOptions`, created in `server/src/rooms.ts` from the join query, stored on `Game`, sent in `welcome`, shown in the lobby panel) with this one option; package D adds more.
- Unsuppressed: a loud gunshot sound with a long audible range, a visible muzzle flash, no suppressor on the model. Shot events are already broadcast to everyone; add a server-side loudness and range so a gunshot is a sound event that respects earshot like footsteps (range about 60 m unsuppressed, about 20 m suppressed).
- Suppressed: today's behaviour and models.
- `tools/blender/weapons.py` must output both guns with the suppressor as a separate node that the client shows or hides. The pistol's suppressor is generated by the script; check what the rifle model includes.

**Done means:** tests for the knife slot (timing, damage front and back, switching, nothing changing when `seq` jumps), for every zone and multiplier standing and crouched, for the option reaching `welcome` and changing gunshot range; `prediction.test.ts` extended to three slots and still at zero disagreements; browser check at `?lag=150` on both maps with mismatches at 0; screenshots of the knife in first and third person and of both gun variants; `HANDOFF.md` updated.

## B. Client utilities (Sonnet 5.5)

**Status (2026-11-16): built, reviewed and merged into branch `wave-1` (protocol 10); on `main` since 2026-11-17. `HANDOFF.md` ("Client utilities") describes what exists and what was not verified.**

Client-side features plus two tiny server endpoints. Stays out of `shared/gun.ts`, `shared/knife.ts`, the binary format and the prediction loop.

- **Custom key bindings.** Every action in `client/src/input.ts` becomes rebindable from the settings panel (`client/src/ui.ts`, `client/src/settings.ts`, stored in `localStorage`): click an action, press a key or mouse button, conflicts are flagged, a reset-to-defaults button. The controls page and every on-screen hint ("Ready (G)") read the current binding.
- **Phone notice.** On a touch device without a mouse (pointer: coarse, no hover), show a full-screen message before loading anything: the game needs a mouse and keyboard, with a button to copy the link for later. Do not load the map.
- **Feedback button.** In the pause menu and on the result card: a text box (500 characters) and a send button. Sends the note with map, room, team, frame rate, render scale, ping, browser and GPU string (from the WebGL debug renderer info) to the server, which appends one JSON line per report to a log file (`SB_FEEDBACK_FILE`, default `feedback.log` beside the server) and to stdout. Rate-limited per connection; length-capped on the server.
- **Automatic error reports.** `window.onerror`, `unhandledrejection` and a lost WebGL context send one compact report (message, stack, the same context fields) through the same channel, at most 5 per session, never containing chat text or the player's name beyond what the server already knows.
- Reports travel as JSON text frames on the existing WebSocket (`ClientMsg`), or by HTTP POST to the game server if the socket is down; the HTTP route must apply the same origin check as the socket.

**Done means:** server tests for the report rules (caps, rate limit, origin); browser checks of rebinding (including a mouse button), the phone notice under mobile emulation, a feedback line arriving in the log, and a forced error arriving; screenshots under `docs/review/utilities/`.

## C. Bomb carrier (Opus 5.5)

**Status (2026-11-16): built, reviewed and merged into branch `wave-2` (protocol 11); on `main` since 2026-11-17. The carrier is chosen by rotation, not at random (no `Math.random` in the simulation). No screenshots exist: the build froze at that step. See `HANDOFF.md` ("Wave 2").** The specification below is kept as written.

Today any ghost can plant. Change to one bomb.

- At round start one random living ghost carries the bomb. Only the carrier can plant (`canAct` in `shared/rules.ts`).
- The carrier drops it on death, or on purpose with a key (default G outside warmup; the ready hotkey moves if it conflicts). A dropped bomb lies at a position on the ground; any ghost who walks over it picks it up (not the player who just dropped it for 1 s). Defenders cannot pick it up or move it.
- Who knows what: every ghost always knows who carries the bomb and where a dropped bomb is. A defender is told about a dropped bomb only while it is in their line of sight, using the same line test as `Game.knowsAbout`, and never who carries it. The radar and HUD follow that.
- If no ghost has the bomb and all ghosts are dead, the round ends as now.
- The carrier flag is part of the self snapshot only if the client needs it to predict the plant lock; otherwise send it in JSON (roster or a `bomb` message). Decide and document.
- Bots and `tools/bot.ts` must cope (a bot ghost with the bomb plants).

**Done means:** tests for assignment, drop on death, manual drop, pickup, the pickup delay, plant refused for non-carriers, and that a defender out of sight never receives the dropped position; browser check of a drop, pickup and plant; HUD and radar screenshots.

## D. Rooms and community (Sonnet 5.5)

**Status (2026-11-16): built, reviewed and merged into branch `wave-2` (protocol 12); on `main` since 2026-11-17. `fillBots` is stored and shown only, for package E. No screenshots exist: the build froze at that step. See `HANDOFF.md` ("Wave 2").** The specification below is kept as written.

JSON messages and UI only. Builds on the `RoomOptions` from package A (`shared/room-options.ts`: add a field, a line in `parseRoomOptions`, and a row in the lobby panel; the create-room form in `client/src/ui.ts` sends them as query parameters).

- **Public room list.** Rooms are public or private (creator's choice; private is the default for "Create room", public for "Quick play"). An HTTP endpoint on the game server (`GET /rooms`, origin-checked, cached for a second) lists public rooms: code, map, player count and capacity, phase, options. The menu shows the list with a refresh and a join button, and Quick play joins the fullest public room that has space, or creates one.
- **Room options** set at creation and shown in the lobby: public or private, map, suppressed weapons (from A), maximum players (2 to 10), rounds to win (3, 6, 9), fill with bots (from E; show it disabled until E exists). Only the creator can change them, only in warmup.
- **Vote to kick.** Any player can start a vote against another; it passes with more than half of the connected players, needs at least three players in the room, lasts 30 s, one vote at a time, a cooldown per caller. A kicked player cannot rejoin that room for 10 minutes (by IP as the server sees it and by name). In a two-player room the creator can simply remove the other player in warmup.
- **Name filter.** Names and chat pass through a filter on the server: a small built-in list of slurs and obvious evasions (keep the list in one file, easy to extend), impersonation of system names ("Server", "Admin"), and duplicate names in a room get a number suffix. Filtered chat words are replaced with asterisks, not dropped.
- **Map vote.** On the result card every player picks a map from the installed ones (or "same map"); the most-voted map loads for the next match, ties go to the current map. This requires a room to change map between matches: the server swaps the `Game`'s map and sends a new `welcome`-like message; the client unloads the old map and loads the new one without a page reload. Stats and teams carry on as in the rematch flow.

**Done means:** tests for list contents (private rooms never listed), option validation, vote thresholds and cooldowns, the rejoin ban, name filtering, vote counting and the map swap; browser checks of the list, a kick, and a map change between matches with bots; screenshots.

## E. Bots that fight, and a practice range (Opus 5.5)

**Status (2026-11-16): built, reviewed and merged into branch `wave-3` (protocol 13); on `main` since 2026-11-17; nothing seen in a browser. `HANDOFF.md` ("Package E (bots and practice range)") has what exists, the decisions taken, the bench and match numbers and what was not verified. Decisions taken beyond this text: fill keeps each team at half of `maxPlayers`; bot difficulty is a room option (`botLevel`, default normal); bots are named "BOT <name>" and flagged in the roster; practice targets are fully visible ghosts or defenders that never fire, placed in view of the person's spawn; damage per hit travels in `hitconfirm.damage` for everyone. Open point for the owner: ghost bots almost never win a round against defender bots on normal or hard (tuning, after he has played). The reviewer should read `server/src/bots.ts` against the information rule (the brain's inputs are listed at the top of the file).** The specification below is kept as written.

A player who opens the game alone should have something to do.

- **Bots run inside the server** as players without a socket. Each bot produces one `NetCmd` per tick and goes through `Game.handleCmd` like a human, so every rule applies to it. A bot may only use what a human on its team would be sent: its own snapshot through `knowsAbout`, and the sound events in its earshot. Never read hidden enemy positions.
- **Navigation.** The map verifier (`tools/blender/mapkit.py`) already flood-fills the walkable space. Export a navigation graph from it into the map JSON (nodes on walkable cells, edges for walk, step, jump and drop, with floor level) and add path-finding in `shared/` or `server/`. Both maps must rebuild.
- **Behaviour.** Ghost bots: move quietly toward a site by varied routes, stop when a defender is near (staying invisible), stab from behind when possible, plant when carrying the bomb. Defender bots: hold or patrol sites, turn toward sounds, investigate, shoot with a reaction delay and aim error that depend on difficulty, reload, switch to the pistol when the rifle is empty, defuse.
- **Difficulty:** easy, normal, hard (reaction time, aim error, how well they use sound).
- **Fill option:** a room option (wired in D) keeps teams at a chosen size with bots; a bot leaves when a human joins. Bots are marked in the roster and never count for vote kicks or the creator role.
- **Practice range:** a menu entry that opens a private solo room with rounds off (`Game` already supports `rounds: false`), unlimited reserve ammunition, static and moving bot targets that show the damage and zone of each hit, and a choice of side.
- Cost: measure with `tools/bench.ts`; ten bots must stay well under a millisecond per tick on Warehouse.

**Done means:** tests that a bot never acts on information `knowsAbout` withholds, reaches both sites on both maps, plants and defuses, and that fill adds and removes bots correctly; a full bot-versus-bot match completing on each map (run once each); the bench numbers; the old `tools/bot.ts` kept for scripted tests.

## F. Hands and animations (Opus 5.5)

**Status (2026-11-16): built, reviewed and merged into branch `wave-3`; on `main` since 2026-11-17; client and art only, `shared/` untouched, no protocol change. `HANDOFF.md` ("Package F (hands and animations) in detail") lists what was built, the decisions taken (one skinned mesh per weapon rig, clips sampled by reload progress, suppressor hidden by a bone, the swing driven by the windup and slash events, the body turned toward open floor), draw calls, and what was not verified. For the reviewer: nothing was seen in the game; check the hands at real screen sizes first.** The specification below is kept as written.

Art pipeline plus presentation. CC0 sources already approved: Poly Haven, ambientCG, Quaternius, Kenney, KayKit; record every file in a `CREDITS.md`.

- **First-person hands** holding each weapon, built in `tools/blender/` and shown by `client/src/presenter.ts`. Within the budget: the viewmodel may cost one more draw call.
- **Real reload animations** per gun: magazine out, magazine in, bolt or slide, timed to the rule's reload length (2.2 s rifle, 1.4 s pistol), with the existing sound sequence aligned to the motion and cut off if the reload is cancelled.
- **Third person:** a one-handed pistol pose (today the pistol sits in the rifle's two-handed pose), a reload motion, the defender knife hold and swing, and a ghost knife swing driven by the real slash event instead of being inferred from visibility spikes.
- Fix what the handoff lists under known problems while there: death animation leaving bodies in walls, the upright armed crouch.

**Done means:** short screen recordings or frame sequences of each animation in first and third person under `docs/review/animations/`, draw-call counts, and nothing in `shared/` changed.

## L. Menus and settings redesign (Sonnet 5.5)

**Status (2026-11-17): built, reviewed and on `main`. During the build the owner also asked for a per-player ping column on the scoreboard, which made this package protocol 14 (a server-measured `pings` JSON message; `server/src/ping-probe.ts`). `HANDOFF.md` ("Package L (menus and settings) in detail") has what exists and what was not verified.** The specification below is kept as written. From the owner's feedback after waves 1 to 3: "settings page is too long, we can group stuff like in tabs, so general tab, control tab etc", and the first menu page is one long column with a poor room section; he asked for a proper room page with a private or public choice and the room's settings shown while creating. Client UI only (`client/src/ui.ts`, `ui.css`, `community-ui.ts`, `settings.ts`): no new message, no `PROTOCOL_VERSION` change, nothing in `shared/` or the server. The room options and the `GET /rooms` list already exist (package D, E); this package only rearranges how they are shown.

- **Settings in tabs.** General (name, show FPS and ping, feedback), Controls (key bindings, sensitivity, aim sensitivity, hold or toggle), Video (graphics quality, crosshair), Audio (volumes, hit sound). Each tab fits without a long scroll at 1366x768; the bindings list may scroll inside its tab. Both reset buttons stay, each in its own tab. Settings also open from the main menu (today they exist only in game).
- **Home page.** A short screen instead of one column: the player's name, then Quick play, Rooms, Practice range, Settings, How to play. Each opens its own page with a Back button; Esc goes back.
- **Rooms page.** The public room list with refresh and join, a "Join by code" box, and a "Create room" button.
- **Create room page.** Private or Public as a clear two-way choice at the top (private is the default), then every room option in one form: map, maximum players, rounds to win, suppressed weapons, fill with bots, bot skill. "Create" lands in the lobby. The lobby panel shows the same options in the same order and the creator edits them there in warmup, as now.
- **Practice page.** Map and side, then start.
- **Small fixes folded in (open since wave 2):** the HUD title reads "FIRST TO 6" whatever `roundsToWin` is (one constant in `client/src/presenter.ts`); a vote-kick button per player on the Tab scoreboard.
- Must keep working: `?auto=1`, `?quiet=1`, `?room=`, invite links, the how-to shown once, the phone notice, every hint reading the live key bindings, menus suspending weapon keys.

**Done means:** screenshots of every page and every settings tab at 1366x768 and 1920x1080 under `docs/review/menus/`; create a private and a public room from the new form and see the public one in the list; `npm test` and `npm run typecheck` clean; nothing in `shared/` or `server/` changed.

## G. Graphics tiers and effects (Opus 5.5)

**Status (2026-11-17): built, reviewed and on `main`; client and map art only, no protocol change. `HANDOFF.md` ("Package G (graphics tiers and effects) in detail") has the tiers, the numbers, the decisions taken and what was not verified (frame rate above all: the owner checks Low on a laptop with `?tier=low`).** The specification below is kept as written.

The game looks flat because of a deliberately strict budget (unlit world, no post-processing, 8 draw calls). Raise both tiers.

- **Low** (integrated graphics, the default when unsure): sharper baked lighting, distance fog and colour grading inside the existing map shader (no extra pass), light props and decals, particles with tight caps. No full-screen post-processing. Target 60 FPS at 720p on Intel UHD 620.
- **High** (dedicated GPU): everything in Low plus bloom, ambient occlusion, tone mapping, a few dynamic lights (muzzle flashes, bomb), soft shadows under players, denser props.
- **Choosing:** measure frame time for a few seconds on the loading screen and pick; the settings menu overrides (it currently only caps render resolution).
- **Effects:** muzzle flash, tracer, bullet impact dust and decals per surface, knife hit, footstep dust, bomb light and explosion, ghost shimmer tuned against the real maps.
- **Maps:** more visual-only detail in both map definitions (the builder supports boxes without collision), better site markings and stair readability; rebuild both with the GPU bake.
- Rewrite the performance-budget rule in `HANDOFF.md` as two budgets.
- The owner must check the Low tier on a laptop without a GPU; give them a `?tier=low` URL and a visible FPS counter.

**Done means:** before and after screenshots of the same views on both maps in both tiers, draw calls and frame times for each, and the download size of each map.

## H. Recorded sounds (Sonnet 5.5)

**Status (2026-11-17): built, reviewed and on `main`; client audio only, no protocol change. 53 Kenney CC0 samples (138 KB) with a synthesised fallback, and the test page at `?soundtest=1`. `HANDOFF.md` ("Package H (recorded sounds) in detail") has the table of every event, the measured levels and the owner's listening checklist. Open: nobody has listened to anything; the five Kenney packs hold no gunshot, so gunshots are the synthesised shot under a recorded thump (a real recording needs the owner to approve another CC0 source); metal footsteps are a stand-in; breathing, hurt and the round chimes stay synthesised. Kenney's site refuses scripted downloads: the owner downloads packs by hand into the git-ignored `tools/audio-source/`.** The specification below is kept as written.

Everything is synthesised in `client/src/audio.ts` and nobody has listened to it. Sound is how defenders find ghosts, so this is gameplay.

- Replace or layer the synthesised sounds with recorded CC0 samples: footsteps per surface (concrete, metal, wood), gunshots suppressed and unsuppressed for both guns, reloads, knife, bomb, impacts, UI. Kenney's audio packs are pre-approved; anything else needs the owner's approval before download. Record every file in `client/public/audio/CREDITS.md`.
- Keep the interface in `client/src/audio-api.ts`; keep distance, direction and wall muffling; keep the total download small (compressed, mono for positional sounds).
- A sound test page (`?soundtest=1`) that plays each sound at chosen distances and angles, so the owner can judge it with headphones.

**Done means:** every event has a sample or a stated reason to stay synthesised, sizes listed, and the owner has a checklist of what to listen for.

## M. Realistic weapons and sights (Opus 5.5)

**Status (2026-11-18): part 2 built on branch `claude/realistic-weapons-804056`, not reviewed or merged: the AK-105, Makarov, tactical knife and red dot from Fab in first and third person, one texture atlas per gun (1024 Low, 2048 High), a generated ACOG-like 2x scope seen through its eyepiece instead of the blackout, generated suppressors (`HANDOFF.md` "Package M part 2"). Left: the owner downloads "AR Scope (Game-Ready)" by Scape into `tools/blender/source-art/realistic/scope2x/` and a session rebuilds the weapons and checks it.** Earlier: **Status (2026-11-17): part 1 built on branch `claude/sights-aimfix-f78887` (protocol 15, 447 tests), not merged: the sight table and rule, the server's pending/active choice, the Loadout page, the red dot and 2x scope overlays, generated stand-in sight meshes, and the stuck-aim fix. `HANDOFF.md` ("Package M part 1") has what was built, the decisions taken and what was not verified. Part 2 (the AK-103, pistol and knife models, real sight models, credits) waits for the owner's downloads; it re-points `gun_sight_<id>` nodes and `SIGHT_EYE` (presenter.ts) at the new rifle.** The specification below is kept as written.

- **Rifle:** a realistic AK-103 replacing the current rifle (same slot, same numbers). Chosen by the owner (2026-11-17): Sketchfab "AK-103 - Game Ready Assault Rifle Weapon" by bogdanzloy20280 (CC-BY, 12.5k triangles, 4K textures). Textures reduced to fit the budget (Low tier: one material, at most 1024-2048 px); still one draw call per gun in hand, first and third person. Pistol and knife replaced in the same realistic style so nothing looks out of place: recommended to the owner (2026-11-17) Sketchfab "G19 Pistol, Game Ready, Free version" by Rotuma (CC-BY, about 20k triangles) and "Fighting Ka-Bar knifes" by vitvitskyi (CC-BY, about 16k; the knife model is shared by ghosts and defenders). **Sketchfab is blocked from Pakistan, so the models now come from Fab (all free, CC-BY), chosen by the owner 2026-11-17:** rifle "AK-105" by SpatialNeglect (fab.com/listings/9b9836c5-b73c-4216-a389-a61549eb3a74; the short AK-103 sibling with tactical upgrades, as the AK-103 itself is not on Fab), red dot "Red Dot Sight" by Gerardo Justel (3a8c2a97-481e-403b-a61b-aef09a96debe), 2x "AR Scope (Game-Ready)" by Scape (346c6bbd-a204-4317-9e10-b25c653821a8), pistol "Makarov Pistol (PM)" by TaigaForest (6af98baa-bc87-4a38-ae33-db73ca1c855c, about 10.7k polygons), knife "Tactical Knife" by Gerardo Justel (33452f11-fc65-479e-8d6e-75bf8be1c0ff). The Sketchfab picks above are superseded. The owner downloads every file into the git-ignored `tools/blender/source-art/realistic/<item>/` and sounds into `tools/audio-source/freesound/`.
- **Sights:** iron (default), 1x red dot, 2x scope. Chosen in a loadout page (menu and in game), applied at the next spawn, shown on the gun to everyone. Rules: the sight changes the aimed zoom and the aim-in time (2x zooms more and aims in slower); spread and recoil stay per weapon. The aim time is stepped in `shared/gun.ts`, so the sight choice must reach both sides exactly (server keeps it per player, the client predicts with it, `prediction.test.ts` covers every sight). Red dot drawn as a reticle on the sight glass; 2x as a zoomed full view with a scope ring (no second render pass). Red dot candidate: the Vzor-1 inside Sketchfab "low-poly AK-74M Zenitco" by D_U (CC-BY); a 2x scope may be generated in Blender if no free model fits.
- **Stuck aiming:** `client/src/input.ts` stops aiming only on a `mouseup`; if the browser loses that event the aim stays on. Reconcile held mouse buttons with `MouseEvent.buttons` on every mouse event (and on regaining pointer lock), so a button that is no longer down is released. Cause not reproduced (no real mouse in automation).
- Credits for every file in `client/public/models/CREDITS.md`.

## N. Real recorded sounds (Sonnet 5.5)

- Replace the synthesised gunshot body with recordings: rifle close, rifle distant tail, pistol close and distant, suppressed versions (recordings filtered, or real suppressed shots if found). Replace the synthesised breathing loop with recorded breaths, calm and exerted, keeping `breathDistanceGain`, occlusion and the 8 m range exactly. Replace the hurt sound. Upgrade footsteps where a better CC0 recording exists.
- Approved by the owner (2026-11-17), Freesound, CC0: AK-47 felix.blume 136399 (close, outdoor range), ninebilly 520934 single and 520935 burst, serøutōnin--deprivəd 855842 and 855843 (with distant tail); breathing: the owner disliked the heavy-breathing picks (ThabzMalik 767046, Amekiano 516696, movethemoon 205526; 2026-11-17). Ghost breathing must be quiet, controlled breathing, not panting. **Final sound list, owner 2026-11-17:** gunshots 136399, 520934, 520935, 855843; breathing ThabzMalik 767046 (kept by the owner; use it for a ghost that has been running) and Unstoppable0 361869 (slow, steady; replaces 516696, use it for a calm ghost). Pistol shots still to find. Pistol shots still to find. The owner downloads (login); the session gives him an exact list, then `tools/process-audio.mjs` processes them.

## O. Realistic soldiers (Opus 5.5)

- Defenders: helmet, plate carrier, uniform, gloves, boots. Ghosts: a dark close-fitting stealth suit and mask, a clearly different silhouette. First-person sleeves and gloves rebuilt to match.
- Chosen by the owner (2026-11-17): Sketchfab "FREE [Military Soldier] RIGGED" by BAMEN (CC-BY, 11.1k triangles, rigged, FBX), but Sketchfab is blocked from Pakistan and BAMEN's model was not found on Fab. **Chosen instead by the owner (2026-11-17): Fab "Quantum Modular Character Free Sample" by Quantum Assets (fab.com/listings/8e200050-3158-4762-b297-f785b5b1533d)**: free under the Fab Standard License (Personal and Professional tiers at $0, not CC), a soldier from a modular UE5/MetaHuman-compatible kit on the UE5 skeleton, FBX included. Triangle count not stated and probably high for this game: expect to reduce it heavily (and the bone count, for the Low tier), and retarget Mixamo animations onto it or rig it through Mixamo. Credit the seller in `CREDITS.md` and do not ship its source files outside the game build. **Measured 2026-11-18 (Blender import of the free sample): `SKM_Character.fbx` is 162,882 triangles, 15 meshes, 16 materials, 275 bones; textures 1.2 GB of 4K PNGs.** Unusable as-is (16 draw calls per player against a budget of 2, about 1.6 M triangles for ten players, a 1 GB download). The owner keeps its look (cap, rolled-up shirt, plate vest, pouches, jeans; no helmet). The build keeps that look and slims it: one mesh and one material per character, about 10-15k triangles (fewer for Low), about 60-70 bones, one 1024² (Low) / 2048² (High) texture atlas baked from the 4K set; then the owner checks frame rate on his laptop. He rejected "SF Operator" by britdawgmasterfunk. Models ripped from commercial games are excluded even when labelled CC. **The soldier is a stopgap:** the owner plans to replace it with a futuristic look when the maps are revamped, so keep the character pipeline model-agnostic (any rigged humanoid FBX in, same clips out) and do not over-invest in this model's specifics. Rigging and animations from Mixamo (the owner uploads the model for auto-rigging and downloads the animation list the session gives him).
- Budget: at most 2 draw calls per armed player stays; a lighter version for the Low tier (target about 10-15k triangles per player); frame rate checked on the owner's laptop.

## I. Grenades (Opus 5.5)

Design is a proposal; confirm with the owner after the friends test, because grenades interact with invisibility and sound.

- Proposal: each ghost carries one smoke (blocks defenders' line of sight for about 12 s, for covering a plant); each defender carries one flash (blinds and deafens players looking at it within range, and makes ghosts in its radius fully visible for about 2 s).
- Thrown with a key (default 4 to select, left mouse to throw, right mouse for a short lob). The grenade is a server-simulated object bouncing off the map's boxes with fixed-step physics; it is sent to clients in snapshots or JSON updates and is not client-predicted beyond the throw animation.
- Smoke must affect `knowsAbout` (a ghost inside or behind smoke is not sent on sight) and bots' vision. Flash effects are applied by the server telling each affected client its intensity.

## J. Accounts, saved stats, leaderboard (Opus 5.5)

Needs a server that is always on with a persistent disk.

- Guest play is unchanged. An account adds a reserved name, lifetime stats and a profile.
- Storage: SQLite on the game server (Node 22's built-in `node:sqlite`, or `better-sqlite3`), file path from `SB_DB_FILE`, schema migrations in code, a backup note in `DEPLOY.md`.
- Auth: username and password only, hashed with scrypt from `node:crypto` with a per-user salt; session tokens stored hashed, sent by the client as the first WebSocket message or a header on HTTP calls, never in a URL. Rate limits on sign-up and sign-in per IP; generic error messages; minimum password length; no email, so no password reset beyond a recovery code shown once at sign-up.
- HTTP JSON endpoints on the game server with the same origin check: sign up, sign in, sign out, profile, leaderboard.
- Stats written at match end from the existing `MatchStats`: matches, wins, kills, deaths, assists, headshots, backstabs, damage, plants, defuses, time played. Leaderboard pages by wins and by kill/death ratio with a minimum match count.
- A short privacy page stating what is stored. Account deletion from the profile.
- Tests against a temporary database for every rule above.

## K. Voice chat (Opus 5.5)

- Team-only voice, push-to-talk (default V), with a mute list and volume per player.
- WebRTC audio between teammates, with the existing WebSocket used only for signalling. Start with direct peer connections and public STUN; say plainly that some networks will fail without a TURN relay, which costs money and is the owner's call.
- Dead players can talk only to dead teammates during a round, matching the text chat rule.
- Microphone permission is requested only when the player first presses the talk key.

## Hosting steps still open (owner)

1. Friends test: the tunnel and the Cloudflare project are set up and were checked working on 2026-11-15 (`HANDOFF.md`, Hosting). Still to do: the owner plays it himself, checks the ping shown in settings, invites friends, and collects what feels wrong. Add a card for Stillblade on the `play.orcavalley.com` home page.
2. Always-on: rent the VPS, point `stillblade-server.orcavalley.com` at it as a DNS-only record, and run the Compose stack. The Docker and Caddy setup has never been run; expect to fix something on the first try.
3. Check the Low graphics tier on a laptop without a dedicated GPU once package G is in.
