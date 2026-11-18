"""
The downloaded animation pack's gloved hands on our first-person rigs (package R, second part; the owner asked to try
them). Source: the pack's `Hand_Mesh` (two primitives: `Hand_D`, the skin: forearms and the fingertips the fingerless
glove leaves bare; `Glove_D`, the glove) in tools/blender/source-art/realistic/fp-anims/m4_animations_gltf.zip, read as
data by fpanims.py (Fab Standard License; its textures now ship inside our gun atlases, credited in
client/public/models/CREDITS.md).

How it is put on our rigs (viewmodel.py):
  - `fit_bones(arm)`: our skeleton keeps its arms; its hand bones (fingers and thumb) are moved to the pack's hand
    skeleton (its bind pose), carried onto our wrist by a rigid fit of the two hands' frames (wrist, knuckles, the line
    across the knuckles; the pack's size kept, it is real-size in centimetres). So the grips, finger curls and clips,
    which all read the bones, follow the new hands by themselves.
  - `hands_mesh(fits, look)`: the pack's mesh moved by the same fit, its skin weights renamed onto our bones (Hand ->
    Wrist, finger joints 1-3 -> our 2-4, its forearm -> our wrist-end twist bone); its bare forearm skin is cut away
    above the glove's cuff (a sleeve covers it).
  - `sleeve(arm, side, fits, ...)`: defenders only: a tube from just below the glove's cuff to past the elbow, its
    texture the rolled shirt's orange fabric, skinned along the forearm's twist bones. Ghosts keep their suit forearm
    (cut at the wrist, soldier.py) and its own cuff.
  - Atlas regions `glove` (the glove's maps recoloured coyote; a ghost's glove is tinted near-black by its vertex
    colour) and `handskin` (the skin map cropped to the fingertips), in every gun's atlas (realistic.ARM_LAYOUTS).
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import fpanims
import realistic as rl

FINGERS = ('Index', 'Middle', 'Ring', 'Pinky')
SIDES = {'L': 'Left', 'R': 'Right'}
# The pack's skin above the glove's cuff is cut from this far below the cuff's top (cm, pack bind space).
SKIN_CUT_BELOW_CUFF = 1.0
# The defender's sleeve starts this far below the glove cuff's top (cm, pack space; it covers the cuff's upper edge)
# and stands this far off the glove (m).
SLEEVE_OVER_CUFF = 1.6
SLEEVE_CLEAR = 0.005
# The part of the sleeve region's fabric crop the tube samples (u0, v0, u1, v1, fractions of the crop).
SLEEVE_PATCH = (0.40, 0.40, 0.58, 0.58)
# Sleeve radii at the elbow relative to the wrist end, rings along it and segments round it.
SLEEVE_ELBOW_GROW = 1.65
SLEEVE_RINGS = 10
SLEEVE_SEGMENTS = 18
# The pack's hands are drawn at this size. As authored they are about 1.4 times our soldier's (12.7 cm from wrist to
# knuckles against 9.0, a cuff about 10 cm across), so they are scaled to our hand's length: the grips, the guns and the
# third-person characters were all sized for it.
PACK_HAND_SCALE = float(os.environ.get('SB_PACK_HAND_SCALE', '0.71'))
# Team looks: the glove's colour in the atlas (its texture's light and dark kept), and the vertex tints.
COYOTE = (0.50, 0.40, 0.27)
GHOST_GLOVE_TINT = (0.16, 0.16, 0.17, 0.0)
GHOST_SKIN_TINT = (0.45, 0.42, 0.40, 0.0)
GHOST_SLEEVE_TINT = (0.11, 0.11, 0.13, 0.0)


def log(*a):
    print('[packhands]', *a, flush=True)


def available():
    return os.path.exists(fpanims.ZIP) and os.environ.get('SB_PACK_HANDS', '1') != '0'


# ---------------------------------------------------------------------------------------------
# The pack's mesh and skeleton, in its bind space (centimetres, as stored)

class Source:
    def __init__(self):
        p = self.p = fpanims.Pack()
        g = p.g
        self.prims = []
        self.bind = {}
        bind_m = {}
        for mesh_i, mesh in enumerate(g['meshes'][:2]):
            prim = mesh['primitives'][0]
            skin = g['skins'][mesh_i]
            names = [p.nodes[k]['name'].rsplit('_', 1)[0] for k in skin['joints']]
            ibm = p._read(skin['inverseBindMatrices'])
            for k, n in enumerate(names):
                m = Matrix([[ibm[k][c * 4 + r] for c in range(4)] for r in range(4)]).inverted()
                bind_m[n] = m
                self.bind[n] = m.translation.copy()
            self.prims.append({
                'material': g['materials'][prim['material']]['name'],
                'pos': [Vector(v) for v in p._read(prim['attributes']['POSITION'])],
                'nrm': [Vector(v) for v in p._read(prim['attributes']['NORMAL'])],
                'uv': [(u, 1.0 - v) for u, v in p._read(prim['attributes']['TEXCOORD_0'])],
                'joints': [[names[j] for j in js] for js in p._read(prim['attributes']['JOINTS_0'])],
                'weights': p._read(prim['attributes']['WEIGHTS_0']),
                'tris': p._read(prim['indices']),
            })
        # The fingertip end joints carry no skin, so they are not in the skins: place them from their parent's bind
        # matrix and their own rest offset.
        for i, node in enumerate(p.nodes):
            n = node.get('name', '').rsplit('_', 1)[0]
            par = p.parent.get(i)
            if n in self.bind or par is None:
                continue
            pn = p.nodes[par].get('name', '').rsplit('_', 1)[0]
            if pn in bind_m and 'Hand' in n:
                self.bind[n] = (bind_m[pn] @ Vector(node.get('translation', (0, 0, 0)))).copy()
        self.folder = os.path.dirname(next(
            os.path.join(d, 'scene.gltf') for d, _, f in os.walk(fpanims._extract()) if 'scene.gltf' in f))
        # Per side: the forearm's axis (wrist to elbow) and the glove cuff's top (cm up the forearm from the wrist).
        self.cuff = {}
        for sd, nm in SIDES.items():
            w = self.bind[f'{nm}Hand']
            up = (self.bind[f'{nm}ForeArm'] - w).normalized()
            g = self.prims[1]
            top = max((v - w).dot(up) for v, js in zip(g['pos'], g['joints']) if js[0].startswith(nm))
            self.cuff[sd] = (w, up, top)

    def side_of(self, joints, weights):
        k = max(range(4), key=lambda i: weights[i])
        return 'L' if joints[k].startswith('Left') else 'R'

    def up_dist(self, sd, v):
        w, up, _ = self.cuff[sd]
        return (v - w).dot(up)

    def kept_faces(self, prim):
        """Faces of a primitive left after the bare forearm is cut (the skin above the glove's cuff)."""
        out = []
        tris = prim['tris']
        for i in range(0, len(tris), 3):
            a, b, c = tris[i:i + 3]
            if prim['material'] == 'Hand_D':
                sd = self.side_of(prim['joints'][a], prim['weights'][a])
                top = self.cuff[sd][2] - SKIN_CUT_BELOW_CUFF
                if all(self.up_dist(sd, prim['pos'][k]) > top for k in (a, b, c)):
                    continue
            out.append((a, b, c))
        return out

    def skin_crop(self):
        """The part of the skin map the kept skin (fingertips, the wrist under the cuff) uses (u0, v0, u1, v1)."""
        prim = self.prims[0]
        us, vs = [], []
        for f in self.kept_faces(prim):
            for k in f:
                us.append(prim['uv'][k][0])
                vs.append(prim['uv'][k][1])
        return (max(0.0, min(us) - 0.01), max(0.0, min(vs) - 0.01), min(1.0, max(us) + 0.01), min(1.0, max(vs) + 0.01))

    def maps(self, stem):
        def img(suffix):
            for d, _, files in os.walk(self.folder):
                for f in files:
                    if f.startswith(stem + suffix):
                        return rl.load_image(os.path.join(d, f))
            raise FileNotFoundError(stem + suffix)
        orm = img('_ORM')
        # No metalness: the pack's materials set metallicFactor 0 (their ORM's blue channel is not used and reads 1).
        return {'base': (img('_BaseColor'), None), 'ao': (orm, 0), 'rough': (orm, 1), 'normal': (img('_Normal'), None)}


_SOURCE = None


def source():
    global _SOURCE
    if _SOURCE is None:
        _SOURCE = Source()
    return _SOURCE


def byte_colours(me):
    """The colours as the one corner byte attribute 'Col' the rest of a rig uses (RGB tint, A = emission): joined
    meshes keep only attributes of the same name, type and domain, and the exporter writes the active one."""
    src = me.color_attributes['Col']
    vals = np.zeros(len(src.data) * 4, np.float32)
    src.data.foreach_get('color', vals)
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    attr.data.foreach_set('color', vals)
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find('Col')


def hand_frame(wrist, knuckles, across):
    """Rigid frame of a hand: origin at the wrist, Y along the hand, Z across the knuckles (pinky to index)."""
    fingers = (knuckles - wrist).normalized()
    up = (across - fingers * across.dot(fingers)).normalized()
    right = fingers.cross(up)
    m = Matrix((right, fingers, up)).transposed().to_4x4()
    m.translation = wrist
    return m


# ---------------------------------------------------------------------------------------------
# Atlas regions (weapons.py writes them; viewmodel.py maps UVs into them)

def coyote(rgb, s):
    lum = rgb[..., 0] * 0.3 + rgb[..., 1] * 0.55 + rgb[..., 2] * 0.15
    k = lum / max(float(lum.mean()), 1e-3)
    for c in range(3):
        rgb[..., c] = np.clip(k * COYOTE[c], 0, 1)
    s[...] = np.minimum(s, 0.12)


def matte(rgb, s):
    s[...] = np.minimum(s, 0.1)


def crops():
    return {'glove': None, 'handskin': source().skin_crop()}


def regions(rects):
    """Atlas regions for the glove and the fingertip skin (`rects` from realistic.ARM_LAYOUTS)."""
    src = source()
    out = []
    if 'glove' in rects:
        out.append(rl.Region('glove', rects['glove'], src.maps('Glove_D'), post=coyote))
    if 'handskin' in rects:
        out.append(rl.Region('handskin', rects['handskin'], src.maps('Hand_D'), crop=src.skin_crop(), post=matte))
    return out


# ---------------------------------------------------------------------------------------------
# Our skeleton's hands moved to the pack's

def _our_hand(eb, sd):
    w = eb[f'Wrist.{sd}'].head.copy()
    kn = sum((eb[f'{f}2.{sd}'].head for f in FINGERS), Vector()) / 4
    across = eb[f'Index2.{sd}'].head - eb[f'Pinky2.{sd}'].head
    return w, kn, across


def fit_bones(arm):
    """Moves our finger and thumb bones to the pack's hand skeleton (rigidly fitted onto our wrist); returns
    {side: 4x4 from the pack's bind space (cm) to our armature space (m)}."""
    src = source()
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    fits = {}
    for sd, nm in SIDES.items():
        b = src.bind
        pk = sum((b[f'{nm}Hand{f}1'] for f in FINGERS), Vector()) / 4
        fp = hand_frame(b[f'{nm}Hand'], pk, b[f'{nm}HandIndex1'] - b[f'{nm}HandPinky1'])
        w, kn, across = _our_hand(eb, sd)
        fo = hand_frame(w, kn, across)
        fit = fo @ Matrix.Scale(0.01 * PACK_HAND_SCALE, 4) @ fp.inverted()
        fits[sd] = fit
        log(sd, 'hand length (wrist to knuckles): ours', round((kn - w).length, 3), 'm, pack',
            round((pk - b[f'{nm}Hand']).length / 100, 3), 'm')
        chains = [(f, [f'{nm}Hand{f}{k}' for k in (1, 2, 3, 4)], [f'{f}{k}.{sd}' for k in (2, 3, 4)]) for f in FINGERS]
        chains.append(('Thumb', [f'{nm}HandThumb{k}' for k in (1, 2, 3, 4)], [f'Thumb{k}.{sd}' for k in (1, 2, 3)]))
        for _, pj, ours in chains:
            for n in ours:
                eb[n].use_connect = False
            for i, n in enumerate(ours):
                eb[n].head = fit @ b[pj[i]]
                eb[n].tail = fit @ b[pj[i + 1]]
    bpy.ops.object.mode_set(mode='OBJECT')
    return fits


# ---------------------------------------------------------------------------------------------
# The pack's mesh on our bones

def _our_bone(name):
    side = 'L' if name.startswith('Left') else 'R'
    part = name[len(SIDES[side]):]
    if part == 'ForeArm':
        return f'ForeTwist2.{side}'
    if part == 'Hand':
        return f'Wrist.{side}'
    if part.startswith('HandThumb'):
        return f'Thumb{min(3, int(part[-1]))}.{side}'
    for f in FINGERS:
        if part.startswith(f'Hand{f}'):
            return f'{f}{min(4, int(part[-1]) + 1)}.{side}'
    return None


def hands_mesh(fits, look):
    """Both gloved hands as one object on our bones, UVs in the pack's own maps (materials 'Glove_D', 'Hand_D'), vertex
    colours for `look`."""
    src = source()
    bm = bmesh.new()
    deform = bm.verts.layers.deform.verify()
    uvl = bm.loops.layers.uv.verify()
    col = bm.loops.layers.color.new('Col')
    me = bpy.data.meshes.new(f'hands_{look}')
    obj = bpy.data.objects.new(f'hands_{look}', me)
    bpy.context.scene.collection.objects.link(obj)
    groups = {}
    for mi, prim in enumerate(src.prims):
        mat = bpy.data.materials.get(prim['material']) or bpy.data.materials.new(prim['material'])
        me.materials.append(mat)
        verts = {}
        faces = src.kept_faces(prim)
        used = sorted({k for f in faces for k in f})
        for k in used:
            sd = src.side_of(prim['joints'][k], prim['weights'][k])
            v = bm.verts.new(fits[sd] @ prim['pos'][k])
            v.normal = (fits[sd].to_3x3() @ prim['nrm'][k]).normalized()
            acc = {}
            for jn, wt in zip(prim['joints'][k], prim['weights'][k]):
                if wt <= 0:
                    continue
                ob = _our_bone(jn)
                if ob:
                    acc[ob] = acc.get(ob, 0.0) + wt
            tot = sum(acc.values()) or 1.0
            for ob, wt in acc.items():
                if ob not in groups:
                    groups[ob] = obj.vertex_groups.new(name=ob).index
                v[deform][groups[ob]] = wt / tot
            verts[k] = v
        if prim['material'] == 'Glove_D':
            tint = GHOST_GLOVE_TINT if look == 'ghost' else (1.0, 1.0, 1.0, 0.0)
        else:
            tint = GHOST_SKIN_TINT if look == 'ghost' else (1.0, 1.0, 1.0, 0.0)
        for a, b, c in faces:
            try:
                f = bm.faces.new((verts[a], verts[b], verts[c]))
            except ValueError:
                continue
            f.material_index = mi
            f.smooth = True
            for lp, k in zip(f.loops, (a, b, c)):
                lp[uvl].uv = prim['uv'][k]
                lp[col] = tint
    bm.to_mesh(me)
    bm.free()
    byte_colours(me)
    log(look, 'hands tris', len(me.polygons))
    return obj


def sleeve(arm, hands, look, crop):
    """The defender's sleeve: per arm a tube from just below the glove's cuff to past the elbow, UVs into the shirt
    fabric of the 'sleeve' region (`crop`: the part of the shirt map that region holds, u0 v0 u1 v1)."""
    c0, e0, c1, e1 = crop or (0.0, 0.0, 1.0, 1.0)
    # Only a small plain patch of that fabric (the whole crop holds the rolled cuff's seams and dark folds, which
    # streaked along the tube).
    pu0, pv0, pu1, pv1 = SLEEVE_PATCH
    c0, c1 = c0 + (c1 - c0) * pu0, c0 + (c1 - c0) * pu1
    e0, e1 = e0 + (e1 - e0) * pv0, e0 + (e1 - e0) * pv1
    src = source()
    data = arm.data
    me = bpy.data.meshes.new('sleeve')
    obj = bpy.data.objects.new('sleeve', me)
    bpy.context.scene.collection.objects.link(obj)
    bm = bmesh.new()
    deform = bm.verts.layers.deform.verify()
    uvl = bm.loops.layers.uv.verify()
    col = bm.loops.layers.color.new('Col')
    gidx = {}
    # The cuff: vertices mostly on the forearm end (wrist and wrist-end twist bones), not the palm or thumb.
    glove_pts = {sd: [] for sd in 'LR'}
    gm = hands.data
    gname = {g.index: g.name for g in hands.vertex_groups}
    for v in gm.vertices:
        if not v.groups:
            continue
        top = max(v.groups, key=lambda g: g.weight)
        n = gname[top.group]
        if n.startswith('ForeTwist2'):
            glove_pts[n[-1]].append(v.co.copy())
    for sd in 'LR':
        E = data.bones[f'LowerArm.{sd}'].head_local
        w0 = data.bones[f'Wrist.{sd}'].head_local
        a0 = (E - w0).normalized()
        w_p, up_p, top_p = src.cuff[sd]
        # The glove's cuff band (its forearm-end vertices from just below the cuff's top up): the sleeve's wrist end is
        # centred on it and the sleeve runs from there to past our elbow, so it sits on the glove whatever the angle
        # between the pack's hand and its forearm.
        top = top_p * PACK_HAND_SCALE / 100.0
        band = [p for p in glove_pts[sd] if (p - w0).dot(a0) > top - SLEEVE_OVER_CUFF / 100.0 - 0.01] or glove_pts[sd]
        W = sum(band, Vector()) / len(band)
        A = (E - W).normalized()
        d0 = 0.0
        d1 = (E - W).length + 0.03
        across = data.bones[f'Index2.{sd}'].head_local - data.bones[f'Pinky2.{sd}'].head_local
        X = (across - A * across.dot(A)).normalized()
        Y = A.cross(X)
        ex = sorted(abs((p - W).dot(X)) for p in band)
        ey = sorted(abs((p - W).dot(Y)) for p in band)
        rx = ex[int(0.95 * (len(ex) - 1))] + SLEEVE_CLEAR
        ry = ey[int(0.95 * (len(ey) - 1))] + SLEEVE_CLEAR
        log(sd, 'sleeve over', len(band), 'cuff vertices, length', round(d1, 3), 'm; wrist radii', round(rx, 3), round(ry, 3))
        rings = []
        # A short hem turned inward at the wrist end hides the tube's open end.
        stations = [(d0 + 0.004, 0.86)] + [(d0 + (d1 - d0) * i / (SLEEVE_RINGS - 1), 1.0) for i in range(SLEEVE_RINGS)]
        for d, inset in stations:
            t = (d - d0) / (d1 - d0)
            grow = 1 + (SLEEVE_ELBOW_GROW - 1) * min(1.0, max(0.0, t)) ** 1.3
            ring = []
            for s in range(SLEEVE_SEGMENTS):
                a = 2 * math.pi * s / SLEEVE_SEGMENTS
                p = W + A * d + X * (math.cos(a) * rx * grow * inset) + Y * (math.sin(a) * ry * grow * inset)
                v = bm.verts.new(p)
                ws = {f'ForeTwist2.{sd}': max(0.0, 1 - 2 * t), f'ForeTwist1.{sd}': 1 - abs(2 * t - 1) if t < 1 else 0.0,
                      f'LowerArm.{sd}': max(0.0, 2 * t - 1)}
                tot = sum(ws.values()) or 1.0
                for n, wt in ws.items():
                    if wt <= 0:
                        continue
                    if n not in gidx:
                        gidx[n] = obj.vertex_groups.new(name=n).index
                    v[deform][gidx[n]] = wt / tot
                ring.append(v)
            rings.append((d, ring))
        for (da, ra), (db, rb) in zip(rings, rings[1:]):
            for s in range(SLEEVE_SEGMENTS):
                s2 = (s + 1) % SLEEVE_SEGMENTS
                f = bm.faces.new((ra[s], ra[s2], rb[s2], rb[s]))
                f.smooth = True
                # Outward: a face whose normal points at the forearm's axis is turned round.
                f.normal_update()
                c = f.calc_center_median() - W
                if f.normal.dot(c - A * c.dot(A)) < 0:
                    f.normal_flip()
                for lp in f.loops:
                    q = lp.vert.co - W
                    # Round the arm: one width of the fabric crop; along it: its height, wrist to elbow.
                    ang = (math.atan2(q.dot(Y), q.dot(X)) / (2 * math.pi)) % 1.0
                    if s2 == 0 and ang < 0.5:
                        ang = 1.0                     # the seam's last column runs to the crop's far edge
                    along = min(1.0, max(0.0, q.dot(A) / max(d1, 1e-3)))
                    lp[uvl].uv = (c0 + ang * (c1 - c0), e0 + along * (e1 - e0))
                    lp[col] = GHOST_SLEEVE_TINT if look == 'ghost' else (1.0, 1.0, 1.0, 0.0)
    bm.to_mesh(me)
    bm.free()
    byte_colours(me)
    mat = bpy.data.materials.get('sleeve_tube') or bpy.data.materials.new('sleeve_tube')
    me.materials.append(mat)
    return obj
