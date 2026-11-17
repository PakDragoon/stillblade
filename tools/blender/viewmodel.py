"""
Stillblade first-person viewmodels: arms and hands holding each weapon, with their clips.

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup \
        --python tools/blender/viewmodel.py [-- --swat <SWAT.glb>]

Writes client/public/models/viewmodel_rifle.glb, viewmodel_pistol.glb and viewmodel_knife.glb (one file per rig, so
each holds only its own clips). Sources, both CC0 and already on disk (nothing new is downloaded):
  - the arms, gloves and finger rig of "SWAT" by Quaternius (tools/blender/source-art/characters/quaternius-swat/
    SWAT.glb, the same file characters.py uses; see client/public/models/CREDITS.md);
  - the shipped weapon meshes, client/public/models/weapons.glb (built by weapons.py from Quaternius's "Character
    Soldier"), imported as they are, so first and third person show the same guns.

Each rig is ONE skinned mesh (arms + weapon), so it is one draw call:
  - bones UpperArm / LowerArm / Wrist / finger chains (.L and .R) copied from the SWAT rig at the character's 1.8 m
    scale, plus "weapon" (the weapon's own frame, origin at the grip) and, under it, the moving parts:
      rifle  : mag (the magazine), bolt (a small generated cocking knob at the front left of the receiver), sup (suppressor),
               sight_reddot and sight_scope2x (the optional sights, weapons.py's gun_sight_<id>; package M)
      pistol : mag (the base plate plus a generated magazine body), slide, sup (suppressor)
      knife  : no parts
  - empties "muzzle" (suppressor front) and "muzzle_bare" (bare barrel front) under the weapon bone, guns only.
  - the knife file holds two meshes on the same armature: "vm_knife" (defender sleeves) and "vm_ghost" (the ghost
    suit); the client shows one.
The suppressor is part of the mesh; the client hides it by scaling the "sup" bone to almost nothing (no extra draw
call and no mesh swap). The sights not mounted are hidden the same way (every clip keys them on the gun, at full size),
and the magazine inside the reload clip while it is off screen.

Rig space (glTF/engine): -Z forward, +Y up, +X right, metres. For the guns the rig's origin is the gun's grip at the
hip pose, where client/src/presenter.ts places it (its per-weapon `hip` pose, the same numbers as HIP below): the
client moves the whole rig for aiming, drawing, firing kick and sway, and the clips only move what is inside it.
For the knife the rig's origin is the camera itself; the clips carry the whole swing.

Clips (30 fps, every bone keyed on every frame, linear):
  rifle  : idle; reload (2.2 s = the rule's reload; magazine out at 0.3 s, new one seated at 1.4 s, bolt pulled at
           1.9 s and released at 2.07 s: the times of synthReload in client/src/audio.ts)
  pistol : idle; reload (1.4 s; magazine drops at 0.15 s, new one seated at 0.7 s, slide pulled at 1.0 s and released
           at 1.17 s: synthPistolReload)
  knife  : idle; swing (0.2 s windup = the rule's windup, 0.12 s slash, 0.2 s recovery)
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rigkit as rk  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
DEFAULT_SWAT = os.path.join(HERE, 'source-art', 'characters', 'quaternius-swat', 'SWAT.glb')
WEAPONS_GLB = os.path.join(ROOT, 'client', 'public', 'models', 'weapons.glb')
OUT_DIR = os.path.join(ROOT, 'client', 'public', 'models')

FPS = 30
TARGET_HEIGHT = 1.8
# The grip point in the hand (rigkit.hand_grip_frame): off the palm along its normal, and along the hand.
GRIP_PALM_OFFSET = 0.024
GRIP_ALONG_HAND = 0.6
# The source's cartoon hands are large next to real-size guns: the clips scale each hand about its wrist.
HAND_SCALE = 0.8

FINGERS = ('Index', 'Middle', 'Ring', 'Pinky')
ARM_BONES = ['UpperArm', 'LowerArm', 'Wrist'] + [f'{f}{k}' for f in FINGERS for k in (1, 2, 3, 4)] + \
    [f'Thumb{k}' for k in (1, 2, 3)]

# Linear RGB per SWAT material. First person sees sleeves and gloves only.
PALETTES = {
    # Coyote-brown gloves: they must read against the black guns.
    'defender': {'Swat': (0.62, 0.22, 0.04, 1.0), 'Swat_Black': (0.2, 0.135, 0.07, 1.0), 'Skin': (0.17, 0.115, 0.06, 1.0)},
    'ghost': {'Swat': (0.075, 0.07, 0.11, 1.0), 'Swat_Black': (0.025, 0.025, 0.03, 1.0), 'Skin': (0.04, 0.04, 0.045, 1.0)},
}
PART_COLOURS = {
    'knob': (0.13, 0.135, 0.14, 1.0),     # weapons.py's Grey2
    'magbody': (0.045, 0.048, 0.052, 1.0),  # DarkGrey
}

# Hip poses of the guns in PlayCanvas camera space (position, Euler degrees): presenter.ts VM_LOOKS[..].hip.
HIP = {
    'rifle': ((0.17, -0.32, -0.5), (4, 6, -6)),
    'pistol': ((0.12, -0.175, -0.34), (2, 4, -3)),
}

# Shoulders and elbow pole directions in camera space (Blender axes: X right, Y forward, Z up).
SHOULDERS = {
    'rifle': {'R': (0.2, 0.12, -0.3), 'L': (-0.02, 0.36, -0.44)},
    'pistol': {'R': (0.19, -0.02, -0.27), 'L': (-0.04, 0.17, -0.34)},
    'knife': {'R': (0.18, 0.08, -0.3), 'L': (-0.2, -0.02, -0.28)},
}
POLES = {'R': (0.8, -0.3, -1.0), 'L': (-0.8, -0.3, -1.0)}

# Finger curls (degrees for bones 2, 3, 4 of each finger; thumb: opposition about the fingers' direction, then
# curl of Thumb2 and Thumb3), per hold.
GRIP_CURL = {f: (78, 85, 50) for f in FINGERS}
TRIGGER_CURL = dict(GRIP_CURL, Index=(28, 38, 20))
WRAP_CURL = {f: (70, 75, 45) for f in FINGERS}
PINCH_CURL = {'Index': (45, 55, 30), 'Middle': (40, 50, 30), 'Ring': (35, 45, 25), 'Pinky': (30, 40, 20)}
RELAX_CURL = {f: (25, 30, 15) for f in FINGERS}
THUMB_GRIP = (55, 25, 20)
THUMB_RELAX = (20, 10, 5)


def log(*a):
    rk.log('viewmodel', *a)


def args():
    swat = DEFAULT_SWAT
    if '--' in sys.argv:
        rest = sys.argv[sys.argv.index('--') + 1:]
        if '--swat' in rest:
            swat = rest[rest.index('--swat') + 1]
    return swat


# ---------------------------------------------------------------------------------------------
# Arms from the SWAT model

def import_swat(path, palette_name):
    """Imports SWAT.glb and returns (src armature, scale to metres, arms mesh object in metres with vertex groups)."""
    bpy.ops.import_scene.gltf(filepath=path)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE' and o.name.startswith('CharacterArmature'))
    # Unparent from the importer's root node, keeping the world transform (the root node is removed later).
    mw = arm.matrix_world.copy()
    arm.parent = None
    arm.matrix_world = mw
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm]
    dg = bpy.context.evaluated_depsgraph_get()
    zs = []
    for o in meshes:
        ev = o.evaluated_get(dg)
        m = ev.to_mesh()
        zs.extend((o.matrix_world @ v.co).z for v in m.vertices)
        ev.to_mesh_clear()
    s = TARGET_HEIGHT / (max(zs) - min(zs))
    body = next(o for o in meshes if o.name.startswith('Swat_Body'))
    palette = PALETTES[palette_name]

    me = body.data
    ev = body.evaluated_get(dg)
    em = ev.to_mesh()
    world = [body.matrix_world @ v.co for v in em.vertices]
    ev.to_mesh_clear()
    gname = {g.index: g.name for g in body.vertex_groups}
    wanted = {f'{b}.{side}' for b in ARM_BONES for side in 'LR'}
    weights = []
    for v in me.vertices:
        w = {gname[g.group]: g.weight for g in v.groups if gname[g.group] in wanted and g.weight > 0}
        weights.append(w)
    keep_v = [sum(w.values()) >= 0.35 for w in weights]
    mats = [m.name if m else '' for m in me.materials]

    bm = bmesh.new()
    vmap = {}
    for i, v in enumerate(me.vertices):
        if keep_v[i]:
            vmap[i] = bm.verts.new(world[i] * s)
    bm.verts.ensure_lookup_table()
    col_layer = bm.loops.layers.color.new('Col')
    face_cols = []
    for p in me.polygons:
        if not all(keep_v[i] for i in p.vertices):
            continue
        try:
            f = bm.faces.new([vmap[i] for i in p.vertices])
        except ValueError:
            continue
        name = mats[p.material_index] if p.material_index < len(mats) else ''
        key = next((k for k in palette if name == k or name.startswith(k + '.')), None)
        face_cols.append((f, palette[key] if key else (1, 0, 1, 1)))
    out_me = bpy.data.meshes.new('arms')
    bm.to_mesh(out_me)
    bm.free()
    obj = bpy.data.objects.new('arms', out_me)
    bpy.context.scene.collection.objects.link(obj)
    # Vertex groups (renormalised over the arm bones) and corner colours, by the kept vertex order.
    kept = [i for i in range(len(me.vertices)) if keep_v[i]]
    groups = {}
    for new_i, old_i in enumerate(kept):
        w = weights[old_i]
        tot = sum(w.values())
        for gn, gw in w.items():
            g = groups.get(gn) or obj.vertex_groups.new(name=gn)
            groups[gn] = g
            g.add([new_i], gw / tot, 'REPLACE')
    set_corner_colours(obj, [c for _, c in face_cols])
    thin_arms(obj, arm, s)
    # Fewer triangles: the sleeves are mostly off screen and the file is downloaded by every player.
    n = tris(out_me)
    if n > ARM_TRIS:
        dec = obj.modifiers.new('Decimate', 'DECIMATE')
        dec.ratio = ARM_TRIS / n
        dec.use_collapse_triangulate = True
        with bpy.context.temp_override(object=obj, active_object=obj):
            bpy.ops.object.modifier_apply(modifier=dec.name)
    log('arms:', len(out_me.vertices), 'verts', tris(out_me), 'tris, scale', round(s, 5))
    return arm, s, obj


ARM_THIN = 0.78
ARM_TRIS = 1500


def thin_arms(obj, src, s):
    """
    Pulls the sleeve vertices toward their bone's axis (by ARM_THIN at full upper or lower arm weight): the source's
    cartoon forearms fill the screen at first-person distance. The hands are left as they are.
    """
    heads = {}
    for side in 'LR':
        for n in ('UpperArm', 'LowerArm', 'Wrist'):
            b = src.data.bones[f'{n}.{side}']
            heads[f'{n}.{side}'] = (src.matrix_world @ b.head_local) * s
    groups = {g.index: g.name for g in obj.vertex_groups}
    for v in obj.data.vertices:
        w = {groups[g.group]: g.weight for g in v.groups}
        for side in 'LR':
            wu, wl = w.get(f'UpperArm.{side}', 0.0), w.get(f'LowerArm.{side}', 0.0)
            if wu + wl <= 0:
                continue
            a, b = (heads[f'UpperArm.{side}'], heads[f'LowerArm.{side}']) if wu >= wl else                 (heads[f'LowerArm.{side}'], heads[f'Wrist.{side}'])
            d = b - a
            k = max(0.0, min(1.0, (v.co - a).dot(d) / d.length_squared))
            p = a + d * k
            f = 1 - (1 - ARM_THIN) * min(1.0, wu + wl)
            v.co = p + (v.co - p) * f


def set_corner_colours(obj, per_face):
    me = obj.data
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    for poly, col in zip(me.polygons, per_face):
        for li in poly.loop_indices:
            attr.data[li].color = col
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find('Col')


def tris(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def make_armature(name, src, s, extra):
    """New armature at the origin: the SWAT arm bones (metres) plus `extra` = [(name, parent, head)] (identity
    orientation: Y forward, Z up)."""
    data = bpy.data.armatures.new(name)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones
    src_scale = src.matrix_world.to_scale()[0]
    names = [b.name for b in src.data.bones if any(b.name == f'{a}.{sd}' for a in ARM_BONES for sd in 'LR')]
    for n in names:
        sb = src.data.bones[n]
        M = src.matrix_world @ sb.matrix_local
        loc = M.translation * s
        rot = M.to_3x3().normalized().to_quaternion()
        b = eb.new(n)
        b.head = (0, 0, 0)
        b.tail = (0, max(sb.length * src_scale * s, 0.012), 0)
        b.matrix = Matrix.LocRotScale(loc, rot, None)
    for n in names:
        p = src.data.bones[n].parent
        if p is not None and p.name in names:
            eb[n].parent = eb[p.name]
    for n, parent, head in extra:
        b = eb.new(n)
        b.head = Vector(head)
        b.tail = Vector(head) + Vector((0, 0.05, 0))
        b.roll = 0
        if parent:
            b.parent = eb[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    return obj


# ---------------------------------------------------------------------------------------------
# Weapon parts

def components(obj):
    """Loose parts of a mesh: list of (face indices, bbox min, bbox max, centroid)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    seen = set()
    out = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack = [f]
        seen.add(f.index)
        faces = []
        while stack:
            x = stack.pop()
            faces.append(x)
            for v in x.verts:
                for y in v.link_faces:
                    if y.index not in seen:
                        seen.add(y.index)
                        stack.append(y)
        pts = [v.co.copy() for x in faces for v in x.verts]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        out.append(([x.index for x in faces], lo, hi, sum(pts, Vector()) / len(pts)))
    bm.free()
    return out


