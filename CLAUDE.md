# Stillblade

Browser tactical FPS (PlayCanvas engine as a library, TypeScript, Vite; authoritative Node WebSocket server).

Read `HANDOFF.md` before starting work: it records what is verified, what has never been tested, known problems, and the rules that keep client and server in sync.

- `npm run dev` starts server and client; `npm test`; `npm run typecheck`.
- Shared simulation rules live in `shared/` and must stay identical for client and server.
- Collision is axis-aligned boxes only; each map is generated from its definition in `tools/blender/maps/<id>.py` by the shared builder (`npm run map -- <id>`, verification in `tools/blender/mapkit.py`), never hand-edited.
- The owner prefers the main session to write correctness-critical code itself and delegate self-contained art, tooling and UI work to Opus subagents.
