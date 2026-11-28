"""
Dry Creek (file id `drycreek`): a walled military compound, 80 x 80 m, built as a playable greybox with
Test Map 1's look. Built with `npm run map -- drycreek`.

Source of truth: the owner-approved plan, draft 4 (docs/maps/dry-creek/dry-creek-plan-v4.svg), and the
script that drew it (docs/maps/dry-creek/dry_creek_plan_v4.py), whose rectangles r(...) and walls w(...)
are in metres. Every coordinate below is written in those PLAN metres (x east, y SOUTH, north up,
0..80) and converted once by the helpers:

    authoring X = x - 40          authoring Y = 40 - y          (Blender, Z up, metres)

so the plan's south (the ghost spawn, bottom left) is -Y and the defender spawn (top right) is +Y. In
engine coordinates (x, height, z = -authoring Y) that is simply x - 40 and z = y - 40.

Wall lines in the plan are 0.25 m thick walls centred on the line (T). Where two walls meet, one of
them runs on to the other's far face, so no two boxes overlap and no corner is open. Every change
from the drawn plan is listed in docs/review/maps/drycreek/README.md with its reason, and marked
"DEVIATION" here.

Heights (stage 1 of the art package, real-world sizes; the plan's legend had 3.5 m for every tall wall):
lane and compound walls, fences and blast walls 2.2 m above the floor on their higher side (1.2 x a
person); barrack walls 3.2 m under a 0.25 m roof; other buildings 3.0 to 3.5 m; the watchtower 9 m;
vehicles, containers and tanks at their real sizes; the outer wall 4.0 m; hard cover 2.2 m, human cover
1.8 m, jump boxes 1.0 m; raised walkway 1.2 m; basin 1.2 m deep; crouch gaps 1.4 m clear.
The low roof between the barracks is 2.05 m: tools/mount_check.ts measures the highest ledge a player
can mount as 1.16 m from the ground and 2.16 m from a 1.0 m box, so it is reachable only from its
box, and the passage under it is 1.9 m clear (standing room, no jumping).
"""

from mapkit import MapDef
import mapshapes as shapes

MAP = MapDef("drycreek", "Dry Creek")
m = MAP

# ---- heights (stage 1 of the art package: real-world sizes) ----------------------------------------
OUTER_H, OUTER_T = 4.0, 0.5      # the compound's perimeter wall (the map's edge) stays 4.0 m
WALL_H = 2.2                     # lane and compound walls, fences, blast walls: 1.2 x a 1.8 m person
T = 0.25
HT = T / 2
HARD_H = 2.2
HUMAN_H = 1.8
JUMP_H = 1.0
CROUCH_CLEAR = 1.4
DOOR_H = 2.4                     # barrack door lintels (headroom 2.4 m)
BARRACK_H = 3.2                  # barrack walls (eaves)
ROOF_T = 0.25
ROOF_TOP = BARRACK_H + ROOF_T    # 3.45 m: the barrack roofs cover the wall tops; 1.4 m above the low roof
LOW_ROOF_TOP, LOW_ROOF_T = 2.05, 0.15
PASSAGE_CLEAR = LOW_ROOF_TOP - LOW_ROOF_T     # 1.9 m
RAISED_H = 1.2                   # walkway
BASIN = -1.2                     # Site B floor
FENCE_H = RAISED_H + WALL_H      # B east fence: 2.2 m above the walkway (3.4 m above the ground)
GANTRY_UNDER = FENCE_H           # the walkway's roof sits on the fence: 2.2 m headroom, so a jump stays under it
GANTRY_T = 0.2
GARAGE_H, HQ_H, POST_H, HUT_H, SHED_H = 3.5, 3.5, 3.3, 3.0, 3.0
TRAILER_H = 2.9                  # office trailers on blocks
GUARD_HUT_H = 2.8
TOWER_BASE_H, TOWER_H = 3.2, 9.0  # watchtower: a single-storey guard house with the tower on its corner
BUS_H, VAN_H, APV_H, TRUCK_H = 3.0, 2.1, 2.7, 3.2
CONTAINER_H, CONTAINER_W, CONTAINER_40 = 2.6, 2.44, 12.19
TANK_D, TANK_SADDLE = 3.0, 0.3   # horizontal fuel tanks on saddles
DARK_STEEL = (0.22, 0.22, 0.22)
RISE, TREAD = 0.2, 0.4
GROUND_Z0 = -1.6
N = 80.0

# Stage 2: a gritty desert military outpost. Six surface materials (one draw call each, plus the paint decals and
# the sky: 8, the Low budget), all CC0 textures (client/public/maps/CREDITS.md); colour comes from per-box tints.
m.surfaces = ["dc_ground", "dc_concrete", "dc_metal", "dc_paint", "dc_wood", "dc_fabric"]
m.category_surface = {
    "floor": "dc_ground",          # sand and gravel
    "slab": "dc_concrete",         # concrete pads, the basin floor, the passage
    "wood_floor": "dc_wood",       # barrack floors (plywood)
    "basin_stairs": "dc_concrete",
    "outer_wall": "dc_concrete",
    "inner_wall": "dc_concrete",   # T-walls, concrete buildings, the low-roof block
    "barrack_wall": "dc_wood",     # the barracks are plywood huts
    "shed": "dc_metal",            # corrugated sheds: garage, pump hut, generator shed
    "cabin": "dc_paint",           # office trailers and the guard hut
    "crate": "dc_wood",
    "platform": "dc_metal",
    "stairs": "dc_metal",
    "vehicle": "dc_paint",
    "container": "dc_metal",
    "machine": "dc_paint",
    "hesco": "dc_fabric",
    "roof": "dc_metal",
}
# The basin's stairs sit in channels cut into the ground: floors for the walkway-gap check (that check
# compares every solid reaching into walking height above a floor level, and from the basin floor the
# ground's own edges are such solids).
m.floor_categories = {"floor", "basin_stairs", "slab", "wood_floor"}
m.noise_amp = {"dc_ground": 0.2, "dc_concrete": 0.1, "dc_wood": 0.06, "dc_metal": 0.08}
m.wall_surfaces = {"dc_concrete", "dc_wood"}
m.floor_surfaces = {"dc_ground", "dc_concrete"}
m.varied_surfaces = {"dc_wood", "dc_fabric"}
m.paint_surface = "dc_concrete"
m.sun_scale = 0.46
m.sun_warmth = (1.0, 0.9, 0.72)        # a warm desert sun
m.sky_fill_tint = (1.12, 1.0, 0.84)
m.lightmap_size = 4096
m.samples = 1024
m.max_glb_bytes = 3 * 1024 * 1024
# Site boxes are 0.9 m tall: Site B's top (-0.3 m) stays under the rim (0.0 m), so nobody standing on
# the rim, the walkway or the stair landings is inside it, and nobody plants on the 1.0 m jump boxes.
m.site_h = 0.9


def AX(x):
    return x - 40.0


def AY(y):
    return 40.0 - y


def rect(name, category, x0, y0, x1, y1, z0, z1, tint=None, hide=()):
    """A collision box from plan metres (x0..x1 east, y0..y1 south) and heights z0..z1."""
    return m.box(name, category, (AX(min(x0, x1)), AY(max(y0, y1)), z0), (AX(max(x0, x1)), AY(min(y0, y1)), z1),
                 tint=tint, hide=hide)


def vis(name, surface, x0, y0, x1, y1, z0, z1, tint=None):
    return m.visual(name, surface, (AX(min(x0, x1)), AY(max(y0, y1)), z0), (AX(max(x0, x1)), AY(min(y0, y1)), z1),
                    tint)


def hwall(name, y, x0, x1, h=WALL_H, z0=0.0, cat="inner_wall"):
    """A wall along the plan's x axis, centred on plan row y, from x0 to x1."""
    return rect(name, cat, x0, y - HT, x1, y + HT, z0, h)


def vwall(name, x, y0, y1, h=WALL_H, z0=0.0, cat="inner_wall"):
    """A wall along the plan's y axis, centred on plan column x, from y0 to y1."""
    return rect(name, cat, x - HT, y0, x + HT, y1, z0, h)


def solid(name, category, r, h, z0=0.0, tint=None):
    return rect(name, category, r[0], r[1], r[2], r[3], z0, z0 + h, tint=tint)


def subtract(r, hole):
    if hole[0] >= r[2] or hole[2] <= r[0] or hole[1] >= r[3] or hole[3] <= r[1]:
        return [r]
    out = []
    if hole[1] > r[1]:
        out.append((r[0], r[1], r[2], hole[1]))
    if hole[3] < r[3]:
        out.append((r[0], hole[3], r[2], r[3]))
    y0, y1 = max(r[1], hole[1]), min(r[3], hole[3])
    if hole[0] > r[0]:
        out.append((r[0], y0, hole[0], y1))
    if hole[2] < r[2]:
        out.append((hole[2], y0, r[2], y1))
    return out


def fuel_tanks(name, x0, y0, x1, y1):
    """Two horizontal fuel tanks (TANK_D across, on TANK_SADDLE saddles) lying along plan x, side by side over
    y0..y1. Collision follows each tank's round profile in three boxes (the sides lower), down to the ground."""
    import math
    r = TANK_D / 2
    top = TANK_SADDLE + TANK_D
    side = TANK_SADDLE + r + math.sqrt(r * r - (0.75 * r) ** 2)
    for k, c in enumerate((y0 + r, y1 - r)):
        g = "%s_%d" % (name, k + 1)
        m.box(g + "_s", "vehicle", (AX(x0), AY(c + r), 0.0), (AX(x1), AY(c + r / 2), side), tint=(0.8, 0.84, 0.86), group=name)
        m.box(g + "_c", "vehicle", (AX(x0), AY(c + r / 2), 0.0), (AX(x1), AY(c - r / 2), top), tint=(0.8, 0.84, 0.86), group=name)
        m.box(g + "_n", "vehicle", (AX(x0), AY(c - r / 2), 0.0), (AX(x1), AY(c - r), side), tint=(0.8, 0.84, 0.86), group=name)


def pflight(name, cross0, cross1, start, direction, z0, z1, axis, tread=TREAD, category="stairs"):
    """A stair in plan terms: `axis` "x" climbs along plan x (east for direction +1), "y" along plan y
    (SOUTH for direction +1); cross0..cross1 is the plan range across it; `start` is where the first
    step begins. Returns where the upper floor begins, in plan metres."""
    if axis == "x":
        top = m.flight(name, AY(cross1), AY(cross0), AX(start), direction, z0, z1, RISE, tread, axis="x",
                       category=category)
        return top + 40.0
    top = m.flight(name, AX(cross0), AX(cross1), AY(start), -direction, z0, z1, RISE, tread, axis="y",
                   category=category)
    return 40.0 - top


# =================================================================================================
# Outer wall (4.0 m, 0.5 m thick outside the 80 x 80 m plan) and the ground
# =================================================================================================
rect("wall_outer_w", "outer_wall", -OUTER_T, -OUTER_T, 0.0, N + OUTER_T, 0.0, OUTER_H, hide=("bottom", "-x"))
rect("wall_outer_e", "outer_wall", N, -OUTER_T, N + OUTER_T, N + OUTER_T, 0.0, OUTER_H, hide=("bottom", "+x"))
rect("wall_outer_n", "outer_wall", 0.0, -OUTER_T, N, 0.0, 0.0, OUTER_H, hide=("bottom", "+y"))
rect("wall_outer_s", "outer_wall", 0.0, N, N, N + OUTER_T, 0.0, OUTER_H, hide=("bottom", "-y"))

