"""
Realistic weapon sources (package M part 2), shared by weapons.py (third person + textures) and viewmodel.py (first
person). Plain helpers: import a downloaded model, put it into the shipped weapon frame, reduce it, map it into one
texture atlas per gun, and write that atlas.

Sources (CC-BY, credited in client/public/models/CREDITS.md), read from the git-ignored
tools/blender/source-art/realistic/<item>/ (zips are extracted into source-art/realistic/build/unzipped/):
  rifle/ak105fbx.zip            "AK-105" by SpatialNeglect: FBX, 2 materials (ak105, folding_stock), 4K PBR maps
  pistol/source.zip             "Makarov Pistol (PM)" by TaigaForest: FBX in metres with separate parts, 4K maps
                                (base colour, normal, occlusion/roughness/metallic packed), not linked in the FBX
  knife/tactical_knife_gltf.zip "Tactical Knife" by Gerardo Justel: glTF, one material, 4K maps
  reddot/red_dot_sight.glb      "Red Dot Sight" by Gerardo Justel: GLB, one material, 4K maps embedded
  scope2x/<anything>            "AR Scope (Game-Ready)" by Scape when the owner has downloaded it (any .zip, .glb,
                                .gltf or .fbx in that folder); otherwise a 2x combat scope is generated here.

Shipped frame (as weapons.py always had): Blender X right, Y forward (muzzle / blade tip), Z up, metres, origin at the
grip. Normal maps of every source were checked to be OpenGL-style (green up) by rendering them both ways.

The atlas (one per gun, one material per gun): every source material gets a rectangle of the atlas and its UVs are
scaled into it; generated parts and the first-person arms use small flat "swatches" (colour from vertex colours).
Two images per gun:
  <gun>_albedo_<size>.webp  RGB base colour (sRGB, ambient occlusion multiplied in), A = surface value s, read by the
                            client as BOTH gloss and metalness (metal ~0.6-0.9, polymer and rubber ~0.1-0.35)
  <gun>_normal_<size>.webp  tangent-space normal map (RGB, OpenGL convention), no alpha
Vertex colours: RGB multiplies the albedo (white on textured parts), A = emission (1 only on the red dot's reticle).
"""
import math
import os
import shutil
import subprocess
import zipfile

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(HERE, 'source-art', 'realistic')
BUILD = os.path.join(SRC, 'build')
FP_GLB = os.path.join(BUILD, 'weapons_fp.glb')
TEX_DIR = os.path.join(ROOT, 'client', 'public', 'models', 'textures')
ATLAS_SIZES = (2048, 1024)
# Atlas layout per gun (UV units, v up): [(source material, rect)], swatch rect. The rifle: AK-105 body, folding stock,
# red dot, downloaded scope; the swatches (flat colours for generated parts and the first-person arms) in the corner.
LAYOUTS = {
    'rifle': ([('ak105', (0.0, 0.25, 0.75, 1.0)), ('folding_stock', (0.75, 0.75, 1.0, 1.0)),
               ('sight', (0.75, 0.5, 1.0, 0.75)), ('scope', (0.75, 0.25, 1.0, 0.5))], (0.75, 0.0, 1.0, 0.25)),
    'pistol': ([('T_PM', (0.0, 0.25, 0.875, 1.0))], (0.875, 0.0, 1.0, 1.0)),
    'knife': ([('Material.001', (0.0, 0.5, 0.875, 1.0))], (0.875, 0.0, 1.0, 1.0)),
}
# The first-person arms (package O; soldier.py fills them from the soldier's textures): forearm and hand skin, the
# rolled sleeve, and on the knife the ghost's suit arms.
ARM_LAYOUTS = {
    'rifle': {'arms': (0.0, 0.0, 0.375, 0.25), 'sleeve': (0.375, 0.0, 0.75, 0.25)},
    'pistol': {'arms': (0.0, 0.0, 0.4375, 0.25), 'sleeve': (0.4375, 0.0, 0.875, 0.25)},
    'knife': {'arms': (0.0, 0.25, 0.4375, 0.5), 'sleeve': (0.4375, 0.25, 0.875, 0.5),
              'ghostarms': (0.0, 0.0, 0.875, 0.25)},
}
# With the pack's gloved hands (packhands.py): the arms' skin region becomes the glove (its maps, recoloured coyote) and
# the bare fingertips' skin; the sleeve and the ghost's suit keep their rectangles.
ARM_LAYOUTS_PACK = {
    'rifle': {'glove': (0.0, 0.0, 0.25, 0.25), 'handskin': (0.25, 0.0, 0.375, 0.25), 'sleeve': (0.375, 0.0, 0.75, 0.25)},
    'pistol': {'glove': (0.0, 0.0, 0.3125, 0.25), 'handskin': (0.3125, 0.0, 0.4375, 0.25),
               'sleeve': (0.4375, 0.0, 0.875, 0.25)},
    'knife': {'glove': (0.0, 0.25, 0.3125, 0.5), 'handskin': (0.3125, 0.25, 0.4375, 0.5),
              'sleeve': (0.4375, 0.25, 0.875, 0.5), 'ghostarms': (0.0, 0.0, 0.875, 0.25)},
}
WEBP_QUALITY = {'albedo': 82, 'normal': 85}


