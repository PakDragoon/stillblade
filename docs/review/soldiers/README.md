# Package O review screenshots (realistic soldiers)

Taken 2026-11-18 by `tools/soldier-shots.mjs` in **headless Chrome with software GL (SwiftShader)** against a scratch
game server on port 8098 and Vite on 5198 (never the owner's 8080 / 5173), 1366 x 768. **Nothing here was seen on a
real GPU or in motion**: frame rates mean nothing, and every picture is one still frame.

How they were made:
- **First person (10-43):** the practice range, joined as a defender (or a ghost for 32-33) with the game's own input
  dispatched on the page (keys for switching, aiming with Z, firing with F, reloading with R). Reloads and swings are
  frozen (`app.timeScale = 0`) at a chosen fraction of the predicted reload or swing. Real game states, not staged.
- **Third person (60-74): STAGED poses.** Practice-range targets never fight, so each picture takes one standing target
  and replaces its view fields (weapon in hand, aiming, crouched, reloading, alive) in the frame the presenter receives;
  swings are started with `presenter.remoteSwing`. The character code path is the real one (animation layers, sockets,
  pitch and crouch lean), but the state is invented. The camera is moved freely and the first-person layer is hidden.
  Defenders are seen from a ghost's page; ghosts from a defender's page, where practice targets are drawn fully visible
  (the shimmer at opacity 1), plus one at a running ghost's 0.35 (74).
- Tiers by `?tier=low|high`; maps Test Map 1 (`greybox`) and Warehouse.

| Files | What |
|---|---|
| `10-rifle-{iron,reddot,scope2x}-hip`, `11-...-aimed` | The AK with each sight, at the hip and fully aimed (Low, Test Map 1). `11-rifle-scope2x-aimed`: the downloaded AR Scope, eye 4.5 cm behind it, the lens framing the 2x view |
| `12-rifle-reload-{a,b,c}` | Rifle reload: magazine out, new magazine, charging handle pulled |
| `20-pistol-hip`, `21-pistol-aimed`, `22-pistol-reload-{a,b,c}` | The Makarov in two hands; reload |
| `30-knife-idle`, `31-knife-swing` | Defender knife |
| `32-ghost-knife-idle`, `33-ghost-knife-swing` | A ghost's knife: the dark suit arms and gloves |
| `40-*-hip`, `41-*-aimed`, `42/43-*` | High tier and Warehouse |
| `60-{tier}-{map}-defender-rifle-{front,side,back,q}` | Defenders holding the rifle, both tiers, both maps |
| `61-...-rifle-aiming`, `62-...-pistol`, `63-...-knife` | Aiming the rifle, the pistol, the knife |
| `64-...-crouched-{rifle,pistol}` | Crouched (the crouch lean of `characters.ts` applied) |
| `65-...-reload-rifle-magazine`, `65-...-reload-pistol-slide` | Third-person reloads, frozen 0.8 s and 1.05 s in |
| `66-...-defender-knife-swing`, `67-...-defender-corpse` | Knife swing; a body after the death clip |
| `70-{tier}-{map}-ghost-*`, `71-...-crouched`, `72-...-knife-swing`, `73-...-corpse`, `74-...-shimmer-0.35` | Ghosts |
| `report.json` | Draw calls: first person with the other players hidden; third person a whole frame, the same frame with the players hidden, and the difference per player |

Not shown: the 1x red dot and 2x scope on remote players' rifles (practice targets use iron sights), suppressed guns,
a real match, movement.
