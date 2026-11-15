# Stillblade

Browser tactical FPS (PlayCanvas engine as a library, TypeScript, Vite; authoritative Node WebSocket server). Invisible knife-carrying ghosts must plant a bomb; visible armed defenders find them by sound.

**Before any work, read `HANDOFF.md` (what exists, what is verified, the rules that must not be broken, how the owner works) and `ROADMAP.md` (what to build next, in order, with the decisions already made).** Together they are the full context; nothing from earlier conversations is needed.

## Commands

- `npm run dev` starts the game server and the web client. `npm test`. `npm run typecheck`.
- `npm run bot` adds a scripted test player (`-- --shoot`, `--pistol`, `--aim`, `--map <id>`, `--room <code>`).
- `npm run map -- <id>` rebuilds a map in headless Blender (`greybox` or `warehouse`).

## Rules

- Shared simulation lives in `shared/` and must be identical for client and server. Never reimplement a rule on one side only.
- Every timer counts commands the server actually processed for that player. Nothing may depend on the client-chosen `seq`, on wall-clock time, or on `Math.random`.
- Anything the client predicts travels exactly in the binary wire format (`shared/protocol.ts`). Bump `PROTOCOL_VERSION` on any message change. `server/src/prediction.test.ts` must keep passing.
- Never send a defender a ghost it cannot perceive (`Game.knowsAbout` in `server/src/game.ts`). New messages must not leak enemy positions.
- Collision is axis-aligned boxes only. Maps are generated from `tools/blender/maps/<id>.py` by the shared builder and verified by `tools/blender/mapkit.py`; never hand-edit map files.
- Presentation and audio sit behind `client/src/presenter-api.ts` and `client/src/audio-api.ts`: change the interface first.
- No per-frame allocations in `frame()` paths; respect the draw-call budget in `HANDOFF.md`.

## How the owner wants work done

- The main session plans, writes briefs and reviews. Builds run in separate sessions in their own worktrees: Opus 5.5 for shared simulation, wire format, server rules, netcode and heavy art; Sonnet 5.5 for menus, HUD, JSON-only server features, tooling and documents. The method and review checklist are in `ROADMAP.md`.
- Review every branch before it merges: read the simulation and protocol diffs line by line, run the tests yourself, and report what you did not verify.
- Merge to `main` and push only when the owner says so.
- The owner has no game development experience and expects every basic feature an FPS has. Add what is missing to a brief and tell him; explain in plain language and recommend rather than list options.
- Accounts, payments, DNS, API tokens and passwords are the owner's to handle. Never ask for them.
- Update `HANDOFF.md` and `ROADMAP.md` when a package lands, so they stay sufficient on their own.
