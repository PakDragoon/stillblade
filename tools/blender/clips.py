"""
Character clips for soldier.py (package O): retargeting from the SWAT clips, the generated crouch and held-weapon clips,
the hand sockets, and the export. Works on the shipped skeleton (soldier.BONES names), built facing Blender -Y with the
armature object at identity; `export` turns the finished character to face +Y (glTF -Z, the engine's forward).

Retargeting (idle, walk, run, death, hit from SWAT.glb): for every shipped bone, a rest alignment C turns the target's
rest frame (bone direction + the character's forward) onto the source's, so the target's A-pose is read as the source's
T-pose; then each frame the source bone's world rotation change from its rest, D, is applied: rotation = D * C * rest.
Positions follow the target's own bone lengths (forward kinematics) from the hips, whose movement is scaled by the
ratio of hip heights; finally each leg is re-solved with two-bone IK so the ankle goes where the source's foot goes
(scaled), which keeps the feet planted and on the ground.
"""
import math
import os

import bpy
from mathutils import Matrix, Vector

import realistic as rl
import rigkit as rk

FPS = 24
FWD = Vector((0, -1, 0))
RIGHT = Vector((-1, 0, 0))
UP = Vector((0, 0, 1))


def char(v):
    return RIGHT * v[0] + FWD * v[1] + UP * v[2]


def log(*a):
    rk.log('clips', *a)


# Source clip -> shipped name.
RETARGET = {'Idle': 'idle', 'Walk': 'walk', 'Run': 'run', 'Death': 'death', 'HitRecieve': 'hit'}
# Bone -> the child whose direction defines its rest alignment.
DIRS = {'Hips': 'Abdomen', 'Abdomen': 'Torso', 'Torso': 'Chest', 'Chest': 'Neck', 'Neck': 'Head'}
for _S in 'LR':
    DIRS.update({f'Shoulder.{_S}': f'UpperArm.{_S}', f'UpperArm.{_S}': f'LowerArm.{_S}',
                 f'LowerArm.{_S}': f'Wrist.{_S}', f'Wrist.{_S}': f'Middle2.{_S}',
                 f'UpperLeg.{_S}': f'LowerLeg.{_S}', f'LowerLeg.{_S}': f'Foot.{_S}',
                 f'Thumb1.{_S}': f'Thumb2.{_S}', f'Thumb2.{_S}': f'Thumb3.{_S}'})
    for _F in ('Index', 'Middle', 'Ring', 'Pinky'):
        DIRS.update({f'{_F}2.{_S}': f'{_F}3.{_S}', f'{_F}3.{_S}': f'{_F}4.{_S}'})
# Leaves borrow their parent's alignment.
SAME_AS = {}
for _S in 'LR':
    SAME_AS[f'Thumb3.{_S}'] = f'Thumb2.{_S}'
    for _F in ('Index', 'Middle', 'Ring', 'Pinky'):
        SAME_AS[f'{_F}4.{_S}'] = f'{_F}3.{_S}'

# Crouch (metres, degrees), as the old SWAT pipeline (characters.py, removed in package O) had them.
CROUCH_DROP = {'crouch_idle': 0.50, 'crouch_walk': 0.40}
CROUCH_LEAN = 22.0
CROUCH_HEAD_COUNTER = 0.8
CROUCH_FEET_IN = 0.75
DEATH_RECENTRE = 0.6

