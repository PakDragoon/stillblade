"""
Package V part 1: the owner's knife pack ("Knife FPS Animations", Fab Standard License; knifepack.py extracts it) read
in Blender, shared by fpknife.py (the first-person knife rig) and weapons.py (the third-person karambit and the knife
atlas).

The pack (measured; fpknife.py logs it on every build):
  - Hands_rig.fbx: one skinned mesh "Hands_LP" (10,606 triangles, 5,337 vertices, one material: full-finger gloves and
    camouflage sleeves to the upper arm, no bare skin) on a UE-style skeleton "root" (pelvis ... head, clavicles, upper
    arms, twist bones, hands, metacarpals and three joints per finger), and "weapon_r", the knife socket, a child of
    hand_r that the clips animate too (it only moves against the hand in the draw and the inspect).
  - SKM_Knife.fbx: the karambit "ViperFANG" (4,300 triangles), skinned wholly to its own bone "spin" (under "body").
    The pack's script parents it to weapon_r at the socket's own position and rotation.
  - The clips (60 fps; one FBX each, the skeleton keyed): idle 5.33 s (a 2.67 s loop played twice), draw 1.0,
    quick_draw 0.5, swing_0 0.667, swing_1..3 0.5, strike_prepare / strike_hit / strike_miss (a heavy stab), inspect
    4.83, sprint, sprint_prepare, holster 0.667, empty (the hands without the knife). The pack's animator (read as
    data from its .controller) plays the swings at 1.1x, chains Swing_0 -> Swing_1 -> Swing_3 while the attack is held
    and then returns through Quick_draw; each swing's "TraceHit" event (where its blade strikes) is at 50.2 % of the
    clip (swing_2 50.3 %), read from the clips' .meta files.
  - The eye: the pack's camera hangs from the head bone ("CameraTarget": 6.93 cm along the head bone's X, 1.24 cm
    along its Y, turned (90, -90, 0) degrees), vertical field of view 34.5 degrees. The head bone stays put in every
    clip but turns by up to 3.6 degrees (a little camera motion baked into the swings and the inspect).

Frames: Blender world as imported (metres, Z up; the character faces -Y, its right hand at -X). `Pack.sample(clip, t)`
gives every bone's rigid world frame, the socket's ("weapon") and the eye's ("eye": X right, Y forward, Z up).
"""
import math
import os

import bpy
from mathutils import Matrix, Quaternion, Vector

import knifepack

FBX_FPS = 60
HANDS = 'Character/Mesh/Hands_rig.fbx'
KNIFE = 'Weapon/Mesh/SKM_Knife.fbx'
CLIPS = {
    'idle': 'Character/Animations/AS_Hands_idle.fbx',
    'draw': 'Character/Animations/AS_Hands_draw.fbx',
    'quick_draw': 'Character/Animations/AS_Hands_quick_draw.fbx',
    'swing_0': 'Character/Animations/AS_Hands_swing_0.fbx',
    'swing_1': 'Character/Animations/AS_Hands_swing_1.fbx',
    'swing_2': 'Character/Animations/AS_Hands_swing_2.fbx',
    'swing_3': 'Character/Animations/AS_Hands_swing_3.fbx',
    'holster': 'Character/Animations/AS_Hands_holster.fbx',
    'inspect': 'Character/Animations/AS_Hands_inspect.fbx',
}
KNIFE_CLIPS = {'knife_idle': 'Weapon/Animations/AS_Knife_idle.fbx'}
# The swings' strike ("TraceHit" in the clips' .meta files, normalised time) and the animator's speed for them.
STRIKE = {'swing_0': 0.5020576, 'swing_1': 0.5020576, 'swing_2': 0.5034965, 'swing_3': 0.5020576}
SWING_SPEED = 1.1
# The idle's loop: frames 1 and 161 (and 321) are the same pose.
IDLE_LOOP = 160 / FBX_FPS
# The camera on the head bone (the prefab's CameraTarget, Unity's left-handed local frame converted to the FBX's:
# x negated, the quaternion's y and z negated).
EYE_OFFSET = Vector((0.0693, 0.0124, 0.0))
EYE_ROT = Quaternion((0.5, 0.5, 0.5, -0.5))            # (w, x, y, z): Unity (x .5, y -.5, z .5, w .5)
PACK_FOV = 34.46576
# The glove and the sleeve are separate UV islands of the one texture; faces of the glove have their UV centroid above
# this v (Blender UVs, v up) in the pack's texture.
GLOVE_V = 0.62


def log(*a):
    print('[knifekit]', *a, flush=True)


def unit(m):
    loc, rot, _ = m.decompose()
    return Matrix.LocRotScale(loc, rot, None)