# Site B's basin and the channels its stairs stand in are holes in the ground.
BASIN_R = (60.0, 42.0, 72.0, 58.0)
CH_WEST = (58.0, 47.0, 60.0, 51.0)            # B mid stairs
CH_NORTH = (62.0, 40.0, 66.0, 42.0)           # B north stairs (the plan's "north ramp")
CH_SOUTH = (62.0, 58.0, 66.0, 60.0)           # B south stairs
# DEVIATION: the east stairs are 2.0 m long (five 0.4 m treads of 0.2 m), not the drawn 1.5 m; they
# start 0.625 m inside the basin and end at the stairwell's west wall.
EAST_ST = (71.375, 51.6, 73.375, 53.375)
CH_EAST = (72.0, EAST_ST[1], EAST_ST[2], EAST_ST[3])
HOLES = [BASIN_R, CH_WEST, CH_NORTH, CH_SOUTH, CH_EAST]
# Stage 2: floors that are not sand, cut out of the ground at ground level (no step): plywood in the barracks,
# concrete in the passage, the parade ground, the motor pool and the defender spawn's pad.
SLABS = [("a_n_floor", "wood_floor", (21.0 + HT, 10.0 + HT, 38.0 - HT, 18.0 - HT)),
         ("a_s_floor", "wood_floor", (21.0 + HT, 22.0 + HT, 38.0 - HT, 29.0 - HT)),
         ("a_passage_floor", "slab", (30.0, 18.0 + HT, 34.0, 22.0 - HT)),
         ("m_parade_slab", "slab", (21.0, 38.0, 54.0, 57.0)),
         ("w_motor_pool_slab", "slab", (1.0, 33.5, 17.5, 56.0)),
         ("d_spawn_pad", "slab", (64.0, 0.0, 80.0, 11.0)),
         ("b_apron", "slab", (57.0, 39.0, 75.5 - HT, 61.0))]     # the concrete round Site B's pit
WOOD_FLOOR = (0.52, 0.46, 0.39)
pieces = [(-OUTER_T, -OUTER_T, N + OUTER_T, N + OUTER_T)]
for h in HOLES + [r for _n, _c, r in SLABS]:
    pieces = [p for r in pieces for p in subtract(r, h)]
for k, r in enumerate(pieces):
    rect("ground_%02d" % (k + 1), "floor", r[0], r[1], r[2], r[3], GROUND_Z0, 0.0, hide=("bottom",))
for name, cat, r in SLABS:
    parts = [r]
    for h in HOLES:
        parts = [p for q in parts for p in subtract(q, h)]
    for k, q in enumerate(parts):
        rect(name if len(parts) == 1 else "%s_%d" % (name, k + 1), cat, q[0], q[1], q[2], q[3], GROUND_Z0, 0.0,
             tint=WOOD_FLOOR if cat == "wood_floor" else None, hide=("bottom",))
for k, h in enumerate(HOLES):
    rect("b_basin_floor_%d" % (k + 1), "slab", h[0], h[1], h[2], h[3], GROUND_Z0, BASIN, hide=("bottom",))

# =================================================================================================
# Dividing walls (3.5 m): they make the three lanes; the gaps are the chokes
# =================================================================================================
# west lane | mid. DEVIATION: the drawn wall starts at y 34, leaving an unlabelled 2 m gap at y 32-34
# from the west lane into the strip north of the school bus (a second, unmarked way from the west lane
# to A short); it starts at the A yard's south wall instead. Garage gap (13) y 44-48 as drawn.
vwall("lane_w_mid_n", 18.0, 32.0 + HT, 44.0)
vwall("lane_w_mid_s", 18.0, 48.0, 60.0 - HT)
# mid | south lane, Fuel gap (14) x 26-30. DEVIATION: the drawn wall stops at x 54 and B's west wall
# at y 60, leaving a 2 m gap at x 54-56 into a pocket open to B (an unmarked fifth way into B); the
# pocket is filled solid, closing it.
hwall("lane_mid_s_w", 60.0, 18.0 - HT, 26.0)
hwall("lane_mid_s_e", 60.0, 30.0, 54.0 - HT)
rect("b_sw_corner_block", "inner_wall", 54.0 - HT, 60.0 - HT, 56.0 + HT, 64.0 + HT, 0.0, WALL_H)
# A yard | mid, with A short (12) at x 30-34; mid's north wall on to x 54 (defenders enter mid at 54-56)
hwall("a_yard_s_w", 32.0, 18.0 - HT, 30.0)
hwall("a_yard_s_e", 32.0, 34.0, 54.0)
# A yard west wall; A long (11) enters at y 20-32. DEVIATION (stage 1): its last 5.5 m before A long are tall
# T-walls (3.4 m): at 2.2 m this stretch is a running jump from the low roof (2.75 m across at +0.15 m;
# tools/mount_check.ts), and from it every 2.2 m wall top in the map is a walk or a jump away.
YARD_GATE_H = 3.4
vwall("a_yard_w", 18.0, 4.0, 14.5)
vwall("a_yard_w_gate", 18.0, 14.5, 20.0, YARD_GATE_H)
# A yard | defender side, gap y 14-18; the north strip is closed at x 44
vwall("a_yard_e_n", 44.0, 0.0, 14.0)
vwall("a_yard_e_s", 44.0, 18.0, 32.0 - HT)
# B: west wall with B mid (15) at y 46-50; north wall with B north (17) at x 62-66; south wall with
# B south (16) at x 62-66. The north and south walls run on to the fence (drawn ending 0.5 m short of
# it, a slot).
vwall("b_w_n", 56.0, 36.0 - HT, 46.0)
vwall("b_w_s", 56.0, 50.0, 60.0 - HT)
hwall("b_n_w", 36.0, 56.0 + HT, 62.0)
hwall("b_n_e", 36.0, 66.0, 75.5 - HT)
hwall("b_s_w", 64.0, 56.0 + HT, 62.0)
hwall("b_s_e", 64.0, 66.0, 75.5 - HT)

# =================================================================================================
# Site A: two barracks inside the A yard, the low roof and the covered passage between them
# =================================================================================================
# North barrack (Site A): north wall with crouch gap 6, west door 22 (new in draft 4), east door 5,
# south wall open into the passage at x 30-34 under the low roof.
C6 = (26.0, 27.4)
D22 = (12.5, 15.0)
D5 = (13.0, 15.5)
hwall("a_n_wall_n_w", 10.0, 21.0 - HT, C6[0], BARRACK_H, cat="barrack_wall")
hwall("a_n_wall_n_e", 10.0, C6[1], 38.0 + HT, BARRACK_H, cat="barrack_wall")
hwall("a6_crouch_lintel", 10.0, C6[0], C6[1], BARRACK_H, CROUCH_CLEAR, cat="barrack_wall")
vwall("a_n_wall_w_n", 21.0, 10.0 + HT, D22[0], BARRACK_H, cat="barrack_wall")
vwall("a_n_wall_w_s", 21.0, D22[1], 18.0 - HT, BARRACK_H, cat="barrack_wall")
vwall("a22_west_door_lintel", 21.0, D22[0], D22[1], BARRACK_H, DOOR_H, cat="barrack_wall")
vwall("a_n_wall_e_n", 38.0, 10.0 + HT, D5[0], BARRACK_H, cat="barrack_wall")
vwall("a_n_wall_e_s", 38.0, D5[1], 18.0 - HT, BARRACK_H, cat="barrack_wall")
vwall("a5_east_door_lintel", 38.0, D5[0], D5[1], BARRACK_H, DOOR_H, cat="barrack_wall")
hwall("a_n_wall_s_w", 18.0, 21.0 - HT, 30.0, BARRACK_H, cat="barrack_wall")
hwall("a_n_wall_s_e", 18.0, 34.0, 38.0 + HT, BARRACK_H, cat="barrack_wall")
hwall("a_n_wall_s_over_passage", 18.0, 30.0, 34.0, BARRACK_H, PASSAGE_CLEAR, cat="barrack_wall")
rect("a_n_roof", "roof", 21.0 - HT, 10.0 - HT, 38.0 + HT, 18.0 + HT, BARRACK_H, ROOF_TOP)

# South barrack: west door 7 (from A long), south crouch gap 8 (from A short), north wall open into
# the passage.
D7 = (24.5, 27.5)
C8 = (30.0, 31.4)
hwall("a_s_wall_n_w", 22.0, 21.0 - HT, 30.0, BARRACK_H, cat="barrack_wall")
hwall("a_s_wall_n_e", 22.0, 34.0, 38.0 + HT, BARRACK_H, cat="barrack_wall")
hwall("a_s_wall_n_over_passage", 22.0, 30.0, 34.0, BARRACK_H, PASSAGE_CLEAR, cat="barrack_wall")
vwall("a_s_wall_w_n", 21.0, 22.0 + HT, D7[0], BARRACK_H, cat="barrack_wall")
vwall("a_s_wall_w_s", 21.0, D7[1], 29.0 - HT, BARRACK_H, cat="barrack_wall")
vwall("a7_south_door_lintel", 21.0, D7[0], D7[1], BARRACK_H, DOOR_H, cat="barrack_wall")
hwall("a_s_wall_s_w", 29.0, 21.0 - HT, C8[0], BARRACK_H, cat="barrack_wall")
hwall("a_s_wall_s_e", 29.0, C8[1], 38.0 + HT, BARRACK_H, cat="barrack_wall")
hwall("a8_crouch_lintel", 29.0, C8[0], C8[1], BARRACK_H, CROUCH_CLEAR, cat="barrack_wall")
vwall("a_s_wall_e", 38.0, 22.0 + HT, 29.0 - HT, BARRACK_H, cat="barrack_wall")
rect("a_s_roof", "roof", 21.0 - HT, 22.0 - HT, 38.0 + HT, 29.0 + HT, BARRACK_H, ROOF_TOP)

# Between the barracks: the low roof over a closed block (x 21-30), the covered passage with roof hole
# 10 (x 30-34), and a tall closed room (x 34-38).
BETWEEN = (18.0 + HT, 22.0 - HT)
rect("a_low_roof_block", "inner_wall", 21.0 - HT, BETWEEN[0], 30.0, BETWEEN[1], 0.0, LOW_ROOF_TOP)
H10 = (31.3, 19.3, 32.7, 20.7)
for nm, r in (("w", (30.0, BETWEEN[0], H10[0], BETWEEN[1])), ("e", (H10[2], BETWEEN[0], 34.0, BETWEEN[1])),
              ("n", (H10[0], BETWEEN[0], H10[2], H10[1])), ("s", (H10[0], H10[3], H10[2], BETWEEN[1]))):
    rect("a10_passage_roof_" + nm, "platform", r[0], r[1], r[2], r[3], PASSAGE_CLEAR, LOW_ROOF_TOP)
rect("a_between_room_e", "inner_wall", 34.0, BETWEEN[0], 38.0 + HT, BETWEEN[1], 0.0, ROOF_TOP)
# Box 9 onto the low roof. DEVIATION: drawn 1.5 x 1.5 m standing 0.3 m off the barrack wall (a slot)
# with 1.1 m to the yard wall (a slot); pushed against the block and 1.35 m deep, leaving the 1.4 m
# walkway beside it.
rect("a9_jump_box_to_roof", "crate", 21.0 - HT - 1.35, 19.0, 21.0 - HT, 20.5, 0.0, JUMP_H)

# Site A cover. DEVIATION (all four): drawn 1.1 to 1.4 m off a wall; pushed against it (or into the
# corner) so no gap under 1.4 m is left.
solid("a_console", "machine", (27.0, 12.6, 31.5, 15.0), HARD_H, tint=(0.62, 0.66, 0.7))
solid("a_cover_nw", "crate", (22.55, 10.0 + HT, 24.55, 11.5 + HT), HUMAN_H)
solid("a_cover_se", "crate", (35.875, 16.375, 38.0 - HT, 18.0 - HT), HUMAN_H)
solid("a_s_jump_box", "crate", (24.0, 24.5, 25.5, 26.0), JUMP_H)
solid("a_s_cover_se", "crate", (34.375, 27.375, 38.0 - HT, 29.0 - HT), HUMAN_H)
solid("a_yard_sandbags", "crate", (40.0, 22.0, 42.0, 26.0), HUMAN_H, tint=(0.78, 0.72, 0.58))

