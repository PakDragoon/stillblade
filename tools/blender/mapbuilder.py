"""
Stillblade map builder: turns a MapDef (tools/blender/maps/<id>.py) into the shipped files.
Runs inside Blender; started by tools/blender/build_map.py (see `npm run map -- <id>`).

Outputs (client/public/maps/):
  <id>.glb          visual meshes: world (one primitive per surface material) + paint decals
  <id>.json         collision boxes + gameplay data (engine coords) + "look" (render setup)
  <id>_baked.webp   baked LIGHT atlas (lighting only, no surface colour; encoding below)
  tex_*.webp        tiling albedo textures, shared by all maps (mapkit.TEXTURE_LIBRARY)
  sky.jpg           tonemapped LDR sky (upper hemisphere equirect strip), shared
  index.json        list of every map in the folder (id + display name), for the client menu

Source art (CC0, see client/public/maps/CREDITS.md) lives in tools/blender/source-art/, which is
NOT committed. When it is missing, texture and sky processing are skipped and the shipped files are
reused; the bake needs the HDRI.

Baked lighting:
  The world is lit once in Cycles by the Poly Haven HDRI sky (sun disc removed and replaced by an
  explicit sun lamp at the HDRI's sun direction, so shadows are crisp) plus the map's own lamps,
  with realistic surface albedos for correct coloured bounce. The bake stores DIFFUSE
  DIRECT+INDIRECT WITHOUT the colour pass, i.e. pure incoming light. The game multiplies it with
  the tiling albedo textures (client/src/maplook.ts):
      colour = albedo(TEXCOORD_0 / tile) * COLOR_0 * light(TEXCOORD_1)
  Light encoding (8-bit sRGB atlas): stored = srgb_encode(light / LIGHT_SCALE), decoded on the GPU
  as light = srgb_decode(texel) * LIGHT_SCALE (look.lightScale). Light above LIGHT_SCALE clips.
  The bake runs on the GPU when there is one (OptiX, then CUDA), else on the CPU.
  GLB vertex layout:
    TEXCOORD_0  world-space planar UVs, 1 unit = 1 m (tiling albedo textures)
    TEXCOORD_1  lightmap UVs into <id>_baked.webp (non-overlapping, texel aligned)
    COLOR_0     linear albedo multiplier: skirting band / grime gradient / large-scale variation /
                per-box tint, and paint colour (decals)
  Faces that can never be seen (resting on or buried in another box, facing out of the map,
  faces a definition marks hidden) are dropped before UV packing. After packing, wall and floor
  faces are cut into sub-quads purely to carry vertex colour. Paint decals are flat quads a few mm
  off their surface; they are NOT in the bake and reuse the lightmap island of the surface under
  them, so they get exactly its lighting.
"""

import json
import math
import os
import time

import bpy

import mapkit

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "client", "public", "maps"))
SOURCE_DIR = os.path.join(HERE, "source-art")
SKY_NAME = "sky.jpg"
SKY_PATH = os.path.join(OUT_DIR, SKY_NAME)
HDRI_PATH = os.path.join(SOURCE_DIR, "hdri", "kloofendal_48d_partly_cloudy_puresky_2k.hdr")

TEXTURE_SIZE = 1024
TEXTURE_WEBP_QUALITY = 82
PAINT_TINT = 2.0             # paint decals: floor texture x COLOR_0 x 2 (COLOR_0 is <= 1)

# Vertex-colour shaping (multipliers on the albedo; 1 = texture as is). Heights are above the
# floor level the wall stands on.
SKIRT_H = 0.3                # dark painted base band on every wall
SKIRT_MUL = 0.55
GRIME_TOP = 1.4              # grime gradient from the skirting up to this height
GRIME_MUL = 0.84
CAP_H = 0.15                 # darker coping band at the top of the walls
CAP_MUL = 0.8
WALL_TOP_MUL = 0.8           # top faces of walls
SUBDIV = 3.0                 # metres between vertex-colour sub-quad cuts on walls/floor
NOISE_SCALE = 4.0            # metres per value-noise lattice cell

# Sky and sun. The sky is the Poly Haven HDRI "Kloofendal 48d Partly Cloudy (Pure Sky)", used
# unrotated. Its sun sits at 47.9 deg elevation; horizontally, toward the sun is (0.827, -0.562)
# in Blender (x, y). The realtime sun in client/src/main.ts (players + viewmodel) uses the same
# direction; the script checks the HDRI agrees with these constants.
SUN_HORIZONTAL = (0.827, -0.562)
SUN_ELEVATION = math.radians(47.9)
HDRI_SUN_CLAMP = 3.0                # sky radiance above this (the sun disc + halo) moves into the lamp
SUN_WARMTH = (1.0, 0.93, 0.80)
SKY_FILL_TINT = (1.1, 1.0, 0.82)    # tames the HDRI's strong blue so shade is cool, not navy
SKY_DISPLAY_EXPOSURE = 1.25
SUN_ANGLE = math.radians(1.2)
DIFFUSE_BOUNCES = 4
LIGHT_SCALE = 2.0
SKY_W, SKY_H = 2048, 512
SKY_ELEV_MIN = -6.0
SKY_JPEG_QUALITY = 88
LIGHTMAP_PAD = 4
WEBP_QUALITY = 92
DITHER = 0.6

