"""
Stillblade greybox test map generator.

Run headless:
  blender --background --python tools/blender/greybox.py
  blender --background --python tools/blender/greybox.py -- --no-bake
      (skip the Cycles bake and reuse the existing baked texture; the lightmap
       UV layout is deterministic, so the old texture still lines up)
  Optional overrides for quick look-dev: -- --samples 64 --size 1024

Outputs (relative to this file):
  ../../client/public/maps/greybox.glb        visual mesh: ONE mesh, ONE material
  ../../client/public/maps/greybox.json       collision boxes + gameplay data (engine coords)
  ../../client/public/maps/greybox_baked.webp baked lighting atlas (sRGB)

Baked lighting:
  The world is lit once in Cycles (warm sun + cool sky + diffuse bounce) and the
  COMBINED result (albedo x direct + indirect) is baked into a single atlas.
  The game draws the world unlit from that atlas (client/src/maplook.ts).
  GLB vertex layout:
    TEXCOORD_0  world-space planar UVs, 1 unit = 1 m (for future detail textures)
    TEXCOORD_1  lightmap UVs into greybox_baked.* (non-overlapping, texel aligned)
    COLOR_0     flat category colour (fallback look when the atlas is not applied)
  Faces that can never be seen (box bottoms resting on the floor, faces pressed
  against or buried inside another box, the outside of the outer walls, the
  floor's underside/edges) are dropped before UV packing so no texels are wasted.

Single source of truth: BOXES below. Every solid in the map is an axis-aligned
box; the same list drives both the Blender meshes and the collision JSON.

Authoring space is Blender (Z up, metres). Layout:
  X = map width  (-15 .. 15, left/right as seen by ghosts)
  Y = map length (-22 .. 22, ghost spawn at -Y, defender spawn at +Y)
Engine space (glTF, Y up, -Z forward) = (x, z, -y), so ghosts at engine +Z face
-Z (yaw 0) and defenders at engine -Z face +Z (yaw 180).
"""

import json
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "client", "public", "maps"))
GLB_PATH = os.path.join(OUT_DIR, "greybox.glb")
JSON_PATH = os.path.join(OUT_DIR, "greybox.json")
BAKED_NAME = "greybox_baked.webp"
BAKED_PATH = os.path.join(OUT_DIR, BAKED_NAME)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"bake": True, "samples": 256, "size": 2048}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-bake":
            opts["bake"] = False
        elif a in ("--samples", "--size") and i + 1 < len(argv):
            opts[a[2:]] = int(argv[i + 1])
            i += 1
        else:
            raise SystemExit("[greybox] unknown argument: %s" % a)
        i += 1
    return opts

# ---------------------------------------------------------------------------
# Dimensions
# ---------------------------------------------------------------------------
HALF_W = 15.0        # interior half width  (X) -> 30 m
HALF_L = 22.0        # interior half length (Y) -> 44 m
WALL_T = 0.5         # outer wall thickness
WALL_H = 4.0         # outer wall height
INNER_H = 3.5        # inner wall height
FLOOR_T = 0.5

HULL_W = 0.6
HULL_H = 1.8
MIN_WALKWAY = 1.4
MAX_STEP_RISE = 0.3
MIN_TREAD = 0.4

# ---------------------------------------------------------------------------
# Box list: (name, category, (minx, miny, minz), (maxx, maxy, maxz))  Blender coords
# ---------------------------------------------------------------------------
BOXES = []


def box(name, category, mn, mx):
    assert all(a < b for a, b in zip(mn, mx)), name
    BOXES.append((name, category, tuple(float(v) for v in mn), tuple(float(v) for v in mx)))


def crate(idx, cx, cy, kind):
    """kind: 'c1' 1m cube, 'c2x' 2x1x1 long in X, 'c2y' 1x2x1 long in Y, 'c3' 1x1x2 stack."""
    sx, sy, sz = {"c1": (1, 1, 1), "c2x": (2, 1, 1), "c2y": (1, 2, 1), "c3": (1, 1, 2)}[kind]
    box("crate_%02d" % idx, "crate",
        (cx - sx / 2, cy - sy / 2, 0.0), (cx + sx / 2, cy + sy / 2, sz))


# Floor (top at z = 0), covers outer walls too
box("floor", "floor",
    (-HALF_W - WALL_T, -HALF_L - WALL_T, -FLOOR_T), (HALF_W + WALL_T, HALF_L + WALL_T, 0.0))

# Outer walls (long walls span full length incl. corners)
box("wall_outer_west", "outer_wall", (-HALF_W - WALL_T, -HALF_L - WALL_T, 0), (-HALF_W, HALF_L + WALL_T, WALL_H))
box("wall_outer_east", "outer_wall", (HALF_W, -HALF_L - WALL_T, 0), (HALF_W + WALL_T, HALF_L + WALL_T, WALL_H))
box("wall_outer_south", "outer_wall", (-HALF_W, -HALF_L - WALL_T, 0), (HALF_W, -HALF_L, WALL_H))   # ghost end
box("wall_outer_north", "outer_wall", (-HALF_W, HALF_L, 0), (HALF_W, HALF_L + WALL_T, WALL_H))     # defender end

