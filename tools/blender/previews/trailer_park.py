"""
Trailer Park (the same map as APV Courtyard): an editable greybox PREVIEW, for visual review only.
It is not a playable map: not in tools/blender/maps/, not built by mapbuilder.py, not checked by
mapkit.py, and it writes no game files.

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup ^
        --python tools/blender/previews/trailer_park.py -- [--samples N] [--no-render] [--no-compare]
        [--only view_a,view_b]   (render just these angled views; the .blend is still saved)

Layout source of truth: docs/maps/trailer-park.webp (1000 x 1000 px, north up), read with the
owner's confirmed notes in docs/maps/trailer-park-notes.md. Every shape below was traced from that
image by measuring its pixels (filled lighter shapes = solid blocks, thin outlined lines = walls,
gaps in the lines = openings). The table is in IMAGE PIXELS (x right, y down). Numbers in names
(n10, n18 ...) are the notes' feature numbers.

Output: docs/review/maps/trailer-park/ (the .blend, overhead.png, compare_*.png, view_*.jpg,
measurements.txt).

Blender axes: X = east = image x * M_PER_PX; Y = north = (1000 - image y) * M_PER_PX; Z = up.
"""

import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

# =============================================================================================
# Scale. One factor for the whole image: 0.07 m per image px.
#   main entrance 25 (27 px) -> 1.9 m, a normal doorway
#   crouch opening 8 (22 px) -> 1.5 m and crouch opening 9 (16 px) -> 1.1 m: both pass a 0.6 m player
#   the gap in the A-yard south wall (33 px) -> 2.3 m; school bus 12 (138 x 28 px) -> 9.7 x 2.0 m;
#   jump box 10 (31 x 18 px) -> 2.2 x 1.3 m; van 26 (28 x 93 px) -> 2.0 x 6.5 m
# The image becomes 70 x 70 m (the playable area inside the outer wall is about 64 x 67 m).
# =============================================================================================
M_PER_PX = 0.07
IMG = 1000

# Player movement (shared/constants.ts), and MOUNT_MAX measured from it by
# tools/blender/previews/mount_check.ts (runs the shared stepPlayer):
HULL_HALF_WIDTH = 0.3
HULL_HEIGHT = 1.8
HULL_HEIGHT_CROUCHED = 1.2
EYE_HEIGHT = 1.62
EYE_HEIGHT_CROUCHED = 1.02
STEP_HEIGHT = 0.35
MOUNT_MAX = 1.16          # highest ledge above your feet you can jump onto (simulated with stepPlayer)

# Heights
BOUNDARY_H = 4.0          # outer wall
WALL_H = 3.5              # "tall": every thin wall line and every filled block not named otherwise (24)
HUMAN_H = 1.8             # trailers 19, short walls by B 22 (= HULL_HEIGHT)
JUMP_H = 1.0              # jump boxes 10, 16, 21, 23 (under MOUNT_MAX)
LOW_COVER_H = 1.2         # box 18: hides a crouched player (1.2), just above MOUNT_MAX so it can't be jumped
# Crates inside barracks 4 and 5 (owner-approved): small or square ones are jumpable, long or thin
# ones are crouch cover. "Long" = footprint at least CRATE_LONG_RATIO times as long as it is wide.
CRATE_SQUARE_H = 1.0      # under MOUNT_MAX: jump onto it
CRATE_LONG_H = 1.2        # hides a crouched player, just too tall to jump onto
CRATE_LONG_RATIO = 2.0
BUS_H = 3.0               # school bus 12
VAN_H = 2.5               # van 26: above 1.0 + MOUNT_MAX, so not even a box gets you on it
APV_H = 2.4               # APV 11
CROUCH_CLEAR = 1.4        # crouch openings 8 and 9: above 1.2 crouched, below 1.8 standing
DOOR_H = 2.3              # house doorways (Warehouse DOOR_H)
DOOR_W_PX = 24            # house doors are marked, not drawn as gaps: 24 px = 1.7 m wide
BARRACK_ROOF_TOP = 3.5    # barracks 4 and 5 are closed and roofed at wall height
ROOF_T = 0.2
ROOF6_TOP = 2.0           # middle block 6: box 10 (1.0) + 1.0 rise, under MOUNT_MAX (1.16) above the box
ROOF6_T = 0.15            # so the underside is 1.85 m: a standing player (1.8) fits under it
HOUSE_H = 3.0             # house 17 walls; roof slab on top
EAST_SILL_H = 1.2         # window beside box 16: not jumpable from the floor, a 0.2 m step from the box
TRENCH_DEPTH = 1.2        # Site B: a crouched player is hidden below the rim; deeper than a jump
STAIR_RISE = 0.2
STAIR_TREAD = 0.45
BANK_LIP = 0.05
RAISED_H = 1.2            # walkway 13: just above MOUNT_MAX, so only the planks (or a drop) connect it
PLANK_W_M = 1.0           # each plank ramp is 1 m wide, laid along the walkway's west edge
PLANK_BOARD = 0.2
PLANK_GAP = 0.04
PLANK_T = 0.06

WALL_T = 0.25             # thin walls (the image draws them 3 to 4 px)
BOUNDARY_T_PX = 8         # the outer wall stroke in the image
OUTLINE_PX = 3            # filled blocks: the traced fill plus its drawn outline
GROUND_T = 1.6

# =============================================================================================
# Coordinate table (image px). Traced from docs/maps/trailer-park.webp.
# =============================================================================================
# Outer edge of the boundary wall, traced around the outside of its stroke and simplified (1.5 px).
BOUNDARY = [
    (431, 22), (838, 22), (871, 24), (905, 35), (913, 44), (923, 98), (923, 137), (975, 138), (983, 146),
    (982, 231), (975, 236), (907, 237), (908, 518), (920, 521), (926, 529), (926, 594), (921, 601), (909, 604),
    (909, 796), (898, 807), (858, 808), (858, 869), (897, 870), (905, 876), (907, 881), (905, 899), (889, 966),
    (882, 971), (711, 971), (708, 978), (703, 981), (534, 981), (359, 981), (352, 986), (320, 986), (311, 979),
    (309, 974), (186, 974), (177, 982), (138, 982), (134, 980), (129, 970), (129, 897), (130, 892), (136, 885),
    (147, 882), (147, 810), (149, 805), (145, 800), (145, 772), (153, 764), (211, 764), (212, 734), (49, 733),
    (42, 726), (42, 708), (29, 674), (29, 501), (21, 445), (19, 374), (11, 341), (15, 296), (15, 130), (17, 126),
    (22, 123), (59, 123), (66, 129), (129, 129), (130, 48), (131, 43), (138, 38), (271, 38), (296, 23),
]

