# Realistic weapons (package M part 2): review screenshots

Taken on 2026-11-18 by `node tools/weapon-shots.mjs` in **headless Chrome with software GL (SwiftShader)**, driven over
the DevTools protocol, against a scratch game server on port 8094 (`SB_SERVER_PORT=8094 npx tsx server/src/main.ts`)
and Vite on port 5194 (`npx vite --port 5194 --strictPort`). The owner's ports 8080 and 5173 were not touched. 1366 x
768. **Nothing here was seen in a real browser window, on a real GPU, in motion or with a mouse**; software GL also
renders the lighting and the WebP textures differently from a real graphics card in small ways.

Every picture is a real game state, driven through the game's own input (keys dispatched on the page: Z to aim, F to
fire, R to reload, 2 and 3 to switch), frozen with `app.timeScale = 0` on the frame of interest. The sight comes from
the saved loadout through the server, as in play. Third person: scripted players (`tools/bot.ts --still`, with
`--pistol` / `--knife`, and `sight=` in their join address) seen from a ghost's page; the camera is moved next to each.

| File | What it shows |
|---|---|
| `10-rifle-<sight>-hip.jpg` | The AK-105 from the hip with iron sights, the red dot, the 2x scope (practice range, Low tier, Test Map 1). |
| `11-rifle-<sight>-aimed.jpg` | Fully aimed with each sight. Iron: the AK's own rear sight and front post. Red dot: the reticle is part of the model, glowing on the sight's glass. 2x scope: the scope seen from close behind its eyepiece, a chevron reticle in the lens, the gun and the scope body still in view (no blackout). |
| `11-rifle-scope2x-aiming-in.jpg` | Half way into the 2x scope. |
| `12-rifle-reload-a/b/c` | Rifle reload frozen at 20 % (magazine out, in the left hand), 50 % (new magazine coming up), 88.5 % (charging handle pulled back by the left hand from under the gun; the gun rolled to show its right side). |
| `20`, `21`, `22-pistol-*` | The Makarov from the hip, aimed, and mid-reload at 30 % (magazine out), 60 % (new magazine) and 76 % (slide back). |
| `30-knife-idle`, `31-knife-swing` | The defender's knife at rest and mid-slash (frozen 3 commands after the strike landed). |
| `32-ghost-knife-idle` | The same knife rig with the ghost's dark sleeves. |
| `40`, `41`, `42`, `43-*` | High tier on Test Map 1 (red dot hip and aimed, pistol, knife), Low tier in Warehouse (iron), High tier in Warehouse (2x scope). |
| `50-third-person-<who>-front/side` | Remote defenders: rifle with the red dot, rifle with the 2x scope, pistol, knife, and a red-dot rifle in a room created with suppressed weapons. |

`report.json`: draw calls per frame with the other players hidden: 9 with the rifle at the hip (each sight), 8 fully
aimed (each sight), 8 with the pistol, 10 with the knife (the knife's view has one more world material in frame; before
this package it was 11, because the defender's knife rig drew the ghost's sleeves too, a bug fixed here). The gun in hand
is one draw call in every case, as before.

Things to judge with your own eyes: whether the metal reads as metal on a real screen (it is lit by the fixed sun and
ambient plus a generated studio reflection), the size of the 2x scope's lens on your monitor, the red dot's reticle size
(1.1 mm on the glass, about 6 px across at 1366 x 768), and the hands (still the cartoon arms until package O).