# =================================================================================================
# West lane: motor pool
# =================================================================================================
solid("w_garage", "shed", (0.0, 22.0, 12.0, 32.0), GARAGE_H)
# The watchtower: a single-storey guard house on the drawn footprint, the tower (4 x 4 m, 9 m to its roof) on its
# south-east corner. Not climbable: nothing reaches the guard house roof.
solid("w_watchtower", "inner_wall", (0.0, 4.0, 14.0, 14.0), TOWER_BASE_H)
TOWER_CAB_Z = 6.4
for _k, (_lx, _ly) in enumerate(((10.4, 10.4), (13.35, 10.4), (10.4, 13.35), (13.35, 13.35))):
    solid("w_tower_leg_%d" % _k, "machine", (_lx, _ly, _lx + 0.25, _ly + 0.25), TOWER_CAB_Z - TOWER_BASE_H, z0=TOWER_BASE_H)
solid("w_watchtower_tower", "inner_wall", (10.15, 10.15, 13.85, 13.85), TOWER_H - TOWER_CAB_Z, z0=TOWER_CAB_Z)
solid("w_apv", "vehicle", (6.0, 40.0, 9.0, 46.0), APV_H, tint=(0.5, 0.62, 0.52))
# The van: a real van is 2.1 m wide (drawn 3 m), on the drawn centre line.
solid("w_van", "vehicle", (12.45, 50.0, 14.55, 55.0), VAN_H, tint=(0.62, 0.7, 0.8))
solid("w_cover", "crate", (3.0, 56.0, 7.0, 58.0), HUMAN_H)
solid("w_jump_box", "crate", (13.0, 36.0, 14.5, 37.5), JUMP_H)

# =================================================================================================
# Mid: parade ground and command post
# =================================================================================================
solid("m_command_post", "inner_wall", (30.0, 40.0, 44.0, 50.0), POST_H)
solid("m_school_bus", "vehicle", (22.0, 34.5, 34.0, 37.0), BUS_H, tint=(1.0, 0.78, 0.25))
solid("m_trailer_w", "cabin", (46.0, 38.0, 49.0, 48.0), TRAILER_H)
solid("m_trailer_e", "cabin", (50.5, 38.0, 53.5, 48.0), TRAILER_H)
solid("m_jump_box", "crate", (24.0, 52.0, 25.5, 53.5), JUMP_H)
solid("m_cover_e", "crate", (46.0, 52.0, 48.0, 56.0), HUMAN_H)
solid("m_cover_w", "crate", (24.0, 44.0, 26.0, 48.0), HUMAN_H)

# =================================================================================================
# South lane: fuel depot
# =================================================================================================
fuel_tanks("s_fuel_tank_w", 30.0, 66.0, 36.0, 72.0)
fuel_tanks("s_fuel_tank_e", 40.0, 66.0, 46.0, 72.0)
solid("s_cover_w", "crate", (20.0, 64.0, 22.0, 68.0), HUMAN_H)
# DEVIATION (stage 1): 1 m west of the drawn spot. Drawn, its edge was 2.9 m from the 1.8 m crates' corner, a
# running jump away (tools/mount_check.ts), and from the crates' top every 2.2 m wall top is a mount.
solid("s_jump_box", "crate", (48.0, 70.0, 49.5, 71.5), JUMP_H)
solid("s_cover_e", "crate", (52.0, 74.0, 58.0, 76.0), HUMAN_H)
solid("s_pump_hut", "shed", (20.0, 72.0, 26.0, 80.0), HUT_H)
solid("s_generator_shed", "shed", (60.0, 72.0, 70.0, 80.0), SHED_H)

# =================================================================================================
# Site B: the sunken depot, its stairs, the raised walkway and the stairwell down from it
# =================================================================================================
pflight("b_stair_west", CH_WEST[1], CH_WEST[3], 60.0, -1, BASIN, 0.0, "x", category="basin_stairs")
pflight("b_stair_north", CH_NORTH[0], CH_NORTH[2], 42.0, -1, BASIN, 0.0, "y", category="basin_stairs")
pflight("b_stair_south", CH_SOUTH[0], CH_SOUTH[2], 58.0, 1, BASIN, 0.0, "y", category="basin_stairs")
pflight("b_stair_east", EAST_ST[1], EAST_ST[3], EAST_ST[0], 1, BASIN, 0.0, "x", category="basin_stairs")
solid("b_transformer", "machine", (64.0, 48.0, 68.5, 51.5), HARD_H, z0=BASIN, tint=(0.55, 0.6, 0.55))
solid("b_cover", "crate", (61.5, 53.5, 63.5, 55.5), HUMAN_H, z0=BASIN)
solid("b_jump_box", "crate", (69.0, 44.5, 70.5, 46.0), JUMP_H, z0=BASIN)

# The raised walkway (18), 1.2 m, along the east wall from y 34 to 64, with 0.8 m-tread stairs at both
# ends (y 30-34 and 64-68: the drawn end pads).
WALK_X0 = 75.5 + HT
rect("b_walkway", "platform", WALK_X0, 34.0, N, 64.0, 0.0, RAISED_H)
pflight("b_walkway_stair_n", WALK_X0, N, 30.0, 1, 0.0, RAISED_H, "y", tread=0.8)
pflight("b_walkway_stair_s", WALK_X0, N, 68.0, -1, 0.0, RAISED_H, "y", tread=0.8)

# The B east fence and the stairwell (23). DEVIATION (review item 4 and the acceptance check "no line
# of sight from the walkway to any point of the plant zone"): the drawn 6 m opening at y 47-53 looks
# straight down the plank and stairs into the basin. The fence is a solid wall (2.2 m above the walkway,
# under the gantry roof, so a jump does not see over it) with a 1.78 m opening at its south end; behind it
# a closed stairwell (x 73.5-75.5, y 46.5-53.5, the drawn plank's footprint) holds the top landing at
# walkway height, the plank (five 0.2 m steps) down to the ground, and an opening at its north-west corner
# onto the east stairs into the basin. The opening into it and the opening out of it are offset, so no
# straight line passes through both into the plant zone.
SW_W, SW_S, SW_N = 73.5, 46.5, 53.5
FENCE_OPEN = (SW_S + HT, 48.4)
vwall("b_fence_n", 75.5, 30.0, FENCE_OPEN[0], FENCE_H)
vwall("b_fence_s", 75.5, FENCE_OPEN[1], 68.0, FENCE_H)
hwall("b23_stairwell_s", SW_S, SW_W - HT, 75.5 - HT, FENCE_H)
hwall("b23_stairwell_n", SW_N, SW_W - HT, 75.5 - HT, FENCE_H)
vwall("b23_stairwell_w", SW_W, SW_S + HT, EAST_ST[1], FENCE_H)
rect("b23_top_landing", "platform", SW_W + HT, FENCE_OPEN[0], WALK_X0, FENCE_OPEN[1], 0.0, RAISED_H)
PLANK_FOOT = FENCE_OPEN[1] + 5 * TREAD
pflight("b23_plank", SW_W + HT, 75.5 - HT, PLANK_FOOT, -1, 0.0, RAISED_H, "y")
# The gantry canopy. DEVIATION (stage 1): with the fence at 2.2 m above the walkway a jumping player's eye
# (2.79 m above the walkway) clears it and sees down into the plant zone. A corrugated canopy on the fence, 2 m
# wide over the walkway and its stairs, gives 2.2 m of headroom: under it a jump stays under the fence top.
# Farther out a jump clears the canopy, but from there the canopy itself hides the basin: a line over its
# edge and down to any point of the plant zone needs the eye within 77.0 m of plan x (worked out in
# README.md; drycreek.test.ts checks every spot). The rest of the walkway is open sky. The fence runs on
# along the walkway's stairs, and the stairwell is roofed.
GANTRY_X1 = 77.4
rect("b_gantry_roof", "roof", 75.5 - HT, 30.0, GANTRY_X1, 68.0, GANTRY_UNDER, GANTRY_UNDER + GANTRY_T)
rect("b23_stairwell_roof", "roof", SW_W - HT, SW_S - HT, 75.5 - HT, SW_N + HT, GANTRY_UNDER, GANTRY_UNDER + GANTRY_T)

# =================================================================================================
# Defender side
# =================================================================================================
solid("d_hq", "inner_wall", (46.0, 4.0, 60.0, 14.0), HQ_H)
# Two 40 ft ISO containers side by side (12.19 x 4.88 m, 2.6 m high) on the drawn 10 x 6 m footprint's centre.
solid("d_containers", "container", (67.0 - CONTAINER_40 / 2, 21.0 - CONTAINER_W, 67.0 + CONTAINER_40 / 2, 21.0 + CONTAINER_W),
      CONTAINER_H, tint=(0.62, 0.72, 0.64))
solid("d_cover", "crate", (48.0, 22.0, 52.0, 24.0), HUMAN_H)
solid("d_jump_box", "crate", (58.0, 28.0, 59.5, 29.5), JUMP_H)

# =================================================================================================
# Sightline blockers as real objects. DEVIATION (review item: no line over 40 m): draft 4 leaves about
# 72,000 clear eye lines over 40 m between standing or crouched eyes (1.5 m grid). These objects are the
# fewest, out of a list of candidates, that cut every one (a greedy set cover; README.md lists each with
# the lines it cuts). Heights are the objects' own: Hesco bastions 2.2 m, concrete T-walls 2.4 m, IBC
# tanks two high 2.3 m, supply crates 1.8 m, trucks 3.2 m. (T-walls: 2.5 m, like the 8 ft barriers.)
# =================================================================================================
HESCO_H, TWALL_H, IBC_H = 2.2, 2.5, 2.3
ART = {}            # name -> kind, for the art pass (stage 2)


def prop(name, kind, category, r, h, z0=0.0, tint=None):
    ART[name] = kind
    return solid(name, category, r, h, z0=z0, tint=tint)


