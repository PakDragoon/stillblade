"""
Trailer Park (file id `trailerpark`, also called APV Courtyard): the owner's drawing as a playable
greybox, with Test Map 1's look. Built with `npm run map -- trailerpark`.

Source of truth: docs/maps/trailer-park.webp (1000 x 1000 px, north up), read with
docs/maps/trailer-park-notes.md (the numbered features) and the owner-approved Blender preview
tools/blender/previews/trailer_park.py (its coordinate table, traced in image pixels at 0.07 m per
pixel, and its heights). Names below carry the notes' numbers (n10_..., n18_...).

Authoring space (Blender, Z up, metres): X = image x, Y = image up, centred on the image:
    X = (px - 500) * 0.07        Y = (500 - py) * 0.07
so the ghost spawn (bottom left of the image) is at -Y facing +Y and the defender spawn (top) at +Y.

Every collision solid is an axis-aligned box. Angled shapes (the APV, the west trailer, tilted
crates and blocks, the round post, Site B's curved banks, the planks) keep their angled look as
oriented visual-only boxes; their collision is a few boxes that follow the shape (mapshapes.cover),
drawn by nothing (hide "all"). The planks are real 0.2 m stairs under the visual boards.
"""

import math

import mapshapes as ms
from mapkit import MapDef

MAP = MapDef("trailerpark", "Trailer Park")
m = MAP

S = 0.07                     # metres per image pixel (approved preview, M_PER_PX)


def X(px):
    return (px - 500.0) * S


def Y(py):
    return (500.0 - py) * S


# ---- heights (approved preview constants) ----------------------------------------------------
BOUNDARY_H = 4.0
BOUNDARY_T = 0.5
WALL_H = 3.5                 # every thin wall line and every filled block not named otherwise (24)
T = 0.25                     # thin walls
HT = T / 2
HUMAN_H = 1.8                # trailers 19, short walls 22
JUMP_H = 1.0                 # jump boxes 10, 16, 21, 23 and the two at the walkway's ends
LOW_COVER_H = 1.2            # box 18
CRATE_SQUARE_H = 1.0         # barrack crates: small or square, jumpable
CRATE_LONG_H = 1.2           # barrack crates: long or thin, crouch cover
BUS_H, VAN_H, APV_H = 3.0, 2.5, 2.4
CROUCH_CLEAR = 1.4           # crouch openings 8 and 9
DOOR_H = 2.3                 # house doors
BARRACK_ROOF_TOP, ROOF_T = 3.5, 0.2
ROOF6_TOP, ROOF6_T = 2.0, 0.15
HOUSE_H = 3.0
EAST_SILL_H = 1.2
PIT = -1.2                   # Site B floor (TRENCH_DEPTH)
RAISED_H = 1.2               # walkway 13
RISE, TREAD = 0.2, 0.45      # stairs (B pit)
PLANK_TREAD = 0.45           # plank stairs: Test Map 1's treads (see plank() for why not the drawn 4.5 m ramp)
GROUND_Z0 = -1.6

m.surfaces = ["floor", "wall_outer", "wall_inner", "crate", "metal"]
m.category_surface = {
    "floor": "floor",
    "pit_rim": "floor",
    "pit_stairs": "metal",
    "outer_wall": "wall_outer",
    "inner_wall": "wall_inner",
    "crate": "crate",
    "platform": "metal",
    "stairs": "metal",
    "vehicle": "metal",
    "roof": "metal",
}
# The pit's rim pieces and stairs are part of the ground around Site B: floors, not obstacles, for the
# walkway-gap check (that check looks at every solid reaching into walking height above a floor
# level, and at the pit floor's level that would be every wall standing on the ground nearby).
m.floor_categories = {"floor", "pit_rim", "pit_stairs"}
m.noise_amp = {"floor": 0.16, "wall_outer": 0.10, "wall_inner": 0.08}
m.wall_surfaces = {"wall_outer", "wall_inner"}
m.lightmap_size = 4096
m.samples = 1024
m.max_glb_bytes = 3 * 1024 * 1024
m.site_h = 1.25             # the site boxes hold only their floors (and crates on them), not the pit rim

_count = {}


def uid(prefix):
    _count[prefix] = _count.get(prefix, 0) + 1
    return "%s_%02d" % (prefix, _count[prefix])


def box(name, category, x0, y0, z0, x1, y1, z1, tint=None, hide=(), group=None):
    return m.box(name, category, (min(x0, x1), min(y0, y1), z0), (max(x0, x1), max(y0, y1), z1), tint=tint, hide=hide,
                 group=group)


def wx(name, py, x0, x1, h=WALL_H, z0=0.0, cat="inner_wall"):
    """A thin wall along X centred on image row py, from x0 to x1 (metres)."""
    return box(name, cat, x0, Y(py) - HT, z0, x1, Y(py) + HT, h)


def wy(name, px, y0, y1, h=WALL_H, z0=0.0, cat="inner_wall"):
    """A thin wall along Y centred on image column px, from y0 to y1 (metres)."""
    return box(name, cat, X(px) - HT, y0, z0, X(px) + HT, y1, h)


def px_rect(px0, py0, px1, py1, pad=0):
    """Image rectangle (+ pad px on every side) -> metric (x0, y0, x1, y1)."""
    return (X(px0 - pad), Y(py1 + pad), X(px1 + pad), Y(py0 - pad))


def block(name, category, r, h, z0=0.0, tint=None, hide=()):
    return box(name, category, r[0], r[1], z0, r[2], r[3], h, tint=tint, hide=hide)


def angled(name, surface, category, polys, h, z0=0.0, tint=None, overhang=0.25, max_strip=1.0, strip=None, axis=None,
           visuals=None, extend=()):
    """An angled solid: oriented visual boxes (one per rectangle in `polys`, or `visuals` when given)
    and hidden axis-aligned collision boxes covering all of them, one group. `extend` lists
    (axis, value) lines (a wall face) the collision boxes are stretched to when within 0.6 m of them,
    so a shape pushed against a wall leaves no notch between its steps and the wall."""
    for k, poly in enumerate(visuals if visuals is not None else polys):
        if isinstance(poly, dict):
            vis = poly
        else:
            cx, cy, ln, wd, ang = ms.rect_frame(poly)
            vis = dict(cx=cx, cy=cy, ln=ln, wd=wd, ang=ang, z0=z0, z1=h)
        nm = name if k == 0 and len(polys) == 1 and visuals is None else "%s_v%d" % (name, k)
        m.visual(nm, surface, (vis["cx"] - vis["ln"] / 2, vis["cy"] - vis["wd"] / 2, vis["z0"]),
                 (vis["cx"] + vis["ln"] / 2, vis["cy"] + vis["wd"] / 2, vis["z1"]), tint, yaw=vis["ang"],
                 hide=vis.get("hide", ("bottom",)))
    rects = ms.cover(polys, overhang=overhang, max_strip=max_strip, axis=axis, strip=strip)
    for k, r in enumerate(rects):
        r = list(r)
        for ax, v in extend:
            if 0 < v - r[ax + 2] < 0.6:
                r[ax + 2] = v
            elif 0 < r[ax] - v < 0.6:
                r[ax] = v
        box("%s_c%02d" % (name, k + 1), category, r[0], r[1], z0, r[2], r[3], h, hide=("all",), group=name)
    return rects