# Site B (3): the dug-out sand pit, traced around its darker fill. The third value is 1 where a bank
# line is drawn along the edge that starts at this vertex, 0 where the edge is open (no line).
PIT_B = [
    (207, 59, 1), (231, 69, 1), (253, 75, 1), (265, 83, 1), (274, 93, 1), (272, 114, 1), (261, 129, 1),
    (251, 136, 1), (251, 153, 1), (256, 161, 1), (257, 171, 1), (275, 191, 1), (293, 193, 1), (304, 188, 0),
    (307, 201, 1), (305, 205, 1), (289, 218, 1), (284, 221, 1), (275, 222, 1), (270, 226, 1), (261, 239, 1),
    (260, 253, 1), (263, 285, 1), (261, 308, 1), (263, 314, 1), (256, 338, 1), (251, 347, 1), (243, 361, 1),
    (241, 376, 0), (212, 366, 1), (215, 350, 1), (214, 307, 1), (218, 289, 1), (225, 278, 1), (225, 267, 1),
    (217, 242, 1), (211, 235, 1), (222, 184, 1), (209, 147, 1), (209, 141, 1), (216, 128, 1), (217, 114, 1),
    (222, 103, 1), (220, 96, 1), (215, 91, 1), (195, 80, 0),
]

# Walls: centre lines (polylines). Height WALL_H unless a height is given.
WALLS = [
    # name                       height      points
    ("n_wall_x322",              None,       [(322, 30), (322, 172)]),
    ("n_wall_x502",              None,       [(502, 60), (502, 94)]),
    ("ne_wall_x826",             None,       [(826, 30), (826, 113)]),
    ("bus_side_wall_x574",       None,       [(574, 252), (574, 355)]),
    ("ne_a_corner_wall",         None,       [(798, 298), (798, 393), (818, 393), (818, 416)]),
    ("ne_a_room_wall",           None,       [(754, 416), (754, 366), (798, 366)]),
    ("t_block_curve",            None,       [(720, 366), (726, 373), (734, 391)]),
    ("yard_n_wall_x389",         None,       [(389, 420), (389, 481)]),
    ("yard_n_wall_y410",         None,       [(417, 410), (580, 410)]),
    ("yard_w_wall_x311_a",       None,       [(311, 532), (311, 540)]),
    ("yard_w_wall_x311_b",       None,       [(311, 574), (311, 713)]),
    ("yard_s_wall_1",            None,       [(311, 713), (387, 713)]),
    ("yard_s_wall_2",            None,       [(420, 713), (514, 713)]),
    ("yard_s_wall_3",            None,       [(546, 711), (580, 711)]),
    ("n18_west_post",            None,       [(350, 713), (350, 745)]),
    ("n18_east_post",            None,       [(483, 713), (483, 745)]),
    # A building (barracks 4 and 5)
    ("a_west_wall_n",            None,       [(580, 410), (580, 445)]),        # gap 445..473 = main entrance 25
    ("a_west_wall_mid",          None,       [(580, 473), (580, 532)]),
    ("a_west_wall_s",            None,       [(580, 597), (580, 706)]),
    ("a_north_wall_w",           None,       [(580, 416), (620, 416)]),        # gap 620..642 = crouch 8
    ("a_north_wall_e",           None,       [(642, 416), (818, 416)]),
    ("a_east_wall_n",            None,       [(818, 416), (818, 457)]),        # gap 457..489 = window by box 16
    ("a_east_wall_s",            None,       [(818, 489), (818, 706)]),
    ("a_south_wall_w",           None,       [(580, 706), (624, 706)]),        # gap 624..640 = crouch 9
    ("a_south_wall_e",           None,       [(640, 706), (818, 706)]),
    ("a_south_small_room",       None,       [(655, 706), (655, 727), (689, 727)]),
    # middle block 6: the closed west room under the low roof, and the closed east room
    ("n6_room_north",            None,       [(583, 527), (709, 527)]),
    ("n6_room_south",            None,       [(583, 596), (709, 596)]),
    ("n6_room_west",             ROOF6_TOP,  [(583, 527), (583, 596)]),       # roof-high: box 10 climbs over it
    ("n6_room_east_a",           ROOF6_TOP - ROOF6_T, [(709, 527), (709, 576)]),
    ("n6_room_east_b",           ROOF6_TOP - ROOF6_T, [(709, 583), (709, 596)]),
    ("a_east_room_north",        None,       [(769, 527), (818, 527)]),
    ("a_east_room_west",         None,       [(778, 530), (778, 592)]),
    ("a_east_room_south",        None,       [(769, 595), (818, 595)]),
    # east corridor
    ("east_wall_y530",           None,       [(818, 530), (851, 530)]),
    ("east_wall_y592",           None,       [(818, 592), (847, 592)]),
    # south
    ("house_s_wall_x367",        None,       [(367, 887), (367, 972)]),
    ("se_wall_x666",             None,       [(666, 727), (666, 826)]),
    # short walls by B (22), player height
    ("n22_short_walls",          HUMAN_H,    [(206, 140), (206, 106), (177, 106), (177, 212), (160, 212),
                                              (160, 226), (184, 239)]),
    ("n22_short_wall_2",         HUMAN_H,    [(203, 241), (211, 237)]),
]

# Walls drawn nowhere but needed for the roof-6 reading (see the README): above roof 6, where the
# image draws no wall between x 709 and 769, from the roof up to the barrack roofs.
UPPER_WALLS = [
    ("n6_upper_north",  [(709, 527), (769, 527)]),
    ("n6_upper_south",  [(709, 596), (769, 596)]),
]