_blockers = not __import__("os").environ.get("DC_NO_BLOCKERS")
if _blockers:
    # West edge, south of the Garage (the review's 48 m line): a Hesco return from the west wall.
    prop("x_w_wall_return", "hesco", "hesco", (0.0, 56.5, 3.0, 57.5), HESCO_H)
    # The west strip (x 12-18): a cargo truck parked across the lane from the mid wall (1.5 m short of the
    # APV), and a row of T-walls north of the ghost spawn.
    prop("x_w_truck", "truck", "vehicle", (10.5, 38.9, 18.0 - HT, 41.4), TRUCK_H, tint=(0.55, 0.6, 0.5))
    prop("x_w_spawn_screen", "twall", "inner_wall", (5.5, 62.0, 14.0, 62.6), TWALL_H)
    # The north strip (y 0-4, x 0-44): a Hesco return from the north wall.
    prop("x_n_pillar", "hesco", "hesco", (22.0, 0.0, 23.5, 5.5), HESCO_H)
    # A east door: a Hesco blast wall in front of it in the yard (the defender side looked through the yard
    # gap and the door across Site A, 57 m).
    prop("x_a_blast_wall", "hesco", "hesco", (40.5, 12.0, 42.4, 16.5), HESCO_H)
    # Mid north (y 32-38, from the defender side to the west lane): a Hesco L against mid's north wall.
    prop("x_m_north_block", "hesco", "hesco", (43.5, 32.0 + HT, 45.5, 36.6), HESCO_H)
    prop("x_m_north_post", "hesco", "hesco", (40.5, 36.6, 43.5, 38.0), HESCO_H)
    # Mid's north-west pocket (x 18-22, y 32-45): a cargo truck parked along the lane wall (the low roof
    # looked down the lane wall's mid side, over the garage gap, to the ghost spawn, 60 m).
    prop("x_m_nw_truck", "truck", "vehicle", (18.0 + HT, 35.6, 20.5, 43.0), TRUCK_H, tint=(0.5, 0.55, 0.45))
    # B mid: a T-wall row west of the gap, against the east trailer (lines from the ghost spawn ran through
    # the fuel gap, B mid and over the basin, 79 m).
    prop("x_b_mid_blast_wall", "twall", "inner_wall", (53.5, 47.0, 54.1, 52.5), TWALL_H)
    # B north: a T-wall row inside the gap (lines ran from the containers through both B gaps, 48 m).
    prop("x_b_north_blast_wall", "twall", "inner_wall", (59.0, 37.6, 66.5, 38.2), TWALL_H)
    # The walkway and the east edge (x 72-80): a guard hut before the walkway's north stairs, and two stacks
    # of supply crates on the walkway, offset so no line runs its length.
    prop("x_e_guard_hut", "guard_hut", "cabin", (73.4, 25.4, N, 28.4), GUARD_HUT_H)
    prop("x_e_walkway_crate_n", "crates", "crate", (77.2, 44.0, N, 46.0), HUMAN_H, z0=RAISED_H)
    prop("x_e_walkway_crate_s", "crates", "crate", (WALK_X0, 54.0, 78.4, 56.0), HUMAN_H, z0=RAISED_H)
    # The south lane (y 60-66, from the ghost spawn to the east wall): Hesco blocks against mid's south wall
    # and against the east fuel tanks.
    prop("x_s_block_w", "hesco", "hesco", (36.0, 60.0 + HT, 40.0, 64.6), HESCO_H)
    prop("x_s_block_e", "hesco", "hesco", (46.0, 62.6, 48.0, 66.0), HESCO_H)
    # The back alley behind the fuel tanks (y 72-80) and its diagonals to the walkway: a Hesco wall from the
    # south wall between the tanks, a fuel tanker between the east tanks and B's south wall, and IBC tanks.
    prop("x_s_alley_wall", "hesco", "hesco", (39.5, 74.0, 40.5, N), HESCO_H)
    prop("x_s_tanker", "tanker", "vehicle", (50.0, 65.6, 58.0, 68.1), TRUCK_H, tint=(0.8, 0.82, 0.78))
    prop("x_s_alley_block", "ibc", "crate", (43.0, 72.0, 44.5, 73.5), IBC_H)
    prop("x_s_shed_block", "ibc", "crate", (58.5, 70.5, 60.0, 72.0), IBC_H)
    # The ghost spawn's east exit: a Hesco post east of the T-walls.
    prop("x_s_spawn_pillar", "hesco", "hesco", (17.5, 62.0, 18.5, 65.0), HESCO_H)
    # The fuel gap (14) and the garage gap (13): a T-wall row on the mid side of each (lines ran from the
    # ghost spawn through them across mid, up to 56 m).
    prop("x_m_fuel_blast_wall", "twall", "inner_wall", (25.5, 57.4, 30.5, 58.0), TWALL_H)
    prop("x_m_garage_blast_wall", "twall", "inner_wall", (20.2, 43.0, 20.8, 49.0), TWALL_H)
    # Mid's south side, along the wall from the fuel gap: a Hesco post against the wall.
    prop("x_m_south_post", "hesco", "hesco", (38.0, 57.0, 39.5, 60.0 - HT), HESCO_H)
    # The west lane under the Garage (lines across the A long opening into the yard's south strip): crates.
    prop("x_w_garage_pile", "crates", "crate", (0.0, 32.0, 3.0, 33.5), HUMAN_H)
    # The ghost spawn's east exit, south of the drawn cover: an annex on the pump hut.
    prop("x_s_pump_annex", "hut", "shed", (22.0, 70.0, 26.0, 72.0), HUT_H)
    # Defender side, from the spawn south-west toward mid: a Hesco barrier between the cover and the
    # containers, and IBC tanks.
    prop("x_d_barrier", "hesco", "hesco", (53.5, 22.5, 56.5, 23.5), HESCO_H)
    prop("x_d_post_w", "ibc", "crate", (46.5, 16.0, 48.0, 17.5), IBC_H)
    prop("x_d_post_e", "ibc", "crate", (58.4, 20.5, 59.4, 23.5), IBC_H)
    prop("x_d_post_s", "ibc", "crate", (46.5, 20.5, 48.0, 22.0), IBC_H)
    # A truck parked in the pocket north of mid's north wall: the defender side's jump box (eye 2.62 m)
    # looked over the yard's east wall, down the yard's south strip and out of A long (54 m).
    prop("x_d_truck", "truck", "vehicle", (46.0, 27.9, 53.4, 30.4), TRUCK_H, tint=(0.52, 0.56, 0.47))
# The room between the barracks carries a water tank on its roof: from the passage roof (eye 3.67 m) the
# room's roof (3.45 m) let a line pass east over the yard to the walkway stairs (48 m).
prop("a_rooftop_tank", "water_tank", "vehicle", (34.2, 18.3, 37.9, 21.7), 1.15, z0=ROOF_TOP)

# =================================================================================================
# Allowed low ceilings
# =================================================================================================


def low(name, x0, y0, x1, y1, clearance, crouch):
    m.low_ceiling(name, (AX(x0), AY(y1), -0.01), (AX(x1), AY(y0), 0.01), clearance, crouch=crouch)


low("a6_crouch_gap", C6[0] - 0.4, 10.0 - 0.6, C6[1] + 0.4, 10.0 + 0.6, CROUCH_CLEAR, True)
low("a8_crouch_gap", C8[0] - 0.4, 29.0 - 0.6, C8[1] + 0.4, 29.0 + 0.6, CROUCH_CLEAR, True)
low("a_passage_under_low_roof", 30.0 - 0.3, 18.0 - 0.6, 34.0 + 0.3, 22.0 + 0.6, PASSAGE_CLEAR, False)

# =================================================================================================
# Gameplay: spawns, sites, checks
# =================================================================================================
for x in (5.0, 6.5, 8.0, 9.5, 11.0):
    m.spawn("ghosts", AX(x), AY(74.0), 0.0, -45.0)
for x in (69.0, 70.5, 72.0, 73.5, 75.0):
    m.spawn("defenders", AX(x), AY(6.0), 0.0, 135.0)
SITE_A = (22.5, 11.0, 37.0, 17.5)
SITE_B = (62.5, 44.5, 69.5, 55.5)           # 2.5 m in from every rim of the basin
m.site("A", (AX(SITE_A[0]), AY(SITE_A[3])), (AX(SITE_A[2]), AY(SITE_A[1])), 0.0)
m.site("B", (AX(SITE_B[0]), AY(SITE_B[3])), (AX(SITE_B[2]), AY(SITE_B[1])), BASIN)
m.max_sightline = 40.0
m.sightline_crouched = True
m.jump_peek_report = True
m.strict_spawn_sight = True
m.allowed_tops = ["*jump*", "a_low_roof_block", "*sandbags_door*"]


def gate(x0, y0, x1, y1, z0, z1):
    return (AX(x0), AY(y1), z0, AX(x1), AY(y0), z1)


# Distinct ways into each site, proven by the verifier: each gate alone connects the ghost spawn to the
# site, and with every gate closed the site cannot be reached.
m.route_gates = {
    "A": [("A long: south barrack door 7", gate(20.5, D7[0], 21.5, D7[1], -0.1, 0.1)),
          ("west door 22", gate(20.5, D22[0], 21.5, D22[1], -0.1, 0.1)),
          ("A short: south crouch gap 8", gate(C8[0], 28.5, C8[1], 29.5, -0.1, 0.1)),
          ("box 9, low roof, roof hole 10", gate(21.0 - HT, BETWEEN[0], 34.0, BETWEEN[1], LOW_ROOF_TOP - 0.05,
                                                 LOW_ROOF_TOP + 0.05)),
          ("north crouch gap 6 (watchtower flank)", gate(C6[0], 9.5, C6[1], 10.5, -0.1, 0.1)),
          ("east door 5 (round the yard)", gate(37.5, D5[0], 38.5, D5[1], -0.1, 0.1))],
    "B": [("B mid (15)", gate(55.5, 46.0, 56.5, 50.0, -0.1, 0.1)),
          ("B south (16)", gate(62.0, 63.5, 66.0, 64.5, -0.1, 0.1)),
          ("B north (17)", gate(62.0, 35.5, 66.0, 36.5, -0.1, 0.1)),
          ("walkway, stairwell 23 and plank", gate(SW_W + HT, SW_S + HT, 75.5 - HT, SW_N - HT, -0.1, RAISED_H + 0.1))],
}

# =================================================================================================
# Paint: site markings and letters (Test Map 1's style)
# =================================================================================================
PAINT = {
    "A": dict(line=(0.95, 0.10, 0.07), fill=(0.62, 0.44, 0.42)),
    "B": dict(line=(0.09, 0.27, 1.0), fill=(0.42, 0.48, 0.66)),
}
LINE_W = 0.25
for name, (x0, y0), (x1, y1), z in m.sites:
    p = PAINT[name]
    m.floor_rect(x0, y0, x1, y1, z, p["fill"], layer=0)
    m.floor_rect(x0, y0, x1, y0 + LINE_W, z, p["line"])
    m.floor_rect(x0, y1 - LINE_W, x1, y1, z, p["line"])
    m.floor_rect(x0, y0 + LINE_W, x0 + LINE_W, y1 - LINE_W, z, p["line"])
    m.floor_rect(x1 - LINE_W, y0 + LINE_W, x1, y1 - LINE_W, z, p["line"])
    m.hazard_band(x0 + LINE_W, y0 + LINE_W, x1 - LINE_W, y1 - LINE_W, z, p["line"], width=0.3, stripe=0.22, gap=0.3)
m.floor_text("A", (AX(33.5), AY(14.0)), 0.0, 2.0, PAINT["A"]["line"], up=(0, 1), stroke=0.2)
m.floor_text("B", (AX(66.0), AY(46.2)), BASIN, 1.8, PAINT["B"]["line"], up=(0, 1), stroke=0.2)
SIGN = (0.84, 0.82, 0.76)
# wall signs: (letter, plan x, plan y, axis, sign) on the outside faces of the walls players come in by
for letter, px, py, axis, sign in (("A", 21.0 - HT, 17.0, 0, -1),     # barrack west wall, south of door 22
                                   ("A", 38.0 + HT, 11.6, 0, 1),      # barrack east wall, north of door 5
                                   ("A", 28.4, 29.0 + HT, 1, -1),     # south barrack, beside crouch gap 8
                                   ("B", 56.0 - HT, 52.5, 0, -1),     # B west wall, south of B mid
                                   ("B", 68.5, 64.0 + HT, 1, -1),     # B south wall, east of B south
                                   ("B", 68.5, 36.0 - HT, 1, 1)):     # B north wall, east of B north
    centre = (AX(px), AY(py), 1.2)
    m.wall_rect(centre, axis, sign, 1.5, 1.8, SIGN, layer=0)
    m.wall_text(letter, centre, axis, sign, 1.4, PAINT[letter]["line"], stroke=0.2)

# Stairs: alternating tread tint and a yellow nosing on every step, as on Test Map 1
YELLOW = (0.95, 0.72, 0.05)
by_name = {b["name"]: b for b in m.boxes}
for fl in m.flights:
    for k, nm in enumerate(fl["steps"]):
        b = by_name[nm]
        b["tint"] = (1.0, 1.0, 1.0) if k % 2 else (0.8, 0.8, 0.82)
        (bx0, by0, _bz0), (bx1, by1, top) = b["mn"], b["mx"]
        # the nosing is the step's edge toward the bottom of the flight
        steps = [by_name[n] for n in fl["steps"]]
        if fl["axis"] == "y":
            down = steps[0]["mn"][1] < steps[-1]["mn"][1]          # climbs toward +Y: nosing at -Y
            if down:
                m.floor_rect(bx0 + 0.05, by0, bx1 - 0.05, by0 + 0.08, top, YELLOW)
            else:
                m.floor_rect(bx0 + 0.05, by1 - 0.08, bx1 - 0.05, by1, top, YELLOW)
        else:
            if steps[0]["mn"][0] < steps[-1]["mn"][0]:              # climbs toward +X: nosing at -X
                m.floor_rect(bx0, by0 + 0.05, bx0 + 0.08, by1 - 0.05, top, YELLOW)
            else:
                m.floor_rect(bx1 - 0.08, by0 + 0.05, bx1, by1 - 0.05, top, YELLOW)