# =============================================================================================
# Outer wall and ground
# =============================================================================================
# The traced outer edge (preview BOUNDARY, outer side of the 8 px stroke) as a polygon whose edges all
# run along X or Y, on the INSIDE face of the wall. The drawn curves and slants are stepped in about
# 1 m jogs (the wall is 0.5 m thick, Test Map 1's).
INNER_PX = [
    (137, 46), (283, 46), (283, 30), (875, 30), (875, 40), (902, 40), (902, 60), (915, 60), (915, 145),
    (975, 145), (975, 229), (900, 229), (900, 526), (918, 526), (918, 596), (900, 596), (900, 800), (850, 800),
    (850, 877), (897, 877), (897, 915), (891, 915), (891, 940), (885, 940), (885, 963), (709, 963), (709, 973),
    (355, 973), (355, 978), (312, 978), (312, 966), (182, 966), (182, 974), (137, 974), (137, 890), (154, 890),
    (154, 772), (220, 772), (220, 725), (50, 725), (50, 690), (37, 690), (37, 480), (28, 480), (28, 360),
    (22, 360), (22, 131), (63, 131), (63, 137), (137, 137),
]
INNER = [(X(px), Y(py)) for px, py in INNER_PX]
_ccw = ms.signed_area(INNER) > 0
for i in range(len(INNER)):
    a, b = INNER[i], INNER[(i + 1) % len(INNER)]
    prev, nxt = INNER[i - 1], INNER[(i + 2) % len(INNER)]
    ux, uy = (b[0] - a[0], b[1] - a[1])
    ln = math.hypot(ux, uy)
    ux, uy = ux / ln, uy / ln
    nx, ny = (uy, -ux) if _ccw else (-uy, ux)          # outward
    if abs(uy) < 1e-9:      # along X: the ends reach to the neighbouring walls' outer faces (or stop at them)
        # neighbour edges are along Y; their outward normals in x:
        pux = 0.0
        pa = INNER[i - 1]
        p_ny = (a[1] - pa[1])
        p_nx = (p_ny / abs(p_ny)) if _ccw else (-p_ny / abs(p_ny))     # outward x of edge prev->a
        q_ny = (nxt[1] - b[1])
        q_nx = (q_ny / abs(q_ny)) if _ccw else (-q_ny / abs(q_ny))     # outward x of edge b->nxt
        xa = a[0] + p_nx * BOUNDARY_T
        xb = b[0] + q_nx * BOUNDARY_T
        y0, y1 = sorted((a[1], a[1] + ny * BOUNDARY_T))
        box(uid("wall_outer"), "outer_wall", min(xa, xb), y0, 0.0, max(xa, xb), y1, BOUNDARY_H,
            hide=("bottom", "+y" if ny > 0 else "-y"))
    else:
        x0, x1 = sorted((a[0], a[0] + nx * BOUNDARY_T))
        box(uid("wall_outer"), "outer_wall", x0, min(a[1], b[1]), 0.0, x1, max(a[1], b[1]), BOUNDARY_H,
            hide=("bottom", "+x" if nx > 0 else "-x"))

# Site B: a window of the ground around the pit is rastered (0.5 m cells); the rest of the ground is
# the inner polygon in rectangles.
PIT_WINDOW = (-22.0, 8.0, -12.5, 31.0)
for r in ms.rectilinear_rects(INNER):
    for piece in ms.subtract(r, PIT_WINDOW):
        box(uid("ground"), "floor", piece[0], piece[1], GROUND_Z0, piece[2], piece[3], 0.0,
            hide=("bottom", "+x", "-x", "+y", "-y"))

# =============================================================================================
# Site B (3): the dug-out pit, 1.2 m below ground, with stairs at its three open ends
# =============================================================================================
# The traced fill (preview PIT_B, image px) in metres, with the three open ends turned into straight
# stair channels 1.7 m wide (the stairs inside them are 1.66 m: MIN_STAIR_WIDTH is 1.6). Open edges
# (no bank) are the stair tops.
PIT_POLY = [
    (-21.0, 30.15), (-18.75, 30.15),                          # north channel, north side
    (X(253), Y(75)), (X(265), Y(83)), (X(274), Y(93)), (X(272), Y(114)), (X(261), Y(129)), (X(251), Y(136)),
    (X(251), Y(153)), (X(256), Y(161)), (X(257), Y(171)),
    (-15.75, 21.85), (-13.5, 21.85),                          # east channel, north side; then open (east stair top)
    (-13.5, 20.15), (-15.75, 20.15),                          # east channel, south side
    (X(270), Y(226)), (X(261), Y(239)), (X(260), Y(253)), (X(263), Y(285)), (X(261), Y(308)), (X(263), Y(314)),
    (X(256), Y(338)),
    (-18.15, 10.75), (-18.15, 8.5),                           # south channel, east side; then open (south stair top)
    (-19.85, 8.5), (-19.85, 10.75),                           # south channel, west side
    (X(214), Y(307)), (X(218), Y(289)), (X(225), Y(278)), (X(225), Y(267)), (X(217), Y(242)), (X(211), Y(235)),
    (X(222), Y(184)), (X(209), Y(147)), (X(209), Y(141)), (X(216), Y(128)), (X(217), Y(114)), (X(222), Y(103)),
    (-19.6, 28.45), (-21.0, 28.45),                           # north channel, south side; then open (north stair top)
]
PIT_OPEN = {12, 23, 39}            # edge i -> i+1 has no bank (stair tops)
BANK_IN = 0.02                     # bank face just inside the pit edge (no face shares a plane with the ground)
BANK_T = 0.25
CAP_W = 0.6                        # flat lip on the ground beyond the bank: covers the 0.5 m ground cells' steps
RIM_TOP = 0.08                     # collision under bank and lip (the visuals stay below it)

# pit floor (and the base the rastered ground stands on)
box("n3_site_b_floor", "floor", PIT_WINDOW[0], PIT_WINDOW[1], GROUND_Z0, PIT_WINDOW[2], PIT_WINDOW[3], PIT,
    hide=("bottom", "+x", "-x", "+y", "-y"))
for r in ms.raster(PIT_WINDOW, 0.5, lambda c: not ms.rect_meets_poly(c, PIT_POLY)):
    box(uid("ground_b"), "floor", r[0], r[1], PIT, r[2], r[3], 0.0, hide=("bottom",))

_pit_ccw = ms.signed_area(PIT_POLY) > 0
_n = len(PIT_POLY)


