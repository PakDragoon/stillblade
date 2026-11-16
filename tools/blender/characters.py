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
  3b. Builds the armed upper-body clips for defenders, aim (static two-handed hold of the gun in
     tools/blender/weapons.py's convention, arms solved with two-bone IK) and shoot (recoil ending on
     aim). The source has gun clips, but they are one-handed pistol poses that do not suit an SMG.
     It also measures a grip frame in each hand from the finger bones, used for the hand IK and for
     two empties on Wrist.R ("socket_gun", "socket_knife") that client/src/characters.ts hangs the
     weapon meshes from.
  3c. Builds the rest of the held-weapon clips the same way (package F): pistol (a one-handed hold, arm out in
     front of the shoulder) and pistol_shoot; reload_rifle (2.2 s) and reload_pistol (1.4 s) with the support hand
     taking the magazine out to the belt and back and working the bolt or slide at the times of the reload sounds in
     client/src/audio.ts; knife_hold and knife_swing (0.2 s windup, 0.12 s strike, recovery), the swing used by
     defenders and ghosts alike.
  3d. Death: the source clip falls straight back about 1.8 m (head 1.5 m behind the feet). The whole body is moved
     forward as it falls (feet slide a little), so the body ends up centred on where the player stood: head about
     1.3 m behind, feet 0.6 m in front. client/src/presenter.ts then turns the body toward open floor.
  4. Keeps only the clips the game uses, renamed: idle, walk, run, crouch_idle, crouch_walk,
     death, hit, aim, shoot, pistol, pistol_shoot, reload_rifle, reload_pistol, knife_hold, knife_swing.
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

# Armed clips (defenders). Gun placement relative to the right shoulder joint, metres in the character's own
# frame (right, forward, up) at the final 1.8 m scale; the gun points straight ahead, level.
AIM_GUN_FROM_SHOULDER = (-0.11, 0.17, -0.09)
# Support hand: where the left hand grips the gun, metres in the gun's frame (right, forward, up), origin at
# the pistol grip: the front of the magazine well (weapons.py: magazine spans 0.20-0.35 m forward).
AIM_SUPPORT_ON_GUN = (0.0, 0.17, -0.02)
# Elbow pole directions in the character frame (right, forward, up), per side.
AIM_POLE = {'R': (0.65, -0.15, -1.0), 'L': (-0.55, -0.1, -1.0)}
# Shoot: recoil per frame (24 fps) as a fraction of the peak; peak kick back (m) and muzzle climb (degrees).
SHOOT_CURVE = (0.0, 1.0, 0.62, 0.32, 0.12, 0.0)
SHOOT_BACK = 0.045
SHOOT_CLIMB = 7.0
SHOOT_CHEST = 2.5           # degrees the chest rocks back at the peak
# How far the grip sits off the palm (metres, along the palm normal) and how far along the hand from the wrist.
GRIP_PALM_OFFSET = 0.028
GRIP_ALONG_HAND = 0.55       # 0 = wrist joint, 1 = finger knuckles

