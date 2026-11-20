"""
Package T: the first-person rifle rig, client/public/models/viewmodel_rifle.glb, built from the owner's
"M4 - FPS Weapon Animations Pack FREE (v.1)" exactly as authored: the pack's own arms (bare forearms, fingerless
gloves), its own skeleton and bind pose, its own M4 and its own clips. Nothing is retargeted; the clips are only
resampled at the speeds the game's rules need.

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup \
        --python tools/blender/fpm4.py [-- --preview <dir> [--aim 0.08,0.2] [--try '{"name": [[x, y, z], [p, y, r]]}']
        [--no-export]]
  --preview: Workbench renders of the clips at the pack's own hold ("pack-") and ours ("ours-"); --aim: the aimed
  views, plus iron sights at other eye distances; --try: reload frames at other hip poses (PlayCanvas pose);
  --no-export: leave viewmodel_rifle.glb alone.

Needs weapons.py to have run first (its git-ignored build/weapons_fp.glb holds the M4's parts, the sights and the
suppressor with UVs into the rifle atlas, the muzzles and the aim points, all in the shipped gun frame).

The rig (one skinned mesh, one draw call, the rifle atlas's material):
  - the pack's arm joints (RightForeArm, RightHand, RightHandIndex1-4, ... and the same on the left; its upper arms
    carry no skin and are left out), with the pack's bind pose (its inverse bind matrices), so its arms deform exactly
    as in the pack;
  - "weapon" (the shipped gun frame: X right, Y muzzle, Z up, origin at the grip) and under it the M4's moving parts
    "mag" (the magazine), "round" (its top round), "bolt", "catch" (the bolt catch), "trigger", plus "rearsight" (the
    folding rear sight, shrunk away by the client when an optic is mounted), "sup" (suppressor) and
    "sight_reddot" / "sight_scope2x" (shrunk away unless mounted);
  - empties "muzzle", "muzzle_bare" and "aim_<sight>" under the weapon bone.
Rig space: the pack's world seen from the gun frame at the idle hold, so the rig's origin is the grip at idle and the
client places it at its hip pose (presenter.ts VM_LOOKS.rifle.hip) or on the sight line when aiming.

Clips (30 fps, every bone keyed on every frame, linear; times are the pack's, scaled to our rules):
  rifle_idle            the pack's first frame (Reload at 0 s)
  rifle_idle_empty      the same with the bolt locked back on the bolt catch and the empty magazine's follower up
                        (the pack's Reload_Empty at 0 s): shown while the magazine is empty
  rifle_reload          Reload 0-2.95 s in 2.2 s (1.34x; the pack's motion ends there)
  rifle_reload_empty    Reload_Empty 0-3.45 s in 2.7 s (1.28x): starts locked back, the left hand slaps the bolt catch
  rifle_draw            Draw 0-0.70 s in 0.4 s (1.75x)
  rifle_fire            Fire 0-0.30 s in 0.1 s (3x; one shot at the rule's 10 rounds a second: trigger, bolt, kick)
  rifle_fire_empty      the same for the shot that empties the magazine: the bolt stays back and the catch rises
The last END_FADE of each moving clip blends onto the idle pose exactly, so the switch to rifle_idle never pops.
The pack's Holster (0.57 s) is not exported: a weapon switch has no holster time in the rules (the new weapon starts
drawing at once), so it could only play by delaying the new weapon or as a rule change.
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fpanims  # noqa: E402
import m4  # noqa: E402
import packhands  # noqa: E402
import realistic as rl  # noqa: E402
import rigkit as rk  # noqa: E402

ROOT = rl.ROOT
OUT = os.path.join(ROOT, 'client', 'public', 'models', 'viewmodel_rifle.glb')
FPS = 30
END_FADE = 0.08
# (our clip, pack clip, pack seconds used, our seconds): our seconds are the rules' (shared/weapons.ts).
CLIPS = [
    ('rifle_reload', 'Reload', 2.95, 2.2),
    ('rifle_reload_empty', 'Reload_Empty', 3.45, 2.7),
    ('rifle_draw', 'Draw', 0.70, 0.4),
    ('rifle_fire', 'Fire', 0.30, 0.1),
]
# The shot that empties the magazine: from this pack time on the bolt stays back (where Reload_Empty starts) and the
# bolt catch rises under it over CATCH_RISE seconds (pack time).
LOCK_FROM = 0.10
CATCH_RISE = 0.03
# The pack's mesh space (glTF: Y up, centimetres) to Blender rig axes.
C = fpanims.TO_BLENDER @ Matrix.Scale(0.01, 4)
# The hip pose the owner approved for the AK (package O third follow-up), and the hip pose the pack itself frames
# (computed below from its eye). Previews render both; presenter.ts uses the one chosen (see HANDOFF "Package T").
HIP_OURS = ((0.155, -0.168, -0.155), (2, 11, -1))


def log(*a):
    print('[fpm4]', *a, flush=True)


def tris(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def clean(name):
    return name.rsplit('_', 1)[0]


class Arms:
    """The pack's two skinned meshes (hands and gloves), their joints and bind matrices."""

    def __init__(self, pack):
        g = pack.g
        self.bind = {}                  # clean joint name -> bind matrix (mesh space, cm)
        self.node = {}                  # clean joint name -> pack node name
        self.prims = []
        for mesh_i in (0, 1):
            prim = g['meshes'][mesh_i]['primitives'][0]
            skin = g['skins'][mesh_i]
            names = []
            for k, j in enumerate(skin['joints']):
                n = clean(pack.nodes[j]['name'])
                names.append(n)
                self.node[n] = pack.nodes[j]['name']
            ibm = pack._read(skin['inverseBindMatrices'])
            for n, m in zip(names, ibm):
                self.bind[n] = Matrix([[m[c * 4 + r] for c in range(4)] for r in range(4)]).inverted()
            self.prims.append({
                'material': g['materials'][prim['material']]['name'],
                'pos': [Vector(v) for v in pack._read(prim['attributes']['POSITION'])],
                'nrm': [Vector(v) for v in pack._read(prim['attributes']['NORMAL'])],
                'uv': [(u, 1.0 - v) for u, v in pack._read(prim['attributes']['TEXCOORD_0'])],
                'joints': [[names[j] for j in js] for js in pack._read(prim['attributes']['JOINTS_0'])],
                'weights': pack._read(prim['attributes']['WEIGHTS_0']),
                'tris': pack._read(prim['indices']),
            })
        # Parents among the skinned joints (the pack's hierarchy).
        self.parent = {}
        for n, full in self.node.items():
            i = pack.index[full]
            p = pack.parent.get(i)
            while p is not None and clean(pack.nodes[p].get('name', '')) not in self.node:
                p = pack.parent.get(p)
            self.parent[n] = clean(pack.nodes[p]['name']) if p is not None else None
        # Parents before children.
        order = []
        while len(order) < len(self.node):
            for n in sorted(self.node):
                if n not in order and (self.parent[n] is None or self.parent[n] in order):
                    order.append(n)
        self.order = order

    def rest(self, n):
        """A joint's bind pose in Blender rig axes (metres, unit scale)."""
        return m4.unit(C @ self.bind[n])

    def mesh(self):
        """Both pack meshes as one Blender object at the bind pose, vertex groups per joint, materials Glove_D and
        Hand_D, custom normals, a white corner colour."""
        bm = bmesh.new()
        uvl = bm.loops.layers.uv.new('UVMap')
        dl = bm.verts.layers.deform.verify()
        mats, normals = [], []
        groups = sorted(self.node)
        gi = {n: i for i, n in enumerate(groups)}
        rot = C.to_3x3().normalized()
        for prim in self.prims:
            if prim['material'] not in mats:
                mats.append(prim['material'])
            mi = mats.index(prim['material'])
            vs = []
            for v, js, ws in zip(prim['pos'], prim['joints'], prim['weights']):
                bv = bm.verts.new(C @ v)
                for j, w in zip(js, ws):
                    if w > 0:
                        bv[dl][gi[j]] = bv[dl].get(gi[j], 0.0) + w
                vs.append(bv)
            t = prim['tris']
            for k in range(0, len(t), 3):
                a, b, c = t[k:k + 3]
                try:
                    f = bm.faces.new((vs[a], vs[b], vs[c]))
                except ValueError:
                    continue
                f.material_index = mi
                for lp, idx in zip(f.loops, (a, b, c)):
                    lp[uvl].uv = prim['uv'][idx]
                    normals.append((rot @ prim['nrm'][idx]).normalized())
        me = bpy.data.meshes.new('pack_arms')
        bm.to_mesh(me)
        bm.free()
        for m in mats:
            me.materials.append(bpy.data.materials.get(m) or bpy.data.materials.new(m))
        me.normals_split_custom_set(normals)
        obj = bpy.data.objects.new('pack_arms', me)
        bpy.context.scene.collection.objects.link(obj)
        for n in groups:
            obj.vertex_groups.new(name=n)
        rl.set_colour(obj, (1, 1, 1, 0))
        return obj


