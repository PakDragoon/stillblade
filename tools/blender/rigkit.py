"""
Helpers shared by the Blender scripts that pose arms and write clips (viewmodel.py, clips.py, review.py).

Plain functions on armature-space pose matrices: a pose is a dict {bone name: 4x4 Matrix in armature space}, the
same thing Blender's PoseBone.matrix holds. `write_action` turns a list of such poses into a keyed action.
"""
import math

import bpy
from mathutils import Matrix, Quaternion, Vector


def log(tag, *a):
    print(f'[{tag}]', *a, flush=True)


# ---------------------------------------------------------------------------------------------
# Actions (Blender 4.4+ slotted actions; legacy fallback)

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


def set_action(obj, action):
    ad = obj.animation_data or obj.animation_data_create()
    ad.action = action
    if hasattr(ad, 'action_slot') and action is not None and len(getattr(action, 'slots', [])) > 0:
        ad.action_slot = action.slots[0]


def write_action(arm, name, frames, bones=None, moving=None):
    """
    New action from per-frame armature-space pose matrices: frames = [(frame, {bone: Matrix}), ...]. Every bone in
    `bones` (default: all) is keyed on every frame (location, quaternion, scale), parents before children. With
    `moving` (a set of bone names), only those bones get location keys and no bone gets scale keys (the others keep
    their rest offsets: rigid chains), which makes the exported clip much smaller.
    """
    pose, data = arm.pose, arm.data
    order = [bn.name for bn in data.bones if bones is None or bn.name in bones]
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
            if moving is None or n in moving:
                pb.keyframe_insert('location', frame=f, group=n)
            pb.keyframe_insert('rotation_quaternion', frame=f, group=n)
            if moving is None:
                pb.keyframe_insert('scale', frame=f, group=n)
    new.use_fake_user = True
    return new


def descendants(bone):
    out = []
    stack = list(bone.children)
    while stack:
        b = stack.pop()
        out.append(b.name)
        stack.extend(b.children)
    return out


# ---------------------------------------------------------------------------------------------
# Frames and easing

def frame_from(right, fwd, up, origin):
    m = Matrix((right, fwd, up)).transposed().to_4x4()
    m.translation = origin
    return m


def smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def lerp_frame(a, b, w):
    """Blend of two rigid frames: positions lerped, rotations slerped."""
    if w <= 0:
        return a.copy()
    if w >= 1:
        return b.copy()
    la, ra, _ = a.decompose()
    lb, rb, _ = b.decompose()
    return Matrix.LocRotScale(la.lerp(lb, w), ra.slerp(rb, w), None)


def keyed(keys, t, ease=smooth):
    """
    Piecewise value from keys [(time, value), ...] sorted by time; values are tuples (blended per element) or
    callables of t returning a frame Matrix (blended as frames). Eased between keys.
    """
    if t <= keys[0][0]:
        return resolve(keys[0][1], t)
    for i in range(len(keys) - 1):
        t0, v0 = keys[i]
        t1, v1 = keys[i + 1]
        if t <= t1:
            w = ease((t - t0) / (t1 - t0)) if t1 > t0 else 1.0
            a, b = resolve(v0, t), resolve(v1, t)
            if isinstance(a, Matrix):
                return lerp_frame(a, b, w)
            return tuple(x + (y - x) * w for x, y in zip(a, b))
    return resolve(keys[-1][1], t)


def resolve(v, t):
    return v(t) if callable(v) else v


def offset_frame(dx=0.0, dy=0.0, dz=0.0, pitch=0.0, yaw=0.0, roll=0.0):
    """Rigid offset: translation (Blender X right, Y forward, Z up) after rotation (degrees: pitch about X, muzzle up;
    yaw about Z, muzzle left; roll about Y, top to the right), applied about the frame's own origin."""
    r = (Matrix.Rotation(math.radians(yaw), 4, 'Z') @ Matrix.Rotation(math.radians(pitch), 4, 'X')
         @ Matrix.Rotation(math.radians(roll), 4, 'Y'))
    return Matrix.Translation(Vector((dx, dy, dz))) @ r