# Package F clips: placements in the character frame (right, forward, up) relative to the right shoulder, metres.
PISTOL_FROM_SHOULDER = (-0.06, 0.4, -0.05)
PISTOL_SHOOT_CLIMB = 14.0
PISTOL_SHOOT_BACK = 0.035
KNIFE_HOLD_FROM_SHOULDER = (0.0, 0.27, -0.27)
KNIFE_BACK_FROM_SHOULDER = (0.12, 0.02, 0.1)
KNIFE_STRIKE_FROM_SHOULDER = (-0.3, 0.3, -0.2)
LEFT_GUARD_FROM_SHOULDER = (-0.36, 0.28, -0.28)
BELT_FROM_SHOULDER = (-0.36, 0.04, -0.45)
# Death: share of the hips' backward travel the body is moved forward again.
DEATH_RECENTRE = 0.6

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

    # Hand grip frames (need the finger bones, so before they are deleted) and the armed clips.
    am = unit / arm.matrix_world.to_scale()[0]          # armature units per metre
    sockets = hand_sockets(arm, forward, am)
    aim, shoot = build_aim(arm, actions['Idle'], am, forward, sockets)
    more = build_more(arm, actions['Idle'], am, forward, sockets)
    death = recentre_death(arm, actions['Death'], forward)

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
    keep = {crouch_idle.name: crouch_idle, crouch_walk.name: crouch_walk, aim.name: aim, shoot.name: shoot,
            'death': death}
    keep.update({a.name: a for a in more})
    for a in list(bpy.data.actions):
        short = a.name.split('|')[-1]
        if a in keep.values():
            continue
        if short == 'Death':
            bpy.data.actions.remove(a)
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

    # --- Weapon sockets: empties parented to the right wrist bone (see hand_sockets) --------------
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    socket_objs = []
    wrist = arm.data.bones['Wrist.R']
    for name in ('socket_gun', 'socket_knife'):
        e = bpy.data.objects.new(name, None)
        scene.collection.objects.link(e)
        e.parent = arm
        e.parent_type = 'BONE'
        e.parent_bone = 'Wrist.R'
        bpy.context.view_layer.update()
        loc, rot, _ = (arm.matrix_world @ wrist.matrix_local @ sockets[name]).decompose()
        e.matrix_world = Matrix.LocRotScale(loc, rot, Vector((1, 1, 1)))
        socket_objs.append(e)
        bpy.context.view_layer.update()
        log(name, 'world (rest pose, Blender Z up)', tuple(round(c, 3) for c in e.matrix_world.translation))
    arm.data.pose_position = 'POSE'
    bpy.context.view_layer.update()

    # --- Export --------------------------------------------------------------------------------
    set_action(arm, keep['idle'])
    scene.frame_set(0)
    for o in bpy.data.objects:
        o.select_set(o in (arm, body) or o in socket_objs)
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


# ---------------------------------------------------------------------------------------------
# Weapons: hand sockets and the armed (two-handed) upper-body clips

def frame_from(right, fwd, up, origin):
    m = Matrix((right, fwd, up)).transposed().to_4x4()
    m.translation = origin
    return m


def hand_grip_frame(data, side, am):
    """
    Rest-pose grip frame of one hand, in armature space: origin in the palm where a handle would sit,
    axes (right, forward, up) of a pistol grip held in it: 'up' runs from the pinky side to the index side,
    'forward' follows the fingers (the barrel of a pistol lies along the forearm), 'right' completes the frame.
    The palm normal (which way the palm faces) is the frame's -right for the right hand and +right for the left.
    """
    wrist = data.bones[f'Wrist.{side}']
    w = wrist.head_local
    # The first finger bones all start at one point at the wrist; the knuckles are the heads of the second ones.
    knuckles = sum((data.bones[f'{f}2.{side}'].head_local for f in ('Index', 'Middle', 'Ring', 'Pinky')), Vector()) / 4
    fingers = (knuckles - w).normalized()
    across = (data.bones[f'Index2.{side}'].head_local - data.bones[f'Pinky2.{side}'].head_local)
    up = (across - fingers * across.dot(fingers)).normalized()
    right = fingers.cross(up)
    # Palm side: a right hand closes on a grip from the grip's right side (palm faces -right), a left hand
    # from its left side (palm faces +right). (Rest pose: T-pose, palms down, thumbs forward.)
    palm = -right if side == 'R' else right
    origin = w + (knuckles - w) * GRIP_ALONG_HAND + palm * (GRIP_PALM_OFFSET * am)
    return frame_from(right, fingers, up, origin), palm


def hand_sockets(arm, forward, am):
    """
    Socket transforms relative to the rest pose of Wrist.R (armature units), keyed by socket name, plus the
    left hand's grip frame for the support-hand IK:
      socket_gun   : the gun model's frame (X right, Y forward = muzzle, Z up; origin = pistol grip)
      socket_knife : the knife model's frame (Y forward = blade tip out of the thumb side, Z up = spine,
                     toward the elbow, so the cutting edge faces the way the fingers point)
    """
    data = arm.data
    out = {}
    g, palm = hand_grip_frame(data, 'R', am)
    wr = data.bones['Wrist.R'].matrix_local
    out['socket_gun'] = wr.inverted() @ g
    r, f, u = (g.col[i].to_3d() for i in range(3))
    k_fwd, k_up = u, -f
    k = frame_from(k_fwd.cross(k_up), k_fwd, k_up, g.translation)
    out['socket_knife'] = wr.inverted() @ k
    gl, palm_l = hand_grip_frame(data, 'L', am)
    out['left_grip'] = data.bones['Wrist.L'].matrix_local.inverted() @ gl
    fwd_a = (arm.matrix_world.inverted().to_3x3() @ forward).normalized()
    up_a = (arm.matrix_world.inverted().to_3x3() @ Vector((0, 0, 1))).normalized()
    log('palm . up (rest T-pose, palms down: expect ~ -1): right', round(palm.dot(up_a), 2),
        'left', round(palm_l.dot(up_a), 2))
    return out


