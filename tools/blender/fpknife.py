"""
Package V part 1: the first-person knife rig, client/public/models/viewmodel_knife.glb, built from the owner's
"Knife FPS Animations" pack exactly as authored: the pack's own hands (gloves and sleeves), its own skeleton and bind
pose, its own karambit on its own socket, and its own clips, only resampled at the speeds the game's rules need.
Nothing is retargeted.

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup \
        --python tools/blender/fpknife.py [-- --preview <dir> [--no-export]]
  --preview: Workbench renders of every clip from the pack's eye, at the pack's field of view ("pack-") and at the
  game's fixed 74-degree weapon view without the zoom ("vm74-"); --no-export: leave viewmodel_knife.glb alone.

Needs the pack (tools/blender/source-art/realistic/fp-anims/knife_fps_animations.unitypackage, extracted by
knifepack.py) and the knife atlas written by weapons.py (realistic.LAYOUTS['knife']: the karambit and the hands).

The rig (one skinned mesh per look, both on one armature "rig_knife", one shown at a time; one draw call):
  - the pack's arm joints from the upper arms down (upperarm_*, its twist bones, lowerarm_*, hand_*, the metacarpals
    and three joints per finger) with the pack's bind pose, so the hands deform exactly as in the pack; the joints
    above (clavicles, spine, head) carry no skin and are left out;
  - "weapon": the pack's knife socket weapon_r (under hand_r; the clips move it against the hand in the draw), with the
    karambit bound rigidly to it as the pack's script attaches it;
  - "vm_knife" (defenders: the gloves coyote like the M4's, the sleeves the defenders' orange) and "vm_ghost" (ghosts:
    dark gloves and sleeves like the ghost suit). They differ only in their vertex colours (the atlas holds the hands
    in grey, the colour comes from the vertex colour the material multiplies by), so vm_ghost reuses vm_knife's
    vertex data in the file (`share_ghost`).
Faces the camera never sees in any exported frame are dropped (`visible_faces`).

Rig space: the pack's eye (its camera on the head bone) at each frame, Blender camera-rig axes (X right, Y forward,
Z up; glTF: -Z forward, +Y up). The client hangs the rig from the camera and draws it with the pack's own vertical
field of view, 34.5 degrees, through the viewmodel zoom (presenter.ts KNIFE_VM_ZOOM).

Clips (30 fps, every bone keyed on every frame, linear; pack times scaled to the rules in shared/weapons.ts and
shared/knife.ts):
  knife_idle      the pack's idle loop, 2.67 s (the client loops it)
  knife_draw      the pack's quick_draw, 0.5 s in 0.3 s (1.67x: the defender knife's draw); also the swing recovery
  knife_swing_0..3  each swing's wind-up (pack 0 s to the moment its blade crosses the middle of the view) in the
                  rule's 0.2 s windup, so the blade crosses the crosshair when the slash lands; the rest at the pack's
                  own 1.1x. (The pack's own hit event, "TraceHit", comes 0.07-0.1 s later, when the blade is already
                  at or past the edge of its view: `crossing`.) The client chains them while the
                  attack is held as the pack's animator does (0 from the idle, then 1 after 0, 2 or 3; 2 and 3 in turn
                  after 1) and recovers to the idle through knife_draw's rise when it is released.
Not exported: draw (1.0 s, a flourish too long for the 0.3 s draw), holster (a switch has no holster time), inspect
(no inspect key or rule), sprint and sprint_prepare (no sprint rule: running is the normal pace, and a lowered knife
would read as unready), strike_prepare / strike_hit / strike_miss (a heavy stab: the knife has one attack), empty.
"""
import json
import math
import os
import struct
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import knifekit as kk  # noqa: E402
import realistic as rl  # noqa: E402
import rigkit as rk  # noqa: E402

