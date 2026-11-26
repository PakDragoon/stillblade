# Trailer Park (`trailerpark`): the playable greybox

Built from the owner-approved preview (`tools/blender/previews/trailer_park.py`, README in `docs/review/maps/trailer-park/`) as a real map: `tools/blender/maps/trailerpark.py`, built with `npm run map -- trailerpark`, checked by `tools/blender/mapkit.py`. Test Map 1's look (same five surfaces, copings, paint), not the realistic art.

## Pictures

Taken from the real client in headless Chrome (SwiftShader software GL, Low tier, 1280 x 720) on scratch ports 8090 (server) and 5190 (Vite), with `node tools/trailerpark-shots.mjs`. The client joined a practice room on the map; the camera was then placed at each view at standing (1.62 m) or crouched (1.02 m) eye height over the nearest walkable spot. Practice targets are hidden. `shots.json` has each camera and the draw-call count.

| File | View |
|---|---|
| `01_ghost_spawn.jpg` | ghost spawn (bottom left of the drawing) |
| `02_defender_spawn.jpg` | defender spawn (top) |
| `03_site_a_in_barrack.jpg` | Site A inside the north barrack |
| `04_site_b_pit.jpg` | Site B in the pit, from the south stair |
| `05_site_b_from_rim.jpg` | Site B from the ground east of the pit (the curved banks) |
| `06_box10_to_roof6.jpg` | standing on box 10, roof 6 ahead |
| `07_hole7_down.jpg` | on roof 6, looking down through hole 7 |
| `08_under_hole7.jpg` | in the passage under roof 6, hole 7 above |
| `09_crouch8_crouched.jpg` | crouched at crouch opening 8 |
| `10_crouch9_crouched.jpg` | crouched at crouch opening 9 |
| `11_walkway_from_plank14.jpg` | on plank 14, the east walkway ahead |
| `12_plank15_from_ground.jpg` | plank 15 from the ground corridor |
| `13_house.jpg`, `14_house_inside.jpg` | house 17 from the south, and inside |
| `15_box18_yard_gap.jpg` | the A-yard wall gap beside box 18 |
| `16_apv.jpg` | the APV |

Every view drew 8 calls with the targets hidden: the world (5 surfaces + paint, one GLB primitive each), the sky, and the first-person knife.

## Measured

| | Trailer Park | Test Map 1 | Warehouse |
|---|---|---|---|
| Spawn to site paths (walking, A / B) | ghosts 52.4 / 56.8 m (48.8 m to B dropping into the pit), defenders 35.2 / 43.7 m | ghosts 30.6 / 30.5, defenders 11.0 / 10.8 | ghosts 38.6 / 39.3, defenders 14.8 / 15.4 |
| Longest sightline (eye to eye, 1.5 m grid) | 63.4 m (limit set to 64) | not checked | 30 m limit |
| Collision boxes (hidden ones in brackets) | 437 (183) | 45 | 345 |
| Visual-only boxes (turned ones) | 199 (87) | 26 | |
| World draw calls with the sky (Low budget 8) | 7 | 7 | 8 |
| Vertices | 23,044 | | about 30 k |
| Lightmap | 4096², 2.8 cm per texel | 3072² | 4096² |
| Download (GLB, JSON, lightmap, shared sky and textures) | 2.57 MB (GLB 0.93, JSON 0.34 with the nav graph, lightmap 0.54) | 1.2 MB | 2.9 MB |
| Bake (1024 samples, RTX 4060 OptiX) | 300 s (build 308 s) | 150 s | 365 s |
| Nav graph (nodes / links in the file, a two-way link counted once) | 3,350 / 11,415 (8 of them crouch links, all two-way: 16 one-way crouch moves) | 1,481 / 5,457 | 3,388 / 11,307 |
| Server bench, 10 bots, 120 s (`tools/bench.ts --bots`) | 0.149 ms a tick, 99th percentile 0.92, worst 3.7 ms after warm-up | | 0.138 / 1.01 / 5.8 in the same run |

Routes the checker proves separate (`route_gates`), shortest ghost path through each:
- **Site A:** main entrance 25 52.4 m; crouch opening 9 then the passage 56.6 m; box 10, roof 6 and hole 7 55.0 m; crouch opening 8 68.4 m.
- **Site B:** a drop off the rim 48.8 m; south stair 49.1 m; east stair 68.1 m; north stair 76.6 m.

Ghost spawn eyes see no defender spawn eye (0 of 25 pairs).