def split_faces(obj, faces, name):
    """Moves the given faces of `obj` into a new object (same frame)."""
    faces = set(faces)
    part = bpy.data.objects.new(name, obj.data.copy())
    bpy.context.scene.collection.objects.link(part)
    for o, keep in ((obj, False), (part, True)):
        bm = bmesh.new()
        bm.from_mesh(o.data)
        dead = [f for f in bm.faces if (f.index in faces) != keep]
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        bm.to_mesh(o.data)
        bm.free()
        o.data.update()
    return part


def box_part(name, centre, size, colour, tilt=0.0):
    """A box mesh object (Blender axes), optionally tilted about X by `tilt` radians around its centre."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(tilt, 3, 'X'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=centre)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    set_corner_colours(obj, [colour] * len(me.polygons))
    return obj


def normalise_colours(obj):
    """Rewrites whatever colour attribute the importer made as the corner byte colour 'Col' (linear values)."""
    me = obj.data
    src = me.color_attributes.active_color or (me.color_attributes[0] if len(me.color_attributes) else None)
    cols = []
    for poly in me.polygons:
        if src is None:
            cols.append((1, 0, 1, 1))
        elif src.domain == 'CORNER':
            cols.append(tuple(src.data[poly.loop_indices[0]].color))
        else:
            cols.append(tuple(src.data[poly.vertices[0]].color))
    set_corner_colours(obj, cols)


def axis_of(points):
    """Unit axis from the centroid of the lowest third of `points` (by Z) to that of the highest third."""
    pts = sorted(points, key=lambda p: p.z)
    n = max(1, len(pts) // 3)
    lo = sum(pts[:n], Vector()) / n
    hi = sum(pts[-n:], Vector()) / n
    return (hi - lo).normalized(), lo, hi


def tilt_to(axis):
    """Rotation about X turning +Z onto `axis` (whose X component is ignored)."""
    return Matrix.Rotation(-math.atan2(axis.y, axis.z), 4, 'X')


def import_weapons():
    bpy.ops.import_scene.gltf(filepath=WEAPONS_GLB)
    objs = {o.name: o for o in bpy.data.objects if o.name in (
        'gun', 'gun_suppressor', 'gun_muzzle', 'gun_muzzle_bare', 'pistol', 'pistol_suppressor', 'pistol_muzzle',
        'pistol_muzzle_bare', 'knife') or o.name.startswith('gun_sight_')}
    bpy.context.view_layer.update()
    for o in objs.values():
        if o.type == 'MESH':
            normalise_colours(o)
    return objs


def weapon_parts(rig, w):
    """
    Splits the rig's weapon into its moving parts. Returns ({bone: [mesh objects]}, landmarks dict) in the weapon's
    frame (Blender: X right, Y forward = muzzle or blade tip, Z up, origin at the grip).
    """
    marks = {}
    if rig == 'rifle':
        gun = w['gun']
        comps = components(gun)
        mag = [c for c in comps if c[1].y >= 0.18 and c[2].y <= 0.36 and c[2].z <= 0.05 and c[1].z < -0.05]
        mag_obj = split_faces(gun, [i for c in mag for i in c[0]], 'mag')
        mpts = [v.co.copy() for v in mag_obj.data.vertices]
        ax, lo, hi = axis_of(mpts)
        marks['mag_centre'] = (lo + hi) / 2
        marks['mag_axis'] = ax
        marks['mag_bottom'] = lo
        # Grip axis from the grip's own vertices (below the receiver, behind the magazine).
        gp = [v.co.copy() for v in gun.data.vertices if v.co.z < -0.015 and v.co.y < 0.08]
        marks['grip_axis'] = axis_of(gp)[0]
        # A cocking knob at the front left of the receiver, where the support hand can reach it from the magazine.
        knob = box_part('bolt', (-0.036, 0.31, 0.15), (0.016, 0.022, 0.014), PART_COLOURS['knob'])
        marks['knob'] = Vector((-0.036, 0.31, 0.15))
        log('rifle: magazine', len(mag), 'parts, axis', tuple(round(c, 3) for c in ax), 'centre',
            tuple(round(c, 3) for c in marks['mag_centre']), 'grip axis', tuple(round(c, 3) for c in marks['grip_axis']))
        parts = {'weapon': [gun], 'mag': [mag_obj], 'bolt': [knob], 'sup': [w['gun_suppressor']]}
        # Optional sights (package M): one bone each, named after weapons.py's node (gun_sight_<id> -> sight_<id>).
        for name in sorted(n for n in w if n.startswith('gun_sight_')):
            parts[name[len('gun_'):]] = [w[name]]
        return parts, marks
    if rig == 'pistol':
        p = w['pistol']
        comps = components(p)
        slide = [c for c in comps if c[1].z >= 0.005]
        base = [c for c in comps if c[2].z <= -0.04]
        gp = [v.co.copy() for v in p.data.vertices if v.co.z < -0.005 and v.co.y < 0.03]
        gax = axis_of(gp)[0]
        marks['grip_axis'] = gax
        slide_obj = split_faces(p, [i for c in slide for i in c[0]], 'slide')
        base = [c for c in components(p) if c[2].z <= -0.04]     # face indices changed with the split
        base_obj = split_faces(p, [i for c in base for i in c[0]], 'mag')
        bpts = [v.co for v in base_obj.data.vertices]
        bc = Vector(((min(q.x for q in bpts) + max(q.x for q in bpts)) / 2, (min(q.y for q in bpts) + max(q.y for q in bpts)) / 2,
                     max(q.z for q in bpts)))
        # The magazine body: a box from the base plate up into the grip, along the grip's rake (hidden in the grip
        # when seated; seen while it drops out and goes back in).
        length = 0.078
        centre = bc + gax * (length / 2 - 0.002)
        body = box_part('magbody', centre, (0.017, 0.028, length), PART_COLOURS['magbody'], tilt=-math.atan2(gax.y, gax.z))
        join([base_obj, body])
        marks['mag_centre'] = bc + gax * (length / 2)
        marks['mag_axis'] = gax
        marks['mag_bottom'] = bc
        spts = [v.co for v in slide_obj.data.vertices]
        marks['slide_rear'] = Vector((0.0, min(q.y for q in spts) + 0.012, max(q.z for q in spts) - 0.006))
        marks['slide_centre'] = Vector((0.0, (min(q.y for q in spts) + max(q.y for q in spts)) / 2,
                                        (min(q.z for q in spts) + max(q.z for q in spts)) / 2))
        log('pistol: slide', len(slide), 'parts; base plate', len(base), 'parts; grip axis', tuple(round(c, 3) for c in gax))
        return {'weapon': [p], 'mag': [base_obj], 'slide': [slide_obj], 'sup': [w['pistol_suppressor']]}, marks
    return {'weapon': [w['knife']]}, marks


def join(objs):
    first = objs[0]
    if len(objs) == 1:
        return first
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = first
    with bpy.context.temp_override(active_object=first, selected_editable_objects=objs, selected_objects=objs):
        bpy.ops.object.join()
    return first


# ---------------------------------------------------------------------------------------------
# Posing

class Rig:
    def __init__(self, name, arm, marks, cam_to_rig):
        self.name = name
        self.arm = arm
        self.data = arm.data
        self.marks = marks
        self.cam_to_rig = cam_to_rig
        self.rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
        self.grip0 = {}
        self.palm0 = {}
        for side in 'RL':
            self.grip0[side], self.palm0[side] = rk.hand_grip_frame(self.data, side, GRIP_PALM_OFFSET, GRIP_ALONG_HAND)
        self.shoulder = {sd: cam_to_rig @ Vector(p) for sd, p in SHOULDERS[name].items()}
        self.pole = {sd: (cam_to_rig.to_3x3() @ Vector(p)).normalized() for sd, p in POLES.items()}
        self.max_reach = {'R': 0.0, 'L': 0.0}
        self.max_at = {'R': 0.0, 'L': 0.0}
        self.t = 0.0

    def cam(self, m):
        """A camera-space frame (Blender axes) in rig space."""
        return self.cam_to_rig @ m

    def pose(self, gun, parts, grips, curls, thumbs, shift=None):
        """
        Armature-space pose: weapon bone at `gun` (rig space), parts {bone: rig-space matrix with scale}, grips
        {side: target grip frame in rig space}, curls {side: finger curl table}, thumbs {side: thumb triple}.
        """
        mats = {n: m.copy() for n, m in self.rest.items()}
        mats['weapon'] = gun.copy()
        for n, m in parts.items():
            mats[n] = m.copy()
        for side in 'RL':
            self.pose_arm(mats, side, grips[side], curls[side], thumbs[side], (shift or {}).get(side))
        return mats

    def pose_arm(self, mats, side, grip, curl, thumb, shift=None):
        data = self.data
        names = [f'{a}.{side}' for a in ARM_BONES]
        # `shift`: the shoulder reaching forward (camera space), for a hand going further than the arm allows.
        sh = self.shoulder[side] + (self.cam_to_rig.to_3x3() @ Vector(shift) if shift else Vector())
        delta = Matrix.Translation(sh - self.rest[f'UpperArm.{side}'].translation)
        for n in names:
            mats[n] = delta @ self.rest[n]
        w0 = self.rest[f'Wrist.{side}']
        # The hand is scaled about the wrist; the grip point moves in with it, so aim the wrist at the scaled grip.
        wt = grip @ Matrix.Scale(HAND_SCALE, 4) @ self.grip0[side].inverted() @ w0
        reach = rk.solve_arm(data, mats, side, wt.translation, self.pole[side])
        if reach > self.max_reach[side]:
            self.max_reach[side], self.max_at[side] = reach, self.t
        mats[f'Wrist.{side}'] = wt
        rk.twist_forearm(data, mats, side, self.palm0[side], 0.8)
        for n in names[3:]:
            mats[n] = wt @ w0.inverted() @ self.rest[n]
        # Fingers curl toward the palm about the hand's pinky-to-index axis.
        r, f, u = (grip.col[i].to_3d().normalized() for i in range(3))
        axis = u if side == 'R' else -u
        for finger in FINGERS:
            chain = [f'{finger}{k}.{side}' for k in (2, 3, 4)]
            for i, b in enumerate(chain):
                rk.rotate_about(mats, chain[i:], mats[b].to_translation(), axis, math.radians(curl[finger][i]))
        tchain = [f'Thumb{k}.{side}' for k in (1, 2, 3)]
        opp, c2, c3 = thumb
        # Opposition: the thumb swings across the palm about the metacarpals' direction, then its joints curl.
        rk.rotate_about(mats, tchain, mats[tchain[0]].to_translation(), f if side == 'R' else -f, math.radians(opp))
        rk.rotate_about(mats, tchain[1:], mats[tchain[1]].to_translation(), axis, math.radians(c2))
        rk.rotate_about(mats, tchain[2:], mats[tchain[2]].to_translation(), axis, math.radians(c3))


def at(frame, m):
    return frame @ m


def clip(rig, name, seconds, fn):
    """Samples fn(t) -> pose at FPS over `seconds` and writes the action `name`."""
    n = max(1, int(round(seconds * FPS)))
    frames = []
    for i in range(n + 1):
        rig.t = min(seconds, i / FPS)
        frames.append((i, fn(rig.t)))
    act = rk.write_action(rig.arm, name, frames)
    log(rig.name, 'clip', name, 'frames', n + 1, 'seconds', round(n / FPS, 3))
    return act


def scaled(m, s):
    return m @ Matrix.Scale(s, 4)


HIDDEN = 0.001


def build_gun_clips(rig):
    mk = rig.marks
    rifle = rig.name == 'rifle'
    gax = mk['grip_axis']
    # Right hand on the pistol grip, raked like the grip; trigger finger along the guard.
    # A little low on the grip so the web of the hand sits under the slide or receiver.
    grip_r = Matrix.Translation(gax * -0.014) @ tilt_to(gax)
    max_ = mk['mag_axis']
    mag_rest = Matrix.Translation(mk['mag_centre'])
    rest_parts = {'mag': mag_rest.copy(), 'sup': Matrix.Translation(rig.rest['sup'].translation)}
    # Sights ride on the gun like the suppressor (the client scales away the ones not mounted).
    sight_bones = [b for b in rig.rest if b.startswith('sight_')]
    for b in sight_bones:
        rest_parts[b] = Matrix.Translation(rig.rest[b].translation)
    moving = 'bolt' if rifle else 'slide'
    rest_parts[moving] = Matrix.Translation(rig.rest[moving].translation)

    if rifle:
        # Left hand wraps the magazine like a vertical foregrip, palm on its left side.
        support = Matrix.Translation(mk['mag_centre'] + Vector((-0.004, 0.0, -0.005))) @ tilt_to(max_)
        mag_grip = support.copy()
        # Pulling the bolt: pinching the knob from the left, fingers forward.
        knob = mk['knob']
        bolt_grip = Matrix.Translation(knob + Vector((-0.012, 0.0, -0.012))) @ Matrix.Rotation(math.radians(15), 4, "X")
        support_curl, support_thumb = WRAP_CURL, THUMB_GRIP
    else:
        # Support hand wrapped over the right hand's fingers on the grip's left side.
        support = Matrix.Translation(Vector((-0.03, 0.012, -0.022))) @ tilt_to(gax) @ Matrix.Rotation(math.radians(-12), 4, 'Y')
        # Holding the new magazine by its base, palm up.
        mag_grip = Matrix.Translation(mk['mag_bottom'] + Vector((0, 0, -0.03))) @ rk.frame_from(
            Vector((0, 0, 1)), Vector((0, 1, 0)), Vector((-1, 0, 0)), Vector())
        rear = mk['slide_rear']
        bolt_grip = Matrix.Translation(rear + Vector((0.0, 0.0, 0.035))) @ rk.frame_from(
            Vector((0, 0, -1)), Vector((1, 0, 0)), Vector((0, -1, 0)), Vector())
        support_curl, support_thumb = WRAP_CURL, THUMB_GRIP
    hand_to_mag = mag_grip.inverted() @ mag_rest

    def gun_at(t, keys):
        return rk.offset_frame(*rk.keyed(keys, t))

    def idle(t):
        return rig.pose(Matrix(), rest_parts, {'R': grip_r, 'L': support},
                        {'R': TRIGGER_CURL, 'L': support_curl}, {'R': THUMB_GRIP, 'L': support_thumb})

    clip(rig, f'{rig.name}_idle', 1 / FPS, idle)

    if rifle:
        # Brought in toward the middle of the view, muzzle up, canted so the magazine well faces the left hand.
        G1 = (-0.11, -0.05, 0.03, 6, 8, 35)
        G1b = (-0.11, -0.05, 0.038, 9, 8, 35)             # magazine seated: a small jolt up
        G1c = (-0.115, -0.06, 0.03, 4, 10, 31)            # bolt pulled: the gun rocks back
        gun_keys = [(0.0, (0, 0, 0, 0, 0, 0)), (0.25, G1), (1.36, G1), (1.42, G1b), (1.55, G1), (1.9, G1),
                    (1.97, G1c), (2.07, G1c), (2.1, G1), (2.2, (0, 0, 0, 0, 0, 0))]
        belt = rig.cam(Matrix.Translation(Vector((-0.1, 0.3, -0.75))) @ Matrix.Rotation(math.radians(-30), 4, 'X'))
        bolt_keys = [(0.0, (0.0,)), (1.9, (0.0,)), (1.97, (-0.06,)), (2.07, (-0.06,)), (2.1, (0.0,))]

        def gunm(t):
            return gun_at(t, gun_keys)

        def bolt_off(t):
            return rk.keyed(bolt_keys, t)[0]

        def on_gun(m, extra=None):
            return lambda t: gunm(t) @ (extra(t) if extra else Matrix()) @ m

        down = lambda d: (lambda t: Matrix.Translation(-max_ * d))
        left_keys = [
            (0.0, on_gun(support)), (0.2, on_gun(support)), (0.3, on_gun(mag_grip)),
            (0.55, on_gun(mag_grip, down(0.24))), (0.75, belt), (1.0, belt),
            (1.25, on_gun(mag_grip, down(0.09))), (1.4, on_gun(mag_grip)), (1.5, on_gun(mag_grip)),
            (1.8, on_gun(bolt_grip)), (1.9, on_gun(bolt_grip)),
            (1.97, lambda t: gunm(t) @ Matrix.Translation(Vector((0, bolt_off(t), 0))) @ bolt_grip),
            (2.07, lambda t: gunm(t) @ Matrix.Translation(Vector((0, -0.06, 0))) @ bolt_grip),
            (2.2, on_gun(support))]

        def reload(t):
            gun = gunm(t)
            left = rk.keyed(left_keys, t)
            parts = {'sup': gun @ rest_parts['sup'],
                     'bolt': gun @ Matrix.Translation(Vector((0, bolt_off(t), 0))) @ rest_parts['bolt']}
            for b in sight_bones:
                parts[b] = gun @ rest_parts[b]
            if t < 0.3 or t >= 1.4:
                parts['mag'] = gun @ mag_rest
            elif 0.62 <= t < 0.85:
                parts['mag'] = scaled(left @ hand_to_mag, HIDDEN)
            else:
                parts['mag'] = left @ hand_to_mag
            # The left shoulder reaches forward and up for the cocking knob.
            sw = rk.keyed([(0.0, (0.0,)), (1.55, (0.0,)), (1.8, (1.0,)), (2.07, (1.0,)), (2.2, (0.0,))], t)[0]
            shift = {'L': (0.05 * sw, 0.06 * sw, 0.07 * sw)}
            holding = 0.28 <= t < 1.45
            lc = WRAP_CURL if holding else (PINCH_CURL if 1.75 <= t < 2.12 else (RELAX_CURL if 0.2 <= t < 0.28 else support_curl))
            return rig.pose(gun, parts, {'R': gun @ grip_r, 'L': left}, {'R': TRIGGER_CURL, 'L': lc},
                            {'R': THUMB_GRIP, 'L': THUMB_GRIP}, shift)

        clip(rig, f'{rig.name}_reload', 2.2, reload)
    else:
        P1 = (-0.03, -0.01, 0.035, 14, 12, 34)
        P1b = (-0.03, -0.01, 0.043, 17, 12, 34)
        P1c = (-0.03, 0.005, 0.035, 12, 12, 34)        # slide released: the gun kicks forward a touch
        P2 = (-0.14, 0.04, -0.03, 6, 30, 10)           # racking: pushed out and turned in, under the left hand
        P2c = (-0.14, 0.055, -0.03, 4, 30, 10)
        gun_keys = [(0.0, (0, 0, 0, 0, 0, 0)), (0.12, P1), (0.66, P1), (0.71, P1b), (0.78, P1), (0.95, P2), (1.17, P2),
                    (1.19, P2c), (1.25, P2), (1.4, (0, 0, 0, 0, 0, 0))]
        belt = rig.cam(Matrix.Translation(Vector((-0.08, 0.25, -0.62))) @ Matrix.Rotation(math.radians(-20), 4, 'X'))
        slide_keys = [(0.0, (0.0,)), (1.0, (0.0,)), (1.07, (-0.035,)), (1.17, (-0.035,)), (1.19, (0.0,))]

        def gunm(t):
            return gun_at(t, gun_keys)

        def slide_off(t):
            return rk.keyed(slide_keys, t)[0]

        def on_gun(m, extra=None):
            return lambda t: gunm(t) @ (extra(t) if extra else Matrix()) @ m

        away = Matrix.Translation(Vector((-0.06, -0.03, -0.09))) @ support
        down = lambda d: (lambda t: Matrix.Translation(-max_ * d))
        left_keys = [
            (0.0, on_gun(support)), (0.1, on_gun(away)), (0.35, belt), (0.45, belt),
            (0.62, on_gun(mag_grip, down(0.07))), (0.7, on_gun(mag_grip)), (0.76, on_gun(mag_grip)),
            (0.95, on_gun(bolt_grip)), (1.0, on_gun(bolt_grip)),
            (1.07, lambda t: gunm(t) @ Matrix.Translation(Vector((0, slide_off(t), 0))) @ bolt_grip),
            (1.17, lambda t: gunm(t) @ Matrix.Translation(Vector((0, -0.035, 0))) @ bolt_grip),
            (1.4, on_gun(support))]
        g = 9.81

        def reload(t):
            gun = gunm(t)
            left = rk.keyed(left_keys, t)
            parts = {'sup': gun @ rest_parts['sup'],
                     'slide': gun @ Matrix.Translation(Vector((0, slide_off(t), 0))) @ rest_parts['slide']}
            if t < 0.15 or t >= 0.7:
                parts['mag'] = gun @ mag_rest
            elif t < 0.38:
                fall = 0.5 * g * (t - 0.15) ** 2 + 0.25 * (t - 0.15)
                parts['mag'] = gun @ Matrix.Translation(-max_ * fall) @ mag_rest
            elif t < 0.45:
                parts['mag'] = scaled(gun @ Matrix.Translation(-max_ * 0.4) @ mag_rest, HIDDEN)
            else:
                parts['mag'] = left @ hand_to_mag
            sw = rk.keyed([(0.0, (0.0,)), (0.78, (0.0,)), (0.95, (1.0,)), (1.2, (1.0,)), (1.4, (0.0,))], t)[0]
            shift = {'L': (0.0, 0.07 * sw, 0.03 * sw)}
            lc = support_curl if (t < 0.08 or t >= 1.3) else (PINCH_CURL if 0.9 <= t < 1.22 else
                                                               (WRAP_CURL if 0.4 <= t < 0.76 else RELAX_CURL))
            return rig.pose(gun, parts, {'R': gun @ grip_r, 'L': left}, {'R': TRIGGER_CURL, 'L': lc},
                            {'R': THUMB_GRIP, 'L': THUMB_GRIP if 0.4 <= t < 1.22 or t >= 1.3 else THUMB_RELAX}, shift)

        clip(rig, f'{rig.name}_reload', 1.4, reload)


def knife_frame(pos, blade, spine):
    """Knife frame in camera space (Blender axes): origin at the handle's middle, Y along the blade, Z = spine."""
    y = Vector(blade).normalized()
    z = Vector(spine)
    z = (z - y * z.dot(y)).normalized()
    return rk.frame_from(y.cross(z), y, z, Vector(pos))