def log(*a):
    print('[realistic]', *a, flush=True)


def tris(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


# ---------------------------------------------------------------------------------------------
# Files

def find_source(item, exts):
    """First file under source-art/realistic/<item>/ with one of `exts` (zips are extracted first), or None."""
    root = os.path.join(SRC, item)
    if not os.path.isdir(root):
        return None
    for name in sorted(os.listdir(root)):
        if name.lower().endswith('.zip'):
            unzip(os.path.join(root, name))
    for base in (root, os.path.join(BUILD, 'unzipped', item)):
        for dirpath, _, files in os.walk(base):
            if os.path.normpath(dirpath).startswith(os.path.normpath(BUILD)) and base == root:
                continue
            for f in sorted(files):
                if f.lower().endswith(exts):
                    return os.path.join(dirpath, f)
    return None


def unzip(path):
    """Extracts a downloaded zip into build/unzipped/<item>/ once (names with '..' or absolute paths are skipped)."""
    item = os.path.basename(os.path.dirname(path))
    dst = os.path.join(BUILD, 'unzipped', item)
    stamp = os.path.join(dst, '.from_' + os.path.basename(path))
    if os.path.exists(stamp):
        return dst
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            n = info.filename.replace('\\', '/')
            if n.startswith('/') or '..' in n.split('/') or ':' in n:
                continue
            z.extract(info, dst)
    open(stamp, 'w').close()
    return dst


def find_file(item, name):
    """A file called `name` anywhere in the item's folder or its extracted zips."""
    for base in (os.path.join(SRC, item), os.path.join(BUILD, 'unzipped', item)):
        for dirpath, _, files in os.walk(base):
            if name in files:
                return os.path.join(dirpath, name)
    raise FileNotFoundError(f'{name} not found for {item}')


def import_model(path):
    """Imports a model file; returns its meshes with world transforms baked in, unparented (other new objects removed)."""
    before = set(bpy.data.objects)
    low = path.lower()
    if low.endswith('.fbx'):
        bpy.ops.import_scene.fbx(filepath=path)
    elif low.endswith(('.glb', '.gltf')):
        bpy.ops.import_scene.gltf(filepath=path)
    elif low.endswith('.obj'):
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise ValueError(f'cannot import {path}')
    bpy.context.view_layer.update()
    new = [o for o in bpy.data.objects if o not in before]
    meshes = []
    for o in new:
        if o.type != 'MESH':
            continue
        if o.data.users > 1:
            o.data = o.data.copy()
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(mw)
        o.matrix_world = Matrix()
        meshes.append(o)
    for o in new:
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    return meshes


# ---------------------------------------------------------------------------------------------
# Geometry

def basis(forward, up):
    """Matrix whose rows map source vectors to (right, forward, up) = Blender (X, Y, Z)."""
    f = Vector(forward).normalized()
    u = Vector(up)
    u = (u - f * u.dot(f)).normalized()
    r = f.cross(u)
    return Matrix((r, f, u)).to_4x4()


def to_frame(objs, forward, up, origin, scale):
    """Moves meshes (world = data) into the shipped frame: `origin` (source) to 0, axes turned, scaled."""
    m = Matrix.Scale(scale, 4) @ basis(forward, up) @ Matrix.Translation(-Vector(origin))
    for o in objs:
        o.data.transform(m)
        o.data.update()
    return m


def points(objs):
    return [v.co.copy() for o in (objs if isinstance(objs, (list, tuple)) else [objs]) for v in o.data.vertices]


def bounds(objs):
    p = points(objs)
    lo = Vector((min(q.x for q in p), min(q.y for q in p), min(q.z for q in p)))
    hi = Vector((max(q.x for q in p), max(q.y for q in p), max(q.z for q in p)))
    return lo, hi


def axis_of(pts):
    """Unit axis from the centroid of the lowest third of `pts` (by Z) to that of the highest third; and both ends."""
    pts = sorted(pts, key=lambda p: p.z)
    n = max(1, len(pts) // 3)
    lo = sum(pts[:n], Vector()) / n
    hi = sum(pts[-n:], Vector()) / n
    return (hi - lo).normalized(), lo, hi


def join(objs, name=None):
    objs = [o for o in objs if o is not None]
    first = objs[0]
    if len(objs) > 1:
        for o in bpy.context.scene.objects:
            o.select_set(o in objs)
        bpy.context.view_layer.objects.active = first
        with bpy.context.temp_override(active_object=first, selected_editable_objects=objs, selected_objects=objs):
            bpy.ops.object.join()
    if name:
        first.name = name
        first.data.name = name
    return first


def duplicate(obj, name):
    c = obj.copy()
    c.data = obj.data.copy()
    c.name = name
    c.data.name = name
    bpy.context.scene.collection.objects.link(c)
    return c


def weld(obj, dist=1e-6):
    """Merges coincident vertices (keeps custom normals as they are)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bm.to_mesh(obj.data)
    bm.free()


def decimate(obj, target, keep_normals=True):
    """Collapse-decimates `obj` to about `target` triangles, then copies the original's custom normals back onto it
    (nearest face, interpolated), so the source's normal maps still shade the way they were baked."""
    n = tris(obj.data)
    if n <= target:
        return
    ref = duplicate(obj, obj.name + '_ref') if keep_normals else None
    weld(obj, 1e-6)
    m = obj.modifiers.new('Collapse', 'DECIMATE')
    m.ratio = max(0.01, target / max(1, tris(obj.data)))
    m.use_collapse_triangulate = True
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=m.name)
    if ref is not None:
        transfer_normals(ref, obj)
        bpy.data.objects.remove(ref)
    log('decimated', obj.name, n, '->', tris(obj.data))


def transfer_normals(src, dst):
    m = dst.modifiers.new('Normals', 'DATA_TRANSFER')
    m.object = src
    m.use_loop_data = True
    m.data_types_loops = {'CUSTOM_NORMAL'}
    m.loop_mapping = 'POLYINTERP_NEAREST'
    with bpy.context.temp_override(object=dst, active_object=dst):
        bpy.ops.object.modifier_apply(modifier=m.name)


def uv_crop(objs, material, pad=0.01):
    """Bounding box (u0, v0, u1, v1) of the UVs of `material`'s faces over `objs`, padded; None if none."""
    lo, hi = None, None
    for o in objs:
        me = o.data
        if not me.uv_layers:
            continue
        uv = np.zeros(len(me.loops) * 2, np.float32)
        me.uv_layers.active.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        mats = [m.name if m else '' for m in me.materials]
        for p in me.polygons:
            if p.material_index < len(mats) and mats[p.material_index] == material:
                sel = uv[p.loop_start:p.loop_start + p.loop_total]
                a, b = sel.min(axis=0), sel.max(axis=0)
                lo = a if lo is None else np.minimum(lo, a)
                hi = b if hi is None else np.maximum(hi, b)
    if lo is None:
        return None
    return (max(0.0, float(lo[0]) - pad), max(0.0, float(lo[1]) - pad), min(1.0, float(hi[0]) + pad),
            min(1.0, float(hi[1]) + pad))


def new_mesh_object(name, bm, material):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(bpy.data.materials.get(material) or bpy.data.materials.new(material))
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def lathe(name, profile, segments, material, centre=(0.0, 0.0), back=0.0, sharp=35):
    """
    A solid of revolution about an axis along +Y through (x, z) = `centre`: `profile` is [(y, radius), ...] from the
    rear to the front (y from `back`); consecutive points make one ring of quads. Ends with radius > 0 are left open
    (a bore you can see into, or a lens you look through). Faces point outward.
    """
    bm = bmesh.new()
    cx, cz = centre
    rings = []
    for y, r in profile:
        rings.append([bm.verts.new((cx + r * math.cos(2 * math.pi * k / segments), back + y,
                                    cz + r * math.sin(2 * math.pi * k / segments))) for k in range(segments)])
    for a, b in zip(rings, rings[1:]):
        for k in range(segments):
            n = (k + 1) % segments
            bm.faces.new((a[k], a[n], b[n], b[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = new_mesh_object(name, bm, material)
    # Outward: the first face's normal should point away from the axis or along it at the end caps.
    f = obj.data.polygons[len(obj.data.polygons) // 2]
    c = f.center
    out = Vector((c.x - cx, 0, c.z - cz))
    if out.length > 1e-6 and f.normal.dot(out) < 0:
        obj.data.flip_normals()
    obj.data.set_sharp_from_angle(angle=math.radians(sharp))
    return obj


def box(name, centre, size, material, bevel=0.0, segments=1, drop=()):
    """A box (optionally bevelled); `drop` = outward directions whose faces are left out (faces nobody sees from
    outside but would show from inside a sight, such as the underside of a housing sitting on a tube)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=bevel, segments=segments, affect='EDGES',
                        profile=0.5)
    if drop:
        bm.normal_update()
        dead = [f for f in bm.faces if any(f.normal.dot(Vector(d)) > 0.99 for d in drop)]
        bmesh.ops.delete(bm, geom=dead, context='FACES_ONLY')
    bmesh.ops.translate(bm, verts=bm.verts, vec=centre)
    obj = new_mesh_object(name, bm, material)
    obj.data.set_sharp_from_angle(angle=math.radians(35))
    return obj


def cylinder(name, start, direction, length, radius, material, segments=16, cap=True):
    """A capped cylinder from `start` along `direction` (unit)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segments, radius1=radius, radius2=radius,
                          depth=length)
    d = Vector(direction).normalized()
    rot = Vector((0, 0, 1)).rotation_difference(d).to_matrix()
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=rot)
    bmesh.ops.translate(bm, verts=bm.verts, vec=Vector(start) + d * (length / 2))
    obj = new_mesh_object(name, bm, material)
    obj.data.set_sharp_from_angle(angle=math.radians(35))
    return obj


def disc(name, centre, normal, radius, material, segments=12):
    """A flat polygon facing `normal`."""
    bm = bmesh.new()
    n = Vector(normal).normalized()
    a = n.orthogonal().normalized()
    b = n.cross(a)
    vs = [bm.verts.new(Vector(centre) + (a * math.cos(2 * math.pi * k / segments) + b * math.sin(2 * math.pi * k / segments)) * radius)
          for k in range(segments)]
    f = bm.faces.new(vs)
    f.normal_update()
    if f.normal.dot(n) < 0:
        f.normal_flip()
    return new_mesh_object(name, bm, material)


def front_face(obj, eps=0.004):
    """Forward-most face of a mesh: (centre x, front y, centre z, height)."""
    pts = [v.co for v in obj.data.vertices]
    ymax = max(p.y for p in pts)
    front = [p for p in pts if p.y > ymax - eps]
    lo, hi = min(p.z for p in front), max(p.z for p in front)
    return (min(p.x for p in front) + max(p.x for p in front)) / 2, ymax, (lo + hi) / 2, hi - lo


def add_empty(name, loc, parent=None, axis=None):
    """An empty at `loc`; with `axis`, its local +Z points along it (landmark directions for viewmodel.py)."""
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    m = Matrix.Translation(Vector(loc))
    if axis is not None:
        m = m @ Vector((0, 0, 1)).rotation_difference(Vector(axis).normalized()).to_matrix().to_4x4()
    e.matrix_world = m
    if parent is not None:
        e.parent = parent
        e.matrix_parent_inverse = parent.matrix_world.inverted()
    return e


# ---------------------------------------------------------------------------------------------
# Materials of the sources

def material_maps(mat):
    """{'base', 'rough', 'metal', 'ao', 'normal'} -> (image, channel or None for RGB) traced from a Principled BSDF."""
    out = {}
    if not mat or not mat.node_tree:
        return out
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        return out

    def trace(sock, depth=0):
        if depth > 6 or not sock.is_linked:
            return None
        link = sock.links[0]
        node, out_name = link.from_node, link.from_socket.name
        if node.type == 'TEX_IMAGE' and node.image:
            return (node.image, 3 if out_name == 'Alpha' else None)
        if node.type in ('SEPARATE_COLOR', 'SEPRGB', 'SEPARATE_RGB'):
            ch = {'Red': 0, 'R': 0, 'Green': 1, 'G': 1, 'Blue': 2, 'B': 2}.get(out_name)
            r = trace(node.inputs[0], depth + 1)
            return (r[0], ch) if r else None
        if node.type == 'NORMAL_MAP':
            return trace(node.inputs['Color'], depth + 1)
        for s in node.inputs:
            r = trace(s, depth + 1)
            if r:
                return r
        return None

    for key, name in (('base', 'Base Color'), ('rough', 'Roughness'), ('metal', 'Metallic'), ('normal', 'Normal')):
        r = trace(bsdf.inputs[name])
        if r:
            out[key] = r
    return out


class Region:
    """One rectangle of an atlas (UV space, v up) and the maps resampled into it."""

    def __init__(self, name, rect, maps=None, constant=None, crop=None, post=None):
        """`crop` (u0, v0, u1, v1): only that part of the source maps is used (UVs outside it are clamped);
        `post(rgb, s)` may change the composed albedo (h, w, 3) and surface value (h, w) of this region in place."""
        self.name, self.rect, self.maps, self.constant = name, rect, maps or {}, constant
        self.crop, self.post = crop, post

    def map_uv(self, u, v):
        u0, v0, u1, v1 = self.rect
        if self.crop:
            c0, d0, c1, d1 = self.crop
            u, v = (u - c0) / max(c1 - c0, 1e-6), (v - d0) / max(d1 - d0, 1e-6)
        return u0 + u * (u1 - u0), v0 + v * (v1 - v0)

    def centre(self):
        u0, v0, u1, v1 = self.rect
        return (u0 + u1) / 2, (v0 + v1) / 2


# Generated-part swatches: (albedo grey multiplied by the vertex colour, surface value s).
SWATCH_S = {'polymer': 0.22, 'metal': 0.62, 'glow': 0.15}


class Atlas:
    """
    Rectangles for each source material plus a column of flat swatches. `layout` = [(material name or key, rect,
    maps)] with rect in UV units (u0, v0, u1, v1); the swatches fill `swatch_rect`.
    """

    def __init__(self, name, layout, swatch_rect):
        self.name = name
        self.regions = {}
        for entry in layout:
            if isinstance(entry, Region):
                self.regions[entry.name] = entry
            else:
                k, r, m = entry
                self.regions[k] = Region(k, r, m)
        u0, v0, u1, v1 = swatch_rect
        keys = list(SWATCH_S)
        h = (v1 - v0) / len(keys)
        self.swatches = {k: Region(k, (u0, v0 + i * h, u1, v0 + (i + 1) * h), constant=SWATCH_S[k])
                         for i, k in enumerate(keys)}

    def remap(self, obj, material_region=None, swatch=None):
        """
        Writes the atlas UVs ('UVMap', the only layer left): faces of a source material are scaled into its region;
        with `swatch`, every face points at that swatch's centre. `material_region` maps a material name to a region
        key (default: the material's own name).
        """
        me = obj.data
        n = len(me.loops)
        uv = np.zeros(n * 2, np.float32)
        if swatch is None:
            src = me.uv_layers.active
            if src is None:
                raise RuntimeError(f'{obj.name} has no UVs')
            src.data.foreach_get('uv', uv)
            uv = uv.reshape(-1, 2)
            out = np.zeros_like(uv)
            mats = [m.name if m else '' for m in me.materials]
            lo_seen, hi_seen = uv.min(axis=0), uv.max(axis=0)
            if lo_seen.min() < -0.01 or hi_seen.max() > 1.01:
                log('WARNING', obj.name, 'UVs outside 0..1:', lo_seen, hi_seen, '(clamped)')
            uv = np.clip(uv, 0.0, 1.0)
            poly_mat = np.zeros(len(me.polygons), np.int32)
            me.polygons.foreach_get('material_index', poly_mat)
            loop_poly = np.zeros(n, np.int32)
            for p in me.polygons:
                loop_poly[p.loop_start:p.loop_start + p.loop_total] = p.index
            loop_mat = poly_mat[loop_poly]
            for mi, mname in enumerate(mats):
                key = (material_region or {}).get(mname, mname)
                if key not in self.regions:
                    key = next((k for k in self.regions if mname.startswith(k)), None)
                if key is None:
                    raise RuntimeError(f'{obj.name}: material {mname!r} has no atlas region in {self.name}')
                reg = self.regions[key]
                u0, v0, u1, v1 = reg.rect
                sel = loop_mat == mi
                su, sv = uv[sel, 0], uv[sel, 1]
                if reg.crop:
                    c0, d0, c1, d1 = reg.crop
                    su = np.clip((su - c0) / max(c1 - c0, 1e-6), 0, 1)
                    sv = np.clip((sv - d0) / max(d1 - d0, 1e-6), 0, 1)
                out[sel, 0] = u0 + su * (u1 - u0)
                out[sel, 1] = v0 + sv * (v1 - v0)
            uv = out.ravel()
        else:
            cu, cv = self.swatches[swatch].centre()
            uv = np.tile(np.array([cu, cv], np.float32), n)
        for layer in list(me.uv_layers):
            me.uv_layers.remove(layer)
        layer = me.uv_layers.new(name='UVMap')
        layer.data.foreach_set('uv', uv)

    # --- images --------------------------------------------------------------------------------

    def write(self, out_dir=TEX_DIR, sizes=ATLAS_SIZES):
        """Composes the atlas at the largest size, writes every size as WebP; returns {(kind, size): path}."""
        size = max(sizes)
        alb = np.zeros((size, size, 4), np.float32)
        nrm = np.zeros((size, size, 4), np.float32)
        nrm[...] = (0.5, 0.5, 1.0, 1.0)
        for reg in list(self.regions.values()) + list(self.swatches.values()):
            x0, y0, x1, y1 = (int(round(c * size)) for c in reg.rect)
            w, h = x1 - x0, y1 - y0
            if w <= 0 or h <= 0:
                continue
            if reg.constant is not None:
                alb[y0:y1, x0:x1] = (1.0, 1.0, 1.0, reg.constant)
                nrm[y0:y1, x0:x1] = (0.5, 0.5, 1.0, 1.0)
                continue
            mp = reg.maps
            cr = reg.crop
            base = sample(mp.get('base'), w, h, (0.2, 0.2, 0.2), cr)
            rough = sample(mp.get('rough'), w, h, 0.6, cr)
            metal = sample(mp.get('metal'), w, h, 0.0, cr)
            ao = sample(mp.get('ao'), w, h, 1.0, cr)
            n = sample(mp.get('normal'), w, h, (0.5, 0.5, 1.0), cr)
            g = 1.0 - rough
            s = metal * (0.55 + 0.35 * g) + (1.0 - metal) * (0.10 + 0.30 * g)
            # Metal: the sources' gun-black base colour (about 0.2) is lifted so the client's studio reflection reads
            # on it (it is the metal's reflectance); polymer is left as it is.
            alb[y0:y1, x0:x1, :3] = np.clip(base * ao[..., None] * (1.0 + METAL_LIFT * metal[..., None]), 0, 1)
            # s is smoothed and stepped (it only has to tell metal from polymer and shiny from worn): the WebP
            # alpha plane is stored losslessly, and a smooth stepped plane costs little.
            alb[y0:y1, x0:x1, 3] = np.round(box_blur(s, 2) * S_LEVELS) / S_LEVELS
            if reg.post:
                rgb, sv = alb[y0:y1, x0:x1, :3], alb[y0:y1, x0:x1, 3]
                reg.post(rgb, sv)
            nrm[y0:y1, x0:x1, :3] = n
            nrm[y0:y1, x0:x1, 3] = 1.0
            log(self.name, 'region', reg.name, f'{w}x{h}', 'mean s', round(float(s.mean()), 3),
                'metal share', round(float((metal > 0.5).mean()), 3))
        os.makedirs(out_dir, exist_ok=True)
        paths = {}
        for kind, arr in (('albedo', alb), ('normal', nrm)):
            for sz in sizes:
                a = arr if sz == size else downsample(arr, size // sz)
                path = os.path.join(out_dir, f'{self.name}_{kind}_{sz}.webp')
                save_webp(a, path, WEBP_QUALITY[kind], alpha=kind == 'albedo')
                paths[(kind, sz)] = path
                log('wrote', path, os.path.getsize(path), 'bytes')
        return paths


_CROPPED = {}


def sample(src, w, h, default, crop=None):
    """A source map resampled to w x h (rows bottom-up, raw stored values): (h, w, 3) for colour, (h, w) for a channel.
    With `crop` (u0, v0, u1, v1), only that part of the image."""
    if src is None:
        if isinstance(default, tuple):
            return np.broadcast_to(np.array(default, np.float32), (h, w, 3)).copy()
        return np.full((h, w), default, np.float32)
    img, ch = src
    img.colorspace_settings.name = 'Non-Color'     # raw stored values (sRGB-encoded colours stay encoded)
    if crop:
        key = (img.name, tuple(round(x, 5) for x in crop))
        if key not in _CROPPED:
            iw, ih = img.size
            px = np.empty(iw * ih * 4, np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(ih, iw, 4)
            x0, x1 = int(crop[0] * iw), max(int(crop[0] * iw) + 1, int(math.ceil(crop[2] * iw)))
            y0, y1 = int(crop[1] * ih), max(int(crop[1] * ih) + 1, int(math.ceil(crop[3] * ih)))
            _CROPPED[key] = np.ascontiguousarray(px[y0:y1, x0:x1])
        sub = _CROPPED[key]
        c = bpy.data.images.new('sb_crop', sub.shape[1], sub.shape[0], alpha=True, float_buffer=True)
        c.colorspace_settings.name = 'Non-Color'
        c.pixels.foreach_set(sub.ravel())
        c.scale(w, h)
        a = np.empty(w * h * 4, np.float32)
        c.pixels.foreach_get(a)
        bpy.data.images.remove(c)
        a = a.reshape(h, w, 4)
        if isinstance(default, tuple):
            return a[..., :3].copy()
        return a[..., ch if ch is not None else 0].copy()
    c = img.copy()
    c.scale(w, h)
    a = np.empty(w * h * 4, np.float32)
    c.pixels.foreach_get(a)
    bpy.data.images.remove(c)
    a = a.reshape(h, w, 4)
    if isinstance(default, tuple):
        return a[..., :3].copy()
    return a[..., ch if ch is not None else 0].copy()


S_LEVELS = 16
METAL_LIFT = 0.7


def box_blur(a, r):
    """Mean over a (2r+1)^2 window (edges clamped)."""
    p = np.pad(a, r, mode='edge')
    c = np.cumsum(np.cumsum(p, axis=0), axis=1)
    c = np.pad(c, ((1, 0), (1, 0)))
    k = 2 * r + 1
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def downsample(a, k):
    h, w, c = a.shape
    return a.reshape(h // k, k, w // k, k, c).mean(axis=(1, 3))


def save_webp(arr, path, quality, alpha=True):
    h, w, _ = arr.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=alpha)
    img.colorspace_settings.name = 'Non-Color'
    img.alpha_mode = 'STRAIGHT'
    img.pixels.foreach_set(np.clip(arr, 0, 1).astype(np.float32).ravel())
    img.file_format = 'WEBP'
    img.filepath_raw = path
    img.save(filepath=path, quality=quality)
    bpy.data.images.remove(img)
    if not os.path.exists(path):
        raise RuntimeError(f'could not write {path}')


def load_image(path):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = 'Non-Color'
    return img


# ---------------------------------------------------------------------------------------------
# Vertex colours and the single material

def set_colour(obj, rgba):
    """Every corner of `obj` gets `rgba` in the byte colour attribute 'Col' (RGB tints the albedo, A = emission)."""
    me = obj.data
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    vals = np.tile(np.array(rgba, np.float32), len(me.loops))
    attr.data.foreach_set('color', vals)
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find('Col')


def single_material(obj, name):
    me = obj.data
    me.materials.clear()
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    me.materials.append(mat)
    for p in me.polygons:
        p.material_index = 0
    return mat


def prepare(obj, atlas, material, swatch=None, colour=(1, 1, 1, 0), material_region=None):
    """Atlas UVs, vertex colour and the gun's one material, in that order (UVs need the source materials)."""
    atlas.remap(obj, material_region=material_region, swatch=swatch)
    set_colour(obj, colour)
    single_material(obj, material)


def quantize(path):
    """Shrinks a shipped GLB's vertex attributes (tools/quantize-glb.mjs, needs Node on the PATH)."""
    node = shutil.which('node')
    if not node:
        log('WARNING node not found: run node tools/quantize-glb.mjs', path)
        return
    subprocess.run([node, os.path.join(ROOT, 'tools', 'quantize-glb.mjs'), path], check=True)