def solve_arm(data, mats, side, target, pole):
    """Two-bone IK (UpperArm, LowerArm) putting the wrist joint at `target`; elbow bends toward `pole`."""
    up_name, lo_name, end_name = f'UpperArm.{side}', f'LowerArm.{side}', f'Wrist.{side}'
    ub, lb, eb = data.bones[up_name], data.bones[lo_name], data.bones[end_name]
    la = (lb.head_local - ub.head_local).length
    lbl = (eb.head_local - lb.head_local).length
    H = mats[up_name].to_translation()
    ht = target - H
    reach = ht.length / (la + lbl)
    d = min(max(ht.length, abs(la - lbl) + 1e-6), la + lbl - 1e-6)
    dirv = ht.normalized()
    bend = (pole - dirv * pole.dot(dirv)).normalized()
    x = (la * la - lbl * lbl + d * d) / (2 * d)
    h = math.sqrt(max(la * la - x * x, 0.0))
    K = H + dirv * x + bend * h
    T = H + dirv * d
    elbow_local = ub.matrix_local.inverted() @ lb.head_local
    wrist_local = lb.matrix_local.inverted() @ eb.head_local

    def rotated(m, q, new_head):
        nm = (q.to_matrix() @ m.to_3x3()).to_4x4()
        nm.translation = new_head
        return nm

    mu = mats[up_name]
    q1 = ((mu @ elbow_local) - H).rotation_difference(K - H)
    mats[up_name] = rotated(mu, q1, H)
    ml = rotated(mats[lo_name], q1, K)
    q2 = ((ml @ wrist_local) - K).rotation_difference(T - K)
    mats[lo_name] = rotated(ml, q2, K)
    return reach


def write_action(arm, name, frames):
    """New action from per-frame armature-space pose matrices {bone: Matrix}."""
    pose, data = arm.pose, arm.data
    order = [bn.name for bn in data.bones]   # parents come before children in this list
    new = bpy.data.actions.new(name)
    set_action(arm, new)
    for f, mats in frames:
        for n in order:
            pb = pose.bones[n]
            bone = data.bones[n]
            if bone.parent:
                par = bone.parent
                basis = (mats[par.name] @ par.matrix_local.inverted() @ bone.matrix_local).inverted() @ mats[n]
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
    return new


