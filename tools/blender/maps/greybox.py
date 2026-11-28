"""
Training Yard (file id `greybox`, called Test Map 1 until 2026-11-28): the original open-air test map. Three lanes, two bomb sites,
a raised platform overlooking mid. Built with `npm run map -- greybox` (or `npm run map:greybox`).

Layout (Blender coords, Z up): X = width (-15 .. 15), Y = length (-22 .. 22), ghost spawn at -Y,
defender spawn at +Y.
"""

from mapkit import MapDef

MAP = MapDef("greybox", "Training Yard")
m = MAP

HALF_W = 15.0        # interior half width  (X) -> 30 m
HALF_L = 22.0        # interior half length (Y) -> 44 m
WALL_T = 0.5         # outer wall thickness
WALL_H = 4.0         # outer wall height
INNER_H = 3.5        # inner wall height
FLOOR_T = 0.5

m.surfaces = ["floor", "wall_outer", "wall_inner", "crate", "metal"]
m.category_surface = {
    "floor": "floor",
    "outer_wall": "wall_outer",
    "inner_wall": "wall_inner",
    "crate": "crate",
    "platform": "metal",
    "stairs": "metal",
}
m.noise_amp = {"floor": 0.16, "wall_outer": 0.10, "wall_inner": 0.08}
m.wall_surfaces = {"wall_outer", "wall_inner"}
m.lightmap_size = 3072
m.samples = 1024


def box(name, category, mn, mx):
    m.box(name, category, mn, mx)


def crate(idx, cx, cy, kind):
    """kind: 'c1' 1m cube, 'c2x' 2x1x1 long in X, 'c2y' 1x2x1 long in Y, 'c3' 1x1x2 stack."""
    sx, sy, sz = {"c1": (1, 1, 1), "c2x": (2, 1, 1), "c2y": (1, 2, 1), "c3": (1, 1, 2)}[kind]
    box("crate_%02d" % idx, "crate", (cx - sx / 2, cy - sy / 2, 0.0), (cx + sx / 2, cy + sy / 2, sz))


# Floor (top at z = 0), covers outer walls too
box("floor", "floor", (-HALF_W - WALL_T, -HALF_L - WALL_T, -FLOOR_T), (HALF_W + WALL_T, HALF_L + WALL_T, 0.0))

# Outer walls (long walls span full length incl. corners)
box("wall_outer_west", "outer_wall", (-HALF_W - WALL_T, -HALF_L - WALL_T, 0), (-HALF_W, HALF_L + WALL_T, WALL_H))
box("wall_outer_east", "outer_wall", (HALF_W, -HALF_L - WALL_T, 0), (HALF_W + WALL_T, HALF_L + WALL_T, WALL_H))
box("wall_outer_south", "outer_wall", (-HALF_W, -HALF_L - WALL_T, 0), (HALF_W, -HALF_L, WALL_H))   # ghost end
box("wall_outer_north", "outer_wall", (-HALF_W, HALF_L, 0), (HALF_W, HALF_L + WALL_T, WALL_H))     # defender end

# Lane dividers (run along Y), each with a 2 m door gap
box("wall_lane_L_1", "inner_wall", (-5.25, -14.0, 0), (-4.75, -6.0, INNER_H))
box("wall_lane_L_2", "inner_wall", (-5.25, -4.0, 0), (-4.75, 6.0, INNER_H))
box("wall_lane_R_1", "inner_wall", (4.75, -14.0, 0), (5.25, 0.0, INNER_H))
box("wall_lane_R_2", "inner_wall", (4.75, 2.0, 0), (5.25, 6.0, INNER_H))

# Site entrances: cross walls at end of side lanes, 3 m choke into each site
box("wall_siteA_entry_W", "inner_wall", (-HALF_W, 6.0, 0), (-11.5, 6.5, INNER_H))
box("wall_siteA_entry_E", "inner_wall", (-8.5, 6.0, 0), (-5.25, 6.5, INNER_H))
box("wall_siteB_entry_W", "inner_wall", (5.25, 6.0, 0), (8.5, 6.5, INNER_H))
box("wall_siteB_entry_E", "inner_wall", (11.5, 6.0, 0), (HALF_W, 6.5, INNER_H))

# Mid-to-site connectors: 3.5 m gap (y 6.5..10) between lane wall end and these
box("wall_mid_A", "inner_wall", (-5.25, 10.0, 0), (-4.75, 15.0, INNER_H))
box("wall_mid_B", "inner_wall", (4.75, 10.0, 0), (5.25, 15.0, INNER_H))