# Held weapons. Rifle: the chest turns right (bladed stance) so the left hand reaches the handguard; the gun's grip sits
# this far from the turned right shoulder joint (character frame: right, forward, up), stock in the shoulder pocket.
AIM_CHEST_YAW = -22.0
AIM_NECK_YAW = 18.0
AIM_GUN_FROM_SHOULDER = (0.07, 0.27, -0.06)
POLE = {'R': (0.8, -0.2, -1.0), 'L': (-0.8, -0.1, -1.0)}
SHOOT_CURVE = (0.0, 1.0, 0.62, 0.32, 0.12, 0.0)
SHOOT_BACK = 0.035
SHOOT_CLIMB = 5.0
SHOOT_CHEST = 2.0
# Pistol: two hands, arms out in front, the pistol under the eye line.
PISTOL_CHEST_YAW = -8.0
PISTOL_FROM_SHOULDER = (0.11, 0.47, -0.04)
PISTOL_SHOOT_CLIMB = 12.0
PISTOL_SHOOT_BACK = 0.03
# Knife (relative to the right shoulder).
KNIFE_HOLD_FROM_SHOULDER = (0.02, 0.3, -0.3)
KNIFE_BACK_FROM_SHOULDER = (0.1, 0.05, 0.08)
KNIFE_STRIKE_FROM_SHOULDER = (-0.3, 0.35, -0.22)
LEFT_GUARD_FROM_SHOULDER = (-0.38, 0.3, -0.3)
BELT_FROM_SHOULDER = (-0.3, 0.1, -0.42)
# Hands: grip point off the palm and along the hand; finger curls (degrees, phalanges 2, 3, 4), thumbs (opposition,
# curl 2, curl 3) per hold, as in viewmodel.py.
GRIP_PALM_OFFSET = 0.03
GRIP_ALONG_HAND = 0.55
GRIP_CURL = {f: (75, 80, 45) for f in ('Index', 'Middle', 'Ring', 'Pinky')}
TRIGGER_CURL = dict(GRIP_CURL, Index=(25, 35, 15))
WRAP_CURL = {f: (65, 70, 40) for f in ('Index', 'Middle', 'Ring', 'Pinky')}
RELAX_CURL = {f: (20, 25, 12) for f in ('Index', 'Middle', 'Ring', 'Pinky')}
THUMB_GRIP = (50, 20, 15)
THUMB_RELAX = (15, 8, 4)
SUPPORT_ROLL = -35
SUPPORT_INSET = 0.016


# ---------------------------------------------------------------------------------------------
# SWAT source

def import_swat(path):
    before = set(bpy.data.objects)
    acts_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    mw = arm.matrix_world.copy()
    arm.parent = None
    arm.matrix_world = mw
    for o in new:
        if o is not arm:
            bpy.data.objects.remove(o)
    acts = {a.name.split('|')[-1]: a for a in bpy.data.actions if a not in acts_before}
    return arm, acts


def rot(m):
    return m.to_3x3().normalized()


def frame(d, ref):
    d = d.normalized()
    r = ref - d * ref.dot(d)
    if r.length < 0.3:
        alt = UP if abs(d.dot(UP)) < 0.7 else FWD
        r = alt - d * alt.dot(d)
    r.normalize()
    return Matrix((d.cross(r), d, r)).transposed()


class Retarget:
    def __init__(self, src, tgt):
        self.src, self.tgt = src, tgt
        sw = src.matrix_world
        self.s_rest = {b.name: sw @ b.matrix_local for b in src.data.bones}
        self.t_rest = {b.name: b.matrix_local.copy() for b in tgt.data.bones}
        self.order = [b.name for b in tgt.data.bones]
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in tgt.data.bones}
        self.C = {}
        for b in self.order:
            if b not in DIRS or b not in self.s_rest:
                continue
            c = DIRS[b]
            ds = self.s_rest[c].translation - self.s_rest[b].translation
            dt = self.t_rest[c].translation - self.t_rest[b].translation
            self.C[b] = frame(ds, FWD) @ frame(dt, FWD).transposed()
        for b, p in SAME_AS.items():
            if p in self.C:
                self.C[b] = self.C[p]
        # The source's shoulder bones slope up to the arm (a cartoon build); copying their direction would hunch the
        # target's clavicles. Shoulders take the motion only.
        for S in 'LR':
            self.C.pop(f'Shoulder.{S}', None)
        self.k = self.t_rest['Hips'].translation.z / self.s_rest['Hips'].translation.z
        log('hip height ratio target / source', round(self.k, 3))

    def pose(self, action, f):
        rk.set_action(self.src, action)
        bpy.context.scene.frame_set(int(f))
        sw = self.src.matrix_world
        sp = {pb.name: sw @ pb.matrix for pb in self.src.pose.bones}
        R, P = {}, {}
        for b in self.order:
            rt = rot(self.t_rest[b])
            if b in sp and b in self.s_rest:
                D = rot(sp[b]) @ rot(self.s_rest[b]).transposed()
                R[b] = D @ self.C.get(b, Matrix.Identity(3)) @ rt
            else:
                par = self.parent[b]
                R[b] = (R[par] @ rot(self.t_rest[par]).transposed() @ rt) if par else rt
        for b in self.order:
            par = self.parent[b]
            if b == 'Hips':
                P[b] = self.t_rest[b].translation + (sp['Hips'].translation - self.s_rest['Hips'].translation) * self.k
            elif par is None:
                P[b] = self.t_rest[b].translation.copy()
            else:
                off = self.t_rest[b].translation - self.t_rest[par].translation
                P[b] = P[par] + (R[par] @ rot(self.t_rest[par]).transposed()) @ off
        mats = {b: Matrix.LocRotScale(P[b], R[b].to_quaternion(), None) for b in self.order}
        # Feet back where the source's feet are (scaled), legs re-solved.
        for S in 'LR':
            foot = f'Foot.{S}'
            want = self.t_rest[foot].translation + (sp[foot].translation - self.s_rest[foot].translation) * self.k
            fk_knee = mats[f'LowerLeg.{S}'].translation - mats[f'UpperLeg.{S}'].translation
            solve_leg(self.tgt.data, mats, S, want, fk_knee)
        return mats