def yellow_edge(x0, y0, x1, y1, z):
    m.floor_rect(AX(x0), AY(y1), AX(x1), AY(y0), z, YELLOW)


# drops marked yellow: the roof hole's edges, the low roof's west edge over box 9
yellow_edge(H10[0] - 0.1, H10[1], H10[0], H10[3], LOW_ROOF_TOP)
yellow_edge(H10[2], H10[1], H10[2] + 0.1, H10[3], LOW_ROOF_TOP)
yellow_edge(H10[0], H10[1] - 0.1, H10[2], H10[1], LOW_ROOF_TOP)
yellow_edge(H10[0], H10[3], H10[2], H10[3] + 0.1, LOW_ROOF_TOP)
yellow_edge(21.0 - HT, BETWEEN[0] + 0.05, 21.0 - HT + 0.1, BETWEEN[1] - 0.05, LOW_ROOF_TOP)

# oil stains on the concrete pads and the sand (plan metres: centre, size)
STAIN = (0.26, 0.24, 0.21)
for cx, cy, sx, sy in ((9.0, 48.0, 1.4, 0.9), (37.0, 55.0, 1.0, 1.3), (60.0, 30.0, 1.2, 1.1), (28.0, 63.0, 1.5, 0.8),
                       (50.0, 18.0, 1.0, 0.9), (15.0, 40.0, 0.9, 0.7), (40.0, 76.0, 1.1, 0.8), (70.0, 68.0, 0.8, 0.6),
                       (7.5, 37.5, 1.6, 1.1), (13.5, 57.0, 1.2, 0.9), (52.0, 26.0, 1.3, 0.8), (27.0, 41.0, 0.9, 0.9)):
    m.floor_rect(AX(cx - sx / 2), AY(cy + sy / 2), AX(cx + sx / 2), AY(cy - sy / 2), 0.0, STAIN, layer=0)

# =================================================================================================
# Art (stage 2): the models. Every model fills its object's collision box (hidden, so only the model shows)
# or sits above head height; the checker proves no visual box reaches into the space players stand in.
# Helpers are map-independent (tools/blender/mapshapes.py); this part only says what goes where.
# =================================================================================================
S = {"ground": "dc_ground", "concrete": "dc_concrete", "metal": "dc_metal", "paint": "dc_paint", "wood": "dc_wood",
     "fabric": "dc_fabric", "canvas": (0.6, 0.54, 0.4), "hesco": (0.74, 0.67, 0.52)}
by_name = {b["name"]: b for b in m.boxes}


def model_box(name):
    """The collision box of `name`, hidden from drawing: its model replaces it."""
    b = by_name[name]
    b["hide"] = ("all",)
    return b["mn"], b["mx"]


def AB(x0, y0, x1, y1, z0, z1):
    return (AX(min(x0, x1)), AY(max(y0, y1)), z0), (AX(max(x0, x1)), AY(min(y0, y1)), z1)


OLIVE, TAN, SAND_TAN = (0.42, 0.44, 0.32), (0.6, 0.53, 0.38), (0.66, 0.58, 0.42)
# ---- vehicles -------------------------------------------------------------------------------------
shapes.vehicle(m, "m_school_bus_v", *model_box("m_school_bus"), "bus", S, (0.86, 0.6, 0.14))
shapes.vehicle(m, "w_apv_v", *model_box("w_apv"), "apv", S, TAN)
shapes.vehicle(m, "w_van_v", *model_box("w_van"), "van", S, (0.84, 0.84, 0.8), flip=True)
if _blockers:
    shapes.vehicle(m, "x_w_truck_v", *model_box("x_w_truck"), "truck", S, OLIVE, flip=True)
    shapes.vehicle(m, "x_m_nw_truck_v", *model_box("x_m_nw_truck"), "truck", S, SAND_TAN)
    shapes.vehicle(m, "x_d_truck_v", *model_box("x_d_truck"), "truck", S, OLIVE)
    shapes.vehicle(m, "x_s_tanker_v", *model_box("x_s_tanker"), "tanker", S, (0.84, 0.84, 0.82))

# ---- containers (two 40 ft boxes in one collision box) ---------------------------------------------
_mn, _mx = model_box("d_containers")
_ym = (_mn[1] + _mx[1]) / 2
shapes.container(m, "d_cont_n", (_mn[0], _ym, _mn[2]), _mx, S, (0.55, 0.23, 0.15))
shapes.container(m, "d_cont_s", _mn, (_mx[0], _ym, _mx[2]), S, (0.27, 0.37, 0.48))

# ---- fuel tanks: horizontal tanks on concrete saddles, a decorative ladder and valves ---------------
for tank, (tx0, ty0, tx1, ty1) in (("s_fuel_tank_w", (30.0, 66.0, 36.0, 72.0)), ("s_fuel_tank_e", (40.0, 66.0, 46.0, 72.0))):
    r = TANK_D / 2
    for k, cy in enumerate((ty0 + r, ty1 - r)):
        g = "%s_%d" % (tank, k + 1)
        for part in ("_s", "_c", "_n"):
            model_box(g + part)
        shapes.cylinder(m, g + "_body", "dc_paint", (AX((tx0 + tx1) / 2), AY(cy), TANK_SADDLE + r), r - 0.02,
                        (tx1 - tx0) - 0.3, "x", 14, (0.86, 0.86, 0.83))
        for u in (tx0 + 0.9, tx1 - 1.3):
            vis(g + "_saddle_%d" % int(u), "dc_concrete", u, cy - 1.15, u + 0.4, cy + 1.15, 0.0, 0.85, (0.9, 0.88, 0.82))
        # ladder on the east end: two rails and rungs, inside the tank's collision
        for dv in (-0.25, 0.25):
            vis(g + "_rail%+.0f" % (dv * 4), "dc_paint", tx1 - 0.12, cy + dv - 0.03, tx1 - 0.06, cy + dv + 0.03, 0.3,
                TANK_SADDLE + TANK_D - 0.05, (0.3, 0.3, 0.3))
        for j in range(9):
            z = 0.55 + j * 0.3
            vis(g + "_rung%d" % j, "dc_paint", tx1 - 0.12, cy - 0.25, tx1 - 0.08, cy + 0.25, z, z + 0.04, (0.3, 0.3, 0.3))
        vis(g + "_valve", "dc_paint", tx0 + 0.02, cy - 0.2, tx0 + 0.15, cy + 0.2, 0.45, 0.8, (0.55, 0.12, 0.08))

# ---- sightline objects: Hesco, T-walls, IBC tanks, crates --------------------------------------------
for name, kind in sorted(ART.items()):
    if name not in by_name:
        continue
    if kind == "hesco":
        shapes.hesco(m, name + "_m", *model_box(name), S)
    elif kind == "twall":
        shapes.twall_row(m, name + "_m", *model_box(name), S)
    elif kind == "ibc":
        shapes.ibc_stack(m, name + "_m", *model_box(name), S)
    elif kind == "crates":
        shapes.crate_stack(m, name + "_m", *model_box(name), S)

# ---- cover, jump boxes, sandbag walls --------------------------------------------------------------
for name in ("a_cover_nw", "a_cover_se", "a_s_cover_se", "m_cover_w", "m_cover_e", "d_cover", "s_cover_e", "b_cover"):
    shapes.crate_stack(m, name + "_m", *model_box(name), S, levels=2)
for name in ("a9_jump_box_to_roof", "a_s_jump_box", "w_jump_box", "m_jump_box", "s_jump_box", "d_jump_box", "b_jump_box"):
    shapes.crate_stack(m, name + "_m", *model_box(name), S, levels=1, tint=(0.95, 0.9, 0.8))
for name in ("a_yard_sandbags", "w_cover", "s_cover_w"):
    shapes.sandbag_wall(m, name + "_m", *model_box(name), S)

# ---- the room between the barracks: its water tank on a steel stand --------------------------------
_mn, _mx = model_box("a_rooftop_tank")
_c = ((_mn[0] + _mx[0]) / 2, (_mn[1] + _mx[1]) / 2)
for sx in (-1, 1):
    for sy in (-1, 1):
        m.visual("a_tank_leg_%d%d" % (sx + 1, sy + 1), "dc_paint", (_c[0] + sx * 1.25 - 0.06, _c[1] + sy * 1.25 - 0.06, ROOF_TOP),
                 (_c[0] + sx * 1.25 + 0.06, _c[1] + sy * 1.25 + 0.06, ROOF_TOP + 0.25), DARK_STEEL)
m.visual("a_tank_deck", "dc_paint", (_c[0] - 1.45, _c[1] - 1.45, ROOF_TOP + 0.25), (_c[0] + 1.45, _c[1] + 1.45, ROOF_TOP + 0.3),
         DARK_STEEL)
shapes.cylinder(m, "a_tank_body", "dc_paint", (_c[0], _c[1], (ROOF_TOP + 0.3 + _mx[2]) / 2), 1.6, _mx[2] - ROOF_TOP - 0.32,
                "z", 14, (0.24, 0.27, 0.23))

# ---- Site B transformer: tank, cooling fins, insulators, conservator ------------------------------
_mn, _mx = model_box("b_transformer")
F = shapes.Frame(m, "b_transformer_m", _mn, _mx)
TR_COL = (0.4, 0.45, 0.4)
F.box("dc_paint", 0.0, F.L, 0.0, F.W, 0.0, 0.18, DARK_STEEL)                                 # skid
F.box("dc_paint", 0.3, F.L - 0.3, 0.3, F.W - 0.3, 0.18, F.H - 0.05, TR_COL)                   # tank
F.box("dc_paint", 0.25, F.L - 0.25, 0.25, F.W - 0.25, F.H - 0.05, F.H, tuple(c * 0.85 for c in TR_COL), 0.5)
for k in range(int((F.L - 0.8) / 0.22)):                                                    # fins, both long sides
    u = 0.4 + k * 0.22
    F.box("dc_paint", u, u + 0.05, 0.0, 0.3, 0.35, F.H - 0.35, tuple(c * 0.92 for c in TR_COL), 0.15)
    F.box("dc_paint", u, u + 0.05, F.W - 0.3, F.W, 0.35, F.H - 0.35, tuple(c * 0.92 for c in TR_COL), 0.15)
for j in range(3):                                                                          # HV bushings
    F.cyl("dc_paint", 1.0 + j * 1.2, F.W * 0.35, F.H + 0.35, 0.09, 0.7, "z", 8, (0.45, 0.22, 0.12), 0.3)
    F.cyl("dc_paint", 1.2 + j * 1.0, F.W * 0.72, F.H + 0.2, 0.06, 0.4, "z", 8, (0.45, 0.22, 0.12), 0.3)
F.cyl("dc_paint", F.L / 2, F.W * 0.5, F.H + 0.45, 0.28, F.L * 0.45, "u", 10, TR_COL, 0.4)    # conservator
for u in (F.L * 0.3, F.L * 0.7):
    F.box("dc_paint", u - 0.05, u + 0.05, F.W * 0.5 - 0.05, F.W * 0.5 + 0.05, F.H, F.H + 0.2, DARK_STEEL, 0.2)
m.wall_rect((AX(64.0 + 0.3), AY(49.75), BASIN + 1.25), 0, -1, 0.7, 0.6, (0.95, 0.75, 0.05), layer=0)  # warning plate
m.wall_text("4", (AX(64.0 + 0.3), AY(49.75), BASIN + 1.25), 0, -1, 0.35, (0.05, 0.05, 0.05), stroke=0.12)