def knife_grip(k):
    """Right-hand grip frame for a knife frame (characters.py socket_knife): the handle runs pinky to index, the
    blade out of the index side, the spine toward the wrist."""
    x, y, z = (k.col[i].to_3d() for i in range(3))
    up, fwd = y, -z
    return rk.frame_from(fwd.cross(up), fwd, up, k.translation)


def build_knife_clips(rig):
    REST = knife_frame((0.17, 0.36, -0.16), (-0.18, 0.8, 0.55), (0.0, -0.55, 0.8))
    BACK = knife_frame((0.27, 0.38, -0.09), (-0.25, -0.1, 1.0), (0.4, -0.9, 0.0))
    SLASH = knife_frame((0.0, 0.36, -0.24), (-1.0, 0.45, -0.15), (-0.1, 0.2, 1.0))
    guard = rig.cam(Matrix.Translation(Vector((-0.24, 0.28, -0.46))) @ Matrix.Rotation(math.radians(-60), 4, 'X'))
    keys = [(0.0, lambda t: REST), (0.2, lambda t: BACK), (0.32, lambda t: SLASH), (0.52, lambda t: REST)]
    # Windup eases out (slows into the top), the slash eases in (fast at the end), the recovery is smooth.
    eases = [lambda x: 1 - (1 - x) * (1 - x), lambda x: x * x, rk.smooth]

    def frame_at(t):
        for i in range(len(keys) - 1):
            t0, a = keys[i]
            t1, b = keys[i + 1]
            if t <= t1:
                return rk.lerp_frame(a(t), b(t), eases[i](min(1.0, max(0.0, (t - t0) / (t1 - t0)))))
        return REST

    def pose_at(k):
        return rig.pose(k, {}, {'R': knife_grip(k), 'L': guard}, {'R': GRIP_CURL, 'L': RELAX_CURL},
                        {'R': THUMB_GRIP, 'L': THUMB_RELAX})

    clip(rig, 'knife_idle', 1 / FPS, lambda t: pose_at(REST))
    clip(rig, 'knife_swing', 0.52, lambda t: pose_at(frame_at(t)))


