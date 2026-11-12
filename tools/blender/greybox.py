"""
Stillblade greybox test map generator.

ONE command regenerates everything shipped for this map:
  blender --background --python tools/blender/greybox.py
  blender --background --python tools/blender/greybox.py -- --no-bake
      (skip the Cycles bake and reuse the existing baked texture; the lightmap
       UV layout is deterministic, so the old texture still lines up)
  Optional overrides for quick look-dev: -- --samples 64 --size 1024

Outputs (relative to this file, all in ../../client/public/maps/):
  greybox.glb          visual meshes: world (one primitive per surface material) + paint decals
  greybox.json         collision boxes + gameplay data (engine coords) + "look" (render setup)
  greybox_baked.webp   baked LIGHT atlas (lighting only, no surface colour; encoding below)
  tex_*.webp           tiling albedo textures, one per surface material
  sky.jpg              tonemapped LDR sky (upper hemisphere equirect strip)

Source art (CC0, see client/public/maps/CREDITS.md) lives in tools/blender/source-art/,
which is NOT committed (raw downloads are large). When it is missing, the texture and sky
processing steps are skipped and the already shipped tex_*.webp / sky.jpg are reused
(the bake then reads the mean albedo of each material from the shipped texture).

Baked lighting:
  The world is lit once in Cycles by the Poly Haven HDRI sky (sun disc removed and
  replaced by an explicit sun lamp at the HDRI's sun direction, so shadows are crisp
  and noise-free) with realistic surface albedos for correct coloured bounce. The bake
  stores DIFFUSE DIRECT+INDIRECT WITHOUT the colour pass, i.e. pure incoming light.
  The game multiplies it with the tiling albedo textures (client/src/maplook.ts):
      colour = albedo(TEXCOORD_0 / tile) * COLOR_0 * light(TEXCOORD_1)
  Light encoding (8-bit sRGB atlas): stored = srgb_encode(light / LIGHT_SCALE),
  decoded on the GPU as  light = srgb_decode(texel) * LIGHT_SCALE  (LIGHT_SCALE = 2,
  written to greybox.json as look.lightScale). Light above 2.0 clips.
  GLB vertex layout:
    TEXCOORD_0  world-space planar UVs, 1 unit = 1 m (tiling albedo textures)
    TEXCOORD_1  lightmap UVs into greybox_baked.* (non-overlapping, texel aligned)
    COLOR_0     linear albedo multiplier: skirting band / grime gradient / large-scale
                variation / per-box tint (walls, floor, crates) and paint colour (decals)
  Faces that can never be seen (box bottoms resting on the floor, faces pressed
  against or buried inside another box, the outside of the outer walls, the
  floor's underside/edges) are dropped before UV packing so no texels are wasted.
  After packing, wall and floor faces are cut into sub-quads (same plane, UVs
  interpolated inside the face's lightmap island) purely to carry vertex colour.
  Paint decals (bomb-site markings, wall letters) are flat quads a few mm off their
  surface; they are NOT in the bake and reuse the lightmap island of the surface
  underneath, so they get exactly its lighting.

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
SOURCE_DIR = os.path.join(HERE, "source-art")
SKY_NAME = "sky.jpg"
SKY_PATH = os.path.join(OUT_DIR, SKY_NAME)
HDRI_PATH = os.path.join(SOURCE_DIR, "hdri", "kloofendal_48d_partly_cloudy_puresky_2k.hdr")


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

# ---------------------------------------------------------------------------
# Surface materials (art pass)
# ---------------------------------------------------------------------------
# key -> albedo texture processing + tiling. `src` is a CC0 Poly Haven diffuse map in
# source-art/textures/ (see CREDITS.md); it is resized, low-frequency "detiled" (large
# blotches that would repeat visibly are flattened), reduced in contrast (log space),
# desaturated, and scaled to the target mean linear albedo `albedo` (x `tint`).
# `tile` = metres covered by one texture repeat (the source's real-world size).
TEXTURE_SIZE = 1024
TEXTURE_WEBP_QUALITY = 82
TEXTURES = {
    "floor": dict(src="concrete_floor_02_diff_1k.jpg", out="tex_floor.webp", tile=2.5,
                  albedo=0.23, contrast=0.75, sat=0.45, detile=0.55, tint=(1.0, 0.99, 0.96)),
    "wall_outer": dict(src="factory_brick_diff_1k.jpg", out="tex_wall_outer.webp", tile=1.5,
                       albedo=0.2, contrast=0.75, sat=0.85, detile=0.6, tint=(1.0, 1.0, 1.0)),
    "wall_inner": dict(src="concrete_wall_004_diff_1k.jpg", out="tex_wall_inner.webp", tile=2.0,
                       albedo=0.27, contrast=0.9, sat=0.8, detile=0.5, tint=(1.0, 1.0, 1.0)),
    "crate": dict(src="raw_plank_wall_diff_1k.jpg", out="tex_crate.webp", tile=1.87,
                  albedo=0.30, contrast=0.7, sat=0.85, detile=0.5, tint=(1.0, 1.0, 1.0)),
    "metal": dict(src="blue_metal_plate_diff_1k.jpg", out="tex_metal.webp", tile=2.5,
                  albedo=0.19, contrast=0.8, sat=0.35, detile=0.5, tint=(1.0, 1.0, 1.0)),
}
# Export material name per surface key (maplook.ts matches meshes by these names).
EXPORT_NAMES = {k: "map_" + k for k in list(TEXTURES) + ["paint"]}
PAINT_TINT = 2.0             # paint decals: floor texture x COLOR_0 x 2 (COLOR_0 is <= 1)
CATEGORY_TO_MAT = {
    "floor": "floor",
    "outer_wall": "wall_outer",
    "inner_wall": "wall_inner",
    "crate": "crate",
    "platform": "metal",
    "stairs": "metal",
}

# Vertex-colour shaping (multipliers on the albedo; 1 = texture as is)
SKIRT_H = 0.3                # dark painted base band on every wall
SKIRT_MUL = 0.55
GRIME_TOP = 1.4              # grime gradient from the skirting up to this height
GRIME_MUL = 0.84
CAP_H = 0.15                 # darker coping band at the top of the walls
CAP_MUL = 0.8
WALL_TOP_MUL = 0.8           # top faces of walls
SUBDIV = 3.0                 # metres between vertex-colour sub-quad cuts on walls/floor
NOISE_SCALE = 4.0            # metres per value-noise lattice cell
NOISE_AMP = {"floor": 0.16, "wall_outer": 0.10, "wall_inner": 0.08}
PAINT_Z = (0.006, 0.012)     # paint decal offsets above the floor: fill, lines/letters
WALL_PAINT_OFF = 0.008       # wall letters off the wall surface

# Paint colours (COLOR_0, linear; the paint material multiplies by PAINT_TINT).
PAINT = {
    "A": dict(line=(0.95, 0.10, 0.07), fill=(0.62, 0.44, 0.42)),
    "B": dict(line=(0.09, 0.27, 1.0), fill=(0.42, 0.48, 0.66)),
}
SITE_LINE_W = 0.25           # painted border width
# 8x10 bold stencil glyphs (2-cell strokes), top row first.
GLYPHS = {
    "A": ["..####..", ".######.", "###..###", "##....##", "##....##",
          "########", "########", "##....##", "##....##", "##....##"],
    "B": ["#######.", "########", "##....##", "##....##", "#######.",
          "#######.", "##....##", "##....##", "########", "#######."],
}
GLYPH_W, GLYPH_H = 8, 10
# Floor letters: (site, centre (x, y), cell size) - placed clear of the site crates.
FLOOR_LETTERS = [("A", (-10.2, 12.25), 0.25), ("B", (7.9, 10.25), 0.25)]
# Wall letters: (site, face point on the wall plane (x, y, z centre), outward normal axis
# and sign, cell size). Upright, readable from in front of the wall.
WALL_LETTERS = [
    ("A", (-6.9, 6.0, 1.75), (1, -1), 0.17),     # site A entry wall, facing the A lane
    ("A", (-4.75, 12.5, 1.75), (0, 1), 0.17),    # mid connector wall, facing mid
    ("B", (6.9, 6.0, 1.75), (1, -1), 0.17),      # site B entry wall, facing the B lane
    ("B", (4.75, 12.5, 1.75), (0, -1), 0.17),    # mid connector wall, facing mid
]


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
# The sky is the Poly Haven HDRI "Kloofendal 48d Partly Cloudy (Pure Sky)", used unrotated.
# Its sun sits at 47.9 deg elevation; horizontally, toward the sun is (0.827, -0.562) in
# Blender (x, y): over the east / ghost side, so lane walls throw shadows across the lanes.
# The realtime sun in client/src/main.ts (players + viewmodel) uses the same direction
# (engine euler (42, 55.8, 0)); the script checks the HDRI agrees with these constants.
SUN_HORIZONTAL = (0.827, -0.562)    # (x, y), normalised
SUN_ELEVATION = math.radians(47.9)
HDRI_SUN_CLAMP = 3.0                # sky radiance above this (the sun disc + halo) moves into the lamp
# Art direction: the real sun:sky ratio of the HDRI leaves shade at ~15-20 % of sunlit,
# far too dark to read ghosts in. The sun is dimmed and the sky fill lifted so shade
# lands at ~35-50 % of sunlit while the sunlit floor stays around 1.6 (light units).
SUN_SCALE = 0.40                    # x the irradiance removed from the HDRI
SUN_WARMTH = (1.0, 0.93, 0.80)      # a little warmer than the HDRI's sun
SKY_SCALE = 2.6                     # x the (sun-less) HDRI radiance as fill light
SKY_FILL_TINT = (1.1, 1.0, 0.82)    # tames the HDRI's strong blue so shade is cool, not navy
SKY_DISPLAY_EXPOSURE = 1.25         # shipped sky image: x HDRI radiance before tonemapping
SUN_ANGLE = math.radians(1.2)       # angular diameter -> soft-edged shadows
DIFFUSE_BOUNCES = 4
LIGHT_SCALE = 2.0                   # atlas stores light / LIGHT_SCALE (then sRGB); shader undoes it
# Baked accent lights (point lamps, light only): (position, colour, power W, radius)
ACCENT_LIGHTS = [
    ((-9.0, 11.0, 3.2), (1.0, 0.35, 0.25), 120.0, 0.6),   # site A: red-ish
    ((9.0, 11.0, 3.2), (0.3, 0.5, 1.0), 120.0, 0.6),      # site B: blue-ish
    ((-5.0, -5.0, 3.0), (1.0, 0.7, 0.4), 45.0, 0.3),       # lane L door: warm
    ((5.0, 1.0, 3.0), (1.0, 0.7, 0.4), 45.0, 0.3),         # lane R door: warm
]
SKY_W, SKY_H = 2048, 512            # shipped sky strip size
SKY_ELEV_MIN = -6.0                 # degrees: bottom row of the strip (below: clamped)
SKY_JPEG_QUALITY = 88
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
    """All visible box faces: list of dicts {pts, axis, sign, key, box, top}."""
    solids = [(cat, mn, mx) for _n, cat, mn, mx in BOXES]
    keys = [CATEGORY_TO_MAT[cat] for _n, cat, _mn, _mx in BOXES]
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
            faces.append({"pts": [v[i] for i in f], "axis": axis, "sign": sign, "key": keys[idx],
                          "box": idx, "top": mx[2]})
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


def face_st(f, point, tol=1e-4):
    """(s, t) of `point` on rectangle face f (p0 + s*e1 + t*e3), or None if off the face."""
    p = f["pts"]
    if abs(point[f["axis"]] - p[0][f["axis"]]) > tol:
        return None
    e1 = [p[1][i] - p[0][i] for i in range(3)]
    e3 = [p[3][i] - p[0][i] for i in range(3)]
    d = [point[i] - p[0][i] for i in range(3)]
    s = sum(d[i] * e1[i] for i in range(3)) / sum(c * c for c in e1)
    t = sum(d[i] * e3[i] for i in range(3)) / sum(c * c for c in e3)
    if not (-1e-6 <= s <= 1 + 1e-6 and -1e-6 <= t <= 1 + 1e-6):
        return None
    return s, t


def lerp_face(f, s, t, field):
    q = f[field]
    return tuple(q[0][i] + s * (q[1][i] - q[0][i]) + t * (q[3][i] - q[0][i]) for i in range(len(q[0])))


def _hash_u32(*vals):
    h = 2166136261
    for v in vals:
        h ^= v & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    h ^= h >> 15
    h = (h * 0x2C1B3C6D) & 0xFFFFFFFF
    h ^= h >> 12
    h = (h * 0x297A2D39) & 0xFFFFFFFF
    h ^= h >> 15
    return h


def hash_signed(*vals):
    return _hash_u32(*vals) / 2147483647.5 - 1.0          # [-1, 1]


def name_rand(name, salt=0):
    import zlib
    return hash_signed(zlib.crc32(name.encode("utf-8")), salt)


def value_noise(p):
    """Smooth deterministic 3D value noise in [-1, 1], lattice NOISE_SCALE metres."""
    q = [c / NOISE_SCALE for c in p]
    i0 = [int(math.floor(c)) for c in q]
    fr = [c - math.floor(c) for c in q]
    w = [f * f * (3 - 2 * f) for f in fr]
    acc = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                wt = (w[0] if dx else 1 - w[0]) * (w[1] if dy else 1 - w[1]) * (w[2] if dz else 1 - w[2])
                acc += wt * hash_signed(i0[0] + dx, i0[1] + dy, i0[2] + dz, 7)
    return acc


def box_tint(f):
    """Per-box albedo multiplier (RGB): crates vary in brightness/warmth, walls barely."""
    name = BOXES[f["box"]][0]
    if f["key"] == "crate":
        b = 0.95 + 0.13 * name_rand(name)
        h = 0.06 * name_rand(name, 1)
        return (b * (1 + h), b, b * (1 - h))
    if f["key"] in ("wall_outer", "wall_inner"):
        b = 1.0 + 0.035 * name_rand(name)
        return (b, b, b)
    return (1.0, 1.0, 1.0)


def grid_cuts(p0, e, axis_world, spacing):
    """Parameter values in (0, 1) where p0 + s*e crosses world multiples of `spacing`."""
    a, b = p0[axis_world], p0[axis_world] + e[axis_world]
    lo, hi = min(a, b), max(a, b)
    out = []
    k = math.floor(lo / spacing) + 1
    while k * spacing < hi - 0.25:
        if k * spacing > lo + 0.25:
            out.append((k * spacing - a) / (b - a))
        k += 1
    return out


def subdivide(f):
    """Cut a face into sub-quads that carry vertex colour. Returns [(pts, lm, cols)]."""
    p = f["pts"]
    e1 = [p[1][i] - p[0][i] for i in range(3)]
    e3 = [p[3][i] - p[0][i] for i in range(3)]
    key, axis = f["key"], f["axis"]
    is_wall = key in ("wall_outer", "wall_inner")
    s_cuts, t_cuts = [], []
    vert_edge = None
    if axis == 2:
        if key == "floor":
            s_cuts = grid_cuts(p[0], e1, 0 if abs(e1[0]) > EPS else 1, SUBDIV)
            t_cuts = grid_cuts(p[0], e3, 0 if abs(e3[0]) > EPS else 1, SUBDIV)
    elif is_wall:
        vert_edge = 3 if abs(e3[2]) > EPS else 1
        horiz = e1 if vert_edge == 3 else e3
        hcuts = grid_cuts(p[0], horiz, 0 if abs(horiz[0]) > EPS else 1, SUBDIV)
        ev = e3 if vert_edge == 3 else e1
        z0 = p[0][2]
        vcuts = []
        for z in (SKIRT_H, GRIME_TOP, f["top"] - CAP_H):
            s = (z - z0) / ev[2]
            if 1e-4 < s < 1 - 1e-4:
                vcuts.append(s)
        vcuts.sort()
        if vert_edge == 3:
            s_cuts, t_cuts = hcuts, vcuts
        else:
            s_cuts, t_cuts = vcuts, hcuts
    S = [0.0] + sorted(s_cuts) + [1.0]
    T = [0.0] + sorted(t_cuts) + [1.0]
    tint = box_tint(f)
    amp = NOISE_AMP.get(key, 0.0)

    def colour(pt, band):
        m = 1.0 + amp * value_noise(pt) if amp else 1.0
        if is_wall:
            if axis == 2:
                m *= WALL_TOP_MUL
            elif band == "skirt":
                m *= SKIRT_MUL
            elif band == "cap":
                m *= CAP_MUL
            else:
                g = min(1.0, max(0.0, (pt[2] - SKIRT_H) / (GRIME_TOP - SKIRT_H)))
                m *= GRIME_MUL + (1.0 - GRIME_MUL) * g
        return tuple(min(1.0, c * m) for c in tint)

    out = []
    for j in range(len(T) - 1):
        for i in range(len(S) - 1):
            corners = [(S[i], T[j]), (S[i + 1], T[j]), (S[i + 1], T[j + 1]), (S[i], T[j + 1])]
            pts = [lerp_face(f, s, t, "pts") for s, t in corners]
            lm = [lerp_face(f, s, t, "lm") for s, t in corners]
            band = None
            if is_wall and axis != 2:
                mz = sum(q[2] for q in pts) / 4
                band = "skirt" if mz < SKIRT_H else ("cap" if mz > f["top"] - CAP_H else "body")
            out.append((pts, lm, [colour(q, band) for q in pts]))
    return out


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


def make_export_material(name, rgb):
    """A material written to the GLB. Only its NAME matters to the game: maplook.ts swaps
    it for the unlit albedo x lightmap shader (the base colour is a plain fallback)."""
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.cameras,
                 bpy.data.lights, bpy.data.worlds, bpy.data.images):
        for item in list(coll):
            coll.remove(item)


SURFACE_KEYS = ["floor", "wall_outer", "wall_inner", "crate", "metal"]


def make_mesh_object(name, quads, mat_keys, materials):
    """quads: [(pts, lm, cols, axis, key)] -> mesh object with UV0 world, UV1 lightmap, COLOR_0."""
    verts, polys = [], []
    for q in quads:
        base = len(verts)
        verts.extend(q[0])
        polys.append((base, base + 1, base + 2, base + 3))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], polys)
    mesh.validate()
    mesh.update()
    for m in materials:
        mesh.materials.append(m)
    uv_world = mesh.uv_layers.new(name="world")       # -> TEXCOORD_0
    uv_lm = mesh.uv_layers.new(name="lightmap")       # -> TEXCOORD_1
    col = mesh.color_attributes.new("Color", "BYTE_COLOR", "CORNER")
    mesh.color_attributes.active_color = col
    if len(mesh.polygons) != len(quads):
        raise RuntimeError("mesh validation changed the face count of %s" % name)
    for pi, poly in enumerate(mesh.polygons):
        pts, lm, cols, axis, key = quads[pi]
        poly.use_smooth = False
        poly.material_index = mat_keys.index(key)
        for li in poly.loop_indices:
            corner = mesh.loops[li].vertex_index - 4 * pi
            if not 0 <= corner < 4:
                raise RuntimeError("unexpected loop order after validate()")
            uv_world.data[li].uv = world_uv(pts[corner], axis)
            uv_lm.data[li].uv = lm[corner]
            c = cols[corner]
            col.data[li].color = (c[0], c[1], c[2], 1.0)
    uv_lm.active_render = True
    uv_lm.active = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj, len(verts)


def build_scene(atlas_size, albedos):
    """One mesh object for the whole world, one bake material per surface key."""
    faces, hidden = collect_faces()
    density, fill = pack_lightmap(faces, atlas_size)
    quads = []
    for f in faces:
        for pts, lm, cols in subdivide(f):
            quads.append((pts, lm, cols, f["axis"], f["key"]))
    mats = [make_bake_material("bake_" + k, albedos[k]) for k in SURFACE_KEYS]
    obj, nverts = make_mesh_object("greybox_world", quads, SURFACE_KEYS, mats)
    print("[greybox] world mesh: %d faces kept, %d hidden faces removed, %d sub-quads, %d verts"
          % (len(faces), hidden, len(quads), nverts))
    print("[greybox] lightmap: %d^2, %.1f texels/m (%.1f cm/texel), %.0f%% of atlas used by islands, pad %d"
          % (atlas_size, density, 100.0 / density, fill * 100, LIGHTMAP_PAD))
    return obj, faces


# ---------------------------------------------------------------------------
# Paint decals (visual only, not baked: they borrow the lightmap of the surface below)
# ---------------------------------------------------------------------------
def glyph_runs(letter):
    """Horizontal runs of filled cells: [(row_from_top, col0, col1_exclusive)]."""
    runs = []
    for r, row in enumerate(GLYPHS[letter]):
        c = 0
        while c < len(row):
            if row[c] == "#":
                c0 = c
                while c < len(row) and row[c] == "#":
                    c += 1
                runs.append((r, c0, c))
            else:
                c += 1
    return runs


def find_face(faces, point, axis, sign):
    for f in faces:
        if f["axis"] == axis and f["sign"] == sign and face_st(f, point) is not None:
            return f
    raise RuntimeError("no visible face under decal point %s" % (point,))


def decal_quad(faces, corners, axis, sign, off, key, col):
    """A flat quad lying `off` metres in front of the face it is painted on."""
    f = None
    lm = []
    for c in corners:
        f = find_face(faces, c, axis, sign) if f is None or face_st(f, c) is None else f
        s, t = face_st(f, c)
        lm.append(lerp_face(f, s, t, "lm"))
    pts = []
    for c in corners:
        q = list(c)
        q[axis] += sign * off
        pts.append(tuple(q))
    return (pts, lm, [col] * 4, axis, key)


def build_paint(faces):
    quads = []
    zf, zl = PAINT_Z
    for name, (x0, y0), (x1, y1) in SITES:
        pc_ = PAINT[name]
        w = SITE_LINE_W

        def rect(ax0, ay0, ax1, ay1, z_off, colr):
            corners = [(ax0, ay0, 0.0), (ax1, ay0, 0.0), (ax1, ay1, 0.0), (ax0, ay1, 0.0)]
            quads.append(decal_quad(faces, corners, 2, 1, z_off, "paint", colr))
        rect(x0, y0, x1, y1, zf, pc_["fill"])
        rect(x0, y0, x1, y0 + w, zl, pc_["line"])
        rect(x0, y1 - w, x1, y1, zl, pc_["line"])
        rect(x0, y0 + w, x0 + w, y1 - w, zl, pc_["line"])
        rect(x1 - w, y0 + w, x1, y1 - w, zl, pc_["line"])
    for letter, (cx, cy), cell in FLOOR_LETTERS:
        colr = PAINT[letter]["line"]
        for r, c0, c1 in glyph_runs(letter):
            ax0, ax1 = cx + (c0 - GLYPH_W / 2) * cell, cx + (c1 - GLYPH_W / 2) * cell
            ay1 = cy + (GLYPH_H / 2 - r) * cell
            ay0 = ay1 - cell
            corners = [(ax0, ay0, 0.0), (ax1, ay0, 0.0), (ax1, ay1, 0.0), (ax0, ay1, 0.0)]
            quads.append(decal_quad(faces, corners, 2, 1, zl, "paint", colr))
    for letter, centre, (axis, sign), cell in WALL_LETTERS:
        colr = PAINT[letter]["line"]
        n = [0.0, 0.0, 0.0]
        n[axis] = float(sign)
        view = [-n[0], -n[1], -n[2]]
        right = (view[1], -view[0], 0.0)              # cross(view, +Z)
        for r, c0, c1 in glyph_runs(letter):
            u0, u1 = (c0 - GLYPH_W / 2) * cell, (c1 - GLYPH_W / 2) * cell
            v1 = (GLYPH_H / 2 - r) * cell
            v0 = v1 - cell
            corners = []
            for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1)):
                corners.append((centre[0] + right[0] * u, centre[1] + right[1] * u, centre[2] + v))
            quads.append(decal_quad(faces, corners, axis, sign, WALL_PAINT_OFF, "paint", colr))
    return quads


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

    sky_img, sun_rgb = load_hdri_split()

    world = bpy.data.worlds.new("sky")
    scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = sky_img
    env.interpolation = "Linear"
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    bg.inputs["Strength"].default_value = 1.0          # SKY_SCALE is applied to the pixels

    light = bpy.data.lights.new("sun", "SUN")
    peak = max(sun_rgb)
    light.energy = peak
    light.color = tuple(c / peak for c in sun_rgb)
    light.angle = SUN_ANGLE
    sun = bpy.data.objects.new("sun", light)
    h = math.cos(SUN_ELEVATION)
    to_sun = Vector((SUN_HORIZONTAL[0] * h, SUN_HORIZONTAL[1] * h, math.sin(SUN_ELEVATION))).normalized()
    sun.rotation_euler = to_sun.to_track_quat("Z", "Y").to_euler()   # lamp shines along its -Z
    scene.collection.objects.link(sun)
    print("[greybox] sun lamp: strength %.3f colour %s (from HDRI, x%.2f, warmth %s)"
          % (peak, [round(c / peak, 3) for c in sun_rgb], SUN_SCALE, SUN_WARMTH))

    for i, (pos, colr, power, radius) in enumerate(ACCENT_LIGHTS):
        lamp = bpy.data.lights.new("accent_%d" % i, "POINT")
        lamp.energy = power
        lamp.color = colr
        setattr_if(lamp, "shadow_soft_size", radius)
        o = bpy.data.objects.new("accent_%d" % i, lamp)
        o.location = pos
        scene.collection.objects.link(o)


def hdri_pixels():
    """The source HDRI as a float32 (h, w, 3) linear array, row 0 = bottom (nadir)."""
    import numpy as np
    img = bpy.data.images.load(HDRI_PATH)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[..., :3].copy()


def hdri_solid_angles(h, w):
    import numpy as np
    elev = ((np.arange(h) + 0.5) / h - 0.5) * math.pi
    return (np.cos(elev) * (2 * math.pi / w) * (math.pi / h)).astype(np.float32)[:, None]


def load_hdri_split():
    """Split the HDRI into a sun-less sky (float image for the world) and a sun lamp colour.
    Radiance above HDRI_SUN_CLAMP is removed; its integrated irradiance E (W/m^2, the unit
    of a Cycles sun's strength) becomes the lamp: S = E * SUN_SCALE * SUN_WARMTH."""
    import numpy as np
    if not os.path.exists(HDRI_PATH):
        raise RuntimeError("bake needs the source HDRI %s (see CREDITS.md); run with --no-bake "
                           "to reuse the shipped lightmap" % HDRI_PATH)
    px = hdri_pixels()
    h, w, _ = px.shape
    lum = px @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    y, x = np.unravel_index(int(np.argmax(lum)), lum.shape)
    elev = ((y + 0.5) / h - 0.5) * 180.0
    phi = (0.5 - (x + 0.5) / w) * 2 * math.pi        # Cycles equirect: u = 0.5 - atan2(y, x) / 2pi
    hx, hy = math.cos(phi), math.sin(phi)
    print("[greybox] HDRI sun: elevation %.1f deg, horizontal (%.3f, %.3f)" % (elev, hx, hy))
    d_el = abs(elev - math.degrees(SUN_ELEVATION))
    d_az = math.degrees(math.acos(max(-1.0, min(1.0, hx * SUN_HORIZONTAL[0] + hy * SUN_HORIZONTAL[1]))))
    if d_el > 1.0 or d_az > 1.0:
        raise RuntimeError("SUN_* constants disagree with the HDRI sun (%.1f / %.1f deg off)" % (d_el, d_az))
    scale = np.maximum(1.0, lum / HDRI_SUN_CLAMP)[..., None]
    sky = px / scale
    removed = ((px - sky) * hdri_solid_angles(h, w)[..., None]).reshape(-1, 3).sum(axis=0)
    sun_rgb = [float(removed[i]) * SUN_SCALE * SUN_WARMTH[i] for i in range(3)]
    sky = sky * SKY_SCALE * np.array(SKY_FILL_TINT, dtype=np.float32)
    img = bpy.data.images.new("hdri_sky", w, h, alpha=True, float_buffer=True)
    rgba = np.concatenate([sky, np.ones((h, w, 1), dtype=np.float32)], axis=2)
    img.pixels.foreach_set(rgba.ravel())
    img.update()
    return img, sun_rgb


def sample_points(img, faces, size):
    """Linear baked values at a few reference spots, for checking the shade ratio."""
    import numpy as np
    px = np.empty(size * size * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(size, size, 4)

    def at(point, axis, sign_dir):
        for f in faces:
            if f["axis"] != axis or f["sign"] != sign_dir:
                continue
            st = face_st(f, point)
            if st is None:
                continue
            u, v = lerp_face(f, st[0], st[1], "lm")
            x, y = int(u * size), int(v * size)
            win = px[max(0, y - 2):y + 3, max(0, x - 2):x + 3, :3]
            return [round(float(c), 3) for c in win.reshape(-1, 3).mean(axis=0)]
        return None

    spots = [
        ("floor sunlit (mid)", (0.0, -3.0, 0.0), 2, 1),
        ("floor shade (W of lane wall L)", (-5.8, 2.5, 0.0), 2, 1),
        ("floor shade (open, behind crate 05)", (-1.3, -8.6, 0.0), 2, 1),
        ("floor corner (SW, shade)", (-14.8, -21.8, 0.0), 2, 1),
        ("wall sunlit (+X face lane L)", (-4.75, 0.0, 1.5), 0, 1),
        ("wall shade (-X face lane L)", (-5.25, 0.0, 1.5), 0, -1),
        ("wall sunlit (-Y face site B entry)", (7.0, 6.0, 1.5), 1, -1),
        ("crate top", (-12.0, -10.0, 1.0), 2, 1),
        ("site A floor", (-11.0, 13.0, 0.0), 2, 1),
        ("site B floor", (11.0, 13.0, 0.0), 2, 1),
    ]
    vals = {}
    for label, p, axis, sgn in spots:
        vals[label] = at(p, axis, sgn)
        print("[greybox]   %-36s light (linear) %s" % (label, vals[label]))

    def lum(c):
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] if c else float("nan")
    print("[greybox]   shade/sunlit ratio: floor by wall %.2f, open floor %.2f, wall %.2f; atlas max %.3f"
          % (lum(vals["floor shade (W of lane wall L)"]) / lum(vals["floor sunlit (mid)"]),
             lum(vals["floor shade (open, behind crate 05)"]) / lum(vals["floor sunlit (mid)"]),
             lum(vals["wall shade (-X face lane L)"]) / lum(vals["wall sunlit (+X face lane L)"]),
             float(px[:, :, :3].max())))
    return vals


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
    print("[greybox] baking %d^2 DIFFUSE light only (direct+indirect, no colour), %d samples, %d bounces ..."
          % (size, samples, DIFFUSE_BOUNCES))
    res = bpy.ops.object.bake(
        type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"},
        margin=LIGHTMAP_PAD, margin_type="EXTEND", uv_layer="lightmap",
        use_clear=True, target="IMAGE_TEXTURES", use_selected_to_active=False)
    if "FINISHED" not in res:
        raise RuntimeError("bake failed: %s" % (res,))
    t_bake = time.time() - t0
    vals = sample_points(img, faces, size)
    # Encode: stored = light / LIGHT_SCALE (the sRGB transfer is applied when saving).
    import numpy as np
    px = np.empty(size * size * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    clipped = float((px[:, :3] > LIGHT_SCALE).any(axis=1).mean())
    px[:, :3] /= LIGHT_SCALE
    img.pixels.foreach_set(px.ravel())
    img.update()
    print("[greybox] light encoding: stored = light / %.1f; %.3f%% of texels clip" % (LIGHT_SCALE, clipped * 100))
    denoise_and_save(img, BAKED_PATH, size)
    print("[greybox] bake %.1f s, denoise+save %.1f s -> %s (%d bytes)"
          % (t_bake, time.time() - t0 - t_bake, BAKED_PATH, os.path.getsize(BAKED_PATH)))
    verify_encoding(faces, size, vals)


def srgb_to_linear(c):
    import numpy as np
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    import numpy as np
    c = np.clip(np.asarray(c, dtype=np.float64), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def verify_encoding(faces, size, raw_vals):
    """Round trip: read the written 8-bit atlas back, decode exactly like the shader
    (sRGB -> linear, x LIGHT_SCALE) and compare with the raw float bake at the spots."""
    import numpy as np
    img = bpy.data.images.load(BAKED_PATH)
    img.colorspace_settings.name = "Non-Color"        # raw stored bytes / 255
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    bpy.data.images.remove(img)
    worst = 0.0
    spots = {"floor sunlit (mid)": ((0.0, -3.0, 0.0), 2, 1),
             "wall shade (-X face lane L)": ((-5.25, 0.0, 1.5), 0, -1),
             "floor shade (W of lane wall L)": ((-5.8, 2.5, 0.0), 2, 1)}
    for label, (p, axis, sgn) in spots.items():
        f = find_face(faces, p, axis, sgn)
        u, v = lerp_face(f, *face_st(f, p), "lm")
        x, y = int(u * size), int(v * size)
        stored = px[max(0, y - 2):y + 3, max(0, x - 2):x + 3, :3].reshape(-1, 3).mean(axis=0)
        decoded = srgb_to_linear(stored) * LIGHT_SCALE
        raw = np.array(raw_vals[label])
        rel = float(np.max(np.abs(decoded - raw) / np.maximum(raw, 1e-3)))
        worst = max(worst, rel)
        print("[greybox]   round trip %-32s raw %s -> stored(sRGB) %s -> decoded %s (%.1f%%)"
              % (label, np.round(raw, 3).tolist(), np.round(stored, 3).tolist(),
                 np.round(decoded, 3).tolist(), rel * 100))
    if worst > 0.12:
        raise RuntimeError("lightmap encode/decode mismatch: %.1f%%" % (worst * 100))


def finalize_materials(obj, albedos):
    """Swap the bake materials for the named export materials (same slot order)."""
    mesh = obj.data
    for i, key in enumerate(SURFACE_KEYS):
        mesh.materials[i] = make_export_material(EXPORT_NAMES[key], albedos[key])


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
        export_normals=False,          # the world is drawn unlit; normals would be dead weight
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
    mat_names = sorted(m.get("name", "") for m in gltf.get("materials", []))
    info = {"meshes": len(gltf.get("meshes", [])), "primitives": len(prims),
            "materials": len(gltf.get("materials", [])), "images": len(gltf.get("images", [])),
            "attributes": attrs, "material_names": mat_names}
    expected = sorted(EXPORT_NAMES.values())
    if mat_names != expected or len(prims) != len(expected) or info["images"] != 0:
        raise RuntimeError("expected one primitive per material %s and no images, got %s" % (expected, info))
    for p in prims:
        for need in ("TEXCOORD_0", "TEXCOORD_1", "COLOR_0"):
            if need not in p["attributes"]:
                raise RuntimeError("GLB primitive is missing %s: %s" % (need, sorted(p["attributes"])))
    return info


def look_data():
    """Render setup for client/src/maplook.ts (not gameplay data)."""
    mats = {}
    for key in SURFACE_KEYS:
        t = TEXTURES[key]
        mats[EXPORT_NAMES[key]] = {"albedo": t["out"], "tile": t["tile"]}
    mats[EXPORT_NAMES["paint"]] = {"albedo": TEXTURES["floor"]["out"], "tile": TEXTURES["floor"]["tile"],
                                   "tint": PAINT_TINT, "decal": True}
    return {
        "lightmap": BAKED_NAME,
        "lightScale": LIGHT_SCALE,
        "materials": mats,
        "sky": {"texture": SKY_NAME, "elevMin": SKY_ELEV_MIN},
    }


# ---------------------------------------------------------------------------
# Source art processing (albedo textures, sky)
# ---------------------------------------------------------------------------
def _read_image(path, colorspace="Non-Color"):
    import numpy as np
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = colorspace
    return img


def _image_rgb(img):
    import numpy as np
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return px.reshape(h, w, 4)[..., :3].astype(np.float64)


def _save_image(rgb_srgb, path, fmt, quality):
    import numpy as np
    h, w, _ = rgb_srgb.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    img.colorspace_settings.name = "Non-Color"         # write the given bytes unchanged
    rgba = np.concatenate([np.clip(rgb_srgb, 0, 1), np.ones((h, w, 1))], axis=2).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = fmt
    img.filepath_raw = path
    img.save(filepath=path, quality=quality)
    bpy.data.images.remove(img)
    if not os.path.exists(path):
        raise RuntimeError("could not write %s" % path)


def _wrap_blur(a, sigma):
    """Gaussian blur with wrap-around (keeps tileable textures tileable), per channel."""
    import numpy as np
    h, w = a.shape[:2]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    g = np.exp(-2 * (math.pi ** 2) * (sigma ** 2) * (fx ** 2 + fy ** 2))
    return np.stack([np.real(np.fft.ifft2(np.fft.fft2(a[..., c]) * g)) for c in range(a.shape[2])], axis=2)


LUM = (0.2126, 0.7152, 0.0722)


def process_textures():
    """Source diffuse maps -> tex_*.webp. Returns {key: mean linear albedo RGB} for the bake."""
    import numpy as np
    albedos = {}
    for key, t in TEXTURES.items():
        src = os.path.join(SOURCE_DIR, "textures", t["src"])
        dst = os.path.join(OUT_DIR, t["out"])
        if os.path.exists(src):
            img = _read_image(src)
            if tuple(img.size) != (TEXTURE_SIZE, TEXTURE_SIZE):
                img.scale(TEXTURE_SIZE, TEXTURE_SIZE)
            lin = srgb_to_linear(_image_rgb(img))
            bpy.data.images.remove(img)
            lum_w = np.array(LUM)
            mean = lin.reshape(-1, 3).mean(axis=0)
            # 1) detile: flatten large blotches (they make the repeat obvious)
            low = _wrap_blur(lin, TEXTURE_SIZE / 10.0)
            lin = np.maximum(lin - t["detile"] * (low - mean), 1e-4)
            # 2) contrast in log-luminance around the mean
            lum = lin @ lum_w
            gm = math.exp(float(np.log(lum).mean()))
            new_lum = gm * (lum / gm) ** t["contrast"]
            lin = lin * (new_lum / lum)[..., None]
            # 3) saturation
            lum = (lin @ lum_w)[..., None]
            lin = lum + (lin - lum) * t["sat"]
            # 4) target mean albedo and tint
            lin = lin * (t["albedo"] / float((lin @ lum_w).mean())) * np.array(t["tint"])
            lin = np.clip(lin, 0.0, 1.0)
            _save_image(linear_to_srgb(lin), dst, "WEBP", TEXTURE_WEBP_QUALITY)
            print("[greybox] texture %-10s %s -> %s (%d bytes)" % (key, t["src"], t["out"], os.path.getsize(dst)))
        elif os.path.exists(dst):
            print("[greybox] texture %-10s source missing, reusing shipped %s" % (key, t["out"]))
        else:
            raise RuntimeError("texture %s: neither source %s nor shipped %s exists" % (key, src, dst))
        # Mean albedo of what actually ships (what the bake should bounce)
        img = _read_image(dst)
        albedos[key] = tuple(float(c) for c in srgb_to_linear(_image_rgb(img)).reshape(-1, 3).mean(axis=0))
        bpy.data.images.remove(img)
        print("[greybox]   mean linear albedo %s" % [round(c, 3) for c in albedos[key]])
    return albedos


def sky_tonemap(x):
    """Linear HDR sky -> display linear: identity up to 0.75, smooth shoulder to 1."""
    import numpy as np
    k = 0.75
    return np.where(x <= k, x, k + (1 - k) * (1 - np.exp(-(x - k) / (1 - k))))


def process_sky():
    """HDRI -> sky.jpg: equirect strip, full 360 deg wide, elevation SKY_ELEV_MIN..90 deg,
    top row = zenith. Exposure 1: radiance in the same units as the baked light."""
    import numpy as np
    if not os.path.exists(HDRI_PATH):
        if os.path.exists(SKY_PATH):
            print("[greybox] sky: source HDRI missing, reusing shipped %s" % SKY_NAME)
            return
        raise RuntimeError("sky: neither %s nor %s exists" % (HDRI_PATH, SKY_PATH))
    px = hdri_pixels().astype(np.float64)              # row 0 = nadir
    h, w, _ = px.shape
    # rows of the strip (j = 0 bottom) -> source rows, linear interpolation
    elev = SKY_ELEV_MIN + (np.arange(SKY_H) + 0.5) / SKY_H * (90.0 - SKY_ELEV_MIN)
    sy = (elev + 90.0) / 180.0 * h - 0.5
    y0 = np.clip(np.floor(sy).astype(int), 0, h - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fy = (sy - np.floor(sy))[:, None, None]
    strip = px[y0] * (1 - fy) + px[y1] * fy
    if w != SKY_W:          # horizontal box resample
        xs = (np.arange(SKY_W) + 0.5) / SKY_W * w - 0.5
        x0 = np.clip(np.floor(xs).astype(int), 0, w - 1)
        x1 = (x0 + 1) % w
        fx = (xs - np.floor(xs))[None, :, None]
        strip = strip[:, x0] * (1 - fx) + strip[:, x1] * fx
    # per channel: highlights (sun, cloud cores) roll off to white instead of hue-shifting
    strip = sky_tonemap(strip * SKY_DISPLAY_EXPOSURE)
    strip = np.clip(strip, 0, 1)
    _save_image(linear_to_srgb(strip), SKY_PATH, "JPEG", SKY_JPEG_QUALITY)
    print("[greybox] sky: %dx%d, elevation %.0f..90 deg -> %s (%d bytes)"
          % (SKY_W, SKY_H, SKY_ELEV_MIN, SKY_PATH, os.path.getsize(SKY_PATH)))


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
        data["look"] = look_data()
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
    albedos = process_textures()
    process_sky()
    obj, faces = build_scene(size, albedos)
    n_bake_mats = len(SURFACE_KEYS)
    if opts["bake"]:
        bake_lighting(obj, faces, size, opts["samples"])
    finalize_materials(obj, albedos)
    paint = build_paint(faces)
    make_mesh_object("greybox_paint", paint, ["paint"],
                     [make_export_material(EXPORT_NAMES["paint"], (0.6, 0.2, 0.2))])
    print("[greybox] paint decals: %d quads" % len(paint))
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