EPS = 1e-6


def log(msg):
    print("[map] " + msg, flush=True)


def setattr_if(obj, name, value):
    if hasattr(obj, name):
        try:
            setattr(obj, name, value)
            return True
        except (TypeError, ValueError, AttributeError) as exc:
            log("could not set %s.%s: %s" % (type(obj).__name__, name, exc))
    return False


class Build:
    """Per-map build state: paths, the face list, surface keys."""

    def __init__(self, m):
        self.m = m
        self.glb_path = os.path.join(OUT_DIR, m.id + ".glb")
        self.json_path = os.path.join(OUT_DIR, m.id + ".json")
        self.baked_name = m.id + "_baked.webp"
        self.baked_path = os.path.join(OUT_DIR, self.baked_name)
        self.export_names = {k: "map_" + k for k in m.surfaces + ["paint"]}
        # Every solid drawn: collision boxes, then visual-only boxes.
        self.items = []
        for b in m.boxes:
            self.items.append(dict(name=b["name"], key=m.category_surface[b["category"]], mn=b["mn"], mx=b["mx"],
                                   tint=b["tint"], hide=b["hide"]))
        for v in m.visuals:
            self.items.append(dict(name=v["name"], key=v["surface"], mn=v["mn"], mx=v["mx"],
                                   tint=v["tint"], hide=()))
        # Invisible collision volumes (hide "all") are neither drawn nor occluders.
        self.items = [it for it in self.items if "all" not in it["hide"]]
        floor_boxes = [b for b in m.boxes if b["category"] in m.floor_categories]
        # Floor levels each item stands on (for skirting bands): floors whose top lies inside the
        # item's height range and whose footprint is within 0.7 m of it.
        for it in self.items:
            lv = set()
            for f in floor_boxes:
                top = f["mx"][2]
                if it["mn"][2] - 0.05 <= top < it["mx"][2] and mapkit.rect_dist(it["mn"], it["mx"], f["mn"], f["mx"]) < 0.7:
                    lv.add(round(top, 4))
            it["levels"] = sorted(lv) or [it["mn"][2]]


# ---------------------------------------------------------------------------
# Faces, hidden-face removal, lightmap packing
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
FACE_NAMES = ["bottom", "top", "-y", "+y", "+x", "-x"]


def box_verts(mn, mx):
    x0, y0, z0 = mn
    x1, y1, z1 = mx
    return [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]


def face_hidden(idx, mn, mx, axis, sign, solids, grid, map_mn, map_mx):
    """True if this box face can never be seen by a player.

    - It faces out of the map (outside of the outer walls, floor edges/underside).
    - Another solid covers the whole face and lies on its outward side, i.e. the face rests on,
      is pressed against or is buried inside that solid.
    Partially covered faces are kept, so nothing visible is ever removed."""
    c = mx[axis] if sign > 0 else mn[axis]
    if axis < 2:
        edge = map_mx[axis] if sign > 0 else map_mn[axis]
        if abs(c - edge) < EPS:
            return True
    elif sign < 0 and abs(c - map_mn[2]) < EPS:
        return True
    tangents = [i for i in range(3) if i != axis]
    for j in grid.query(mn[0] - 0.01, mn[1] - 0.01, mx[0] + 0.01, mx[1] + 0.01):
        if j == idx:
            continue
        bmn, bmx = solids[j]
        if any(bmn[i] > mn[i] + EPS or bmx[i] < mx[i] - EPS for i in tangents):
            continue
        if sign > 0 and bmn[axis] <= c + EPS and bmx[axis] > c + 1e-4:
            return True
        if sign < 0 and bmx[axis] >= c - EPS and bmn[axis] < c - 1e-4:
            return True
    return False


def collect_faces(b):
    """All visible box faces: list of dicts {pts, axis, sign, key, item, top}."""
    solids = [(it["mn"], it["mx"]) for it in b.items]
    grid = mapkit.Grid2D(solids, 2.0)
    map_mn = [min(s[0][i] for s in solids) for i in range(3)]
    map_mx = [max(s[1][i] for s in solids) for i in range(3)]
    faces, hidden = [], 0
    for idx, it in enumerate(b.items):
        mn, mx = it["mn"], it["mx"]
        v = box_verts(mn, mx)
        for f, (axis, sign), fname in zip(BOX_FACES, FACE_AXIS, FACE_NAMES):
            if fname in it["hide"] or face_hidden(idx, mn, mx, axis, sign, solids, grid, map_mn, map_mx):
                hidden += 1
                continue
            faces.append({"pts": [v[i] for i in f], "axis": axis, "sign": sign, "key": it["key"],
                          "item": idx, "top": mx[2]})
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
    """Assign every face a texel-aligned island in one size x size atlas, at the highest uniform
    texel density that fits. Writes face['lm'] = 4 UV corners."""
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


