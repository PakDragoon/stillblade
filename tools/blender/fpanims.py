"""
The downloaded first-person animation pack (package R): "M4 - FPS Weapon Animations Pack FREE (v.1)" (Fab Standard
License; tools/blender/source-art/realistic/fp-anims/m4_animations_gltf.zip, git-ignored). Read as data only: the zip is
extracted by realistic.unzip into build/unzipped/fp-anims/ and its scene.gltf / scene.bin are parsed here with the
standard library and mathutils (nothing from the download is run or imported by Blender's importer).

The pack is ONE glTF timeline with five consecutive clips (checked: each animation's keys lie in its own range):
    Reload        0.033 - 3.667 s   (tactical: the M4's magazine dropped and replaced)
    Reload_Empty  3.700 - 7.500 s   (empty: the same plus the bolt released)
    Fire          7.533 - 8.333 s
    Holster       8.367 - 8.933 s
    Draw          8.967 - 10.000 s
Nodes (centimetres, an FBX Z-up scene under a Y-up conversion): FPS_Camera_j_01 (the eye, animated), Main_j_049 (the
rifle, animated), Mag1_j_050 / Mag2_j_051 (the old and the new magazine), Bolt_j_052, BoltCatch_j_053, and two arm
chains RightArm_03 / LeftArm_026 > ForeArm > Hand > Thumb1-4, Index1-4, Middle1-4, Ring1-4, Pinky1-4.

`Pack.world(name, clip, t)` gives a node's world matrix (metres, Blender axes: X right, Y forward, Z up after
`TO_BLENDER`) at time t seconds into a clip; `Pack.in_camera(name, clip, t)` the same in the pack's camera frame,
expressed like viewmodel.py's camera space (X right, Y forward, Z up).
"""
import json
import math
import os
import struct

from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'source-art', 'realistic', 'fp-anims')
ZIP = os.path.join(SRC, 'm4_animations_gltf.zip')

CLIPS = ('Reload', 'Reload_Empty', 'Fire', 'Holster', 'Draw')
CAMERA = 'FPS_Camera_j_01'
GUN = 'Main_j_049'
MAG_OLD = 'Mag1_j_050'
MAG_NEW = 'Mag2_j_051'
BOLT = 'Bolt_j_052'
BOLT_CATCH = 'BoltCatch_j_053'
SIDES = {'R': 'Right', 'L': 'Left'}
FINGERS = ('Index', 'Middle', 'Ring', 'Pinky')

# glTF (Y up, -Z forward) to Blender (Z up, Y forward).
TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))

_COMP = {5126: ('f', 4), 5123: ('H', 2), 5125: ('I', 4), 5121: ('B', 1)}
_NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def _extract():
    import realistic as rl
    return rl.unzip(ZIP)


