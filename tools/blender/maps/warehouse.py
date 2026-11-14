"""
Warehouse (file id `warehouse`): a warehouse and office building on three levels.

    basement  z = -4.0   car park (west), plant room with site A, service corridors, pump room
    ground    z =  0.0   loading bay, storage racks, site B, offices, lobby; outdoor loading yard
    mezzanine z =  3.6   storage mezzanine over the offices and a catwalk over the north strip

Ghosts spawn in the sunlit loading yard (-Y), defenders in the lobby at the north end (+Y).
Built with `npm run map -- warehouse`; plan images: `python tools/blender/mapplan.py warehouse`.

Blender coords (Z up, metres): X = width (building -20 .. 20), Y = length (yard -24 .. -14.5,
building -14 .. 18). Every collision solid is an axis-aligned box; stairs are box steps.
"""

from mapkit import MapDef

MAP = MapDef("warehouse", "Warehouse")
m = MAP

B, G, M, ROOF = -4.0, 0.0, 3.6, 8.0          # floor levels and roof underside
SLAB_G = 0.3                                   # ground slab over the basement
SLAB_M = 0.3                                   # mezzanine / catwalk deck
X0, X1, Y0, Y1 = -20.0, 20.0, -14.0, 18.0      # building interior
YARD_Y0 = -24.0                                # yard south edge
WT = 0.5                                       # outer wall thickness
DOOR_H = 2.3
RISE_B = 0.25                                  # basement <-> ground: 16 rises
RISE_M = 0.24                                  # ground <-> mezzanine: 15 rises
TREAD = 0.4

m.surfaces = ["wh_floor", "wh_block", "wh_paint", "crate", "wh_metal", "wh_tiles"]
m.category_surface = {
    "floor": "wh_floor", "floor_tiles": "wh_tiles", "deck": "wh_metal",
    "outer_wall": "wh_block", "block_wall": "wh_block", "inner_wall": "wh_paint", "office_wall": "wh_paint",
    "column": "wh_block", "crate": "crate", "rack": "crate", "stairs": "wh_metal",
    "rail": "wh_metal", "roof": "wh_metal", "machine": "wh_paint", "car": "wh_paint",
    "vehicle": "wh_metal", "furniture": "wh_paint", "container": "wh_metal",
}
m.floor_categories = {"floor", "floor_tiles", "deck"}
m.floor_surfaces = {"wh_floor", "wh_tiles"}
m.wall_surfaces = {"wh_block", "wh_paint"}
m.varied_surfaces = {"crate"}
m.paint_surface = "wh_floor"
m.noise_amp = {"wh_floor": 0.14, "wh_block": 0.08, "wh_paint": 0.06, "wh_tiles": 0.05}
m.max_sightline = 30.0
m.lightmap_size = 3072
m.samples = 1024
m.max_glb_bytes = 4 * 1024 * 1024
m.site_h = 2.5


# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------
_count = {}


def uid(prefix):
    _count[prefix] = _count.get(prefix, 0) + 1
    return "%s_%02d" % (prefix, _count[prefix])