def _turn(i):
    """Turn at vertex i (degrees, + = convex corner of the pit), and whether an open edge meets it."""
    a, b, c = PIT_POLY[i - 1], PIT_POLY[i], PIT_POLY[(i + 1) % _n]
    a1 = math.atan2(b[1] - a[1], b[0] - a[0])
    a2 = math.atan2(c[1] - b[1], c[0] - b[0])
    d = math.degrees((a2 - a1 + math.pi) % (2 * math.pi) - math.pi)
    return d if _pit_ccw else -d


_rim_polys = []
for i in range(_n):
    if i in PIT_OPEN:
        continue
    a, b = PIT_POLY[i], PIT_POLY[(i + 1) % _n]
    # right of the edge is outside the pit for a counter-clockwise outline; offsets are measured to the right
    sgn = 1.0 if _pit_ccw else -1.0
    ends = []
    for v in (i, (i + 1) % _n):
        open_here = (v - 1) % _n in PIT_OPEN or v in PIT_OPEN
        t = _turn(v)
        ends.append(0.0 if open_here or t <= 0 else math.tan(math.radians(min(t, 100.0)) / 2))
    wall = ms.segment_rect(a, b, sgn * -BANK_IN, sgn * BANK_T, ends[0] * BANK_T, ends[1] * BANK_T)
    cap = ms.segment_rect(a, b, sgn * BANK_T, sgn * (BANK_T + CAP_W), ends[0] * (BANK_T + CAP_W),
                          ends[1] * (BANK_T + CAP_W))
    k = i % 3
    for nm, quad, z0, z1, hide in (("n3_bank_%02d" % i, wall, PIT, 0.07 + 0.004 * k, ("bottom", "-y" if sgn > 0 else "+y")),
                                   ("n3_lip_%02d" % i, cap, 0.0, 0.055 + 0.004 * k, ("bottom", "+y" if sgn > 0 else "-y"))):
        cx, cy, ln, wd, ang = ms.rect_frame(quad)
        axis_aligned = abs(math.sin(math.radians(ang) * 2)) < 1e-9
        if axis_aligned:
            xs = [p[0] for p in quad]
            ys = [p[1] for p in quad]
            m.visual(nm, "floor", (min(xs), min(ys), z0), (max(xs), max(ys), z1))
        else:
            m.visual(nm, "floor", (cx - ln / 2, cy - wd / 2, z0), (cx + ln / 2, cy + wd / 2, z1), yaw=ang, hide=hide)
    # one convex outline for bank and lip together
    full = ms.segment_rect(a, b, sgn * -BANK_IN, sgn * (BANK_T + CAP_W), ends[0] * (BANK_T + CAP_W),
                           ends[1] * (BANK_T + CAP_W))
    _rim_polys.append(full)

for poly in _rim_polys:
    for r in ms.cover([poly], overhang=0.2, max_strip=1.0):
        box(uid("n3_rim"), "pit_rim", r[0], r[1], PIT, r[2], r[3], RIM_TOP, hide=("all",))

# stairs out of the pit (5 steps of 0.2 m, 0.45 m treads, then the ground)
m.flight("n3_stair_north", 28.45 + BANK_IN, 30.15 - BANK_IN, -18.75, -1, PIT, 0.0, RISE, TREAD, axis="x",
         category="pit_stairs")
m.flight("n3_stair_east", 20.15 + BANK_IN, 21.85 - BANK_IN, -15.75, 1, PIT, 0.0, RISE, TREAD, axis="x",
         category="pit_stairs")
m.flight("n3_stair_south", -19.85 + BANK_IN, -18.15 - BANK_IN, 10.75, -1, PIT, 0.0, RISE, TREAD, axis="y",
         category="pit_stairs")

# =============================================================================================
# Walls (thin lines in the image), north to south
# =============================================================================================
# north
wy("n_wall_x322", 322, Y(172), Y(30))
BIG_T = ms.union_rects([px_rect(367, 94, 501, 115, 3), px_rect(367, 116, 659, 166, 3), px_rect(617, 167, 638, 187, 3),
                        px_rect(434, 168, 507, 289, 3), px_rect(434, 290, 522, 301, 3)])
wy("n_wall_x502", 502, Y(91), Y(60))                                   # stops on the big T block
NE_L = ms.union_rects([px_rect(719, 113, 849, 186, 3), px_rect(796, 187, 844, 295, 3)])
wy("ne_wall_x826", 826, Y(110), Y(30))                                 # from the outer wall to the NE block
wy("bus_side_wall_x574", 574, Y(355), Y(252))
# the closed room north-east of the north barrack (walls ne_a_corner and ne_a_room, nothing inside):
# one solid; the corner wall continues north to the NE block
wy("ne_a_corner_wall", 798, Y(366) + HT, Y(298))
A_N = Y(416)                       # north barrack, north wall centre
A_N_OUT = A_N + HT
block("ne_a_room", "inner_wall", (X(754) - HT, A_N_OUT, X(798) + HT, Y(366) + HT), WALL_H)
block("ne_a_room_corner", "inner_wall", (X(798) + HT, A_N_OUT, X(818) + HT, Y(393) + HT), WALL_H)

# A yard (west of the barracks)
YARD_N = Y(410)
wx("yard_n_wall_y410", 410, X(417), X(580) - HT)
wy("yard_n_wall_x389", 389, Y(478), Y(420))                            # stops on the L block
L_WEST_A = px_rect(274, 478, 393, 503)
L_WEST_B = px_rect(274, 503, 427, 533)
wy("yard_w_wall_x311_a", 311, Y(540), L_WEST_B[1])
YARD_S = Y(713)
wy("yard_w_wall_x311_b", 311, YARD_S - HT, Y(574))
wx("yard_s_wall_1", 713, X(311) + HT, X(387))
wx("yard_s_wall_2", 713, X(420), X(514))
wx("yard_s_wall_3", 706, X(546), X(580) - HT)               # drawn 5 px lower: in line with the barrack wall
wy("n18_west_post", 350, Y(745), YARD_S - HT)
wy("n18_east_post", 483, Y(745), YARD_S - HT)

# =============================================================================================
# A building: barracks 4 (north, Site A) and 5 (south), block 6 with its roof, the passage under
# roof 6 with hole 7, crouch openings 8 and 9, main entrance 25, the east window by box 16
# =============================================================================================
A_W, A_E, A_S = X(580), X(818), Y(706)
A_M4, A_M5 = Y(527), Y(596)                 # barrack 4 south wall, barrack 5 north wall (centres)
A_W_IN, A_E_IN = A_W + HT, A_E - HT
A_N_IN, A_S_IN = A_N - HT, A_S + HT
PASS_W = X(709) + HT                        # passage: from block 6's east face ...
PASS_E = X(778) - HT                        # ... to the closed east room
UPPER_E = X(769)                            # the walls above the passage roof end here (preview)
C8 = (X(620), X(642))                       # crouch opening 8 (1.54 m)
C9 = (X(632) - 0.7, X(632) + 0.7)           # crouch opening 9, widened from 1.12 m to 1.4 m (MIN_WALKWAY)
E25 = (Y(473), Y(445))                      # main entrance 25 (1.96 m)
W16 = (Y(489), Y(457))                      # east window over box 16 (2.24 m)

