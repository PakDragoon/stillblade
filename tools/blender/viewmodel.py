"""
Stillblade first-person viewmodels: arms and hands holding each weapon, with their clips.

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup \
        --python tools/blender/viewmodel.py [-- --rig rifle|pistol|knife]

Writes client/public/models/viewmodel_rifle.glb, viewmodel_pistol.glb and viewmodel_knife.glb (one file per rig, so
each holds only its own clips). Sources:
  - the arms (package O): the Quantum soldier's forearms, hands and rolled-up sleeves for defenders, the stealth
    suit's arms with gloves for ghosts (soldier.py fp_sources / fp_arms: the same skeleton and textures as the third-
    person characters; their textures live in each gun's atlas, written by weapons.py);
  - the full-detail realistic weapon parts written by weapons.py (package M part 2) to the git-ignored
    tools/blender/source-art/realistic/build/weapons_fp.glb: the AK-105, the Makarov, the knife, the sights and the
    suppressors, already in the shipped frame with UVs into each gun's texture atlas, plus landmarks (mark_*) and the
    aim points (aim_*). Run weapons.py first.
The arms' UVs point into the gun's atlas (skin, sleeve and ghost-suit regions), so a rig is still one mesh with one
material (the gun's).

Each rig is ONE skinned mesh (arms + weapon), so it is one draw call:
  - bones UpperArm / LowerArm / Wrist / three bones per finger and thumb (.L and .R) from the soldier's skeleton (real
    size), plus "weapon" (the weapon's own frame, origin at the grip) and, under it, the moving parts:
      rifle  : mag (the AK magazine), bolt (the bolt carrier with its charging handle on the right), sup (suppressor),
               sight_reddot and sight_scope2x (the optional sights on the dust-cover rail, weapons.py's gun_sight_<id>)
      pistol : mag (magazine and follower), slide (slide and safety), sup (suppressor)
      knife  : no parts
  - empties "muzzle" (suppressor front) and "muzzle_bare" (bare muzzle front) under the weapon bone, guns only, and
    "aim_<sight>" (the eye position when aiming with that sight; presenter.ts aims the rig by it).
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
  aimed  : <rig>_aim_<sight> (one frame): the idle hold seen from the aim point, the arms solved again from
           shoulders that keep their place relative to the eye (presenter.ts blends idle -> aim by the aim progress)
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
import soldier  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
import realistic as rl  # noqa: E402
WEAPONS_GLB = rl.FP_GLB
OUT_DIR = os.path.join(ROOT, 'client', 'public', 'models')

FPS = 30
TARGET_HEIGHT = 1.8
# The grip point in the hand (rigkit.hand_grip_frame): off the palm along its normal, and along the hand.
GRIP_PALM_OFFSET = 0.024
GRIP_ALONG_HAND = 0.6
# The source's cartoon hands are large next to real-size guns: the clips scale each hand about its wrist.
HAND_SCALE = 1.0          # real hands (package O); the cartoon SWAT hands were drawn at 0.8

FINGERS = ('Index', 'Middle', 'Ring', 'Pinky')
HAND = ['Wrist'] + [f'{f}{k}' for f in FINGERS for k in (2, 3, 4)] + [f'Thumb{k}' for k in (1, 2, 3)]
TWIST = ['ForeTwist1', 'ForeTwist2']
ARM_BONES = ['UpperArm', 'LowerArm'] + HAND + TWIST
# Share of the hand's roll (about the forearm) taken by the forearm itself and by its two twist bones (soldier.py
# FP_TWIST: mid forearm, near the wrist), so neither the elbow nor the wrist wrings.
TWIST_SHARE = {'LowerArm': 0.1, 'ForeTwist1': 0.5, 'ForeTwist2': 0.85}

# Hip poses of the guns in PlayCanvas camera space (position, Euler degrees): presenter.ts VM_LOOKS[..].hip.
HIP = {
    'rifle': ((0.155, -0.168, -0.155), (2, 11, -1)),
    'pistol': ((0.085, -0.105, -0.18), (-2, 12, -1)),
}

# The arms, per rig and side, in camera space (Blender axes: X right, Y forward, Z up): the forearm's direction from
# elbow to wrist and the upper arm's from elbow to shoulder, at the rig's first pose (idle). The shoulder is placed from
# them (off screen, below the view) and kept for every clip; the elbow bends the same way (its pole). This is how
# shooters frame their arms: each forearm comes in from a bottom corner as one straight line to the hand, the elbow
# low and a little out, the upper arm out of view.
ARMS = {
    'rifle': {'R': {'fore': (-0.15, 0.45, 0.88), 'upper': (0.30, -0.85, -0.40)},
              'L': {'fore': (0.08, 0.30, 0.95), 'upper': (-0.35, -0.85, -0.40)}},
    'pistol': {'R': {'fore': (-0.12, 0.50, 0.86), 'upper': (0.30, -0.85, -0.40)},
               'L': {'fore': (0.22, 0.50, 0.84), 'upper': (-0.35, -0.85, -0.40)}},
    'knife': {'R': {'fore': (-0.30, 0.55, 0.78), 'upper': (0.45, -0.85, -0.25)},
              'L': {'fore': (0.30, 0.60, 0.74), 'upper': (-0.60, -0.70, -0.20)}},
}

# Finger curls (degrees for bones 2, 3, 4 of each finger; thumb: opposition about the fingers' direction, then
# curl of Thumb2 and Thumb3), per hold.
GRIP_CURL = {f: (78, 85, 50) for f in FINGERS}
TRIGGER_CURL = dict(GRIP_CURL, Index=(45, 55, 30))
WRAP_CURL = {f: (70, 75, 45) for f in FINGERS}
PINCH_CURL = {'Index': (45, 55, 30), 'Middle': (40, 50, 30), 'Ring': (35, 45, 25), 'Pinky': (30, 40, 20)}
RELAX_CURL = {f: (25, 30, 15) for f in FINGERS}
THUMB_GRIP = (55, 25, 20)
# Pistol, thumbs forward: the firing hand's thumb lies along the frame's left side over the support hand's, which points
# forward under the slide.
THUMB_FWD_R = (20, 10, 5)
THUMB_FWD_L = (0, 5, 0)
# Pistol support hand: cupping the firing hand from below and the left (offset from the grip, gun frame, metres), and
# its pitch (degrees, negative: fingers down round the front of the firing hand's fingers).
PISTOL_SUPPORT = (-0.034, 0.016, -0.03)
PISTOL_SUPPORT_PITCH = -14
THUMB_RELAX = (20, 10, 5)
# Rifle reload, gun offsets from the hip (rk.offset_frame: x right, y forward, z up, metres; pitch muzzle up, yaw muzzle
# left, roll top to the right, degrees, about the grip): while the magazine is changed, and while the bolt is pulled.
# The left hand takes the old magazine away to RELOAD_BELT (camera space, Blender axes: down and to the left, out of
# view) and brings the new one back up the same way.
RELOAD_MAG = (0.01, 0.1, 0.06, 40, -42, 30)
RELOAD_BOLT = (-0.05, 0.07, 0.04, 16, 0, -14)
RELOAD_BELT = (-0.2, 0.4, -0.6)
# Knife: the thumb wraps over the fingers round the handle.
THUMB_KNIFE = (70, 45, 35)


def log(*a):
    rk.log('viewmodel', *a)


# ---------------------------------------------------------------------------------------------
# Armature

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
    """The first-person parts file (weapons.py): {name without 'fp_': object}, world transforms as exported."""
    if not os.path.exists(WEAPONS_GLB):
        raise FileNotFoundError(f'{WEAPONS_GLB} is missing: run tools/blender/weapons.py first')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=WEAPONS_GLB)
    bpy.context.view_layer.update()
    objs = {}
    for o in set(bpy.data.objects) - before:
        if o.name.startswith('fp_'):
            objs[o.name[3:].split('.')[0]] = o
        else:
            bpy.data.objects.remove(o)
    for o in objs.values():
        if o.type == 'MESH':
            mw = o.matrix_world.copy()
            o.parent = None
            o.data.transform(mw)
            o.matrix_world = Matrix()
            corner_colours(o)
    return objs


def corner_colours(obj):
    """The importer's colour attribute (any name, domain or type) as the corner byte colour 'Col' the arms use, so
    joining keeps both (attributes are joined by name)."""
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


def mark(w, name):
    """A landmark empty: (location, its +Z axis)."""
    m = w[f'mark_{name}'].matrix_world
    return m.translation.copy(), m.col[2].to_3d().normalized()


def weapon_parts(rig, w):
    """
    The rig's weapon and its moving parts, and landmarks ({bone: [mesh objects]}, marks), in the weapon's frame
    (Blender: X right, Y forward = muzzle or blade tip, Z up, origin at the grip).
    """
    marks = {}
    if rig == 'rifle':
        marks['grip_axis'] = mark(w, 'rifle_grip')[1]
        c, ax = mark(w, 'rifle_mag')
        marks['mag_centre'], marks['mag_axis'] = c, ax
        marks['mag_bottom'] = mark(w, 'rifle_mag_bottom')[0]
        marks['handguard'] = mark(w, 'rifle_handguard')[0]
        marks['handguard_half'] = mark(w, 'rifle_handguard_size')[0]
        marks['handle'] = mark(w, 'rifle_handle')[0]
        log('rifle: magazine axis', tuple(round(x, 3) for x in ax), 'centre', tuple(round(x, 3) for x in c),
            'handguard', tuple(round(x, 3) for x in marks['handguard']), 'handle', tuple(round(x, 3) for x in marks['handle']))
        parts = {'weapon': [w['gun']], 'mag': [w['gun_mag']], 'bolt': [w['gun_bolt']], 'sup': [w['gun_suppressor']]}
        for name in sorted(n for n in w if n.startswith('gun_sight_')):
            parts[name[len('gun_'):]] = [w[name]]
        return parts, marks
    if rig == 'pistol':
        marks['grip_axis'] = mark(w, 'pistol_grip')[1]
        c, ax = mark(w, 'pistol_mag')
        marks['mag_centre'], marks['mag_axis'] = c, ax
        marks['mag_bottom'] = mark(w, 'pistol_mag_bottom')[0]
        marks['slide_rear'] = mark(w, 'pistol_slide_rear')[0]
        return {'weapon': [w['pistol']], 'mag': [w['pistol_mag']], 'slide': [w['pistol_slide']],
                'sup': [w['pistol_suppressor']]}, marks
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
    def __init__(self, name, arm, marks, cam_to_rig, aims=None):
        self.name = name
        # Per sight: the aim point (the eye when aimed with it) in the gun's frame.
        self.aims = aims or {}
        self.arm = arm
        self.data = arm.data
        self.marks = marks
        self.cam_to_rig = cam_to_rig
        self.rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
        self.grip0 = {}
        self.palm0 = {}
        for side in 'RL':
            self.grip0[side], self.palm0[side] = rk.hand_grip_frame(self.data, side, GRIP_PALM_OFFSET, GRIP_ALONG_HAND)
        self.shoulder = {}
        self.pole = {}
        lo = self.rest['LowerArm.R'].translation
        self.len_upper = (lo - self.rest['UpperArm.R'].translation).length
        self.len_fore = (self.rest['Wrist.R'].translation - lo).length
        self.max_reach = {'R': 0.0, 'L': 0.0}
        self.max_bend = {'R': 0.0, 'L': 0.0}
        self.max_roll = {'R': 0.0, 'L': 0.0}
        self.max_at = {'R': 0.0, 'L': 0.0}
        self.t = 0.0

    def wrist_target(self, side, grip):
        """The wrist's matrix for a hand holding `grip` (rig space)."""
        return grip @ Matrix.Scale(HAND_SCALE, 4) @ self.grip0[side].inverted() @ self.rest[f'Wrist.{side}']

    def place_arms(self, grips):
        """Shoulders and elbow poles from ARMS for the first pose's hand targets `grips` {side: grip frame}."""
        rot = self.cam_to_rig.to_3x3()
        cam = self.cam_to_rig.inverted()
        for side in 'RL':
            spec = ARMS[self.name][side]
            w = self.wrist_target(side, grips[side]).translation
            elbow = w - (rot @ Vector(spec['fore']).normalized()) * self.len_fore
            self.shoulder[side] = elbow + (rot @ Vector(spec['upper']).normalized()) * self.len_upper
            self.pole[side] = (elbow - self.shoulder[side]).normalized()
            log(self.name, side, 'shoulder (camera)', tuple(round(x, 3) for x in cam @ self.shoulder[side]),
                'elbow', tuple(round(x, 3) for x in cam @ elbow), 'wrist', tuple(round(x, 3) for x in cam @ w))

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
        hand = [f'{a}.{side}' for a in HAND[1:]]
        # `shift`: the shoulder reaching forward (camera space), for a hand going further than the arm allows.
        sh = self.shoulder[side] + (self.cam_to_rig.to_3x3() @ Vector(shift) if shift else Vector())
        delta = Matrix.Translation(sh - self.rest[f'UpperArm.{side}'].translation)
        for n in names:
            mats[n] = delta @ self.rest[n]
        w0 = self.rest[f'Wrist.{side}']
        # The hand is scaled about the wrist; the grip point moves in with it, so aim the wrist at the scaled grip.
        wt = self.wrist_target(side, grip)
        reach = rk.solve_arm(data, mats, side, wt.translation, self.pole[side])
        if reach > self.max_reach[side]:
            self.max_reach[side], self.max_at[side] = reach, self.t
        mats[f'Wrist.{side}'] = wt
        self.twist(mats, side)
        for n in hand:
            mats[n] = wt @ w0.inverted() @ self.rest[n]
        # The hand's own frame as posed (not the grip's: a grip may lie diagonally in the palm, as the knife's does).
        hand = wt @ w0.inverted() @ self.grip0[side]
        r, f, u = (hand.col[i].to_3d().normalized() for i in range(3))
        axis = u if side == 'R' else -u
        palm = ((wt @ w0.inverted()).to_3x3() @ self.palm0[side]).normalized()
        # Each finger bends in its own plane, every joint toward the palm: its hinge is the finger's direction crossed
        # with the palm's normal (a finger pointing a little sideways still folds straight onto the palm).
        for finger in FINGERS:
            chain = [f'{finger}{k}.{side}' for k in (2, 3, 4)]
            d = (mats[chain[1]].to_translation() - mats[chain[0]].to_translation()).normalized()
            hinge = d.cross(palm)
            hinge = hinge.normalized() if hinge.length > 1e-6 else axis
            for i, b in enumerate(chain):
                rk.rotate_about(mats, chain[i:], mats[b].to_translation(), hinge, math.radians(curl[finger][i]))
        tchain = [f'Thumb{k}.{side}' for k in (1, 2, 3)]
        opp, c2, c3 = thumb
        # Opposition: the thumb swings across the palm about the metacarpals' direction, then its joints curl.
        rk.rotate_about(mats, tchain, mats[tchain[0]].to_translation(), f if side == 'R' else -f, math.radians(opp))
        rk.rotate_about(mats, tchain[1:], mats[tchain[1]].to_translation(), axis, math.radians(c2))
        rk.rotate_about(mats, tchain[2:], mats[tchain[2]].to_translation(), axis, math.radians(c3))


    def twist(self, mats, side):
        """Spreads the hand's roll about the forearm over LowerArm and the twist bones (TWIST_SHARE), and records the
        largest roll and the largest bend of the wrist off the forearm's line (for the log)."""
        lo, wr = f'LowerArm.{side}', f'Wrist.{side}'
        K = mats[lo].to_translation()
        T = mats[wr].to_translation()
        axis = (T - K).normalized()
        to_lo = mats[lo].to_3x3() @ self.rest[lo].to_3x3().inverted()
        to_wr = mats[wr].to_3x3() @ self.rest[wr].to_3x3().inverted()
        hand_dir = (to_wr @ self.grip0[side].col[1].to_3d()).normalized()
        self.max_bend[side] = max(self.max_bend[side], math.degrees(axis.angle(hand_dir)))
        fa = to_lo @ self.palm0[side]
        ha = to_wr @ self.palm0[side]
        fa = fa - axis * fa.dot(axis)
        ha = ha - axis * ha.dot(axis)
        ang = 0.0
        if fa.length > 1e-6 and ha.length > 1e-6:
            fa.normalize()
            ha.normalize()
            ang = math.atan2(fa.cross(ha).dot(axis), fa.dot(ha))
        self.max_roll[side] = max(self.max_roll[side], abs(math.degrees(ang)))
        base = mats[lo].copy()
        for n, share in TWIST_SHARE.items():
            b = f'{n}.{side}'
            m = base if n == 'LowerArm' else base @ self.rest[lo].inverted() @ self.rest[b]
            h = m.to_translation()
            mats[b] = Matrix.Translation(h) @ Matrix.Rotation(ang * share, 4, axis) @ Matrix.Translation(-h) @ m