def import_parts():
    """weapons.py's first-person parts file: {name without 'fp_gun_' (the body: 'body'): object} for the rifle."""
    if not os.path.exists(rl.FP_GLB):
        raise FileNotFoundError(f'{rl.FP_GLB} is missing: run tools/blender/weapons.py first')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=rl.FP_GLB)
    bpy.context.view_layer.update()
    out = {}
    for o in set(bpy.data.objects) - before:
        n = o.name.split('.')[0]
        if n == 'fp_gun':
            out['body'] = o
        elif n.startswith('fp_gun_'):
            out[n[len('fp_gun_'):]] = o
        else:
            bpy.data.objects.remove(o)
    for o in out.values():
        if o.type == 'MESH':
            mw = o.matrix_world.copy()
            o.parent = None
            o.data.transform(mw)
            o.matrix_world = Matrix()
            corner_colours(o)
    return out


def corner_colours(obj):
    me = obj.data
    src = me.color_attributes.active_color or (me.color_attributes[0] if len(me.color_attributes) else None)
    n = len(me.loops)
    vals = [1.0, 1.0, 1.0, 0.0] * n
    if src is not None:
        if src.domain == 'CORNER':
            vals = [c for d in src.data for c in d.color]
        else:
            per_v = [tuple(d.color) for d in src.data]
            vals = [c for lp in me.loops for c in per_v[lp.vertex_index]]
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    attr.data.foreach_set('color', vals)
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find('Col')


