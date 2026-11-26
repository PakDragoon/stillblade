# Trailer Park (APV Courtyard): 3D greybox preview, for review only

This is a look-only model of the owner's image `docs/maps/trailer-park.webp`, read together with the confirmed notes in `docs/maps/trailer-park-notes.md`. **It is not playable.** It isn't registered as a map, the map pipeline didn't build it, and the map checker (`mapkit.py`) hasn't checked it. The older APV Courtyard preview (`docs/review/maps/apv-courtyard/`, built from the stretched SVG) is left exactly as it was.

- **Script:** `tools/blender/previews/trailer_park.py`. The coordinate table at its top lists every wall, block, opening, roof, ramp and marker in image pixels, one row per feature, named after the notes' numbers (`n10_…`, `n18_…`). The table was traced by measuring the image's pixels (filled lighter shapes are blocks, thin lines are walls, gaps are openings) and checked by eye on zoomed crops. Every assumed size is a named constant above the table.
- **Rebuild** (about 2 minutes; it writes everything in this folder; adding `--only view_x,view_y` after the `--` renders just those views):
  `"C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup --python tools/blender/previews/trailer_park.py`
- **Jump heights:** `tools/blender/previews/mount_check.ts` (`npx tsx …`) runs the game's own movement code to find the tallest ledge a player can jump onto.
- **Scene:** `trailer_park.blend`. Its collections can each be hidden: Walls, A_building, A_roofs_barracks, House_17, House_17_roof, Blocks_tall, Blocks_human_height, Boxes_jump, Boxes_low_cover, Vehicles, Elevation_SiteB, East_route, Markers, Scale_players.

## Images

| File | What it shows |
|---|---|
| `compare_side_by_side.png` | The owner's image next to the overhead render, same framing |
| `compare_overlay.png` | The image at 50% over the render: walls, blocks and openings line up |
| `overhead.png` | Straight-down orthographic render, 2 render pixels per image pixel (2000 x 2000) |
| `view_site_b.jpg` | Site B (3) below ground, from the south-east: depth, the south and east stairs, the short walls 22 |
| `view_site_b_from_north.jpg` | Down into Site B from the north stairs |
| `view_east_walkway.jpg` | Raised walkway 13 from the south-west, with plank 15 against its side |
| `view_east_walkway_along.jpg` | Along the walkway from the south: the jump box at its south end (a player standing on it), plank 15, and the walls that close the ground corridor |
| `view_a_building.jpg` | The A building, barrack roofs hidden: box 10, roof 6 (yellow), hole 7, crouch openings 8 and 9 (purple), main entrance 25 |
| `view_a_roof_climb.jpg` | Box 10 up onto roof 6, and along the roof to hole 7 |
| `view_a_under_roof.jpg` | Inside the passage under hole 7, looking south: a standing player fits under the roof |
| `view_house.jpg` | House 17 from the south-west: the two south doors (the west door is on the far side) |
| `view_house_box18.jpg` | Low box 18 north of the house, now east of the yard-wall gap, with crouched players at both its ends and a player walking through the gap |
| `view_birds_eye.jpg` | The whole map |

The red and orange posts are player-size boxes, exactly the game's collision box. Red is standing (1.8 m), orange is crouched (1.2 m), and the black band marks eye height. They are hidden in the overhead.

## Scale

One factor for the whole image: **0.07 m per image pixel**. At that scale:

- Main entrance 25 (27 px) is 1.9 m, a normal doorway.
- Crouch openings 8 and 9 (22 and 16 px) are 1.5 and 1.1 m wide, both wider than the 0.6 m player.
- The gap in the A yard's south wall (33 px) is 2.3 m.
- The school bus is 9.7 x 2.0 m, the van 2.0 x 6.4 m, and jump box 10 is 2.2 x 1.3 m. All read as real sizes.

The image becomes 70 x 70 m, with about 64 x 67 m of playable ground. To change the scale, edit `M_PER_PX`.

## How high a player can climb (measured, not assumed)

`mount_check.ts` runs the shared `stepPlayer` with a ledge directly ahead. **A player can jump onto a ledge up to 1.16 m above their feet.** From the ground that is 1.16 m; from the top of a 1.0 m box it is 2.16 m. The result is the same from 0, 0.3 and 0.6 m back.

## Assumed dimensions

