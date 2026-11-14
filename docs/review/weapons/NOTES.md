# Rifle and pistol presentation: browser check (2026-11-15)

Local server on 8092, Vite on 5192, `?map=greybox`, a still ghost bot first so the page joined as a defender.
The browser pane was visible (about 60 to 75 FPS), so frames ran on requestAnimationFrame. Mid-motion shots
were taken by stubbing requestAnimationFrame for a moment (the last frame stays on screen). Input was
dispatched KeyboardEvents (Digit1, Digit2, KeyQ, KeyZ held, KeyF, KeyR); no pointer lock.

| File | What |
|---|---|
| 01-rifle-hip.jpg | Rifle from the hip (unchanged pose). |
| 02-rifle-aimed.jpg | Rifle fully aimed: rear sight under the crosshair, spread ticks faded. 02a: first try, too close. |
| 03-pistol-hip.jpg | Pistol from the hip. |
| 04-pistol-aimed.jpg, 04b | Pistol fully aimed; 04b one frame after a shot (kick and flash). 04a: before the roll fix (below). |
| 05-mid-switch-to-pistol.jpg | 0.09 s into a switch: the pistol rising from below. |
| 06-pistol-reload.jpg | Pistol reload, 0.5 s in: tilted, magazine well toward the support hand. |
| 07-hud-pistol-reloading.png | HUD: "1 Rifle 30/90" dim above "2 PISTOL", 8 / 36, RELOADING bar. |
| 08, 08b | A `--pistol --shoot` defender bot seen by a ghost (camera moved by script for the shot): pistol in hand, rifle disabled, 2 render components enabled on the character; tracer and flash from the pistol. |

Found and fixed during the check: the source "Pistol" prop is rolled about 13 degrees in the Character Soldier
file (grip leaning sideways), which read as a canted gun when aimed. weapons.py now turns it upright.

Numbers: gunMismatches 0 and error 0 throughout (pistol taps, pistol reload back to 12, rifle burst, switches
by 1, 2 and Q); no console errors in either tab.

Not checked: sound by ear; the remote switch dip and aim raise (code path only); mouse feel; frame rate.
The remote pistol sits in the rifle's two-handed hold, so it is mostly hidden between the hands.