# Lane dividers (run along Y), each with a 2 m door gap
# Left divider x -5.25..-4.75 : gap y -6..-4
box("wall_lane_L_1", "inner_wall", (-5.25, -14.0, 0), (-4.75, -6.0, INNER_H))
box("wall_lane_L_2", "inner_wall", (-5.25, -4.0, 0), (-4.75, 6.0, INNER_H))
# Right divider x 4.75..5.25 : gap y 0..2
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

# Raised platform overlooking mid (defender side), 5 x 4 m, 1.2 m high
PLAT_H = 1.2
box("platform_mid", "platform", (-2.5, 10.0, 0), (2.5, 14.0, PLAT_H))

# Staircase behind the platform, descending toward defender spawn (+Y)
STEP_RISE = 0.2
STEP_TREAD = 0.45
STAIR_X = (-1.0, 1.0)       # 2 m wide
STAIR_Y0 = 14.0             # back edge of platform
N_STEPS = int(round(PLAT_H / STEP_RISE)) - 1   # 5 steps, platform is the 6th rise
STEPS = []
for i in range(N_STEPS):
    top = PLAT_H - STEP_RISE * (i + 1)          # 1.0, 0.8, ... 0.2
    y0 = STAIR_Y0 + STEP_TREAD * i
    name = "stair_%02d" % (i + 1)
    box(name, "stairs", (STAIR_X[0], y0, 0.0), (STAIR_X[1], y0 + STEP_TREAD, top))
    STEPS.append(name)

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
# Visual-only decals and gameplay data (Blender coords)
# ---------------------------------------------------------------------------
SITES = [
    ("A", (-12.0, 8.0), (-6.0, 14.0)),
    ("B", (6.0, 8.0), (12.0, 14.0)),
]
SITE_H = 2.5
DECAL_T = 0.02

# (x, y) feet positions, yaw in engine degrees
SPAWNS = {
    "ghosts": [((x, -20.0), 0.0) for x in (-4.0, -2.0, 0.0, 2.0, 4.0)],
    "defenders": [((x, 20.0), 180.0) for x in (-4.0, -2.0, 0.0, 2.0, 4.0)],
}

