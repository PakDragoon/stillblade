# Armor (package P) review screenshots

Taken 2026-11-18 by `tools/armor-shots.mjs` in headless Chrome (software GL, 1366 x 768, Low tier) against a scratch
server on port 8092 and Vite on 5192, Test Map 1, practice range as a defender.

- `hud_full_armor.jpg` (real): health and armor at spawn, `100` and a shield with `100`.
- `practice_hits_split.jpg`, `practice_strip_crop.jpg` (real): four single rifle shots at a practice target 6 m
  away, each listed in the top strip as `34 body (17 armor / 17 health)` from the server's `hitconfirm`. `strip.txt`
  holds the strip's text.
- `hud_armor_42_flash_STAGED.jpg`, `hud_armor_42_STAGED.jpg`, `hud_armor_empty_STAGED.jpg` (STAGED: the presenter
  was handed `armor` 42 and then 0 on its input; no real hit on the local player). The flash after a drop lasts
  0.18 s plus a 0.3 s fade and was not caught on the "flash" frame (software GL frames are slower than that), so the
  flash itself has not been seen. At 0 the shield and number are dimmed to 28 %.

Not seen: the armor drop and flash from a real hit on the local player, and the armor-hit sound (nobody listened).