def item_tint(b, f):
    """Per-box albedo multiplier (RGB): an explicit tint, else crates vary, walls barely."""
    it = b.items[f["item"]]
    if it["tint"] is not None:
        return tuple(it["tint"])
    name = it["name"]
    if f["key"] in b.m.varied_surfaces:
        v = 0.95 + 0.13 * mapkit.name_rand(name)
        h = 0.06 * mapkit.name_rand(name, 1)
        return (v * (1 + h), v, v * (1 - h))
    if f["key"] in b.m.wall_surfaces:
        v = 1.0 + 0.035 * mapkit.name_rand(name)
        return (v, v, v)
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


def subdivide(b, f):
    """Cut a face into sub-quads that carry vertex colour. Returns [(pts, lm, cols)]."""
    p = f["pts"]
    e1 = [p[1][i] - p[0][i] for i in range(3)]
    e3 = [p[3][i] - p[0][i] for i in range(3)]
    key, axis = f["key"], f["axis"]
    it = b.items[f["item"]]
    is_wall = key in b.m.wall_surfaces
    levels = it["levels"]
    s_cuts, t_cuts = [], []
    if axis == 2:
        if key in b.m.floor_surfaces:
            s_cuts = grid_cuts(p[0], e1, 0 if abs(e1[0]) > EPS else 1, SUBDIV)
            t_cuts = grid_cuts(p[0], e3, 0 if abs(e3[0]) > EPS else 1, SUBDIV)
    elif is_wall:
        vert_edge = 3 if abs(e3[2]) > EPS else 1
        horiz = e1 if vert_edge == 3 else e3
        hcuts = grid_cuts(p[0], horiz, 0 if abs(horiz[0]) > EPS else 1, SUBDIV)
        ev = e3 if vert_edge == 3 else e1
        z0 = p[0][2]
        vcuts = []
        heights = [f["top"] - CAP_H]
        for lv in levels:
            heights += [lv + SKIRT_H, lv + GRIME_TOP]
        for z in heights:
            s = (z - z0) / ev[2]
            if 1e-4 < s < 1 - 1e-4:
                vcuts.append(s)
        vcuts = sorted(set(round(v, 6) for v in vcuts))
        if vert_edge == 3:
            s_cuts, t_cuts = hcuts, vcuts
        else:
            s_cuts, t_cuts = vcuts, hcuts
    S = [0.0] + sorted(s_cuts) + [1.0]
    T = [0.0] + sorted(t_cuts) + [1.0]
    tint = item_tint(b, f)
    amp = b.m.noise_amp.get(key, 0.0)

    def level_below(z):
        best = levels[0]
        for lv in levels:
            if lv <= z + 1e-4:
                best = lv
        return best

    def colour(pt, band, lv):
        m = 1.0 + amp * value_noise(pt) if amp else 1.0
        if is_wall:
            if axis == 2:
                m *= WALL_TOP_MUL
            elif band == "skirt":
                m *= SKIRT_MUL
            elif band == "cap":
                m *= CAP_MUL
            else:
                g = min(1.0, max(0.0, (pt[2] - lv - SKIRT_H) / (GRIME_TOP - SKIRT_H)))
                m *= GRIME_MUL + (1.0 - GRIME_MUL) * g
        return tuple(min(1.0, c * m) for c in tint)

    out = []
    for j in range(len(T) - 1):
        for i in range(len(S) - 1):
            corners = [(S[i], T[j]), (S[i + 1], T[j]), (S[i + 1], T[j + 1]), (S[i], T[j + 1])]
            pts = [lerp_face(f, s, t, "pts") for s, t in corners]
            lm = [lerp_face(f, s, t, "lm") for s, t in corners]
            band, lv = None, 0.0
            if is_wall and axis != 2:
                mz = sum(q[2] for q in pts) / 4
                lv = level_below(mz)
                band = "skirt" if mz - lv < SKIRT_H else ("cap" if mz > f["top"] - CAP_H else "body")
            out.append((pts, lm, [colour(q, band, lv) for q in pts]))
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
    """A material written to the GLB. Only its NAME matters to the game: maplook.ts swaps it for
    the unlit albedo x lightmap shader (the base colour is a plain fallback)."""
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