# Surface colours: category -> (bake material name, linear RGB). These are the
# albedos the bake multiplies with light; the exported GLB has ONE material.
MATERIALS = {
    "floor": ("mat_floor", (0.24, 0.24, 0.25)),
    "wall": ("mat_wall", (0.46, 0.46, 0.475)),
    "crate": ("mat_crate", (0.68, 0.45, 0.21)),
    "platform": ("mat_platform", (0.38, 0.45, 0.55)),
    "site_A": ("mat_site_a", (0.66, 0.15, 0.12)),
    "site_B": ("mat_site_b", (0.12, 0.27, 0.65)),
}
CATEGORY_TO_MAT = {
    "floor": "floor",
    "outer_wall": "wall",
    "inner_wall": "wall",
    "crate": "crate",
    "platform": "platform",
    "stairs": "platform",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def to_engine_point(p):
    x, y, z = p
    return (x, z, -y)


def to_engine_box(mn, mx):
    a = to_engine_point(mn)
    b = to_engine_point(mx)
    return (tuple(min(a[i], b[i]) for i in range(3)), tuple(max(a[i], b[i]) for i in range(3)))


def r3(v):
    out = round(v, 3)
    return 0.0 if out == 0 else out   # avoid -0.0


def rv(v):
    return [r3(c) for c in v]


def overlap3(amn, amx, bmn, bmx, eps=1e-6):
    return all(amn[i] < bmx[i] - eps and bmn[i] < amx[i] - eps for i in range(3))


def rect_dist(amn, amx, bmn, bmx):
    dx = max(0.0, bmn[0] - amx[0], amn[0] - bmx[0])
    dy = max(0.0, bmn[1] - amx[1], amn[1] - bmx[1])
    return math.hypot(dx, dy)


def hull_box(x, y, z=0.0):
    h = HULL_W / 2
    return (x - h, y - h, z), (x + h, y + h, z + HULL_H)


class VerifyError(Exception):
    pass


# ---------------------------------------------------------------------------
# Verification (Blender coords)
# ---------------------------------------------------------------------------
def verify():
    print("[greybox] --- verification ---")
    errors = []

    names = [b[0] for b in BOXES]
    if len(names) != len(set(names)):
        errors.append("duplicate box names")

    # Spawns: inside walls, no intersection, spacing
    for team, spawns in SPAWNS.items():
        if len(spawns) != 5:
            errors.append("%s has %d spawns (need 5)" % (team, len(spawns)))
        for i, ((x, y), _yaw) in enumerate(spawns):
            hmn, hmx = hull_box(x, y)
            if not (-HALF_W <= hmn[0] and hmx[0] <= HALF_W and -HALF_L <= hmn[1] and hmx[1] <= HALF_L):
                errors.append("%s spawn %d outside outer walls" % (team, i))
            for name, _cat, mn, mx in BOXES:
                if overlap3(hmn, hmx, mn, mx):
                    errors.append("%s spawn %d intersects %s" % (team, i, name))
            for j in range(i + 1, len(spawns)):
                (x2, y2), _ = spawns[j]
                if math.hypot(x - x2, y - y2) < 1.2 - 1e-6:
                    errors.append("%s spawns %d/%d closer than 1.2 m" % (team, i, j))
    print("[greybox] spawns: %d ghosts, %d defenders checked"
          % (len(SPAWNS["ghosts"]), len(SPAWNS["defenders"])))

    # Stairs: rise sequence floor -> steps -> platform
    by_name = {b[0]: b for b in BOXES}
    steps = sorted((by_name[n] for n in STEPS), key=lambda b: b[3][2])
    tops = [0.0] + [s[3][2] for s in steps] + [PLAT_H]
    rises = [round(tops[i + 1] - tops[i], 4) for i in range(len(tops) - 1)]
    for r in rises:
        if r > MAX_STEP_RISE + 1e-6 or r <= 0:
            errors.append("bad stair rise %.3f" % r)
    for s in steps:
        tread = s[3][1] - s[2][1]
        width = s[3][0] - s[2][0]
        if tread < MIN_TREAD - 1e-6:
            errors.append("%s tread %.3f < %.2f" % (s[0], tread, MIN_TREAD))
        if width < 1.6 - 1e-6:
            errors.append("%s width %.3f < 1.6" % (s[0], width))
        # headroom: a player standing on this step must not hit anything except
        # the next steps / platform (which the hull overhangs because tread < hull)
        cx = (s[2][0] + s[3][0]) / 2
        cy = (s[2][1] + s[3][1]) / 2
        hmn, hmx = hull_box(cx, cy, s[3][2])
        for name, c, mn, mx in BOXES:
            if c in ("stairs", "platform"):
                continue
            if overlap3(hmn, hmx, mn, mx):
                errors.append("hull on %s intersects %s" % (s[0], name))
    print("[greybox] stairs: %d steps, rises %s (max %.2f)" % (len(steps), rises, max(rises)))

    # Walkway gaps: any two ground-level solids must touch or leave >= 1.4 m
    ground = [b for b in BOXES if b[1] != "floor" and b[2][2] < HULL_H and b[3][2] > 0.05]
    narrow = []
    for i in range(len(ground)):
        for j in range(i + 1, len(ground)):
            a, b = ground[i], ground[j]
            if a[1] in ("stairs", "platform") and b[1] in ("stairs", "platform"):
                continue   # staircase pieces form one walkable structure
            d = rect_dist(a[2], a[3], b[2], b[3])
            if 1e-6 < d < MIN_WALKWAY - 1e-6:
                narrow.append("%s <-> %s gap %.2f m" % (a[0], b[0], d))
            if overlap3(a[2], a[3], b[2], b[3]):
                narrow.append("%s overlaps %s" % (a[0], b[0]))
    errors.extend(narrow)
    print("[greybox] walkway gaps: %d ground solids, %d narrow gaps" % (len(ground), len(narrow)))

    # Door gaps in lane dividers >= 1.6 m (checked by construction above: 2 m)
    if errors:
        for e in errors:
            print("[greybox] FAIL: " + e)
        raise VerifyError("%d verification failure(s)" % len(errors))
    print("[greybox] verification passed")


# ---------------------------------------------------------------------------
# Lighting / bake settings
# ---------------------------------------------------------------------------
# Direction TOWARD the sun. Same azimuth as the realtime sun in client/src/main.ts
# (which still lights players and the viewmodel), at a 50 degree elevation so
# shadows are readable but lanes are not drowned in shade.
SUN_HORIZONTAL = (0.573, -0.820)    # (x, y), normalised: sun over the ghost/east side
SUN_ELEVATION = math.radians(50.0)
SUN_COLOR = (1.0, 0.93, 0.82)       # slightly warm
SUN_STRENGTH = 2.2                  # W/m^2 (calibrated: shade ~45-70 % of sunlit)
SUN_ANGLE = math.radians(3.0)       # angular diameter -> soft-ish penumbra
SKY_COLOR = (0.72, 0.83, 1.0)       # slightly cool
SKY_STRENGTH = 1.25
DIFFUSE_BOUNCES = 3
LIGHTMAP_PAD = 4                    # texels of padding on each side of every island
WEBP_QUALITY = 92
DITHER = 0.6                        # breaks up 8-bit banding in soft gradients

EPS = 1e-6


def setattr_if(obj, name, value):
    if hasattr(obj, name):
        try:
            setattr(obj, name, value)
            return True
        except (TypeError, ValueError, AttributeError) as exc:
            print("[greybox] could not set %s.%s: %s" % (type(obj).__name__, name, exc))
    return False


# ---------------------------------------------------------------------------
# Blender scene
# ---------------------------------------------------------------------------
BOX_FACES = [
    (0, 3, 2, 1),  # bottom (-Z)
    (4, 5, 6, 7),  # top (+Z)
    (0, 1, 5, 4),  # -Y
    (2, 3, 7, 6),  # +Y
    (1, 2, 6, 5),  # +X
    (3, 0, 4, 7),  # -X
]
FACE_AXIS = [(2, -1), (2, 1), (1, -1), (1, 1), (0, 1), (0, -1)]   # (axis, outward sign)


def box_verts(mn, mx):
    x0, y0, z0 = mn
    x1, y1, z1 = mx
    return [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]


def face_hidden(idx, mn, mx, axis, sign, solids, map_mn, map_mx):
    """True if this box face can never be seen by a player.

    - It faces out of the map (outside of the outer walls, floor edges/underside).
    - Another solid covers the whole face and lies on its outward side, i.e. the
      face rests on / is pressed against / is buried inside that solid.
    Partially covered faces are kept, so nothing visible is ever removed."""
    c = mx[axis] if sign > 0 else mn[axis]
    if axis < 2:
        edge = map_mx[axis] if sign > 0 else map_mn[axis]
        if abs(c - edge) < EPS:
            return True
    elif sign < 0 and abs(c - map_mn[2]) < EPS:
        return True
    tangents = [i for i in range(3) if i != axis]
    for j, (bmn, bmx) in enumerate(solids):
        if j == idx:
            continue
        if any(bmn[i] > mn[i] + EPS or bmx[i] < mx[i] - EPS for i in tangents):
            continue
        if sign > 0 and bmn[axis] <= c + EPS and bmx[axis] > c + 1e-4:
            return True
        if sign < 0 and bmx[axis] >= c - EPS and bmn[axis] < c - 1e-4:
            return True
    return False


def collect_faces():
    """All visible box faces: list of dicts {pts, axis, key}."""
    solids = [(cat, mn, mx) for _n, cat, mn, mx in BOXES]
    keys = [CATEGORY_TO_MAT[cat] for _n, cat, _mn, _mx in BOXES]
    for name, (x0, y0), (x1, y1) in SITES:
        solids.append(("site", (x0, y0, 0.0), (x1, y1, DECAL_T)))
        keys.append("site_" + name)
    map_mn = [min(b[2][i] for b in BOXES) for i in range(3)]
    map_mx = [max(b[3][i] for b in BOXES) for i in range(3)]
    occluders = [(mn, mx) for _c, mn, mx in solids]

    faces, hidden = [], 0
    for idx, (_cat, mn, mx) in enumerate(solids):
        v = box_verts(mn, mx)
        for f, (axis, sign) in zip(BOX_FACES, FACE_AXIS):
            if face_hidden(idx, mn, mx, axis, sign, occluders, map_mn, map_mx):
                hidden += 1
                continue
            faces.append({"pts": [v[i] for i in f], "axis": axis, "key": keys[idx]})
    return faces, hidden


def dist(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def skyline_pack(rects, size):
    """Bottom-left skyline packer. rects: [(id, w, h)] in texels.
    Returns {id: (x, y, rotated)} or None if they do not fit in size x size."""
    sky = [[0, 0, size]]            # segments [x, y, width], contiguous over [0, size)
    out = {}
    order = sorted(rects, key=lambda r: (max(r[1], r[2]), min(r[1], r[2]), -r[0]), reverse=True)
    for rid, w, h in order:
        best = None
        for rw, rh, rot in ((w, h, False), (h, w, True)):
            if rw > size or rh > size:
                continue
            for i in range(len(sky)):
                x = sky[i][0]
                if x + rw > size:
                    break
                y, left, j = 0, rw, i
                while left > 0:
                    y = max(y, sky[j][1])
                    left -= sky[j][2]
                    j += 1
                if y + rh > size:
                    continue
                score = (y + rh, x)
                if best is None or score < best[0]:
                    best = (score, i, x, y, rw, rh, rot)
        if best is None:
            return None
        _s, i, x, y, rw, rh, rot = best
        out[rid] = (x, y, rot)
        sky.insert(i, [x, y + rh, rw])
        j = i + 1
        while j < len(sky) and sky[j][0] < x + rw:
            cut = x + rw - sky[j][0]
            if cut >= sky[j][2]:
                del sky[j]
            else:
                sky[j][0] += cut
                sky[j][2] -= cut
                break
        k = 0
        while k < len(sky) - 1:                 # merge equal heights
            if sky[k][1] == sky[k + 1][1]:
                sky[k][2] += sky[k + 1][2]
                del sky[k + 1]
            else:
                k += 1
    return out


def pack_lightmap(faces, size):
    """Assign every face a texel-aligned island in one size x size atlas, at the
    highest uniform texel density that fits. Writes face['lm'] = 4 UV corners."""
    pad = LIGHTMAP_PAD

    def dims(f, d):
        p = f["pts"]
        return (max(1, int(math.ceil(dist(p[0], p[1]) * d - 1e-9))),
                max(1, int(math.ceil(dist(p[0], p[3]) * d - 1e-9))))

    lo, hi, best = 1.0, float(size), None
    for _ in range(22):
        mid = (lo + hi) / 2
        rects = [(i, w + 2 * pad, h + 2 * pad) for i, (w, h) in enumerate(dims(f, mid) for f in faces)]
        placed = skyline_pack(rects, size)
        if placed is None:
            hi = mid
        else:
            lo, best = mid, (mid, placed)
    if best is None:
        raise RuntimeError("lightmap islands do not fit in %d^2" % size)
    density, placed = best
    used = 0
    for i, f in enumerate(faces):
        w, h = dims(f, density)
        x, y, rot = placed[i]
        ox, oy = x + pad, y + pad
        if not rot:
            corners = [(ox, oy), (ox + w, oy), (ox + w, oy + h), (ox, oy + h)]
        else:
            corners = [(ox, oy), (ox, oy + w), (ox + h, oy + w), (ox + h, oy)]
        f["lm"] = [(u / size, v / size) for u, v in corners]
        used += w * h
    return density, used / float(size * size)


def world_uv(p, axis):
    x, y, z = p
    return {2: (x, y), 1: (x, z), 0: (y, z)}[axis]


def make_bake_material(name, rgb):
    """Pure diffuse albedo for the bake (no specular, so the bake is view independent)."""
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:   # Blender 5.x creates node trees by default
        mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    dif = nodes.new("ShaderNodeBsdfDiffuse")
    dif.inputs["Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    links.new(dif.outputs["BSDF"], out.inputs["Surface"])
    mat.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    return mat


def make_export_material():
    """The single material written to the GLB. White base colour multiplied by
    COLOR_0 gives the old flat greybox look if the baked atlas is not applied;
    maplook.ts replaces it with an unlit material sampling the atlas on UV1."""
    mat = bpy.data.materials.new("mat_world")
    if mat.node_tree is None:
        mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.cameras,
                 bpy.data.lights, bpy.data.worlds, bpy.data.images):
        for item in list(coll):
            coll.remove(item)


def build_scene(atlas_size):
    """One mesh object for the whole world, one bake material per category."""
    faces, hidden = collect_faces()
    density, fill = pack_lightmap(faces, atlas_size)

    keys = list(MATERIALS.keys())
    verts, polys = [], []
    for f in faces:
        base = len(verts)
        verts.extend(f["pts"])
        polys.append((base, base + 1, base + 2, base + 3))
    mesh = bpy.data.meshes.new("greybox_world")
    mesh.from_pydata(verts, [], polys)
    mesh.validate()
    mesh.update()
    for key in keys:
        mesh.materials.append(make_bake_material(*MATERIALS[key]))

    uv_world = mesh.uv_layers.new(name="world")       # -> TEXCOORD_0
    uv_lm = mesh.uv_layers.new(name="lightmap")       # -> TEXCOORD_1
    col = mesh.color_attributes.new("Color", "BYTE_COLOR", "CORNER")
    mesh.color_attributes.active_color = col
    if len(mesh.polygons) != len(faces):
        raise RuntimeError("mesh validation changed the face count")
    for pi, poly in enumerate(mesh.polygons):
        f = faces[pi]
        poly.use_smooth = False
        poly.material_index = keys.index(f["key"])
        rgb = MATERIALS[f["key"]][1]
        for li in poly.loop_indices:
            corner = mesh.loops[li].vertex_index - 4 * pi
            if not 0 <= corner < 4:
                raise RuntimeError("unexpected loop order after validate()")
            uv_world.data[li].uv = world_uv(f["pts"][corner], f["axis"])
            uv_lm.data[li].uv = f["lm"][corner]
            col.data[li].color = (rgb[0], rgb[1], rgb[2], 1.0)
    uv_lm.active_render = True
    uv_lm.active = True

    obj = bpy.data.objects.new("greybox_world", mesh)
    bpy.context.scene.collection.objects.link(obj)
    print("[greybox] world mesh: %d faces kept, %d hidden faces removed, %d verts"
          % (len(faces), hidden, len(verts)))
    print("[greybox] lightmap: %d^2, %.1f texels/m (%.1f cm/texel), %.0f%% of atlas used by islands, pad %d"
          % (atlas_size, density, 100.0 / density, fill * 100, LIGHTMAP_PAD))
    return obj, faces, len(keys)


# ---------------------------------------------------------------------------
# Bake
# ---------------------------------------------------------------------------
def setup_lighting(samples):
    from mathutils import Vector
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    cy = scene.cycles
    setattr_if(cy, "device", "CPU")
    cy.samples = samples
    setattr_if(cy, "use_adaptive_sampling", False)
    setattr_if(cy, "use_denoising", False)          # denoised in the compositor after baking
    setattr_if(cy, "max_bounces", DIFFUSE_BOUNCES)
    setattr_if(cy, "diffuse_bounces", DIFFUSE_BOUNCES)
    for name in ("glossy_bounces", "transmission_bounces", "volume_bounces"):
        setattr_if(cy, name, 0)
    setattr_if(cy, "caustics_reflective", False)
    setattr_if(cy, "caustics_refractive", False)
    setattr_if(cy, "sample_clamp_indirect", 4.0)

    world = bpy.data.worlds.new("sky")
    scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg is None:
        bg = world.node_tree.nodes.new("ShaderNodeBackground")
        out = next((n for n in world.node_tree.nodes if n.type == "OUTPUT_WORLD"), None) \
            or world.node_tree.nodes.new("ShaderNodeOutputWorld")
        world.node_tree.links.new(bg.outputs["Background"], out.inputs["Surface"])
    bg.inputs["Color"].default_value = (SKY_COLOR[0], SKY_COLOR[1], SKY_COLOR[2], 1.0)
    bg.inputs["Strength"].default_value = SKY_STRENGTH

    light = bpy.data.lights.new("sun", "SUN")
    light.energy = SUN_STRENGTH
    light.color = SUN_COLOR
    light.angle = SUN_ANGLE
    sun = bpy.data.objects.new("sun", light)
    h = math.cos(SUN_ELEVATION)
    to_sun = Vector((SUN_HORIZONTAL[0] * h, SUN_HORIZONTAL[1] * h, math.sin(SUN_ELEVATION))).normalized()
    sun.rotation_euler = to_sun.to_track_quat("Z", "Y").to_euler()   # lamp shines along its -Z
    scene.collection.objects.link(sun)


def sample_points(img, faces, size):
    """Linear baked values at a few reference spots, for checking the shade ratio."""
    import numpy as np
    px = np.empty(size * size * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(size, size, 4)

    def at(point, axis, sign_dir):
        for f in faces:
            p = f["pts"]
            if f["axis"] != axis:
                continue
            n = [0, 0, 0]
            e1 = [p[1][i] - p[0][i] for i in range(3)]
            e3 = [p[3][i] - p[0][i] for i in range(3)]
            n = [e1[1] * e3[2] - e1[2] * e3[1], e1[2] * e3[0] - e1[0] * e3[2], e1[0] * e3[1] - e1[1] * e3[0]]
            if n[axis] * sign_dir <= 0 or abs(point[axis] - p[0][axis]) > 1e-4:
                continue
            d = [point[i] - p[0][i] for i in range(3)]
            s = sum(d[i] * e1[i] for i in range(3)) / sum(c * c for c in e1)
            t = sum(d[i] * e3[i] for i in range(3)) / sum(c * c for c in e3)
            if not (0 <= s <= 1 and 0 <= t <= 1):
                continue
            lm = f["lm"]
            u = lm[0][0] + s * (lm[1][0] - lm[0][0]) + t * (lm[3][0] - lm[0][0])
            v = lm[0][1] + s * (lm[1][1] - lm[0][1]) + t * (lm[3][1] - lm[0][1])
            x, y = int(u * size), int(v * size)
            win = px[max(0, y - 2):y + 3, max(0, x - 2):x + 3, :3]
            return [round(float(c), 3) for c in win.reshape(-1, 3).mean(axis=0)]
        return None

    spots = [
        ("floor sunlit (mid)", (0.0, -3.0, 0.0), 2, 1),
        ("floor shade (W of lane wall L)", (-5.8, 2.5, 0.0), 2, 1),
        ("floor shade (open, behind crate 05)", (-0.5, -8.2, 0.0), 2, 1),
        ("wall sunlit (+X face lane L)", (-4.75, 0.0, 1.5), 0, 1),
        ("wall shade (-X face lane L)", (-5.25, 0.0, 1.5), 0, -1),
        ("wall sunlit (-Y face site B entry)", (7.0, 6.0, 1.5), 1, -1),
        ("crate top", (-12.0, -10.0, 1.0), 2, 1),
        ("site A floor marker", (-11.0, 13.0, DECAL_T), 2, 1),
        ("site B floor marker", (11.0, 13.0, DECAL_T), 2, 1),
    ]
    vals = {}
    for label, p, axis, sgn in spots:
        vals[label] = at(p, axis, sgn)
        print("[greybox]   %-36s linear %s" % (label, vals[label]))

    def lum(c):
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] if c else float("nan")
    print("[greybox]   shade/sunlit ratio: floor by wall %.2f, open floor %.2f, wall %.2f; atlas max %.3f"
          % (lum(vals["floor shade (W of lane wall L)"]) / lum(vals["floor sunlit (mid)"]),
             lum(vals["floor shade (open, behind crate 05)"]) / lum(vals["floor sunlit (mid)"]),
             lum(vals["wall shade (-X face lane L)"]) / lum(vals["wall sunlit (+X face lane L)"]),
             float(px[:, :, :3].max())))


def denoise_and_save(img, path, size):
    """OIDN-denoise the float bake in the compositor and write it as sRGB."""
    scene = bpy.context.scene
    tree = bpy.data.node_groups.new("bake_denoise", "CompositorNodeTree")
    tree.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    n_img = tree.nodes.new("CompositorNodeImage")
    n_img.image = img
    n_dn = tree.nodes.new("CompositorNodeDenoise")
    for name, value in (("HDR", True), ("Prefilter", "Accurate"), ("Quality", "High")):
        sock = n_dn.inputs.get(name)
        if sock is not None:
            try:
                sock.default_value = value
            except (TypeError, ValueError) as exc:
                print("[greybox] denoise %s: %s" % (name, exc))
    n_out = tree.nodes.new("NodeGroupOutput")
    tree.links.new(n_img.outputs["Image"], n_dn.inputs["Image"])
    tree.links.new(n_dn.outputs["Image"], n_out.inputs[0])
    scene.compositing_node_group = tree

    if scene.camera is None:     # the render pipeline wants a camera even for compositing only
        cam = bpy.data.objects.new("bake_cam", bpy.data.cameras.new("bake_cam"))
        scene.collection.objects.link(cam)
        scene.camera = cam
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.use_compositing = True
    setattr_if(scene.render, "dither_intensity", DITHER)
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    bpy.ops.render.render()

    ims = scene.render.image_settings
    ims.file_format = "WEBP"
    ims.color_mode = "RGB"
    ims.quality = WEBP_QUALITY
    rr = bpy.data.images["Render Result"]
    rr.save_render(path, scene=scene)
    if not os.path.exists(path):
        raise RuntimeError("baked texture was not written: %s" % path)


def bake_lighting(obj, faces, size, samples):
    import time
    t0 = time.time()
    setup_lighting(samples)
    img = bpy.data.images.new("greybox_baked", size, size, alpha=False, float_buffer=True)
    for slot in obj.material_slots:
        nt = slot.material.node_tree
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.nodes.active = tex                 # bake target (not connected)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    print("[greybox] baking %d^2 COMBINED (diffuse direct+indirect), %d samples, %d bounces ..."
          % (size, samples, DIFFUSE_BOUNCES))
    res = bpy.ops.object.bake(
        type="COMBINED", pass_filter={"DIRECT", "INDIRECT", "DIFFUSE"},
        margin=LIGHTMAP_PAD, margin_type="EXTEND", uv_layer="lightmap",
        use_clear=True, target="IMAGE_TEXTURES", use_selected_to_active=False)
    if "FINISHED" not in res:
        raise RuntimeError("bake failed: %s" % (res,))
    t_bake = time.time() - t0
    sample_points(img, faces, size)
    denoise_and_save(img, BAKED_PATH, size)
    print("[greybox] bake %.1f s, denoise+save %.1f s -> %s (%d bytes)"
          % (t_bake, time.time() - t0 - t_bake, BAKED_PATH, os.path.getsize(BAKED_PATH)))


def finalize_materials(obj):
    mesh = obj.data
    mesh.materials.clear()
    mesh.materials.append(make_export_material())
    for poly in mesh.polygons:
        poly.material_index = 0


def export_glb():
    os.makedirs(OUT_DIR, exist_ok=True)
    kwargs = dict(
        filepath=GLB_PATH,
        export_format="GLB",
        export_yup=True,
        use_selection=False,
        export_apply=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_normals=True,
        export_texcoords=True,
        export_tangents=False,
        export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        export_extras=False,
    )
    # Drop any keyword this exporter version does not know about.
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    dropped = [k for k in kwargs if k not in props]
    for k in dropped:
        kwargs.pop(k)
    if dropped:
        print("[greybox] exporter ignored unknown options: %s" % dropped)
    result = bpy.ops.export_scene.gltf(**kwargs)
    if "FINISHED" not in result:
        raise RuntimeError("glTF export failed: %s" % (result,))


def inspect_glb():
    """Read back the GLB's JSON chunk: meshes, primitives, materials, attributes."""
    import struct
    with open(GLB_PATH, "rb") as f:
        data = f.read()
    length, ctype = struct.unpack_from("<II", data, 12)
    gltf = json.loads(data[20:20 + length].decode("utf-8"))
    prims = [p for m in gltf.get("meshes", []) for p in m["primitives"]]
    attrs = sorted(prims[0]["attributes"].keys()) if prims else []
    info = {"meshes": len(gltf.get("meshes", [])), "primitives": len(prims),
            "materials": len(gltf.get("materials", [])), "images": len(gltf.get("images", [])),
            "attributes": attrs}
    if info["meshes"] != 1 or info["primitives"] != 1 or info["materials"] != 1:
        raise RuntimeError("expected one mesh/primitive/material, got %s" % info)
    for need in ("TEXCOORD_0", "TEXCOORD_1"):
        if need not in attrs:
            raise RuntimeError("GLB is missing %s: %s" % (need, attrs))
    return info


def write_json(baked=None):
    boxes_out = []
    for name, cat, mn, mx in BOXES:
        emn, emx = to_engine_box(mn, mx)
        boxes_out.append({"name": name, "category": cat, "min": rv(emn), "max": rv(emx)})

    bmn = [min(b["min"][i] for b in boxes_out) for i in range(3)]
    bmx = [max(b["max"][i] for b in boxes_out) for i in range(3)]

    spawns_out = {}
    for team, spawns in SPAWNS.items():
        spawns_out[team] = [{"pos": rv(to_engine_point((x, y, 0.0))), "yaw": yaw}
                            for (x, y), yaw in spawns]

    sites_out = []
    for name, (x0, y0), (x1, y1) in SITES:
        emn, emx = to_engine_box((x0, y0, 0.0), (x1, y1, SITE_H))
        sites_out.append({"name": name, "min": rv(emn), "max": rv(emx)})

    data = {
        "name": "greybox",
        "bounds": {"min": rv(bmn), "max": rv(bmx)},
        "boxes": boxes_out,
        "spawns": spawns_out,
        "bombSites": sites_out,
    }
    if baked:
        data["baked"] = baked     # lighting atlas, sampled with TEXCOORD_1 of the GLB
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(JSON_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    return data


def centre(points):
    n = len(points)
    return [r3(sum(p[i] for p in points) / n) for i in range(3)]


def main():
    opts = parse_args()
    verify()
    reset_scene()
    size = opts["size"]
    if not opts["bake"]:
        if os.path.exists(BAKED_PATH):
            existing = bpy.data.images.load(BAKED_PATH)
            size = existing.size[0]           # UV layout is texel aligned to this size
            bpy.data.images.remove(existing)
            print("[greybox] --no-bake: reusing %s (%d^2)" % (BAKED_PATH, size))
        else:
            print("[greybox] WARNING --no-bake but %s does not exist; map will be unlit-fallback" % BAKED_PATH)
    obj, faces, n_bake_mats = build_scene(size)
    if opts["bake"]:
        bake_lighting(obj, faces, size, opts["samples"])
    finalize_materials(obj)
    export_glb()
    glb = inspect_glb()
    data = write_json(BAKED_NAME if os.path.exists(BAKED_PATH) else None)

    glb_size = os.path.getsize(GLB_PATH)
    json_size = os.path.getsize(JSON_PATH)
    print("[greybox] --- summary ---")
    print("[greybox] boxes (collision): %d  (crates %d)"
          % (len(BOXES), sum(1 for b in BOXES if b[1] == "crate")))
    print("[greybox] GLB: %d mesh, %d primitive, %d material, %d images, attributes %s (baked from %d colours)"
          % (glb["meshes"], glb["primitives"], glb["materials"], glb["images"], glb["attributes"], n_bake_mats))
    print("[greybox] engine bounds: min %s max %s" % (data["bounds"]["min"], data["bounds"]["max"]))
    print("[greybox] ghost spawn centre:    %s" % centre([s["pos"] for s in data["spawns"]["ghosts"]]))
    print("[greybox] defender spawn centre: %s" % centre([s["pos"] for s in data["spawns"]["defenders"]]))
    for s in data["bombSites"]:
        print("[greybox] site %s centre: %s" % (s["name"], centre([s["min"], s["max"]])))
    print("[greybox] %s : %d bytes" % (GLB_PATH, glb_size))
    print("[greybox] %s : %d bytes" % (JSON_PATH, json_size))
    if os.path.exists(BAKED_PATH):
        print("[greybox] %s : %d bytes" % (BAKED_PATH, os.path.getsize(BAKED_PATH)))
    if glb_size <= 0 or glb_size > 1024 * 1024:
        raise RuntimeError("GLB size out of range: %d" % glb_size)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # make headless runs fail loudly with non-zero exit
        import traceback
        traceback.print_exc()
        print("[greybox] ERROR: %s" % exc)
        sys.exit(1)
