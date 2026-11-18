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
        if prim['material'] == 'Hand_D':
            # Only the fingertips' skin: the wrist's lies under the glove and poked through its cuff when the wrist
            # bent (the overhand handle pull). (The atlas crop still uses kept_faces, so the textures are unchanged.)
            def dom(k):
                js, ws = prim['joints'][k], prim['weights'][k]
                return js[max(range(4), key=lambda i: ws[i])]
            faces = [f for f in faces if not all(dom(k).endswith(('Hand', 'ForeArm')) for k in f)]
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


# ---------------------------------------------------------------------------------------------
# The defender's sleeve from the soldier's own shirt (package R follow-up)

# The part of the Quantum shirt's upper-arm sleeve that is moved onto the forearm, as fractions from the elbow (0) to
# the shoulder (1): above the rolled cuff, below the armpit. Its elbow end goes to the wrist, its shoulder end past
# our elbow (the upper sleeve narrows toward the elbow as a forearm sleeve narrows toward the wrist).
SHIRT_FROM, SHIRT_TO = 0.22, 0.75
# At the wrist the sleeve closes onto the glove's strap: its radius there is the strap's plus SHIRT_HUG (m), easing out
# to the strap's plus SHIRT_LOOSE by SHIRT_HUG_LEN up the forearm, then growing to SLEEVE_ELBOW_GROW at the elbow.
SHIRT_HUG = 0.0025
SHIRT_LOOSE = 0.008
SHIRT_HUG_LEN = 0.035
# The sleeve's wrist end starts this far past the glove cuff band's centre toward the hand (m), so it covers the whole
# strap and the wrist when the hand bends; and its end is cut on a slant (degrees), lower under the arm, so the cuff is
# not a flat ring.
SHIRT_START = -0.003
SHIRT_SLANT = 7
SHIRT_PAST_ELBOW = 0.10
# Turns the shirt round the forearm (degrees) so its seam runs underneath, out of view.
SHIRT_TURN = {'L': 0.0, 'R': 0.0}
# Triangles kept per sleeve (the source is subdivided once first, so the bunching below has edges to bend).
SHIRT_TRIS = 600
# Bunching where the sleeve is pushed up against the glove: ridges round the wrist end, slanting round the arm
# (height m, spacing m along the arm, how far up it fades m).
BUNCH_HEIGHT = 0.0035
BUNCH_SPACING = 0.016
BUNCH_FADE = 0.05


def _cuff(arm, hands, sd):
    """The glove cuff's centre on the forearm, the forearm's axis from it to the elbow, the frame round it and the
    strap's radii (95th percentile across and through the hand)."""
    data = arm.data
    src = source()
    E = data.bones[f'LowerArm.{sd}'].head_local
    w0 = data.bones[f'Wrist.{sd}'].head_local
    a0 = (E - w0).normalized()
    # This hand's vertices (the glove's cuff and strap; the wrist's own skin is not in the mesh any more).
    gname = {g.index: g.name for g in hands.vertex_groups}
    pts = [v.co.copy() for v in hands.data.vertices
           if v.groups and gname[max(v.groups, key=lambda g: g.weight).group].endswith(f'.{sd}')]
    top_d = src.cuff[sd][2] * PACK_HAND_SCALE / 100.0
    band = [p for p in pts if (p - w0).dot(a0) > top_d - SLEEVE_OVER_CUFF / 100.0 - 0.01] or pts
    W = sum(band, Vector()) / len(band)
    A = (E - W).normalized()
    across = data.bones[f'Index2.{sd}'].head_local - data.bones[f'Pinky2.{sd}'].head_local
    X = (across - A * across.dot(A)).normalized()
    Y = A.cross(X)
    ex = sorted(abs((p - W).dot(X)) for p in band)
    ey = sorted(abs((p - W).dot(Y)) for p in band)
    return W, E, A, X, Y, ex[int(0.95 * (len(ex) - 1))], ey[int(0.95 * (len(ey) - 1))]