def at(frame, m):
    return frame @ m


def clip(rig, name, seconds, fn):
    """Samples fn(t) -> pose at FPS over `seconds` and writes the action `name`."""
    n = max(1, int(round(seconds * FPS)))
    rig.max_bend = {'R': 0.0, 'L': 0.0}
    rig.max_roll = {'R': 0.0, 'L': 0.0}
    frames = []
    for i in range(n + 1):
        rig.t = min(seconds, i / FPS)
        frames.append((i, fn(rig.t)))
    act = rk.write_action(rig.arm, name, frames)
    log(rig.name, 'clip', name, 'frames', n + 1, 'seconds', round(n / FPS, 3), 'largest wrist bend R/L',
        round(rig.max_bend['R']), round(rig.max_bend['L']), 'roll about the forearm R/L', round(rig.max_roll['R']),
        round(rig.max_roll['L']))
    return act


def scaled(m, s):
    return m @ Matrix.Scale(s, 4)


HIDDEN = 0.001
# Rifle support hand, cradling the handguard from below: the palm faces up, leaning this far (degrees) toward the
# gun's left (the side the forearm comes from); the fingers curl over the far side, the thumb lies along the near
# side. SUPPORT_ALONG: how far the hand turns from straight across the handguard toward the forearm's line (0..1),
# so the wrist is not bent sideways. SUPPORT_INSET: the grip point inside the handguard's surface (m).
SUPPORT_TILT = 20
SUPPORT_ALONG = 0.5
SUPPORT_INSET = 0.02
# Right hand on the pistol grip: turned about the grip's axis (degrees, positive: knuckles toward the gun's left) so
# the hand lines up with a forearm coming from the lower right.
GRIP_R_YAW = 0
BOLT_TRAVEL = 0.07
# Aimed arms: the largest reach (fraction of the arm's length) before a shoulder leans toward its hand.
AIM_REACH = 0.985


