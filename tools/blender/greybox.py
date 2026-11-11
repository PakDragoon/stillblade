"""
Stillblade greybox test map generator.

Run headless:
  blender --background --python tools/blender/greybox.py

Outputs (relative to this file):
  ../../client/public/maps/greybox.glb   visual mesh, one object per material
  ../../client/public/maps/greybox.json  collision boxes + gameplay data (engine coords)

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

# Materials: category -> (material name, RGB). At most 6.
MATERIALS = {
    "floor": ("mat_floor", (0.18, 0.18, 0.19)),
    "wall": ("mat_wall", (0.50, 0.50, 0.52)),
    "crate": ("mat_crate", (0.72, 0.48, 0.22)),
    "platform": ("mat_platform", (0.38, 0.45, 0.55)),
    "site_A": ("mat_site_a", (0.80, 0.18, 0.15)),
    "site_B": ("mat_site_b", (0.15, 0.35, 0.85)),
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
# Blender scene
# ---------------------------------------------------------------------------
def make_material(name, rgb):
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:   # Blender 5.x creates node trees by default
        mat.use_nodes = True
    bsdf = None
    for node in mat.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            bsdf = node
            break
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    return mat


BOX_FACES = [
    (0, 3, 2, 1),  # bottom (-Z)
    (4, 5, 6, 7),  # top (+Z)
    (0, 1, 5, 4),  # -Y
    (2, 3, 7, 6),  # +Y
    (1, 2, 6, 5),  # +X
    (3, 0, 4, 7),  # -X
]


def box_verts(mn, mx):
    x0, y0, z0 = mn
    x1, y1, z1 = mx
    return [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]


def build_object(obj_name, boxes, mat):
    """One mesh object holding many boxes, built directly in world space
    (equivalent to joining per-box objects with transforms applied)."""
    verts, faces = [], []
    for mn, mx in boxes:
        base = len(verts)
        verts.extend(box_verts(mn, mx))
        faces.extend(tuple(base + i for i in f) for f in BOX_FACES)
    mesh = bpy.data.meshes.new(obj_name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    for poly in mesh.polygons:
        poly.use_smooth = False
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(obj_name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for item in list(coll):
            coll.remove(item)

    mats = {key: make_material(name, rgb) for key, (name, rgb) in MATERIALS.items()}

    groups = {}
    for _name, cat, mn, mx in BOXES:
        groups.setdefault(CATEGORY_TO_MAT[cat], []).append((mn, mx))
    for name, (x0, y0), (x1, y1) in SITES:
        groups.setdefault("site_" + name, []).append(((x0, y0, 0.0), (x1, y1, DECAL_T)))

    objs = []
    for key, boxes in groups.items():
        objs.append(build_object("greybox_" + key, boxes, mats[key]))
    return objs, len(mats)


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
        export_normals=True,
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


def write_json():
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
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(JSON_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    return data


def centre(points):
    n = len(points)
    return [r3(sum(p[i] for p in points) / n) for i in range(3)]


def main():
    verify()
    objs, n_mats = build_scene()
    export_glb()
    data = write_json()

    glb_size = os.path.getsize(GLB_PATH)
    json_size = os.path.getsize(JSON_PATH)
    print("[greybox] --- summary ---")
    print("[greybox] boxes (collision): %d  (crates %d)"
          % (len(BOXES), sum(1 for b in BOXES if b[1] == "crate")))
    print("[greybox] mesh objects: %d  materials: %d" % (len(objs), n_mats))
    print("[greybox] engine bounds: min %s max %s" % (data["bounds"]["min"], data["bounds"]["max"]))
    print("[greybox] ghost spawn centre:    %s" % centre([s["pos"] for s in data["spawns"]["ghosts"]]))
    print("[greybox] defender spawn centre: %s" % centre([s["pos"] for s in data["spawns"]["defenders"]]))
    for s in data["bombSites"]:
        print("[greybox] site %s centre: %s" % (s["name"], centre([s["min"], s["max"]])))
    print("[greybox] %s : %d bytes" % (GLB_PATH, glb_size))
    print("[greybox] %s : %d bytes" % (JSON_PATH, json_size))
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
