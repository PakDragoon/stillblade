"""
Package T: the M4 from the owner's "M4 - FPS Weapon Animations Pack FREE (v.1)" (Fab Standard License;
tools/blender/source-art/realistic/fp-anims/m4_animations_gltf.zip, git-ignored), shared by weapons.py (the third-person
M4, its landmarks, the rifle atlas) and fpm4.py (the first-person rig: the pack's arms, M4 and clips as authored).

The pack is read as data (fpanims.Pack: the standard library and mathutils; nothing from the download is run).

Frames (Blender axes, metres):
  - the pack's world: fpanims.Pack.world (its scene scaled by 0.01: every joint's world matrix has scale 0.01);
  - the shipped gun frame (weapons.py's convention for every gun): X right, Y toward the muzzle, Z up, origin at the
    grip (on the pistol grip's axis, GRIP_DOWN of the way down from its top, centred across it). `M4.frame(clip, t)`
    is that frame in the pack's world; at the idle pose (IDLE) it is `M4.F0`, and "rig space" (fpm4.py) is the pack's
    world seen from F0, so the rig's origin is the gun's grip at the idle hold, as presenter.ts expects.

Pack nodes used: the gun joint Main_j_049 (meshes Main and Safety), the magazine Mag1_j_050 (the tactical and the
empty reload both drop this magazine and seat it again; Mag2 never moves and is not used), its top round
"Bullet5_56x45mm" (lowered and shrunk while the magazine is empty: Reload_Empty's first second), Bolt_j_052 (locked back
6.2 cm while empty), BoltCatch_j_053 (turned 7.2 degrees while it holds the bolt), Trigger_j_054 (pulled about 20 degrees
in Fire).
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

import fpanims
import realistic as rl

IDLE = ('Reload', 0.0)
# Where the fist closes on the pistol grip: this far down from its top (as weapons.GRIP_DOWN).
GRIP_DOWN = 0.35
GUN = fpanims.GUN
MAG = 'Mag1_j_050'
ROUND = 'Bullet5_56x45mm'            # the first node of that name: the round on top of Mag1
BOLT = 'Bolt_j_052'
CATCH = 'BoltCatch_j_053'
TRIGGER = 'Trigger_j_054'
# Our part name: (pack mesh nodes, pack joint whose motion it follows).
PARTS = {
    'body': (('Main_M4_D_0', 'Safety_M4_D_0'), GUN),
    'mag': (('Mag1_M4_D_0',), MAG),
    'round': (('Bullet5_56x45mm_Bullet5_56x45mm_D_0',), ROUND),
    'bolt': (('Bolt_M4_D_0',), BOLT),
    'catch': (('BoltCatch_M4_D_0',), CATCH),
    'trigger': (('Trigger_M4_D_0',), TRIGGER),
}
# The folding rear sight on the receiver's rail (cut out of Main into its own part so the rig can fold it away when an
# optic is mounted, as a real M4's flip-up sight is). In the gun joint's frame (metres): y range, above this height.
REAR_SIGHT_Y = (-0.086, -0.026)
REAR_SIGHT_Z = 0.0515


def log(*a):
    print('[m4]', *a, flush=True)


def unit(m):
    """The rigid part of a matrix (scale removed)."""
    loc, rot, _ = m.decompose()
    return Matrix.LocRotScale(loc, rot, None)


class M4:
    def __init__(self, pack=None):
        self.p = pack or fpanims.Pack()
        # The gun joint's frame at idle, with weapons.py's axes (X right, Y muzzle, Z up), origin at the joint.
        j0 = unit(self.p.world(GUN, *IDLE)) @ fpanims.GUN_AXES
        pts = [j0.inverted() @ v for v in self.p.mesh_points('Main_M4_D_0', *IDLE)]
        # Pistol grip: below the receiver (z < -7.5 cm) between the stock's front and the trigger guard.
        grip = [v for v in pts if v.z < -0.075 and -0.16 < v.y < -0.035]
        ax, lo, hi = rl.axis_of(grip)
        origin = hi + (lo - hi) * GRIP_DOWN
        xs = [v.x for v in grip]
        origin.x = (min(xs) + max(xs)) / 2
        self.grip_axis = ax
        self.grip = origin.copy()           # in the gun joint's frame
        self.to_grip = Matrix.Translation(origin)
        self.F0 = j0 @ self.to_grip
        self.F0i = self.F0.inverted()
        log('grip in the gun joint frame (cm)', tuple(round(c * 100, 2) for c in origin), 'axis',
            tuple(round(c, 3) for c in ax))

    # --- frames -------------------------------------------------------------------------------------------

    def frame(self, clip, t):
        """The shipped gun frame (grip origin) in the pack's world at `t` s into `clip`."""
        return unit(self.p.world(GUN, clip, t)) @ fpanims.GUN_AXES @ self.to_grip

    def joint(self, name, clip, t):
        """A joint's rigid world frame."""
        return unit(self.p.world(name, clip, t))

    def scale(self, name, clip, t):
        """A joint's world scale relative to the pack's 0.01 (mean of its axes)."""
        s = self.p.world(name, clip, t).to_scale()
        return (s.x + s.y + s.z) / 3 / 0.01

    def camera(self):
        """The pack's eye (Blender camera axes: X right, Y forward, Z up) in its world; it never moves."""
        return self.p.cam_matrix(*IDLE)

    # --- meshes -------------------------------------------------------------------------------------------

    def mesh(self, node, frame=None):
        """A rigid pack mesh at the idle pose in the shipped gun frame (or `frame`): positions, normals, UVs (v up),
        triangles, material name."""
        p = self.p
        i = p.index[node]
        mesh = p.g['meshes'][p.nodes[i]['mesh']]
        prim = mesh['primitives'][0]
        w = (frame or self.F0i) @ p.world(node, *IDLE)
        nm = w.to_3x3().inverted().transposed()
        pos = [w @ Vector(v) for v in p._read(prim['attributes']['POSITION'])]
        nrm = [(nm @ Vector(v)).normalized() for v in p._read(prim['attributes']['NORMAL'])]
        uv = [(u, 1.0 - v) for u, v in p._read(prim['attributes']['TEXCOORD_0'])]
        tris = p._read(prim['indices'])
        mat = p.g['materials'][prim['material']]['name']
        return pos, nrm, uv, [tuple(tris[k:k + 3]) for k in range(0, len(tris), 3)], mat

    def part_points(self, part):
        pts = []
        for node in PARTS[part][0]:
            pts += self.mesh(node)[0]
        return pts

    def maps(self, stem):
        """{'base', 'normal'} images of a pack material (its M4 and round have no roughness or metal maps)."""
        folder = None
        for d, _, files in os.walk(fpanims._extract()):
            if 'textures' in d.replace('\\', '/').split('/')[-1:] or any(f.startswith(stem) for f in files):
                folder = d
                if any(f.startswith(stem) for f in files):
                    break
        out = {}
        for f in sorted(os.listdir(folder)):
            if f.startswith(stem + '_BaseColor'):
                out['base'] = (rl.load_image(os.path.join(folder, f)), None)
            elif f.startswith(stem + '_Normal'):
                out['normal'] = (rl.load_image(os.path.join(folder, f)), None)
        return out

    # --- landmarks (shipped gun frame) ---------------------------------------------------------------------

    def landmarks(self):
        """Measured points of the M4 in the shipped frame (metres): bore (x, z), muzzle front y, front sight post
        top z, the top rail's height and free length, the magazine's axis, the handguard box, the charging handle."""
        body = self.part_points('body')
        ymax = max(v.y for v in body)
        front = [v for v in body if v.y > ymax - 0.05]
        bx = (min(v.x for v in front) + max(v.x for v in front)) / 2
        bz = (min(v.z for v in front) + max(v.z for v in front)) / 2
        # Front sight post: the highest point well forward of the receiver (joint frame y 0.30-0.37).
        post = [v for v in body if 0.30 < (v.y + self.grip.y) < 0.37]
        iron_z = max(v.z for v in post)
        # The rail's top: the highest point along the handguard (joint frame y 0.10-0.28; nothing stands on it there).
        rail_z = max(v.z for v in body if 0.10 < (v.y + self.grip.y) < 0.28)
        # The rail is free (for an optic) from the receiver's rear to the end of the handguard, apart from the rear
        # sight, which folds away whenever an optic is mounted.
        top = [v for v in body if abs(v.z - rail_z) < 0.002]
        rail_y = (min(v.y for v in top), max(v.y for v in top))
        mag_ax, mag_lo, mag_hi = rl.axis_of(self.part_points('mag'))
        hg = [v for v in body if 0.11 < (v.y + self.grip.y) < 0.29]
        hlo = Vector([min(v[k] for v in hg) for k in range(3)])
        hhi = Vector([max(v[k] for v in hg) for k in range(3)])
        bolt = self.part_points('bolt')
        handle = Vector((bx, min(v.y for v in bolt), max(v.z for v in bolt)))
        out = {'bore': (bx, bz), 'muzzle_y': ymax, 'iron_z': iron_z, 'rail_z': rail_z, 'rail_y': rail_y,
               'mag': (mag_ax, mag_lo, mag_hi), 'handguard': (hlo, hhi), 'handle': handle}
        log('landmarks (cm):', 'bore', tuple(round(c * 100, 2) for c in out['bore']), 'muzzle', round(ymax * 100, 2),
            'front post top', round(iron_z * 100, 2), 'rail z', round(rail_z * 100, 2), 'rail y',
            tuple(round(c * 100, 1) for c in rail_y), 'handguard', tuple(round(c * 100, 1) for c in hlo),
            tuple(round(c * 100, 1) for c in hhi), 'mag axis', tuple(round(c, 3) for c in mag_ax))
        return out

    # --- Blender objects ----------------------------------------------------------------------------------

    def part_object(self, part, name):
        """A Blender mesh of one part (materials named after the pack's, for the atlas) in the shipped frame. The
        body's folding rear sight comes back as a second object (name + '_rearsight')."""
        bm = bmesh.new()
        uvl = bm.loops.layers.uv.new('UVMap')
        mats = []
        normals = []
        rear = bmesh.new() if part == 'body' else None
        ruvl = rear.loops.layers.uv.new('UVMap') if rear else None
        rnormals = []
        g = self.grip
        for node in PARTS[part][0]:
            pos, nrm, uv, tris, mat = self.mesh(node)
            if mat not in mats:
                mats.append(mat)
            mi = mats.index(mat)
            vs = {}
            rvs = {}
            for a, b, c in tris:
                if len({a, b, c}) < 3:
                    continue
                in_rear = rear is not None and all(
                    REAR_SIGHT_Y[0] < pos[k].y + g.y < REAR_SIGHT_Y[1] and pos[k].z + g.z > REAR_SIGHT_Z
                    for k in (a, b, c))
                if in_rear:
                    for k in (a, b, c):
                        if k not in rvs:
                            rvs[k] = rear.verts.new(pos[k])
                    try:
                        f = rear.faces.new((rvs[a], rvs[b], rvs[c]))
                    except ValueError:
                        continue
                    f.material_index = 0
                    for lp, k in zip(f.loops, (a, b, c)):
                        lp[ruvl].uv = uv[k]
                        rnormals.append(nrm[k])
                    continue
                for k in (a, b, c):
                    if k not in vs:
                        vs[k] = bm.verts.new(pos[k])
                try:
                    f = bm.faces.new((vs[a], vs[b], vs[c]))
                except ValueError:
                    continue
                f.material_index = mi
                for lp, k in zip(f.loops, (a, b, c)):
                    lp[uvl].uv = uv[k]
                    normals.append(nrm[k])
        out = [self._object(bm, name, mats, normals)]
        if rear is not None:
            out.append(self._object(rear, name + '_rearsight', ['M4_D'], rnormals))
        return out

    @staticmethod
    def _object(bm, name, mats, normals):
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in mats:
            me.materials.append(bpy.data.materials.get(m) or bpy.data.materials.new(m))
        me.normals_split_custom_set(normals)
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def skin_crop():
    """The part of the pack's skin map (Hand_D) its arms use (u0, v0, u1, v1; v up): forearms and fingertips."""
    import packhands
    prim = packhands.source().prims[0]
    us = [uv[0] for uv in prim['uv']]
    vs = [uv[1] for uv in prim['uv']]
    return (max(0.0, min(us) - 0.01), max(0.0, min(vs) - 0.01), min(1.0, max(us) + 0.01), min(1.0, max(vs) + 0.01))


def pc_from_blender(k):
    """Inverse of rigkit.pc_pose: a camera-space frame (Blender axes) as a PlayCanvas (position, euler degrees)."""
    import rigkit as rk
    m = rk.PC_TO_BL.inverted() @ k @ rk.PC_TO_BL
    e = m.to_euler('XYZ')
    return tuple(m.translation), tuple(math.degrees(a) for a in e)