def slab(prefix, x0, y0, x1, y1, z0, z1, holes=(), category="floor", hide=()):
    """A rectangle minus rectangular holes, as few boxes as a simple strip split gives."""
    xs = sorted(set([x0, x1] + [h[i] for h in holes for i in (0, 2) if x0 < h[i] < x1]))
    ys = sorted(set([y0, y1] + [h[i] for h in holes for i in (1, 3) if y0 < h[i] < y1]))

    def solid(cx, cy):
        return not any(h[0] <= cx <= h[2] and h[1] <= cy <= h[3] for h in holes)

    strips = []        # per y band: list of x runs
    for j in range(len(ys) - 1):
        runs, start = [], None
        for i in range(len(xs) - 1):
            filled = solid((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2)
            if filled and start is None:
                start = xs[i]
            if not filled and start is not None:
                runs.append((start, xs[i]))
                start = None
        if start is not None:
            runs.append((start, xs[-1]))
        strips.append((ys[j], ys[j + 1], runs))
    # merge consecutive bands with identical runs
    merged = []
    for ya, yb, runs in strips:
        if merged and merged[-1][2] == runs and abs(merged[-1][1] - ya) < 1e-9:
            merged[-1] = (merged[-1][0], yb, runs)
        else:
            merged.append((ya, yb, runs))
    for ya, yb, runs in merged:
        for xa, xb in runs:
            m.box(uid(prefix), category, (xa, ya, z0), (xb, yb, z1), hide=hide)


def wall(prefix, category, axis, c0, c1, a0, a1, z0, z1, openings=(), tint=None):
    """A wall along `axis` ("x" or "y"): thickness c0..c1 across it, length a0..a1 along it,
    height z0..z1. Openings: (a_start, a_end, z_bottom, z_top) cut through it; openings may share
    a span (a window under a high vent). Pieces are full-height runs, sills, lintels and mullions."""
    cuts = sorted(set([a0, a1] + [v for o in openings for v in o[:2] if a0 < v < a1]))
    pieces = []
    for a, b in zip(cuts[:-1], cuts[1:]):
        mid = (a + b) / 2
        holes = sorted((o[2], o[3]) for o in openings if o[0] < mid < o[1])
        z = z0
        for hb, ht in holes:
            if hb > z:
                pieces.append((a, b, z, hb))
            z = max(z, ht)
        if z < z1:
            pieces.append((a, b, z, z1))
    # merge neighbouring spans with the same vertical extent
    merged = []
    for pc in sorted(pieces, key=lambda p: (p[2], p[3], p[0])):
        if merged and merged[-1][2:] == pc[2:] and abs(merged[-1][1] - pc[0]) < 1e-9:
            merged[-1] = (merged[-1][0], pc[1]) + pc[2:]
        else:
            merged.append(pc)
    for a, b, za, zb in sorted(merged):
        if axis == "x":
            m.box(uid(prefix), category, (a, c0, za), (b, c1, zb), tint=tint)
        else:
            m.box(uid(prefix), category, (c0, a, za), (c1, b, zb), tint=tint)


def crate(cx, cy, z, sx=1.0, sy=1.0, sz=1.0, name=None):
    m.box(name or uid("crate"), "crate", (cx - sx / 2, cy - sy / 2, z), (cx + sx / 2, cy + sy / 2, z + sz))


def column(cx, cy, z0, z1, w=0.5, name=None):
    m.box(name or uid("column"), "column", (cx - w / 2, cy - w / 2, z0), (cx + w / 2, cy + w / 2, z1))


# ---------------------------------------------------------------------------------------------
# Slabs: basement floor, ground slab (with stair holes), yard, mezzanine, catwalk, roof
# ---------------------------------------------------------------------------------------------
S1 = (18.0, 20.0)          # yard stair (x range), climbs south from the basement landing
S2 = (-8.0, -6.0)          # loading bay stair (x range)
S3 = (6.2, 8.2)            # office stair (x range)
M1 = (1.4, 3.4)            # hall stair to the mezzanine (x range), 0.6 m clear of the deck edge
M2 = (10.0, 12.0)          # lobby stair to the mezzanine (x range)

HOLE_S2 = (S2[0], -9.6, S2[1], -5.2)
HOLE_S3 = (S3[0], 7.6, S3[1], 12.0)
HOLE_S1 = (S1[0], -22.5, S1[1], -14.5)
DOCK = (-5.0, -4.6)
CAT_X0 = -14.0             # catwalk west end (over site B)        # wall between the loading bay and the hall / offices / mezzanine (y range)

slab("floor_b", X0, Y0, X1, Y1, B - 0.5, B)                       # basement floor
m.box("floor_b_s1", "floor", (S1[0], -16.5, B - 0.5), (S1[1], Y0 - WT, B))   # yard stair landing
slab("floor_g", X0, Y0, X1, Y1, G - SLAB_G, G, holes=[HOLE_S2, HOLE_S3])
slab("floor_yard", X0, YARD_Y0, X1, Y0 - WT, G - 0.5, G, holes=[HOLE_S1])
slab("deck_m", 4.0, DOCK[1], X1, 12.0, M - SLAB_M, M, holes=[(M2[0], 11.0, M2[1], 12.0)], category="deck")   # mezzanine; notch for the top of M2
m.box("deck_m1", "deck", (M1[0], 2.4, M - SLAB_M), (4.0, 4.4, M))          # M1 landing
m.box("deck_cat", "deck", (CAT_X0, 12.0, M - SLAB_M), (6.0, 14.0, M))      # catwalk
# Roof with skylight strips (open to the sky; far above any reachable spot)
SKYLIGHTS = [(-16.0, -4.0, -13.0, 9.0), (-6.0, -4.0, -3.0, 9.0), (8.0, -12.0, 11.0, -7.0), (14.0, 13.0, 17.0, 17.0)]
slab("roof", X0, Y0, X1, Y1, ROOF, ROOF + 0.4, holes=SKYLIGHTS, category="roof", hide=("top",))

# ---------------------------------------------------------------------------------------------
# Outer walls
# ---------------------------------------------------------------------------------------------
TOP = ROOF + 0.4
YARD_H = 4.5
HIGH_WIN = (5.2, 7.0)
wall("w_west", "outer_wall", "y", X0 - WT, X0, Y0 - WT, Y1 + WT, B - 0.5, TOP,
     [(-10.0, -6.0) + HIGH_WIN, (0.0, 4.0) + HIGH_WIN, (10.0, 14.0) + HIGH_WIN])
wall("w_east", "outer_wall", "y", X1, X1 + WT, Y0 - WT, Y1 + WT, B - 0.5, TOP,
     [(-12.0, -8.0) + HIGH_WIN, (13.0, 17.0) + HIGH_WIN])
wall("w_north", "outer_wall", "x", Y1, Y1 + WT, X0, X1, B - 0.5, TOP,
     [(-16.0, -11.0) + HIGH_WIN, (-6.0, -1.0) + HIGH_WIN, (13.0, 18.0) + HIGH_WIN])
D1, D2, D3 = (-17.0, -13.0), (-2.0, 2.0), (11.0, 15.0)
wall("w_south", "outer_wall", "x", Y0 - WT, Y0, X0, X1, B - 0.5, TOP,
     [D1 + (G, 4.5), D2 + (G, 4.5), D3 + (G, 4.5), (S1[0], S1[1], B, B + 2.4),
      (-9.0, -5.0) + HIGH_WIN, (4.0, 8.0) + HIGH_WIN])
# Yard walls (open sky above)
wall("w_yard_s", "outer_wall", "x", YARD_Y0 - WT, YARD_Y0, X0 - WT, X1 + WT, G - 0.5, YARD_H)
m.box("w_yard_w", "outer_wall", (X0 - WT, YARD_Y0, G - 0.5), (X0, Y0 - WT, YARD_H))
m.box("w_yard_e", "outer_wall", (X1, YARD_Y0, B - 0.5), (X1 + WT, Y0 - WT, YARD_H))

# ---------------------------------------------------------------------------------------------
# Staircases (box steps; each step is solid down to the floor it starts from)
# ---------------------------------------------------------------------------------------------
# S1: yard -> basement, open stairwell along the yard's east wall, climbing south.
m.flight("s1", S1[0], S1[1], -16.5, -1, B, G, RISE_B, TREAD, base=B - 0.5)
m.box("s1_wall", "block_wall", (S1[0] - 0.5, -22.5, B - 0.5), (S1[0], Y0 - WT, G + 1.0))
# S2: loading bay -> car park, climbing south (top at the loading bay end).
m.flight("s2", S2[0], S2[1], -3.6, -1, B, G, RISE_B, TREAD)
# Enclosed on both sides from the basement floor up (no hanging off the side under the slab edge).
m.box("s2_wall_w", "block_wall", (S2[0] - 0.2, -9.6, B), (S2[0], -5.0, 3.0))
m.box("s2_wall_e", "block_wall", (S2[1], -9.6, B), (S2[1] + 0.2, -5.0, 3.0))
m.box("s2_wall_wb", "block_wall", (S2[0] - 0.2, -5.0, B), (S2[0], -3.6, G - SLAB_G))
m.box("s2_wall_eb", "block_wall", (S2[1], -5.0, B), (S2[1] + 0.2, -3.6, G - SLAB_G))
m.box("s2_wall_n", "block_wall", (S2[0], -5.2, G), (S2[1], -5.0, 3.0))
# S3: offices -> plant room, climbing north (top at the north strip).
m.flight("s3", S3[0], S3[1], 6.0, 1, B, G, RISE_B, TREAD)
m.box("s3_wall_w", "block_wall", (S3[0] - 0.2, 6.0, B), (S3[0], 12.0, M - SLAB_M))
m.box("s3_wall_e", "block_wall", (S3[1], 6.0, B), (S3[1] + 0.2, 12.0, M - SLAB_M))
m.box("s3_wall_s", "office_wall", (S3[0], 7.4, G), (S3[1], 7.6, M - SLAB_M))
# M1: hall -> mezzanine, climbing north.
m.flight("m1", M1[0], M1[1], DOCK[1] + 1.4, 1, G, M, RISE_M, TREAD)   # bottom step faces open floor
# M2: lobby -> mezzanine, climbing south; the bottom step faces 1.4 m of open floor (a stair can only
# be entered from its bottom end: from the side the hull overlaps two steps).
m.flight("m2", M2[0], M2[1], Y1 - 1.4, -1, G, M, RISE_M, TREAD)

# ---------------------------------------------------------------------------------------------
# Railings. The catwalk has a gap over site B to drop through; falling is never a trap.
# ---------------------------------------------------------------------------------------------
RT = 0.1
RAIL = (M, M + 1.2)             # 1.2 m: too tall to jump onto, so nobody balances on top


def rail(x0, y0, x1, y1):
    m.box(uid("rail"), "rail", (x0, y0, RAIL[0]), (x1, y1, RAIL[1]), tint=(1.0, 0.78, 0.15))


rail(4.0, DOCK[1], 4.0 + RT, 2.4)                    # west edge, south of the M1 landing
rail(4.0, 4.4, 4.0 + RT, 12.0)                       # west edge, north of the landing
rail(M1[0], 2.4, M1[0] + RT, 4.4)                    # M1 landing
rail(M1[0] + RT, 4.4 - RT, 4.0, 4.4)
rail(M1[1], 2.4, 4.0, 2.4 + RT)                      # landing edge beside the top step
rail(6.0, 12.0 - RT, M2[0], 12.0)                    # mezzanine north edge
rail(M2[1], 12.0 - RT, X1, 12.0)
rail(CAT_X0, 14.0 - RT, 6.0, 14.0)                   # catwalk north side
rail(CAT_X0 + 2.0, 12.0, 4.0, 12.0 + RT)             # catwalk south side; open over site B at the west end
rail(CAT_X0, 12.0 + RT, CAT_X0 + RT, 14.0 - RT)      # catwalk west end

# Columns under the mezzanine edge and the catwalk
for y in (4.0, 10.0):
    m.box(uid("column"), "column", (4.0, y - 0.15, G), (4.3, y + 0.15, M - SLAB_M))
for x in (-12.0, -8.0, 0.0):
    m.box(uid("column"), "column", (x - 0.15, 13.7, G), (x + 0.15, 14.0, M - SLAB_M))

# ---------------------------------------------------------------------------------------------
# Ground floor: offices (under the mezzanine, east), lobby
# ---------------------------------------------------------------------------------------------
OH = M - SLAB_M                     # office walls run up to the mezzanine deck
WIN = (1.2, 2.4)
wall("off_w", "office_wall", "y", 6.0, 6.2, DOCK[1], 6.0, G, OH)
wall("off_n", "office_wall", "x", 9.4, 9.6, S3[1] + 0.2, X1, G, OH, [(12.0, 13.8, G, DOOR_H), (15.0, 19.0) + WIN])
wall("off_cs", "office_wall", "x", 0.8, 1.0, 6.2, X1, G, OH, [(7.5, 9.1, G, DOOR_H), (13.0, 14.6, G, DOOR_H), (17.0, 18.6, G, DOOR_H)])
wall("off_cn", "office_wall", "x", 2.8, 3.0, 6.2, X1, G, OH, [(9.5, 11.1, G, DOOR_H), (15.5, 17.1, G, DOOR_H), (11.8, 13.6) + WIN])
# Dock wall: block wall from the floor to the roof between the loading bay and everything north of
# it; offset openings so no line of sight runs from the yard through a door deep into the building.
wall("dock", "block_wall", "x", DOCK[0], DOCK[1], X0, X1, G, ROOF,
     [(-17.0, -15.0, G, 3.0), (-3.6, -1.2, G, 3.0), (D3[0] - 1.0, D3[0] + 0.8, G, DOOR_H),
      (-14.0, -9.0, 6.4, 7.6), (-1.0, 3.0, 6.4, 7.6)])
m.box("off_d1", "office_wall", (11.8, DOCK[1], G), (12.0, 0.8, OH))
m.box("off_d2", "office_wall", (15.8, DOCK[1], G), (16.0, 0.8, OH))
m.box("off_d3", "office_wall", (13.8, 3.0, G), (14.0, 9.4, OH))
slab("floor_off", 6.2, DOCK[1], X1, 9.4, G - 0.02, G + 0.0, holes=[(6.2, 6.0, 8.4, 9.4)], category="floor_tiles", hide=("bottom",))

# ---------------------------------------------------------------------------------------------
# Basement walls
# ---------------------------------------------------------------------------------------------
BH = G - SLAB_G
wall("bw1", "block_wall", "y", 4.0, 4.5, Y0, Y1, B, BH, [(-9.5, -7.5, B, B + DOOR_H + 0.1), (0.0, 3.0, B, B + DOOR_H + 0.1)])
wall("bw2", "block_wall", "x", -4.5, -4.0, 4.5, X1, B, BH, [(10.0, 12.0, B, B + DOOR_H + 0.1)])
# Storeroom block in the service area (ring corridor around it)
SR = (6.5, -12.0, 17.5, -6.5)
wall("sr_s", "block_wall", "x", SR[1], SR[1] + 0.3, SR[0], SR[2], B, BH)
wall("sr_n", "block_wall", "x", SR[3] - 0.3, SR[3], SR[0], SR[2], B, BH, [(8.0, 10.0, B, B + DOOR_H)])
wall("sr_w", "block_wall", "y", SR[0], SR[0] + 0.3, SR[1] + 0.3, SR[3] - 0.3, B, BH)
wall("sr_e", "block_wall", "y", SR[2] - 0.3, SR[2], SR[1] + 0.3, SR[3] - 0.3, B, BH, [(-8.8, -7.0, B, B + DOOR_H)])
# Pump room partition (north of the plant room)
wall("bw3", "block_wall", "x", 12.0, 12.3, S3[1], X1, B, BH, [(14.0, 16.0, B, B + DOOR_H + 0.1)])

# ---------------------------------------------------------------------------------------------
# Spawns and bomb sites
# ---------------------------------------------------------------------------------------------
for x in (6.0, 7.5, 9.0, 10.5, 12.0):
    m.spawn("ghosts", x, -19.0, G, 0.0)
for x in (-1.0, 0.5, 2.0, 3.5, 5.0):
    m.spawn("defenders", x, 16.5, G, 180.0)
m.site("A", (9.0, -1.0), (16.0, 6.0), B)      # basement plant room
m.site("B", (-19.0, 6.0), (-11.0, 11.5), G)   # ground floor dispatch area, under the catwalk's edge

# Distinct ghost routes, checked by the verifier: each gate alone connects the ghost spawn to the
# site, and with every gate closed the site cannot be reached. (x0, y0, z0, x1, y1, z1)
m.route_gates = {
    "A": [("S1 yard stair (service corridors)", (S1[0], -22.5, B - 0.1, S1[1], -14.5, G + 0.1)),
          ("S2 loading bay stair (car park)", (S2[0], -9.6, B - 0.1, S2[1], -3.6, G + 0.1)),
          ("S3 office stair (offices)", (S3[0], 6.0, B - 0.1, S3[1], 12.0, G + 0.1))],
    "B": [("dock opening west (rack aisles)", (-17.0, DOCK[0], G - 0.1, -15.0, DOCK[1], G + 0.5)),
          ("dock opening middle (main aisle)", (-3.6, DOCK[0], G - 0.1, -1.2, DOCK[1], G + 0.5)),
          ("office door (offices, lobby, mezzanine)", (D3[0] - 1.0, DOCK[0], G - 0.1, D3[0] + 0.8, DOCK[1], G + 0.5)),
          ("up S3 from the basement", (S3[0], 6.0, B - 0.1, S3[1], 12.0, G + 0.1))],
}


# =============================================================================================
# Cover: crates, racks, vehicles, machinery. Racks, vehicles and machines are collision volumes
# (hide "all") drawn by the visual-only boxes added in the detail section below.
# =============================================================================================
def solid(name, category, mn, mx, tint=None, visible=True):
    return m.box(name, category, mn, mx, tint=tint, hide=() if visible else ("all",))


def stack(cx, cy, z, sx, sy, layers=2, name=None):
    """Crates stacked `layers` high (1 m each), one collision box."""
    crate(cx, cy, z, sx, sy, float(layers), name=name)


# ---- yard ------------------------------------------------------------------------------------
TRAILER = (-9.0, -22.5, -6.4, -14.5)          # backed up to the building between D1 and D2
solid("trailer", "vehicle", (TRAILER[0], TRAILER[1], G), (TRAILER[2], TRAILER[3], 3.9), visible=False)
solid("container", "container", (2.0, YARD_Y0, G), (8.0, -21.6, 2.6), tint=(0.62, 0.22, 0.14))
stack(-14.3, -19.4, G, 1.4, 1.2, 1)
stack(-14.3, -20.6, G, 1.4, 1.2, 2)
stack(14.4, -16.7, G, 1.2, 1.2, 2)
crate(13.9, -20.5, G)

# ---- loading bay -----------------------------------------------------------------------------
stack(-19.0, -11.9, G, 2.0, 1.2, 2)
# Pallet walls staged inside each loading door: no view from the yard deep into the building.
crate(-15.2, -11.2, G, 5.6, 1.6, 3.2, name="baffle_d1")
crate(-1.7, -11.8, G, 7.8, 1.6, 3.2, name="baffle_d2")
crate(13.4, -11.2, G, 5.2, 1.6, 3.2, name="baffle_d3")
stack(-10.0, -13.0, G, 2.0, 2.0, 2)            # against the south wall between D1 and D2
crate(-11.4, -9.1, G, 2.0, 2.6, 2.5)
crate(-12.9, -8.4, G)
stack(5.0, -13.0, G, 2.0, 2.0, 2)              # against the south wall between D2 and D3
solid("forklift", "vehicle", (7.6, -10.0, G), (8.8, -7.6, 2.2), visible=False)
stack(17.0, -10.8, G, 2.0, 1.2, 2)
crate(19.4, -13.4, G, 1.2, 1.2, 1.0)
column(-4.0, -8.0, G, ROOF, 0.5)
column(12.0, -8.0, G, ROOF, 0.5)

# ---- storage hall: racks run north-south, 2 m aisles ----------------------------------------
RACK_Y = (-3.2, 4.0)
RACK_H = 4.5
RACKS = [(-18.2, -17.0), (-15.0, -13.8), (-11.8, -10.6), (-8.6, -7.4), (-5.4, -4.2)]
for i, (rx0, rx1) in enumerate(RACKS):
    solid("rack_%d" % (i + 1), "rack", (rx0, RACK_Y[0], G), (rx1, RACK_Y[1], RACK_H), visible=False)
# staging lane north of the racks: pallets that break the aisle sightlines
stack(-16.0, 6.6, G, 1.2, 1.2, 2)
stack(-8.0, 6.6, G, 1.2, 1.2, 2)
stack(-2.0, 7.0, G, 1.4, 1.2, 2)
crate(-0.8, 3.0, G, 1.2, 1.2, 1.0)
stack(-2.0, -1.4, G, 1.2, 1.2, 2)              # main aisle, north of the dock opening

# ---- site B (dispatch area) ------------------------------------------------------------------
stack(-17.8, 9.4, G, 1.0, 1.0, 2)
stack(-13.6, 10.2, G, 2.0, 1.0, 1)
crate(-13.0, 7.0, G)
stack(-10.4, 8.6, G, 1.2, 1.2, 2)

# ---- north strip and lobby -------------------------------------------------------------------
stack(-11.0, 16.0, G, 2.0, 1.0, 2)
stack(-4.5, 17.5, G, 1.0, 1.0, 2)
crate(-19.3, 16.45, G, 1.4, 3.1, 2.4)
solid("reception", "furniture", (15.0, 15.4, G), (17.0, Y1, 1.25), tint=(0.55, 0.42, 0.32))
solid("lobby_screen", "office_wall", (14.8, 15.2, G), (15.0, Y1, 2.4))
stack(19.4, 13.6, G, 1.2, 1.2, 2)
crate(-5.5, 13.7, G, 1.0, 3.0, 2.4, name="pallet_wall_n")   # under the catwalk
solid("lobby_partition", "block_wall", (8.2, 13.4, G), (8.4, Y1, ROOF))

# ---- offices: desks and tall cabinets --------------------------------------------------------
DESK = (0.7, 0.4, 0.3)
for i, (x0, y0, x1, y1) in enumerate([(8.6, -4.6, 9.4, -3.0), (13.5, -3.2, 14.3, -1.6), (18.4, -3.2, X1, -2.4),
                                       (9.8, 5.2, 11.4, 6.0), (16.0, 5.2, 17.6, 6.0)]):
    solid("desk_%d" % (i + 1), "furniture", (x0, y0, G), (x1, y1, 0.75), tint=DESK)
for i, (x0, y0, x1, y1) in enumerate([(19.4, 3.0, X1, 4.6), (8.4, 8.8, 10.0, 9.4)]):
    solid("cabinet_%d" % (i + 1), "furniture", (x0, y0, G), (x1, y1, 2.0), tint=(0.36, 0.38, 0.42))

# ---- mezzanine -------------------------------------------------------------------------------
crate(6.05, -4.0, M, 3.9, 1.2, 2.0)             # mezzanine south-west corner, against the rail
stack(8.0, 5.0, M, 1.2, 1.2, 2)
crate(6.2, 9.0, M, 1.2, 2.8, 2.6, name="mezz_shelf")
crate(6.2, -0.2, M, 1.2, 3.2, 2.6, name="mezz_shelf_s")
stack(13.6, 8.8, M, 2.0, 1.2, 2)
# Mezzanine store room (south-east), walls 2.6 m, two doors
MS = M + 2.6
wall("mstore_w", "office_wall", "y", 10.0, 10.2, DOCK[1], 3.8, M, MS)
wall("mstore_n", "office_wall", "x", 3.8, 4.0, 10.0, X1, M, MS, [(17.6, 19.4, M, M + DOOR_H)])   # door into the mezzanine office
stack(12.6, -1.0, M, 1.2, 2.0, 2)
crate(10.7, -4.1, M)                            # corner crate (touches two walls)
stack(17.0, -4.0, M, 1.2, 1.2, 2)
solid("mezz_office_w", "office_wall", (16.0, 4.0, M), (16.2, 10.4, MS))

# ---- basement: car park ----------------------------------------------------------------------
for x in (-13.5, -2.5):
    for y in (-10.0, -4.0, 2.0, 8.0):
        column(x, y, B, G - SLAB_G, 0.6)
# north store wall: closes the car park at y = 14 except two doorways
wall("bw4", "block_wall", "x", 14.0, 14.3, -15.6, 0.0, B, G - SLAB_G, [(-9.0, -7.0, B, B + DOOR_H + 0.1), (-4.0, -2.0, B, B + DOOR_H + 0.1)])
stack(-8.0, 17.0, B, 3.0, 2.0, 2)              # bike store: crates behind each doorway
stack(-3.0, 17.0, B, 2.4, 2.0, 2)
solid("core", "block_wall", (-11.4, 3.0, B), (-8.4, 8.6, G - SLAB_G))          # lift / services core
solid("utility_ne", "block_wall", (0.0, 14.0, B), (4.0, Y1, G - SLAB_G))         # electrical room
solid("utility_sw", "block_wall", (-14.0, Y0, B), (-11.0, -12.0, G - SLAB_G))    # sprinkler valve room
solid("ramp_box", "block_wall", (X0, 14.0, B), (-15.6, Y1, G - SLAB_G))          # closed vehicle ramp
solid("spine", "block_wall", (-5.0, 0.0, B), (-4.6, 12.0, G - SLAB_G))          # offset from spine_s: a dogleg, not a window
solid("spine_s", "block_wall", (-6.2, -3.6, B), (-5.8, -1.6, G - SLAB_G))          # car park spine wall
solid("booth", "inner_wall", (-0.3, 0.4, B), (1.5, 2.6, B + 2.4), tint=(0.9, 0.86, 0.7))   # pay booth
CAR_COLOURS = [(0.55, 0.08, 0.06), (0.12, 0.2, 0.42), (0.8, 0.8, 0.78), (0.18, 0.18, 0.2), (0.25, 0.35, 0.22),
               (0.7, 0.55, 0.15), (0.45, 0.45, 0.48)]
CARS = []


def car(cx, cy, along_x=True):
    """A parked car: collision volume 4.4 x 1.8 x 1.0 body plus a cabin, drawn by visuals later."""
    i = len(CARS)
    hx, hy = (2.2, 0.9) if along_x else (0.9, 2.2)
    solid("car_%02d" % (i + 1), "car", (cx - hx, cy - hy, B), (cx + hx, cy + hy, B + 1.0), visible=False)
    cxh, cyh = (1.2, 0.75) if along_x else (0.75, 1.2)
    ox = -0.3 if along_x else 0.0
    oy = 0.0 if along_x else -0.3
    solid("car_%02d_cab" % (i + 1), "car", (cx + ox - cxh, cy + oy - cyh, B + 1.0),
          (cx + ox + cxh, cy + oy + cyh, B + 1.45), visible=False)
    CARS.append((cx, cy, along_x, CAR_COLOURS[i % len(CAR_COLOURS)]))


for cy in (-11.5, -8.0, -2.1, 4.5, 7.8):        # west row, nose to the wall
    car(X0 + 2.2, cy)
car(-10.0, 11.2)                               # middle
for cy in (-11.0, 5.5, 11.6):                  # east row, nose to the wall
    car(1.8, cy)

# ---- basement: plant room (site A) and pump room ---------------------------------------------
solid("boiler_1", "machine", (17.6, -4.0, B), (X1, -1.0, B + 2.6), visible=False)
solid("boiler_2", "machine", (17.6, 0.5, B), (X1, 3.5, B + 2.6), visible=False)
solid("pump_a", "machine", (11.0, 1.0, B), (12.5, 2.0, B + 1.0), tint=(0.2, 0.4, 0.6))
solid("panel_w1", "machine", (6.0, -1.2, B), (6.3, 3.2, B + 2.8), tint=(0.5, 0.52, 0.5))   # control panel by the car park door
solid("cabinets_a", "machine", (13.5, 4.0, B), (15.5, 4.6, B + 2.0), tint=(0.5, 0.52, 0.5))
stack(9.3, -0.7, B, 1.0, 1.0, 2)
solid("tank", "machine", (10.0, 8.0, B), (12.6, 10.6, B + 2.8), visible=False)
solid("cabinets_w2", "machine", (4.5, -4.0, B), (8.5, -3.4, B + 1.9), tint=(0.5, 0.52, 0.5))
solid("generator", "machine", (11.0, 14.0, B), (15.0, 16.6, B + 2.4), tint=(0.62, 0.5, 0.12))
solid("pumps_ne", "machine", (18.0, 14.4, B), (X1, 15.6, B + 1.2), tint=(0.2, 0.4, 0.6))
# storeroom in the service area
stack(7.8, -11.1, B, 2.0, 1.2, 2)
crate(12.0, -9.0, B)
stack(16.6, -11.1, B, 1.2, 1.2, 2)


# =============================================================================================
# Visual-only detail (no collision). Everything here stays inside a collision volume or above
# head height; the verifier fails the build if any of it intrudes into space a player can occupy.
# =============================================================================================
ORANGE = (0.95, 0.36, 0.06)
DARK = (0.09, 0.09, 0.1)
STEEL = (0.62, 0.64, 0.66)
GLASS = (0.1, 0.13, 0.16)


def vis(prefix, surface, mn, mx, tint=None):
    m.visual(uid(prefix), surface, mn, mx, tint)


# ---- racks: orange uprights and beams, decks, stocked pallets, a back panel -------------------
for i, (rx0, rx1) in enumerate(RACKS):
    y0, y1 = RACK_Y
    bays = 3
    bay = (y1 - y0) / bays
    levels = [(0.0, 1.45), (1.55, 2.95), (3.05, 4.4)]
    xm = (rx0 + rx1) / 2
    vis("rackback", "wh_paint", (xm - 0.02, y0 + 0.05, 0.05), (xm + 0.02, y1 - 0.05, RACK_H - 0.05), (0.3, 0.3, 0.32))
    for k in range(bays + 1):
        yy = min(max(y0 + k * bay, y0 + 0.04), y1 - 0.04)
        for xa in (rx0, rx1 - 0.08):
            vis("upright", "wh_metal", (xa, yy - 0.04, 0.0), (xa + 0.08, yy + 0.04, RACK_H), ORANGE)
    for z0, z1 in levels[1:] + [(4.4, 4.5)]:
        for xa in (rx0, rx1 - 0.06):
            vis("beam", "wh_metal", (xa, y0, z0 - 0.12), (xa + 0.06, y1, z0), ORANGE)
        vis("deck", "crate", (rx0 + 0.06, y0 + 0.04, z0 - 0.1), (rx1 - 0.06, y1 - 0.04, z0 - 0.06), (0.7, 0.62, 0.5))
    for k in range(bays):
        for li, (z0, z1) in enumerate(levels):
            if (i + k + li) % 5 == 4:
                continue                                # an empty slot here and there (back panel shows)
            ya = y0 + k * bay + 0.12
            yb = y0 + (k + 1) * bay - 0.12
            h = 0.9 + 0.35 * (((i * 7 + k * 3 + li * 5) % 4) / 3.0)
            col = [(0.62, 0.48, 0.32), (0.75, 0.66, 0.5), (0.55, 0.42, 0.3), (0.82, 0.8, 0.74)][(i + 2 * k + li) % 4]
            vis("pallet", "crate", (rx0 + 0.1, ya, z0 + 0.02), (rx1 - 0.1, yb, z0 + 0.14), (0.75, 0.62, 0.45))
            vis("goods", "wh_paint" if (i + k + li) % 3 else "crate", (rx0 + 0.12, ya + 0.04, z0 + 0.14),
                (rx1 - 0.12, yb - 0.04, z0 + 0.14 + min(h, z1 - z0 - 0.3)), col)

# ---- parked cars -------------------------------------------------------------------------------
for k, (cx, cy, along_x, colour) in enumerate(CARS):
    hx, hy = (2.2, 0.9) if along_x else (0.9, 2.2)
    x0, x1, y0, y1 = cx - hx, cx + hx, cy - hy, cy + hy
    vis("carbody", "wh_paint", (x0 + 0.04, y0 + 0.04, B + 0.28), (x1 - 0.04, y1 - 0.04, B + 0.96), colour)
    vis("carsill", "wh_paint", (x0 + 0.3, y0 + 0.06, B + 0.2), (x1 - 0.3, y1 - 0.06, B + 0.3), DARK)
    ox = -0.3
    vis("carglass", "wh_paint", (cx + ox - 1.18, cy - 0.73, B + 0.96), (cx + ox + 1.18, cy + 0.73, B + 1.36), GLASS)
    vis("carroof", "wh_paint", (cx + ox - 1.0, cy - 0.7, B + 1.36), (cx + ox + 1.0, cy + 0.7, B + 1.44), colour)
    for wx in (x0 + 0.5, x1 - 1.1):
        for wy0, wy1 in ((y0 + 0.02, y0 + 0.3), (y1 - 0.3, y1 - 0.02)):
            vis("wheel", "wh_paint", (wx, wy0, B), (wx + 0.62, wy1, B + 0.62), DARK)
    vis("carlamp", "wh_paint", (x1 - 0.06, y0 + 0.15, B + 0.62), (x1 - 0.02, y0 + 0.45, B + 0.76), (0.95, 0.92, 0.75))
    vis("carlamp", "wh_paint", (x1 - 0.06, y1 - 0.45, B + 0.62), (x1 - 0.02, y1 - 0.15, B + 0.76), (0.95, 0.92, 0.75))
    vis("carlamp", "wh_paint", (x0 + 0.02, y0 + 0.15, B + 0.66), (x0 + 0.06, y0 + 0.5, B + 0.8), (0.8, 0.06, 0.04))
    vis("carlamp", "wh_paint", (x0 + 0.02, y1 - 0.5, B + 0.66), (x0 + 0.06, y1 - 0.15, B + 0.8), (0.8, 0.06, 0.04))

# ---- trailer in the yard -----------------------------------------------------------------------
tx0, ty0, tx1, ty1 = TRAILER
vis("trailer", "wh_metal", (tx0 + 0.03, ty0 + 0.03, 1.25), (tx1 - 0.03, ty1 - 0.03, 3.87), (0.86, 0.87, 0.9))
vis("trailer", "wh_metal", (tx0 + 0.05, ty0 + 0.05, 0.3), (tx1 - 0.05, ty1 - 2.6, 1.25), (0.25, 0.27, 0.3))   # side skirts
vis("trailer", "wh_metal", (tx0 + 0.15, ty1 - 2.6, 0.95), (tx1 - 0.15, ty1 - 0.05, 1.25), DARK)              # rear frame
for wy in (ty1 - 2.5, ty1 - 1.4):
    for wx0, wx1 in ((tx0 + 0.05, tx0 + 0.6), (tx1 - 0.6, tx1 - 0.05)):
        vis("trailerwheel", "wh_paint", (wx0, wy, 0.0), (wx1, wy + 1.0, 1.0), DARK)
vis("trailerstripe", "wh_paint", (tx0 + 0.01, ty0 + 0.5, 1.4), (tx0 + 0.03, ty1 - 0.5, 1.55), (0.85, 0.1, 0.08))
vis("trailerstripe", "wh_paint", (tx1 - 0.03, ty0 + 0.5, 1.4), (tx1 - 0.01, ty1 - 0.5, 1.55), (0.85, 0.1, 0.08))

# ---- forklift ----------------------------------------------------------------------------------
vis("fork", "wh_paint", (7.65, -9.2, 0.15), (8.75, -7.65, 1.15), (0.95, 0.68, 0.08))       # body
vis("fork", "wh_paint", (7.7, -7.95, 0.15), (8.7, -7.62, 1.0), (0.2, 0.2, 0.22))           # counterweight
vis("fork", "wh_metal", (7.7, -9.95, 0.0), (7.8, -9.75, 2.18), DARK)                        # mast
vis("fork", "wh_metal", (8.6, -9.95, 0.0), (8.7, -9.75, 2.18), DARK)
vis("fork", "wh_metal", (7.8, -9.9, 1.6), (8.6, -9.8, 1.7), DARK)
vis("fork", "wh_metal", (7.9, -9.98, 0.05), (8.05, -9.4, 0.1), DARK)                        # forks (under the mast)
vis("fork", "wh_metal", (8.35, -9.98, 0.05), (8.5, -9.4, 0.1), DARK)
for fx in (7.68, 8.64):
    for fy in (-9.15, -8.0):
        vis("forkpost", "wh_metal", (fx, fy, 1.15), (fx + 0.06, fy + 0.06, 2.15), DARK)
vis("forkroof", "wh_metal", (7.68, -9.15, 2.12), (8.72, -7.94, 2.18), DARK)
for wy in (-9.6, -8.2):
    vis("forkwheel", "wh_paint", (7.62, wy, 0.0), (8.78, wy + 0.4, 0.4), DARK)

# ---- boilers and the tank (octagonal from three boxes), pipes up to the ceiling ----------------
def drum(name, x0, y0, x1, y1, z0, z1, colour, cut=0.4):
    vis(name, "wh_paint", (x0 + cut, y0, z0), (x1 - cut, y1, z1), colour)
    vis(name, "wh_paint", (x0, y0 + cut, z0), (x1, y1 - cut, z1), colour)
    vis(name, "wh_paint", (x0 + cut, y0 + cut, z1), (x1 - cut, y1 - cut, z1 + 0.15), colour)


drum("boiler", 17.6, -4.0, X1, -1.0, B, B + 2.45, (0.55, 0.12, 0.1))
drum("boiler", 17.6, 0.5, X1, 3.5, B, B + 2.45, (0.55, 0.12, 0.1))
drum("tank", 10.0, 8.0, 12.6, 10.6, B, B + 2.65, (0.7, 0.72, 0.7), 0.5)
for px, py in ((18.6, -2.6), (18.6, 2.0), (11.3, 9.3)):
    vis("riser", "wh_metal", (px - 0.12, py - 0.12, B + 2.6), (px + 0.12, py + 0.12, G - SLAB_G), (0.55, 0.2, 0.1))
# basement ceiling pipes (above any reachable head height)
PIPE_Z = (G - SLAB_G - 0.28, G - SLAB_G - 0.12)
vis("pipe", "wh_metal", (4.5, -0.6, PIPE_Z[0]), (X1, -0.44, PIPE_Z[1]), (0.55, 0.2, 0.1))
vis("pipe", "wh_metal", (4.5, -0.2, PIPE_Z[0]), (X1, -0.04, PIPE_Z[1]), (0.2, 0.35, 0.55))
vis("pipe", "wh_metal", (18.4, -13.8, PIPE_Z[0]), (18.56, -4.5, PIPE_Z[1]), (0.2, 0.35, 0.55))
vis("pipe", "wh_metal", (6.5, -5.8, PIPE_Z[0]), (X1, -5.64, PIPE_Z[1]), (0.55, 0.2, 0.1))
vis("pipe", "wh_metal", (-19.6, -13.8, PIPE_Z[0]), (-19.44, 13.8, PIPE_Z[1]), (0.75, 0.12, 0.08))     # sprinkler main
vis("pipe", "wh_metal", (-19.6, -4.2, PIPE_Z[0]), (3.8, -4.04, PIPE_Z[1]), (0.75, 0.12, 0.08))
vis("pipe", "wh_metal", (-19.6, 10.6, PIPE_Z[0]), (3.8, 10.76, PIPE_Z[1]), (0.75, 0.12, 0.08))
vis("tray", "wh_metal", (-12.0, -13.8, G - SLAB_G - 0.12), (-11.6, 13.8, G - SLAB_G - 0.06), STEEL)
# hall: cable tray and a sprinkler main under the roof
vis("tray", "wh_metal", (X0 + 0.2, 7.6, 7.3), (X1 - 0.2, 8.0, 7.36), STEEL)
vis("pipe", "wh_metal", (X0 + 0.2, -2.2, 7.4), (X1 - 0.2, -2.04, 7.56), (0.75, 0.12, 0.08))
vis("pipe", "wh_metal", (X0 + 0.2, -9.0, 7.4), (X1 - 0.2, -8.84, 7.56), (0.75, 0.12, 0.08))
# roller-shutter drums above the loading doors (outside the reach of anyone in the doorway)
for dx0, dx1 in (D1, D2, D3):
    vis("shutter", "wh_metal", (dx0 - 0.2, Y0, 4.55), (dx1 + 0.2, Y0 + 0.5, 5.05), (0.35, 0.4, 0.45))

# ---- light fixtures and baked lamps ------------------------------------------------------------
WARM = (1.0, 0.56, 0.22)       # sodium
COLD = (0.72, 0.85, 1.0)       # fluorescent
HALL = (1.0, 0.86, 0.66)       # high-bay
OFFICE = (0.9, 0.95, 1.0)


def fixture(x, y, z_top, colour, power, w=0.6, d=0.2, kind="POINT", size=None):
    """A ceiling fixture box with its lamp just below, so the fixture face glows in the bake."""
    vis("lamp", "wh_paint", (x - w / 2, y - d / 2, z_top - 0.08), (x + w / 2, y + d / 2, z_top), (1.0, 1.0, 1.0))
    if kind == "AREA":
        m.area_light((x, y, z_top - 0.2), size or (w, d), colour, power)
    else:
        m.point_light((x, y, z_top - 0.3), colour, power, radius=0.1)


CEIL_B = G - SLAB_G
# car park: sodium pools along the aisles, some bays left dark
for x, y in ((-15.0, -12.0), (-15.0, -1.0), (-15.0, 10.0), (-8.5, -6.0), (-8.5, 1.5), (-8.5, 12.0),
             (-1.0, -11.5), (-1.0, -3.5), (-1.0, 6.5), (-7.0, 16.0)):
    fixture(x, y, CEIL_B, WARM, 130.0)
# plant room, pump room and service corridors: cold strips
for x, y in ((8.0, 1.5), (14.0, 1.5), (14.5, 7.0), (5.25, 9.0), (12.0, 15.6), (17.5, 13.5)):
    fixture(x, y, CEIL_B, COLD, 90.0, 1.2, 0.15, "AREA", (1.2, 0.15))
for x, y in ((19.0, -12.5), (19.0, -7.5), (14.0, -5.5), (8.0, -5.5), (11.0, -13.0), (5.5, -10.0), (12.0, -9.5)):
    fixture(x, y, CEIL_B, COLD, 55.0, 1.2, 0.15, "AREA", (1.2, 0.15))
fixture(19.0, -15.5, G - 1.6, COLD, 40.0, 0.4, 0.3)               # over the yard stair landing (under the wall)
# ground floor hall, loading bay, lobby, north strip: high-bay lamps under the roof
for x, y in ((-16.0, 0.5), (-9.0, 0.5), (-2.0, 0.5), (-15.0, 9.0), (-6.0, 9.0), (-16.0, -9.0), (-6.0, -12.0),
             (3.0, -8.5), (16.0, -8.0), (-12.0, 16.0), (-2.0, 16.0), (13.0, 15.5)):
    fixture(x, y, ROOF - 0.6, HALL, 520.0, 0.5, 0.5)
# offices (under the mezzanine deck): flat panels
for x, y in ((9.0, -2.0), (14.0, -2.0), (18.0, -2.0), (10.0, 1.9), (17.0, 1.9), (11.0, 6.5), (17.0, 7.0), (7.2, 6.7)):
    fixture(x, y, M - SLAB_M, OFFICE, 70.0, 0.6, 0.6, "AREA", (0.6, 0.6))
for x, y in ((5.1, -2.0), (5.1, 6.0), (13.0, 11.2), (-3.0, 13.0), (-10.0, 13.0)):     # under the deck edges
    fixture(x, y, M - SLAB_M, HALL, 45.0, 0.5, 0.3)
# mezzanine and catwalk
for x, y in ((7.0, 1.0), (13.0, -1.0), (18.0, -1.0), (8.0, 9.0), (14.0, 6.5)):
    fixture(x, y, ROOF - 0.6, HALL, 300.0, 0.5, 0.5)
m.point_light((15.0, -22.0, 4.2), (1.0, 0.8, 0.55), 80.0, 0.2)       # yard wall lamp

# ---- stairs: alternating tread tint and yellow nosing so every step reads ----------------------
by_name = {b["name"]: b for b in m.boxes}
for fl in m.flights:
    for k, nm in enumerate(fl["steps"]):
        b = by_name[nm]
        b["tint"] = (0.95, 0.95, 0.95) if k % 2 else (0.72, 0.72, 0.74)
        top = b["mx"][2]
        if fl["axis"] == "y":
            # the nosing is the step's edge toward the bottom of the flight
            bottom_side = "lo" if fl["z0"] < fl["z1"] and by_name[fl["steps"][0]]["mn"][1] < b["mn"][1] else "hi"
            first = by_name[fl["steps"][0]]
            climbing_up_y = len(fl["steps"]) > 1 and by_name[fl["steps"][1]]["mn"][1] > first["mn"][1]
            if climbing_up_y:
                m.floor_rect(b["mn"][0] + 0.05, b["mn"][1], b["mx"][0] - 0.05, b["mn"][1] + 0.07, top, (0.95, 0.72, 0.05))
            else:
                m.floor_rect(b["mn"][0] + 0.05, b["mx"][1] - 0.07, b["mx"][0] - 0.05, b["mx"][1], top, (0.95, 0.72, 0.05))

# ---- paint: sites, letters, signage, floor markings ---------------------------------------------
RED, RED_FILL = (0.95, 0.1, 0.07), (0.55, 0.36, 0.33)
BLUE, BLUE_FILL = (0.08, 0.28, 1.0), (0.36, 0.42, 0.62)
YELLOW, WHITE = (0.95, 0.72, 0.05), (0.85, 0.85, 0.82)
LINE_W = 0.22
for name, (x0, y0), (x1, y1), z in m.sites:
    line, fill = (RED, RED_FILL) if name == "A" else (BLUE, BLUE_FILL)
    m.floor_rect(x0, y0, x1, y1, z, fill, layer=0)
    m.floor_rect(x0, y0, x1, y0 + LINE_W, z, line)
    m.floor_rect(x0, y1 - LINE_W, x1, y1, z, line)
    m.floor_rect(x0, y0 + LINE_W, x0 + LINE_W, y1 - LINE_W, z, line)
    m.floor_rect(x1 - LINE_W, y0 + LINE_W, x1, y1 - LINE_W, z, line)
m.floor_text("A", (14.6, -0.0), B, 2.0, RED, up=(0, 1), stroke=0.22)
m.floor_text("B", (-15.0, 7.3), G, 2.0, BLUE, up=(0, 1), stroke=0.22)
# wall letters and arrows (site markers, stair signs)
m.wall_text("A", (13.4, -4.0, B + 1.7), 1, 1, 1.2, RED, stroke=0.2)              # plant room side of the south door
m.wall_text("A", (4.5, 3.9, B + 1.7), 0, 1, 1.0, RED, stroke=0.2)                # plant room side of the car park door
m.wall_text("A", (4.0, -4.0, B + 1.6), 0, -1, 0.9, RED, stroke=0.2)              # car park, by the plant room door
m.wall_text(">", (4.0, -2.8, B + 1.6), 0, -1, 0.7, RED, stroke=0.18, angle=90)
m.wall_text("A", (S2[0] - 0.2, -7.0, G + 1.8), 0, -1, 0.8, RED, stroke=0.18)    # loading bay, stair down to A
m.wall_text(">", (S2[0] - 0.2, -8.2, G + 1.8), 0, -1, 0.6, RED, stroke=0.16, angle=-90)
m.wall_text("A", (S1[0] - 0.5, -20.5, G + 0.55), 0, -1, 0.6, RED, stroke=0.16)  # yard stair parapet
m.wall_text("B", (-16.0, DOCK[1], G + 3.6), 1, 1, 1.2, BLUE, stroke=0.2)         # dock wall, hall side, above the west opening
m.wall_text("B", (-13.0, DOCK[0], G + 3.8), 1, -1, 1.2, BLUE, stroke=0.2)        # dock wall, loading bay side
m.wall_text(">", (-11.6, DOCK[0], G + 3.8), 1, -1, 0.9, BLUE, stroke=0.18, angle=180)
m.wall_text("A", (12.8, DOCK[0], G + 3.4), 1, -1, 1.0, RED, stroke=0.2)          # loading bay, over the office door
m.wall_text("-1", (S3[1] + 0.2, 10.5, G + 1.6), 0, 1, 0.6, YELLOW, stroke=0.16)  # office stair: level -1
m.wall_text("P", (X0 + WT * 0 + 0.0, 0.0, B + 1.8), 0, 1, 1.1, (0.15, 0.4, 0.95), stroke=0.22)   # car park west wall
m.wall_text("-1", (-11.4, 5.8, B + 1.7), 0, -1, 0.8, YELLOW, stroke=0.16)         # car park core
m.wall_text("P", (-10.5, 14.0, B + 1.6), 1, -1, 0.7, (0.15, 0.4, 0.95), stroke=0.16)   # bike store wall, car park side
# car park bay lines (white) between parked cars, and a yellow walkway along the core
for cy in (-13.15, -9.75, -6.35, -3.75, -0.45, 2.95, 6.15, 9.55):
    m.floor_rect(X0 + 0.1, cy - 0.06, X0 + 5.0, cy + 0.06, B, WHITE)
for cy in (-12.8, -9.2, 3.9, 7.1, 10.3, 13.0):
    m.floor_rect(-1.0, cy - 0.06, 3.9, cy + 0.06, B, WHITE)
m.floor_rect(-13.0, -13.6, -13.0 + 0.12, 13.6, B, YELLOW)
# loading bay: yellow safety lines along the dock wall and around the doors
m.floor_rect(X0 + 0.2, DOCK[0] - 1.1, X1 - 0.2, DOCK[0] - 0.98, G, YELLOW)
for dx0, dx1 in (D1, D2, D3):
    m.floor_rect(dx0, Y0 + 0.1, dx0 + 0.15, Y0 + 2.0, G, YELLOW)
    m.floor_rect(dx1 - 0.15, Y0 + 0.1, dx1, Y0 + 2.0, G, YELLOW)
    m.floor_rect(dx0, Y0 + 1.85, dx1, Y0 + 2.0, G, YELLOW)
# hall: walkway lines along the main aisle
m.floor_rect(-3.9, -4.4, -3.75, 11.8, G, YELLOW)
m.floor_rect(1.05, 3.2, 1.2, 11.8, G, YELLOW)
# mezzanine edge: yellow kick plate line
m.floor_rect(4.15, DOCK[1] + 0.1, 4.3, 11.8, M, YELLOW)