# ---------------------------------------------------------------------------------------------

def skin(obj, arm, groups=None):
    if groups:
        for gname in groups:
            g = obj.vertex_groups.new(name=gname)
            g.add(list(range(len(obj.data.vertices))), 1.0, 'REPLACE')
    obj.parent = arm
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm


def build(rig_name, swat):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    weapons = import_weapons()
    parts, marks = weapon_parts(rig_name, weapons)
    palettes = ['defender', 'ghost'] if rig_name == 'knife' else ['defender']
    arms = []
    src = s = None
    for pal in palettes:
        before = set(bpy.data.objects)
        src, s, a = import_swat(swat, pal)
        arms.append((pal, a))
        for o in set(bpy.data.objects) - before:
            if o is not a and o is not src:
                bpy.data.objects.remove(o)
        if pal != palettes[-1]:
            bpy.data.objects.remove(src)

    extra = [('weapon', None, (0, 0, 0))]
    for bone in parts:
        if bone == 'weapon':
            continue
        pts = [o.matrix_world @ v.co for o in parts[bone] for v in o.data.vertices]
        c = sum(pts, Vector()) / len(pts)
        if bone == 'mag' and 'mag_centre' in marks:
            c = marks['mag_centre']
        extra.append((bone, 'weapon', tuple(c)))
    arm = make_armature(f'vm_{rig_name}', src, s, extra)
    # The SWAT source is no longer needed (nor its 24 clips).
    bpy.data.objects.remove(src)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)

    # One mesh per palette: arms plus every weapon part, each part bound rigidly to its bone.
    meshes = []
    for i, (pal, a) in enumerate(arms):
        objs = [a]
        for bone, olist in parts.items():
            for o in olist:
                c = o.copy() if i < len(arms) - 1 else o
                if c is not o:
                    c.data = o.data.copy()
                    scene.collection.objects.link(c)
                c.parent = None
                c.matrix_world = Matrix()
                for vg in list(c.vertex_groups):
                    c.vertex_groups.remove(vg)
                g = c.vertex_groups.new(name=bone)
                g.add(list(range(len(c.data.vertices))), 1.0, 'REPLACE')
                objs.append(c)
        m = join(objs)
        name = 'vm_ghost' if pal == 'ghost' else f'vm_{rig_name}'
        m.name = name
        m.data.name = name
        m.data.set_sharp_from_angle(angle=math.radians(45))
        skin(m, arm)
        meshes.append(m)
        log(name, 'tris', tris(m.data), 'verts', len(m.data.vertices))

    mat = bpy.data.materials.new('viewmodel')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    ca = nt.nodes.new('ShaderNodeVertexColor')
    ca.layer_name = 'Col'
    nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.6
    for m in meshes:
        m.data.materials.clear()
        m.data.materials.append(mat)
        with bpy.context.temp_override(object=m, active_object=m):
            bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
            bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)

    # Muzzle points under the weapon bone (guns).
    empties = []
    prefix = {'rifle': 'gun', 'pistol': 'pistol'}.get(rig_name)
    if prefix:
        for src_name, name in ((f'{prefix}_muzzle', 'muzzle'), (f'{prefix}_muzzle_bare', 'muzzle_bare')):
            loc = weapons[src_name].matrix_world.translation.copy()
            e = bpy.data.objects.new(name, None)
            scene.collection.objects.link(e)
            e.parent = arm
            e.parent_type = 'BONE'
            e.parent_bone = 'weapon'
            bpy.context.view_layer.update()
            e.matrix_world = Matrix.Translation(loc)
            empties.append(e)
    for o in list(bpy.data.objects):
        if o not in meshes and o not in empties and o is not arm:
            bpy.data.objects.remove(o)

    if rig_name == 'knife':
        cam_to_rig = Matrix()
    else:
        pos, eul = HIP[rig_name]
        cam_to_rig = rk.pc_pose(pos, eul).inverted()
    rig = Rig(rig_name, arm, marks, cam_to_rig)
    if rig_name == 'knife':
        build_knife_clips(rig)
    else:
        build_gun_clips(rig)
    log(rig_name, 'reach (fraction of arm length) right', round(rig.max_reach['R'], 3), 'at', round(rig.max_at['R'], 2),
        's; left', round(rig.max_reach['L'], 3), 'at', round(rig.max_at['L'], 2), 's')
    if rig.max_reach['R'] > 0.995 or rig.max_reach['L'] > 0.995:
        log('WARNING a hand target is out of reach: the arm is straight and the hand floats')

    rk.set_action(arm, next(a for a in bpy.data.actions if a.name.endswith('_idle')))
    scene.frame_set(0)
    for o in bpy.data.objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    out = os.path.join(OUT_DIR, f'viewmodel_{rig_name}.glb')
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=True, export_yup=True, export_texcoords=False,
        export_normals=True, export_tangents=False, export_vertex_color='ACTIVE', export_all_vertex_colors=False,
        export_materials='EXPORT', export_skins=True, export_all_influences=False, export_def_bones=False,
        export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
        export_optimize_animation_size=True, export_anim_slide_to_zero=False, export_morph=False,
        export_extras=False, export_cameras=False, export_lights=False)
    log('wrote', out, os.path.getsize(out), 'bytes')


def main():
    swat = args()
    log('SWAT source', swat)
    only = None
    if '--' in sys.argv:
        rest = sys.argv[sys.argv.index('--') + 1:]
        if '--rig' in rest:
            only = rest[rest.index('--rig') + 1]
    for name in ('rifle', 'pistol', 'knife'):
        if only and name != only:
            continue
        build(name, swat)


main()