# west wall: entrance 25 is open to full height; from y 532 to 597 block 6 is the wall
wy("a_west_wall_n", 580, E25[1], YARD_N + HT)
wy("a_west_wall_mid", 580, A_M4 + HT, E25[0])
wy("a_west_wall_s", 580, A_S + HT, A_M5 - HT)
# north wall with crouch opening 8
wx("a_north_wall_w", 416, A_W + HT, C8[0])
wx("n8_crouch_lintel", 416, C8[0], C8[1], WALL_H, CROUCH_CLEAR)
wx("a_north_wall_e", 416, C8[1], A_E + HT)
# east wall with the window sill
wy("a_east_wall_n", 818, W16[1], A_N - HT)
wy("n16_window_sill", 818, W16[0], W16[1], EAST_SILL_H)
wy("a_east_wall_s", 818, A_S + HT, W16[0])
# south wall with crouch opening 9
wx("a_south_wall_w", 706, A_W - HT, C9[0])
wx("n9_crouch_lintel", 706, C9[0], C9[1], WALL_H, CROUCH_CLEAR)
wx("a_south_wall_e", 706, C9[1], A_E + HT)
# middle walls: barrack 4's south wall and barrack 5's north wall; over the passage only above its roof
for tag, py in (("n4", 527), ("n5", 596)):
    wx("%s_mid_wall_w" % tag, py, A_W - HT, PASS_W)
    wx("%s_mid_wall_upper" % tag, py, PASS_W, UPPER_E, WALL_H, ROOF6_TOP - ROOF6_T)
    wx("%s_mid_wall_e" % tag, py, UPPER_E, A_E_IN)
# block 6: closed under its roof (its 0.5 m slot in the drawn east wall is too narrow for a player), so
# solid; its top is roof 6 (2.0 m), one step from box 10
block("n6_block", "inner_wall", (A_W - HT, A_M5 + HT, PASS_W, A_M4 - HT), ROOF6_TOP)
# the closed east room (no entrance in the drawing): solid
block("a_east_room", "inner_wall", (PASS_E, A_M5 + HT, A_E_IN, A_M4 - HT), WALL_H)
# roof 6 over the passage, with hole 7
H7 = px_rect(728, 543, 772, 581)
P_N, P_S = A_M4 - HT, A_M5 + HT
for nm, r in (("n6_roof_w", (PASS_W, P_S, H7[0], P_N)), ("n6_roof_e", (H7[2], P_S, PASS_E, P_N)),
              ("n6_roof_n", (H7[0], H7[3], H7[2], P_N)), ("n6_roof_s", (H7[0], P_S, H7[2], H7[1]))):
    block(nm, "platform", r, ROOF6_TOP, ROOF6_TOP - ROOF6_T)
# barrack roofs, between the walls
block("n4_roof", "roof", (A_W_IN, A_M4 + HT, A_E_IN, A_N_IN), BARRACK_ROOF_TOP, BARRACK_ROOF_TOP - ROOF_T)
block("n5_roof", "roof", (A_W_IN, A_S_IN, A_E_IN, A_M5 - HT), BARRACK_ROOF_TOP, BARRACK_ROOF_TOP - ROOF_T)

# ---- crates in barrack 4 (owner-approved sizes; crates within half a metre of a wall or of each
# other are pushed against it, so no gap under MIN_WALKWAY is left between them) --------------------
B4_S = A_M4 + HT
B5_N = A_M5 - HT
block("crate_a4_desk_nw", "crate", (A_W_IN, Y(437), X(615), A_N_IN), CRATE_SQUARE_H)
block("crate_a4_bench_n", "crate", (X(652), Y(429), X(697), A_N_IN), CRATE_LONG_H)
block("crate_a4_post", "crate", px_rect(661, 462, 669, 483), CRATE_LONG_H)
block("crate_a4_post_w", "crate", (A_W_IN, Y(506), X(594), Y(490)), CRATE_SQUARE_H)
block("crate_a4_box_sw", "crate", (A_W_IN, B4_S, X(605), Y(506)), CRATE_SQUARE_H)
block("crate_a4_bench_s", "crate", (X(605), B4_S, X(651), Y(511)), CRATE_LONG_H)
block("crate_a4_small_s", "crate", (X(651), B4_S, X(665), Y(510)), CRATE_SQUARE_H)
BOX16 = (X(800), Y(491), A_E_IN, Y(444))
block("n16_jump_box_east", "crate", BOX16, JUMP_H)
block("crate_a4_ne_corner", "crate", (X(796.5), BOX16[3], A_E_IN, A_N_IN), CRATE_SQUARE_H)
block("crate_a4_se_corner", "crate", (X(801), B4_S, A_E_IN, BOX16[1]), CRATE_SQUARE_H)
block("crate_a4_se_corner_w", "crate", (X(788), B4_S, X(801), Y(513)), CRATE_SQUARE_H)   # 1.5 m from box 16
angled("crate_a4_tilted_table", "crate", "crate",
       [ms.turned_rect(X(722), Y(473.5), 37 * S, 25.4 * S, -97.8)], CRATE_SQUARE_H)
# small tilted crate: moved 0.6 m east against the north-east corner crate and 0.12 m north to the wall
_st = ms.turned_rect(X(776.4) + 0.6, Y(425.8) + 0.12, 22 * S, 9 * S, -10.0)
_dx = X(796.5) - max(p[0] for p in _st)
_dy = A_N_IN - max(p[1] for p in _st)
angled("crate_a4_small_tilted", "crate", "crate", [[(p[0] + _dx, p[1] + _dy) for p in _st]], CRATE_LONG_H,
       extend=((0, X(796.5)), (1, A_N_IN)))

# ---- crates in barrack 5 ----
block("crate_a5_box", "crate", (X(690), Y(618), X(709), B5_N), CRATE_SQUARE_H)
block("crate_a5_bench", "crate", (X(648), A_S_IN, X(731), A_S_IN + 24 * S), CRATE_LONG_H)
_t5 = ms.turned_rect(X(764.1), Y(683.9), 25 * S, 15 * S, 8.3)
_dy5 = A_S_IN - min(p[1] for p in _t5)
_dx5 = (X(731) + 1.41) - min(p[0] for p in _t5)
angled("crate_a5_tilted", "crate", "crate", [[(p[0] + _dx5, p[1] + _dy5) for p in _t5]], CRATE_SQUARE_H,
       extend=((1, A_S_IN),))
block("crate_a5_box_e", "crate", (A_E_IN - 17 * S, A_S_IN, A_E_IN, A_S_IN + 20 * S), CRATE_SQUARE_H)

# outside the south barrack: the small closed room (solid), the long bar and the corner box
A_S_OUT = A_S - HT
SMALL_ROOM = (X(655) - HT, Y(727) - HT, X(689), A_S_OUT)
block("a_south_small_room", "inner_wall", SMALL_ROOM, WALL_H)
block("n24_a_south_bar", "inner_wall", (X(689), Y(728), A_E + HT, A_S_OUT), WALL_H)
block("n24_a_se_box", "inner_wall", (A_E + HT, Y(744), X(838), Y(715)), WALL_H)     # east pad left off: 1.4 m to the walkway corner