def import_fbx(rel):
    """Imports one file of the pack (data only); {name without suffix: object} of the new objects."""
    path = knifepack.path(rel)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False, ignore_leaf_bones=False,
                             use_custom_props=False, use_anim=True)
    bpy.context.view_layer.update()
    return {o.name.split('.')[0]: o for o in bpy.data.objects if o not in before}


def remove(objs):
    for o in objs.values():
        data = o.data
        bpy.data.objects.remove(o)
        if data is not None and data.users == 0:
            if isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
            elif isinstance(data, bpy.types.Armature):
                bpy.data.armatures.remove(data)


class Pack:
    def __init__(self):
        scene = bpy.context.scene
        objs = import_fbx(HANDS)
        self.arm, self.mesh, self.socket = objs['root'], objs['Hands_LP'], objs['weapon_r']
        self.G = self.arm.matrix_world.copy()
        kobjs = import_fbx(KNIFE)
        self.knife_arm, self.knife_mesh = kobjs['Armature'], kobjs['SM_ViperFANG']
        same = all(abs(a - b) < 1e-6 for ra, rb in zip(self.G, self.knife_arm.matrix_world) for a, b in zip(ra, rb))
        log('hands root', [tuple(round(x, 4) for x in r) for r in self.G], 'knife root the same:', same)
        if not same:
            raise RuntimeError('the knife file and the hands file import with different root transforms')
        for a in list(bpy.data.actions):
            bpy.data.actions.remove(a)
        scene.frame_set(0)
        bpy.context.view_layer.update()
        self.bones = [b.name for b in self.arm.data.bones]
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in self.arm.data.bones}
        self.rest = {b.name: unit(self.arm.matrix_world @ b.matrix_local) for b in self.arm.data.bones}
        self.rest['weapon'] = unit(self.socket.matrix_world)
        self.socket_scale = self.socket.matrix_world.to_scale()
        self._cache = {}
        log('fps after import', scene.render.fps, 'bones', len(self.bones), 'socket parent', self.socket.parent_bone)

    # --- meshes (world, metres) -------------------------------------------------------------------------

    def hands_mesh(self):
        """(positions, normals per corner, uvs per corner, triangles [(a, b, c)], {vertex: [(bone, weight)]})."""
        me, mw = self.mesh.data, self.mesh.matrix_world
        nm = mw.to_3x3().inverted().transposed()
        pos = [mw @ v.co for v in me.vertices]
        groups = {g.index: g.name for g in self.mesh.vertex_groups}
        weights = [[(groups[g.group], g.weight) for g in v.groups if g.weight > 0] for v in me.vertices]
        me.calc_loop_triangles()
        uvl = me.uv_layers.active.data
        tris = []
        for lt in me.loop_triangles:
            tris.append((tuple(lt.vertices), [uvl[i].uv.copy() for i in lt.loops],
                         [(nm @ Vector(me.corner_normals[i].vector)).normalized() for i in lt.loops]))
        return pos, tris, weights

    def knife_mesh_local(self):
        """The karambit in the socket's frame (metres): positions, triangles with per-corner UVs and normals."""
        me, mw = self.knife_mesh.data, self.knife_mesh.matrix_world
        # FBX root space (the pack's script parents the knife's root to the socket at identity), then the socket's own
        # scale (the hands file's 0.01): metres in the socket frame.
        to_local = Matrix.Diagonal(self.socket_scale.to_4d()) @ self.G.inverted() @ mw
        nm = to_local.to_3x3().inverted().transposed()
        pos = [to_local @ v.co for v in me.vertices]
        me.calc_loop_triangles()
        uvl = me.uv_layers.active.data
        tris = []
        for lt in me.loop_triangles:
            tris.append((tuple(lt.vertices), [uvl[i].uv.copy() for i in lt.loops],
                         [(nm @ Vector(me.corner_normals[i].vector)).normalized() for i in lt.loops]))
        return pos, tris

    def knife_maps(self):
        d = knifepack.path('Weapon/Textures/2k')
        return orm_maps(d, 'T_ViperFANG_2k_')

    def hands_maps(self):
        d = knifepack.path('Character/Textures/2k')
        return orm_maps(d, 'T_Hands_')

    # --- poses -----------------------------------------------------------------------------------------

    def eye(self, head):
        """The pack's camera from the head bone's world frame: X right, Y forward, Z up (Blender camera-rig axes)."""
        h = unit(head)
        r = h.to_quaternion() @ EYE_ROT
        fwd = r @ Vector((0, 0, 1))            # Unity cameras look along their local +Z, up +Y
        up = r @ Vector((0, 1, 0))
        right = fwd.cross(up)
        m = Matrix((right, fwd, up)).transposed().to_4x4()
        m.translation = h @ EYE_OFFSET
        return m

    def sample(self, clip, times, src=None):
        """[{bone: world frame, 'weapon': socket frame, 'eye': camera frame}] at `times` (seconds into the pack's
        clip, 60 fps; clamped to the clip)."""
        files = src or CLIPS
        objs = import_fbx(files[clip])
        arm = objs.get('root') or objs.get('Armature')
        sock = objs.get('weapon_r')
        act = arm.animation_data.action
        f0, f1 = act.frame_range
        scene = bpy.context.scene
        out = []
        for t in times:
            f = min(f1, max(f0, f0 + t * FBX_FPS))
            fi = int(math.floor(f))
            scene.frame_set(fi, subframe=f - fi)
            pose = {}
            for pb in arm.pose.bones:
                pose[pb.name] = unit(arm.matrix_world @ pb.matrix)
            if sock is not None:
                pose['weapon'] = unit(sock.matrix_world)
            if 'head' in pose:
                pose['eye'] = self.eye(arm.matrix_world @ arm.pose.bones['head'].matrix)
            out.append(pose)
        remove(objs)
        for a in list(bpy.data.actions):
            if a.users == 0:
                bpy.data.actions.remove(a)
        return out

    def duration(self, clip, src=None):
        files = src or CLIPS
        if (clip, 'dur') not in self._cache:
            objs = import_fbx(files[clip])
            arm = objs.get('root') or objs.get('Armature')
            f0, f1 = arm.animation_data.action.frame_range
            remove(objs)
            self._cache[(clip, 'dur')] = (f1 - f0) / FBX_FPS
        return self._cache[(clip, 'dur')]