def _bone_frame(data, name, axis):
    """Two unit vectors across a bone (its own X squared up to `axis`, and the third)."""
    m = data.bones[name].matrix_local.to_3x3()
    x = m.col[0].normalized()
    x = (x - axis * x.dot(axis)).normalized()
    return x, axis.cross(x)


def _smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def sleeve_from_shirt(arm, hands, shirt):
    """The defender's sleeves made from the soldier's shirt (`shirt`: its arm part, world space = the rig's rest space,
    material M_Shirt_RolledUp): per arm the upper-arm sleeve between SHIRT_FROM and SHIRT_TO is cut out with two planes
    and laid along the forearm, its folds and texture kept, its radius fitted to the forearm and closed onto the
    glove's strap at the wrist."""
    data = arm.data
    gname = {g.index: g.name for g in shirt.vertex_groups}
    out = []
    for sd in 'LR':
        S = data.bones[f'UpperArm.{sd}'].head_local
        Es = data.bones[f'LowerArm.{sd}'].head_local
        L_s = (S - Es).length
        As = (S - Es).normalized()
        Xs, Ys = _bone_frame(data, f'UpperArm.{sd}', As)
        W, E, A, X, Y, rx, ry = _cuff(arm, hands, sd)
        Xf, Yf = _bone_frame(data, f'LowerArm.{sd}', A)
        # Well past the elbow (SHIRT_PAST_ELBOW), so the sleeve's open upper end never comes into view (it did when
        # aiming); the part beyond the elbow follows the upper arm.
        L_e = (E - W).length
        L_t = L_e + SHIRT_PAST_ELBOW
        obj = rl.duplicate(shirt, f'sleeve_{sd}')
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        deform = bm.verts.layers.deform.verify()
        bm.verts.ensure_lookup_table()
        # Only this side's arm sleeve.
        side = []
        for v in bm.verts:
            ws = v[deform]
            best = max(ws.items(), key=lambda kv: kv[1])[0] if len(ws) else None
            n = gname.get(best, '') if best is not None else ''
            side.append(n.endswith(f'.{sd}') and n.startswith(('UpperArm', 'LowerArm')))
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if not all(side[v.index] for v in f.verts)], context='FACES')
        # Clean cuts across the sleeve at both ends.
        slant = (Matrix.Rotation(math.radians(SHIRT_SLANT), 3, Xs) @ As).normalized()
        for frac, keep_up, no in ((SHIRT_FROM, True, slant), (SHIRT_TO, False, As)):
            co = Es + As * (L_s * frac)
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no, clear_inner=keep_up, clear_outer=not keep_up)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        if not bm.verts:
            raise RuntimeError(f'no shirt sleeve left on side {sd}')
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        # The source's radius along the kept part (10 bins), to fit the forearm's radius.
        bins = [[] for _ in range(10)]
        for v in bm.verts:
            q = v.co - Es
            a = (q.dot(As) / L_s - SHIRT_FROM) / (SHIRT_TO - SHIRT_FROM)
            bins[min(9, max(0, int(a * 10)))].append((q - As * q.dot(As)).length)
        # The 85th percentile, not the mean: the folds standing out of the cloth are the ones that must meet the strap.
        mean = [sorted(b)[int(0.85 * (len(b) - 1))] if b else None for b in bins]
        known = [m for m in mean if m]
        mean = [m if m else sum(known) / len(known) for m in mean]
        turn = math.radians(SHIRT_TURN[sd])
        ravg = (rx + ry) / 2
        for v in bm.verts:
            q = v.co - Es
            a = min(1.0, max(0.0, (q.dot(As) / L_s - SHIRT_FROM) / (SHIRT_TO - SHIRT_FROM)))
            radial = q - As * q.dot(As)
            x, y = radial.dot(Xs), radial.dot(Ys)
            x, y = x * math.cos(turn) - y * math.sin(turn), x * math.sin(turn) + y * math.cos(turn)
            f = min(9.0, max(0.0, a * 10 - 0.5))
            i0 = int(f)
            src_r = mean[i0] + (mean[min(9, i0 + 1)] - mean[i0]) * (f - i0)
            d = SHIRT_START + a * (L_t - SHIRT_START)
            want = ravg + SHIRT_HUG + (SHIRT_LOOSE - SHIRT_HUG) * _smooth(d / SHIRT_HUG_LEN)
            want *= 1 + (SLEEVE_ELBOW_GROW - 1) * a ** 1.3
            # Compression folds above the cuff (none on its very edge, which stays on the strap).
            ang = math.atan2(y, x)
            ridge = 0.5 + 0.5 * math.sin(2 * math.pi * d / BUNCH_SPACING + 2 * ang + 0.7 * math.sin(3 * ang))
            want += BUNCH_HEIGHT * ridge * math.exp(-d / BUNCH_FADE) * _smooth(d / 0.008)
            k = want / max(src_r, 1e-4)
            v.co = W + A * d + Xf * (x * k * rx / ravg) + Yf * (y * k * ry / ravg)
        bm.to_mesh(obj.data)
        bm.free()
        for g in list(obj.vertex_groups):
            obj.vertex_groups.remove(g)
        gi = {n: obj.vertex_groups.new(name=f'{n}.{sd}') for n in ('ForeTwist2', 'ForeTwist1', 'LowerArm', 'Wrist', 'UpperArm')}
        for v in obj.data.vertices:
            t = min(1.0, max(0.0, (v.co - W).dot(A) / L_t))
            # Loose cloth turns less than skin with the hand: the wrist end mostly on the half-roll twist bone
            # (viewmodel.py TWIST_SHARE: ForeTwist1 0.5, ForeTwist2 0.85), easing onto the forearm toward the elbow.
            t = min(1.0, max(0.0, (v.co - W).dot(A) / L_e))
            up = _smooth(((v.co - W).dot(A) - L_e + 0.01) / 0.05)
            ws = {'ForeTwist2': 0.25 * max(0.0, 1 - 3 * t), 'ForeTwist1': max(0.0, 1 - t * 1.6), 'LowerArm': min(1.0, t * 1.6)}
            ws = {n: wt * (1 - up) for n, wt in ws.items()}
            ws['UpperArm'] = up
            tot = sum(ws.values()) or 1.0
            for n, wt in ws.items():
                if wt > 0:
                    gi[n].add([v.index], wt / tot, 'REPLACE')
            # (The rig normalises every vertex's weights before export.) The part over the wrist follows the hand a little, so the cuff stays on the strap when the wrist bends.
            dw = (v.co - W).dot(A)
            if dw < 0.01:
                gi["Wrist"].add([v.index], 0.12 * _smooth((0.01 - dw) / 0.02), 'REPLACE')
        before = len(obj.data.polygons)
        ds = [(v.co - W).dot(A) for v in obj.data.vertices]
        for lo, hi in ((0.0, 0.03), (0.08, 0.12), (0.18, 0.22)):
            ring = [v.co - W for v in obj.data.vertices if lo <= (v.co - W).dot(A) < hi]
            if ring:
                log(sd, f'  section {lo}-{hi} m: across', round(min(q.dot(X) for q in ring), 3), round(max(q.dot(X) for q in ring), 3),
                    'through', round(min(q.dot(Y) for q in ring), 3), round(max(q.dot(Y) for q in ring), 3))
        log(sd, 'shirt sleeve reaches', round(min(ds), 3), 'to', round(max(ds), 3), 'm up the forearm (elbow at',
            round((E - W).dot(A), 3), ')')
        rl.decimate(obj, SHIRT_TRIS, keep_normals=False)
        log(sd, 'shirt sleeve: source radii elbow to shoulder', [round(m, 3) for m in mean], '; wrist strap radii',
            round(rx, 3), round(ry, 3), '; faces', before, '->', len(obj.data.polygons))
        out.append(obj)
    obj = rl.join(out, 'sleeve')
    if obj.data.has_custom_normals:
        with bpy.context.temp_override(object=obj, active_object=obj):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
    obj.data.shade_smooth()
    rl.set_colour(obj, (1.0, 1.0, 1.0, 0.0))
    return obj