# box 10: from the ground onto it, then onto roof 6
block("n10_jump_box_to_roof6", "crate", (X(549), Y(574), A_W - HT, Y(556)), JUMP_H)

# =============================================================================================
# East route: raised walkway 13, plank stairs 14 and 15, jump boxes at both ends
# =============================================================================================
WALK_X0, WALK_X1 = X(852), X(900)
WALK_N, WALK_S = Y(380), Y(700)
CORR_X0 = A_E + HT                          # the ground corridor between the barracks and the walkway
block("n13_raised_walkway", "platform", (WALK_X0, WALK_S, WALK_X1, WALK_N), RAISED_H)
block("n13_walkway_bay", "platform", (WALK_X1, Y(596), X(918), Y(526)), RAISED_H)   # fills the outer wall's bay
# Between the two plank tops the drawing closes the ground corridor with two short walls; that pocket
# could be dropped into from the walkway and never left, so it is filled to walkway height instead.


def plank(name, y_top, direction):
    """Stairs (hidden) up the walkway's west side across the whole corridor, ending at y_top (where the
    drawing's plank meets the walkway), under a visual board ramp whose surface stays at or below every
    step, so nobody sinks into it.

    The stairs fill the corridor (2.25 m) because a narrower plank leaves a slot beside it under
    MIN_WALKWAY. They keep the drawn top end but are 2.25 m long, not the drawn 4.5 m: plank 14 would
    otherwise pass the east window, and from its steps the 1.2 m sill could be jumped onto from
    outside, making the window (one way out, by box 16) a way in."""
    y_low = y_top - direction * PLANK_TREAD * 5
    top = m.flight(name, CORR_X0, WALK_X0, y_low, direction, 0.0, RAISED_H, RISE, PLANK_TREAD, axis="y",
                   hide=("all",))
    run = PLANK_TREAD * 6
    ang = math.degrees(math.atan2(RAISED_H, run))
    thick = 0.06
    length = math.hypot(run, RAISED_H)
    cy = y_low + direction * run / 2
    cz = RAISED_H / 2 - thick / 2 / math.cos(math.radians(ang))
    nb = 7
    gap = 0.04
    width = WALK_X0 - CORR_X0
    bw = (width - gap * (nb - 1)) / nb
    for k in range(nb):
        x0 = CORR_X0 + k * (bw + gap)
        m.visual("%s_board_%d" % (name, k + 1), "crate", (x0, cy - length / 2, cz - thick / 2),
                 (x0 + bw, cy + length / 2, cz + thick / 2), pitch=ang * direction, hide=("bottom",))
    return top


P14_TOP = plank("n14_plank_north", Y(530), -1)
P15_TOP = plank("n15_plank_south", Y(592), 1)
block("n13_walkway_west", "platform", (CORR_X0, P15_TOP, WALK_X0, P14_TOP), RAISED_H)
EC_BOX = (X(873), WALK_N, WALK_X1, Y(348))
block("n24_east_corridor_box", "inner_wall", EC_BOX, WALL_H)
block("n13_jump_box_north_end", "crate", (WALK_X0, WALK_N, EC_BOX[0], Y(364)), JUMP_H)
block("n13_jump_box_south_end", "crate", (X(880), Y(716), WALK_X1, WALK_S), JUMP_H)

# =============================================================================================
# Blocks (24: tall, cannot be climbed) and other solids
# =============================================================================================
for k, r in enumerate(BIG_T):
    block("n24_big_t_north_%d" % k, "inner_wall", r, WALL_H)
for k, r in enumerate(NE_L):
    block("n24_ne_l_%d" % k, "inner_wall", r, WALL_H)
for k, r in enumerate(ms.union_rects([(X(301), Y(156), X(322) - HT, Y(111)), (X(282), Y(169), X(322) - HT, Y(152))])):
    block("n24_nw_small_l_%d" % k, "inner_wall", r, WALL_H)
block("n24_east_alcove", "inner_wall", px_rect(884, 186, 930, 198, 3), WALL_H)
WEST_L = ms.union_rects([px_rect(76, 193, 110, 321, 3), px_rect(72, 322, 186, 375, 3)])
for k, r in enumerate(WEST_L):
    block("n24_west_l_%d" % k, "inner_wall", r, WALL_H)
CENTRE_L = ms.union_rects([px_rect(295, 256, 380, 331, 3), px_rect(295, 332, 345, 430, 3)])
for k, r in enumerate(CENTRE_L):
    block("n24_centre_l_%d" % k, "inner_wall", r, WALL_H)
block("n24_box_by_b_south", "inner_wall", (X(297), Y(253), X(323), Y(232)), WALL_H)      # down to the centre L
block("n24_west_small", "inner_wall", (X(51), Y(261), X(73), Y(238)), WALL_H)             # against the west L
BUS = (X(574) + HT, Y(291), X(718), Y(262))
block("n12_school_bus", "vehicle", BUS, BUS_H, tint=(1.0, 0.78, 0.25))
block("n24_post_by_bus", "inner_wall", (X(574) + HT, Y(301), X(587), BUS[1]), WALL_H)
block("n24_post_north", "inner_wall", (X(652), Y(113), X(658), Y(103)), WALL_H)
block("n24_ne_small", "inner_wall", (X(798) + HT, Y(319), X(827), Y(298)), WALL_H)
for k, r in enumerate(ms.union_rects([px_rect(693, 364, 719, 394, 3), (X(654), A_N_OUT, X(754) - HT, Y(393))])):
    block("n24_t_north_of_a_%d" % k, "inner_wall", r, WALL_H)
block("n24_block_north_yard", "inner_wall", (X(420), YARD_N + HT, X(496), Y(382)), WALL_H)

# west and centre
LONG_WALL = px_rect(102, 455, 236, 489, 3)
block("n20_long_wall", "inner_wall", LONG_WALL, WALL_H)
block("n24_west_post", "inner_wall", (X(218), LONG_WALL[3], X(236), Y(430)), WALL_H)
block("n24_west_wall_box", "inner_wall", (X(28), Y(480), X(72), Y(448)), WALL_H)
block("n24_l_west_yard_a", "inner_wall", L_WEST_A, WALL_H)
block("n24_l_west_yard_b", "inner_wall", L_WEST_B, WALL_H)
# box 21 fills the gap between the long wall and the yard L: jump over it
block("n21_jump_box_in_gap", "crate", (LONG_WALL[2], LONG_WALL[1], L_WEST_A[0], L_WEST_A[3]), JUMP_H)
block("n24_yard_box", "inner_wall", px_rect(390, 641, 423, 654, 3), WALL_H)
block("n24_post_yard_sw", "inner_wall", (X(301), YARD_S, X(311) - HT, Y(707)), WALL_H)
block("n24_sw_box", "inner_wall", (X(194), Y(725), X(219), Y(698)), WALL_H)
block("n19_trailer_east", "vehicle", (X(185) + 0.23, Y(621), X(222) + 0.23, Y(602)), HUMAN_H, tint=(0.75, 0.82, 0.9))