# PlayCanvas camera space (x right, y up, z back) <-> Blender rig space (X right, Y forward, Z up).
PC_TO_BL = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def pc_pose(pos, euler):
    """A PlayCanvas entity pose (local position, setLocalEulerAngles degrees) as a Blender rig-space matrix."""
    ex, ey, ez = (math.radians(a) for a in euler)
    # pc.Quat.setFromEulerAngles: R = Rz * Ry * Rx.
    r = Matrix.Rotation(ez, 4, 'Z') @ Matrix.Rotation(ey, 4, 'Y') @ Matrix.Rotation(ex, 4, 'X')
    m = Matrix.Translation(Vector(pos)) @ r
    return PC_TO_BL @ m @ PC_TO_BL.inverted()


# ---------------------------------------------------------------------------------------------
# Arms

def hand_grip_frame(data, side, palm_offset, along, am=1.0):
    """
    Rest-pose grip frame of one hand (armature space): origin in the palm where a handle would sit, axes (right,
    forward, up) of a pistol grip held in it: 'up' runs from the pinky side to the index side, 'forward' follows the
    metacarpals (wrist to knuckles), 'right' completes the frame. Returns (frame, palm normal).
    """
    w = data.bones[f'Wrist.{side}'].head_local
    knuckles = sum((data.bones[f'{f}2.{side}'].head_local for f in ('Index', 'Middle', 'Ring', 'Pinky')), Vector()) / 4
    fingers = (knuckles - w).normalized()
    across = data.bones[f'Index2.{side}'].head_local - data.bones[f'Pinky2.{side}'].head_local
    up = (across - fingers * across.dot(fingers)).normalized()
    right = fingers.cross(up)
    palm = -right if side == 'R' else right
    origin = w + (knuckles - w) * along + palm * (palm_offset * am)
    return frame_from(right, fingers, up, origin), palm


def rotate_about(mats, names, pivot, axis, angle):
    r = Matrix.Translation(pivot) @ Matrix.Rotation(angle, 4, axis) @ Matrix.Translation(-pivot)
    for n in names:
        mats[n] = r @ mats[n]


def solve_arm(data, mats, side, target, pole):
    """Two-bone IK (UpperArm, LowerArm) putting the wrist joint at `target`; the elbow bends toward `pole`.
    Returns the reach as a fraction of the arm's length (>= 1: out of reach, the arm is straight)."""
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


def twist_forearm(data, mats, side, rest_palm, share):
    """
    Turns the forearm about its own axis toward the hand's roll (share 0..1), so the wrist does not twist like a
    candy wrapper. `rest_palm` is the palm normal in the rest pose (armature space). Elbow and wrist stay put.
    """
    lo, wr = f'LowerArm.{side}', f'Wrist.{side}'
    lb, wb = data.bones[lo], data.bones[wr]
    K = mats[lo].to_translation()
    T = mats[lo] @ (lb.matrix_local.inverted() @ wb.head_local)
    axis = (T - K).normalized()
    fa = (mats[lo].to_3x3() @ lb.matrix_local.to_3x3().inverted()) @ rest_palm
    ha = (mats[wr].to_3x3() @ wb.matrix_local.to_3x3().inverted()) @ rest_palm
    fa = (fa - axis * fa.dot(axis))
    ha = (ha - axis * ha.dot(axis))
    if fa.length < 1e-6 or ha.length < 1e-6:
        return
    fa.normalize()
    ha.normalize()
    ang = math.atan2(fa.cross(ha).dot(axis), fa.dot(ha))
    r = Matrix.Translation(K) @ Matrix.Rotation(ang * share, 4, axis) @ Matrix.Translation(-K)
    mats[lo] = r @ mats[lo]