def solve_leg(data, mats, S, target, pole):
    """Two-bone IK (UpperLeg, LowerLeg) putting the ankle at `target`, knee toward `pole`; the foot keeps its rotation."""
    up, lo, ft = f'UpperLeg.{S}', f'LowerLeg.{S}', f'Foot.{S}'
    ub, lb, fb = data.bones[up], data.bones[lo], data.bones[ft]
    la = (lb.head_local - ub.head_local).length
    lbl = (fb.head_local - lb.head_local).length
    H = mats[up].translation
    K0 = mats[lo].translation
    A0 = mats[ft].translation
    ht = target - H
    d = min(max(ht.length, abs(la - lbl) + 1e-6), la + lbl - 1e-5)
    dirv = ht.normalized()
    bend = pole - dirv * pole.dot(dirv)
    if bend.length < 1e-4:
        bend = FWD - dirv * FWD.dot(dirv)
    bend.normalize()
    x = (la * la - lbl * lbl + d * d) / (2 * d)
    h = math.sqrt(max(la * la - x * x, 0.0))
    K = H + dirv * x + bend * h
    T = H + dirv * d
    q1 = (K0 - H).rotation_difference(K - H)
    mu = (q1.to_matrix() @ mats[up].to_3x3()).to_4x4()
    mu.translation = H
    mats[up] = mu
    old = q1 @ (A0 - K0)
    q2 = old.rotation_difference(T - K)
    ml = ((q2 @ q1).to_matrix() @ mats[lo].to_3x3()).to_4x4()
    ml.translation = K
    mats[lo] = ml
    fm = mats[ft].copy()
    fm.translation = T
    mats[ft] = fm


def retarget_clip(rt, action, name):
    a, b = (int(round(x)) for x in action.frame_range)
    frames = [(f - a, rt.pose(action, f)) for f in range(a, b + 1)]
    log('retargeted', name, 'frames', len(frames))
    return frames


# ---------------------------------------------------------------------------------------------
# Generated clips

def descendants(data, name):
    return [name] + rk.descendants(data.bones[name])


def turn(mats, names, pivot_bone, axis, deg):
    pivot = mats[pivot_bone].translation.copy()
    rk.rotate_about(mats, names, pivot, axis, math.radians(deg))


def crouch(rt, frames, name):
    data = rt.tgt.data
    below = descendants(data, 'Hips')
    spine = descendants(data, 'Abdomen')
    neck = descendants(data, 'Neck')
    # The source's idle stands with one foot well forward: kept under dropped hips, that leg goes straight out in a
    # lunge. Each foot's average forward offset from the hips (its stance, not its stride) is mostly taken out.
    stance = {S: sum((m[f'Foot.{S}'].translation - m['Hips'].translation).dot(FWD) for _, m in frames) / len(frames)
              for S in 'LR'}
    out = []
    for f, m0 in frames:
        mats = {k: v.copy() for k, v in m0.items()}
        feet = {S: Matrix.Translation(-FWD * stance[S] * CROUCH_FEET_IN) @ mats[f'Foot.{S}'] for S in 'LR'}
        T = Matrix.Translation(-UP * CROUCH_DROP[name])
        for n in below:
            mats[n] = T @ mats[n]
        # Positive turn about the character's right tips the top backward (right-handed right, forward, up): lean
        # forward with a negative angle.
        turn(mats, spine, 'Abdomen', RIGHT, -CROUCH_LEAN)
        turn(mats, neck, 'Neck', RIGHT, CROUCH_LEAN * CROUCH_HEAD_COUNTER)
        for S in 'LR':
            for n in descendants(data, f'Foot.{S}'):
                mats[n] = feet[S] @ m0[f'Foot.{S}'].inverted() @ m0[n]
            solve_leg(data, mats, S, feet[S].translation, FWD)
        out.append((f, mats))
    log('built', name)
    return out


