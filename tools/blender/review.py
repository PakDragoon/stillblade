"""
Renders review frames of the shipped animations in headless Blender (no browser, no game):

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup \
        --python tools/blender/review.py -- <frames dir> [fp|tp|all]

fp: the first-person viewmodels (client/public/models/viewmodel_*.glb) seen from the game camera (vertical field of
    view 74 degrees, the default setting), each gun rig placed at its hip pose exactly as client/src/presenter.ts
    places it, the knife rig at the camera. Every frame of each clip at 30 fps.
tp: the third-person character (character_high.glb with weapons.glb in its hand sockets), upper-body clips over the legs
    of a base clip as client/src/characters.ts layers them, plus its crouch lean, from a three-quarter view.
Each clip is written as numbered PNGs under <frames dir>/<name>/; tools/review-animations.mjs turns them into the
contact sheets and videos in docs/review/animations/.
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rigkit as rk  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
MODELS = os.path.join(ROOT, 'client', 'public', 'models')
FPS = 30
RES = (640, 360)

# presenter.ts VM_LOOKS hip poses (PlayCanvas camera space).
HIP = {'rifle': ((0.17, -0.32, -0.5), (4, 6, -6)), 'pistol': ((0.12, -0.175, -0.34), (2, 4, -3))}


def log(*a):
    rk.log('review', *a)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = FPS
    sc.render.resolution_x, sc.render.resolution_y = RES
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    try:
        sc.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    world = bpy.data.worlds.new('w')
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.36, 0.42, 0.5, 1)
    bg.inputs['Strength'].default_value = 0.9
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.5
    so = bpy.data.objects.new('sun', sun)
    sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(50), math.radians(-20), math.radians(30))
    return sc


def vertex_colour_material():
    mat = bpy.data.materials.new('vc')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    ca = nt.nodes.new('ShaderNodeVertexColor')
    nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.6
    return mat


def use_material(objs, mat):
    for o in objs:
        if o.type == 'MESH':
            o.data.materials.clear()
            o.data.materials.append(mat)


def add_camera(sc, loc, rot, fov_y=74.0):
    cd = bpy.data.cameras.new('cam')
    cd.sensor_fit = 'VERTICAL'
    cd.angle_y = math.radians(fov_y)
    cd.clip_start = 0.02
    co = bpy.data.objects.new('cam', cd)
    sc.collection.objects.link(co)
    co.location = loc
    co.rotation_euler = rot
    sc.camera = co
    return co


def import_glb(path, **kw):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, **kw)
    return [o for o in bpy.data.objects if o not in before]


def action(name):
    return next(a for a in bpy.data.actions if a.name == name or a.name.split('|')[-1] == name)


def render_frames(sc, out_dir, count, setup):
    os.makedirs(out_dir, exist_ok=True)
    for i in range(count):
        setup(i)
        sc.render.filepath = os.path.join(out_dir, f'{i:03d}.png')
        bpy.ops.render.render(write_still=True)
    log('rendered', count, 'frames to', out_dir)


# ---------------------------------------------------------------------------------------------
# First person

def fp(frames_dir, only=None):
    jobs = [('rifle', 'rifle_idle', False), ('rifle', 'rifle_idle', True), ('rifle', 'rifle_reload', False),
            ('pistol', 'pistol_idle', False), ('pistol', 'pistol_idle', True), ('pistol', 'pistol_reload', False),
            ('knife', 'knife_idle', False), ('knife', 'knife_swing', False), ('ghost', 'knife_swing', False)]
    for rig, clip, sup in jobs:
        name = f'fp_{rig}_{clip.split("_", 1)[1]}' + ('_suppressed' if sup else '')
        if only and not name.startswith(only):
            continue
        sc = reset_scene()
        objs = import_glb(os.path.join(MODELS, f'viewmodel_{"knife" if rig == "ghost" else rig}.glb'))
        arm = next(o for o in objs if o.type == 'ARMATURE')
        meshes = [o for o in objs if o.type == 'MESH']
        use_material(meshes, vertex_colour_material())
        if rig in ('knife', 'ghost'):
            for m in meshes:
                m.hide_render = (m.name.startswith('vm_ghost')) != (rig == 'ghost')
        # The rig's root node (the armature or an importer root above it) sits where the client puts it.
        top = arm
        while top.parent is not None:
            top = top.parent
        top.matrix_world = rk.pc_pose(*HIP[rig]) if rig in HIP else Matrix()
        cam = add_camera(sc, (0, 0, 0), (math.radians(90), 0, 0))
        if os.environ.get('SB_REVIEW_SIDE'):
            # Debug view from the left, outside the head, looking at the hands.
            v = [float(x) for x in os.environ['SB_REVIEW_SIDE'].split(',')] if ',' in os.environ['SB_REVIEW_SIDE'] else                 [-0.75, 0.45, -0.05, 0.1, 0.62, -0.3, 45]
            cam.location = Vector(v[0:3])
            cam.rotation_euler = (Vector(v[3:6]) - cam.location).to_track_quat('-Z', 'Y').to_euler()
            cam.data.angle_y = math.radians(v[6])
        act = action(clip)
        rk.set_action(arm, act)
        f0, f1 = (int(round(x)) for x in act.frame_range)
        count = f1 - f0 + 1 if not clip.endswith('_idle') else 1
        pb = arm.pose.bones.get('sup')
        if pb is not None and not sup:
            # As the client does: the bare look shrinks the suppressor bone to nothing (after the clip).
            c = pb.constraints.new('LIMIT_SCALE')
            c.use_max_x = c.use_max_y = c.use_max_z = True
            c.max_x = c.max_y = c.max_z = 0.001
            c.owner_space = 'LOCAL'

        def setup(i, f0=f0):
            sc.frame_set(f0 + i)
            bpy.context.view_layer.update()

        render_frames(sc, os.path.join(frames_dir, name), count, setup)


# ---------------------------------------------------------------------------------------------
# Third person (filled in by tp_jobs below)

UPPER_ROOT = 'Abdomen'
# characters.ts CROUCH_LEAN: radians about the character's right axis per bone (Abdomen, Chest, Neck, UpperArm.R,
# UpperArm.L), applied parent first after the clips, while crouched with a gun or knife held.
CROUCH_BONES = ('Abdomen', 'Chest', 'Neck', 'UpperArm.R', 'UpperArm.L')
CROUCH_LEAN = (-0.32, -0.12, 0.36, 0.44, 0.44)


def sample_basis(arm, act, frame):
    rk.set_action(arm, act)
    bpy.context.scene.frame_set(int(frame))
    return {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}


def tp(frames_dir, jobs):
    sc = reset_scene()
    # TEMPERANCE: the default heuristic gives this rig zero-length bones, which throws bone-parented sockets off.
    objs = import_glb(os.path.join(MODELS, 'character_high.glb'), bone_heuristic='TEMPERANCE')
    arm = next(o for o in objs if o.type == 'ARMATURE')
    body = [o for o in objs if o.type == 'MESH']
    wobjs = import_glb(os.path.join(MODELS, 'weapons.glb'))
    mat = vertex_colour_material()
    use_material(body + [o for o in wobjs if o.type == 'MESH'], mat)
    weapons = {o.name: o for o in wobjs}
    sockets = {o.name: o for o in objs if o.name.startswith('socket_')}
    for n in ('gun', 'pistol', 'knife'):
        w = weapons[n]
        w.parent = sockets['socket_knife' if n == 'knife' else 'socket_gun']
        w.matrix_parent_inverse = Matrix()
        w.matrix_basis = Matrix()
    for n in ('gun_suppressor', 'pistol_suppressor'):
        weapons[n].hide_render = True
    upper = set([UPPER_ROOT] + rk.descendants(arm.data.bones[UPPER_ROOT]))
    # The character's right, from where the rifle hold puts the gun (in front of the shoulder).
    rk.set_action(arm, action('aim'))
    sc.frame_set(0)
    bpy.context.view_layer.update()
    fwd = sockets['socket_gun'].matrix_world.translation - arm.matrix_world @ arm.pose.bones['UpperArm.R'].head
    fwd.z = 0
    char_right = fwd.normalized().cross(Vector((0, 0, 1)))
    # Floor for scale.
    bpy.ops.mesh.primitive_plane_add(size=6)
    floor = bpy.context.active_object
    fm = bpy.data.materials.new('floor')
    fm.diffuse_color = (0.25, 0.25, 0.27, 1)
    floor.data.materials.append(fm)
    cam = add_camera(sc, (0, 0, 0), (0, 0, 0), fov_y=34)
    f = fwd.normalized()
    up = Vector((0, 0, 1))
    # Views relative to the character's own facing: front three-quarter (gun side), side (its right), and front
    # left (where the support hand works during reloads). (camera position, look-at point)
    views = {
        'front': (f * 2.3 + char_right * 1.0 + up * 1.45, up * 1.05),
        'side': (char_right * 2.9 + f * 0.25 + up * 1.0, up * 0.75),
        'left': (f * 2.0 - char_right * 1.3 + up * 1.5, up * 1.05),
    }
    for job in jobs:
        name, base, up_clip, weapon, crouch, seconds, view = job
        for n in ('gun', 'pistol', 'knife'):
            weapons[n].hide_render = n != weapon
        pos, look = views[view]
        cam.location = pos
        cam.rotation_euler = (look - pos).to_track_quat('-Z', 'Y').to_euler()
        ba = action(base)
        ua = action(up_clip) if up_clip else None
        count = max(1, int(round(seconds * FPS)) + 1)

        def setup(i, ba=ba, ua=ua, crouch=crouch):
            t = i / FPS
            bf = ba.frame_range[0] + (t * 24) % max(1e-6, ba.frame_range[1] - ba.frame_range[0])
            if base == 'death':
                bf = min(ba.frame_range[1], ba.frame_range[0] + t * 24)
            b = sample_basis(arm, ba, bf)
            if ua is not None:
                uf = min(ua.frame_range[1], ua.frame_range[0] + t * 24)
                u = sample_basis(arm, ua, uf)
                for n in upper:
                    b[n] = u[n]
            rk.set_action(arm, None)
            for pb in arm.pose.bones:
                pb.matrix_basis = b[pb.name]
            bpy.context.view_layer.update()
            if crouch:
                right = char_right
                inv = arm.matrix_world.inverted()
                for bn, ang in zip(CROUCH_BONES, CROUCH_LEAN):
                    pb = arm.pose.bones[bn]
                    head_w = arm.matrix_world @ pb.head
                    m_w = arm.matrix_world @ pb.matrix
                    r = Matrix.Translation(head_w) @ Matrix.Rotation(ang, 4, right) @ Matrix.Translation(-head_w)
                    pb.matrix = inv @ r @ m_w
                    bpy.context.view_layer.update()

        render_frames(sc, os.path.join(frames_dir, name), count, setup)


# name, base clip, upper clip, weapon in hand, crouched, seconds, view
TP_JOBS = [
    ('tp_rifle_hold', 'idle', 'aim', 'gun', False, 0, 'front'),
    ('tp_rifle_reload', 'idle', 'reload_rifle', 'gun', False, 2.2, 'left'),
    ('tp_rifle_crouch', 'crouch_idle', 'aim', 'gun', True, 0, 'side'),
    ('tp_pistol_hold', 'idle', 'pistol', 'pistol', False, 0, 'front'),
    ('tp_pistol_shoot', 'idle', 'pistol_shoot', 'pistol', False, 0.3, 'side'),
    ('tp_pistol_reload', 'idle', 'reload_pistol', 'pistol', False, 1.4, 'left'),
    ('tp_pistol_crouch', 'crouch_idle', 'pistol', 'pistol', True, 0, 'side'),
    ('tp_knife_hold', 'idle', 'knife_hold', 'knife', False, 0, 'front'),
    ('tp_knife_swing', 'idle', 'knife_swing', 'knife', False, 0.6, 'front'),
    ('tp_knife_crouch', 'crouch_idle', 'knife_hold', 'knife', True, 0, 'side'),
    ('tp_ghost_swing', 'walk', 'knife_swing', 'knife', False, 0.6, 'side'),
    ('tp_death', 'death', None, 'gun', False, 1.2, 'side'),
]


def main():
    rest = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    frames_dir = rest[0] if rest else os.path.join(ROOT, 'docs', 'review', 'animations', 'frames')
    mode = rest[1] if len(rest) > 1 else 'all'
    only = rest[2] if len(rest) > 2 else None
    if mode in ('fp', 'all'):
        fp(frames_dir, only)
    if mode in ('tp', 'all'):
        tp(frames_dir, [j for j in TP_JOBS if not only or j[0] == only])


main()