def join(objs, name):
    first = objs[0]
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = first
    with bpy.context.temp_override(active_object=first, selected_editable_objects=objs, selected_objects=objs):
        bpy.ops.object.join()
    first.name = first.data.name = name
    return first


# Part bones: name -> pack joint (None: rigid on the weapon bone, at its own centre).
PART_JOINTS = {'mag': m4.MAG, 'round': m4.ROUND, 'bolt': m4.BOLT, 'catch': m4.CATCH, 'trigger': m4.TRIGGER}
STATIC_PARTS = ('rearsight', 'sup', 'sight_reddot', 'sight_scope2x')


class Rig:
    def __init__(self):
        self.m = m4.M4()
        self.p = self.m.p
        self.arms = Arms(self.p)
        self.G = self.m.F0i            # pack world -> rig space

    # --- poses (rig space) --------------------------------------------------------------------------

    def joint_pose(self, joint, clip, t):
        return self.G @ self.m.joint(joint, clip, t)

    def pose(self, clip, t):
        """{bone: rig-space matrix} at `t` seconds of the pack's `clip`."""
        out = {}
        for n in self.arms.order:
            out[n] = self.joint_pose(self.arms.node[n], clip, t)
        gun = self.G @ self.m.frame(clip, t)
        out['weapon'] = gun
        for b, j in PART_JOINTS.items():
            m = self.joint_pose(j, clip, t)
            if b == 'round':
                s = self.m.scale(j, clip, t) / self.round_scale0
                m = m @ Matrix.Scale(s, 4)
            out[b] = m
        for b in STATIC_PARTS:
            if b in self.static_rest:
                out[b] = gun @ self.static_rest[b]
        return out

    def locked(self, pose_, src):
        """`pose_` with the bolt, bolt catch and round where they sit in `src` (a pose), relative to the gun."""
        out = dict(pose_)
        for b in ('bolt', 'catch', 'round'):
            out[b] = pose_['weapon'] @ src['weapon'].inverted() @ src[b]
        return out

    # --- build --------------------------------------------------------------------------------------

    def build(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scene = bpy.context.scene
        scene.render.fps = FPS
        self.round_scale0 = self.m.scale(m4.ROUND, *m4.IDLE)
        parts = import_parts()
        log('parts', sorted(parts))
        self.static_rest = {}
        bone_heads = {}
        for b in STATIC_PARTS:
            key = {'sup': 'suppressor'}.get(b, b)
            if key in parts:
                pts = [v.co for v in parts[key].data.vertices]
                c = sum(pts, Vector()) / len(pts)
                self.static_rest[b] = Matrix.Translation(c)
        # The armature: the pack's joints at its bind pose, the gun's bones at the idle pose.
        data = bpy.data.armatures.new('rig_rifle')
        arm = bpy.data.objects.new('rig_rifle', data)
        scene.collection.objects.link(arm)
        bpy.context.view_layer.objects.active = arm
        arm.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        eb = data.edit_bones
        idle = self.pose(*m4.IDLE)
        for n in self.arms.order:
            b = eb.new(n)
            b.head, b.tail = (0, 0, 0), (0, 0.02, 0)
            b.matrix = self.arms.rest(n)
        for n in self.arms.order:
            if self.arms.parent[n]:
                eb[n].parent = eb[self.arms.parent[n]]
        b = eb.new('weapon')
        b.head, b.tail = (0, 0, 0), (0, 0.05, 0)
        for n in list(PART_JOINTS) + [s for s in STATIC_PARTS if s in self.static_rest]:
            b = eb.new(n)
            b.head, b.tail = (0, 0, 0), (0, 0.02, 0)
            b.matrix = idle[n]
            b.parent = eb['weapon']
        bpy.ops.object.mode_set(mode='OBJECT')
        self.arm = arm

        # One mesh: the pack's arms (skinned as in the pack) and every gun part bound rigidly to its bone.
        arms_obj = self.arms.mesh()
        lay = rl.ARM_LAYOUTS_PACK['rifle']
        atlas = rl.Atlas('rifle', [rl.Region('glove', lay['glove']),
                                   rl.Region('handskin', lay['handskin'], crop=m4.skin_crop())], (0, 0, 0, 0))
        atlas.remap(arms_obj, material_region={'Glove_D': 'glove', 'Hand_D': 'handskin'})
        rl.single_material(arms_obj, 'rifle')
        log('arms tris', tris(arms_obj.data), 'verts', len(arms_obj.data.vertices), 'joints', len(self.arms.order))
        bind = {'body': 'weapon', 'suppressor': 'sup'}
        objs = [arms_obj]
        for key, o in parts.items():
            if o.type != 'MESH':
                continue
            bone = bind.get(key, key)
            if bone not in data.bones:
                log('WARNING part without a bone:', key)
                continue
            for vg in list(o.vertex_groups):
                o.vertex_groups.remove(vg)
            g = o.vertex_groups.new(name=bone)
            g.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')
            rl.single_material(o, 'rifle')
            objs.append(o)
            log('part', key, '->', bone, 'tris', tris(o.data))
        mesh = join(objs, 'vm_rifle')
        mesh.parent = arm
        mod = mesh.modifiers.new('Armature', 'ARMATURE')
        mod.object = arm
        with bpy.context.temp_override(object=mesh, active_object=mesh):
            bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
            bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
        log('vm_rifle tris', tris(mesh.data), 'verts', len(mesh.data.vertices))
        self.mesh = mesh

        # Empties on the weapon bone (muzzles, aim points), from the parts file (already in the shipped frame).
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=rl.FP_GLB)
        bpy.context.view_layer.update()
        empties = []
        new = set(bpy.data.objects) - before
        for o in new:
            n = o.name.split('.')[0]
            if o.type == 'EMPTY' and (n.startswith('fp_gun_muzzle') or n.startswith('fp_gun_aim_')):
                loc = o.matrix_world.translation.copy()
                e = bpy.data.objects.new(n[len('fp_gun_'):], None)
                scene.collection.objects.link(e)
                e.parent = arm
                e.parent_type = 'BONE'
                e.parent_bone = 'weapon'
                bpy.context.view_layer.update()
                e.matrix_world = Matrix.Translation(loc)
                empties.append(e)
        for o in new:
            bpy.data.objects.remove(o)
        self.empties = empties
        log('empties', sorted(e.name for e in empties))
        for a in list(bpy.data.actions):
            bpy.data.actions.remove(a)

        self.write_clips()

    # --- clips --------------------------------------------------------------------------------------

    def write_clips(self):
        self.loose = self.rigid()
        idle = self.pose(*m4.IDLE)
        empty0 = self.pose('Reload_Empty', 0.0)
        idle_empty = self.locked(idle, empty0)
        self.action('rifle_idle', [idle, idle])
        self.action('rifle_idle_empty', [idle_empty, idle_empty])
        for name, clip, src_s, our_s in CLIPS:
            n = max(1, int(round(our_s * FPS)))
            frames = []
            for i in range(n + 1):
                u = i / n
                pose_ = self.pose(clip, u * src_s)
                w = rk.smooth((u - (1 - END_FADE)) / END_FADE) if u > 1 - END_FADE else 0.0
                if w > 0:
                    pose_ = {b: rk.lerp_frame_scaled(pose_[b], idle[b], w) for b in pose_}
                frames.append(pose_)
            self.action(name, frames)
            log('clip', name, 'from', clip, f'0-{src_s} s', 'in', our_s, 's', f'({src_s / our_s:.2f}x)', 'frames', n + 1)
            if name == 'rifle_fire':
                # The magazine's last round: the same shot, then the bolt held back on the catch.
                ef = []
                for i in range(n + 1):
                    t = i / n * src_s
                    pose_ = self.pose(clip, t)
                    if t >= LOCK_FROM:
                        locked = self.locked(pose_, empty0)
                        k = min(1.0, (t - LOCK_FROM) / CATCH_RISE)
                        locked['catch'] = rk.lerp_frame(pose_['catch'], locked['catch'], k)
                        pose_ = locked
                    ef.append(pose_)
                # It ends on the empty idle.
                self.action('rifle_fire_empty', ef[:-1] + [idle_empty])
        self.cues()

    def action(self, name, frames):
        """Keys every bone on every frame: rotation always; location only where a bone moves against its parent (the
        arm roots and the gun parts: the pack's finger and hand joints keep their lengths, checked in `rigid`), scale
        only on the bones that are scaled (the round, and the parts the client shrinks away). Fewer channels keep the
        file small (every channel costs accessor entries in the glTF's JSON)."""
        arm, data = self.arm, self.arm.data
        new = bpy.data.actions.new(name)
        rk.set_action(arm, new)
        loc_bones = {n for n in self.arms.order if not self.arms.parent[n]} | {'weapon'} | set(PART_JOINTS) | self.loose
        scale_bones = {'round'} | set(STATIC_PARTS)
        for f, mats in enumerate(frames):
            for bn in data.bones:
                n = bn.name
                pb = arm.pose.bones[n]
                if bn.parent:
                    par = bn.parent
                    basis = (mats[par.name] @ par.matrix_local.inverted() @ bn.matrix_local).inverted() @ mats[n]
                else:
                    basis = bn.matrix_local.inverted() @ mats[n]
                loc, rotq, scl = basis.decompose()
                pb.rotation_mode = 'QUATERNION'
                pb.location = loc if n in loc_bones else (0, 0, 0)
                pb.rotation_quaternion = rotq
                pb.scale = scl if n in scale_bones else (1, 1, 1)
                if n in loc_bones:
                    pb.keyframe_insert('location', frame=f, group=n)
                pb.keyframe_insert('rotation_quaternion', frame=f, group=n)
                if n in scale_bones:
                    pb.keyframe_insert('scale', frame=f, group=n)
        new.use_fake_user = True
        return new

    def rigid(self):
        """Arm joints whose offset from their parent changes in some clip by more than 0.3 mm (they keep location
        keys); logged."""
        loose = set()
        worst = 0.0
        for n in self.arms.order:
            par = self.arms.parent[n]
            if not par:
                continue
            ref = None
            for clip in fpanims.CLIPS:
                for k in range(0, 31):
                    t = self.p.duration(clip) * k / 30
                    off = (self.joint_pose(self.arms.node[par], clip, t).inverted()
                           @ self.joint_pose(self.arms.node[n], clip, t)).translation
                    ref = ref or off
                    d = (off - ref).length
                    worst = max(worst, d)
                    if d > 0.0003:
                        loose.add(n)
        log('arm joints that change length (keep location keys):', sorted(loose), 'largest change (mm)',
            round(worst * 1000, 2))
        return loose

    def cues(self):
        """Pack events at our clips' times (for audio-logic.ts RELOAD_CUES and presenter.ts jolts)."""
        def find(clip, src_s, our_s, test, step=1 / 120):
            t = 0.0
            while t <= src_s:
                if test(clip, t):
                    return round(t * our_s / src_s, 3), round(t, 3)
                t += step
            return None

        def mag_off(d):
            return lambda clip, t: (self.p.in_gun(m4.MAG, clip, t).translation
                                    - self.p.in_gun(m4.MAG, clip, 0).translation).length > d

        for name, clip, src_s, our_s in CLIPS[:2]:
            out = find(clip, src_s, our_s, mag_off(0.01))
            t_out = out[1] if out else 0
            seat = find(clip, src_s, our_s, lambda c, t: t > t_out + 0.3 and not mag_off(0.003)(c, t))
            log('pack cues', name, 'magazine leaves (ours, pack s)', out, 'magazine seated', seat)
        bolt0 = self.p.in_gun(m4.BOLT, 'Reload', 0).translation
        home = find('Reload_Empty', 3.45, 2.7,
                    lambda c, t: t > 1 and (self.p.in_gun(m4.BOLT, c, t).translation - bolt0).length < 0.005)
        catch = find('Reload_Empty', 3.45, 2.7, lambda c, t: t > 1 and (
            self.p.in_gun(m4.CATCH, c, t).to_quaternion().rotation_difference(
                self.p.in_gun(m4.CATCH, 'Reload', 0).to_quaternion()).angle < math.radians(1)))
        log('pack cues rifle_reload_empty: bolt catch released', catch, 'bolt home', home)

    # --- export -------------------------------------------------------------------------------------

    def export(self):
        rk.set_action(self.arm, bpy.data.actions['rifle_idle'])
        bpy.context.scene.frame_set(0)
        for o in bpy.data.objects:
            o.select_set(True)
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

    # --- framing ------------------------------------------------------------------------------------

    def pack_hip(self):
        """The pack's own hold: the gun frame at idle seen from the pack's eye, as a PlayCanvas pose."""
        cam = self.m.camera()
        k = cam.inverted() @ self.m.F0
        pos, eul = m4.pc_from_blender(k)
        return tuple(round(x, 4) for x in pos), tuple(round(a, 2) for a in eul)