def recentre_death(frames):
    h0 = frames[0][1]['Hips'].translation
    out = []
    for f, mats in frames:
        back = -(mats['Hips'].translation - h0).dot(FWD)
        T = Matrix.Translation(FWD * max(0.0, back) * DEATH_RECENTRE)
        out.append((f, {n: T @ m for n, m in mats.items()}))
    return out


def load_marks():
    """Gun landmarks and parts from weapons.py's first-person file, in the guns' frame (Blender X right, Y forward,
    Z up, origin at the grip)."""
    if not os.path.exists(rl.FP_GLB):
        raise FileNotFoundError(f'{rl.FP_GLB} is missing: run tools/blender/weapons.py first')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=rl.FP_GLB)
    bpy.context.view_layer.update()
    marks, bounds = {}, {}
    for o in [o for o in bpy.data.objects if o not in before]:
        n = o.name.split('.')[0]
        if n.startswith('fp_mark_'):
            m = o.matrix_world
            marks[n[len('fp_mark_'):]] = (m.translation.copy(), m.col[2].to_3d().normalized())
        elif o.type == 'MESH' and n in ('fp_gun', 'fp_pistol', 'fp_knife'):
            pts = [o.matrix_world @ v.co for v in o.data.vertices]
            bounds[n[3:]] = (Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))),
                             Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts))))
    for o in [o for o in bpy.data.objects if o not in before]:
        bpy.data.objects.remove(o)
    return marks, bounds


def tilt_to(axis):
    return Matrix.Rotation(-math.atan2(axis.y, axis.z), 4, 'X')


class Poser:
    """Arms and hands on the shipped skeleton (armature space = world while building)."""

    def __init__(self, arm, base):
        self.arm = arm
        self.data = arm.data
        self.base = base
        self.rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
        self.grip0, self.palm0 = {}, {}
        for S in 'RL':
            self.grip0[S], self.palm0[S] = rk.hand_grip_frame(self.data, S, GRIP_PALM_OFFSET, GRIP_ALONG_HAND)
        self.chest = descendants(self.data, 'Chest')
        self.neck = descendants(self.data, 'Neck')
        self.max_reach = {'R': 0.0, 'L': 0.0}

    def start(self, chest_yaw=0.0, chest_pitch=0.0):
        mats = {n: m.copy() for n, m in self.base.items()}
        if chest_yaw:
            turn(mats, self.chest, 'Chest', UP, chest_yaw)
            turn(mats, self.neck, 'Neck', UP, -chest_yaw * (AIM_NECK_YAW / max(1e-6, -AIM_CHEST_YAW)))
        if chest_pitch:
            turn(mats, self.chest, 'Chest', RIGHT, chest_pitch)
        return mats

    def shoulder(self, mats, S='R'):
        return mats[f'UpperArm.{S}'].translation.copy()

    def hand(self, mats, S, grip, curl, thumb):
        """Wrist placed so the hand's grip frame lands on `grip` (armature space), arm by IK, fingers curled."""
        w0 = self.rest[f'Wrist.{S}']
        wt = grip @ self.grip0[S].inverted() @ w0
        reach = rk.solve_arm(self.data, mats, S, wt.translation, char(POLE[S]).normalized())
        self.max_reach[S] = max(self.max_reach[S], reach)
        mats[f'Wrist.{S}'] = wt
        rk.twist_forearm(self.data, mats, S, self.palm0[S], 0.7)
        kids = rk.descendants(self.data.bones[f'Wrist.{S}'])
        for n in kids:
            mats[n] = wt @ w0.inverted() @ self.rest[n]
        r, f, u = (grip.col[i].to_3d().normalized() for i in range(3))
        axis = u if S == 'R' else -u
        for F in ('Index', 'Middle', 'Ring', 'Pinky'):
            chain = [f'{F}{k}.{S}' for k in (2, 3, 4)]
            for i, b in enumerate(chain):
                rk.rotate_about(mats, chain[i:], mats[b].translation.copy(), axis, math.radians(curl[F][i]))
        t = [f'Thumb{k}.{S}' for k in (1, 2, 3)]
        opp, c2, c3 = thumb
        rk.rotate_about(mats, t, mats[t[0]].translation.copy(), f if S == 'R' else -f, math.radians(opp))
        rk.rotate_about(mats, t[1:], mats[t[1]].translation.copy(), axis, math.radians(c2))
        rk.rotate_about(mats, t[2:], mats[t[2]].translation.copy(), axis, math.radians(c3))

    def hang(self, mats, S, curl=RELAX_CURL, thumb=THUMB_RELAX):
        """The arm as in the base pose, fingers relaxed."""
        w = mats[f'Wrist.{S}']
        g = w @ self.rest[f'Wrist.{S}'].inverted() @ self.grip0[S]
        self.hand(mats, S, g, curl, thumb)