# south
HOUSE_N, HOUSE_STEP, HOUSE_S = Y(775), Y(830), Y(887)
HOUSE_W, HOUSE_MID, HOUSE_E = X(347), X(482), X(671)
block("n18_low_box", "crate", (X(423), HOUSE_N + HT, X(483) - HT, YARD_S - HT), LOW_COVER_H)
wy("house_s_wall_x367", 367, Y(973), HOUSE_S - HT)
wy("se_wall_x666", 666, HOUSE_STEP + HT, SMALL_ROOM[1])
block("n24_box_by_van_wall", "inner_wall", (X(646), HOUSE_STEP + HT, X(666) - HT, Y(803)), WALL_H)
block("n26_van", "vehicle", px_rect(765, 794, 787, 879, 3), VAN_H, tint=(0.62, 0.7, 0.8))
block("n24_se_box_on_wall", "inner_wall", (X(758), Y(963), X(809), Y(942)), WALL_H)
block("n24_s_box_on_wall", "inner_wall", (X(538), Y(973), X(563), Y(950)), WALL_H)
block("n24_s_post_a", "inner_wall", (X(662), Y(973), X(669), Y(962)), WALL_H)
block("n24_s_post_b", "inner_wall", (X(714), Y(963), X(728), Y(954)), WALL_H)
block("n23_jump_box_south", "crate", (X(367) + HT, Y(937), X(394), Y(915)), JUMP_H)

# house 17: walls 3.0 m with three doors 1.7 m wide and 2.3 m high, a roof slab on top
DW = 0.85
D_WEST, D_SW, D_SE = Y(862), X(504), X(617)
wx("n17_wall_n_w", 775, HOUSE_W - HT, HOUSE_MID + HT, HOUSE_H)
wy("n17_wall_step", 482, HOUSE_STEP - HT, HOUSE_N - HT, HOUSE_H)
wx("n17_wall_n_e", 830, HOUSE_MID + HT, HOUSE_E + HT, HOUSE_H)
wy("n17_wall_e", 671, HOUSE_S + HT, HOUSE_STEP - HT, HOUSE_H)
wy("n17_wall_w_n", 347, D_WEST + DW, HOUSE_N - HT, HOUSE_H)
wy("n17_door_w_top", 347, D_WEST - DW, D_WEST + DW, HOUSE_H, DOOR_H)
wy("n17_wall_w_s", 347, HOUSE_S + HT, D_WEST - DW, HOUSE_H)
wx("n17_wall_s_1", 887, HOUSE_W - HT, D_SW - DW, HOUSE_H)
wx("n17_door_sw_top", 887, D_SW - DW, D_SW + DW, HOUSE_H, DOOR_H)
wx("n17_wall_s_2", 887, D_SW + DW, D_SE - DW, HOUSE_H)
wx("n17_door_se_top", 887, D_SE - DW, D_SE + DW, HOUSE_H, DOOR_H)
wx("n17_wall_s_3", 887, D_SE + DW, HOUSE_E + HT, HOUSE_H)
block("n17_roof_w", "roof", (HOUSE_W - HT, HOUSE_S - HT, HOUSE_MID + HT, HOUSE_N + HT), HOUSE_H + ROOF_T, HOUSE_H)
block("n17_roof_e", "roof", (HOUSE_MID + HT, HOUSE_S - HT, HOUSE_E + HT, HOUSE_STEP + HT), HOUSE_H + ROOF_T, HOUSE_H)

# =============================================================================================
# Angled shapes: oriented visual boxes over hidden collision that follows them
# =============================================================================================
APV = ms.turned_rect(X(479.9), Y(571.6), 83 * S, 24 * S, 25.8)
APV_NUB = ms.turned_rect(X(479.3), Y(547.5), 16.8 * S, 19.5 * S, 26.6)
angled("n11_apv", "metal", "vehicle", [APV, APV_NUB], APV_H, tint=(0.5, 0.62, 0.52), overhang=0.25)
angled("n19_trailer_west", "metal", "vehicle", [ms.turned_rect(X(140.4), Y(604.7), 52.8 * S, 19.7 * S, -12.0)],
       HUMAN_H, tint=(0.75, 0.82, 0.9))

# short walls by B (22), player height: the straight parts are boxes, the two slanted ends are angled
wy("n22_short_wall_a", 206, Y(140), Y(106) - HT, HUMAN_H)
wx("n22_short_wall_b", 106, X(177) - HT, X(206) + HT, HUMAN_H)
wy("n22_short_wall_c", 177, Y(212) - HT, Y(106) - HT, HUMAN_H)
wx("n22_short_wall_d", 212, X(160) - HT, X(177) - HT, HUMAN_H)
SW_E = [(X(160) - HT, Y(226)), (X(160) + HT, Y(226)), (X(160) + HT, Y(212) - HT), (X(160) - HT, Y(212) - HT)]
SW_F = ms.segment_rect((X(160), Y(226)), (X(184), Y(239)), -HT, HT, HT, 0.0)
SW_G = ms.segment_rect((X(203), Y(241)), (X(211), Y(237)), -HT, HT, 0.0, 0.0)
POST_C, POST_R = (X(193.5), Y(245)), 11.5 * S
# an octagon as the union of a cross and four turned boxes on its diagonal edges (tops 1 cm apart)
_k = math.tan(math.radians(22.5))
_post_vis = [dict(cx=POST_C[0], cy=POST_C[1], ln=2 * POST_R, wd=2 * POST_R * _k, ang=0.001, z0=0.0, z1=HUMAN_H),
             dict(cx=POST_C[0], cy=POST_C[1], ln=2 * POST_R * _k, wd=2 * POST_R, ang=0.001, z0=0.0, z1=HUMAN_H - 0.01)]
for q in range(4):
    a = math.radians(45 + 90 * q)
    edge = POST_R * (1 - _k) * math.sqrt(2)          # length of the diagonal edge
    depth = POST_R * (1 - _k) / math.sqrt(2)         # from that edge to the cross's inner corner
    r = POST_R - depth / 2
    _post_vis.append(dict(cx=POST_C[0] + r * math.cos(a), cy=POST_C[1] + r * math.sin(a), ln=edge, wd=depth,
                          ang=math.degrees(a) + 90, z0=0.0, z1=HUMAN_H - 0.015))
# collision for the round post (the octagon above), the slanted walls F and G that meet it, wall e and the pocket:
# one cover, so their collision boxes do not overlap
_oct = [(POST_C[0] + POST_R / math.cos(math.radians(22.5)) * math.cos(math.radians(22.5 + 45 * k)),
         POST_C[1] + POST_R / math.cos(math.radians(22.5)) * math.sin(math.radians(22.5 + 45 * k))) for k in range(8)]