def build_aim(arm, src_action, am, forward, sockets):
    """
    'aim': a static two-handed hold (the source has only one-handed pistol clips): the spine and head of the
    first Idle frame, the gun level and straight ahead in front of the right shoulder, the right wrist placed
    so the gun socket lands on that gun frame, the left hand on the front of the magazine, both arms solved
    with two-bone IK. 'shoot': the same pose with a short recoil (gun kicks back and climbs, chest rocks),
    ending exactly on the aim pose so the game can cut between the two.
    """
    data = arm.data
    inv_w = arm.matrix_world.inverted()
    up_a = (inv_w.to_3x3() @ Vector((0, 0, 1))).normalized()
    fwd_a = (inv_w.to_3x3() @ forward).normalized()
    fwd_a = (fwd_a - up_a * fwd_a.dot(up_a)).normalized()
    side_a = fwd_a.cross(up_a)                                   # character's right
    char = lambda v: side_a * v[0] + fwd_a * v[1] + up_a * v[2]

    # Bones the source clip does not key keep whatever was set last (build_crouch leaves its final frame
    # in the pose), so clear the pose to rest before sampling.
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)
    set_action(arm, src_action)
    a = int(round(src_action.frame_range[0]))
    bpy.context.scene.frame_set(a + 1)
    bpy.context.scene.frame_set(a)
    base = {pb.name: pb.matrix.copy() for pb in arm.pose.bones}

    shoulder_r = base['UpperArm.R'].to_translation()
    g0 = frame_from(side_a, fwd_a, up_a, shoulder_r + char(AIM_GUN_FROM_SHOULDER) * am)
    s_gun_inv = sockets['socket_gun'].inverted()
    s_left_inv = sockets['left_grip'].inverted()
    chest_set = set(['Chest'] + descendants(data.bones['Chest']))

    def pose_for(k):
        mats = {n: m.copy() for n, m in base.items()}
        # Chest rocks back about its own joint.
        if k > 0:
            pivot = mats['Chest'].to_translation()
            # (right, forward, up) is right-handed, so a positive turn about 'right' tips 'up' backward.
            rc = (Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(SHOOT_CHEST) * k, 4, side_a)
                  @ Matrix.Translation(-pivot))
            for n in chest_set:
                mats[n] = rc @ mats[n]
            g = rc @ g0
        else:
            g = g0.copy()
        # Recoil in the gun's own frame: back along -forward, muzzle climbs about the grip.
        g = g @ Matrix.Translation(Vector((0, -SHOOT_BACK * am * k, 0))) @ Matrix.Rotation(math.radians(SHOOT_CLIMB) * k, 4, 'X')
        support = g @ Matrix.Translation(Vector(AIM_SUPPORT_ON_GUN) * am)
        w_r = g @ s_gun_inv
        w_l = support @ s_left_inv
        reach_r = solve_arm(data, mats, 'R', w_r.to_translation(), char(AIM_POLE['R']))
        reach_l = solve_arm(data, mats, 'L', w_l.to_translation(), char(AIM_POLE['L']))
        mats['Wrist.R'] = w_r
        mats['Wrist.L'] = w_l
        # Children of the wrists (finger bones, deleted later) are left as they were: they are not shipped.
        return mats, reach_r, reach_l

    mats0, rr, rl = pose_for(0)
    sl = base['UpperArm.L'].to_translation()
    arm_len = ((data.bones['LowerArm.R'].head_local - data.bones['UpperArm.R'].head_local).length +
               (data.bones['Wrist.R'].head_local - data.bones['LowerArm.R'].head_local).length) / am
    rel = lambda p: tuple(round(c, 3) for c in ((p - shoulder_r).dot(side_a) / am, (p - shoulder_r).dot(fwd_a) / am,
                                                (p - shoulder_r).dot(up_a) / am))
    log('arm length m', round(arm_len, 3), 'left shoulder rel. right (r,f,u)', rel(sl),
        'right wrist target', rel(mats0['Wrist.R'].to_translation()), 'left wrist target', rel(mats0['Wrist.L'].to_translation()))
    log('aim reach (fraction of arm length) right', round(rr, 3), 'left', round(rl, 3))
    if rr > 0.999 or rl > 0.999:
        log('WARNING aim target out of reach: the hands will not meet the gun')
    aim = write_action(arm, 'aim', [(0, mats0), (12, mats0)])
    frames = [(i, pose_for(k)[0]) for i, k in enumerate(SHOOT_CURVE)]
    shoot = write_action(arm, 'shoot', frames)
    log('built aim, shoot frames', len(frames))
    return aim, shoot