def gun_frame(origin, pitch=0.0, yaw=0.0, roll=0.0):
    r = (Matrix.Rotation(math.radians(yaw), 4, UP) @ Matrix.Rotation(math.radians(pitch), 4, RIGHT)
         @ Matrix.Rotation(math.radians(roll), 4, FWD))
    m = r @ rk.frame_from(RIGHT, FWD, UP, Vector())
    m.translation = origin
    return m


def knife_frame(origin, blade, spine):
    y = char(blade).normalized()
    z = char(spine)
    z = (z - y * z.dot(y)).normalized()
    return rk.frame_from(y.cross(z), y, z, origin)


# Knife frame relative to the right hand's grip frame: blade out of the index side (the grip's up), spine toward the
# wrist (against the fingers).
KNIFE_IN_HAND = rk.frame_from(Vector((1, 0, 0)), Vector((0, 0, 1)), Vector((0, -1, 0)), Vector())


def weapon_clips(arm, base):
    marks, bounds = load_marks()
    P = Poser(arm, base)
    out = {}

    def clip(name, seconds, fn):
        n = max(1, int(round(seconds * FPS)))
        out[name] = [(i, fn(min(seconds, i / FPS))) for i in range(n + 1)]
        log('built', name, 'frames', n + 1)

    # --- Rifle -------------------------------------------------------------------------------------------------
    gax = marks['rifle_grip'][1]
    grip_r = Matrix.Translation(gax * -0.014) @ tilt_to(gax)
    hg, half = marks['rifle_handguard'][0], marks['rifle_handguard_size'][0]
    a = math.radians(SUPPORT_ROLL)
    sfwd, sup = Vector((math.cos(a), 0.0, math.sin(a))), Vector((0.0, 1.0, 0.0))
    spalm = sfwd.cross(sup)
    support = rk.frame_from(spalm, sfwd, sup, hg - spalm * max(0.0, half.z - SUPPORT_INSET))
    mag_c, mag_ax = marks['rifle_mag']
    mag_grip = Matrix.Translation(mag_c + Vector((-0.004, 0.0, -0.005))) @ tilt_to(mag_ax)
    handle = marks['rifle_handle'][0]
    bolt_grip = rk.frame_from(Vector((-1, 0, 0)), Vector((0, 0, 1)), Vector((0, 1, 0)), handle + Vector((0.021, 0.004, -0.012)))

    def rifle_at(mats, k=0.0, extra=Matrix()):
        g = gun_frame(P.shoulder(mats) + char(AIM_GUN_FROM_SHOULDER)) @ extra
        if k:
            g = g @ Matrix.Translation(Vector((0, -SHOOT_BACK * k, 0))) @ Matrix.Rotation(math.radians(SHOOT_CLIMB) * k, 4, 'X')
        return g

    def aim_pose(k=0.0):
        mats = P.start(AIM_CHEST_YAW, -SHOOT_CHEST * k)
        g = rifle_at(mats, k)
        P.hand(mats, 'R', g @ grip_r, TRIGGER_CURL, THUMB_GRIP)
        P.hand(mats, 'L', g @ support, WRAP_CURL, THUMB_GRIP)
        return mats

    out['aim'] = [(0, aim_pose()), (12, aim_pose())]
    out['shoot'] = [(i, aim_pose(k)) for i, k in enumerate(SHOOT_CURVE)]

    # Reload (2.2 s): gun lowered and canted, magazine out at 0.3 s, a new one from the vest at 0.75-1.0, seated at
    # 1.4 s, the charging handle pulled 1.9 s and released 2.07 s (the sound cues).
    def gun_offset(t):
        keys = [(0.0, (0, 0, 0, 0, 0, 0)), (0.25, (-0.02, -0.04, -0.12, 8, 12, 30)), (1.55, (-0.02, -0.04, -0.12, 8, 12, 30)),
                (1.8, (0.0, -0.04, -0.1, 4, 6, -12)), (2.07, (0.0, -0.04, -0.1, 4, 6, -12)), (2.2, (0, 0, 0, 0, 0, 0))]
        return rk.offset_frame(*rk.keyed(keys, t))

    def rifle_reload(t):
        mats = P.start(AIM_CHEST_YAW)
        g = rifle_at(mats, 0.0, gun_offset(t))
        belt = Matrix.Translation(P.shoulder(mats, 'L') + char((0.18, 0.18, -0.38))) @ tilt_to(Vector((0, 0.3, 1)))
        belt = belt @ rk.frame_from(RIGHT, FWD, UP, Vector())
        on = lambda m, d=0.0: (lambda tt: g @ Matrix.Translation(-mag_ax * d) @ m)
        bolt = rk.keyed([(0.0, (0.0,)), (1.9, (0.0,)), (1.97, (-0.06,)), (2.07, (-0.06,)), (2.1, (0.0,))], t)[0]
        lk = [(0.0, on(support)), (0.2, on(support)), (0.3, on(mag_grip)), (0.55, on(mag_grip, 0.22)),
              (0.75, lambda tt: belt), (1.0, lambda tt: belt), (1.25, on(mag_grip, 0.08)), (1.4, on(mag_grip)),
              (1.5, on(mag_grip)), (1.8, on(bolt_grip)), (1.9, on(bolt_grip)),
              (1.97, lambda tt: g @ Matrix.Translation(Vector((0, bolt, 0))) @ bolt_grip),
              (2.07, lambda tt: g @ Matrix.Translation(Vector((0, -0.06, 0))) @ bolt_grip), (2.2, on(support))]
        left = rk.keyed(lk, t)
        P.hand(mats, 'R', g @ grip_r, TRIGGER_CURL, THUMB_GRIP)
        holding = 0.28 <= t < 1.45
        P.hand(mats, 'L', left, WRAP_CURL if holding or t < 0.2 or t > 2.12 else GRIP_CURL, THUMB_GRIP)
        return mats

    clip('reload_rifle', 2.2, rifle_reload)

    # --- Pistol (two hands) --------------------------------------------------------------------------------
    pax = marks['pistol_grip'][1]
    pgrip_r = Matrix.Translation(pax * -0.012) @ tilt_to(pax)
    psupport = Matrix.Translation(Vector((-0.03, 0.012, -0.022))) @ tilt_to(pax) @ Matrix.Rotation(math.radians(-12), 4, 'Y')
    pmag_c, pmag_ax = marks['pistol_mag']
    pmag_bottom = marks['pistol_mag_bottom'][0]
    pmag_grip = Matrix.Translation(pmag_bottom + Vector((0, 0, -0.03))) @ rk.frame_from(
        Vector((0, 0, 1)), Vector((0, 1, 0)), Vector((-1, 0, 0)), Vector())
    rear = marks['pistol_slide_rear'][0]
    slide_grip = Matrix.Translation(rear + Vector((0.0, 0.0, 0.035))) @ rk.frame_from(
        Vector((0, 0, -1)), Vector((1, 0, 0)), Vector((0, -1, 0)), Vector())

    def pistol_at(mats, k=0.0, extra=Matrix()):
        g = gun_frame(P.shoulder(mats) + char(PISTOL_FROM_SHOULDER)) @ extra
        if k:
            g = g @ Matrix.Translation(Vector((0, -PISTOL_SHOOT_BACK * k, 0))) @ Matrix.Rotation(math.radians(PISTOL_SHOOT_CLIMB) * k, 4, 'X')
        return g

    def pistol_pose(k=0.0):
        mats = P.start(PISTOL_CHEST_YAW)
        g = pistol_at(mats, k)
        P.hand(mats, 'R', g @ pgrip_r, TRIGGER_CURL, THUMB_GRIP)
        P.hand(mats, 'L', g @ psupport, WRAP_CURL, THUMB_GRIP)
        return mats

    clip('pistol', 0.5, lambda t: pistol_pose())
    out['pistol_shoot'] = [(i, pistol_pose(k)) for i, k in enumerate(SHOOT_CURVE)]

    def poff(t):
        keys = [(0.0, (0, 0, 0, 0, 0, 0)), (0.15, (0.02, -0.12, -0.1, 18, 10, 25)), (0.9, (0.02, -0.12, -0.1, 18, 10, 25)),
                (1.0, (0.06, -0.12, -0.08, 8, 20, 8)), (1.17, (0.06, -0.12, -0.08, 8, 20, 8)), (1.4, (0, 0, 0, 0, 0, 0))]
        return rk.offset_frame(*rk.keyed(keys, t))

    def pistol_reload(t):
        mats = P.start(PISTOL_CHEST_YAW)
        g = pistol_at(mats, 0.0, poff(t))
        belt = Matrix.Translation(P.shoulder(mats, 'L') + char((0.15, 0.16, -0.4))) @ rk.frame_from(RIGHT, FWD, UP, Vector())
        on = lambda m, extra=Matrix(): (lambda tt: g @ extra @ m)
        sl = rk.keyed([(0.0, (0.0,)), (1.0, (0.0,)), (1.07, (-0.035,)), (1.17, (-0.035,)), (1.19, (0.0,))], t)[0]
        lk = [(0.0, on(psupport)), (0.12, on(psupport, Matrix.Translation(Vector((-0.06, -0.03, -0.08))))),
              (0.35, lambda tt: belt), (0.45, lambda tt: belt),
              (0.62, on(pmag_grip, Matrix.Translation(-pmag_ax * 0.06))), (0.7, on(pmag_grip)), (0.78, on(pmag_grip)),
              (0.95, on(slide_grip)), (1.0, on(slide_grip)),
              (1.07, lambda tt: g @ Matrix.Translation(Vector((0, sl, 0))) @ slide_grip),
              (1.17, lambda tt: g @ Matrix.Translation(Vector((0, -0.035, 0))) @ slide_grip), (1.4, on(psupport))]
        P.hand(mats, 'R', g @ pgrip_r, TRIGGER_CURL, THUMB_GRIP)
        P.hand(mats, 'L', rk.keyed(lk, t), WRAP_CURL if (t < 0.08 or t > 1.3 or 0.4 <= t < 0.8) else GRIP_CURL,
               THUMB_GRIP)
        return mats

    clip('reload_pistol', 1.4, pistol_reload)

    # --- Knife ------------------------------------------------------------------------------------------------
    def knife_pose(kf, guard_mats=None, yaw=0.0):
        mats = P.start(yaw)
        sh = P.shoulder(mats)
        k = kf(sh)
        P.hand(mats, 'R', k @ KNIFE_IN_HAND.inverted(), GRIP_CURL, THUMB_GRIP)
        guard = Matrix.Translation(sh + char(LEFT_GUARD_FROM_SHOULDER)) @ rk.frame_from(
            char((0, 0, 1)), char((0.3, 1, 0.3)).normalized(), char((-1, 0, 0)), Vector())
        guard = rk.frame_from(*(guard.col[i].to_3d() for i in range(3)), guard.translation)
        P.hand(mats, 'L', rk.lerp_frame(guard, guard, 0), GRIP_CURL, THUMB_GRIP)
        return mats

    hold = lambda sh: knife_frame(sh + char(KNIFE_HOLD_FROM_SHOULDER), (0.0, 0.85, 0.5), (0.0, -0.5, 0.85))
    back = lambda sh: knife_frame(sh + char(KNIFE_BACK_FROM_SHOULDER), (-0.2, -0.3, 1.0), (0.3, -1.0, 0.0))
    strike = lambda sh: knife_frame(sh + char(KNIFE_STRIKE_FROM_SHOULDER), (-1.0, 0.5, -0.2), (0.0, 0.3, 1.0))
    clip('knife_hold', 0.5, lambda t: knife_pose(hold))
    eases = [lambda x: 1 - (1 - x) * (1 - x), lambda x: x * x, rk.smooth]
    kk = [(0.0, hold, 0.0), (0.2, back, 18.0), (0.32, strike, -22.0), (0.57, hold, 0.0)]

    def swing(t):
        for i in range(len(kk) - 1):
            t0, a_, ya = kk[i]
            t1, b_, yb = kk[i + 1]
            if t <= t1:
                w = eases[i](min(1.0, max(0.0, (t - t0) / (t1 - t0))))
                return knife_pose(lambda sh: rk.lerp_frame(a_(sh), b_(sh), w), yaw=ya + (yb - ya) * w)
        return knife_pose(hold)

    clip('knife_swing', 0.57, swing)
    log('reach (fraction of arm length) right', round(P.max_reach['R'], 3), 'left', round(P.max_reach['L'], 3))
    # Sockets (rest pose, armature space): where each weapon's frame sits relative to the right hand.
    sockets = {'socket_gun': P.grip0['R'] @ grip_r.inverted(), 'socket_pistol': P.grip0['R'] @ pgrip_r.inverted(),
               'socket_knife': P.grip0['R'] @ KNIFE_IN_HAND}
    return out, sockets