def make_mesh_object(name, quads, mat_keys, materials):
    """quads: [(pts, lm, cols, axis, key)] -> mesh object with UV0 world, UV1 lightmap, COLOR_0.
    Polygons may have any number (>= 3) of corners."""
    verts, polys = [], []
    for q in quads:
        base = len(verts)
        verts.extend(q[0])
        polys.append(tuple(range(base, base + len(q[0]))))
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
    starts = []
    acc = 0
    for q in quads:
        starts.append(acc)
        acc += len(q[0])
    for pi, poly in enumerate(mesh.polygons):
        pts, lm, cols, axis, key = quads[pi]
        poly.use_smooth = False
        poly.material_index = mat_keys.index(key)
        for li in poly.loop_indices:
            corner = mesh.loops[li].vertex_index - starts[pi]
            if not 0 <= corner < len(pts):
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


def build_scene(b, atlas_size, albedos):
    """One mesh object for the whole world, one bake material per surface key."""
    faces, hidden = collect_faces(b)
    density, fill = pack_lightmap(faces, atlas_size)
    quads = []
    for f in faces:
        for pts, lm, cols in subdivide(b, f):
            quads.append((pts, lm, cols, f["axis"], f["key"]))
    used = [k for k in b.m.surfaces if any(f["key"] == k for f in faces)]
    mats = [make_bake_material("bake_" + k, albedos[k]) for k in used]
    obj, nverts = make_mesh_object(b.m.id + "_world", quads, used, mats)
    log("world mesh: %d faces kept, %d hidden faces removed, %d sub-quads, %d verts"
        % (len(faces), hidden, len(quads), nverts))
    log("lightmap: %d^2, %.1f texels/m (%.1f cm/texel), %.0f%% of atlas used by islands, pad %d"
        % (atlas_size, density, 100.0 / density, fill * 100, LIGHTMAP_PAD))
    b.used_surfaces = used
    b.density = density
    return obj, faces


# ---------------------------------------------------------------------------
# Paint decals (visual only, not baked: they borrow the lightmap of the surface below)
# ---------------------------------------------------------------------------
def faces_on_plane(faces, axis, sign, c):
    return [f for f in faces if f["axis"] == axis and f["sign"] == sign and abs(f["pts"][0][axis] - c) < 1e-4]


def decal_polys(faces, d):
    """One decal -> [(pts, lm, cols, axis, 'paint')]. A decal must lie on one face, except an
    axis-aligned rectangle, which is split along the faces it crosses."""
    axis, sign, off, col = d["axis"], d["sign"], d["off"], d["colour"]
    corners = d["corners"]
    plane = faces_on_plane(faces, axis, sign, corners[0][axis])

    def lift(c):
        q = list(c)
        q[axis] += sign * off
        return tuple(q)

    for f in plane:
        st = [face_st(f, c) for c in corners]
        if all(s is not None for s in st):
            return [([lift(c) for c in corners], [lerp_face(f, s, t, "lm") for s, t in st], [col] * len(corners),
                     axis, "paint")]
    tang = [i for i in range(3) if i != axis]
    lo = [min(c[i] for c in corners) for i in range(3)]
    hi = [max(c[i] for c in corners) for i in range(3)]
    rect = all(any(abs(c[i] - lo[i]) < 1e-6 or abs(c[i] - hi[i]) < 1e-6 for i in tang) for c in corners)
    if not rect:
        raise RuntimeError("decal %s does not fit on one face" % (corners,))
    out = []
    covered = 0.0
    for f in plane:
        fl = [min(p[i] for p in f["pts"]) for i in range(3)]
        fh = [max(p[i] for p in f["pts"]) for i in range(3)]
        a = [max(lo[i], fl[i]) for i in range(3)]
        bb = [min(hi[i], fh[i]) for i in range(3)]
        if any(bb[i] - a[i] < 1e-4 for i in tang):
            continue
        u, v = tang
        pts = []
        for cu, cv in ((a[u], a[v]), (bb[u], a[v]), (bb[u], bb[v]), (a[u], bb[v])):
            q = [0.0, 0.0, 0.0]
            q[axis] = corners[0][axis]
            q[u], q[v] = cu, cv
            pts.append(tuple(q))
        if axis == 1:                 # keep the winding facing outward like the source corners
            pts = pts[::-1] if sign > 0 else pts
        elif axis == 0:
            pts = pts if sign > 0 else pts[::-1]
        else:
            pts = pts if sign > 0 else pts[::-1]
        st = [face_st(f, c) for c in pts]
        out.append(([lift(c) for c in pts], [lerp_face(f, s, t, "lm") for s, t in st], [col] * 4, axis, "paint"))
        covered += (bb[u] - a[u]) * (bb[v] - a[v])
    area = (hi[tang[0]] - lo[tang[0]]) * (hi[tang[1]] - lo[tang[1]])
    if covered < area * 0.5:
        raise RuntimeError("decal %s mostly off any visible face (%.0f%% covered)" % (corners, covered / area * 100))
    return out