| Constant | Value | Where it comes from |
|---|---|---|
| `M_PER_PX` | 0.07 m/px | Door widths, see Scale above |
| `BOUNDARY_H` | 4.0 m | Test Map 1's outer wall |
| `WALL_H` ("tall": every thin wall line and every filled block not named otherwise, 24) | 3.5 m | Test Map 1's inner walls; far above any jump |
| `HUMAN_H` (trailers 19, short walls 22) | **1.8 m** | Standing player height (owner: "human height") |
| `JUMP_H` (boxes 10, 16, 21, 23, and the two at the walkway's ends) | **1.0 m** | Under the 1.16 m measured climb, with margin |
| `LOW_COVER_H` (box 18) | **1.2 m** | Crouched player height, so it hides you only when crouched; 0.04 m above the 1.16 m climb, so it can't be jumped onto |
| `CRATE_SQUARE_H` (small or square crates in the barracks) | **1.0 m** | Jumpable, like a jump box (owner-approved) |
| `CRATE_LONG_H` (long or thin crates in the barracks) | **1.2 m** | Crouch cover, just too tall to jump onto (owner-approved) |
| `CRATE_LONG_RATIO` | 2.0 | A crate counts as "long" when its footprint is at least twice as long as it is wide |
| `CROUCH_CLEAR` (openings 8 and 9) | **1.4 m** | Above crouched (1.2 m), below standing (1.8 m) |
| `ROOF6_TOP` (roof of middle block 6 and the passage) | **2.0 m** | Box 10 (1.0 m) plus a 1.0 m climb, under the 2.16 m measured limit (0.16 m spare) |
| `ROOF6_T` | **0.15 m** | Leaves **1.85 m** under the roof: a standing player (1.8 m) fits, with 0.05 m spare |
| `BARRACK_ROOF_TOP` | 3.5 m | The barracks are closed and roofed at wall height |
| `EAST_SILL_H` (window beside box 16) | 1.2 m | Can't be jumped onto from the floor (1.16 m); from box 16 it is a 0.2 m step |
| `TRENCH_DEPTH` (Site B) | **1.2 m** | A crouched player is hidden below the rim; deeper than a jump, so the stairs are the way out |
| `STAIR_RISE` / `STAIR_TREAD` | 0.2 / 0.45 m | Test Map 1's stairs; 5 steps plus the floor, a 2.25 m run |
| `RAISED_H` (walkway 13) | **1.2 m** | Just above the 1.16 m climb: you get up by a plank, or by a 1.0 m box at either end and then a 0.2 m step |
| Planks 14 and 15 | 1.2 m rise | Over 4.55 m (15°) and 4.41 m (15°); each 1.0 m wide (`PLANK_W_M`, assumed) |
| `DOOR_H`, `DOOR_W_PX` (house doors) | 2.3 m high, 1.7 m wide | Warehouse's door height; the width is assumed, because the doors are marked, not drawn as gaps |
| `HOUSE_H` | 3.0 m | House walls; the roof slab sits on top |
| Bus 12 / van 26 / APV 11 | 3.0 / 2.5 / 2.4 m | "Tall blockers." The van and bus are above 2.16 m, so not even a box gets you onto them |
| `WALL_T` | 0.25 m | The image draws thin walls 3 to 4 px |

**Roof 6, the owner's two conditions, both hold:**
- **Reachable from box 10:** the roof is a 1.0 m climb from the box, and the measured limit is 1.16 m.
- **Standing room underneath:** 1.85 m against a 1.8 m player.

The margins are small (0.16 m and 0.05 m). Raising the roof to give more headroom eats the climb margin, and the reverse. One more catch: the map checker requires 2.0 m of headroom everywhere a player can reach, so 1.85 m would fail it. Meeting both 2.0 m and the climb would need a roof top of at least 2.15 m, which leaves 0.01 m of climb margin: too tight to rely on. If this becomes a real map, the checker's rule would need an exception here, or the passage a different design.

## Owner-approved decisions

The owner approved these answers to the open items from the first version:

1. **House 17 doors:** at the three marks just outside the outline (one west at y 862, two south at x 504 and 617), 1.7 m wide and 2.3 m high.
2. **Planks 14 and 15:** both rise toward the middle. The two short walls at y 530 and y 592 close the ground corridor between them.
3. **Walkway 13 ends:** a 1.0 m jump box on the ground at each end, so a player can climb back up (box, then a 0.2 m step to the 1.2 m walkway).
   - **North box:** x 852–872, y 364–380, 1.4 x 1.1 m, beside the tall block already at the walkway's north-east corner.
   - **South box:** x 880–899, y 700–716, 1.3 x 1.1 m, against the outer wall.
   - Neither blocks the ground corridor west of the walkway. The south one is in `view_east_walkway_along.jpg`, with a player standing on it.
4. **Box 18 shrunk:** only the part east of the A yard's wall gap is kept (x 423–481, 4.1 x 4.1 m, still 1.2 m tall).
   - The gap (x 387–420) stays walkable at full width (2.3 m), and the floor west of the box links it to the open ground beyond the west post.
   - The box is crouch-only cover beside the gap (`view_house_box18.jpg`).
   - The west part of the drawn footprint (x 352–387) was dropped: kept, it would have boxed the gap into a dead end against the house.
5. **Shapes inside barracks 4 and 5 are crates**, sized by the rule above:

   | Crate | Footprint | Height |
   |---|---|---|
   | `crate_a4_desk_nw` | 2.0 x 1.3 m | 1.0 m |
   | `crate_a4_bench_n` | 3.2 x 0.7 m | 1.2 m |
   | `crate_a4_tilted_table` | 2.6 x 1.8 m | 1.0 m |
   | `crate_a4_small_tilted` | 1.5 x 0.6 m | 1.2 m |
   | `crate_a4_ne_corner` | 1.6 x 1.5 m | 1.0 m |
   | `crate_a4_se_corner` | 2.2 x 2.1 m | 1.0 m |
   | `crate_a4_post` | 1.5 x 0.6 m | 1.2 m |
   | `crate_a4_post_w` | 1.1 x 0.7 m | 1.0 m |
   | `crate_a4_box_sw` | 1.3 x 1.3 m | 1.0 m |
   | `crate_a4_bench_s` | 2.9 x 0.8 m | 1.2 m |
   | `crate_a4_small_s` | 0.8 x 0.8 m | 1.0 m |
   | `crate_a5_box` | 1.3 x 1.3 m | 1.0 m |
   | `crate_a5_bench` | 5.8 x 1.7 m | 1.2 m |
   | `crate_a5_tilted` | 1.8 x 1.1 m | 1.0 m |
   | `crate_a5_box_e` | 1.4 x 1.2 m | 1.0 m |

   Under the 3.3 m barrack ceiling, a player on a 1.0 m crate still has 2.3 m of headroom. The two blocks just outside the south barrack (`n24_a_south_bar`, `n24_a_se_box`) stay tall.
6. **Site B:** stairs at all three open edges (north tip 1.7 m wide, south end 2.2 m, narrow east mouth 0.9 m).
7. **The pink walls above the passage roof stay** (see below).

## How I read the A building

- **North barrack 4** holds the Site A plant spot. **South barrack 5** is the other room. Both are closed buildings with a roof.
- **Ways in:**
  - Main entrance 25: an open gap in the north barrack's west wall, full height.
  - Crouch openings 8 (north wall, defender side) and 9 (south barrack's south wall).
  - The east window beside box 16: stand on the box, step over the 1.2 m sill, drop outside to the east.
  - Hole 7.
- **Middle band between the barracks** (owner's answer):
  - West part (x 583–708): the closed block 6, roofed at 2.0 m. Its west wall is only roof-high, so from box 10 you climb straight onto the roof.
  - East part (around hole 7, x 708–778): a roofed passage, open on its north and south sides into both barracks.
  - Both roofs are one continuous slab at the same height, so a player walks along it from above box 10 to hole 7 (see `view_a_roof_climb.jpg`).
  - You drop through the hole into the passage, then walk out into either barrack. There's no way back up through the hole.
- **Inferred walls** (pink in the renders, owner-approved): above the passage roof, from 2.0 m up to the barrack roofs along its north and south edges. The image draws no wall there. Without them, a player on roof 6 could crawl sideways under the barrack roofs, through the 1.3 m gap between the two roof heights.
- **East room** (x 778–818, between the barracks): drawn closed on all sides, so it is a closed room with no entrance.

## East route

- **Walkway 13** is raised 1.2 m along the east corridor (x 852–900, y 380–700).
- **The planks** are the two short lines at x 845–848. Each is a 1 m wide ramp lying against the walkway's west side.
  - Both rise toward the middle (owner-approved). Plank 14 is low at its north end and high at y 530; plank 15 is low at its south end and high at y 592.
  - The two walls drawn from the A building's east wall out to the planks (y 530 and y 592) close the ground corridor between them. To get past, you go up one plank, along the walkway, and down the other.
- **The walkway's ends** (y 380 and y 700) each have a 1.0 m jump box for climbing back up (owner-approved, see above).

## What I couldn't read from the image

1. **Jump box 23 isn't in the image.** Nothing is drawn at the notes' position (383, 926). I built it there as the notes say. The nearest drawn box is against the south boundary wall at (550, 961); I built that one tall, under rule 24.
2. **Site B's curved bank lines** are traced as straight pieces of 1 to 3 m.
3. **Small unlabelled things:**
   - **Empty outlined squares:** one beside box 21 (x 258–273, y 478–492) and one under the south barrack (x 655–690, y 709–727). I built only the second, as walls drawn on its open sides.
   - **Round post:** the one on the short-wall line by B, given the short walls' 1.8 m height.
4. **The small curved line on the T block north of A** (x 720–734, y 366–391) is built as a short tall wall. It could instead be a ramp edge or a cable.
5. **The 7 px gap in block 6's east wall** (y 576–583, 0.5 m) is kept as drawn. It is too narrow for a player.

## Diagonal shapes in the game

Collision in the game is axis-aligned boxes only. Here the APV (11) and its nub, the west trailer (19), a few tilted blocks, the round post and Site B's curved banks are modelled at their drawn angles, for looks only. In a playable version they would keep their look, but their collision would be a few boxes that follow the shape: 3 or 4 for the APV, about 1 per metre along the B banks. The plank ramps and the B stairs would become 0.2 m steps, because collision has no slopes.

## Not verified

- **Nothing was walked in the game.** The climb limit (1.16 m) was measured with the movement code in a minimal test scene, not on this map. Every other height is worked out from that number and the constants.
- **The map checker wasn't run.** As built, the crouch openings (1.4 m) and the passage under roof 6 (1.85 m) are below its 2.0 m headroom rule, and the plank ramps are slopes.
- **The overlay was judged by eye.** Shapes under about 6 px (posts, marks) may be off by a pixel or two (about 0.1 m).
- **Not measured:** sightlines, spawn safety and route timing.