# ---- Site A console: a bank of radio and control racks --------------------------------------------
_mn, _mx = model_box("a_console")
F = shapes.Frame(m, "a_console_m", _mn, _mx)
RACK = (0.34, 0.38, 0.33)
n = 4
for k in range(n):
    u0, u1 = k * F.L / n + 0.015, (k + 1) * F.L / n - 0.015
    F.box("dc_paint", u0, u1, 0.0, F.W, 0.0, F.H - 0.02, RACK)                                   # cabinet
    for v0, v1 in ((0.0, 0.02), (F.W - 0.02, F.W)):
        pass
    F.box("dc_paint", u0 + 0.12, u1 - 0.12, -0.0, 0.0 + 0.012, 1.1, 1.6, (0.08, 0.1, 0.09), 0.3)
    if k:
        F.box("dc_paint", k * F.L / n - 0.015, k * F.L / n + 0.015, 0.05, F.W - 0.05, 0.0, F.H - 0.05, (0.15, 0.15, 0.15), 0.1)
F.box("dc_paint", 0.2, F.L - 0.2, 0.25, F.W - 0.25, F.H - 0.02, F.H, tuple(c * 0.85 for c in RACK), 0.3)
# the faces: screens, switch rows and vents painted on (decals stay on the cabinet faces)
for side in (1, -1):
    for k in range(n):
        uc = (k + 0.5) * F.L / n
        ycoord = _mn[1] if side < 0 else _mx[1]
        cx = _mn[0] + uc
        m.wall_rect((cx, ycoord, 1.45), 1, side, 0.75, 0.42, (0.05, 0.12, 0.09), layer=0)       # screen
        m.wall_rect((cx, ycoord, 1.45), 1, side, 0.68, 0.35, (0.1, 0.32, 0.22), layer=1)
        m.wall_rect((cx, ycoord, 0.95), 1, side, 0.8, 0.16, (0.12, 0.12, 0.12), layer=0)       # switch row
        for j in range(5):
            m.wall_rect((cx - 0.3 + j * 0.15, ycoord, 0.95), 1, side, 0.05, 0.05,
                        ((0.9, 0.2, 0.1), (0.95, 0.75, 0.1), (0.2, 0.8, 0.3), (0.9, 0.9, 0.85), (0.95, 0.75, 0.1))[j], layer=1)
        m.wall_rect((cx, ycoord, 0.4), 1, side, 0.8, 0.35, (0.2, 0.22, 0.2), layer=0)          # vent
        m.wall_rect((cx, ycoord, 1.95), 1, side, 0.8, 0.22, (0.22, 0.24, 0.22), layer=0)       # radio set

# ---- the watchtower: tower legs, the lookout cabin, its roof; the guard house below ----------------
for _nm in ["w_tower_leg_%d" % k for k in range(4)] + ["w_watchtower_tower"]:
    model_box(_nm)
F = shapes.Frame(m, "w_tower_m", *AB(10.0, 10.0, 14.0, 14.0, TOWER_BASE_H, TOWER_H))
F.box("dc_wood", 0.15, 3.85, 0.15, 3.85, TOWER_CAB_Z - TOWER_BASE_H, TOWER_CAB_Z - TOWER_BASE_H + 0.15, (0.85, 0.8, 0.7))
for u0, u1, v0, v1 in ((0.15, 0.95, 0.15, 3.85), (3.05, 3.85, 0.15, 3.85), (0.95, 3.05, 0.15, 0.95), (0.95, 3.05, 3.05, 3.85)):
    F.box("dc_wood", u0, u1, v0, v1, TOWER_CAB_Z - TOWER_BASE_H + 0.15, TOWER_CAB_Z - TOWER_BASE_H + 1.1, (0.85, 0.8, 0.7))
F.box("dc_paint", 0.95, 3.05, 0.95, 3.05, TOWER_CAB_Z - TOWER_BASE_H + 0.15, TOWER_CAB_Z - TOWER_BASE_H + 1.1, (0.08, 0.09, 0.1), 0.3)
for u0, v0 in ((0.15, 0.15), (3.65, 0.15), (0.15, 3.65), (3.65, 3.65)):
    F.box("dc_paint", u0, u0 + 0.2, v0, v0 + 0.2, TOWER_CAB_Z - TOWER_BASE_H + 1.1, TOWER_H - TOWER_BASE_H - 0.35, DARK_STEEL, 0.3)
F.box("dc_metal", -0.3, 4.3, -0.3, 4.3, TOWER_H - TOWER_BASE_H - 0.35, TOWER_H - TOWER_BASE_H - 0.25, (0.75, 0.74, 0.7), 0.5)
F.box("dc_metal", 0.4, 3.6, 0.4, 3.6, TOWER_H - TOWER_BASE_H - 0.25, TOWER_H - TOWER_BASE_H, (0.7, 0.69, 0.66), 0.4)
for u0, v0 in ((0.4, 0.4), (3.35, 0.4), (0.4, 3.35), (3.35, 3.35)):
    F.box("dc_paint", u0, u0 + 0.25, v0, v0 + 0.25, 0.0, TOWER_CAB_Z - TOWER_BASE_H, DARK_STEEL, 0.4)
for k in range(3):                                                                          # leg braces
    z = 0.5 + k * 0.9
    F.box("dc_paint", 0.4, 3.6, 0.45, 0.6, z, z + 0.08, DARK_STEEL, 0.2)
    F.box("dc_paint", 0.4, 3.6, 3.4, 3.55, z, z + 0.08, DARK_STEEL, 0.2)
shapes.flat_roof(m, "w_guardhouse_roof", *AB(0.0, 4.0, 14.0, 14.0, TOWER_BASE_H, TOWER_BASE_H + 0.06), S, overhang=0.2)

# ---- roofs and fronts of the buildings ------------------------------------------------------------
# Barracks: plywood huts under corrugated gable roofs. No overhang toward the low roof and the passage roof
# (y 18 and 22): a player standing up there must not have a sheet in their head.
shapes.gable_roof(m, "a_n_roofsheet", *AB(21.0 - HT, 10.0 - HT, 38.0 + HT, 18.0 + HT, ROOF_TOP, ROOF_TOP + 0.9), S,
                  0.9, ov=(0.35, 0.35, 0.35, -0.08), tint=(0.72, 0.7, 0.66))
shapes.gable_roof(m, "a_s_roofsheet", *AB(21.0 - HT, 22.0 - HT, 38.0 + HT, 29.0 + HT, ROOF_TOP, ROOF_TOP + 0.9), S,
                  0.9, ov=(0.35, 0.35, -0.08, 0.35), tint=(0.72, 0.7, 0.66))
for nm in ("a_n_roof", "a_s_roof"):
    by_name[nm]["hide"] = ("top",)
for nm, (x0, y0, x1, y1), h, ov, par in (("w_garage", (0.0, 22.0, 12.0, 32.0), GARAGE_H, 0.3, 0.0),
                                        ("s_pump_hut", (20.0, 72.0, 26.0, 80.0), HUT_H, 0.25, 0.0),
                                        ("x_s_pump_annex", (22.0, 70.0, 26.0, 72.0), HUT_H, 0.25, 0.0),
                                        ("s_generator_shed", (60.0, 72.0, 70.0, 80.0), SHED_H, 0.3, 0.0),
                                        ("x_e_guard_hut", (73.4, 25.4, N, 28.4), GUARD_HUT_H, 0.2, 0.0),
                                        ("m_trailer_w", (46.0, 38.0, 49.0, 48.0), TRAILER_H, 0.08, 0.0),
                                        ("m_trailer_e", (50.5, 38.0, 53.5, 48.0), TRAILER_H, 0.08, 0.0),
                                        ("d_hq", (46.0, 4.0, 60.0, 14.0), HQ_H, 0.0, 0.45),
                                        ("m_command_post", (30.0, 40.0, 44.0, 50.0), POST_H, 0.0, 0.5)):
    if nm not in by_name:
        continue
    by_name[nm]["hide"] = tuple(set(by_name[nm]["hide"]) | {"top"}) if ov else by_name[nm]["hide"]
    shapes.flat_roof(m, nm + "_rf", *AB(x0, y0, min(x1, N), y1, h, h + 0.06), S, overhang=ov, parapet=par,
                     tint=(0.74, 0.72, 0.68))

# ---- painted detail: wall panels, windows, doors -----------------------------------------------
JOINT = (0.36, 0.35, 0.33)


def face_paint(x0, y0, x1, y1, axis, sign, z0, z1, colour, layer=0):
    """A painted rectangle on a wall face given in plan metres: axis 0 = a face at plan x (x0 == x1), 1 = at plan y."""
    if axis == 0:
        centre = (AX(x0), AY((y0 + y1) / 2), (z0 + z1) / 2)
        m.wall_rect(centre, 0, sign, abs(y1 - y0), z1 - z0, colour, layer)
    else:
        centre = (AX((x0 + x1) / 2), AY(y0), (z0 + z1) / 2)
        m.wall_rect(centre, 1, sign, abs(x1 - x0), z1 - z0, colour, layer)


# Lane walls are concrete T-wall panels: a joint every 1.25 m on both faces and a capping strip.
for b in list(m.boxes):
    if b["category"] != "inner_wall" or "all" in b["hide"]:
        continue
    (x0, y0, z0), (x1, y1, z1) = b["mn"], b["mx"]
    thin = min(x1 - x0, y1 - y0)
    if thin > 0.3 or z0 > 0.01 or z1 not in (WALL_H, YARD_GATE_H, FENCE_H):
        continue
    along = 0 if x1 - x0 > y1 - y0 else 1
    length = (x1 - x0) if along == 0 else (y1 - y0)
    m.visual(b["name"] + "_cap", "dc_concrete", (x0 - 0.03, y0 - 0.03, z1), (x1 + 0.03, y1 + 0.03, z1 + 0.06),
             (0.82, 0.8, 0.76), lm=0.3)
    nj = int(length / 1.25)
    for k in range(1, nj + 1):
        t = (x0 if along == 0 else y0) + k * length / (nj + 1)
        for sgn, face in ((-1, y0 if along == 0 else x0), (1, y1 if along == 0 else x1)):
            if along == 0:
                m.wall_rect((t, face, (z0 + z1) / 2), 1, sgn, 0.05, z1 - z0 - 0.05, JOINT)
            else:
                m.wall_rect((face, t, (z0 + z1) / 2), 0, sgn, 0.05, z1 - z0 - 0.05, JOINT)

WIN_GLASS, WIN_FRAME = (0.09, 0.11, 0.13), (0.8, 0.78, 0.72)


def window(x, y, axis, sign, z0=1.25, z1=2.05, w=1.0):
    """A window painted on a wall face at plan (x, y): frame then glass."""
    if axis == 0:
        face_paint(x, y - w / 2, x, y + w / 2, 0, sign, z0, z1, WIN_FRAME, 0)
        face_paint(x, y - w / 2 + 0.07, x, y + w / 2 - 0.07, 0, sign, z0 + 0.07, z1 - 0.07, WIN_GLASS, 1)
    else:
        face_paint(x - w / 2, y, x + w / 2, y, 1, sign, z0, z1, WIN_FRAME, 0)
        face_paint(x - w / 2 + 0.07, y, x + w / 2 - 0.07, y, 1, sign, z0 + 0.07, z1 - 0.07, WIN_GLASS, 1)


def door(x, y, axis, sign, w=1.0, h=2.1, colour=(0.36, 0.4, 0.34)):
    if axis == 0:
        face_paint(x, y - w / 2, x, y + w / 2, 0, sign, 0.02, h, colour, 0)
        face_paint(x, y + w / 2 - 0.2, x, y + w / 2 - 0.1, 0, sign, 1.0, 1.1, (0.75, 0.75, 0.72), 1)
    else:
        face_paint(x - w / 2, y, x + w / 2, y, 1, sign, 0.02, h, colour, 0)
        face_paint(x + w / 2 - 0.2, y, x + w / 2 - 0.1, y, 1, sign, 1.0, 1.1, (0.75, 0.75, 0.72), 1)


# barracks (outside faces, then inside faces)
for x in (30.0, 33.5, 36.2):
    window(x, 10.0 - HT, 1, 1)
    window(x, 10.0 + HT, 1, -1)
for x in (24.2, 27.4, 34.4):
    window(x, 29.0 + HT, 1, -1)
    window(x, 29.0 - HT, 1, 1)