Low ceilings (the checker's new per-map list), all reachable spots inside each:
- crouch opening 8: 9 crouch-only spots, 1.40 m clear;
- crouch opening 9: 12 crouch-only spots, 1.40 m clear;
- passage under roof 6: 264 spots under 2.0 m, lowest 1.85 m (standing fits).

## Where it departs from the preview, and why

1. **Planks 14 and 15** are real stairs (0.2 m rises, 0.45 m treads) under visual boards. They are **2.25 m wide, the whole ground corridor**, not 1.0 m (preview) or 1.6 m (`MIN_STAIR_WIDTH`), because a narrower plank leaves a 0.65 m slot beside it (under the 1.4 m walkway minimum). They keep the drawn top ends (image y 530 and 592) but are **2.25 m long, not 4.5 m**: at full length plank 14's middle steps sit beside the barrack's east window, and from a 0.6 m step the 1.2 m sill can be jumped onto, which would make the window (meant as a way out, by box 16) a way in. The boards slope about 24° (preview 15°) and their top always stays at or under the steps, so a player floats up to 0.2 m above the board at the front of a step.
2. **The ground pocket between the two plank tops** (closed by the two short walls at y 530 and 592) is filled to walkway height. As drawn, anyone dropping into it from the walkway could never climb out. The two short walls are no longer needed and are gone.
3. **The walkway fills the outer wall's bay** (image x 900 to 918, y 526 to 596) for the same reason: a ground pocket beside a 1.2 m walkway is a trap.
4. **Crouch opening 9 is 1.40 m wide** (was 1.12). Opening 8 stays 1.54 m.
5. **Site B's stairs** sit in three straight channels 1.7 m wide, stairs 1.66 m: the east mouth was 0.93 m, the north 1.69 m, the south 2.15 m. The pit's outline is reshaped by up to about 0.6 m at those three ends; elsewhere it follows the traced curve. The banks are turned wall pieces with a 0.6 m flat lip on the ground beyond them; their collision is boxes about every metre (at most about 0.2 m of invisible edge into the pit at a slanted bank).
6. **The outer wall** follows the traced outline in steps of about 1 m (every collision box is axis-aligned); the curved and slanted corners are stepped, not turned.
7. **Closed rooms are solid**: block 6 under roof 6 (its 0.5 m slot is too narrow for a player), the east room between the barracks, the room north-east of the north barrack, and the small room south of the south barrack.
8. **Gaps under 1.4 m closed or opened** (each was a slot a player could squeeze into):
   - crates within about half a metre of a wall or another crate are pushed against it (barrack 4: desk, benches, the sw/se/ne corner crates, the small tilted crate moved 0.6 m east and 0.12 m north; barrack 5: bench 0.44 m south, box by the east wall, the tilted crate against the south wall 1.41 m from the bench); the wedge of the se corner crate is cut to 0.7 m, 1.5 m from box 16;
   - the two trailers are 1.40 m apart (were 1.17; the east one moved 0.23 m);
   - box 21 fills the whole 2.45 m gap between the long wall and the yard block (was a 1.05 m box leaving 0.2 and 1.2 m beside it), still 1.0 m to jump over;
   - short wall c is carried down to the slanted wall F, closing a 1.05 m gap into the small pocket between walls d, e and F (now solid);
   - the block south-east of the south barrack loses its east pad (1.43 m to the walkway's corner, was 1.30);
   - the preview's short curved line on the T block north of A (unlabelled; "could be a ramp edge or a cable") is left out: as a wall it narrowed the way past the closed room to 1.15 m;
   - smaller snaps of 0.4 m or less so blocks touch their neighbours: the bus against its side wall, the posts by the bus and north of the big T, the small block by the NE corner wall, the T block, the block north of the yard, the corridor box and both walkway jump boxes, the west post and wall box, the box south of B, the small west block, the south boxes and posts on the outer wall, box 18 (touching the yard wall, its east post and the house), jump box 23 against the house's south wall, the south yard wall in line with the barrack wall (5 px lower in the drawing), the small block west of the north wall.
9. **Site boxes are 1.25 m tall**, not Test Map 1's 2.5 m, so Site B holds only the pit floor (not someone standing on the rim above it) and Site A the barrack floor and its 1.0 m crates.
10. Spawns: five per team, 1.2 m apart, at the drawn spots (ghosts face north, defenders south).

## Checked

- `python tools/blender/mapkit.py trailerpark` and the build pass every check.
- `npm test`: the new `server/src/trailerpark.test.ts` walks the special ways with the shared movement code along the nav graph the way a bot follows it: through crouch openings 8 and 9 crouched (and not standing, and back out), stuck crouched under a lintel until clear of it, standing but unable to jump under roof 6, through hole 7 (and no link back up through it), from the ground onto box 10 and roof 6 (two jumps), up and down both planks. `server/src/bots.test.ts` now runs Trailer Park too: every spawn has a nav path to both sites; a ghost bot carries the bomb to each site and plants against a passive defender; a defender bot goes to a bomb planted at each site and defuses it.
- A real round on the scratch server: `tools/bot.ts --plant` as the only ghost and `tools/bot.ts --shoot` as the defender: the ghost carried the bomb in through the main entrance and planted at Site A in each of the two rounds run; no server errors.

## Not verified

- **Nobody has played it with a mouse**, and nobody has looked at it moving. Frame rate on a laptop is the owner's to check (headless Chrome renders in software).
- Balance. In a bot-versus-bot match (`tools/botmatch.ts trailerpark`, normal, five a side) defender bots won all 11 rounds by elimination and no bomb was planted; on Test Map 1 the same run had 3 defused plants. Ghost bots are already known to be weak (HANDOFF, package E), and the ghost routes here are 52 to 57 m against the defenders' 35 to 44 m.
- The 63 m sightline down the west lane (from south of the house to the north end of the pit) is longer than anything on the other maps.
- Bots were not watched taking hole 7 or the planks in a full match; the tests above cover the graph and the movement.