# ---------------------------------------------------------------------------------------------

def prune(act, eps=2e-4):
    """Linear keys; a bone whose channel (location or rotation) does not change over the clip keeps only its first and
    last keys (the export then writes 2 keys instead of one per frame)."""
    groups = {}
    for fc in rk.action_fcurves(act):
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
        groups.setdefault(fc.data_path, []).append(fc)
    for curves in groups.values():
        if all(max(abs(k.co[1] - fc.keyframe_points[0].co[1]) for k in fc.keyframe_points) < eps for fc in curves):
            for fc in curves:
                while len(fc.keyframe_points) > 2:
                    fc.keyframe_points.remove(fc.keyframe_points[1], fast=True)
                fc.update()


def build(arm, looks, static=False):
    """Writes every clip onto `arm` as actions and adds the socket empties."""
    import soldier
    if static:
        rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
        rk.write_action(arm, 'idle', [(0, rest), (1, rest)])
        return
    # The FBX importer sets the scene to the file's 30 fps; the clips are sampled and written at FPS.
    bpy.context.scene.render.fps = FPS
    src, acts = import_swat(soldier.SWAT)
    rt = Retarget(src, arm)
    frames = {}
    for s, name in RETARGET.items():
        frames[name] = retarget_clip(rt, acts[s], name)
    frames['death'] = recentre_death(frames['death'])
    frames['crouch_idle'] = crouch(rt, frames['idle'], 'crouch_idle')
    frames['crouch_walk'] = crouch(rt, frames['walk'], 'crouch_walk')
    bpy.data.objects.remove(src)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    wc, sockets = weapon_clips(arm, frames['idle'][0][1])
    frames.update(wc)
    for name, fr in frames.items():
        act = rk.write_action(arm, name, fr, moving={'Root', 'Hips'})
        prune(act)
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    for name, m in sockets.items():
        e = bpy.data.objects.new(name, None)
        bpy.context.scene.collection.objects.link(e)
        e.parent = arm
        e.parent_type = 'BONE'
        e.parent_bone = 'Wrist.R'
        bpy.context.view_layer.update()
        loc, q, _ = m.decompose()
        e.matrix_world = Matrix.LocRotScale(loc, q, Vector((1, 1, 1)))
    arm.data.pose_position = 'POSE'