# Ghost spawn cover wall (blocks direct mid sightline into spawn)
box("wall_ghost_cover", "inner_wall", (-2.0, -15.25, 0), (2.0, -14.75, 3.0))

# Defender spawn cover wall: without it a defender at spawn could shoot down mid along x = -4
# (beside the left lane wall) into the ghost spawn 40 m away. 1.45 m in front of the spawn line,
# 1.5 m clear of the stairs; defenders leave spawn around either end.
box("wall_defender_cover", "inner_wall", (-4.8, 17.75, 0), (4.8, 18.25, 3.0))

# Raised platform overlooking mid (defender side), 5 x 4 m, 1.2 m high
PLAT_H = 1.2
box("platform_mid", "platform", (-2.5, 10.0, 0), (2.5, 14.0, PLAT_H))

# Staircase behind the platform, descending toward defender spawn (+Y). Kept as hand-placed boxes
# (stair_01 is the top step) so the collision data matches the original map exactly.
STEP_RISE = 0.2
STEP_TREAD = 0.45
STAIR_X = (-1.0, 1.0)       # 2 m wide
STAIR_Y0 = 14.0             # back edge of platform
N_STEPS = int(round(PLAT_H / STEP_RISE)) - 1   # 5 steps, platform is the 6th rise
steps = []
for i in range(N_STEPS):
    top = PLAT_H - STEP_RISE * (i + 1)          # 1.0, 0.8, ... 0.2
    y0 = STAIR_Y0 + STEP_TREAD * i
    name = "stair_%02d" % (i + 1)
    box(name, "stairs", (STAIR_X[0], y0, 0.0), (STAIR_X[1], y0 + STEP_TREAD, top))
    steps.append(name)
m.flights.append(dict(name="stair", steps=steps[::-1], z0=0.0, z1=PLAT_H, axis="y"))

# Crates
crate(1, -12.0, -10.0, "c1")
crate(2, -8.0, -8.0, "c2y")
crate(3, -14.5, -2.0, "c3")
crate(4, -9.0, 2.0, "c1")
crate(5, 0.0, -9.0, "c2x")
crate(6, -4.25, -2.5, "c1")
crate(7, 2.5, 1.0, "c3")
crate(8, -1.5, 5.0, "c1")
crate(9, 8.0, -10.0, "c3")
crate(10, 12.0, -6.0, "c1")
crate(11, 13.0, 0.0, "c2y")
crate(12, 8.0, 3.0, "c1")
crate(13, -10.0, 10.0, "c2x")     # site A
crate(14, -7.5, 12.5, "c3")       # site A
crate(15, -14.5, 15.0, "c1")      # site A back
crate(16, 10.0, 10.5, "c2y")      # site B
crate(17, 7.5, 12.5, "c3")        # site B
crate(18, 13.0, 13.0, "c1")       # site B
crate(19, -8.0, -18.0, "c1")      # ghost spawn
crate(20, 8.0, -18.0, "c1")       # ghost spawn
crate(21, -9.0, 19.0, "c2x")      # defender spawn
crate(22, 10.0, 18.5, "c3")       # defender spawn

# ---------------------------------------------------------------------------
# Gameplay data
# ---------------------------------------------------------------------------
m.site("A", (-12.0, 8.0), (-6.0, 14.0), 0.0)
m.site("B", (6.0, 8.0), (12.0, 14.0), 0.0)
m.site_h = 2.5
for x in (-4.0, -2.0, 0.0, 2.0, 4.0):
    m.spawn("ghosts", x, -20.0, 0.0, 0.0)
for x in (-4.0, -2.0, 0.0, 2.0, 4.0):
    m.spawn("defenders", x, 20.0, 0.0, 180.0)

