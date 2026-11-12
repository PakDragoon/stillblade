"""
Stillblade character pipeline: CC0 source model -> client/public/models/character.glb

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup \
        --python tools/blender/characters.py [-- <source.glb> <out.glb>]

Source: "SWAT" by Quaternius (CC0 1.0, poly.pizza model Btfn3G5Xv4), downloaded from poly.pizza into
tools/blender/source-art/characters/quaternius-swat/SWAT.glb (see client/public/models/CREDITS.md).

What it does, in order:
  1. Imports the source GLB (4 meshes, 4 flat-colour materials, 62-bone rig, 24 clips).
  2. Merges the 46 finger bones into their wrists and drops the IK pole-target bones -> 22 bones.
  3. Builds two new clips, crouch_idle and crouch_walk, from Idle and Walk: the hips are lowered,
     the spine leans forward, the head counter-rotates, and the legs are re-solved with an
     analytic two-bone IK onto the original (unchanged) foot bones, so the feet stay planted.
  4. Keeps only the clips the game uses, renamed: idle, walk, run, crouch_idle, crouch_walk,
     death, slash, hit.
  5. Joins the meshes, bakes the material colours into a vertex-colour attribute (defender
     palette: orange body, charcoal gear, skin, black visor), welds, decimates to <= ~3,800
     triangles and leaves ONE material -> one draw call.
  6. Turns the character to face Blender +Y (= glTF -Z = engine forward at yaw 0), scales it so
     the standing idle is exactly 1.8 m tall with the feet at the origin, and exports a GLB with
     no UVs/textures.
It prints the measured standing / crouched heights and the ground speed of each locomotion clip
(used by client/src/characters.ts to scale playback so the feet do not slide).
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
DEFAULT_SRC = os.path.join(HERE, 'source-art', 'characters', 'quaternius-swat', 'SWAT.glb')
DEFAULT_OUT = os.path.join(ROOT, 'client', 'public', 'models', 'character.glb')

TARGET_HEIGHT = 1.8
TARGET_TRIS = 3800
FPS = 24

# Source action -> shipped clip name.
KEEP = {
    'Idle': 'idle',
    'Walk': 'walk',
    'Run': 'run',
    'Death': 'death',
    'Sword_Slash': 'slash',
    'HitRecieve': 'hit',
}

# Crouch: hip drop and spine lean, in metres / degrees at the final 1.8 m scale.
CROUCH_DROP = {'crouch_idle': 0.52, 'crouch_walk': 0.42}
CROUCH_LEAN = 24.0
CROUCH_HEAD_COUNTER = 0.8   # fraction of the lean the neck undoes so the head looks ahead

# Defender palette (linear RGB) per source material.
PALETTE = {
    'Swat': (0.80, 0.30, 0.05, 1.0),        # main suit -> team orange
    'Swat_Black': (0.035, 0.035, 0.04, 1.0),  # vest, pads, gloves, boots -> charcoal
    'Skin': (0.49, 0.33, 0.19, 1.0),
    'Visor': (0.01, 0.01, 0.012, 1.0),
}

FINGERS = ('Index', 'Middle', 'Ring', 'Pinky', 'Thumb')
DROP_BONES = ('PT.L', 'PT.R')


def log(*a):
    print('[characters]', *a, flush=True)


def args():
    if '--' in sys.argv:
        rest = sys.argv[sys.argv.index('--') + 1:]
        if len(rest) >= 2:
            return rest[0], rest[1]
    return DEFAULT_SRC, DEFAULT_OUT


# ---------------------------------------------------------------------------------------------
# Action helpers (Blender 4.4+ slotted actions; legacy fallback)

def action_fcurves(action):
    curves = []
    layers = getattr(action, 'layers', None)
    if layers is not None and len(layers) > 0:
        for layer in layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    curves.extend(bag.fcurves)
        return curves
    return list(getattr(action, 'fcurves', []))


def remove_fcurve(action, fc):
    layers = getattr(action, 'layers', None)
    if layers is not None and len(layers) > 0:
        for layer in layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    if fc in bag.fcurves[:]:
                        bag.fcurves.remove(fc)
                        return
    else:
        action.fcurves.remove(fc)


def bone_of(data_path):
    if data_path.startswith('pose.bones["'):
        return data_path.split('"')[1]
    return None


def set_action(obj, action):
    ad = obj.animation_data or obj.animation_data_create()
    ad.action = action
    if hasattr(ad, 'action_slot') and action is not None and len(getattr(action, 'slots', [])) > 0:
        ad.action_slot = action.slots[0]


# ---------------------------------------------------------------------------------------------

def main():
    src, out = args()
    log('source', src)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    bpy.ops.import_scene.gltf(filepath=src)

    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm]
    for o in list(bpy.data.objects):
        if o is not arm and o not in meshes and o.type != 'EMPTY':
            bpy.data.objects.remove(o)
    for o in list(bpy.data.objects):
        if o.type == 'EMPTY' and o.name != 'RootNode':
            bpy.data.objects.remove(o)

    # Unparent the armature from the importer's RootNode, keeping its world transform.
    mw = arm.matrix_world.copy()
    arm.parent = None
    arm.matrix_world = mw
    for o in list(bpy.data.objects):
        if o.type == 'EMPTY':
            bpy.data.objects.remove(o)

    for o in bpy.data.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = arm

    # --- 1. Join meshes; bake material colours into a corner colour attribute -----------------
    for m in meshes:
        me = m.data
        attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
        mats = [s.material.name if s.material else '' for s in m.material_slots]
        for poly in me.polygons:
            name = mats[poly.material_index] if poly.material_index < len(mats) else ''
            key = next((k for k in PALETTE if name == k or name.startswith(k + '.')), None)
            col = PALETTE[key] if key else (1, 0, 1, 1)
            if key is None:
                log('WARNING unknown material', name)
            for li in poly.loop_indices:
                attr.data[li].color = col
    with bpy.context.temp_override(active_object=meshes[0], selected_editable_objects=meshes,
                                   selected_objects=meshes, object=meshes[0]):
        bpy.ops.object.join()
    body = meshes[0]
    body.name = 'Character'
    body.data.name = 'Character'
    me = body.data
    me.color_attributes.active_color = me.color_attributes['Col']
    me.materials.clear()
    for uv in list(me.uv_layers):
        me.uv_layers.remove(uv)
    tris0 = sum(len(p.vertices) - 2 for p in me.polygons)
    log('joined mesh: verts', len(me.vertices), 'tris', tris0)

    # --- 2. Bones: fold fingers into wrists, drop pole targets ---------------------------------
    vg = body.vertex_groups
    for side in ('L', 'R'):
        wrist = vg.get(f'Wrist.{side}')
        finger_groups = [g for g in vg if g.name.endswith('.' + side) and g.name.startswith(FINGERS)]
        idx = {g.index for g in finger_groups}
        for v in me.vertices:
            add = sum(g.weight for g in v.groups if g.group in idx)
            if add > 0:
                wrist.add([v.index], add, 'ADD')
        for g in finger_groups:
            vg.remove(g)
    for name in DROP_BONES:
        g = vg.get(name)
        if g:
            vg.remove(g)

    # --- 3. Crouch clips (before deleting PT bones is irrelevant: IK here is analytic) --------
    actions = {a.name.split('|')[-1]: a for a in bpy.data.actions}
    rest_world_scale = arm.matrix_world.to_scale()[0]
    standing_h = measure_height(arm, body, actions['Idle'], 0)
    unit = standing_h / TARGET_HEIGHT        # world units per final metre
    forward = find_forward(body)
    log('standing height (source units)', round(standing_h, 4), 'forward', tuple(round(c, 3) for c in forward))

    crouch_idle = build_crouch(arm, actions['Idle'], 'crouch_idle', unit, forward)
    crouch_walk = build_crouch(arm, actions['Walk'], 'crouch_walk', unit, forward)

    # Delete finger and pole bones (edit mode), then their curves.
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    for b in list(eb):
        if b.name.startswith(FINGERS) or b.name in DROP_BONES:
            eb.remove(b)
    bpy.ops.object.mode_set(mode='OBJECT')
    bones = {b.name for b in arm.data.bones}
    log('bones', len(bones))

    # --- 4. Keep and rename clips ---------------------------------------------------------------
    keep = {crouch_idle.name: crouch_idle, crouch_walk.name: crouch_walk}
    for a in list(bpy.data.actions):
        short = a.name.split('|')[-1]
        if a in keep.values():
            continue
        if short in KEEP:
            a.name = KEEP[short]
            keep[a.name] = a
        else:
            bpy.data.actions.remove(a)
    for a in keep.values():
        a.use_fake_user = True
        for fc in list(action_fcurves(a)):
            b = bone_of(fc.data_path)
            if b is not None and b not in bones:
                remove_fcurve(a, fc)
    log('clips', sorted(keep))

    # --- 5. Weld, decimate, one material -----------------------------------------------------
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.0001 * rest_world_scale / max(rest_world_scale, 1e-9))
    bpy.ops.object.mode_set(mode='OBJECT')
    tris1 = sum(len(p.vertices) - 2 for p in me.polygons)
    if tris1 > TARGET_TRIS:
        dec = body.modifiers.new('Decimate', 'DECIMATE')
        dec.ratio = TARGET_TRIS / tris1
        dec.use_collapse_triangulate = True
        with bpy.context.temp_override(object=body, active_object=body):
            bpy.ops.object.modifier_move_to_index(modifier='Decimate', index=0)
            bpy.ops.object.modifier_apply(modifier='Decimate')
    tris2 = sum(len(p.vertices) - 2 for p in me.polygons)
    log('tris after weld', tris1, 'after decimate', tris2)
    # Clean weights: max 4 influences, normalised, drop tiny ones.
    with bpy.context.temp_override(object=body, active_object=body):
        bpy.ops.object.vertex_group_clean(group_select_mode='ALL', limit=0.01)
        bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    # Smooth shading with hard edges above 50 degrees: crisp low-poly look without splitting
    # every vertex per face (keeps the vertex count, and the file, small).
    me.set_sharp_from_angle(angle=math.radians(50))

    mat = bpy.data.materials.new('character')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    ca = nt.nodes.new('ShaderNodeVertexColor')
    ca.layer_name = 'Col'
    nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.8
    bsdf.inputs['Metallic'].default_value = 0.0
    me.materials.append(mat)
    arm.data.pose_position = 'POSE'

    # --- 6. Orient and scale ----------------------------------------------------------------
    # Rotate about world Z so the measured forward maps to +Y, scale to 1.8 m, feet at origin.
    yaw = math.atan2(forward.x, forward.y)      # angle from +Y to forward, clockwise positive
    rot = Matrix.Rotation(yaw, 4, 'Z')          # turns forward onto +Y
    s = TARGET_HEIGHT / standing_h
    arm.matrix_world = Matrix.Scale(s, 4) @ rot @ arm.matrix_world
    bpy.context.view_layer.update()
    lo, hi = eval_bounds(arm, body, keep['idle'], 0)
    arm.location.z -= lo.z
    arm.location.x -= (lo.x + hi.x) / 2
    arm.location.y -= (lo.y + hi.y) / 2
    bpy.context.view_layer.update()

    for name in ('crouch_idle', 'crouch_walk'):
        lo2, hi2 = eval_bounds(arm, body, keep[name], 0)
        log(f'final {name} height', round(hi2.z - lo2.z, 3), 'top', round(hi2.z, 3))
    fwd2 = find_forward(body)
    log('final forward (should be +Y)', tuple(round(c, 3) for c in fwd2))
    for name in ('walk', 'run', 'crouch_walk'):
        log(f'ground speed {name}', round(ground_speed(arm, keep[name]), 3), 'm/s',
            'duration', round(clip_seconds(keep[name]), 3))
    for name in sorted(keep):
        log(f'clip {name} duration', round(clip_seconds(keep[name]), 3))

    # --- Export --------------------------------------------------------------------------------
    set_action(arm, keep['idle'])
    scene.frame_set(0)
    for o in bpy.data.objects:
        o.select_set(o in (arm, body))
    bpy.context.view_layer.objects.active = arm
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_texcoords=False,
        export_normals=True,
        export_tangents=False,
        export_vertex_color='ACTIVE',
        export_all_vertex_colors=False,
        export_materials='EXPORT',
        export_skins=True,
        export_all_influences=False,
        export_def_bones=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_anim_slide_to_zero=True,
        export_morph=False,
        export_extras=False,
        export_cameras=False,
        export_lights=False,
    )
    log('wrote', out, os.path.getsize(out), 'bytes')


# ---------------------------------------------------------------------------------------------
# Measurement

def eval_bounds(arm, body, action, frame):
    set_action(arm, action)
    bpy.context.scene.frame_set(int(frame))
    dg = bpy.context.evaluated_depsgraph_get()
    ev = body.evaluated_get(dg)
    m = ev.to_mesh()
    mw = body.matrix_world
    pts = [mw @ v.co for v in m.vertices]
    ev.to_mesh_clear()
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def measure_height(arm, body, action, frame):
    lo, hi = eval_bounds(arm, body, action, frame)
    return hi.z - lo.z


def find_forward(body):
    """Horizontal direction from the head centre to the visor (darkest colour) in the rest mesh."""
    me = body.data
    attr = me.color_attributes['Col']
    vis, all_head = Vector(), Vector()
    nv = nh = 0
    zs = [(body.matrix_world @ v.co).z for v in me.vertices]
    zmin, zmax = min(zs), max(zs)
    top = zmin + (zmax - zmin) * 0.82
    for poly in me.polygons:
        c = body.matrix_world @ poly.center
        if c.z < top:
            continue
        col = attr.data[poly.loop_indices[0]].color
        all_head += c
        nh += 1
        if abs(col[0] - PALETTE['Visor'][0]) < 0.01 and abs(col[1] - PALETTE['Visor'][1]) < 0.01:
            vis += c
            nv += 1
    d = vis / max(nv, 1) - all_head / max(nh, 1)
    d.z = 0
    return d.normalized()


def clip_seconds(action):
    a, b = action.frame_range
    return (b - a) / FPS


def ground_speed(arm, action):
    """Average horizontal speed of a foot while it is on the ground (lowest 2 cm), m/s."""
    set_action(arm, action)
    a, b = (int(round(x)) for x in action.frame_range)
    speeds = []
    for foot in ('Foot.L', 'Foot.R'):
        pos = []
        for f in range(a, b + 1):
            bpy.context.scene.frame_set(f)
            pos.append(arm.matrix_world @ arm.pose.bones[foot].head)
        zmin = min(p.z for p in pos)
        for i in range(len(pos) - 1):
            if pos[i].z < zmin + 0.02 and pos[i + 1].z < zmin + 0.02:
                d = pos[i + 1] - pos[i]
                d.z = 0
                speeds.append(d.length * FPS)
    return sum(speeds) / max(len(speeds), 1)


# ---------------------------------------------------------------------------------------------
# Crouch generation

def descendants(bone):
    out = []
    stack = list(bone.children)
    while stack:
        b = stack.pop()
        out.append(b.name)
        stack.extend(b.children)
    return out


def build_crouch(arm, src_action, name, unit, forward):
    """New action: src_action with lowered hips, leaned spine and re-solved legs (armature space)."""
    pose = arm.pose
    data = arm.data
    a, b = (int(round(x)) for x in src_action.frame_range)
    inv_w = arm.matrix_world.inverted()
    up_a = (inv_w.to_3x3() @ Vector((0, 0, 1))).normalized()
    side_w = forward.cross(Vector((0, 0, 1))).normalized()     # world right
    side_a = (inv_w.to_3x3() @ side_w).normalized()
    drop = -up_a * (CROUCH_DROP[name] * unit / arm.matrix_world.to_scale()[0])

    body_set = set(['Body'] + descendants(data.bones['Body']))
    spine_set = set(['Abdomen'] + descendants(data.bones['Abdomen']))
    neck_set = set(['Neck'] + descendants(data.bones['Neck']))
    order = [bn.name for bn in data.bones]   # parents come before children in this list

    def lean_about(bname, angle, mats):
        pivot = mats[bname].to_translation()
        r = (Matrix.Translation(pivot) @ Matrix.Rotation(angle, 4, side_a) @ Matrix.Translation(-pivot))
        return r

    frames = []
    set_action(arm, src_action)
    for f in range(a, b + 1):
        bpy.context.scene.frame_set(f)
        mats = {pb.name: pb.matrix.copy() for pb in pose.bones}
        # Hips down (everything under Body moves with it).
        T = Matrix.Translation(drop)
        for n in body_set:
            mats[n] = T @ mats[n]
        # Lean the spine forward about the abdomen; the head counter-rotates about the neck.
        # Rotation about +side tilts the top toward +forward? Check sign with the forward vector.
        ang = math.radians(CROUCH_LEAN)
        test = Matrix.Rotation(ang, 3, side_a) @ up_a
        fwd_a = (inv_w.to_3x3() @ forward).normalized()
        if test.dot(fwd_a) < 0:
            ang = -ang
        R = lean_about('Abdomen', ang, mats)
        for n in spine_set:
            mats[n] = R @ mats[n]
        R2 = lean_about('Neck', -ang * CROUCH_HEAD_COUNTER, mats)
        for n in neck_set:
            mats[n] = R2 @ mats[n]
        # Legs: two-bone IK from the moved hip onto the original foot.
        for side in ('L', 'R'):
            solve_leg(data, mats, side, fwd_a)
        frames.append((f, mats))

    new = bpy.data.actions.new(name)
    set_action(arm, new)
    for f, mats in frames:
        for n in order:
            pb = pose.bones[n]
            bone = data.bones[n]
            if bone.parent:
                par = bone.parent
                parent_pose = mats[par.name]
                basis = (parent_pose @ par.matrix_local.inverted() @ bone.matrix_local).inverted() @ mats[n]
            else:
                basis = bone.matrix_local.inverted() @ mats[n]
            pb.rotation_mode = 'QUATERNION'
            loc, rotq, scl = basis.decompose()
            pb.location = loc
            pb.rotation_quaternion = rotq
            pb.scale = scl
            pb.keyframe_insert('location', frame=f, group=n)
            pb.keyframe_insert('rotation_quaternion', frame=f, group=n)
            pb.keyframe_insert('scale', frame=f, group=n)
    new.use_fake_user = True
    log('built', name, 'frames', a, b)
    return new


def solve_leg(data, mats, side, fwd_a):
    up_name, lo_name, foot_name = f'UpperLeg.{side}', f'LowerLeg.{side}', f'Foot.{side}'
    ub, lb, fb = data.bones[up_name], data.bones[lo_name], data.bones[foot_name]
    la = (lb.head_local - ub.head_local).length
    lbl = (fb.head_local - lb.head_local).length
    H = mats[up_name].to_translation()
    T = mats[foot_name].to_translation()
    K0 = mats[lo_name].to_translation()
    ht = T - H
    d = ht.length
    d = min(max(d, abs(la - lbl) + 1e-6), la + lbl - 1e-6)
    dirv = ht.normalized()
    # Bend plane: knee toward the original knee if clearly bent, else forward.
    k = K0 - H
    k = k - dirv * k.dot(dirv)
    f = fwd_a - dirv * fwd_a.dot(dirv)
    # Knees point forward (the source knee direction is unreliable once the hip drops).
    bend = f.normalized()
    x = (la * la - lbl * lbl + d * d) / (2 * d)
    h = math.sqrt(max(la * la - x * x, 0.0))
    K = H + dirv * x + bend * h

    # Rotate by bone-to-child vectors (bone axes from the importer need not point at the child).
    knee_local = ub.matrix_local.inverted() @ lb.head_local
    ankle_local = lb.matrix_local.inverted() @ fb.head_local

    def rotated(m, q, pivot, new_head):
        r3 = q.to_matrix() @ m.to_3x3()
        nm = r3.to_4x4()
        nm.translation = new_head
        return nm

    mu = mats[up_name]
    q1 = ((mu @ knee_local) - H).rotation_difference(K - H)
    mats[up_name] = rotated(mu, q1, H, H)
    ml = rotated(mats[lo_name], q1, H, K)
    q2 = ((ml @ ankle_local) - K).rotation_difference(T - K)
    mats[lo_name] = rotated(ml, q2, K, K)


main()