for y in (11.6,):
    window(21.0 - HT, y, 0, -1, w=0.8)
    window(21.0 + HT, y, 0, 1, w=0.8)
for y in (24.6, 27.6):
    window(38.0 + HT, y, 0, 1, w=0.9)
    window(38.0 - HT, y, 0, -1, w=0.9)
for y in (16.8,):
    window(38.0 + HT, y, 0, 1, w=0.8)
# door frames round the barrack doors (west door 22, south door 7, east door 5), both faces
for (xw, (y0, y1)) in ((21.0, D22), (21.0, D7), (38.0, D5)):
    for sgn, xf in ((-1, xw - HT), (1, xw + HT)):
        face_paint(xf, y0 - 0.12, xf, y0, 0, sgn, 0.0, DOOR_H + 0.12, WIN_FRAME, 0)
        face_paint(xf, y1, xf, y1 + 0.12, 0, sgn, 0.0, DOOR_H + 0.12, WIN_FRAME, 0)
        face_paint(xf, y0, xf, y1, 0, sgn, DOOR_H, DOOR_H + 0.12, WIN_FRAME, 0)
# crouch gaps 6 and 8: hazard-yellow frames
for (cx0, cx1), yw in ((C6, 10.0), (C8, 29.0)):
    for sgn, yf in ((1, yw - HT), (-1, yw + HT)):
        face_paint(cx0 - 0.1, yf, cx0, yf, 1, sgn, 0.0, CROUCH_CLEAR + 0.1, YELLOW, 0)
        face_paint(cx1, yf, cx1 + 0.1, yf, 1, sgn, 0.0, CROUCH_CLEAR + 0.1, YELLOW, 0)
        face_paint(cx0, yf, cx1, yf, 1, sgn, CROUCH_CLEAR, CROUCH_CLEAR + 0.1, YELLOW, 0)
# other buildings
for x in (48.5, 51.5, 54.5, 57.5):
    window(x, 14.0, 1, -1, z0=1.4, z1=2.3, w=1.2)                 # HQ, south
door(52.9, 14.0, 1, -1, w=1.4, h=2.3)
for y in (42.0, 45.0, 48.0):
    window(30.0, y, 0, -1, z0=1.4, z1=2.2, w=1.2)                 # command post, west and east
    window(44.0, y, 0, 1, z0=1.4, z1=2.2, w=1.2)
for x in (33.0, 37.0, 41.0):
    window(x, 40.0, 1, 1, z0=1.4, z1=2.2, w=1.2)                  # command post, north and south
    window(x, 50.0, 1, -1, z0=1.4, z1=2.2, w=1.2)
door(37.0, 50.0, 1, -1, w=1.2, h=2.2)
for xt in (46.0, 49.0, 50.5, 53.5):                               # office trailers: long faces
    sgn = -1 if xt in (46.0, 50.5) else 1
    for y in (39.5, 42.0, 46.5):
        window(xt, y, 0, sgn, z0=1.3, z1=2.0, w=1.0)
    door(xt, 44.2, 0, sgn, w=0.9, h=2.05, colour=(0.62, 0.6, 0.55))
window(77.0, 28.4, 1, -1, z0=1.2, z1=1.9, w=1.2)                  # guard hut
door(75.0, 28.4, 1, -1, w=0.9, h=2.05)
for y0 in (23.0, 27.3):                                           # garage: two roll-up doors facing the lane
    face_paint(12.0, y0, 12.0, y0 + 3.4, 0, 1, 0.02, 2.9, (0.5, 0.52, 0.5), 0)
    for k in range(9):
        z = 0.3 + k * 0.3
        face_paint(12.0, y0 + 0.05, 12.0, y0 + 3.35, 0, 1, z, z + 0.04, (0.32, 0.33, 0.32), 1)
door(12.0, 31.0, 0, 1, w=0.9, h=2.1)
for x in (62.0, 64.5, 67.0):                                      # generator shed: louvres on its north face
    face_paint(x, 72.0, x + 1.6, 72.0, 1, 1, 1.6, 2.6, (0.3, 0.31, 0.3), 0)
    for k in range(5):
        z = 1.7 + k * 0.18
        face_paint(x + 0.05, 72.0, x + 1.55, 72.0, 1, 1, z, z + 0.06, (0.6, 0.6, 0.58), 1)
door(25.0, 72.0, 1, 1, w=0.9, h=2.0, colour=(0.55, 0.3, 0.12))    # pump hut
door(13.0, 14.0, 1, -1, w=1.0, h=2.1)                             # guard house under the tower
for x in (3.0, 6.5, 10.0):
    window(x, 14.0, 1, -1, z0=1.3, z1=2.1, w=1.1)

# ---- sandbags at the barrack doors (collision pieces, 0.6 m: cover for a crouched player) ----------
SANDBAG_DOOR_H = 0.6
for nm, r in (("a22_sandbags_door_n", (20.375, 11.0, 21.0 - HT, 12.3)),
              ("a22_sandbags_door_s", (20.375, 15.2, 21.0 - HT, 16.5)),
              ("a7_sandbags_door_n", (20.375, 23.1, 21.0 - HT, 24.3)),
              ("a5_sandbags_door_n", (38.0 + HT, 11.4, 38.625, 12.8)),
              ("a5_sandbags_door_s", (38.0 + HT, 15.7, 38.625, 17.0))):
    solid(nm, "hesco", r, SANDBAG_DOOR_H)
    by_name = {b["name"]: b for b in m.boxes}
    shapes.sandbag_wall(m, nm + "_m", *model_box(nm), S, row=0.15)

# ---- the gantry canopy: brackets under it along the fence ------------------------------------------
for k in range(16):
    y = 30.6 + k * 2.4
    if FENCE_OPEN[0] - 0.2 < y < FENCE_OPEN[1] + 0.2:
        continue
    vis("b_gantry_bracket_%02d" % k, "dc_paint", 75.5 + HT, y - 0.04, 76.4, y + 0.04, GANTRY_UNDER - 0.2,
        GANTRY_UNDER, DARK_STEEL)
    vis("b_gantry_purlin_%02d" % k, "dc_paint", 75.5 + HT, y - 0.03, GANTRY_X1, y + 0.03, GANTRY_UNDER - 0.06,
        GANTRY_UNDER, DARK_STEEL)

# ---- markings on the pads ------------------------------------------------------------------------
LINE = (0.86, 0.84, 0.76)
for y in (36.0, 42.5, 49.0):                                      # motor pool bays
    m.floor_rect(AX(2.0), AY(y + 0.06), AX(10.5), AY(y - 0.06), 0.0, LINE)
for x in (65.0, 79.0):
    m.floor_rect(AX(x - 0.06), AY(10.5), AX(x + 0.06), AY(0.5), 0.0, LINE)
m.floor_rect(AX(65.0), AY(10.56), AX(79.0), AY(10.44), 0.0, LINE)

# ---- callouts: route names painted on the walls players come in by -------------------------------
STENCIL = (0.1, 0.1, 0.1)
BOARD = (0.86, 0.84, 0.78)


def callout(text, px, py, axis, sign, z, height=0.45, board=True):
    centre = (AX(px), AY(py), z)
    width = height * 0.95 * len(text) + 0.3
    if board:
        m.wall_rect(centre, axis, sign, width, height * 1.6, BOARD, layer=0)
    m.wall_text(text, centre, axis, sign, height, STENCIL, layer=1, stroke=0.13)


callout("A LONG", 18.0 - HT, 36.0, 0, -1, 1.35)
callout("A SHORT", 26.5, 32.0 + HT, 1, -1, 1.35)
callout("ROOF", 21.0 - HT, 21.2, 0, -1, 1.45, 0.32)
callout("WEST DOOR", 21.0 - HT, 13.75, 0, -1, 2.83, 0.3)
callout("EAST DOOR", 38.0 + HT, 14.25, 0, 1, 2.83, 0.3)
callout("FLANK", 23.6, 10.0 - HT, 1, 1, 1.35, 0.4)
callout("B MID", 56.0 - HT, 55.0, 0, -1, 1.35)
callout("B NORTH", 71.5, 36.0 - HT, 1, 1, 1.35)
callout("B SOUTH", 71.5, 64.0 + HT, 1, -1, 1.35)
callout("WALKWAY", 77.0, 28.4, 1, -1, 2.35, 0.32)
callout("GARAGE", 12.0, 27.15, 0, 1, 3.15, 0.45, board=False)
callout("MID", 30.0, 45.0, 0, -1, 2.6, 0.55)
callout("HQ", 53.0, 14.0, 1, -1, 2.85, 0.6)
callout("FUEL", 24.0, 70.0, 1, 1, 2.1, 0.45)
callout("TOWER", 7.0, 14.0, 1, -1, 2.55, 0.4)


# ---- concrete pads: expansion joints, every 4 m --------------------------------------------------
PAD_JOINT = (0.42, 0.4, 0.37)
for name, cat, (x0, y0, x1, y1) in SLABS:
    if cat != "slab" or (x1 - x0) < 6 or name.startswith("b_"):
        continue
    x = x0 + 4.0
    while x < x1 - 1.0:
        m.floor_rect(AX(x - 0.025), AY(y1), AX(x + 0.025), AY(y0), 0.0, PAD_JOINT, layer=0)
        x += 4.0
    y = y0 + 4.0
    while y < y1 - 1.0:
        m.floor_rect(AX(x0), AY(y + 0.025), AX(x1), AY(y - 0.025), 0.0, PAD_JOINT, layer=0)
        y += 4.0

# ---- Site A console: panels on its ends too, and the radio sets on top (inside its 2.2 m) ----------
for xf, sgn in ((27.015, -1), (31.485, 1)):
    for k, yc in enumerate((13.2, 14.4)):
        face_paint(xf, yc - 0.45, xf, yc + 0.45, 0, sgn, 1.2, 1.7, (0.05, 0.12, 0.09), 0)
        face_paint(xf, yc - 0.4, xf, yc + 0.4, 0, sgn, 1.25, 1.65, (0.1, 0.3, 0.2), 1)
        face_paint(xf, yc - 0.45, xf, yc + 0.45, 0, sgn, 0.25, 0.75, (0.2, 0.22, 0.2), 0)
        for j in range(4):
            face_paint(xf, yc - 0.4, xf, yc + 0.4, 0, sgn, 0.3 + j * 0.12, 0.34 + j * 0.12, (0.12, 0.12, 0.12), 1)
        face_paint(xf, yc - 0.3, xf, yc + 0.3, 0, sgn, 0.95, 1.05, (0.14, 0.14, 0.14), 0)
        face_paint(xf, yc - 0.25, xf, yc - 0.18, 0, sgn, 0.97, 1.03, (0.9, 0.2, 0.1), 1)
        face_paint(xf, yc - 0.1, xf, yc - 0.03, 0, sgn, 0.97, 1.03, (0.2, 0.8, 0.3), 1)
for k in range(4):                                                  # handles and rack seams on the long faces
    xc = 27.0 + (k + 0.5) * 4.5 / 4
    for yf, sgn in ((12.6, 1), (15.0, -1)):
        face_paint(xc + 0.42, yf, xc + 0.47, yf, 1, sgn, 0.6, 1.9, (0.7, 0.7, 0.68), 1)

# ---- buildings: more windows, AC units and pipes above head height, roof kit --------------------
for y in (6.5, 10.0):
    window(46.0, y, 0, -1, z0=1.4, z1=2.3, w=1.2)                   # HQ west and east
    window(60.0, y, 0, 1, z0=1.4, z1=2.3, w=1.2)
for x in (49.0, 53.0, 57.0):
    window(x, 4.0, 1, 1, z0=1.4, z1=2.3, w=1.2)                    # HQ north