def lerp_frame_scaled(a, b, w):
    """rigkit.lerp_frame keeping scale (the round shrinks while the magazine is empty)."""
    la, ra, sa = a.decompose()
    lb, rb, sb = b.decompose()
    return Matrix.LocRotScale(la.lerp(lb, w), ra.slerp(rb, w), sa.lerp(sb, w))


rk.lerp_frame_scaled = lerp_frame_scaled


def preview(rig, out_dir, hips, shots):
    """Camera-view Workbench renders: the camera at the origin looking along +Y, vertical field of view 74 degrees
    (the game's default), 1366 x 768 at 60 %; the rig at each hip pose."""
    scene = bpy.context.scene
    arm = rig.arm
    cam_data = bpy.data.cameras.new('preview')
    cam_data.sensor_fit = 'VERTICAL'
    cam_data.angle_y = math.radians(74)
    cam_data.clip_start = 0.01
    cam = bpy.data.objects.new('preview', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'VERTEX'
    scene.display.shading.show_cavity = True
    scene.render.resolution_x, scene.render.resolution_y = 1366, 768
    scene.render.resolution_percentage = 60
    scene.render.image_settings.file_format = 'JPEG'
    os.makedirs(out_dir, exist_ok=True)
    for hip_name, (pos, eul) in hips.items():
        arm.matrix_world = rk.pc_pose(pos, eul)
        for action, t, stem, side in shots:
            rk.set_action(arm, bpy.data.actions[action])
            scene.frame_set(int(round(t * FPS)))
            if side:
                target = arm.matrix_world @ Vector((0, 0.08, 0.05))
                eye = target + Vector(side)
                cam.matrix_world = Matrix.Translation(eye) @ (target - eye).to_track_quat('-Z', 'Y').to_matrix().to_4x4()
            else:
                cam.matrix_world = Matrix.Rotation(math.radians(90), 4, 'X')
            scene.render.filepath = os.path.join(out_dir, f'{hip_name}-{stem}.jpg')
            bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    arm.matrix_world = Matrix()


SHOTS = [
    ('rifle_idle', 0, 'idle', None),
    ('rifle_idle', 0, 'idle-left', (-0.40, 0.10, 0.10)),
    ('rifle_idle', 0, 'idle-right', (0.40, 0.10, 0.10)),
    ('rifle_idle', 0, 'bolt-closed-right', (0.22, 0.10, 0.08)),
    ('rifle_idle_empty', 0, 'bolt-locked-right', (0.22, 0.10, 0.08)),
    ('rifle_idle_empty', 0, 'bolt-locked-left', (-0.22, 0.10, 0.08)),
    ('rifle_reload', 0.55, 'reload-1', None), ('rifle_reload', 0.80, 'reload-2-mag-out', None),
    ('rifle_reload', 1.10, 'reload-3', None), ('rifle_reload', 1.50, 'reload-4-mag-in', None),
    ('rifle_reload_empty', 0.9, 'empty-1-mag-out', None), ('rifle_reload_empty', 1.5, 'empty-2-mag-in', None),
    ('rifle_reload_empty', 2.0, 'empty-3-catch', None),
    ('rifle_draw', 0.1, 'draw-1', None), ('rifle_draw', 0.2, 'draw-2', None),
    ('rifle_fire', 1 / 30, 'fire', None),
]


ZOOM = {'iron': 1.3, 'reddot': 1.4, 'scope2x': 1 + (2.0 - 1) * 0.35}


def preview_aim(rig, out_dir, iron_eyes):
    """Aimed views: the camera at each aim point (the rig placed as presenter.ts places it), the weapon view's field
    of view narrowed by the sight's zoom; other sights hidden; iron sights also at other eye distances."""
    scene = bpy.context.scene
    arm = rig.arm
    cam_data = bpy.data.cameras.new('aim')
    cam_data.sensor_fit = 'VERTICAL'
    cam_data.clip_start = 0.01
    cam = bpy.data.objects.new('aim', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.matrix_world = Matrix.Rotation(math.radians(90), 4, 'X')
    rk.set_action(arm, bpy.data.actions['rifle_idle'])
    scene.frame_set(0)
    arm.animation_data.action = None
    aims = {e.name[4:]: e.matrix_world.translation.copy() for e in rig.empties if e.name.startswith('aim_')}
    views = [(k, v) for k, v in aims.items()]
    for e in iron_eyes:
        a = aims['iron'].copy()
        a.y = -e
        views.append((f'iron-eye{int(e * 100)}', a))
    for name, ap in views:
        sight = name.split('-')[0]
        for b in ('sight_reddot', 'sight_scope2x', 'rearsight'):
            pb = arm.pose.bones[b]
            show = (b == f'sight_{sight}') or (b == 'rearsight' and sight == 'iron')
            pb.scale = (1, 1, 1) if show else (0.001, 0.001, 0.001)
        arm.matrix_world = Matrix.Translation(-ap)
        cam_data.angle_y = 2 * math.atan(math.tan(math.radians(37)) / ZOOM[sight])
        bpy.context.view_layer.update()
        scene.render.filepath = os.path.join(out_dir, f'aim-{name}.jpg')
        bpy.ops.render.render(write_still=True)
    arm.matrix_world = Matrix()


def main():
    rest = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    rig = Rig()
    rig.build()
    pack_hip = rig.pack_hip()
    log('the pack\'s own hip pose (PlayCanvas position, euler degrees):', pack_hip, 'ours:', HIP_OURS)
    if '--preview' in rest:
        out_dir = os.path.abspath(rest[rest.index('--preview') + 1])
        hips = {'pack': pack_hip, 'ours': HIP_OURS}
        shots = SHOTS
        if '--try' in rest:
            import json
            hips = json.loads(rest[rest.index('--try') + 1])
            shots = [s for s in SHOTS if s[0].startswith('rifle_reload') and not s[3]]
        preview(rig, out_dir, hips, shots)
        if '--aim' in rest:
            preview_aim(rig, out_dir, [float(x) for x in rest[rest.index('--aim') + 1].split(',')])
    if '--no-export' not in rest:
        rig.export()


main()