def support_frame(hg, half, fore):
    """The rifle's support grip frame (gun frame): the handguard's centre `hg`, its half size `half`, the forearm's
    direction `fore` (gun frame)."""
    a = math.radians(SUPPORT_TILT)
    n = Vector((-math.sin(a), 0.0, math.cos(a)))
    across = Vector((0.0, 1.0, 0.0)).cross(n)
    f = fore - n * fore.dot(n)
    fwd = (across * (1 - SUPPORT_ALONG) + f.normalized() * SUPPORT_ALONG).normalized()
    up = n.cross(fwd)
    r = abs(n.x) * half.x + abs(n.z) * half.z
    return rk.frame_from(n, fwd, up, hg - n * (r - SUPPORT_INSET))


def build_gun_clips(rig):
    mk = rig.marks
    rifle = rig.name == 'rifle'
    gax = mk['grip_axis']
    # Right hand on the pistol grip, raked like the grip; trigger finger along the guard.
    # A little low on the grip so the web of the hand sits under the slide or receiver.
    grip_r = Matrix.Translation(gax * -0.014) @ tilt_to(gax) @ Matrix.Rotation(math.radians(GRIP_R_YAW), 4, 'Z')
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
        # Left hand under the handguard: index finger forward along it, palm up and turned toward the gun's right,
        # fingers wrapping round its right side.
        fore_l = rig.cam_to_rig.to_3x3() @ Vector(ARMS['rifle']['L']['fore']).normalized()
        support = support_frame(mk['handguard'], mk['handguard_half'], fore_l)
        # Holding the magazine: palm on its left side, fingers round its front.
        mag_grip = Matrix.Translation(mk['mag_centre'] + Vector((-0.004, 0.0, -0.005))) @ tilt_to(max_)
        # Pulling the charging handle (right side): the left hand comes under the gun, palm toward the receiver,
        # fingers up over the handle.
        handle = mk['handle']
        bolt_grip = rk.frame_from(Vector((-1, 0, 0)), Vector((0, 0, 1)), Vector((0, 1, 0)),
                                  handle + Vector((0.021, 0.004, -0.012)))
        support_curl, support_thumb = WRAP_CURL, THUMB_GRIP
    else:
        # Support hand wrapped over the right hand's fingers on the grip's left side.
        support = Matrix.Translation(Vector(PISTOL_SUPPORT)) @ tilt_to(gax) @ \
            Matrix.Rotation(math.radians(PISTOL_SUPPORT_PITCH), 4, 'X') @ Matrix.Rotation(math.radians(-12), 4, 'Y')
        # Holding the new magazine by its base, palm up.
        mag_grip = Matrix.Translation(mk['mag_bottom'] + Vector((0, 0, -0.03))) @ rk.frame_from(
            Vector((0, 0, 1)), Vector((0, 1, 0)), Vector((-1, 0, 0)), Vector())
        rear = mk['slide_rear']
        bolt_grip = Matrix.Translation(rear + Vector((0.0, 0.0, 0.035))) @ rk.frame_from(
            Vector((0, 0, -1)), Vector((1, 0, 0)), Vector((0, -1, 0)), Vector())
        support_curl, support_thumb = WRAP_CURL, THUMB_FWD_L
    thumb_r = THUMB_GRIP if rifle else THUMB_FWD_R
    hand_to_mag = mag_grip.inverted() @ mag_rest
    rig.place_arms({'R': grip_r, 'L': support})

    def gun_at(t, keys):
        return rk.offset_frame(*rk.keyed(keys, t))

    def idle(t):
        return rig.pose(Matrix(), rest_parts, {'R': grip_r, 'L': support},
                        {'R': TRIGGER_CURL, 'L': support_curl}, {'R': thumb_r, 'L': support_thumb})

    clip(rig, f'{rig.name}_idle', 1 / FPS, idle)
    # Aimed with each sight: the gun stays where the client puts it (the aim point on the eye), and the arms are
    # solved again from shoulders that stay put relative to the eye, so the arms do not slide into view with the gun.
    # The client blends from idle to these by the aim progress.
    hip_cam = rig.cam_to_rig.inverted()
    hip_shoulder, hip_pole = dict(rig.shoulder), dict(rig.pole)
    for sight, ap in sorted(rig.aims.items()):
        to_rig = Matrix.Translation(ap)
        rig.shoulder = {sd: to_rig @ hip_cam @ p for sd, p in hip_shoulder.items()}
        rig.pole = {sd: (hip_cam.to_3x3() @ v).normalized() for sd, v in hip_pole.items()}
        # The aimed gun is further out than at the hip (the eye sits behind the sight): where a hand would be out of
        # reach, its shoulder leans toward it along the arm's line (as the body leans into the stock).
        for sd, g in (('R', grip_r), ('L', support)):
            w = rig.wrist_target(sd, g).translation
            d = w - rig.shoulder[sd]
            reach = AIM_REACH * (rig.len_upper + rig.len_fore)
            if d.length > reach:
                rig.shoulder[sd] = rig.shoulder[sd] + d.normalized() * (d.length - reach)
        clip(rig, f'{rig.name}_aim_{sight}', 1 / FPS, idle)
    rig.shoulder, rig.pole = hip_shoulder, hip_pole

    if rifle:
        # Raised, the muzzle tipped steeply up and to the right, rolled clockwise so the magazine well faces the left
        # hand coming up from the bottom centre (the common shooter reload; RELOAD_* below).
        G1 = RELOAD_MAG
        G1b = tuple(a + b for a, b in zip(RELOAD_MAG, (0, 0, 0.008, 3, 0, 0)))     # magazine seated: a small jolt up
        G2 = RELOAD_BOLT                                                           # the charging handle toward the hand
        G2c = tuple(a + b for a, b in zip(RELOAD_BOLT, (-0.005, -0.015, 0, -2, 2, -3)))  # bolt pulled: rocks back
        gun_keys = [(0.0, (0, 0, 0, 0, 0, 0)), (0.25, G1), (1.36, G1), (1.42, G1b), (1.55, G1), (1.8, G2), (1.9, G2),
                    (1.97, G2c), (2.07, G2c), (2.1, G2), (2.2, (0, 0, 0, 0, 0, 0))]
        belt = rig.cam(Matrix.Translation(Vector(RELOAD_BELT)) @ Matrix.Rotation(math.radians(-30), 4, 'X'))
        bolt_keys = [(0.0, (0.0,)), (1.9, (0.0,)), (1.97, (-BOLT_TRAVEL,)), (2.07, (-BOLT_TRAVEL,)), (2.1, (0.0,))]

        def gunm(t):
            return gun_at(t, gun_keys)

        def bolt_off(t):
            return rk.keyed(bolt_keys, t)[0]

        def on_gun(m, extra=None):
            return lambda t: gunm(t) @ (extra(t) if extra else Matrix()) @ m

        down = lambda d: (lambda t: Matrix.Translation(-max_ * d))
        left_keys = [
            # The left hand lets go of the handguard as the gun rises and comes up open under the magazine well.
            (0.0, on_gun(support)), (0.06, on_gun(support)), (0.2, on_gun(mag_grip, down(0.07))), (0.3, on_gun(mag_grip)),
            (0.55, on_gun(mag_grip, down(0.12))), (0.75, belt), (1.0, belt),
            (1.25, on_gun(mag_grip, down(0.09))), (1.4, on_gun(mag_grip)), (1.5, on_gun(mag_grip)),
            (1.8, on_gun(bolt_grip)), (1.9, on_gun(bolt_grip)),
            (1.97, lambda t: gunm(t) @ Matrix.Translation(Vector((0, bolt_off(t), 0))) @ bolt_grip),
            (2.07, lambda t: gunm(t) @ Matrix.Translation(Vector((0, -BOLT_TRAVEL, 0))) @ bolt_grip),
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
            # The left shoulder reaches forward and across for the charging handle.
            sw = rk.keyed([(0.0, (0.0,)), (1.55, (0.0,)), (1.8, (1.0,)), (2.07, (1.0,)), (2.2, (0.0,))], t)[0]
            # Both shoulders follow the gun up while it is raised for the reload.
            rw = rk.keyed([(0.0, (0.0,)), (0.25, (1.0,)), (2.05, (1.0,)), (2.2, (0.0,))], t)[0]
            shift = {'L': (0.08 * sw, 0.06 * sw + 0.09 * rw, 0.02 * sw + 0.07 * rw), 'R': (0.0, 0.1 * rw, 0.07 * rw)}
            holding = 0.28 <= t < 1.45
            lc = WRAP_CURL if holding else (PINCH_CURL if 1.75 <= t < 2.12 else (RELAX_CURL if 0.06 <= t < 0.28 else support_curl))
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
            # Both shoulders reach forward while the gun is pushed out to rack the slide.
            rw = rk.keyed([(0.0, (0.0,)), (0.12, (1.0,)), (1.25, (1.0,)), (1.4, (0.0,))], t)[0]
            shift = {'L': (0.03 * sw, 0.12 * sw, 0.05 * sw),
                     'R': (-0.04 * sw, 0.09 * sw + 0.04 * rw, 0.03 * sw + 0.02 * rw)}
            lc = support_curl if (t < 0.08 or t >= 1.3) else (PINCH_CURL if 0.9 <= t < 1.22 else
                                                               (WRAP_CURL if 0.4 <= t < 0.76 else RELAX_CURL))
            return rig.pose(gun, parts, {'R': gun @ grip_r, 'L': left}, {'R': TRIGGER_CURL, 'L': lc},
                            {'R': thumb_r, 'L': support_thumb if t < 0.08 or t >= 1.3 else
                             (THUMB_GRIP if 0.4 <= t < 1.22 else THUMB_RELAX)}, shift)

        clip(rig, f'{rig.name}_reload', 1.4, reload)


def knife_frame(pos, blade, spine):
    """Knife frame in camera space (Blender axes): origin at the handle's middle, Y along the blade, Z = spine."""
    y = Vector(blade).normalized()
    z = Vector(spine)
    z = (z - y * z.dot(y)).normalized()
    return rk.frame_from(y.cross(z), y, z, Vector(pos))


def knife_grip(k):
    """Right-hand grip frame for a knife frame (clips.py KNIFE_IN_HAND, socket_knife): the handle runs pinky to index, the
    blade out of the index side, the spine toward the wrist."""
    x, y, z = (k.col[i].to_3d() for i in range(3))
    up, fwd = y, -z
    g = rk.frame_from(fwd.cross(up), fwd, up, k.translation)
    # The handle lies diagonally across the palm, as a real hand holds it (the wrist then stays nearly straight).
    return g @ Matrix.Rotation(math.radians(KNIFE_DIAGONAL), 4, 'X')


# Degrees the knife's handle turns in the palm (about the palm's normal) from square across it.
KNIFE_DIAGONAL = float(os.environ.get('SB_KNIFE_DIAGONAL', '45'))


def build_knife_clips(rig):
    REST = knife_frame((0.12, 0.26, -0.14), (-0.2, 0.92, 0.33), (0.0, -0.35, 0.94))
    BACK = knife_frame((0.23, 0.32, -0.08), (-0.25, -0.1, 1.0), (0.4, -0.9, 0.0))
    SLASH = knife_frame((-0.04, 0.32, -0.23), (-1.0, 0.45, -0.15), (-0.1, 0.2, 1.0))
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

    rig.place_arms({'R': knife_grip(REST), 'L': guard})

    def pose_at(k, t=0.0):
        # The shoulder reaches forward and across into the slash.
        sw = rk.keyed([(0.0, (0.0,)), (0.2, (0.6,)), (0.32, (1.0,)), (0.52, (0.0,))], t)[0]
        return rig.pose(k, {}, {'R': knife_grip(k), 'L': guard}, {'R': GRIP_CURL, 'L': RELAX_CURL},
                        {'R': THUMB_KNIFE, 'L': THUMB_RELAX}, {'R': (-0.08 * sw, 0.12 * sw, 0.04 * sw)})

    clip(rig, 'knife_idle', 1 / FPS, lambda t: pose_at(REST))
    clip(rig, 'knife_swing', 0.52, lambda t: pose_at(frame_at(t), t))


# ---------------------------------------------------------------------------------------------

def skin(obj, arm, groups=None):
    if groups:
        for gname in groups:
            g = obj.vertex_groups.new(name=gname)
            g.add(list(range(len(obj.data.vertices))), 1.0, 'REPLACE')
    obj.parent = arm
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm


def build(rig_name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    weapons = import_weapons()
    parts, marks = weapon_parts(rig_name, weapons)
    layout, swatch_rect = rl.LAYOUTS[rig_name]
    # The arms (package O): the soldier's forearms, hands and rolled sleeves (defender) or the ghost's suit arms, cut
    # from soldier.py's sources, their textures in this gun's atlas (weapons.py wrote them there).
    src, sparts = soldier.fp_sources()
    s = 1.0
    crops = soldier.fp_crops(sparts)
    atlas = rl.Atlas(rig_name, [(k, r, {}) for k, r in layout] +
                     [rl.Region(k, r, crop=crops.get(k)) for k, r in rl.ARM_LAYOUTS[rig_name].items()], swatch_rect)
    palettes = ['defender', 'ghost'] if rig_name == 'knife' else ['defender']
    arms = [(pal, soldier.fp_arms(pal, sparts[pal], atlas, rig_name)) for pal in palettes]
    for pal, objs in sparts.items():
        if pal not in palettes:
            for o in objs:
                bpy.data.objects.remove(o)
    for pal, a in arms:
        log(pal, 'arms tris', tris(a.data), 'verts', len(a.data.vertices))

    extra = [('weapon', None, (0, 0, 0))]
    for bone in parts:
        if bone == 'weapon':
            continue
        pts = [o.matrix_world @ v.co for o in parts[bone] for v in o.data.vertices]
        c = sum(pts, Vector()) / len(pts)
        if bone == 'mag' and 'mag_centre' in marks:
            c = marks['mag_centre']
        extra.append((bone, 'weapon', tuple(c)))
    # The armature must not share a name with a mesh node (the client picks the knife's variant by node name).
    arm = make_armature(f'rig_{rig_name}', src, s, extra)
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
        skin(m, arm)
        meshes.append(m)
        log(name, 'tris', tris(m.data), 'verts', len(m.data.vertices))

    for m in meshes:
        rl.single_material(m, rig_name)
        with bpy.context.temp_override(object=m, active_object=m):
            bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
            bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)

    # Muzzle points under the weapon bone (guns).
    empties = []
    prefix = {'rifle': 'gun', 'pistol': 'pistol'}.get(rig_name)
    if prefix:
        pairs = [(f'{prefix}_muzzle', 'muzzle'), (f'{prefix}_muzzle_bare', 'muzzle_bare')]
        pairs += [(n, n[len(prefix) + 1:]) for n in sorted(weapons) if n.startswith(f'{prefix}_aim_')]
        for src_name, name in pairs:
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
    bpy.context.view_layer.update()
    aims = {e.name[len('aim_'):]: e.matrix_world.translation.copy() for e in empties if e.name.startswith('aim_')}
    rig = Rig(rig_name, arm, marks, cam_to_rig, aims)
    if rig_name == 'knife':
        build_knife_clips(rig)
    else:
        build_gun_clips(rig)
    log(rig_name, 'reach (fraction of arm length) right', round(rig.max_reach['R'], 3), 'at', round(rig.max_at['R'], 2),
        's; left', round(rig.max_reach['L'], 3), 'at', round(rig.max_at['L'], 2), 's')
    if rig.max_reach['R'] > 0.995 or rig.max_reach['L'] > 0.995:
        log('WARNING a hand target is out of reach: the arm is straight and the hand floats')

    if PREVIEW_DIR:
        preview(rig, PREVIEW_DIR, PREVIEW_SHOTS[rig_name])
    rk.set_action(arm, next(a for a in bpy.data.actions if a.name.endswith('_idle')))
    scene.frame_set(0)
    for o in bpy.data.objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    out = os.path.join(OUT_DIR, f'viewmodel_{rig_name}.glb')
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_tangents=False, export_vertex_color='ACTIVE', export_all_vertex_colors=False,
        export_materials='EXPORT', export_image_format='NONE', export_skins=True, export_all_influences=False, export_def_bones=False,
        export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
        export_optimize_animation_size=True, export_anim_slide_to_zero=False, export_morph=False,
        export_extras=False, export_cameras=False, export_lights=False)
    log('wrote', out, os.path.getsize(out), 'bytes')
    rl.quantize(out)