def ac_unit(name, x, y, nx, ny, z=2.35):
    """A wall air conditioner on the face at plan (x, y) facing (nx, ny), above head height."""
    w, d, h = 0.9, 0.55, 0.55
    if nx:
        x0, x1 = (x, x + d) if nx > 0 else (x - d, x)
        vis(name, "dc_paint", x0, y - w / 2, x1, y + w / 2, z, z + h, (0.8, 0.8, 0.76))
        vis(name + "_grille", "dc_paint", (x1 - 0.01) if nx > 0 else x0, y - w / 2 + 0.08,
            (x1) if nx > 0 else (x0 + 0.01), y + w / 2 - 0.08, z + 0.08, z + h - 0.08, (0.25, 0.25, 0.25))
    else:
        y0, y1 = (y, y + d) if ny > 0 else (y - d, y)
        vis(name, "dc_paint", x - w / 2, y0, x + w / 2, y1, z, z + h, (0.8, 0.8, 0.76))
        vis(name + "_grille", "dc_paint", x - w / 2 + 0.08, (y1 - 0.01) if ny > 0 else y0, x + w / 2 - 0.08,
            y1 if ny > 0 else (y0 + 0.01), z + 0.08, z + h - 0.08, (0.25, 0.25, 0.25))


ac_unit("ac_hq_s1", 50.0, 14.0, 0, 1)
ac_unit("ac_hq_s2", 56.0, 14.0, 0, 1)
ac_unit("ac_hq_w", 46.0, 8.0, -1, 0)
ac_unit("ac_post_n", 35.0, 40.0, 0, -1, 2.2)
ac_unit("ac_post_e", 44.0, 46.5, 1, 0, 2.2)
ac_unit("ac_tr_w", 46.0, 41.0, -1, 0, 2.15)
ac_unit("ac_tr_e", 53.5, 46.0, 1, 0, 2.15)
ac_unit("ac_barrack_n", 32.0, 10.0 - HT, 0, -1, 2.3)
ac_unit("ac_barrack_s", 36.5, 29.0 + HT, 0, 1, 2.3)
# rooftop kit: AC plant, an antenna mast and a dish on the HQ; a sandbag ring and a mast on the command post
vis("hq_roof_plant", "dc_paint", 49.0, 6.0, 51.5, 8.0, HQ_H + 0.06, HQ_H + 1.0, (0.78, 0.78, 0.74))
vis("hq_roof_plant2", "dc_paint", 54.0, 9.5, 56.0, 11.0, HQ_H + 0.06, HQ_H + 0.8, (0.74, 0.74, 0.7))
shapes.cylinder(m, "hq_mast", "dc_paint", (AX(57.5), AY(6.0), HQ_H + 3.5), 0.06, 7.0, "z", 6, DARK_STEEL, 0.2)
shapes.cylinder(m, "hq_dish", "dc_paint", (AX(52.5), AY(11.5), HQ_H + 0.9), 0.6, 0.12, "y", 10, (0.85, 0.85, 0.82), 0.3)
vis("hq_dish_post", "dc_paint", 52.45, 11.4, 52.55, 11.6, HQ_H + 0.06, HQ_H + 0.6, DARK_STEEL)
shapes.cylinder(m, "post_mast", "dc_paint", (AX(41.5), AY(42.0), POST_H + 3.0), 0.05, 6.0, "z", 6, DARK_STEEL, 0.2)
for k, (x0, y0, x1, y1) in enumerate(((31.0, 41.0, 35.0, 41.6), (31.0, 41.6, 31.6, 44.0), (34.4, 41.6, 35.0, 44.0))):
    shapes.sandbag_wall(m, "post_sandbag_ring_%d" % k, *AB(x0, y0, x1, y1, POST_H + 0.06, POST_H + 0.86), S)
vis("post_roof_hatch", "dc_paint", 32.4, 42.2, 33.6, 43.2, POST_H + 0.06, POST_H + 0.3, (0.4, 0.42, 0.38))
# exhaust stacks on the generator shed, pipes along the pump hut
for k, x in enumerate((62.5, 66.0)):
    shapes.cylinder(m, "gen_stack_%d" % k, "dc_paint", (AX(x), AY(76.0), SHED_H + 0.8), 0.15, 1.6, "z", 8, DARK_STEEL, 0.3)
shapes.cylinder(m, "pump_pipe", "dc_paint", (AX(26.15), AY(76.0), 2.4), 0.12, 6.0, "y", 8, (0.5, 0.2, 0.1), 0.3)
for _y in (74.0, 78.0):
    vis("pump_pipe_bracket_%d" % _y, "dc_paint", 26.0, _y - 0.05, 26.3, _y + 0.05, 2.2, 2.3, DARK_STEEL)

# ---- the perimeter: panel joints on the inside face, a cap, concertina wire along the top ---------
for nm, axis, sgn, fixed, lo, hi in (("wall_outer_w", 0, 1, 0.0, 0.0, N), ("wall_outer_e", 0, -1, N, 0.0, N),
                                     ("wall_outer_n", 1, -1, 0.0, 0.0, N), ("wall_outer_s", 1, 1, N, 0.0, N)):
    t = lo + 1.6
    while t < hi - 0.5:      # sgn: the inside face's outward normal in authoring axes
        if axis == 0:
            m.wall_rect((AX(fixed), AY(t), OUTER_H / 2), 0, sgn, 0.06, OUTER_H - 0.1, JOINT)
        else:
            m.wall_rect((AX(t), AY(fixed), OUTER_H / 2), 1, sgn, 0.06, OUTER_H - 0.1, JOINT)
        t += 1.6
    (x0, y0, _z0), (x1, y1, _z1) = by_name[nm]["mn"], by_name[nm]["mx"]
    m.visual(nm + "_cap", "dc_concrete", (x0 - 0.04, y0 - 0.04, OUTER_H), (x1 + 0.04, y1 + 0.04, OUTER_H + 0.08),
             (0.8, 0.78, 0.74), lm=0.3)
    c = ((x0 + x1) / 2, (y0 + y1) / 2, OUTER_H + 0.08 + 0.32)
    length = max(x1 - x0, y1 - y0)
    shapes.cylinder(m, nm + "_wire", "dc_paint", c, 0.32, length, "y" if axis == 0 else "x", 6, (0.35, 0.36, 0.36),
                    0.15, caps=(False, False), t=0.02)

# ---- beyond the wall: guard towers at the corners and light poles, seen over the perimeter --------
for k, (px, py) in enumerate(((-6.0, -6.0), (86.0, -6.0), (-6.0, 86.0), (86.0, 86.0))):
    for dx in (-1.2, 1.0):
        for dy in (-1.2, 1.0):
            vis("out_tower_%d_leg%d%d" % (k, dx > 0, dy > 0), "dc_paint", px + dx, py + dy, px + dx + 0.2, py + dy + 0.2,
                0.0, 6.0, DARK_STEEL)
    vis("out_tower_%d_cab" % k, "dc_wood", px - 1.5, py - 1.5, px + 1.5, py + 1.5, 6.0, 7.2, (0.8, 0.75, 0.66))
    vis("out_tower_%d_win" % k, "dc_paint", px - 1.4, py - 1.4, px + 1.4, py + 1.4, 7.2, 7.9, (0.08, 0.08, 0.09))
    vis("out_tower_%d_roof" % k, "dc_metal", px - 1.8, py - 1.8, px + 1.8, py + 1.8, 7.9, 8.05, (0.72, 0.7, 0.66))
for k, (px, py) in enumerate(((20.0, -3.0), (60.0, -3.0), (-3.0, 40.0), (83.0, 30.0), (40.0, 83.0), (83.0, 70.0))):
    shapes.cylinder(m, "out_pole_%d" % k, "dc_paint", (AX(px), AY(py), 4.5), 0.1, 9.0, "z", 6, DARK_STEEL, 0.2)
    vis("out_pole_%d_lamp" % k, "dc_paint", px - 0.35, py - 0.2, px + 0.35, py + 0.2, 8.8, 9.05, (0.85, 0.85, 0.8))

# ---- lamps (baked) ------------------------------------------------------------------------------
WARM = (1.0, 0.78, 0.52)
SODIUM = (1.0, 0.68, 0.38)
COLD = (0.82, 0.9, 1.0)


def fixture(name, x, y, z_top, colour, power, w=1.2, d=0.2):
    vis(name, "dc_paint", x - w / 2, y - d / 2, x + w / 2, y + d / 2, z_top - 0.08, z_top, (1.0, 1.0, 1.0), )
    m.area_light((AX(x), AY(y), z_top - 0.2), (w, d), colour, power)


CEIL = BARRACK_H
for k, (x, y) in enumerate(((25.0, 14.0), (30.0, 16.6), (34.0, 12.0))):     # north barrack (Site A)
    fixture("lamp_a_n_%d" % k, x, y, CEIL, COLD, 110.0)
for k, (x, y) in enumerate(((25.0, 25.5), (31.0, 25.5), (35.5, 24.0))):     # south barrack
    fixture("lamp_a_s_%d" % k, x, y, CEIL, COLD, 100.0)
for k, y in enumerate((33.0, 40.0, 58.0, 65.0)):                            # under the gantry canopy
    vis("lamp_gantry_%d" % k, "dc_paint", 76.0, y - 0.25, 76.4, y + 0.25, GANTRY_UNDER - 0.1, GANTRY_UNDER, (1, 1, 1))
    m.point_light((AX(76.2), AY(y), GANTRY_UNDER - 0.3), SODIUM, 40.0, 0.15)


def wall_lamp(name, x, y, nx, ny, colour, power, z=3.1):
    """A lamp on a wall face at plan (x, y), facing plan direction (nx, ny) (ny + = south)."""
    w, d = 0.5, 0.18
    if nx:
        x0, x1 = (x, x + d) if nx > 0 else (x - d, x)
        vis(name, "dc_paint", x0, y - w / 2, x1, y + w / 2, z, z + 0.14, (1.0, 1.0, 1.0))
    else:
        y0, y1 = (y, y + d) if ny > 0 else (y - d, y)
        vis(name, "dc_paint", x - w / 2, y0, x + w / 2, y1, z, z + 0.14, (1.0, 1.0, 1.0))
    m.point_light((AX(x + nx * 0.4), AY(y + ny * 0.4), z - 0.2), colour, power, 0.12)


wall_lamp("lamp_ghost_spawn", 8.0, N, 0, -1, WARM, 70.0, 3.5)
wall_lamp("lamp_defender_spawn", 72.0, 0.0, 0, 1, WARM, 70.0, 3.5)
wall_lamp("lamp_stairwell", SW_W + HT, 50.0, 1, 0, WARM, 50.0, 2.9)
wall_lamp("lamp_hq", 50.0, 14.0, 0, 1, SODIUM, 60.0, 3.1)
wall_lamp("lamp_post", 37.0, 50.0, 0, 1, SODIUM, 60.0, 2.9)
wall_lamp("lamp_garage", 12.0, 30.0, 1, 0, SODIUM, 55.0, 3.1)
wall_lamp("lamp_gen_shed", 65.0, 72.0, 0, -1, SODIUM, 55.0, 2.7)
wall_lamp("lamp_pump", 23.0, 72.0, 0, -1, SODIUM, 45.0, 2.7)
m.point_light((AX(66.0), AY(53.0), BASIN + 2.6), (1.0, 0.8, 0.6), 50.0, 0.5)       # Site B, in the basin
m.point_light((AX(32.0), AY(20.0), 1.5), (1.0, 0.8, 0.6), 35.0, 0.3)               # the passage under hole 10

m.sample_spots = [
    ("ground sunlit (parade ground)", (AX(38.0), AY(55.0), 0.0), 2, 1),
    ("barrack floor (Site A)", (AX(30.0), AY(16.5), 0.0), 2, 1),
    ("passage floor under hole 10", (AX(32.0), AY(19.0), 0.0), 2, 1),
    ("site B basin floor", (AX(66.0), AY(54.0), BASIN), 2, 1),
    ("low roof top", (AX(25.0), AY(20.0), LOW_ROOF_TOP), 2, 1),
    ("walkway top", (AX(78.0), AY(40.0), RAISED_H), 2, 1),
    ("stairwell floor", (AX(74.5), AY(52.0), 0.0), 2, 1),
]