_f_vis = dict(zip(("cx", "cy", "ln", "wd", "ang"), ms.rect_frame(SW_F)), z0=0.0, z1=HUMAN_H)
_g_vis = dict(zip(("cx", "cy", "ln", "wd", "ang"), ms.rect_frame(SW_G)), z0=0.0, z1=HUMAN_H)
_e_vis = dict(cx=X(160), cy=(Y(226) + Y(212) - HT) / 2, ln=Y(212) - HT - Y(226), wd=T, ang=90.0, z0=0.0, z1=HUMAN_H - 0.005)
# Wall c is carried on down to wall F: the drawing leaves a 1.05 m gap there into a small pocket between
# walls d, e and F (a slot under MIN_WALKWAY); closed, the pocket is simply solid wall outline.
_f_mid = (X(177), Y(226) + (Y(239) - Y(226)) * (177 - 160) / (184 - 160))
SW_C2 = [(X(177) - HT, _f_mid[1]), (X(177) + HT, _f_mid[1]), (X(177) + HT, Y(212) - HT), (X(177) - HT, Y(212) - HT)]
_c2_vis = dict(cx=X(177), cy=(_f_mid[1] + Y(212) - HT) / 2, ln=Y(212) - HT - _f_mid[1], wd=T, ang=90.0, z0=0.0,
               z1=HUMAN_H - 0.005)
def _fy(x):
    return Y(226) + (Y(239) - Y(226)) * (x - X(160)) / (X(184) - X(160))


SW_POCKET = [(X(160) + HT, Y(212) - HT), (X(177) - HT, Y(212) - HT), (X(177) - HT, _fy(X(177) - HT)),
             (X(160) + HT, _fy(X(160) + HT))]
angled("n22_post_and_slants", "wall_inner", "inner_wall", [_oct, SW_F, SW_G, SW_E, SW_C2, SW_POCKET], HUMAN_H, overhang=0.2,
       axis=0, strip=0.3, visuals=_post_vis + [_f_vis, _g_vis, _e_vis, _c2_vis])

# the tilted tall block inside the short walls' U: its collision fills the U from its lowest corner
# up (the strips beside it are under 0.25 m, too narrow for anyone)
_tb = ms.turned_rect(X(191.5), Y(137), 27.5 * S, 10.8 * S, -71.0)
_cx0, _cx1 = X(177) + HT, X(206) - HT
_top = Y(106) - HT
cx, cy, ln, wd, ang = ms.rect_frame(_tb)
m.visual("n24_tilted_box_by_b", "wall_inner", (cx - ln / 2, cy - wd / 2, 0.0), (cx + ln / 2, cy + wd / 2, WALL_H),
         yaw=ang, hide=("bottom",))
box("n24_tilted_box_by_b_c01", "inner_wall", _cx0, min(p[1] for p in _tb), 0.0, _cx1, _top, WALL_H, hide=("all",))

# (The preview's short curved line on the T block north of A, t_block_curve, is left out: it was an
# unlabelled mark, and as a wall it would narrow the way between the T block and the closed room to
# 1.15 m, under MIN_WALKWAY.)

# =============================================================================================
# Allowed low ceilings
# =============================================================================================
m.low_ceiling("n8_crouch_opening", (C8[0] - 0.4, A_N - 0.6, -0.01), (C8[1] + 0.4, A_N + 0.6, 0.01), CROUCH_CLEAR,
              crouch=True)
m.low_ceiling("n9_crouch_opening", (C9[0] - 0.4, A_S - 0.6, -0.01), (C9[1] + 0.4, A_S + 0.6, 0.01), CROUCH_CLEAR,
              crouch=True)
m.low_ceiling("passage_under_roof6", (PASS_W - 0.3, P_S - 0.6, -0.01), (PASS_E + 0.3, P_N + 0.6, 0.01),
              ROOF6_TOP - ROOF6_T)

# =============================================================================================
# Gameplay: spawns, sites, checks
# =============================================================================================
for x in (-24.4, -23.2, -22.0, -20.8, -19.6):
    m.spawn("ghosts", x, Y(945), 0.0, 0.0)
for x in (17.2, 18.4, 19.6, 20.8, 22.0):
    m.spawn("defenders", x, Y(45), 0.0, 180.0)
m.site("A", (X(672), Y(520)), (X(780), Y(434)), 0.0)          # the plant spot inside the north barrack
m.site("B", (X(228), Y(290)), (X(257), Y(185)), PIT)          # the pit floor
m.max_sightline = 64.0           # measured 63.4 m: the west lane from south of the house to the north end of B

# Distinct ways into each site, checked by the verifier: each gate alone connects the ghost spawn to the
# site, and with every gate closed the site cannot be reached. (x0, y0, z0, x1, y1, z1)
_roof = (A_W - HT - 0.01, P_S, ROOF6_TOP - 0.05, PASS_E, P_N, ROOF6_TOP + 0.05)
m.route_gates = {
    "A": [("main entrance 25 (west door)", (A_W - 0.5, E25[0], -0.1, A_W + 0.5, E25[1], 0.1)),
          ("crouch opening 8 (north wall)", (C8[0], A_N - 0.3, -0.1, C8[1], A_N + 0.3, 0.1)),
          ("crouch opening 9 (south barrack, passage)", (C9[0], A_S - 0.3, -0.1, C9[1], A_S + 0.3, 0.1)),
          ("box 10, roof 6, drop through hole 7", _roof)],
    "B": [("south stair", (-19.85, 8.5, -1.25, -18.15, 10.75, 0.05)),
          ("east stair", (-15.75, 20.15, -1.25, -13.5, 21.85, 0.05)),
          ("north stair", (-21.0, 28.45, -1.25, -18.75, 30.15, 0.05)),
          ("a drop off the rim", (PIT_WINDOW[0], PIT_WINDOW[1], RIM_TOP - 0.01, PIT_WINDOW[2], PIT_WINDOW[3], RIM_TOP + 0.01))],
}

# =============================================================================================
# Paint: site markings and letters (Test Map 1's style)
# =============================================================================================
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
m.floor_text("A", (13.4, 2.6), 0.0, 2.2, PAINT["A"]["line"], up=(0, 1), stroke=0.2)
m.floor_text("B", (-18.02, 19.2), PIT, 1.6, PAINT["B"]["line"], up=(0, 1), stroke=0.18)
SIGN = (0.82, 0.8, 0.74)
for letter, centre, axis, sign in (("A", (A_W - HT, 5.1, 1.75), 0, -1),          # west wall, beside entrance 25
                                   ("A", (12.5, A_N + HT, 1.75), 1, 1),          # north wall, east of crouch 8
                                   ("B", (X(292), 15.4, 1.75), 0, -1)):          # centre L block, facing the pit
    m.wall_rect(centre, axis, sign, 1.7, 2.1, SIGN, layer=0)
    m.wall_text(letter, centre, axis, sign, 1.6, PAINT[letter]["line"], stroke=0.2)