def orm_maps(folder, stem):
    """{'base', 'normal', 'ao', 'rough', 'metal'} -> (image, channel) for realistic.Atlas (Unity's packed
    occlusion (R), roughness (G), metallic (B) map)."""
    import realistic as rl
    out = {}
    for f in sorted(os.listdir(folder)):
        p = os.path.join(folder, f)
        if f.startswith(stem + 'BaseColor'):
            out['base'] = (rl.load_image(p), None)
        elif f.startswith(stem + 'Normal'):
            out['normal'] = (rl.load_image(p), None)
        elif f.startswith(stem + 'OcclusionRoughnessMetallic'):
            img = rl.load_image(p)
            out['ao'], out['rough'], out['metal'] = (img, 0), (img, 1), (img, 2)
    return out


def grip_frame(pose, side='r', palm_offset=0.03, along=0.55):
    """The grip frame of a pack hand (rigkit.hand_grip_frame's construction on the pack's bones): origin in the palm,
    'up' from the pinky side to the index side, 'forward' wrist to knuckles."""
    w = pose[f'hand_{side}'].translation
    kn = sum((pose[f'{f}_01_{side}'].translation for f in ('index', 'middle', 'ring', 'pinky')), Vector()) / 4
    fingers = (kn - w).normalized()
    across = pose[f'index_01_{side}'].translation - pose[f'pinky_01_{side}'].translation
    up = (across - fingers * across.dot(fingers)).normalized()
    right = fingers.cross(up)
    palm = -right if side == 'r' else right
    m = Matrix((right, fingers, up)).transposed().to_4x4()
    m.translation = w + (kn - w) * along + palm * palm_offset
    return m


# ---------------------------------------------------------------------------------------------
# Glove and sleeve: the two looks of the hands

# The knife atlas holds the hands in grey (`hands_post`): each part's mean at M (stored value), its detail kept at C of
# its contrast (the camouflage pattern is muted on the sleeve, the glove's seams and pads kept). The colour comes from
# the vertex colour the material multiplies by (linear): TINTS. Gamma 2.2 makes a stored-value product a linear one.
PARTS = {'glove': {'M': 0.5, 'C': 1.0, 's': 0.12}, 'sleeve': {'M': 0.75, 'C': 0.45, 's': 0.08}}
# Target colours as stored (sRGB-encoded) values: the defender's glove is the M4 rig's coyote (packhands.COYOTE), its
# sleeve the defenders' orange shirt (measured from the soldier's shirt in the pistol atlas's sleeve region); the
# ghost's are the ghost suit's dark grey and the dark glove of the old ghost rig (coyote times its 0.16 tint).
TARGET = {
    'defender': {'glove': (0.50, 0.40, 0.27), 'sleeve': (0.78, 0.36, 0.10)},
    'ghost': {'glove': (0.21, 0.18, 0.14), 'sleeve': (0.17, 0.17, 0.19)},
}


def _lin(x):
    return max(0.0, min(1.0, x)) ** 2.2


