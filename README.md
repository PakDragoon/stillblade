# Stillblade

Low-spec browser tactical FPS. Ghosts are invisible while still and carry knives; defenders have guns and track them by sound.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## Layout

- `shared/` — deterministic movement and collision, run by both the client and (later) the authoritative server. Tests: `npm test`.
- `client/` — PlayCanvas client (Vite root). Maps live in `client/public/maps/` as a `.glb` (visuals) plus a `.json` (collision boxes, spawns, bomb sites).
- `tools/blender/` — headless Blender scripts that generate maps. Rebuild the greybox with `npm run map:greybox`.

Maps are built only from axis-aligned boxes; the collision system supports nothing else.