# B stairs: alternating tread tint and a yellow nosing on every step, as on Test Map 1
YELLOW = (0.95, 0.72, 0.05)
DARK_PAINT = (0.07, 0.07, 0.08)
by_name = {b["name"]: b for b in m.boxes}
for fl in m.flights:
    if not fl["name"].startswith("n3_"):
        continue
    for k, nm in enumerate(fl["steps"]):
        b = by_name[nm]
        b["tint"] = (1.0, 1.0, 1.0) if k % 2 else (0.74, 0.74, 0.78)
        (bx0, by0, _bz0), (bx1, by1, top) = b["mn"], b["mx"]
        if fl["axis"] == "y":       # south stair climbs toward -Y: the nosing is the step's -Y edge
            m.floor_rect(bx0 + 0.05, by0, bx1 - 0.05, by0 + 0.08, top, YELLOW)
        elif fl["name"].endswith("north"):      # climbs toward -X
            m.floor_rect(bx0, by0 + 0.05, bx0 + 0.08, by1 - 0.05, top, YELLOW)
        else:                                   # east stair climbs toward +X
            m.floor_rect(bx1 - 0.08, by0 + 0.05, bx1, by1 - 0.05, top, YELLOW)
# the walkway's open west edge and the edges of roof 6 by hole 7: drops, marked yellow
m.floor_rect(WALK_X0, P14_TOP + 0.05, WALK_X0 + 0.1, WALK_N - 0.05, RAISED_H, YELLOW)
m.floor_rect(WALK_X0, WALK_S + 0.05, WALK_X0 + 0.1, P15_TOP - 0.05, RAISED_H, YELLOW)
m.floor_rect(H7[0] - 0.1, H7[1], H7[0], H7[3], ROOF6_TOP, YELLOW)
m.floor_rect(H7[2], H7[1], H7[2] + 0.1, H7[3], ROOF6_TOP, YELLOW)
m.floor_rect(H7[0], H7[3], H7[2], H7[3] + 0.1, ROOF6_TOP, YELLOW)
m.floor_rect(H7[0], H7[1] - 0.1, H7[2], H7[1], ROOF6_TOP, YELLOW)

# stains and oil spots on the open ground
STAIN = (0.3, 0.29, 0.27)
for cx, cy, sx, sy in ((-2.0, -9.0, 1.4, 0.9), (2.5, 12.0, 1.0, 1.3), (-26.0, -3.0, 1.2, 1.1), (16.0, -20.0, 1.5, 0.8),
                       (-4.0, -30.0, 1.0, 0.9), (24.0, 18.0, 0.9, 0.7), (-6.0, 23.0, 1.1, 0.8), (8.0, -18.0, 0.8, 0.6)):
    m.floor_rect(cx - sx / 2, cy - sy / 2, cx + sx / 2, cy + sy / 2, 0.0, STAIN, layer=0)

# =============================================================================================
# Visual-only detail: copings on thin tall walls (not the walls beside roof 6, where a player stands
# within reach of their tops, nor the house walls under their roof), ceiling fixtures, wall lamps
# =============================================================================================
COPING = (0.62, 0.6, 0.56)
for b in list(m.boxes):
    if b["category"] not in ("outer_wall", "inner_wall") or "all" in b["hide"]:
        continue
    (x0, y0, z0), (x1, y1, z1) = b["mn"], b["mx"]
    if min(x1 - x0, y1 - y0) > 0.6 or z1 < 3.4 or b["name"].startswith(("n4_mid", "n5_mid", "n17_")):
        continue
    o = 0.05
    m.visual(b["name"] + "_cap", "wall_inner", (x0 - o, y0 - o, z1), (x1 + o, y1 + o, z1 + 0.1), COPING)

WARM = (1.0, 0.75, 0.5)
COLD = (0.78, 0.88, 1.0)


def fixture(name, x, y, z_top, colour, power, w=1.2, d=0.2):
    m.visual(name, "metal", (x - w / 2, y - d / 2, z_top - 0.08), (x + w / 2, y + d / 2, z_top), (1.0, 1.0, 1.0))
    m.area_light((x, y, z_top - 0.2), (w, d), colour, power)


CEIL_A = BARRACK_ROOF_TOP - ROOF_T
for k, (x, y) in enumerate(((9.0, 2.0), (14.0, 3.6), (14.0, 0.0), (19.0, 2.0))):        # barrack 4 (Site A)
    fixture("lamp_a4_%d" % k, x, y, CEIL_A, COLD, 110.0)
for k, (x, y) in enumerate(((9.0, -10.6), (14.0, -10.6), (19.0, -10.6))):                # barrack 5
    fixture("lamp_a5_%d" % k, x, y, CEIL_A, COLD, 100.0)
for k, (x, y) in enumerate(((-8.0, -23.0), (-3.5, -25.0), (2.5, -25.0), (8.0, -25.0))):  # house 17
    fixture("lamp_house_%d" % k, x, y, HOUSE_H, WARM, 90.0)


def wall_lamp(name, x, y, nx, ny, colour, power, z=3.1):
    w, d = 0.5, 0.18
    if nx:
        mn, mx = (x if nx > 0 else x - d, y - w / 2, z), (x + d if nx > 0 else x, y + w / 2, z + 0.14)
    else:
        mn, mx = (x - w / 2, y if ny > 0 else y - d, z), (x + w / 2, y + d if ny > 0 else y, z + 0.14)
    m.visual(name, "metal", mn, mx, (1.0, 1.0, 1.0))
    m.point_light((x + nx * 0.4, y + ny * 0.4, z - 0.2), colour, power, 0.12)


wall_lamp("lamp_ghost_spawn", -22.0, Y(966), 0, 1, WARM, 70.0, 3.5)
wall_lamp("lamp_defender_spawn", 19.6, Y(30), 0, -1, WARM, 70.0, 3.5)
wall_lamp("lamp_site_b", X(292), 13.0, -1, 0, (0.62, 0.75, 1.0), 90.0)
m.point_light((-18.0, 18.0, 1.6), (0.3, 0.5, 1.0), 60.0, 0.5)        # site B, in the pit: blue-ish
m.point_light((16.8, -4.3, 1.5), (1.0, 0.8, 0.6), 35.0, 0.3)         # passage under hole 7: warm

m.sample_spots = [
    ("ground sunlit (A yard)", (-2.0, -5.0, 0.0), 2, 1),
    ("wall shade (barrack west wall, outside)", (A_W - HT, -10.0, 1.5), 0, -1),
    ("barrack 4 floor (Site A)", (13.0, 0.5, 0.0), 2, 1),
    ("site B pit floor", (-18.0, 16.0, PIT), 2, 1),
    ("passage floor under hole 7", (17.5, -4.3, 0.0), 2, 1),
    ("house floor", (0.0, -25.0, 0.0), 2, 1),
    ("roof 6 top", (10.0, -4.3, ROOF6_TOP), 2, 1),
    ("walkway top", (26.0, -10.0, RAISED_H), 2, 1),
]