def preview(rig, out_dir, shots):
    """Camera-view renders (Workbench) of `shots` = [(action name, seconds, file stem)]: the camera at the origin
    looking along +Y, vertical field of view 74 degrees (the game's default), 1366 x 768; the rig at its hip pose."""
    scene = bpy.context.scene
    arm = rig.arm
    arm.matrix_world = rig.cam_to_rig.inverted()
    cam_data = bpy.data.cameras.new('preview')
    cam_data.sensor_fit = 'VERTICAL'
    cam_data.angle_y = math.radians(74)
    cam_data.clip_start = 0.01
    cam = bpy.data.objects.new('preview', cam_data)
    scene.collection.objects.link(cam)
    cam.matrix_world = Matrix.Rotation(math.radians(90), 4, 'X')
    scene.camera = cam
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.003, location=(0, 1, 0))
    dot = bpy.context.active_object
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'VERTEX'
    scene.display.shading.show_cavity = True
    scene.display.shading.show_object_outline = True
    scene.render.resolution_x, scene.render.resolution_y = 1366, 768
    scene.render.resolution_percentage = 60
    scene.render.image_settings.file_format = 'JPEG'
    os.makedirs(out_dir, exist_ok=True)
    for action, t, stem in shots:
        rk.set_action(arm, bpy.data.actions[action])
        scene.frame_set(int(round(t * FPS)))
        scene.render.filepath = os.path.join(out_dir, f'{stem}.jpg')
        bpy.ops.render.render(write_still=True)
        # A close-up of the hands: the middle-right of the view at full size.
        scene.render.resolution_percentage = 100
        scene.render.use_border = scene.render.use_crop_to_border = True
        scene.render.border_min_x, scene.render.border_max_x = 0.42, 0.92
        scene.render.border_min_y, scene.render.border_max_y = 0.0, 0.6
        scene.render.filepath = os.path.join(out_dir, f'{stem}-close.jpg')
        bpy.ops.render.render(write_still=True)
        scene.render.resolution_percentage = 60
        scene.render.use_border = False
        # From the left and a little in front of the weapon, to judge the grips.
        target = rig.cam_to_rig.inverted() @ Vector((0, 0.06, 0)) if rig.name != 'knife' else Vector((0.15, 0.36, -0.16))
        eye = target + Vector((-0.33, 0.12, 0.06))
        cam.matrix_world = Matrix.Translation(eye) @ (target - eye).to_track_quat('-Z', 'Y').to_matrix().to_4x4()
        scene.render.filepath = os.path.join(out_dir, f'{stem}-side.jpg')
        bpy.ops.render.render(write_still=True)
        cam.matrix_world = Matrix.Rotation(math.radians(90), 4, 'X')
    bpy.data.objects.remove(cam)
    bpy.data.objects.remove(dot)
    arm.matrix_world = Matrix()