def measure(arm, looks):
    """Height of the standing idle (for the scale) and the ground speed of the locomotion clips (logged)."""
    acts = {a.name: a for a in bpy.data.actions}
    body = looks[0]
    rk.set_action(arm, acts.get('idle'))
    bpy.context.scene.frame_set(0)
    dg = bpy.context.evaluated_depsgraph_get()
    ev = body.evaluated_get(dg)
    m = ev.to_mesh()
    zs = [(body.matrix_world @ v.co).z for v in m.vertices]
    ev.to_mesh_clear()
    return max(zs) - min(zs), min(zs)


def ground_speed(arm, action):
    rk.set_action(arm, action)
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


def export(arm, looks, out):
    bpy.context.scene.render.fps = FPS
    h, zmin = measure(arm, looks)
    import soldier
    s = soldier.TARGET_HEIGHT / h
    arm.matrix_world = Matrix.Scale(s, 4) @ Matrix.Rotation(math.pi, 4, 'Z')
    arm.location.z -= zmin * s
    bpy.context.view_layer.update()
    log('standing height', round(h, 3), 'scaled by', round(s, 4))
    acts = {a.name: a for a in bpy.data.actions}
    for name in ('walk', 'run', 'crouch_walk'):
        if name in acts:
            log(f'ground speed {name}', round(ground_speed(arm, acts[name]), 3), 'm/s')
    for name in ('crouch_idle',):
        if name in acts:
            rk.set_action(arm, acts[name])
            bpy.context.scene.frame_set(0)
            hz = max((arm.matrix_world @ arm.pose.bones['Head'].head).z, 0)
            log('crouch head joint height', round(hz, 3))
    for a in acts.values():
        a.use_fake_user = True
        log('clip', a.name, 'seconds', round((a.frame_range[1] - a.frame_range[0]) / FPS, 3))
    rk.set_action(arm, acts.get('idle'))
    bpy.context.scene.frame_set(0)
    for o in bpy.data.objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_tangents=False, export_vertex_color='ACTIVE', export_all_vertex_colors=False,
        export_materials='EXPORT', export_image_format='NONE', export_skins=True, export_all_influences=False,
        export_def_bones=False, export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=False,
        export_optimize_animation_size=True, export_anim_slide_to_zero=True, export_morph=False, export_extras=False,
        export_cameras=False, export_lights=False)
    log('wrote', out, os.path.getsize(out), 'bytes')
    rl.quantize(out)
    log('quantized', out, os.path.getsize(out), 'bytes')