def build_paint(b, faces):
    quads = []
    for d in b.m.decals:
        quads.extend(decal_polys(faces, d))
    return quads


# ---------------------------------------------------------------------------
# Bake
# ---------------------------------------------------------------------------
def setup_device():
    """GPU if there is one: OptiX, then CUDA; otherwise the CPU. Returns a description."""
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
            for refresh in ("refresh_devices", "get_devices"):
                fn = getattr(prefs, refresh, None)
                if fn:
                    try:
                        fn()
                        break
                    except Exception:  # noqa: BLE001 - device probing must never stop the build
                        pass
            devs = [d for d in prefs.devices if d.type == kind]
            if not devs:
                continue
            for d in prefs.devices:
                d.use = d.type == kind
            scene.cycles.device = "GPU"
            return "GPU %s (%s)" % (kind, ", ".join(d.name for d in devs))
    scene.cycles.device = "CPU"
    return "CPU"


def setup_lighting(b, samples):
    from mathutils import Vector
    m = b.m
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    cy = scene.cycles
    device = setup_device()
    log("bake device: %s" % device)
    b.device = device
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

    sky_img, sun_rgb = load_hdri_split(m)

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
    bg.inputs["Strength"].default_value = 1.0          # sky_scale is applied to the pixels

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
    log("sun lamp: strength %.3f colour %s (from HDRI, x%.2f, warmth %s)"
        % (peak, [round(c / peak, 3) for c in sun_rgb], m.sun_scale, SUN_WARMTH))

    for i, L in enumerate(m.lights):
        lamp = bpy.data.lights.new("lamp_%d" % i, L["type"])
        lamp.energy = L["power"]
        lamp.color = L["colour"]
        o = bpy.data.objects.new("lamp_%d" % i, lamp)
        o.location = L["pos"]
        if L["type"] == "POINT":
            setattr_if(lamp, "shadow_soft_size", L["radius"])
        elif L["type"] == "AREA":
            lamp.shape = "RECTANGLE"
            lamp.size, lamp.size_y = L["size"]
            o.rotation_euler = Vector(L["direction"]).normalized().to_track_quat("-Z", "Y").to_euler()
        elif L["type"] == "SPOT":
            lamp.spot_size = math.radians(L["angle"])
            lamp.spot_blend = L["blend"]
            setattr_if(lamp, "shadow_soft_size", L["radius"])
            o.rotation_euler = Vector(L["direction"]).normalized().to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(o)
    log("lamps: %d" % len(m.lights))


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


def load_hdri_split(m):
    """Split the HDRI into a sun-less sky (float image for the world) and a sun lamp colour.
    Radiance above HDRI_SUN_CLAMP is removed; its integrated irradiance E (W/m^2, the unit of a
    Cycles sun's strength) becomes the lamp: S = E * sun_scale * SUN_WARMTH."""
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
    log("HDRI sun: elevation %.1f deg, horizontal (%.3f, %.3f)" % (elev, hx, hy))
    d_el = abs(elev - math.degrees(SUN_ELEVATION))
    d_az = math.degrees(math.acos(max(-1.0, min(1.0, hx * SUN_HORIZONTAL[0] + hy * SUN_HORIZONTAL[1]))))
    if d_el > 1.0 or d_az > 1.0:
        raise RuntimeError("SUN_* constants disagree with the HDRI sun (%.1f / %.1f deg off)" % (d_el, d_az))
    scale = np.maximum(1.0, lum / HDRI_SUN_CLAMP)[..., None]
    sky = px / scale
    removed = ((px - sky) * hdri_solid_angles(h, w)[..., None]).reshape(-1, 3).sum(axis=0)
    sun_rgb = [float(removed[i]) * m.sun_scale * SUN_WARMTH[i] for i in range(3)]
    sky = sky * m.sky_scale * np.array(SKY_FILL_TINT, dtype=np.float32)
    img = bpy.data.images.new("hdri_sky", w, h, alpha=True, float_buffer=True)
    rgba = np.concatenate([sky, np.ones((h, w, 1), dtype=np.float32)], axis=2)
    img.pixels.foreach_set(rgba.ravel())
    img.update()
    return img, sun_rgb


def find_face(faces, point, axis, sign):
    for f in faces:
        if f["axis"] == axis and f["sign"] == sign and face_st(f, point) is not None:
            return f
    return None