# Blocks. kind: tall / human / jump / low / bus / van / apv.  pad: px added on every side (the
# traced fill plus its drawn outline = OUTLINE_PX; 0 where the rectangle is already the outer edge).
# shape: "rects" [(x0, y0, x1, y1), ...] | "rot" (cx, cy, length, width, angle deg, image coords)
#        | "poly" [(x, y), ...] | "disc" (cx, cy, r)
BLOCKS = [
    # name                     kind     pad  shape   data
    ("n24_big_t_north",        "tall",  3, "rects", [(367, 94, 501, 115), (367, 116, 659, 166), (617, 167, 638, 187),
                                                     (434, 168, 507, 289), (434, 290, 522, 301)]),
    ("n24_ne_l",               "tall",  3, "rects", [(719, 113, 849, 186), (796, 187, 844, 295)]),
    ("n24_nw_small_l",         "tall",  3, "rects", [(304, 114, 316, 153), (285, 155, 316, 166)]),
    ("n24_tilted_box_by_b",    "tall",  0, "rot",   (191.5, 137, 27.5, 10.8, 71)),
    ("n22_round_post",         "human", 0, "disc",  (193.5, 245, 11.5)),
    ("n24_east_alcove",        "tall",  3, "rects", [(884, 186, 930, 198)]),
    ("n24_west_l",             "tall",  3, "rects", [(76, 193, 110, 321), (72, 322, 186, 375)]),
    ("n24_box_by_b_south",     "tall",  3, "rects", [(300, 235, 320, 248)]),
    ("n24_west_small",         "tall",  3, "rects", [(54, 241, 69, 258)]),
    ("n24_centre_l",           "tall",  3, "rects", [(295, 256, 380, 331), (295, 332, 345, 430)]),
    ("n12_school_bus",         "bus",   3, "rects", [(582, 265, 715, 288)]),
    ("n24_post_by_bus",        "tall",  0, "rects", [(580, 295, 587, 301)]),
    ("n24_post_north",         "tall",  0, "rects", [(652, 103, 658, 111)]),
    ("n24_ne_small",           "tall",  3, "rects", [(804, 304, 824, 316)]),
    ("n24_east_corridor_box",  "tall",  3, "rects", [(876, 351, 890, 384)]),
    ("n24_t_north_of_a",       "tall",  3, "rects", [(693, 364, 719, 394), (657, 396, 748, 412)]),
    ("n24_block_north_yard",   "tall",  3, "rects", [(423, 385, 493, 407)]),
    # inside the north barrack (4)
    ("crate_a4_desk_nw",         "crate",  3, "rects", [(590, 422, 612, 434)]),
    ("crate_a4_bench_n",         "crate",  3, "rects", [(655, 422, 694, 426)]),
    ("crate_a4_tilted_table",    "crate",  0, "rot",   (722, 473.5, 37, 25.4, 97.8)),
    ("crate_a4_small_tilted",    "crate",  0, "rot",   (776.4, 425.8, 22, 9, 10)),
    ("crate_a4_ne_corner",       "crate",  0, "poly",  [(792, 420), (815, 420), (815, 442), (801, 442)]),
    ("crate_a4_se_corner",       "crate",  0, "poly",  [(801, 493), (815, 493), (815, 523), (791, 523), (784, 515), (801, 504)]),
    ("crate_a4_post",            "crate",  0, "rects", [(661, 462, 669, 483)]),
    ("crate_a4_post_w",          "crate",  0, "rects", [(584, 490, 594, 505)]),
    ("crate_a4_box_sw",          "crate",  0, "rects", [(587, 506, 605, 524)]),
    ("crate_a4_bench_s",         "crate",  0, "rects", [(609, 511, 651, 523)]),
    ("crate_a4_small_s",         "crate",  0, "rects", [(653, 510, 665, 522)]),
    ("n16_jump_box_east",      "jump",  0, "rects", [(800, 444, 817, 491)]),
    # inside the south barrack (5)
    ("crate_a5_box",             "crate",  3, "rects", [(693, 602, 706, 615)]),
    ("crate_a5_bench",           "crate",  3, "rects", [(651, 677, 728, 695)]),
    ("crate_a5_tilted",          "crate",  0, "rot",   (764.1, 683.9, 25, 15, -8.3)),
    ("crate_a5_box_e",           "crate",  3, "rects", [(791, 683, 802, 697)]),
    ("n24_a_south_bar",        "tall",  3, "rects", [(692, 711, 813, 725)]),
    ("n24_a_se_box",           "tall",  3, "rects", [(823, 718, 838, 741)]),
    # west and centre
    ("n24_west_post",          "tall",  3, "rects", [(221, 433, 233, 447)]),
    ("n24_west_wall_box",      "tall",  3, "rects", [(36, 451, 69, 475)]),
    ("n20_long_wall",          "tall",  3, "rects", [(102, 455, 236, 489)]),
    ("n21_jump_box_in_gap",    "jump",  3, "rects", [(245, 481, 254, 490)]),
    ("n24_l_west_yard",        "tall",  3, "rects", [(277, 481, 390, 505), (277, 506, 424, 530)]),
    ("n11_apv",                "apv",   0, "rot",   (479.9, 571.6, 83, 24, -25.8)),
    ("n11_apv_nub",            "apv",   0, "rot",   (479.3, 547.5, 16.8, 19.5, -26.6)),
    ("n10_jump_box_to_roof6",  "jump",  0, "rects", [(549, 556, 580, 574)]),
    ("n19_trailer_west",       "human", 0, "rot",   (140.4, 604.7, 52.8, 19.7, 12)),
    ("n19_trailer_east",       "human", 3, "rects", [(188, 605, 219, 618)]),
    ("n24_yard_box",           "tall",  3, "rects", [(390, 641, 423, 654)]),
    ("n24_post_yard_sw",       "tall",  0, "rects", [(301, 707, 307, 713)]),
    ("n24_sw_box",             "tall",  3, "rects", [(197, 701, 216, 721)]),
    # south
    # box 18 drawn x 352-481; owner-approved: only the part east of the A-yard wall gap (x 387-420) is
    # kept, so the gap stays walkable at full width and the floor west of the box links it to the west
    ("n18_low_box",            "low",   0, "rects", [(423, 715, 481, 774)]),
    # jump boxes at both ends of walkway 13 (owner-approved): 1.0 m box, then a 0.2 m step up to 1.2 m.
    # North: west of the tall box already at the walkway's north-east corner; south: against the
    # outer wall. Both leave the ground corridor west of the walkway (x 818-852) clear.
    ("n13_jump_box_north_end", "jump",  0, "rects", [(852, 364, 872, 380)]),
    ("n13_jump_box_south_end", "jump",  0, "rects", [(880, 700, 899, 716)]),
    ("n23_jump_box_south",     "jump",  0, "rects", [(372, 915, 394, 937)]),   # from the notes; not drawn
    ("n26_van",                "van",   3, "rects", [(765, 794, 787, 879)]),
    ("n24_box_by_van_wall",    "tall",  3, "rects", [(649, 806, 660, 824)]),
    ("n24_se_box_on_wall",     "tall",  3, "rects", [(761, 945, 806, 960)]),
    ("n24_s_box_on_wall",      "tall",  3, "rects", [(541, 953, 560, 969)]),
    ("n24_s_post_a",           "tall",  0, "rects", [(662, 962, 669, 971)]),
    ("n24_s_post_b",           "tall",  0, "rects", [(714, 954, 728, 961)]),
]

# House 17: closed roof, walls along its outline (L shape), three doors at the small markers
HOUSE_17 = [(347, 775), (482, 775), (482, 830), (671, 830), (671, 887), (347, 887)]
HOUSE_DOORS = [("west", (347, 862)), ("south_w", (504, 887)), ("south_e", (617, 887))]

# Roofs
BARRACK_ROOFS = [("n4_north_barrack_roof", (580, 416, 818, 527)), ("n5_south_barrack_roof", (580, 596, 818, 706)),
                 ("a_east_room_roof", (778, 527, 818, 596))]