def build_more(arm, src_action, am, forward, sockets):
    """Package F upper-body clips (see the module docstring). Hands are rigid (no finger bones ship)."""
    import sys as _sys
    _sys.path.insert(0, HERE)
    import rigkit as rk
    data = arm.data
    inv_w = arm.matrix_world.inverted()
    up_a = (inv_w.to_3x3() @ Vector((0, 0, 1))).normalized()
    fwd_a = (inv_w.to_3x3() @ forward).normalized()
    fwd_a = (fwd_a - up_a * fwd_a.dot(up_a)).normalized()
    side_a = fwd_a.cross(up_a)
    char = lambda v: side_a * v[0] + fwd_a * v[1] + up_a * v[2]
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)
    set_action(arm, src_action)
    a0 = int(round(src_action.frame_range[0]))
    bpy.context.scene.frame_set(a0 + 1)
    bpy.context.scene.frame_set(a0)
    base = {pb.name: pb.matrix.copy() for pb in arm.pose.bones}
    shoulder = base['UpperArm.R'].to_translation()
    at = lambda v: shoulder + char(v) * am
    s_gun_inv = sockets['socket_gun'].inverted()
    s_knife_inv = sockets['socket_knife'].inverted()
    s_left_inv = sockets['left_grip'].inverted()
    chest_set = set(['Chest'] + descendants(data.bones['Chest']))
    rest_left = base['Wrist.L'].copy()

    def gun_frame(origin, pitch=0.0, yaw=0.0, roll=0.0):
        r = (Matrix.Rotation(math.radians(yaw), 4, up_a) @ Matrix.Rotation(math.radians(pitch), 4, side_a)
             @ Matrix.Rotation(math.radians(roll), 4, fwd_a))
        m = frame_from(side_a, fwd_a, up_a, Vector())
        m = r @ m
        m.translation = origin
        return m

    def knife_frame(origin, blade, spine):
        y = char(blade).normalized()
        z = char(spine)
        z = (z - y * z.dot(y)).normalized()
        return frame_from(y.cross(z), y, z, origin)

    def pose(right_socket_frame, right_inv, left_wrist, chest_yaw=0.0):
        mats = {n: m.copy() for n, m in base.items()}
        if chest_yaw:
            pivot = mats['Chest'].to_translation()
            rc = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(chest_yaw), 4, up_a) @ Matrix.Translation(-pivot)
            for n in chest_set:
                mats[n] = rc @ mats[n]
        w_r = right_socket_frame @ right_inv
        solve_arm(data, mats, 'R', w_r.to_translation(), char(AIM_POLE['R']))
        mats['Wrist.R'] = w_r
        solve_arm(data, mats, 'L', left_wrist.to_translation(), char(AIM_POLE['L']))
        mats['Wrist.L'] = left_wrist
        return mats

    def clip(name, seconds, fn):
        n = max(1, int(round(seconds * FPS)))
        frames = [(i, fn(min(seconds, i / FPS))) for i in range(n + 1)]
        act = write_action(arm, name, frames)
        log('built', name, 'frames', n + 1, 'seconds', round(n / FPS, 3))
        return act

    out = []
    # --- Pistol: one-handed hold, left arm hanging as in Idle ---------------------------------------
    p0 = gun_frame(at(PISTOL_FROM_SHOULDER))
    out.append(clip('pistol', 0.5, lambda t: pose(p0, s_gun_inv, rest_left)))

    def pistol_kick(k):
        g = p0 @ Matrix.Translation(Vector((0, -PISTOL_SHOOT_BACK * am * k, 0))) @ Matrix.Rotation(
            math.radians(PISTOL_SHOOT_CLIMB) * k, 4, 'X')
        return pose(g, s_gun_inv, rest_left)
    curve = SHOOT_CURVE
    out.append(write_action(arm, 'pistol_shoot', [(i, pistol_kick(k)) for i, k in enumerate(curve)]))

    # --- Reloads --------------------------------------------------------------------------------------
    g_rifle = gun_frame(shoulder + char(AIM_GUN_FROM_SHOULDER) * am)
    support = Matrix.Translation(Vector(AIM_SUPPORT_ON_GUN) * am)
    knob = Matrix.Translation(Vector((-0.04, 0.31, 0.15)) * am)
    belt_w = Matrix.Translation(at(BELT_FROM_SHOULDER)) @ Matrix(rest_left.to_3x3()).to_4x4()

    def keyed_frames(keys, t):
        return rk.keyed(keys, t)

    rifle_low = gun_frame(at((-0.14, 0.32, -0.2)), pitch=10, yaw=10, roll=35)
    gk = [(0.0, lambda t: g_rifle), (0.25, lambda t: rifle_low), (1.9, lambda t: rifle_low),
          (1.97, lambda t: rifle_low @ Matrix.Translation(Vector((0, -0.02 * am, 0)))),
          (2.07, lambda t: rifle_low), (2.2, lambda t: g_rifle)]

    def rifle_reload(t):
        g = keyed_frames(gk, t)
        on = lambda m, extra=Matrix(): (lambda tt: keyed_frames(gk, tt) @ extra @ m @ s_left_inv)
        down = lambda d: Matrix.Translation(Vector((0, 0, -d * am)))
        bolt = rk.keyed([(0.0, (0.0,)), (1.9, (0.0,)), (1.97, (-0.06,)), (2.07, (-0.06,)), (2.1, (0.0,))], t)[0]
        lk = [(0.0, on(support)), (0.2, on(support)), (0.3, on(support)), (0.55, on(support, down(0.25))),
              (0.75, lambda tt: belt_w), (1.0, lambda tt: belt_w), (1.25, on(support, down(0.1))),
              (1.4, on(support)), (1.5, on(support)), (1.8, on(knob)), (1.9, on(knob)),
              (1.97, on(knob, Matrix.Translation(Vector((0, bolt * am, 0))))),
              (2.07, on(knob, Matrix.Translation(Vector((0, -0.06 * am, 0))))), (2.2, on(support))]
        return pose(g, s_gun_inv, rk.keyed(lk, t))
    out.append(clip('reload_rifle', 2.2, rifle_reload))

    pistol_low = gun_frame(at((-0.14, 0.3, -0.18)), pitch=18, yaw=12, roll=30)
    pk = [(0.0, lambda t: p0), (0.15, lambda t: pistol_low), (1.17, lambda t: pistol_low), (1.4, lambda t: p0)]
    mag_hold = Matrix.Translation(Vector((0.0, -0.01, -0.09)) * am)
    slide = Matrix.Translation(Vector((0.0, -0.015, 0.06)) * am)

    def pistol_reload(t):
        g = keyed_frames(pk, t)
        on = lambda m, extra=Matrix(): (lambda tt: keyed_frames(pk, tt) @ extra @ m @ s_left_inv)
        sl = rk.keyed([(0.0, (0.0,)), (1.0, (0.0,)), (1.07, (-0.035,)), (1.17, (-0.035,)), (1.19, (0.0,))], t)[0]
        lk = [(0.0, lambda tt: rest_left), (0.12, lambda tt: rest_left), (0.35, lambda tt: belt_w),
              (0.45, lambda tt: belt_w), (0.62, on(mag_hold, Matrix.Translation(Vector((0, 0, -0.06 * am))))),
              (0.7, on(mag_hold)), (0.78, on(mag_hold)), (0.95, on(slide)), (1.0, on(slide)),
              (1.07, on(slide, Matrix.Translation(Vector((0, sl * am, 0))))),
              (1.17, on(slide, Matrix.Translation(Vector((0, -0.035 * am, 0))))), (1.4, lambda tt: rest_left)]
        return pose(g, s_gun_inv, rk.keyed(lk, t))
    out.append(clip('reload_pistol', 1.4, pistol_reload))

    # --- Knife ---------------------------------------------------------------------------------------
    hold = knife_frame(at(KNIFE_HOLD_FROM_SHOULDER), (0.0, 0.85, 0.5), (0.0, -0.5, 0.85))
    back = knife_frame(at(KNIFE_BACK_FROM_SHOULDER), (-0.2, -0.3, 1.0), (0.3, -1.0, 0.0))
    strike = knife_frame(at(KNIFE_STRIKE_FROM_SHOULDER), (-1.0, 0.5, -0.2), (0.0, 0.3, 1.0))
    guard = Matrix.Translation(at(LEFT_GUARD_FROM_SHOULDER)) @ Matrix(rest_left.to_3x3()).to_4x4()
    out.append(clip('knife_hold', 0.5, lambda t: pose(hold, s_knife_inv, guard)))
    eases = [lambda x: 1 - (1 - x) * (1 - x), lambda x: x * x, rk.smooth]
    kk = [(0.0, hold, 0.0), (0.2, back, 18.0), (0.32, strike, -22.0), (0.57, hold, 0.0)]

    def swing(t):
        for i in range(len(kk) - 1):
            t0, a, ya = kk[i]
            t1, b, yb = kk[i + 1]
            if t <= t1:
                w = eases[i](min(1.0, max(0.0, (t - t0) / (t1 - t0))))
                return pose(rk.lerp_frame(a, b, w), s_knife_inv, guard, ya + (yb - ya) * w)
        return pose(hold, s_knife_inv, guard)
    out.append(clip('knife_swing', 0.57, swing))
    return out


def recentre_death(arm, action, forward):
    """The death clip with the whole body moved forward by DEATH_RECENTRE of the hips' backward travel."""
    inv_w = arm.matrix_world.inverted()
    up_a = (inv_w.to_3x3() @ Vector((0, 0, 1))).normalized()
    fwd_a = (inv_w.to_3x3() @ forward).normalized()
    fwd_a = (fwd_a - up_a * fwd_a.dot(up_a)).normalized()
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)
    set_action(arm, action)
    a, b = (int(round(x)) for x in action.frame_range)
    bpy.context.scene.frame_set(a)
    hips0 = arm.pose.bones['Hips'].matrix.to_translation()
    frames = []
    for f in range(a, b + 1):
        bpy.context.scene.frame_set(f)
        mats = {pb.name: pb.matrix.copy() for pb in arm.pose.bones}
        back = -(mats['Hips'].to_translation() - hips0).dot(fwd_a)
        T = Matrix.Translation(fwd_a * max(0.0, back) * DEATH_RECENTRE)
        frames.append((f - a, {n: T @ m for n, m in mats.items()}))
    new = write_action(arm, 'death', frames)
    log('built death (recentred) frames', len(frames))
    return new


main()