PREVIEW_DIR = ''
PREVIEW_SHOTS = {
    'rifle': [('rifle_idle', 0, 'rifle-idle'), ('rifle_reload', 0.25, 'rifle-reload-0-hand-in'),
              ('rifle_reload', 0.5, 'rifle-reload-a'), ('rifle_reload', 1.15, 'rifle-reload-b'),
              ('rifle_reload', 1.95, 'rifle-reload-c')],
    'pistol': [('pistol_idle', 0, 'pistol-idle'), ('pistol_reload', 0.42, 'pistol-reload-a'), ('pistol_reload', 1.06, 'pistol-reload-c')],
    'knife': [('knife_idle', 0, 'knife-idle')] + [('knife_swing', t, f'knife-swing-{int(t * 100):02d}') for t in
                                                   (0.1, 0.2, 0.26, 0.3, 0.34, 0.42, 0.5)],
}


def main():
    only = None
    if '--' in sys.argv:
        rest = sys.argv[sys.argv.index('--') + 1:]
        if '--rig' in rest:
            only = rest[rest.index('--rig') + 1]
        if '--preview' in rest:
            global PREVIEW_DIR
            PREVIEW_DIR = rest[rest.index('--preview') + 1]
    for name in ('rifle', 'pistol', 'knife'):
        if only and name != only:
            continue
        build(name)


main()