# ---------------------------------------------------------------------------
# Paint (site markings, letters)
# ---------------------------------------------------------------------------
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
m.floor_text("A", (-10.2, 12.25), 0.0, 2.4, PAINT["A"]["line"], up=(0, 1), stroke=0.2)
m.floor_text("B", (7.9, 10.25), 0.0, 2.4, PAINT["B"]["line"], up=(0, 1), stroke=0.2)
m.wall_text("A", (-6.9, 6.0, 1.75), 1, -1, 1.6, PAINT["A"]["line"], stroke=0.2)    # site A entry wall, facing the A lane
m.wall_text("A", (-4.75, 12.5, 1.75), 0, 1, 1.6, PAINT["A"]["line"], stroke=0.2)   # mid connector wall, facing mid
m.wall_text("B", (6.9, 6.0, 1.75), 1, -1, 1.6, PAINT["B"]["line"], stroke=0.2)     # site B entry wall, facing the B lane
m.wall_text("B", (4.75, 12.5, 1.75), 0, -1, 1.6, PAINT["B"]["line"], stroke=0.2)   # mid connector wall, facing mid

# ---------------------------------------------------------------------------
# Site markings (package G): warning stripes inside each border and pale sign panels behind the
# wall letters, so a site reads from the lane and the letters stand out on concrete.
# ---------------------------------------------------------------------------
DARK_PAINT = (0.07, 0.07, 0.08)
SIGN = (0.82, 0.8, 0.74)
for name, (x0, y0), (x1, y1), z in m.sites:
    m.hazard_band(x0 + LINE_W, y0 + LINE_W, x1 - LINE_W, y1 - LINE_W, z, PAINT[name]["line"], width=0.3, stripe=0.22, gap=0.3)
for letter, centre, axis, sign in (("A", (-6.9, 6.0, 1.75), 1, -1), ("A", (-4.75, 12.5, 1.75), 0, 1),
                                   ("B", (6.9, 6.0, 1.75), 1, -1), ("B", (4.75, 12.5, 1.75), 0, -1)):
    m.wall_rect(centre, axis, sign, 1.7, 2.1, SIGN, layer=0)
# floor arrows in the side lanes pointing on to each site (letters' tops toward the site)
m.floor_text("A >", (-10.0, 1.0), 0.0, 0.9, PAINT["A"]["line"], up=(-1, 0), stroke=0.14)
m.floor_text("B >", (10.0, 1.0), 0.0, 0.9, PAINT["B"]["line"], up=(1, 0), stroke=0.14)

# ---------------------------------------------------------------------------
# Stair readability: alternating step tints, a yellow nosing on every tread edge and a dark riser
# band, plus a yellow edge on the platform's open sides (a drop, not a step).
# ---------------------------------------------------------------------------
YELLOW = (0.95, 0.72, 0.05)
by_name = {b["name"]: b for b in m.boxes}
for k, nm in enumerate(steps):
    b = by_name[nm]
    b["tint"] = (1.0, 1.0, 1.0) if k % 2 else (0.74, 0.74, 0.78)
    top, y1 = b["mx"][2], b["mx"][1]          # the flight climbs toward -Y: the edge toward the bottom is max Y
    m.floor_rect(STAIR_X[0] + 0.05, y1 - 0.08, STAIR_X[1] - 0.05, y1, top, YELLOW)
    m.wall_rect((0.0, y1, top - 0.1), 1, 1, 1.9, 0.12, DARK_PAINT, layer=0)
m.floor_rect(STAIR_X[0] + 0.05, STAIR_Y0 - 0.08, STAIR_X[1] - 0.05, STAIR_Y0, PLAT_H, YELLOW)   # top step edge
m.floor_rect(-2.45, 10.0, 2.45, 10.1, PLAT_H, YELLOW)                                         # platform front edge
m.floor_rect(-2.5, 10.1, -2.4, 13.95, PLAT_H, YELLOW)
m.floor_rect(2.4, 10.1, 2.5, 13.95, PLAT_H, YELLOW)

# ---------------------------------------------------------------------------
# Visual-only detail (no collision; the verifier keeps it out of player space): copings on every
# wall top, a cable run and wall lamps on the outer walls, and stains on the floor.
# ---------------------------------------------------------------------------
STEEL = (0.55, 0.57, 0.6)
COPING = (0.62, 0.6, 0.56)
for b in list(m.boxes):
    if b["category"] not in ("outer_wall", "inner_wall"):
        continue
    (x0, y0, z0), (x1, y1, z1) = b["mn"], b["mx"]
    o = 0.05
    m.visual(b["name"] + "_cap", "wall_inner", (x0 - o, y0 - o, z1), (x1 + o, y1 + o, z1 + 0.1), COPING)