def sample_points(b, img, faces, size):
    """Linear baked values at the map's reference spots."""
    import numpy as np
    px = np.empty(size * size * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(size, size, 4)
    vals = {}
    for label, p, axis, sgn in b.m.sample_spots:
        f = find_face(faces, p, axis, sgn)
        if f is None:
            log("  sample spot %s: no visible face at %s" % (label, p))
            continue
        u, v = lerp_face(f, *face_st(f, p), "lm")
        x, y = int(u * size), int(v * size)
        win = px[max(0, y - 2):y + 3, max(0, x - 2):x + 3, :3]
        vals[label] = [round(float(c), 3) for c in win.reshape(-1, 3).mean(axis=0)]
        log("  %-40s light (linear) %s" % (label, vals[label]))
    log("  atlas max %.3f" % float(px[:, :, :3].max()))
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
                log("denoise %s: %s" % (name, exc))
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


def bake_lighting(b, obj, faces, size, samples):
    t0 = time.time()
    setup_lighting(b, samples)
    img = bpy.data.images.new(b.m.id + "_baked", size, size, alpha=False, float_buffer=True)
    for slot in obj.material_slots:
        nt = slot.material.node_tree
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.nodes.active = tex                 # bake target (not connected)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    log("baking %d^2 DIFFUSE light only (direct+indirect, no colour), %d samples, %d bounces ..."
        % (size, samples, DIFFUSE_BOUNCES))
    res = bpy.ops.object.bake(
        type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"},
        margin=LIGHTMAP_PAD, margin_type="EXTEND", uv_layer="lightmap",
        use_clear=True, target="IMAGE_TEXTURES", use_selected_to_active=False)
    if "FINISHED" not in res:
        raise RuntimeError("bake failed: %s" % (res,))
    t_bake = time.time() - t0
    vals = sample_points(b, img, faces, size)
    import numpy as np
    px = np.empty(size * size * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    clipped = float((px[:, :3] > LIGHT_SCALE).any(axis=1).mean())
    px[:, :3] /= LIGHT_SCALE
    img.pixels.foreach_set(px.ravel())
    img.update()
    log("light encoding: stored = light / %.1f; %.3f%% of texels clip" % (LIGHT_SCALE, clipped * 100))
    t1 = time.time()
    denoise_and_save(img, b.baked_path, size)
    b.bake_seconds = t_bake
    log("bake %.1f s on %s, denoise+save %.1f s -> %s (%d bytes)"
        % (t_bake, b.device, time.time() - t1, b.baked_path, os.path.getsize(b.baked_path)))
    verify_encoding(b, faces, size, vals)


def srgb_to_linear(c):
    import numpy as np
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    import numpy as np
    c = np.clip(np.asarray(c, dtype=np.float64), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def verify_encoding(b, faces, size, raw_vals):
    """Round trip: read the written 8-bit atlas back, decode exactly like the shader (sRGB ->
    linear, x LIGHT_SCALE) and compare with the raw float bake at the first sample spots."""
    import numpy as np
    img = bpy.data.images.load(b.baked_path)
    img.colorspace_settings.name = "Non-Color"        # raw stored bytes / 255
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    bpy.data.images.remove(img)
    worst = 0.0
    for label, p, axis, sgn in b.m.sample_spots[:3]:
        if label not in raw_vals:
            continue
        f = find_face(faces, p, axis, sgn)
        u, v = lerp_face(f, *face_st(f, p), "lm")
        x, y = int(u * size), int(v * size)
        stored = px[max(0, y - 2):y + 3, max(0, x - 2):x + 3, :3].reshape(-1, 3).mean(axis=0)
        decoded = srgb_to_linear(stored) * LIGHT_SCALE
        raw = np.array(raw_vals[label])
        rel = float(np.max(np.abs(decoded - raw) / np.maximum(raw, 0.05)))
        worst = max(worst, rel)
        log("  round trip %-32s raw %s -> stored(sRGB) %s -> decoded %s (%.1f%%)"
            % (label, np.round(raw, 3).tolist(), np.round(stored, 3).tolist(),
               np.round(decoded, 3).tolist(), rel * 100))
    if worst > 0.12:
        raise RuntimeError("lightmap encode/decode mismatch: %.1f%%" % (worst * 100))


def finalize_materials(b, obj, albedos):
    """Swap the bake materials for the named export materials (same slot order)."""
    mesh = obj.data
    for i, key in enumerate(b.used_surfaces):
        mesh.materials[i] = make_export_material(b.export_names[key], albedos[key])


def export_glb(b):
    os.makedirs(OUT_DIR, exist_ok=True)
    kwargs = dict(
        filepath=b.glb_path,
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
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    dropped = [k for k in kwargs if k not in props]
    for k in dropped:
        kwargs.pop(k)
    if dropped:
        log("exporter ignored unknown options: %s" % dropped)
    result = bpy.ops.export_scene.gltf(**kwargs)
    if "FINISHED" not in result:
        raise RuntimeError("glTF export failed: %s" % (result,))


def inspect_glb(b, expected_keys):
    """Read back the GLB's JSON chunk: meshes, primitives, materials, attributes."""
    import struct
    with open(b.glb_path, "rb") as f:
        data = f.read()
    length, _ctype = struct.unpack_from("<II", data, 12)
    gltf = json.loads(data[20:20 + length].decode("utf-8"))
    prims = [p for m in gltf.get("meshes", []) for p in m["primitives"]]
    attrs = sorted(prims[0]["attributes"].keys()) if prims else []
    mat_names = sorted(m.get("name", "") for m in gltf.get("materials", []))
    info = {"meshes": len(gltf.get("meshes", [])), "primitives": len(prims),
            "materials": len(gltf.get("materials", [])), "images": len(gltf.get("images", [])),
            "attributes": attrs, "material_names": mat_names}
    expected = sorted(b.export_names[k] for k in expected_keys)
    if mat_names != expected or len(prims) != len(expected) or info["images"] != 0:
        raise RuntimeError("expected one primitive per material %s and no images, got %s" % (expected, info))
    for p in prims:
        for need in ("TEXCOORD_0", "TEXCOORD_1", "COLOR_0"):
            if need not in p["attributes"]:
                raise RuntimeError("GLB primitive is missing %s: %s" % (need, sorted(p["attributes"])))
    return info


def look_data(b, with_paint):
    """Render setup for client/src/maplook.ts (not gameplay data)."""
    mats = {}
    for key in b.used_surfaces:
        t = mapkit.TEXTURE_LIBRARY[key]
        mats[b.export_names[key]] = {"albedo": t["out"], "tile": t["tile"]}
    if with_paint:
        pt = mapkit.TEXTURE_LIBRARY[b.m.paint_surface]
        mats[b.export_names["paint"]] = {"albedo": pt["out"], "tile": pt["tile"], "tint": PAINT_TINT, "decal": True}
    return {
        "lightmap": b.baked_name,
        "lightScale": LIGHT_SCALE,
        "materials": mats,
        "sky": {"texture": SKY_NAME, "elevMin": SKY_ELEV_MIN},
    }


# ---------------------------------------------------------------------------
# Source art processing (albedo textures, sky)
# ---------------------------------------------------------------------------
def _read_image(path, colorspace="Non-Color"):
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


def process_textures(keys):
    """Source diffuse maps -> tex_*.webp. Returns {key: mean linear albedo RGB} for the bake."""
    import numpy as np
    albedos = {}
    for key in keys:
        t = mapkit.TEXTURE_LIBRARY[key]
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
            low = _wrap_blur(lin, TEXTURE_SIZE / 10.0)                 # 1) detile
            lin = np.maximum(lin - t["detile"] * (low - mean), 1e-4)
            lum = lin @ lum_w                                           # 2) contrast (log luminance)
            gm = math.exp(float(np.log(lum).mean()))
            new_lum = gm * (lum / gm) ** t["contrast"]
            lin = lin * (new_lum / lum)[..., None]
            lum = (lin @ lum_w)[..., None]                              # 3) saturation
            lin = lum + (lin - lum) * t["sat"]
            lin = lin * (t["albedo"] / float((lin @ lum_w).mean())) * np.array(t["tint"])   # 4) albedo
            lin = np.clip(lin, 0.0, 1.0)
            _save_image(linear_to_srgb(lin), dst, "WEBP", TEXTURE_WEBP_QUALITY)
            log("texture %-10s %s -> %s (%d bytes)" % (key, t["src"], t["out"], os.path.getsize(dst)))
        elif os.path.exists(dst):
            log("texture %-10s source missing, reusing shipped %s" % (key, t["out"]))
        else:
            raise RuntimeError("texture %s: neither source %s nor shipped %s exists" % (key, src, dst))
        img = _read_image(dst)
        albedos[key] = tuple(float(c) for c in srgb_to_linear(_image_rgb(img)).reshape(-1, 3).mean(axis=0))
        bpy.data.images.remove(img)
        log("  mean linear albedo %s" % [round(c, 3) for c in albedos[key]])
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
            log("sky: source HDRI missing, reusing shipped %s" % SKY_NAME)
            return
        raise RuntimeError("sky: neither %s nor %s exists" % (HDRI_PATH, SKY_PATH))
    px = hdri_pixels().astype(np.float64)              # row 0 = nadir
    h, w, _ = px.shape
    elev = SKY_ELEV_MIN + (np.arange(SKY_H) + 0.5) / SKY_H * (90.0 - SKY_ELEV_MIN)
    sy = (elev + 90.0) / 180.0 * h - 0.5
    y0 = np.clip(np.floor(sy).astype(int), 0, h - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fy = (sy - np.floor(sy))[:, None, None]
    strip = px[y0] * (1 - fy) + px[y1] * fy
    if w != SKY_W:
        xs = (np.arange(SKY_W) + 0.5) / SKY_W * w - 0.5
        x0 = np.clip(np.floor(xs).astype(int), 0, w - 1)
        x1 = (x0 + 1) % w
        fx = (xs - np.floor(xs))[None, :, None]
        strip = strip[:, x0] * (1 - fx) + strip[:, x1] * fx
    strip = sky_tonemap(strip * SKY_DISPLAY_EXPOSURE)
    strip = np.clip(strip, 0, 1)
    _save_image(linear_to_srgb(strip), SKY_PATH, "JPEG", SKY_JPEG_QUALITY)
    log("sky: %dx%d, elevation %.0f..90 deg -> %s (%d bytes)"
        % (SKY_W, SKY_H, SKY_ELEV_MIN, SKY_PATH, os.path.getsize(SKY_PATH)))


def write_json(b, baked, with_paint):
    data = b.m.engine_data()
    if baked:
        data["baked"] = baked     # lighting atlas, sampled with TEXCOORD_1 of the GLB
        data["look"] = look_data(b, with_paint)
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(b.json_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    return data


def write_index():
    """client/public/maps/index.json: every map JSON in the folder, for the client's map menu."""
    maps = []
    for fn in sorted(os.listdir(OUT_DIR)):
        if not fn.endswith(".json") or fn == "index.json":
            continue
        try:
            with open(os.path.join(OUT_DIR, fn), encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and "boxes" in d and "name" in d:
            maps.append({"id": d["name"], "name": d.get("displayName", d["name"])})
    path = os.path.join(OUT_DIR, "index.json")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"maps": maps}, f, indent=2)
        f.write("\n")
    log("index.json: %s" % ", ".join("%s (%s)" % (m["id"], m["name"]) for m in maps))


def centre(points):
    n = len(points)
    return [round(sum(p[i] for p in points) / n, 3) for i in range(3)]


def build(m, opts):
    t_start = time.time()
    b = Build(m)
    reset_scene()
    size = opts.get("size") or m.lightmap_size
    samples = opts.get("samples") or m.samples
    if not opts["bake"]:
        if os.path.exists(b.baked_path):
            existing = bpy.data.images.load(b.baked_path)
            size = existing.size[0]           # UV layout is texel aligned to this size
            bpy.data.images.remove(existing)
            log("--no-bake: reusing %s (%d^2)" % (b.baked_path, size))
        else:
            log("WARNING --no-bake but %s does not exist; map will be unlit-fallback" % b.baked_path)
    keys = list(m.surfaces)
    if m.paint_surface not in keys:
        keys.append(m.paint_surface)
    albedos = process_textures(keys)
    process_sky()
    obj, faces = build_scene(b, size, albedos)
    if opts["bake"]:
        bake_lighting(b, obj, faces, size, samples)
    finalize_materials(b, obj, albedos)
    paint = build_paint(b, faces)
    if paint:
        make_mesh_object(m.id + "_paint", paint, ["paint"],
                         [make_export_material(b.export_names["paint"], (0.6, 0.2, 0.2))])
    log("paint decals: %d polygons from %d decals" % (len(paint), len(m.decals)))
    export_glb(b)
    expected = list(b.used_surfaces) + (["paint"] if paint else [])
    glb = inspect_glb(b, expected)
    data = write_json(b, b.baked_name if os.path.exists(b.baked_path) else None, bool(paint))
    write_index()

    glb_size = os.path.getsize(b.glb_path)
    log("--- summary (%s) ---" % m.id)
    log("display name: %s" % m.display_name)
    log("boxes (collision): %d, visual-only boxes: %d, lamps: %d" % (len(m.boxes), len(m.visuals), len(m.lights)))
    log("GLB: %d mesh, %d primitive (world draw calls), %d material, %d images, attributes %s"
        % (glb["meshes"], glb["primitives"], glb["materials"], glb["images"], glb["attributes"]))
    log("engine bounds: min %s max %s" % (data["bounds"]["min"], data["bounds"]["max"]))
    log("ghost spawn centre:    %s" % centre([s["pos"] for s in data["spawns"]["ghosts"]]))
    log("defender spawn centre: %s" % centre([s["pos"] for s in data["spawns"]["defenders"]]))
    for s in data["bombSites"]:
        log("site %s centre: %s" % (s["name"], centre([s["min"], s["max"]])))
    total = 0
    files = [b.glb_path, b.json_path, b.baked_path, SKY_PATH] + \
        [os.path.join(OUT_DIR, mapkit.TEXTURE_LIBRARY[k]["out"]) for k in keys]
    for p in files:
        if os.path.exists(p):
            total += os.path.getsize(p)
            log("%-28s %9d bytes" % (os.path.basename(p), os.path.getsize(p)))
    log("total download for this map: %d bytes (%.2f MB)" % (total, total / 1048576))
    log("build time %.1f s" % (time.time() - t_start))
    if glb_size <= 0 or glb_size > m.max_glb_bytes:
        raise RuntimeError("GLB size out of range: %d (limit %d)" % (glb_size, m.max_glb_bytes))
