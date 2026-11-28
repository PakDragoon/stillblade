# Dry Creek playtest sheet (greybox, 5 v 5, sides swapped)

Play one full match: ten rounds, sides swap after round 5, so each group plays five rounds as ghosts and five as
defenders. One person per team fills in the round table during the round-end card, or right after. Use the route
names below exactly so the sheets can be compared.

**Before the match:** the room creator picks Dry Creek, everyone wears headphones, and everyone plays the B
headphone check below (2 minutes, in warmup).

## Route names

Since the art (stage 2) these names are painted on boards on the walls players come in by (A LONG, A SHORT, ROOF,
WEST DOOR, EAST DOOR, FLANK, B MID, B NORTH, B SOUTH, WALKWAY), so players can call them in voice.

| Site | Ghost route (how the ghost came in) | Where it meets the site |
|---|---|---|
| A | **A long door 7**: west lane, A long, south barrack door 7, through the passage | passage mouth |
| A | **West door 22**: west lane, A long, along the barrack wall, west door 22 | west doorway |
| A | **A short 8**: fuel gap, mid, A short, crouch gap 8, south barrack, passage | passage mouth |
| A | **Roof 10**: box 9 onto the low roof, drop through roof hole 10 | passage, under the hole |
| A | **Flank 6**: west lane, beside the watchtower, crouch gap 6 | north wall |
| A | **East door 5**: right round the yard to the defenders' door | east doorway |
| B | **B mid**: fuel gap, mid, round the blast wall, B mid stairs | west stairs |
| B | **B south**: south lane, B south, south stairs | south stairs |
| B | **B north**: round to the defenders' side, B north, north stairs | north stairs |
| B | **Walkway**: south lane, walkway stairs, walkway, stairwell 23, plank, east stairs | east stairs |

Retake routes (defenders after a plant) use the same names: **B north**, **B mid**, **B south**, **Walkway**,
and for A **East door 5**, **West door 22**, **Passage** (from A short or door 7) and **Flank 6**.

## Round table (one row per round)

| Round | Ghost team | First contact: route, and where | Plant tried at (A / B, route) | Planted? | Retake route(s) used | Defused? | Winner | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |
| — | **sides swap** | | | | | | | |
| 6 | | | | | | | | |
| 7 | | | | | | | | |
| 8 | | | | | | | | |
| 9 | | | | | | | | |
| 10 | | | | | | | | |

**First contact** means the first time anyone on either team saw or clearly heard an enemy. Write the route the
ghost was on and the spot, for example "A short 8, at the crouch gap" or "B mid, on the stairs".

## Totals (fill in after the match)

| | Site A | Site B |
|---|---|---|
| Plants tried | | |
| Plants completed | | |
| Plants defused | | |
| First contacts on each route (count per route name) | | |
| Retake routes used (count per route name) | | |

## B headphone check (warmup, 2 minutes, two players)

1. Player 1 stands in the middle of the B basin, by the transformer, eyes closed or looking at the floor.
2. Player 2 walks the walkway from its north stairs to its south stairs, running, then walking (Shift), then
   crouched. Then the same length on the basin floor, round the transformer.
3. Player 1 says each time: walkway or basin? Which side? Near or far?

| Walk | Player 1 said | Right? |
|---|---|---|
| Walkway, running | | |
| Walkway, walking | | |
| Walkway, crouched | | |
| Basin, running | | |
| Basin, walking | | |
| Basin, crouched | | |

Then swap: Player 2 stands on the walkway, Player 1 walks the basin.

## The two questions this test must answer

**1. Can ghosts split a defender's attention at A?** Tick one, and say why in a line.

- [ ] Yes: two ghosts coming by different routes at the same time (for example West door 22 and A short 8, or
  Roof 10 and West door 22) made the defender at the console turn away from one of them.
- [ ] No: one defender at the console could watch every way in at once (say from where).

What the automated check found (server/src/drycreek.test.ts, "one defender at the console"): see README.md,
"Console visibility". A short and the roof hole both come into the north barrack through the passage, so on paper
the console has two angles to watch (the west door and the passage), not three. The playtest decides whether that
is enough.

**2. Can defenders retake B by more than one useful route after a plant?** Tick one.

- [ ] Yes: retakes came by at least two routes (write which) and at least one worked.
- [ ] No: every retake came by one route (write which), because the others were too slow or too exposed (say
  which and why).

## What only people can judge

- Whether the sound of a ghost on the walkway is different enough from one in the basin (the headphone check).
- Whether any route is never used, or always used.
- Whether the ghost or defender side wins too often (record the winner of every round above).
- Frame rate on a laptop without a graphics card (note any stutter and where).