ROOT = rl.ROOT
OUT = os.path.join(ROOT, 'client', 'public', 'models', 'viewmodel_knife.glb')
FPS = 30
# Rules (shared/weapons.ts DEFENDER_KNIFE, shared/constants.ts KNIFE_WINDUP_TICKS / KNIFE_COOLDOWN_TICKS).
WINDUP = 0.2
DRAW = 0.3
COOLDOWN = 0.7
SWINGS = ('swing_0', 'swing_1', 'swing_2', 'swing_3')
# The arm joints kept: everything under the upper arms.
ARM_ROOTS = ('upperarm_l', 'upperarm_r')
# Visibility test for dropping faces: the pack's view (34.5 degrees vertical) at any aspect up to 2.4:1, widened by
# this much on every side for the client's bob, sway and inertia, nearer than its far end; the pack's near plane.
VIS_MARGIN = 1.25
VIS_ASPECT = 2.4
NEAR = 0.1


def log(*a):
    print('[fpknife]', *a, flush=True)


def tris_of(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


# ---------------------------------------------------------------------------------------------
# Clips: pack poses in rig space (the pack's eye)

def to_rig(pose):
    e = pose['eye'].inverted()
    return {b: e @ m for b, m in pose.items() if b != 'eye'}


def clip_frames(pack, clip, our_s, src_map):
    """Rig-space poses at our 30 fps over our_s seconds; `src_map(u)` gives the pack time for our time u."""
    n = max(1, int(round(our_s * FPS)))
    times = [src_map(i / FPS) for i in range(n + 1)]
    return [to_rig(p) for p in pack.sample(clip, times)]


def crossing(pack, clip, dur):
    """Pack time at which the knife (its socket) crosses the middle of the view in the swing's sweep: the last sign
    change of its horizontal screen position before the pack's own hit event (sampled at 240 Hz)."""
    event = kk.STRIKE[clip] * dur
    times = [i / 240 for i in range(int(dur * 240) + 1)]
    xs = []
    for p in pack.sample(clip, times):
        v = (p['eye'].inverted() @ p['weapon']).translation
        xs.append(v.x / max(v.y, 1e-3))
    best = None
    for i in range(1, len(times)):
        if times[i] > event + 1e-6:
            break
        if (xs[i - 1] > 0) != (xs[i] > 0):
            best = times[i - 1] + (times[i] - times[i - 1]) * xs[i - 1] / (xs[i - 1] - xs[i])
    if best is None:
        raise RuntimeError(f'{clip}: the knife never crosses the view before its hit event')
    return best, event


def swing_map(pack, clip):
    dur = pack.duration(clip)
    strike, event = crossing(pack, clip, dur)
    log(f'{clip}: the blade crosses the middle of the view at {strike:.3f} s; the pack\'s hit event is at {event:.3f} s')
    rest = (dur - strike) / kk.SWING_SPEED
    our = WINDUP + rest

    def f(u):
        return strike * u / WINDUP if u <= WINDUP else strike + (u - WINDUP) * kk.SWING_SPEED
    return our, f, strike, dur


# ---------------------------------------------------------------------------------------------

class Rig:
    def __init__(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.pack = kk.Pack()
        bpy.context.scene.render.fps = FPS
        p = self.pack
        keep = set()
        for b in p.bones:
            n = b
            while n is not None and n not in ARM_ROOTS:
                n = p.parent[n]
            if n is not None:
                keep.add(b)
        self.bones = [b for b in p.bones if b in keep]          # parents before children (Blender's order)
        log('pack bones', len(p.bones), 'arm bones kept', len(self.bones))

    # --- clips ----------------------------------------------------------------------------------------

    def sample_clips(self):
        p = self.pack
        for c in ('idle', 'quick_draw', 'draw', 'holster', 'inspect') + SWINGS:
            log('pack clip', c, round(p.duration(c), 3), 's')
        self.clips = {}
        loop = kk.IDLE_LOOP
        self.clips['knife_idle'] = clip_frames(p, 'idle', loop, lambda u: u)
        qd = p.duration('quick_draw')
        self.clips['knife_draw'] = clip_frames(p, 'quick_draw', DRAW, lambda u: u * qd / DRAW)
        log('clip knife_idle: idle 0-%.3f s (its loop) in %.3f s' % (loop, loop))
        log('clip knife_draw: quick_draw 0-%.3f s in %.2f s (%.2fx)' % (qd, DRAW, qd / DRAW))
        self.strikes = {}
        for k, c in enumerate(SWINGS):
            our, f, strike, dur = swing_map(p, c)
            name = f'knife_swing_{k}'
            self.clips[name] = clip_frames(p, c, our, f)
            self.strikes[name] = WINDUP
            log(f'clip {name}: {c} 0-{strike:.3f} s (wind-up to its strike) in {WINDUP} s ({strike / WINDUP:.2f}x),'
                f' {strike:.3f}-{dur:.3f} s at {kk.SWING_SPEED}x: {our:.3f} s (cooldown {COOLDOWN} s)')
            if our > COOLDOWN:
                raise RuntimeError(f'{name} is longer than the cooldown')
        # How the pack's swings chain: each one's first pose against the others' last (hand_r, cm).
        ends = {c: self.clips[f'knife_swing_{k}'][-1]['hand_r'].translation for k, c in enumerate(SWINGS)}
        starts = {c: self.clips[f'knife_swing_{k}'][0]['hand_r'].translation for k, c in enumerate(SWINGS)}
        idle0 = self.clips['knife_idle'][0]['hand_r'].translation
        for c in SWINGS:
            log('chain: start of', c, 'from the idle', round((starts[c] - idle0).length * 100, 1), 'cm;',
                ', '.join(f'from the end of {d} {round((starts[c] - ends[d]).length * 100, 1)} cm' for d in SWINGS))
        # Where the knife sits in the hand (the socket against hand_r) and the eye's turn over the clips.
        i0 = self.clips['knife_idle'][0]
        rel = i0['hand_r'].inverted() @ i0['weapon']
        log('socket in hand_r (idle, cm, deg)', tuple(round(c * 100, 2) for c in rel.translation),
            round(math.degrees(rel.to_quaternion().angle), 1))
        log('hand_r from the eye at idle (cm, X right Y forward Z up)',
            tuple(round(c * 100, 1) for c in i0['hand_r'].translation),
            'hand_l', tuple(round(c * 100, 1) for c in i0['hand_l'].translation))

    # --- build ----------------------------------------------------------------------------------------

    def build(self):
        p = self.pack
        scene = bpy.context.scene
        rest_eye = p.sample('idle', [0.0])[0]['eye']
        self.rest_eye = rest_eye
        E = rest_eye.inverted()
        log('pack eye at rest (world)', tuple(round(c, 4) for c in rest_eye.translation), 'forward',
            tuple(round(c, 3) for c in rest_eye.col[1].to_3d()), 'up', tuple(round(c, 3) for c in rest_eye.col[2].to_3d()))
        self.sample_clips()

        data = bpy.data.armatures.new('rig_knife')
        arm = bpy.data.objects.new('rig_knife', data)
        scene.collection.objects.link(arm)
        bpy.context.view_layer.objects.active = arm
        arm.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        eb = data.edit_bones
        for n in self.bones + ['weapon']:
            b = eb.new(n)
            b.head, b.tail = (0, 0, 0), (0, 0.02, 0)
            b.matrix = E @ p.rest[n]
        for n in self.bones:
            par = p.parent[n]
            if par in self.bones:
                eb[n].parent = eb[par]
        eb['weapon'].parent = eb['hand_r']
        bpy.ops.object.mode_set(mode='OBJECT')
        self.arm = arm

        # Faces seen in some exported frame.
        pos, tris, weights = p.hands_mesh()
        pos = [E @ v for v in pos]
        keep = self.visible_faces(pos, tris, weights)
        hands = self.hands_object(pos, tris, weights, keep)
        kpos, ktris = p.knife_mesh_local()
        knife = self.knife_object(kpos, ktris)
        mesh = join([hands, knife], 'vm_knife')
        mesh.parent = arm
        mod = mesh.modifiers.new('Armature', 'ARMATURE')
        mod.object = arm
        with bpy.context.temp_override(object=mesh, active_object=mesh):
            bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
            bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
        used = {vg.name for vg in mesh.vertex_groups}
        log('vm_knife tris', tris_of(mesh.data), 'verts', len(mesh.data.vertices), 'bones', len(data.bones),
            'weighted', len(used))
        self.mesh = mesh
        self.write_clips()

    def visible_faces(self, pos, tris, weights):
        """Triangles with a corner inside the widened pack view in some frame of some exported clip (skinned with
        the pack's own weights)."""
        names = self.bones + ['weapon']
        bi = {n: i for i, n in enumerate(names)}
        P = np.array([tuple(v) + (1.0,) for v in pos], np.float64)               # (V, 4) rig space at rest
        W = np.zeros((len(pos), 4))
        J = np.zeros((len(pos), 4), np.int64)
        for i, ws in enumerate(weights):
            ws = sorted(ws, key=lambda x: -x[1])[:4]
            tot = sum(w for _, w in ws) or 1.0
            for k, (n, w) in enumerate(ws):
                J[i, k] = bi[n]
                W[i, k] = w / tot
        E = self.rest_eye.inverted()
        rest_inv = np.array([np.array((E @ self.pack.rest[n]).inverted()) for n in names])     # (B, 4, 4)
        th = math.tan(math.radians(kk.PACK_FOV / 2)) * VIS_MARGIN
        tw = th * VIS_ASPECT
        seen = np.zeros(len(pos), bool)
        frames = 0
        for clip, poses in self.clips.items():
            for pose in poses:
                M = np.array([np.array(pose[n]) for n in names]) @ rest_inv               # (B, 4, 4)
                Q = np.zeros((len(pos), 4))
                for k in range(4):
                    Q += W[:, k:k + 1] * np.einsum('vij,vj->vi', M[J[:, k]], P)
                x, y, z = Q[:, 0], Q[:, 1], Q[:, 2]
                seen |= (y > NEAR) & (np.abs(x) < tw * y) & (np.abs(z) < th * y)
                frames += 1
        keep = [i for i, (vs, _, _) in enumerate(tris) if any(seen[v] for v in vs)]
        log('visibility: frames', frames, 'vertices seen', int(seen.sum()), 'of', len(pos), '; triangles kept',
            len(keep), 'of', len(tris))
        return keep

    def hands_object(self, pos, tris, weights, keep):
        bm = bmesh.new()
        uvl = bm.loops.layers.uv.new('UVMap')
        dl = bm.verts.layers.deform.verify()
        groups = self.bones + ['weapon']
        gi = {n: i for i, n in enumerate(groups)}
        vmap, normals = {}, []
        glove_src = kk.glove_tris(self.pack)
        glove = set()
        rot = self.rest_eye.inverted().to_3x3()
        for t in keep:
            vs, uvs, nrms = tris[t]
            bvs = []
            for v, nr in zip(vs, nrms):
                nr = (rot @ nr).normalized()
                key = (v, tuple(round(c, 3) for c in nr))
                if key not in vmap:
                    bv = bm.verts.new(pos[v])
                    for n, w in weights[v]:
                        bv[dl][gi[n]] = w
                    vmap[key] = bv
                    normals.append(nr)
                bvs.append(vmap[key])
            try:
                f = bm.faces.new(bvs)
            except ValueError:
                continue
            f.index = len(bm.faces) - 1
            if t in glove_src:
                glove.add(f.index)
            for lp, uv in zip(f.loops, uvs):
                lp[uvl].uv = uv
        me = bpy.data.meshes.new('hands')
        bm.to_mesh(me)
        bm.free()
        # One normal per vertex (a vertex is split where the pack's normals differ): per-corner custom normals are
        # stored relative to each corner and come back slightly different, which made the exporter split every corner.
        me.normals_split_custom_set_from_vertices(normals)
        obj = bpy.data.objects.new('hands', me)
        bpy.context.scene.collection.objects.link(obj)
        for n in groups:
            obj.vertex_groups.new(name=n)
        self.atlas_hands(obj, glove)
        log('hands tris', tris_of(me), 'verts', len(me.vertices))
        return obj

    def knife_object(self, kpos, ktris):
        """The karambit on the weapon bone (its rest frame in rig space)."""
        w = self.arm.data.bones['weapon'].matrix_local
        nm = w.to_3x3()
        bm = bmesh.new()
        uvl = bm.loops.layers.uv.new('UVMap')
        vmap, normals = {}, []
        for vs, uvs, nrms in ktris:
            bvs = []
            for v, nr in zip(vs, nrms):
                nr = (nm @ nr).normalized()
                key = (v, tuple(round(c, 3) for c in nr))
                if key not in vmap:
                    vmap[key] = bm.verts.new(w @ kpos[v])
                    normals.append(nr)
                bvs.append(vmap[key])
            try:
                f = bm.faces.new(bvs)
            except ValueError:
                continue
            for lp, uv in zip(f.loops, uvs):
                lp[uvl].uv = uv
        me = bpy.data.meshes.new('karambit')
        bm.to_mesh(me)
        bm.free()
        me.normals_split_custom_set_from_vertices(normals)
        obj = bpy.data.objects.new('karambit', me)
        bpy.context.scene.collection.objects.link(obj)
        g = obj.vertex_groups.new(name='weapon')
        g.add(list(range(len(me.vertices))), 1.0, 'REPLACE')
        reg = rl.LAYOUTS['knife'][0]
        remap_rect(obj, dict(reg)['karambit'])
        rl.set_colour(obj, (1, 1, 1, 0))
        log('karambit tris', tris_of(me), 'verts', len(me.vertices))
        return obj

    def atlas_hands(self, obj, glove):
        """UVs into the atlas's hands region; vertex colours: the defender's glove and sleeve tints (by the pack's UV
        islands, knifekit.glove_tris)."""
        lay = dict(rl.LAYOUTS['knife'][0])
        me = obj.data
        remap_rect(obj, lay['hands'])
        cols = np.zeros((len(me.loops), 4), np.float32)
        for poly in me.polygons:
            c = kk.TINTS['defender']['glove' if poly.index in glove else 'sleeve']
            for li in poly.loop_indices:
                cols[li] = (*c, 0.0)
        for a in list(me.color_attributes):
            me.color_attributes.remove(a)
        attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
        attr.data.foreach_set('color', cols.ravel())
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = me.color_attributes.find('Col')
        log('hands: glove faces', len(glove), 'sleeve faces', len(me.polygons) - len(glove))

    def write_clips(self):
        # Every FBX import sets the scene to the pack's 60 fps; the clips are keyed and exported at 30.
        bpy.context.scene.render.fps = FPS
        bpy.context.scene.render.fps_base = 1.0
        for a in list(bpy.data.actions):
            bpy.data.actions.remove(a)
        self.loose = self.rigid()
        for name, frames in self.clips.items():
            self.action(name, frames)
            log('clip', name, round((len(frames) - 1) / FPS, 3), 's', len(frames), 'frames')

    def rigid(self):
        """Bones whose offset from their parent changes (more than 0.3 mm) in some exported frame keep location keys."""
        loose = set()
        worst = {}
        data = self.arm.data
        for n in self.bones + ['weapon']:
            par = data.bones[n].parent
            if par is None:
                continue
            ref = (par.matrix_local.inverted() @ data.bones[n].matrix_local).translation
            for frames in self.clips.values():
                for f in frames:
                    d = ((f[par.name].inverted() @ f[n]).translation - ref).length
                    worst[n] = max(worst.get(n, 0.0), d)
            if worst[n] > 0.0003:
                loose.add(n)
        log('joints that change length (keep location keys):', sorted(loose))
        return loose

    def action(self, name, frames):
        arm, data = self.arm, self.arm.data
        new = bpy.data.actions.new(name)
        rk.set_action(arm, new)
        loc_bones = {n for n in self.bones if data.bones[n].parent is None} | self.loose
        for f, mats in enumerate(frames):
            for bn in data.bones:
                n = bn.name
                pb = arm.pose.bones[n]
                if bn.parent:
                    par = bn.parent
                    basis = (mats[par.name] @ par.matrix_local.inverted() @ bn.matrix_local).inverted() @ mats[n]
                else:
                    basis = bn.matrix_local.inverted() @ mats[n]
                loc, rotq, _ = basis.decompose()
                pb.rotation_mode = 'QUATERNION'
                pb.location = loc if n in loc_bones else (0, 0, 0)
                pb.rotation_quaternion = rotq
                pb.scale = (1, 1, 1)
                if n in loc_bones:
                    pb.keyframe_insert('location', frame=f, group=n)
                pb.keyframe_insert('rotation_quaternion', frame=f, group=n)
        new.use_fake_user = True
        return new

    # --- export ---------------------------------------------------------------------------------------

    def export(self):
        rk.set_action(self.arm, bpy.data.actions['knife_idle'])
        bpy.context.scene.frame_set(0)
        rl.single_material(self.mesh, 'knife')
        for o in bpy.data.objects:
            o.select_set(o in (self.arm, self.mesh))
        bpy.context.view_layer.objects.active = self.arm
        bpy.ops.export_scene.gltf(
            filepath=OUT, export_format='GLB', use_selection=True, export_yup=True, export_texcoords=True,
            export_normals=True, export_tangents=False, export_vertex_color='ACTIVE', export_all_vertex_colors=False,
            export_materials='EXPORT', export_image_format='NONE', export_skins=True, export_all_influences=False,
            export_def_bones=False, export_animations=True, export_animation_mode='ACTIONS',
            export_force_sampling=True, export_optimize_animation_size=True, export_anim_slide_to_zero=False,
            export_morph=False, export_extras=False, export_cameras=False, export_lights=False)
        log('wrote', OUT, os.path.getsize(OUT), 'bytes')
        rl.quantize(OUT)
        weld(OUT)
        share_ghost(OUT)
        log('final', OUT, os.path.getsize(OUT), 'bytes')


def join(objs, name):
    first = objs[0]
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = first
    with bpy.context.temp_override(active_object=first, selected_editable_objects=objs, selected_objects=objs):
        bpy.ops.object.join()
    first.name = first.data.name = name
    return first


def remap_rect(obj, rect):
    me = obj.data
    uv = np.zeros(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = np.clip(uv.reshape(-1, 2), 0, 1)
    u0, v0, u1, v1 = rect
    uv[:, 0] = u0 + uv[:, 0] * (u1 - u0)
    uv[:, 1] = v0 + uv[:, 1] * (v1 - v0)
    for layer in list(me.uv_layers):
        me.uv_layers.remove(layer)
    me.uv_layers.new(name='UVMap').data.foreach_set('uv', uv.ravel())


# ---------------------------------------------------------------------------------------------
# GLB post-passes (after tools/quantize-glb.mjs)

COMP = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    with open(path, 'rb') as f:
        b = f.read()
    jl = struct.unpack_from('<I', b, 12)[0]
    g = json.loads(b[20:20 + jl])
    bl = struct.unpack_from('<I', b, 20 + jl)[0]
    return g, bytes(b[28 + jl:28 + jl + bl])


def write_glb(path, g, chunks):
    """Writes `g` with a binary chunk rebuilt from `chunks` ({bufferView index: bytes}); views no accessor uses are
    dropped and the rest renumbered."""
    used = sorted({a['bufferView'] for a in g['accessors'] if 'bufferView' in a})
    renum = {old: new for new, old in enumerate(used)}
    views, out = [], bytearray()
    for old in used:
        v = dict(g['bufferViews'][old])
        while len(out) % 4:
            out.append(0)
        v['byteOffset'] = len(out)
        v['byteLength'] = len(chunks[old])
        out += chunks[old]
        views.append(v)
    for a in g['accessors']:
        if 'bufferView' in a:
            a['bufferView'] = renum[a['bufferView']]
    g['bufferViews'] = views
    while len(out) % 4:
        out.append(0)
    g['buffers'] = [{'byteLength': len(out)}]
    js = json.dumps(g, separators=(',', ':')).encode('utf8')
    while len(js) % 4:
        js += b' '
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack('<II', len(out), 0x004E4942))
        f.write(out)


def view_chunks(g, bin_):
    return {i: bin_[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
            for i, v in enumerate(g['bufferViews'])}


def accessor_rows(g, bin_, i):
    """An accessor's elements as a (count, element bytes) uint8 array."""
    a = g['accessors'][i]
    v = g['bufferViews'][a['bufferView']]
    size = COMP[a['componentType']] * NCOMP[a['type']]
    stride = v.get('byteStride', size)
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    raw = np.frombuffer(bin_, np.uint8, count=stride * (a['count'] - 1) + size, offset=start)
    return np.lib.stride_tricks.as_strided(raw, (a['count'], size), (stride, 1)).copy()


def weld(path):
    """Merges vertices whose stored attributes are identical byte for byte. Blender keeps custom normals per corner
    and they come back very slightly different at each corner, so its exporter writes a vertex per corner; once the
    normals are stored as bytes those copies are identical. The pack's normals are kept as authored."""
    g, bin_ = read_glb(path)
    chunks = view_chunks(g, bin_)
    for m in g['meshes']:
        for prim in m['primitives']:
            names = sorted(prim['attributes'])
            rows = [accessor_rows(g, bin_, prim['attributes'][n]) for n in names]
            key = np.ascontiguousarray(np.hstack(rows))
            _, first, inverse = np.unique(key.view(np.dtype((np.void, key.shape[1]))).ravel(), return_index=True,
                                          return_inverse=True)
            order = np.argsort(first)
            rank = np.empty_like(order)
            rank[order] = np.arange(len(order))
            keep = first[order]
            remap = rank[inverse.ravel()]
            for n, r in zip(names, rows):
                ai = prim['attributes'][n]
                a = g['accessors'][ai]
                g['bufferViews'].append({'buffer': 0, 'byteLength': 0, 'target': 34962})
                chunks[len(g['bufferViews']) - 1] = r[keep].tobytes()
                a['bufferView'] = len(g['bufferViews']) - 1
                a['byteOffset'] = 0
                a['count'] = int(len(keep))
            ia = g['accessors'][prim['indices']]
            idx = accessor_rows(g, bin_, prim['indices']).view(
                {5121: np.uint8, 5123: np.uint16, 5125: np.uint32}[ia['componentType']]).ravel()
            new = remap[idx].astype(np.uint16 if len(keep) < 65536 else np.uint32)
            g['bufferViews'].append({'buffer': 0, 'byteLength': 0, 'target': 34963})
            chunks[len(g['bufferViews']) - 1] = new.tobytes()
            ia.update({'bufferView': len(g['bufferViews']) - 1, 'byteOffset': 0,
                       'componentType': 5123 if new.dtype == np.uint16 else 5125})
            log('weld', m.get('name'), len(first) if False else len(inverse.ravel()), '->', len(keep), 'vertices')
    write_glb(path, g, chunks)


# ---------------------------------------------------------------------------------------------
# The ghost look: a second mesh node sharing vm_knife's vertex data, with its own colours

def share_ghost(path):
    """Adds the node and mesh "vm_ghost" to the GLB: the same primitive as vm_knife (positions, normals, UVs, joints,
    weights, indices: the same accessors, so no extra bytes) but its own COLOR_0, each defender tint swapped for the
    matching ghost tint (knifekit.TINTS); same skin, same parent."""
    with open(path, 'rb') as f:
        b = f.read()
    jl = struct.unpack_from('<I', b, 12)[0]
    g = json.loads(b[20:20 + jl])
    bl = struct.unpack_from('<I', b, 20 + jl)[0]
    bin_ = bytearray(b[28 + jl:28 + jl + bl])
    mi = next(i for i, m in enumerate(g['meshes']) if m.get('name') == 'vm_knife')
    ni = next(i for i, n in enumerate(g['nodes']) if n.get('mesh') == mi)
    prim = g['meshes'][mi]['primitives'][0]
    acc = g['accessors'][prim['attributes']['COLOR_0']]
    if acc['componentType'] != 5121 or acc['type'] != 'VEC4' or not acc.get('normalized'):
        raise RuntimeError(f'unexpected COLOR_0 {acc}')
    bv = g['bufferViews'][acc['bufferView']]
    start = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    stride = bv.get('byteStride', 4)
    pairs = kk.ghost_pairs()
    out = bytearray()
    misses = 0
    for i in range(acc['count']):
        c = bytes(bin_[start + i * stride:start + i * stride + 4])
        # The defender tint this corner carries (within 3 of 255 per channel after the export's round trip).
        hit = next((gb for db, gb in pairs if max(abs(x - y) for x, y in zip(c, db)) <= 3), None)
        if hit is not None:
            out += hit
        else:
            misses += 1
            out += c
    if misses:
        log('share_ghost: colours kept as they are (knife or unknown):', misses)
    while len(bin_) % 4:
        bin_.append(0)
    g['bufferViews'].append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': len(out), 'target': 34962})
    bin_ += out
    g['accessors'].append({'bufferView': len(g['bufferViews']) - 1, 'componentType': 5121, 'normalized': True,
                           'count': acc['count'], 'type': 'VEC4'})
    gprim = json.loads(json.dumps(prim))
    gprim['attributes']['COLOR_0'] = len(g['accessors']) - 1
    g['meshes'].append({'name': 'vm_ghost', 'primitives': [gprim]})
    node = dict(g['nodes'][ni])
    node['name'] = 'vm_ghost'
    node['mesh'] = len(g['meshes']) - 1
    node.pop('children', None)
    g['nodes'].append(node)
    gi = len(g['nodes']) - 1
    parent = next((n for n in g['nodes'] if ni in n.get('children', [])), None)
    if parent is not None:
        parent['children'].append(gi)
    else:
        for s in g['scenes']:
            if ni in s['nodes']:
                s['nodes'].append(gi)
    g['buffers'][0]['byteLength'] = len(bin_)
    js = json.dumps(g, separators=(',', ':')).encode('utf8')
    while len(js) % 4:
        js += b' '
    while len(bin_) % 4:
        bin_.append(0)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack('<II', len(bin_), 0x004E4942))
        f.write(bin_)
    log('share_ghost: vm_ghost added,', acc['count'], 'colours,', len(out), 'bytes')


# ---------------------------------------------------------------------------------------------
# Previews

SHOTS = [('knife_idle', 0.0, 'idle'), ('knife_draw', 0.0, 'draw-0'), ('knife_draw', 0.12, 'draw-1'),
         ('knife_draw', 0.22, 'draw-2')]
for _k in range(4):
    SHOTS += [(f'knife_swing_{_k}', 0.0, f'swing{_k}-0-start'), (f'knife_swing_{_k}', 0.1, f'swing{_k}-1-windup'),
              (f'knife_swing_{_k}', 0.2, f'swing{_k}-2-strike'), (f'knife_swing_{_k}', 0.27, f'swing{_k}-3-after'),
              (f'knife_swing_{_k}', 0.7, f'swing{_k}-4-end')]


def preview(rig, out_dir, views):
    scene = bpy.context.scene
    arm = rig.arm
    cam_data = bpy.data.cameras.new('preview')
    cam_data.sensor_fit = 'VERTICAL'
    cam_data.clip_start = NEAR / 2
    cam = bpy.data.objects.new('preview', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.matrix_world = Matrix.Rotation(math.radians(90), 4, 'X')
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'VERTEX'
    scene.display.shading.show_cavity = True
    scene.render.resolution_x, scene.render.resolution_y = 1366, 768
    scene.render.resolution_percentage = 60
    scene.render.image_settings.file_format = 'JPEG'
    os.makedirs(out_dir, exist_ok=True)
    for view, fov in views.items():
        cam_data.angle_y = math.radians(fov)
        for action, t, stem in SHOTS:
            if view != 'pack' and not stem.startswith(('idle', 'swing0-2', 'swing1-2')):
                continue
            rk.set_action(arm, bpy.data.actions[action])
            scene.frame_set(int(round(t * FPS)))
            scene.render.filepath = os.path.join(out_dir, f'{view}-{stem}.jpg')
            bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def main():
    rest = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    rig = Rig()
    rig.build()
    if '--preview' in rest:
        preview(rig, os.path.abspath(rest[rest.index('--preview') + 1]), {'pack': kk.PACK_FOV, 'vm74': 74.0})
    if '--no-export' not in rest:
        rig.export()


main()
