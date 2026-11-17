# Rifle sights (package M part 1): review screenshots

Taken on 2026-11-17 by `node tools/sight-shots.mjs` in **headless Chrome with software GL (SwiftShader)**, driven over
the DevTools protocol, against a scratch game server on port 8092 (`SB_SERVER_PORT=8092 npx tsx server/src/main.ts`)
and Vite on port 5192 (`npx vite --port 5192 --strictPort`). The owner's ports 8080 and 5173 were not touched. 1366 x
768, Test Map 1, Low tier. **Nothing here was seen in a real browser window, on a real GPU or with a real mouse**: aim
was held with the Z key (the aim action's second binding) through the game's own input, and Esc was a synthetic key
event.

Every picture is a real game state. Nothing was handed to the presenter by hand: the sight comes from
`localStorage` (`sb-loadout`) through the join query to the server, back in the `spawn` message and the self snapshot,
and for other players through the roster.

| File | What it shows |
|---|---|
| `01-home-menu.png` | The home menu with the new Loadout button ("Rifle sight: 1x red dot", the saved choice). |
| `02-loadout-page-menu.png` | The Loadout page: three sights, one line each, the saved one highlighted. |
| `03-loadout-page-scope-picked.png` | After clicking the 2x scope; `sb-loadout` then read `{"sight":"scope2x"}`. |
| `10-<sight>-hip.jpg` | Practice range as a defender, rifle at the hip, with that sight mounted (iron: the rifle as before). |
| `11-<sight>-aiming-in.jpg` | Frozen at about 60 % aim: the overlay starting to fade in (red dot, scope ring). |
| `12-<sight>-aimed.jpg` | Fully aimed: iron sights as before (crosshair kept); red dot reticle inside the sight's window with the hip crosshair hidden; the 2x scope's ring and dark edge with the gun hidden. |
| `20-pause-menu.png` | The pause menu with its new Loadout button. |
| `21-pause-loadout-applies-next-spawn.png` | With the 2x scope mounted, picking the red dot mid-life: "Applies at your next spawn. This life keeps the 2x scope." (the server and the predicted loadout still had the scope afterwards). |
| `30-third-person-<sight>-front/side.jpg` | Seen by a ghost: two defenders joined from plain WebSocket clients with `sight=2` and `sight=1`; their sights come from the roster and are drawn on their rifles. |

`report.json` holds the numbers the script read back, including:

- Aim counter when fully aimed: 12 (iron), 12 (red dot), 16 (2x scope), as the table says; camera field of view
  60.2, 56.6 and 41.3 degrees.
- Draw calls with the other players hidden (the practice targets walk in and out of view, so totals with them vary):
  9 at the hip with each of the three sights (a sight costs no draw call: the gun in hand is still one); fully aimed
  9, 9 and 7 (with the 2x scope the gun is hidden and the narrower view culls more).

Things to judge with your own eyes (not settled by these pictures): whether the red dot and the 2x ring read well at
real screen sizes, the zoom amounts, how the aim-in feels with a mouse, and the stand-in sight models (part 2 replaces
the rifle and its sights with a realistic model).