# cable tray along the inside of the long outer walls, broken where a tall crate stands against the wall
for x, sx in ((-HALF_W, 1), (HALF_W, -1)):
    xa, xb = (x, x + 0.12) if sx > 0 else (x - 0.12, x)
    for ya, yb in ((-HALF_L + 0.5, -3.2), (-0.8, HALF_L - 0.5)):
        m.visual("tray_%s_%d" % ("w" if sx > 0 else "e", int(ya)), "metal", (xa, ya, 3.72), (xb, yb, 3.8), STEEL)


def wall_lamp(name, x, y, nx, ny, colour, power):
    """A lamp box on a wall face (outward normal nx, ny) above reach, with its baked lamp just in front."""
    w, d = 0.5, 0.18
    if nx:
        mn, mx = (x if nx > 0 else x - d, y - w / 2, 3.32), (x + d if nx > 0 else x, y + w / 2, 3.46)
    else:
        mn, mx = (x - w / 2, y if ny > 0 else y - d, 3.32), (x + w / 2, y + d if ny > 0 else y, 3.46)
    m.visual(name, "metal", mn, mx, (1.0, 1.0, 1.0))
    m.point_light((x + nx * 0.4, y + ny * 0.4, 3.12), colour, power, 0.12)


# ---------------------------------------------------------------------------
# Baked accent lights (point lamps, light only): position, colour, power W, radius
# ---------------------------------------------------------------------------
m.point_light((-9.0, 11.0, 3.2), (1.0, 0.35, 0.25), 120.0, 0.6)   # site A: red-ish
m.point_light((9.0, 11.0, 3.2), (0.3, 0.5, 1.0), 120.0, 0.6)      # site B: blue-ish
m.point_light((-5.0, -5.0, 3.0), (1.0, 0.7, 0.4), 45.0, 0.3)      # lane L door: warm
m.point_light((5.0, 1.0, 3.0), (1.0, 0.7, 0.4), 45.0, 0.3)        # lane R door: warm
wall_lamp("lamp_site_a", -HALF_W, 11.0, 1, 0, (1.0, 0.62, 0.38), 90.0)
wall_lamp("lamp_site_b", HALF_W, 11.0, -1, 0, (0.62, 0.75, 1.0), 90.0)
wall_lamp("lamp_ghost_w", -10.0, -HALF_L, 0, 1, (1.0, 0.75, 0.5), 70.0)
wall_lamp("lamp_ghost_e", 10.0, -HALF_L, 0, 1, (1.0, 0.75, 0.5), 70.0)
wall_lamp("lamp_def_w", -12.0, HALF_L, 0, -1, (1.0, 0.75, 0.5), 70.0)
wall_lamp("lamp_def_e", 12.0, HALF_L, 0, -1, (1.0, 0.75, 0.5), 70.0)

# stains and oil spots (paint decals darken the floor texture; free: the paint is already one draw call)
STAIN = (0.3, 0.29, 0.27)
for i, (cx, cy, sx, sy) in enumerate(((-1.5, -6.0, 1.4, 0.9), (3.0, 4.0, 0.8, 1.2), (-11.0, -6.0, 1.1, 1.1),
                                      (11.5, -3.0, 1.6, 0.7), (-2.0, 17.0, 1.2, 0.8), (6.5, -17.0, 0.9, 0.9),
                                      (-7.5, 4.5, 0.7, 0.5), (12.5, 7.5, 0.8, 0.6))):
    m.floor_rect(cx - sx / 2, cy - sy / 2, cx + sx / 2, cy + sy / 2, 0.0, STAIN, layer=0)

m.sample_spots = [
    ("floor sunlit (mid)", (0.0, -3.0, 0.0), 2, 1),
    ("wall shade (-X face lane L)", (-5.25, 0.0, 1.5), 0, -1),
    ("floor shade (W of lane wall L)", (-5.8, 2.5, 0.0), 2, 1),
    ("floor shade (open, behind crate 05)", (-1.3, -8.6, 0.0), 2, 1),
    ("floor corner (SW, shade)", (-14.8, -21.8, 0.0), 2, 1),
    ("wall sunlit (+X face lane L)", (-4.75, 0.0, 1.5), 0, 1),
    ("wall sunlit (-Y face site B entry)", (7.0, 6.0, 1.5), 1, -1),
    ("crate top", (-12.0, -10.0, 1.0), 2, 1),
    ("site A floor", (-11.0, 13.0, 0.0), 2, 1),
    ("site B floor", (11.0, 13.0, 0.0), 2, 1),
]