class Pack:
    def __init__(self, folder=None):
        folder = folder or _extract()
        path = None
        for dirpath, _, files in os.walk(folder):
            if 'scene.gltf' in files:
                path = os.path.join(dirpath, 'scene.gltf')
                break
        if path is None:
            raise FileNotFoundError(f'scene.gltf not found in {folder}')
        with open(path, encoding='utf8') as f:
            self.g = json.load(f)
        with open(os.path.join(os.path.dirname(path), self.g['buffers'][0]['uri']), 'rb') as f:
            self.bin = f.read()
        self.nodes = self.g['nodes']
        self.index = {}
        for i, n in enumerate(self.nodes):
            self.index.setdefault(n.get('name', f'#{i}'), i)
        self.parent = {}
        for i, n in enumerate(self.nodes):
            for c in n.get('children', []):
                self.parent[c] = i
        # Per clip: start time and, per node, its channels {path: (times, values, interpolation)}.
        self.clips = {}
        for a in self.g['animations']:
            chans = {}
            t0, t1 = 1e9, -1e9
            for c in a['channels']:
                s = a['samplers'][c['sampler']]
                times = self._read(s['input'])
                vals = self._read(s['output'])
                t0, t1 = min(t0, times[0]), max(t1, times[-1])
                chans.setdefault(c['target']['node'], {})[c['target']['path']] = (times, vals, s.get('interpolation', 'LINEAR'))
            self.clips[a['name']] = {'start': t0, 'end': t1, 'channels': chans}
        self._cache = {}

    def _read(self, ai):
        acc = self.g['accessors'][ai]
        view = self.g['bufferViews'][acc['bufferView']]
        fmt, size = _COMP[acc['componentType']]
        n = _NCOMP[acc['type']]
        off = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
        stride = view.get('byteStride', size * n)
        out = []
        for i in range(acc['count']):
            vals = struct.unpack_from('<' + fmt * n, self.bin, off + i * stride)
            out.append(vals if n > 1 else vals[0])
        return out

    def duration(self, clip):
        c = self.clips[clip]
        return c['end'] - c['start']

    def _sample(self, ch, T):
        times, vals, interp = ch
        if T <= times[0]:
            return vals[0], vals[0], 0.0
        if T >= times[-1]:
            return vals[-1], vals[-1], 0.0
        lo, hi = 0, len(times) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if times[mid] <= T:
                lo = mid
            else:
                hi = mid
        w = (T - times[lo]) / (times[hi] - times[lo]) if times[hi] > times[lo] else 0.0
        if interp == 'STEP':
            w = 0.0
        return vals[lo], vals[hi], w

    def local(self, i, clip, t):
        n = self.nodes[i]
        if 'matrix' in n:
            m = n['matrix']
            return Matrix([[m[c * 4 + r] for c in range(4)] for r in range(4)])
        chans = self.clips[clip]['channels'].get(i, {}) if clip else {}
        T = self.clips[clip]['start'] + t if clip else 0.0
        tr = Vector(n.get('translation', (0, 0, 0)))
        q = n.get('rotation', (0, 0, 0, 1))
        rot = Quaternion((q[3], q[0], q[1], q[2]))
        sc = Vector(n.get('scale', (1, 1, 1)))
        if 'translation' in chans:
            a, b, w = self._sample(chans['translation'], T)
            tr = Vector(a).lerp(Vector(b), w)
        if 'rotation' in chans:
            a, b, w = self._sample(chans['rotation'], T)
            qa = Quaternion((a[3], a[0], a[1], a[2]))
            qb = Quaternion((b[3], b[0], b[1], b[2]))
            rot = qa.slerp(qb, w)
        if 'scale' in chans:
            a, b, w = self._sample(chans['scale'], T)
            sc = Vector(a).lerp(Vector(b), w)
        return Matrix.LocRotScale(tr, rot, sc)

    def world(self, name, clip, t):
        """World matrix (Blender axes, metres) of node `name` at `t` s into `clip` (None: the rest pose)."""
        key = (name, clip, round(t, 5))
        if key in self._cache:
            return self._cache[key]
        i = self.index[name]
        m = Matrix()
        chain = []
        while i is not None:
            chain.append(i)
            i = self.parent.get(i)
        for j in reversed(chain):
            m = m @ self.local(j, clip, t)
        out = TO_BLENDER @ m
        self._cache[key] = out
        return out

    def camera(self, clip, t):
        """The eye's frame (Blender axes): X right, Y forward (view direction), Z up, unit scale, metres."""
        m = self.world(CAMERA, clip, t)
        loc = m.translation
        r = m.to_3x3()
        cols = [r.col[k].normalized() for k in range(3)]
        return loc, cols

    def in_camera(self, name, clip, t):
        """Node `name` relative to the eye, in viewmodel.py camera space (X right, Y forward, Z up), metres,
        with its scale removed."""
        cam = self.cam_matrix(clip, t)
        m = cam.inverted() @ self.world(name, clip, t)
        loc, rot, _ = m.decompose()
        return Matrix.LocRotScale(loc, rot, None)

    def gun(self, clip, t):
        """The rifle's frame in camera space, with viewmodel.py's gun axes (X right, Y muzzle, Z up), origin at the
        pack's rifle joint."""
        return self.in_camera(GUN, clip, t) @ GUN_AXES

    def in_gun(self, name, clip, t):
        """Node `name` in the rifle's frame (gun axes), scale removed."""
        return self.gun(clip, t).inverted() @ self.in_camera(name, clip, t)

    def node(self, side, part):
        """The full node name of e.g. ('L', 'HandIndex1') -> 'LeftHandIndex1_033'."""
        base = SIDES[side] + part
        for n in self.index:
            if n.rsplit('_', 1)[0] == base:
                return n
        raise KeyError(base)

    def mesh_points(self, node_name, clip=None, t=0.0):
        """World positions (Blender axes, metres) of the vertices of the mesh on node `node_name`."""
        i = self.index[node_name]
        mesh = self.g['meshes'][self.nodes[i]['mesh']]
        w = self.world(node_name, clip, t)
        pts = []
        for prim in mesh['primitives']:
            for v in self._read(prim['attributes']['POSITION']):
                pts.append(w @ Vector(v))
        return pts

    def cam_matrix(self, clip, t):
        m = self.world(CAMERA, clip, t)
        loc, rot, _ = m.decompose()
        # The camera joint's axes are mapped onto (right, forward, up) by CAM_AXES (found from the rest pose: the
        # rifle in front of and below the eye, to the right).
        return Matrix.LocRotScale(loc, rot, None) @ CAM_AXES


# The eye joint's own axes are X right, Y up, Z back (checked on the rest pose: the rifle is in front of the eye,
# below it and to the right). These columns turn viewmodel.py's camera space (X right, Y forward, Z up) into them.
CAM_AXES = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
# The rifle joint's axes are X left, Y up, Z toward the muzzle; these columns turn viewmodel.py's gun frame (X right,
# Y muzzle, Z up) into them.
GUN_AXES = Matrix(((-1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def degrees(q):
    return tuple(round(math.degrees(a), 1) for a in q.to_euler())