ROOF_6 = (583, 527, 778, 596)          # middle block 6 (notes)
HOLE_7 = (728, 543, 772, 581)          # hole in roof 6

# Openings with something in them
CROUCH_8 = ((620, 416), (642, 416))
CROUCH_9 = ((624, 706), (640, 706))
EAST_WINDOW = ((818, 457), (818, 489))      # beside box 16

# East route
WALKWAY_13 = (852, 380, 900, 700)
PLANKS = [("n14_plank_north", 465, 530), ("n15_plank_south", 655, 592)]   # (name, low-end y, high-end y)
PLANK_EDGE_X = 852                           # boards sit just west of the walkway, on the drawn lines

SPAWNS = [("n1_ghost_spawn", (170, 945), "G"), ("n2_defender_spawn", (780, 45), "D")]
SITES = [("n4_site_a", (700, 470), "A", 0.0), ("n3_site_b", (240, 240), "B", -TRENCH_DEPTH)]

# =============================================================================================
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
IMG_PATH = REPO / "docs" / "maps" / "trailer-park.webp"
OUT = REPO / "docs" / "review" / "maps" / "trailer-park"
LOG = []


def log(msg):
    print("[tp] " + msg)
    LOG.append(msg)


def P(x, y):
    return (x * M_PER_PX, (IMG - y) * M_PER_PX)


# ---------------------------------------------------------------------------------------------
# mesh helpers
# ---------------------------------------------------------------------------------------------
def signed_area(pts):
    return 0.5 * sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
                     for i in range(len(pts)))


def add_prism(bm, pts, z0, z1):
    if signed_area(pts) < 0:
        pts = pts[::-1]
    bot = [bm.verts.new((x, y, z0)) for x, y in pts]
    top = [bm.verts.new((x, y, z1)) for x, y in pts]
    bm.faces.new(bot[::-1])
    bm.faces.new(top)
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bot[i], bot[j], top[j], top[i]))


def add_hull(bm, corners):
    vs = [bm.verts.new(c) for c in corners]
    bmesh.ops.convex_hull(bm, input=vs)


def seg_quad(a, b, t, ext_a, ext_b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy)
    if L < 1e-6:
        return None
    ux, uy = dx / L, dy / L
    nx, ny = -uy * t / 2, ux * t / 2
    ea, eb = (t / 2 if ext_a else 0.0), (t / 2 if ext_b else 0.0)
    ax, ay = a[0] - ux * ea, a[1] - uy * ea
    bx, by = b[0] + ux * eb, b[1] + uy * eb
    return [(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny)]


def add_polyline(bm, pts_m, closed, t, z0, z1):
    n = len(pts_m)
    segs = n if closed else n - 1
    for i in range(segs):
        q = seg_quad(pts_m[i], pts_m[(i + 1) % n], t, closed or i > 0, closed or i < segs - 1)
        if q:
            add_prism(bm, q, z0, z1)


COLLS = {}


def coll(name):
    if name not in COLLS:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
        COLLS[name] = c
    return COLLS[name]


def make_obj(name, bm, mats, collection):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    for m in (mats if isinstance(mats, (list, tuple)) else [mats]):
        if m:
            me.materials.append(m)
    coll(collection).objects.link(ob)
    return ob


def prism_obj(name, pts_m, z0, z1, mat, collection, side_mat=None):
    bm = bmesh.new()
    add_prism(bm, pts_m, z0, z1)
    if side_mat is not None:
        bm.normal_update()
        for f in bm.faces:
            if abs(f.normal.z) < 0.5:
                f.material_index = 1
    return make_obj(name, bm, [mat, side_mat] if side_mat else mat, collection)


def rect_m(r, pad=0):
    x0, y0, x1, y1 = r
    a, b = P(x0 - pad, y1 + pad), P(x1 + pad, y0 - pad)
    return [(a[0], a[1]), (b[0], a[1]), (b[0], b[1]), (a[0], b[1])]


def rot_m(cx, cy, length, width, ang):
    # angle in image coords (y down); convert by flipping the angle
    a = math.radians(-ang)
    ux, uy = math.cos(a), math.sin(a)
    c = P(cx, cy)
    hl, hw = length * M_PER_PX / 2, width * M_PER_PX / 2
    return [(c[0] + ux * hl - uy * hw, c[1] + uy * hl + ux * hw), (c[0] - ux * hl - uy * hw, c[1] - uy * hl + ux * hw),
            (c[0] - ux * hl + uy * hw, c[1] - uy * hl - ux * hw), (c[0] + ux * hl + uy * hw, c[1] + uy * hl - ux * hw)]


def text_obj(name, body, xy, z, size, mat, collection):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.extrude = 0.01
    ob = bpy.data.objects.new(name, cu)
    ob.location = (xy[0], xy[1], z)
    ob.data.materials.append(mat)
    coll(collection).objects.link(ob)
    return ob


def point_in_poly(p, poly):
    x, y = p
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


# ---------------------------------------------------------------------------------------------
# materials
# ---------------------------------------------------------------------------------------------
def srgb(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c)


def make_mat(name, hexcol, rough=0.85, grid=None):
    mat = bpy.data.materials.new(name)
    lin = srgb(hexcol)
    mat.diffuse_color = (*lin, 1.0)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = rough
    if grid is None:
        bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
        return mat
    line_hex, pitch = grid
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])

    def line(axis_out):
        md = nt.nodes.new("ShaderNodeMath")
        md.operation = "FLOORED_MODULO"
        nt.links.new(axis_out, md.inputs[0])
        md.inputs[1].default_value = pitch
        lt = nt.nodes.new("ShaderNodeMath")
        lt.operation = "LESS_THAN"
        nt.links.new(md.outputs[0], lt.inputs[0])
        lt.inputs[1].default_value = 0.05
        return lt.outputs[0]

    mx = nt.nodes.new("ShaderNodeMath")
    mx.operation = "MAXIMUM"
    nt.links.new(line(sep.outputs[0]), mx.inputs[0])
    nt.links.new(line(sep.outputs[1]), mx.inputs[1])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    nt.links.new(mx.outputs[0], mix.inputs["Factor"])
    mix.inputs["A"].default_value = (*lin, 1.0)
    mix.inputs["B"].default_value = (*srgb(line_hex), 1.0)
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    return mat


