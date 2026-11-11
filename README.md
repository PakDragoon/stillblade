# Stillblade

Low-spec browser tactical FPS. Ghosts are invisible while still and carry knives; defenders have guns and track them by sound.

## Run

```bash
npm install
npm run dev
```

This starts the game server (ws://localhost:8080) and the web client. Open http://localhost:5173; every browser tab that opens it is another player.

- `npm run bot` adds a headless player that walks in and strafes, for testing alone (`npm run bot -- --shoot` makes it fire).
- Add `?lag=150` to the URL to simulate 150 ms of round-trip latency.
- Add `?server=ws://host:port` to connect to a server elsewhere.

## Layout

- `shared/` — deterministic movement and collision, run by both the client and (later) the authoritative server. Tests: `npm test`.
- `server/` — authoritative match server (Node + WebSockets). `game.ts` has no socket code, so the rules, hit detection and lag compensation are unit-tested directly.
- `client/` — PlayCanvas client (Vite root). Maps live in `client/public/maps/` as a `.glb` (visuals) plus a `.json` (collision boxes, spawns, bomb sites).
- `tools/blender/` — headless Blender scripts that generate maps. Rebuild the greybox with `npm run map:greybox`.

Maps are built only from axis-aligned boxes; the collision system supports nothing else.