TINTS = {look: {part: tuple(_lin(c / PARTS[part]['M']) for c in rgb) for part, rgb in parts.items()}
         for look, parts in TARGET.items()}


def ghost_pairs():
    """[(defender tint bytes, ghost tint bytes)] as the GLB stores COLOR_0 (linear, unsigned byte)."""
    def b(c):
        return bytes(int(round(max(0.0, min(1.0, x)) * 255)) for x in c) + b'\x00'
    return [(b(TINTS['defender'][p]), b(TINTS['ghost'][p])) for p in PARTS]


_GLOVE = None


def glove_tris(pack):
    """Indices of the pack mesh's loop triangles that belong to the glove: its UV islands (corners joined by shared
    vertex and UV) whose texture is grey (the camouflage sleeve is coloured). Cached."""
    global _GLOVE
    if _GLOVE is not None:
        return _GLOVE
    import numpy as np
    me = pack.mesh.data
    me.calc_loop_triangles()
    uvl = me.uv_layers.active.data
    lts = list(me.loop_triangles)
    parent = list(range(len(lts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    owner = {}
    for t, lt in enumerate(lts):
        for li in lt.loops:
            uv = uvl[li].uv
            key = (me.loops[li].vertex_index, round(uv.x, 4), round(uv.y, 4))
            if key in owner:
                a, b = find(owner[key]), find(t)
                if a != b:
                    parent[a] = b
            else:
                owner[key] = t
    img = pack.hands_maps()['base'][0]
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    chroma = {}
    for t, lt in enumerate(lts):
        u = sum(uvl[li].uv.x for li in lt.loops) / 3
        v = sum(uvl[li].uv.y for li in lt.loops) / 3
        c = px[min(h - 1, max(0, int(v * h))), min(w - 1, max(0, int(u * w))), :3]
        chroma.setdefault(find(t), []).append(float(c.max() - c.min()))
    glove = set()
    stats = []
    for root, cs in chroma.items():
        m = sum(cs) / len(cs)
        stats.append((len(cs), round(m, 3)))
        if m < 0.06:
            glove.update(t for t in range(len(lts)) if find(t) == root)
    log('uv islands (triangles, mean chroma):', sorted(stats, reverse=True)[:16], 'glove triangles', len(glove),
        'of', len(lts))
    _GLOVE = glove
    return glove


def glove_mask(pack, w, h):
    """Texture-space mask (h, w; rows bottom-up) of the glove's UV triangles, grown by 3 pixels into the gutters."""
    import numpy as np
    me = pack.mesh.data
    uvl = me.uv_layers.active.data
    mask = np.zeros((h, w), bool)
    glove = glove_tris(pack)
    for t, lt in enumerate(me.loop_triangles):
        if t not in glove:
            continue
        p = np.array([(uvl[li].uv.x * w, uvl[li].uv.y * h) for li in lt.loops])
        x0, y0 = np.floor(p.min(axis=0)).astype(int)
        x1, y1 = np.ceil(p.max(axis=0)).astype(int)
        x0, y0, x1, y1 = max(x0 - 1, 0), max(y0 - 1, 0), min(x1 + 1, w), min(y1 + 1, h)
        if x1 <= x0 or y1 <= y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        (ax, ay), (bx, by), (cx, cy) = p
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-12:
            continue
        l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d
        l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / d
        inside = (l1 >= -0.02) & (l2 >= -0.02) & (1 - l1 - l2 >= -0.02)
        mask[y0:y1, x0:x1] |= inside
    for _ in range(3):
        g = mask.copy()
        g[1:] |= mask[:-1]
        g[:-1] |= mask[1:]
        g[:, 1:] |= mask[:, :-1]
        g[:, :-1] |= mask[:, 1:]
        mask = g
    return mask


def hands_post(pack):
    """realistic.Region post: the hands' albedo in grey, each part (glove, sleeve) normalised as PARTS says."""
    import numpy as np

    def post(rgb, s):
        h, w = rgb.shape[:2]
        glove = glove_mask(pack, w, h)
        lum = rgb[..., 0] * 0.3 + rgb[..., 1] * 0.55 + rgb[..., 2] * 0.15
        grey = np.zeros_like(lum)
        for part, sel in (('glove', glove), ('sleeve', ~glove)):
            k = PARTS[part]
            mean = max(float(lum[sel].mean()), 1e-3)
            grey[sel] = k['M'] * (1 + (lum[sel] / mean - 1) * k['C'])
            s[sel] = np.minimum(s[sel], k['s'])
            log('hands', part, 'mean stored', round(mean, 3), '->', k['M'], 'pixels', int(sel.sum()))
        for c in range(3):
            rgb[..., c] = np.clip(grey, 0, 1)
    return post