# ---------------------------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------------------------
def build():
    grid = 1.0   # 1 m floor grid, for scale
    M = {
        "ground": make_mat("ground", "#e9eee8", grid=("#c9d3cc", grid)),
        "boundary": make_mat("boundary_wall", "#334d47"),
        "wall": make_mat("wall_tall", "#3e5b54"),
        "tall": make_mat("block_tall", "#b9cbbf"),
        "human": make_mat("block_human_height", "#8fb6d8"),
        "jump": make_mat("box_jump", "#e9b86a"),
        "low": make_mat("box_low_cover", "#6fcfd3"),
        "crate": make_mat("crate_in_barracks", "#c9a46a"),
        "bus": make_mat("school_bus", "#e0b23c", rough=0.6),
        "van": make_mat("van", "#7d8fa3", rough=0.6),
        "apv": make_mat("apv", "#6c8577", rough=0.6),
        "trench": make_mat("trench_floor", "#d8c49a", grid=("#c4ae80", grid)),
        "bank": make_mat("trench_bank", "#8a7550"),
        "stair": make_mat("stair", "#a4b2ac"),
        "stair2": make_mat("stair_alt", "#87968f"),
        "raised": make_mat("raised_walkway", "#d3e6d6", grid=("#b8cebd", grid)),
        "retaining": make_mat("raised_retaining_face", "#7f9f88"),
        "plank": make_mat("plank", "#c49358", rough=0.7),
        "plank_frame": make_mat("plank_support", "#6e5232"),
        "roof": make_mat("roof_barrack", "#c9c4d8"),
        "roof6": make_mat("roof_middle_block_6", "#e8d27a"),
        "house_roof": make_mat("roof_house", "#d8d4e6"),
        "house_wall": make_mat("house_wall", "#57707a"),
        "crouch": make_mat("crouch_lintel", "#7b5a9c"),
        "sill": make_mat("window_sill", "#9c7b5a"),
        "upper": make_mat("inferred_upper_wall", "#b4667a"),
        "ghost": make_mat("ghost_spawn", "#476879"),
        "defender": make_mat("defender_spawn", "#926244"),
        "siteA": make_mat("site_a", "#b5534d"),
        "siteB": make_mat("site_b", "#356a91"),
        "white": make_mat("label_white", "#ffffff"),
        "dummy": make_mat("scale_player_standing", "#e2463a", rough=0.5),
        "dummy_c": make_mat("scale_player_crouched", "#f08a24", rough=0.5),
        "eye": make_mat("scale_eye_band", "#111111"),
    }
    S = M_PER_PX

    # ---- ground (inside the boundary) with the Site B hole --------------------------------
    outer = [P(x, y) for x, y in BOUNDARY]
    ground = prism_obj("ground", outer, -GROUND_T, 0.0, M["ground"], "Ground")
    pit = [P(x, y) for x, y, _ in PIT_B]
    cutter = prism_obj("site_b_cutter", pit, -GROUND_T - 1.0, 1.0, None, "Cutters")
    cutter.display_type = "WIRE"
    cutter.hide_render = True
    mod = ground.modifiers.new("site_b_hole", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    mod.solver = "EXACT"
    coll("Cutters").hide_render = True

    # ---- boundary wall: a ring inset from the traced outer edge ----------------------------
    # each edge of the traced outline becomes a wall strip lying just inside it
    ring = outer if signed_area(outer) > 0 else outer[::-1]
    t = BOUNDARY_T_PX * S
    bm = bmesh.new()
    for i in range(len(ring)):
        a0, b0 = Vector(ring[i]), Vector(ring[(i + 1) % len(ring)])
        d = b0 - a0
        if d.length < 1e-6:
            continue
        d.normalize()
        inward = Vector((-d.y, d.x))          # left of a counter-clockwise outline
        a1, b1 = a0 - d * (t / 2), b0 + d * (t / 2)
        add_prism(bm, [tuple(a1), tuple(b1), tuple(b1 + inward * t), tuple(a1 + inward * t)], 0.0, BOUNDARY_H)
    make_obj("boundary_wall", bm, M["boundary"], "Walls")

    # ---- Site B pit -------------------------------------------------------------------------
    zf = -TRENCH_DEPTH
    prism_obj("n3_site_b_floor", pit, zf - 0.2, zf, M["trench"], "Elevation_SiteB")
    bm = bmesh.new()
    n = len(PIT_B)
    openings = []
    for i in range(n):
        a, b = PIT_B[i], PIT_B[(i + 1) % n]
        if a[2]:
            q = seg_quad(P(a[0], a[1]), P(b[0], b[1]), WALL_T, True, True)
            add_prism(bm, q, zf, BANK_LIP)
        else:
            openings.append(((a[0], a[1]), (b[0], b[1])))
    make_obj("n3_site_b_banks", bm, M["bank"], "Elevation_SiteB")
    n_steps = int(round(TRENCH_DEPTH / STAIR_RISE)) - 1
    for k_open, (a, b) in enumerate(openings):
        am, bmm = Vector(P(*a)), Vector(P(*b))
        mid = (am + bmm) / 2
        along = (bmm - am)
        width = max(along.length, 0.9)
        along.normalize()
        nrm = Vector((-along.y, along.x))
        if not point_in_poly(tuple(mid + nrm * 0.5), pit):
            nrm = -nrm
        for k in range(1, n_steps + 1):
            c0 = mid + nrm * (STAIR_TREAD * (k - 1))
            c1 = mid + nrm * (STAIR_TREAD * k)
            hw = along * (width / 2)
            quad = [tuple(c0 - hw), tuple(c0 + hw), tuple(c1 + hw), tuple(c1 - hw)]
            prism_obj("n3_site_b_stair_%d_%d" % (k_open, k), quad, zf, -STAIR_RISE * k,
                      M["stair"] if k % 2 else M["stair2"], "Elevation_SiteB")
        log("Site B opening %d: (%d, %d) to (%d, %d) px, %.2f m wide -> stairs, %d steps of %.2f m, run %.2f m"
            % (k_open, a[0], a[1], b[0], b[1], along.length if False else (bmm - am).length, n_steps, STAIR_RISE,
               n_steps * STAIR_TREAD))

    # ---- walls ------------------------------------------------------------------------------
    for name, h, pts in WALLS:
        bm = bmesh.new()
        add_polyline(bm, [P(*p) for p in pts], False, WALL_T, 0.0, h if h else WALL_H)
        col = "Walls_short_by_B" if h == HUMAN_H else ("A_building" if name.startswith(("a_", "n6_")) else "Walls")
        make_obj(name, bm, M["human"] if h == HUMAN_H else M["wall"], col)
    for name, pts in UPPER_WALLS:
        bm = bmesh.new()
        add_polyline(bm, [P(*p) for p in pts], False, WALL_T, ROOF6_TOP, WALL_H)
        make_obj(name, bm, M["upper"], "A_building")

    # lintels and sills in openings
    def opening_box(name, ab, z0, z1, mat, collection):
        bm = bmesh.new()
        add_prism(bm, seg_quad(P(*ab[0]), P(*ab[1]), WALL_T, False, False), z0, z1)
        make_obj(name, bm, mat, collection)

    opening_box("n8_crouch_lintel", CROUCH_8, CROUCH_CLEAR, WALL_H, M["crouch"], "A_building")
    opening_box("n9_crouch_lintel", CROUCH_9, CROUCH_CLEAR, WALL_H, M["crouch"], "A_building")
    opening_box("n16_window_sill", EAST_WINDOW, 0.0, EAST_SILL_H, M["sill"], "A_building")
    for nm, ab in (("n8", CROUCH_8), ("n9", CROUCH_9), ("n25", ((580, 445), (580, 473))), ("window16", EAST_WINDOW)):
        w = math.dist(*ab) * S
        log("opening %s: %.2f m wide" % (nm, w))

    # ---- roofs ------------------------------------------------------------------------------
    for name, r in BARRACK_ROOFS:
        prism_obj(name, rect_m(r), BARRACK_ROOF_TOP - ROOF_T, BARRACK_ROOF_TOP, M["roof"], "A_roofs_barracks")
    x0, y0, x1, y1 = ROOF_6
    hx0, hy0, hx1, hy1 = HOLE_7
    for i, r in enumerate(((x0, y0, hx0, y1), (hx1, y0, x1, y1), (hx0, y0, hx1, hy0), (hx0, hy1, hx1, y1))):
        if r[2] > r[0] and r[3] > r[1]:
            prism_obj("n6_roof_part_%d" % i, rect_m(r), ROOF6_TOP - ROOF6_T, ROOF6_TOP, M["roof6"], "A_building")
    log("roof 6: top %.2f m, underside %.2f m, %.1f x %.1f m; hole 7: %.1f x %.1f m"
        % (ROOF6_TOP, ROOF6_TOP - ROOF6_T, (x1 - x0) * S, (y1 - y0) * S, (hx1 - hx0) * S, (hy1 - hy0) * S))

    # ---- house 17 ---------------------------------------------------------------------------
    hp = HOUSE_17
    bm = bmesh.new()
    half = DOOR_W_PX / 2
    for i in range(len(hp)):
        a, b = hp[i], hp[(i + 1) % len(hp)]
        cuts = []
        for _, d in HOUSE_DOORS:
            on_v = a[0] == b[0] == d[0] and min(a[1], b[1]) < d[1] < max(a[1], b[1])
            on_h = a[1] == b[1] == d[1] and min(a[0], b[0]) < d[0] < max(a[0], b[0])
            if on_v:
                cuts.append((d[1] - half, d[1] + half))
            if on_h:
                cuts.append((d[0] - half, d[0] + half))
        axis = 1 if a[0] == b[0] else 0
        lo, hi = sorted((a[axis], b[axis]))
        pieces, cur = [], lo
        for c0, c1 in sorted(cuts):
            pieces.append((cur, c0))
            cur = c1
        pieces.append((cur, hi))
        for p0, p1 in pieces:
            if p1 - p0 < 0.5:
                continue
            if axis == 0:
                q = seg_quad(P(p0, a[1]), P(p1, a[1]), WALL_T, p0 == lo, p1 == hi)
            else:
                q = seg_quad(P(a[0], p0), P(a[0], p1), WALL_T, p0 == lo, p1 == hi)
            add_prism(bm, q, 0.0, HOUSE_H)
        for c0, c1 in cuts:
            if axis == 0:
                q = seg_quad(P(c0, a[1]), P(c1, a[1]), WALL_T, False, False)
            else:
                q = seg_quad(P(a[0], c0), P(a[0], c1), WALL_T, False, False)
            add_prism(bm, q, DOOR_H, HOUSE_H)
    make_obj("n17_house_walls", bm, M["house_wall"], "House_17")
    prism_obj("n17_house_roof", [P(*p) for p in hp], HOUSE_H, HOUSE_H + ROOF_T, M["house_roof"], "House_17_roof")
    log("house 17: doors %.2f m wide, %.2f m high, at %s" % (DOOR_W_PX * S, DOOR_H, ", ".join(n for n, _ in HOUSE_DOORS)))

    # ---- blocks -----------------------------------------------------------------------------
    H = {"tall": WALL_H, "human": HUMAN_H, "jump": JUMP_H, "low": LOW_COVER_H, "bus": BUS_H, "van": VAN_H, "apv": APV_H}
    COL = {"tall": "Blocks_tall", "human": "Blocks_human_height", "jump": "Boxes_jump", "low": "Boxes_low_cover",
           "bus": "Vehicles", "van": "Vehicles", "apv": "Vehicles", "crate": "Crates_in_barracks"}
    for name, kind, pad, shape, data in BLOCKS:
        if shape == "rects":
            foots = [rect_m(r, pad) for r in data]
        elif shape == "rot":
            cx, cy, L, W, ang = data
            foots = [rot_m(cx, cy, L + 2 * pad, W + 2 * pad, ang)]
        elif shape == "poly":
            foots = [[P(*p) for p in data]]
        else:
            cx, cy, r = data
            c = P(cx, cy)
            foots = [[(c[0] + r * S * math.cos(2 * math.pi * k / 24), c[1] + r * S * math.sin(2 * math.pi * k / 24))
                      for k in range(24)]]
        if kind == "crate":
            if shape == "rot":
                long_side, short_side = max(L, W) + 2 * pad, min(L, W) + 2 * pad
            else:
                xs = [p[0] for p in foots[0]]
                ys = [p[1] for p in foots[0]]
                long_side, short_side = max(max(xs) - min(xs), max(ys) - min(ys)), min(max(xs) - min(xs), max(ys) - min(ys))
            h = CRATE_LONG_H if long_side >= CRATE_LONG_RATIO * short_side else CRATE_SQUARE_H
            k = long_side / short_side
            if shape == "rot":
                long_side, short_side = long_side * S, short_side * S
            log("%s: %.2f x %.2f m (ratio %.1f) -> %.1f m %s"
                % (name, long_side, short_side, k, h, "long, crouch cover" if h == CRATE_LONG_H else "square, jumpable"))
        else:
            h = H[kind]
        bm = bmesh.new()
        for f in foots:
            add_prism(bm, f, 0.0, h)
        make_obj(name, bm, M[kind], COL[kind])
        if kind in ("jump", "low", "bus", "van", "apv", "human") and shape == "rects":
            r = data[0]
            log("%s: %.2f x %.2f m, %.2f m tall" % (name, (r[2] - r[0] + 2 * pad) * S, (r[3] - r[1] + 2 * pad) * S, h))
        elif kind in ("apv", "human") and shape == "rot":
            log("%s: %.2f x %.2f m, turned %.0f deg, %.2f m tall" % (name, (data[2] + 2 * pad) * S, (data[3] + 2 * pad) * S, -data[4], h))

    # ---- east walkway and planks ------------------------------------------------------------
    prism_obj("n13_raised_walkway", rect_m(WALKWAY_13), 0.0, RAISED_H, M["raised"], "East_route", side_mat=M["retaining"])
    for name, y_low, y_high in PLANKS:
        X1 = P(PLANK_EDGE_X, 0)[0]
        X0 = X1 - PLANK_W_M
        Yl, Yh = P(0, y_low)[1], P(0, y_high)[1]
        bm = bmesh.new()
        add_hull(bm, [(X0, Yl, 0), (X1, Yl, 0), (X0, Yh, 0), (X1, Yh, 0),
                      (X0, Yh, RAISED_H - PLANK_T), (X1, Yh, RAISED_H - PLANK_T)])
        make_obj(name + "_support", bm, M["plank_frame"], "East_route")
        nb = int((PLANK_W_M + PLANK_GAP) // (PLANK_BOARD + PLANK_GAP))
        margin = (PLANK_W_M - (nb * PLANK_BOARD + (nb - 1) * PLANK_GAP)) / 2
        bm = bmesh.new()
        for i in range(nb):
            b0 = X0 + margin + i * (PLANK_BOARD + PLANK_GAP)
            b1 = b0 + PLANK_BOARD
            add_hull(bm, [(b0, Yl, 0.0), (b1, Yl, 0.0), (b0, Yh, RAISED_H - PLANK_T), (b1, Yh, RAISED_H - PLANK_T),
                          (b0, Yl, PLANK_T), (b1, Yl, PLANK_T), (b0, Yh, RAISED_H), (b1, Yh, RAISED_H)])
        make_obj(name + "_boards", bm, M["plank"], "East_route")
        run = abs(Yh - Yl)
        log("%s: rises %.2f m over %.2f m (%.1f deg), %.2f m wide, low end at image y %d, high end at y %d"
            % (name, RAISED_H, run, math.degrees(math.atan2(RAISED_H, run)), PLANK_W_M, y_low, y_high))

    # ---- markers ----------------------------------------------------------------------------
    for name, (x, y), letter in SPAWNS:
        c = P(x, y)
        r = 1.0
        prism_obj(name, [(c[0] - r, c[1] - r), (c[0] + r, c[1] - r), (c[0] + r, c[1] + r), (c[0] - r, c[1] + r)],
                  0.0, 0.03, M["ghost" if letter == "G" else "defender"], "Markers")
        text_obj(name + "_letter", letter, c, 0.04, 1.4, M["white"], "Markers")
    for name, (x, y), letter, z in SITES:
        c = P(x, y)
        r = 1.6
        prism_obj(name, [(c[0] + r * math.cos(2 * math.pi * k / 40), c[1] + r * math.sin(2 * math.pi * k / 40)) for k in range(40)],
                  z, z + 0.03, M["siteA" if letter == "A" else "siteB"], "Markers")
        text_obj(name + "_letter", letter, c, z + 0.04, 2.2, M["white"], "Markers")

    # ---- player-size posts ------------------------------------------------------------------
    def player(name, xy, z, crouched=False):
        c = P(*xy)
        hh = HULL_HEIGHT_CROUCHED if crouched else HULL_HEIGHT
        eye = EYE_HEIGHT_CROUCHED if crouched else EYE_HEIGHT
        r = HULL_HALF_WIDTH
        sq = lambda e: [(c[0] - r - e, c[1] - r - e), (c[0] + r + e, c[1] - r - e), (c[0] + r + e, c[1] + r + e), (c[0] - r - e, c[1] + r + e)]
        prism_obj("player_" + name, sq(0), z, z + hh, M["dummy_c" if crouched else "dummy"], "Scale_players")
        prism_obj("player_" + name + "_eye", sq(0.01), z + eye - 0.03, z + eye + 0.03, M["eye"], "Scale_players")

    player("on_box_10", (564, 565), JUMP_H)
    player("ground_by_box_10", (560, 590), 0.0)
    player("on_roof_6", (660, 562), ROOF6_TOP)
    player("on_roof_6_by_hole", (722, 562), ROOF6_TOP)
    player("under_roof_6", (742, 534), 0.0)
    player("below_hole_7", (750, 562), 0.0, crouched=True)
    player("crouch_8_under", (631, 416), 0.0, crouched=True)
    player("crouch_8_beside", (660, 440), 0.0)
    player("crouch_9_under", (632, 706), 0.0, crouched=True)
    player("crouch_9_beside", (610, 690), 0.0)
    player("entrance_25", (580, 459), 0.0)
    player("on_box_16", (808, 468), JUMP_H)
    player("box_18_crouched", (497, 760), 0.0, crouched=True)
    player("box_18_standing", (497, 735), 0.0)
    player("box_18_crouched_w", (413, 760), 0.0, crouched=True)
    player("yard_gap_walking", (403, 728), 0.0)
    player("house_door_west", (330, 862), 0.0)
    player("house_door_south", (504, 905), 0.0)
    player("trailer_19", (150, 632), 0.0)
    player("short_wall_22", (192, 185), 0.0)
    player("site_b_standing", (238, 290), -TRENCH_DEPTH)
    player("site_b_crouched", (240, 160), -TRENCH_DEPTH, crouched=True)
    player("site_b_rim", (290, 300), 0.0)
    player("walkway_13", (877, 560), RAISED_H)
    player("walkway_ground", (833, 430), 0.0)
    player("on_walkway_south_box", (889, 708), JUMP_H)
    player("box_21", (250, 500), 0.0)
    return M


# ---------------------------------------------------------------------------------------------
# cameras, light, render, compare
# ---------------------------------------------------------------------------------------------
def setup_device():
    scene = bpy.context.scene
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except (KeyError, AttributeError):
        prefs = None
    if prefs is not None:
        for kind in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = kind
            except (TypeError, ValueError):
                continue
            try:
                prefs.get_devices()
            except Exception:  # noqa: BLE001
                pass
            devs = [d for d in prefs.devices if d.type == kind]
            if not devs:
                continue
            for d in prefs.devices:
                d.use = d.type == kind
            scene.cycles.device = "GPU"
            return "GPU %s" % kind
    scene.cycles.device = "CPU"
    return "CPU"


def camera(name, eye_px, eye_z, tgt_px, tgt_z, lens=24.0):
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    cam.clip_end = 400
    ob = bpy.data.objects.new(name, cam)
    ob.location = (*P(*eye_px), eye_z)
    d = Vector((*P(*tgt_px), tgt_z)) - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    coll("Cameras").objects.link(ob)
    return ob


def setup_scene(samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    log("render device: " + setup_device())
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (*srgb("#e9eef0"), 1.0)
    scene.world = world
    sun = bpy.data.lights.new("sun", "SUN")
    sun.angle = math.radians(2.0)
    sun_ob = bpy.data.objects.new("sun", sun)
    coll("Lights").objects.link(sun_ob)

    size = IMG * M_PER_PX
    over = bpy.data.cameras.new("cam_overhead")
    over.type = "ORTHO"
    over.ortho_scale = size
    over.clip_end = 200
    over_ob = bpy.data.objects.new("cam_overhead", over)
    over_ob.location = (size / 2, size / 2, 60.0)
    coll("Cameras").objects.link(over_ob)
    scene.camera = over_ob

    views = {
        # name: (camera, collections hidden for this view)
        "view_site_b": (camera("cam_site_b", (345, 345), 9.0, (238, 215), -1.4, 22), ()),
        "view_site_b_from_north": (camera("cam_site_b_north", (300, 40), 6.0, (232, 200), -1.2, 22), ()),
        "view_east_walkway": (camera("cam_east", (790, 770), 7.0, (850, 545), 0.5, 20), ()),
        "view_east_walkway_along": (camera("cam_east_along", (858, 805), 5.0, (880, 560), 0.0, 22), ()),
        "view_a_building": (camera("cam_a", (470, 740), 17.0, (690, 560), 0.0, 22), ("A_roofs_barracks",)),
        "view_a_roof_climb": (camera("cam_a_climb", (505, 600), 3.6, (640, 556), 1.6, 22), ()),
        "view_a_under_roof": (camera("cam_a_under", (760, 502), 1.7, (742, 600), 1.0, 18), ("A_roofs_barracks",)),
        "view_house": (camera("cam_house", (270, 965), 8.0, (500, 845), 0.8, 22), ()),
        "view_house_box18": (camera("cam_house_n", (300, 650), 7.5, (430, 760), 0.4, 22), ()),
        "view_birds_eye": (camera("cam_birds_eye", (90, 1250), 55.0, (520, 520), -2.0, 26), ()),
    }
    return sun_ob, over_ob, views


def set_light(sun_ob, elev, azim, sun_strength, world_strength):
    sun_ob.rotation_euler = (math.radians(90 - elev), 0.0, math.radians(azim))
    sun_ob.data.energy = sun_strength
    bpy.context.scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = world_strength


def render_to(path, cam, res):
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.filepath = str(path)
    jpg = str(path).endswith(".jpg")
    scene.render.image_settings.file_format = "JPEG" if jpg else "PNG"
    if jpg:
        scene.render.image_settings.quality = 90
    bpy.ops.render.render(write_still=True)
    log("rendered " + os.path.relpath(path, REPO).replace("\\", "/"))


def find_chrome():
    for p in (os.environ.get("CHROME"), r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", shutil.which("chrome")):
        if p and os.path.exists(p):
            return p
    return None


def compare_images(over_png):
    rel = os.path.relpath(IMG_PATH, OUT).replace("\\", "/")
    D = 900
    page = """<!doctype html><meta charset="utf-8"><title>Trailer Park: image vs render</title>
<style>body{margin:0;background:#fff;font:600 18px sans-serif;color:#223}.row{display:flex;gap:20px;padding:12px 16px}
.lbl{height:28px}img{display:block;width:%(d)dpx;height:%(d)dpx}.over{position:relative;width:%(d)dpx;height:%(d)dpx}
.over img.src{position:absolute;left:0;top:0;opacity:.5}</style><body>
<div class="row" id="side"><div><div class="lbl">Owner's image (trailer-park.webp)</div><img src="%(src)s"></div>
<div><div class="lbl">Blender overhead, orthographic, %(s)g m per image px</div><img src="%(png)s"></div></div>
<div class="row" id="overlay"><div><div class="lbl">Image at 50%% over the render</div>
<div class="over"><img src="%(png)s"><img class="src" src="%(src)s"></div></div></div></body>""" % dict(
        d=D, src=rel, png=over_png.name, s=M_PER_PX)
    (OUT / "compare.html").write_text(page, encoding="utf-8")
    chrome = find_chrome()
    if not chrome:
        log("no Chrome or Edge: open compare.html instead")
        return
    for name, frag, size in (("compare_side_by_side.png", "side", (2 * D + 52, D + 52)),
                             ("compare_overlay.png", "overlay", (D + 32, D + 52))):
        hide = "overlay" if frag == "side" else "side"
        one = OUT / ("_compare_%s.html" % frag)
        one.write_text(page.replace("<body>", "<body><style>#%s{display:none}</style>" % hide), encoding="utf-8")
        out = OUT / name
        try:
            subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                            "--allow-file-access-from-files", "--window-size=%d,%d" % size, "--screenshot=%s" % out,
                            one.as_uri()], check=True, timeout=120, capture_output=True)
            log("wrote " + os.path.relpath(out, REPO).replace("\\", "/"))
        except Exception as e:  # noqa: BLE001
            log("compare %s failed: %s" % (name, e))
        finally:
            one.unlink(missing_ok=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    samples = int(argv[argv.index("--samples") + 1]) if "--samples" in argv else 64
    OUT.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    log("scale %.3f m per image px: image %.1f x %.1f m" % (M_PER_PX, IMG * M_PER_PX, IMG * M_PER_PX))
    build()
    sun_ob, over_ob, views = setup_scene(samples)
    set_light(sun_ob, 50, 35, 3.0, 0.5)
    blend = OUT / "trailer_park.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend), compress=True)
    log("saved " + os.path.relpath(blend, REPO).replace("\\", "/"))
    if "--no-render" not in argv:
        players = coll("Scale_players")
        players.hide_render = True
        set_light(sun_ob, 80, 30, 1.3, 0.72)
        over_png = OUT / "overhead.png"
        if "--only" not in argv:
            render_to(over_png, over_ob, (2000, 2000))
        players.hide_render = False
        set_light(sun_ob, 42, 35, 3.2, 0.45)
        only = argv[argv.index("--only") + 1].split(",") if "--only" in argv else None
        for name, (cam, hidden) in views.items():
            if only and name not in only:
                continue
            for c in hidden:
                coll(c).hide_render = True
            if name == "view_house_box18" or name == "view_house":
                pass
            render_to(OUT / (name + ".jpg"), cam, (1920, 1080))
            for c in hidden:
                coll(c).hide_render = False
        if "--no-compare" not in argv and "--only" not in argv:
            compare_images(over_png)
    (OUT / "measurements.txt").write_text(
        "Generated by tools/blender/previews/trailer_park.py from docs/maps/trailer-park.webp\n\n" + "\n".join(LOG) + "\n",
        encoding="utf-8")
    for p in OUT.glob("*.blend1"):
        p.unlink()


main()
