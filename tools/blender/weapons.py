"""
Stillblade weapon pipeline (package M part 2: realistic models): downloaded CC-BY models -> client/public/models/
weapons.glb (third person), the weapon textures, and the full-detail parts the first-person rigs are built from.

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup \
        --python tools/blender/weapons.py

Sources: tools/blender/source-art/realistic/ (git-ignored; see realistic.py and client/public/models/CREDITS.md):
the AK-105 (rifle), the Makarov PM (pistol), the tactical knife, the red dot sight, and the 2x scope if the owner has
downloaded it (otherwise a 2x combat scope is generated here). Run viewmodel.py after this one.

Writes:
  client/public/models/weapons.glb                 third person: reduced meshes, the node layout below
  client/public/models/textures/<gun>_{albedo,normal}_{2048,1024}.webp   one atlas per gun (realistic.py)
  tools/blender/source-art/realistic/build/weapons_fp.glb   full-detail parts, landmarks and aim points for
                                                   viewmodel.py (git-ignored, rebuilt from the sources)

Node layout of weapons.glb (unchanged names, so the client and soldier.py keep working):
  gun (mesh) with children gun_suppressor, gun_sight_reddot, gun_sight_scope2x (meshes in gun's own frame), the
      empties gun_muzzle (suppressor front), gun_muzzle_bare (muzzle brake front) and gun_aim_<sight> (where the eye
      sits when aiming with that sight: on its optical axis, at its eye relief; presenter.ts aims the gun by them);
  pistol (mesh) with pistol_suppressor, pistol_muzzle, pistol_muzzle_bare, pistol_aim_iron;
  knife (mesh).
Each mesh has positions, normals (the sources' own, carried through every reduction), UVs into its gun's atlas, and a
vertex colour (RGB tints the atlas, A = emission: only the red dot's reticle). One material per gun: rifle, pistol,
knife.

Axis convention (glTF / engine space), origin = centre of the hand's grip (a third of the way down the pistol grip
for the guns, the middle of the handle for the knife):
  -Z forward (gun: muzzle; knife: blade tip), +Y up (gun: sights; knife: spine), +X right.
The character (soldier.py, clips.py) holds the rifle in "socket_gun", the pistol in "socket_pistol" and the knife in "socket_knife".

Suppressors (room option): a realistic can generated here (the AK's slips over its muzzle brake; the pistol's screws
on its muzzle), its own node, merged into the gun's one mesh by the client when the room has suppressors.
Sights (package M): the AK-105 has a Picatinny rail on its dust cover; the red dot and the 2x scope stand on it (the
iron sights are the gun's own). Like the suppressor, each is merged into the one gun mesh in third person and is a bone
scaled away in the first-person rig.
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import realistic as rl  # noqa: E402
import soldier  # noqa: E402

ROOT = rl.ROOT
OUT = os.path.join(ROOT, 'client', 'public', 'models', 'weapons.glb')

# Real sizes (metres): AK-105 with the stock unfolded and its muzzle brake 0.824; the PM is modelled in metres;
# the knife 0.30 (as before); the red dot's housing 0.056 wide; the generated 2x scope 0.145 long.
RIFLE_LENGTH = 0.824
KNIFE_LENGTH = 0.30
REDDOT_WIDTH = 0.056
SCOPE_LENGTH = 0.145
# Where the fist closes on a pistol grip: this far down from the top of the grip (fraction of its length).
GRIP_DOWN = 0.35

# Triangle budgets. First person: per source part (the rest kept as modelled); third person: per node.
FP_RIFLE = {'BARREL': 1900, 'FOLDING_STOCK_CHICK_REST': 900, 'MUZZLE_BRAKE': 700, 'IRON_SIGHT': 850,
            'FOLDING_STOCK': 750, 'HAND_GUARD': 1500, 'RECEIVER': 2300}
FP_REDDOT = {'main_shape': 1300, 'main_bat_1': 220, 'main_buttons_1': 90, 'main_buttons_2': 90, 'main_a': 220}
FP_KNIFE = 1300                     # per source mesh (two)
TP_PISTOL_SCALE = 1.0               # real size (package O: the new hands hold it; M part 2 drew it 1.35x)
TP = {'gun': 3200, 'pistol': 1700, 'knife': 800, 'reddot': 380, 'scope_dl': 380}
FP_SCOPE_DL = 3000                  # a downloaded scope, first person
# The downloaded 2x sight (AR Scope by Scape): its axes in the model's own frame, scale to metres, the lens material.
SCOPE_DL = {'forward': (0, 1, 0), 'up': (0, 0, 1), 'scale': 1.0, 'lens': ('scope_Material.003',)}
# Its four remaining materials, each in its own rectangle of the rifle atlas (inside the 'scope' region).
SCOPE_DL_REGIONS = {'scope_Material.001': (0.75, 0.375, 1.0, 0.5), 'scope_Material': (0.75, 0.25, 0.875, 0.375),
                    'scope_Material.002': (0.875, 0.3125, 1.0, 0.375), 'scope_Material.004': (0.875, 0.25, 1.0, 0.3125)}

# Eye positions when aimed (the shipped frame, metres): iron sights put the eye this far behind the grip (over the
# end of the stock, so the receiver and rear sight lead the eye to the front post); the red dot this far behind its
# glass; the 2x scope this far behind its eyepiece, so the eyepiece fills the view like a real combat scope.
EYE_BEHIND_GRIP = {'rifle': 0.44, 'pistol': 0.30}
REDDOT_EYE_RELIEF = 0.26
SCOPE_EYE_RELIEF = 0.045

# Atlas layouts: realistic.LAYOUTS (shared with viewmodel.py, whose arms use the swatches).
RIFLE_LAYOUT, RIFLE_SWATCHES = rl.LAYOUTS['rifle']
PISTOL_LAYOUT, SIDE_SWATCHES = rl.LAYOUTS['pistol']
KNIFE_LAYOUT, _ = rl.LAYOUTS['knife']

# Generated parts: vertex colours (linear RGB; A = emission) on the 'metal' or 'polymer' swatch.
SUPPRESSOR_RGBA = (0.11, 0.11, 0.115, 0.0)
SCOPE_RGBA = (0.085, 0.085, 0.09, 0.0)
FIBRE_RGBA = (0.9, 0.45, 0.08, 0.0)
RETICLE_RGBA = (1.0, 0.08, 0.05, 1.0)
RETICLE_RADIUS = 0.0011


def log(*a):
    print('[weapons]', *a, flush=True)


def by_name(objs):
    return {o.name.split('.')[0]: o for o in objs}


def grip_origin(pts):
    """A third of the way down a pistol grip: on its axis (top centroid to bottom centroid), centred across it."""
    ax, lo, hi = rl.axis_of(pts)
    return hi + (lo - hi) * GRIP_DOWN, ax


# ---------------------------------------------------------------------------------------------
# Rifle: AK-105

def build_rifle():
    path = rl.find_source('rifle', ('.fbx',))
    if not path:
        raise FileNotFoundError('AK-105 source missing: tools/blender/source-art/realistic/rifle/ak105fbx.zip')
    log('rifle source', path)
    objs = by_name(rl.import_model(path))
    tex = os.path.dirname(path)
    tex = os.path.join(tex, 'textures') if os.path.isdir(os.path.join(tex, 'textures')) else tex
    maps = {}
    for mat in ('ak105', 'folding_stock'):
        stem = 'ak105_ak' if mat == 'ak105' else 'ak105_folding_stock'
        maps[mat] = {'base': (rl.load_image(os.path.join(tex, f'{stem}_BaseColor.png')), None),
                     'rough': (rl.load_image(os.path.join(tex, f'{stem}_Roughness.png')), 0),
                     'metal': (rl.load_image(os.path.join(tex, f'{stem}_Metallic.png')), 0),
                     'normal': (rl.load_image(os.path.join(tex, f'{stem}_Normal.png')), None)}
    # Source: muzzle toward -Y, sights +Z, charging handle on -X (the right side).
    fwd, up = Vector((0, -1, 0)), Vector((0, 0, 1))
    pg = objs['PISTOL GRIP']
    pts = [v.co.copy() for v in pg.data.vertices]
    origin, _ = grip_origin(pts)
    xs = [p.x for p in pts]
    origin.x = (min(xs) + max(xs)) / 2
    all_pts = rl.points(list(objs.values()))
    length = max(p.dot(fwd) for p in all_pts) - min(p.dot(fwd) for p in all_pts)
    s = RIFLE_LENGTH / length
    rl.to_frame(list(objs.values()), fwd, up, origin, s)
    log('rifle: source length', round(length, 4), 'scale', round(s, 5), 'grip origin (source)',
        tuple(round(c, 4) for c in origin))

    # Landmarks (shipped frame).
    brake = objs['MUZZLE_BRAKE']
    blo, bhi = rl.bounds(brake)
    bore_x, bore_z = (blo.x + bhi.x) / 2, (blo.z + bhi.z) / 2
    mx, my, mz, _ = rl.front_face(brake)
    muzzle_bare = Vector((bore_x, my, bore_z))
    barrel_pts = rl.points(objs['BARREL'])
    post = [p for p in barrel_pts if p.y > blo.y - 0.09]
    iron_z = max(p.z for p in post)
    rear = max(rl.points(objs['IRON_SIGHT']), key=lambda p: p.z)
    dc = rl.points(objs['DUST_COVER'])
    rail_z = max(p.z for p in dc)
    rail = [p for p in dc if p.z > rail_z - 0.002]
    rail_y = (min(p.y for p in rail), max(p.y for p in rail))
    hlo, hhi = rl.bounds(objs['HAND_GUARD'])
    handle = max(rl.points(objs['BOLT_CARRIER']), key=lambda p: p.x)
    mag_ax, mag_lo, mag_hi = rl.axis_of(rl.points(objs['MAGAZINE']))
    grip_ax, glo, ghi = rl.axis_of(rl.points(pg))
    log('rifle: bore x/z', round(bore_x, 4), round(bore_z, 4), 'muzzle brake front', round(my, 4), 'rear', round(blo.y, 4),
        'front post top', round(iron_z, 4), 'rear sight top', tuple(round(c, 4) for c in rear),
        'rail top', round(rail_z, 4), 'from', tuple(round(c, 4) for c in rail_y),
        'handguard', tuple(round(c, 4) for c in hlo), tuple(round(c, 4) for c in hhi),
        'charging handle', tuple(round(c, 4) for c in handle))

    # First-person reduction (normals carried over).
    for name, target in FP_RIFLE.items():
        rl.decimate(objs[name], target)
    mag = objs.pop('MAGAZINE')
    bolt = objs.pop('BOLT_CARRIER')
    # The raised cheek rest stands almost at the sight line right in front of the eye when aiming: first person
    # leaves it out (the folding stock itself stays); third person keeps it.
    cheek = objs.pop('FOLDING_STOCK_CHICK_REST')
    cheek.name = cheek.data.name = 'fp_gun_cheek'
    body = rl.join(list(objs.values()), 'fp_gun')
    mag.name = mag.data.name = 'fp_gun_mag'
    bolt.name = bolt.data.name = 'fp_gun_bolt'

    # Suppressor: a can that slips over the muzzle brake.
    br = (bhi.x - blo.x) / 2
    sup = suppressor('fp_gun_suppressor', (bore_x, bore_z), blo.y - 0.006, 0.185, br + 0.0045, 32)
    muzzle = Vector((bore_x, blo.y - 0.006 + 0.185, bore_z))

    marks = {
        'mark_rifle_grip': (Vector((0, 0, 0)), grip_ax),
        'mark_rifle_mag': ((mag_lo + mag_hi) / 2, mag_ax),
        'mark_rifle_mag_bottom': (mag_lo, mag_ax),
        'mark_rifle_handguard': (Vector((bore_x, hlo.y + (hhi.y - hlo.y) * 0.22, (hlo.z + hhi.z) / 2)),
                                 Vector((0, 0, 1))),
        'mark_rifle_handguard_size': (Vector(((hhi.x - hlo.x) / 2, (hhi.y - hlo.y) / 2, (hhi.z - hlo.z) / 2)),
                                      Vector((0, 0, 1))),
        'mark_rifle_handle': (handle, Vector((1, 0, 0))),
    }
    return {'body': body, 'mag': mag, 'bolt': bolt, 'cheek': cheek, 'sup': sup, 'maps': maps,
            'bore': (bore_x, bore_z), 'muzzle': muzzle, 'muzzle_bare': muzzle_bare, 'iron_z': iron_z,
            'rail': (rail_z, rail_y), 'marks': marks}


def suppressor(name, centre, back, length, radius, segments):
    """A modern can: wrench-flat collar at the rear, a long body, a chamfered front face with the bore hole."""
    r = radius
    prof = [(0.0, r * 0.45), (0.0, r * 0.92), (0.004, r * 0.97), (0.030, r * 0.97), (0.034, r), (length - 0.008, r),
            (length - 0.002, r * 0.93), (length, r * 0.84), (length, r * 0.30), (length - 0.006, r * 0.26)]
    return rl.lathe(name, prof, segments, 'gen_metal', centre=centre, back=back)


# ---------------------------------------------------------------------------------------------
# Sights

def build_reddot():
    path = rl.find_source('reddot', ('.glb', '.gltf'))
    if not path:
        raise FileNotFoundError('red dot source missing: tools/blender/source-art/realistic/reddot/red_dot_sight.glb')
    log('red dot source', path)
    objs = {}
    for o in rl.import_model(path):
        key = o.name.replace('_low_sight_0', '').split('.')[0]
        objs[key] = o
    glass = objs.pop('main_glass')
    for k in [k for k in objs if 'screw' in k]:
        bpy.data.objects.remove(objs.pop(k))
    mat = next(o.data.materials[0] for o in objs.values() if o.data.materials)
    maps = rl.material_maps(mat)
    log('red dot maps', {k: (v[0].name, v[1]) for k, v in maps.items()})
    shape = objs['main_shape']
    slo, shi = rl.bounds(shape)
    glo, ghi = rl.bounds(glass)
    s = REDDOT_WIDTH / (shi.x - slo.x)
    # Source: window toward +Y (the hood in front, the low deck behind), buttons on +X (right). Origin: the rail
    # contact under the glass centre line, at the middle of the housing's length.
    origin = Vector(((glo.x + ghi.x) / 2, (slo.y + shi.y) / 2, slo.z))
    rl.to_frame(list(objs.values()) + [glass], Vector((0, 1, 0)), Vector((0, 0, 1)), origin, s)
    glo, ghi = rl.bounds(glass)
    axis_z = (glo.z + ghi.z) / 2
    glass_y = (glo.y + ghi.y) / 2
    bpy.data.objects.remove(glass)
    for k, target in FP_REDDOT.items():
        if k in objs:
            rl.decimate(objs[k], target)
    body = rl.join(list(objs.values()), 'fp_gun_sight_reddot')
    lo, hi = rl.bounds(body)
    log('red dot: scale', round(s, 7), 'size', tuple(round(c, 4) for c in (hi - lo)), 'optical axis height',
        round(axis_z, 4), 'glass y', round(glass_y, 4), 'tris', rl.tris(body.data))
    return body, maps, axis_z, glass_y


def build_scope_generated(segments, name):
    """
    A 2x combat scope (ACOG-like) in its own frame (origin = rail contact under the eyepiece end's... centre of the
    base, Y forward, Z up): a tube with eyepiece and objective bells, a flat housing on top with a fibre-optic light
    pipe, a rail clamp base with two thumb nuts on the left. The tube has no inner wall
    and no glass: from the eye on its axis you look straight through it (the client draws the reticle).
    Returns (object, optical axis height, eyepiece rear y, front y).
    """
    H = 0.034                                    # optical axis above the rail
    y0 = -0.07                                   # eyepiece rear face
    # Radius never shrinks toward the front (except the front rim): a face turned back toward the eye would show
    # inside the lens as a dark ring.
    tube = [(0.0, 0.0150), (0.0, 0.0186), (0.003, 0.0192), (0.086, 0.0192), (0.108, 0.0214), (0.140, 0.0216),
            (0.145, 0.0204), (0.145, 0.0196)]
    parts = [rl.lathe('tube', tube, segments, 'gen_metal', centre=(0.0, H), back=y0)]
    bev = 0.0
    # Seen from the eye on the axis, through the eyepiece, nothing but the tube may face the eye: the housing and the
    # base start flush with the eyepiece's rear face (their rear faces frame the lens) and have no face against the
    # tube; the thumb nuts start inside the clamp, out of the lens's view cone.
    parts.append(rl.box('housing', (0.0, y0 + 0.040, H + 0.0255), (0.027, 0.080, 0.016), 'gen_metal', bevel=bev,
                        segments=2 if bev else 1, drop=((0, 0, -1),)))
    fibre = rl.cylinder('fibre', (0.0, y0 + 0.012, H + 0.0342), (0, 1, 0), 0.062, 0.0042, 'gen_polymer',
                        segments=max(8, segments // 3))
    parts.append(rl.box('base', (0.0, y0 + 0.050, (H - 0.0175) / 2), (0.020, 0.100, H - 0.0175), 'gen_metal',
                        bevel=bev * 0.8, segments=1, drop=((0, 0, 1),)))
    parts.append(rl.box('clamp', (0.0, y0 + 0.052, 0.005), (0.032, 0.090, 0.010), 'gen_metal', bevel=bev * 0.6,
                        segments=1))
    for yy in (0.03, 0.08):
        parts.append(rl.cylinder('nut', (-0.008, y0 + yy, 0.005), (-1, 0, 0), 0.018, 0.0062, 'gen_metal',
                                 segments=max(8, segments // 2)))
    for p in parts:
        rl.set_colour(p, SCOPE_RGBA)
    rl.set_colour(fibre, FIBRE_RGBA)
    parts.append(fibre)
    return rl.join(parts, name), H, y0, y0 + 0.145


def build_scope_downloaded(path):
    """
    The owner's "AR Scope (Game-Ready)" by Scape (Fab, CC-BY): a compact sight on a riser, modelled in metres at real
    size (60 mm long), glTF with five materials. Its frame is set explicitly (SCOPE_DL): forward is the model's +Y
    (elevation knob on top, windage knob on the right, as on a real sight), up +Z, and the lens tube's material is
    dropped so the aimed view looks through the housing. Returns (meshes, {material name: maps}, axis height,
    eyepiece y, front y) in the scope's own frame (origin under the optical axis, on the rail; Y forward, Z up).
    """
    log('2x scope source (downloaded)', path)
    objs = rl.import_model(path)
    # Name each material after its base colour image ("Material.001_baseColor.png" -> "scope_Material.001"), so the
    # names do not depend on what else this Blender session has imported.
    for m in {m for o in objs for m in o.data.materials if m}:
        img = rl.material_maps(m).get('base')
        if img:
            m.name = 'scope_' + os.path.basename(img[0].filepath or img[0].name).split('_baseColor')[0]
    lens = []
    for o in list(objs):
        names = {m.name for m in o.data.materials if m}
        if names & set(SCOPE_DL['lens']) or any('glass' in n.lower() or 'lens' in n.lower() for n in names):
            lens.append(o)
            objs.remove(o)
    rl.to_frame(objs + lens, SCOPE_DL['forward'], SCOPE_DL['up'], (0, 0, 0), SCOPE_DL['scale'])
    lp = rl.points(lens) if lens else rl.points(objs)
    cx = (min(p.x for p in lp) + max(p.x for p in lp)) / 2
    cz = (min(p.z for p in lp) + max(p.z for p in lp)) / 2
    for o in lens:
        bpy.data.objects.remove(o)
    pts = rl.points(objs)
    base = min(p.z for p in pts)
    for o in objs:
        o.data.transform(Matrix.Translation((-cx, 0, -base)))
    pts = rl.points(objs)
    y_rear, y_front = min(p.y for p in pts), max(p.y for p in pts)
    maps = {m.name: rl.material_maps(m) for o in objs for m in o.data.materials if m}
    log('scope: axis height', round(cz - base, 4), 'length', round(y_front - y_rear, 4), 'materials', sorted(maps))
    return objs, maps, cz - base, y_rear, y_front


def build_pistol():
    path = rl.find_source('pistol', ('.fbx',))
    if not path:
        raise FileNotFoundError('Makarov source missing: tools/blender/source-art/realistic/pistol/source.zip')
    log('pistol source', path)
    objs = by_name(rl.import_model(path))
    for k in [k for k in objs if k.startswith('SM_9_18') or k in ('SM_PM_Magazine_S_F', 'SM_PM_Magazine_S_O')]:
        bpy.data.objects.remove(objs.pop(k))
    maps = {'base': (rl.load_image(rl.find_file('pistol', 'T_PM_BaseColor.png')), None),
            'normal': (rl.load_image(rl.find_file('pistol', 'T_PM_Normal.png')), None)}
    orm = rl.load_image(rl.find_file('pistol', 'T_PM_OcclusionRoughnessMetallic.png'))
    maps.update({'ao': (orm, 0), 'rough': (orm, 1), 'metal': (orm, 2)})
    # Source (metres): muzzle +X, sights +Z, safety on +Y (the left side).
    fwd, up = Vector((1, 0, 0)), Vector((0, 0, 1))
    frame = objs['SM_PM_Frame']
    gp = [v.co.copy() for v in frame.data.vertices if v.co.z < 0.075 and v.co.x < -0.022]
    origin, _ = grip_origin(gp)
    ys = [p.y for p in gp]
    origin.y = (min(ys) + max(ys)) / 2
    rl.to_frame(list(objs.values()), fwd, up, origin, 1.0)
    slide = objs['SM_PM_Slide']
    sx, sy, sz, sh = rl.front_face(slide)
    spts = rl.points(slide)
    iron_z = max(p.z for p in spts if p.y > sy - 0.02)
    grip_ax, _, _ = rl.axis_of([v.co.copy() for v in objs['SM_PM_Frame'].data.vertices if v.co.z < -0.005 and v.co.y < 0.03])
    mag_ax, mag_lo, mag_hi = rl.axis_of(rl.points(objs['SM_PM_Magazine']))
    # The bore: the slide's front face is a ring around it; its centre is the barrel's axis.
    bore = Vector((sx, sy, sz))
    log('pistol: grip origin (source)', tuple(round(c, 4) for c in origin), 'slide front', round(sy, 4),
        'bore', tuple(round(c, 4) for c in bore), 'front sight top', round(iron_z, 4))
    body = rl.join([objs['SM_PM_Frame'], objs['SM_PM_Hammer'], objs['SM_PM_Trigger']], 'fp_pistol')
    slide = rl.join([objs['SM_PM_Slide'], objs['SM_PM_Safety']], 'fp_pistol_slide')
    mag = rl.join([objs['SM_PM_Magazine'], objs['SM_PM_Mag_P']], 'fp_pistol_mag')
    sup = suppressor('fp_pistol_suppressor', (bore.x, bore.z), sy - 0.002, 0.125, 0.0142, 28)
    marks = {
        'mark_pistol_grip': (Vector((0, 0, 0)), grip_ax),
        'mark_pistol_mag': ((mag_lo + mag_hi) / 2, mag_ax),
        'mark_pistol_mag_bottom': (mag_lo, mag_ax),
        'mark_pistol_slide_rear': (Vector((0.0, min(p.y for p in spts) + 0.012, max(p.z for p in spts) - 0.004)),
                                   Vector((0, 0, 1))),
    }
    return {'body': body, 'slide': slide, 'mag': mag, 'sup': sup, 'maps': maps,
            'muzzle_bare': bore, 'muzzle': Vector((bore.x, sy - 0.002 + 0.125, bore.z)), 'iron_z': iron_z,
            'bore': (bore.x, bore.z), 'marks': marks}


# ---------------------------------------------------------------------------------------------
# Knife

def build_knife():
    path = rl.find_source('knife', ('.gltf', '.glb'))
    if not path:
        raise FileNotFoundError('knife source missing: tools/blender/source-art/realistic/knife/tactical_knife_gltf.zip')
    log('knife source', path)
    objs = rl.import_model(path)
    mat = objs[0].data.materials[0]
    maps = rl.material_maps(mat)
    log('knife maps', {k: (v[0].name, v[1]) for k, v in maps.items()})
    # Source: blade tip toward -Y, spine +Z. The handle is the mesh that does not reach the tip.
    handle = max(objs, key=lambda o: min(v.co.y for v in o.data.vertices))
    hlo, hhi = rl.bounds(handle)
    pts = rl.points(objs)
    fwd, up = Vector((0, -1, 0)), Vector((0, 0, 1))
    length = max(p.dot(fwd) for p in pts) - min(p.dot(fwd) for p in pts)
    centre = (hlo + hhi) / 2
    s = KNIFE_LENGTH / length
    rl.to_frame(objs, fwd, up, centre, s)
    for o in objs:
        rl.decimate(o, FP_KNIFE)
    knife = rl.join(objs, 'fp_knife')
    lo, hi = rl.bounds(knife)
    log('knife: scale', round(s, 5), 'bounds', tuple(round(c, 4) for c in lo), tuple(round(c, 4) for c in hi))
    return {'body': knife, 'maps': maps, 'material': mat.name}


# ---------------------------------------------------------------------------------------------

def tp_copy(src_objs, name, target):
    """Third-person version: copies joined into one mesh, reduced to `target` triangles, normals carried over."""
    copies = [rl.duplicate(o, o.name + '_tp') for o in src_objs]
    ref = rl.join(copies, name + '_ref')
    obj = rl.duplicate(ref, name)
    rl.decimate(obj, target, keep_normals=False)
    rl.transfer_normals(ref, obj)
    bpy.data.objects.remove(ref)
    return obj


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    os.makedirs(rl.BUILD, exist_ok=True)

    # The first-person arms' textures (package O) go into each gun's atlas: crops of the soldier's maps.
    arm_crops = {}
    if os.path.isdir(soldier.SRC):
        before = set(bpy.data.objects)
        _, sparts = soldier.fp_sources()
        arm_crops = soldier.fp_crops(sparts)
        for o in set(bpy.data.objects) - before:
            bpy.data.objects.remove(o)
    else:
        log('WARNING soldier sources missing: the arm regions of the atlases stay flat grey')

    def arm_regions(name):
        if not arm_crops:
            return [rl.Region(k, r, constant=0.2) for k, r in rl.ARM_LAYOUTS[name].items()]
        return soldier.fp_regions(rl.ARM_LAYOUTS[name], arm_crops)

    # --- Rifle and its sights -------------------------------------------------------------------
    rifle = build_rifle()
    bore_x, bore_z = rifle['bore']
    rail_z, (ry0, ry1) = rifle['rail']
    reddot, reddot_maps, rd_axis, rd_glass = build_reddot()
    # Red dot: on the dust-cover rail, a little ahead of its middle.
    rd_y = ry0 + (ry1 - ry0) * 0.58
    reddot.data.transform(Matrix.Translation((bore_x, rd_y, rail_z)))
    dot = rl.disc('reticle', (bore_x, rd_y + rd_glass - 0.0005, rail_z + rd_axis), (0, -1, 0), RETICLE_RADIUS,
                  'gen_glow', segments=12)

    scope_path = rl.find_source('scope2x', ('.glb', '.gltf', '.fbx', '.obj'))
    scope_maps = {}
    if scope_path:
        sobjs, scope_maps, sc_axis, sc_rear, sc_front = build_scope_downloaded(scope_path)
        for o in sobjs:
            rl.decimate(o, FP_SCOPE_DL // max(1, len(sobjs)))
        scope = rl.join(sobjs, 'fp_gun_sight_scope2x')
        scope_source = 'downloaded'
    else:
        scope, sc_axis, sc_rear, sc_front = build_scope_generated(32, 'fp_gun_sight_scope2x')
        scope_source = 'generated'
    # 2x scope: its eyepiece over the rear of the rail (the eye close behind it when aiming).
    sc_y = ry0 + 0.012 - sc_rear
    scope.data.transform(Matrix.Translation((bore_x, sc_y, rail_z)))
    log('2x scope', scope_source, 'axis height', round(sc_axis, 4), 'eyepiece y', round(sc_y + sc_rear, 4),
        'tris', rl.tris(scope.data))

    regions = [(k, r, {'ak105': rifle['maps']['ak105'], 'folding_stock': rifle['maps']['folding_stock'],
                       'sight': reddot_maps, 'scope': {}}[k]) for k, r in RIFLE_LAYOUT if not (scope_path and k == 'scope')]
    if scope_path:
        # The downloaded sight: one rectangle per material, cropped to the part of its maps the model uses.
        for mname, rect in SCOPE_DL_REGIONS.items():
            regions.append(rl.Region(mname, rect, scope_maps.get(mname, {}), crop=rl.uv_crop([scope], mname)))
    atlas = rl.Atlas('rifle', regions + arm_regions('rifle'), RIFLE_SWATCHES)
    for o in (rifle['body'], rifle['mag'], rifle['bolt'], rifle['cheek']):
        rl.prepare(o, atlas, 'rifle')
    rl.prepare(reddot, atlas, 'rifle', material_region={m.name: 'sight' for m in reddot.data.materials if m})
    rl.prepare(dot, atlas, 'rifle', swatch='glow', colour=RETICLE_RGBA)
    reddot = rl.join([reddot, dot], 'fp_gun_sight_reddot')
    rl.prepare(rifle['sup'], atlas, 'rifle', swatch='metal', colour=SUPPRESSOR_RGBA)
    if scope_path:
        rl.prepare(scope, atlas, 'rifle')
    else:
        keep = [tuple(c.color) for c in scope.data.color_attributes['Col'].data]
        atlas.remap(scope, swatch='metal')
        scope.data.color_attributes['Col'].data.foreach_set('color', [x for c in keep for x in c])
        rl.single_material(scope, 'rifle')
    atlas.write()

    # Aim points (eye positions) per sight; iron line from the front post.
    eye_y = -EYE_BEHIND_GRIP['rifle']
    rifle_aims = {
        'iron': (bore_x, eye_y, rifle['iron_z']),
        'reddot': (bore_x, rd_y + rd_glass - REDDOT_EYE_RELIEF, rail_z + rd_axis),
        'scope2x': (bore_x, sc_y + sc_rear - SCOPE_EYE_RELIEF, rail_z + sc_axis),
    }
    log('rifle aim points', {k: tuple(round(c, 4) for c in v) for k, v in rifle_aims.items()})

    # --- Pistol ---------------------------------------------------------------------------------
    pistol = build_pistol()
    patlas = rl.Atlas('pistol', [(k, r, pistol['maps']) for k, r in PISTOL_LAYOUT] + arm_regions('pistol'),
                      SIDE_SWATCHES)
    for o in (pistol['body'], pistol['slide'], pistol['mag']):
        rl.prepare(o, patlas, 'pistol')
    rl.prepare(pistol['sup'], patlas, 'pistol', swatch='metal', colour=SUPPRESSOR_RGBA)
    patlas.write()
    pistol_aims = {'iron': (pistol['bore'][0], -EYE_BEHIND_GRIP['pistol'], pistol['iron_z'])}

    # --- Knife ----------------------------------------------------------------------------------
    knife = build_knife()
    katlas = rl.Atlas('knife', [(knife['material'], KNIFE_LAYOUT[0][1], knife['maps'])] + arm_regions('knife'),
                      SIDE_SWATCHES)
    rl.prepare(knife['body'], katlas, 'knife')
    katlas.write()

    # --- First-person parts file (viewmodel.py) -----------------------------------------------------
    fp = [rifle['body'], rifle['mag'], rifle['bolt'], rifle['sup'], reddot, scope,
          pistol['body'], pistol['slide'], pistol['mag'], pistol['sup'], knife['body']]
    fp_empties = []
    for n, loc in (('fp_gun_muzzle', rifle['muzzle']), ('fp_gun_muzzle_bare', rifle['muzzle_bare']),
                   ('fp_pistol_muzzle', pistol['muzzle']), ('fp_pistol_muzzle_bare', pistol['muzzle_bare'])):
        fp_empties.append(rl.add_empty(n, loc))
    for k, v in rifle_aims.items():
        fp_empties.append(rl.add_empty(f'fp_gun_aim_{k}', v))
    for k, v in pistol_aims.items():
        fp_empties.append(rl.add_empty(f'fp_pistol_aim_{k}', v))
    for n, (loc, axis) in list(rifle['marks'].items()) + list(pistol['marks'].items()):
        fp_empties.append(rl.add_empty('fp_' + n, loc, axis=axis))
    for o in fp:
        log('first person', o.name, 'tris', rl.tris(o.data), 'verts', len(o.data.vertices))
    export(fp + fp_empties, rl.FP_GLB)

    # --- Third person (weapons.glb) ------------------------------------------------------------------
    gun = tp_copy([rifle['body'], rifle['mag'], rifle['bolt'], rifle['cheek']], 'gun', TP['gun'])
    gsup = suppressor('gun_suppressor', rifle['bore'], rifle['muzzle'].y - 0.185, 0.185,
                      (rl.bounds(rifle['sup'])[1].x - rl.bounds(rifle['sup'])[0].x) / 2, 12)
    rl.prepare(gsup, atlas, 'rifle', swatch='metal', colour=SUPPRESSOR_RGBA)
    grd = tp_copy([reddot], 'gun_sight_reddot', TP['reddot'])
    if scope_path:
        gsc = tp_copy([scope], 'gun_sight_scope2x', TP['scope_dl'])
    else:
        gsc, _, _, _ = build_scope_generated(12, 'gun_sight_scope2x')
        gsc.data.transform(Matrix.Translation((bore_x, sc_y, rail_z)))
        keep = [tuple(c.color) for c in gsc.data.color_attributes['Col'].data]
        atlas.remap(gsc, swatch='metal')
        gsc.data.color_attributes['Col'].data.foreach_set('color', [x for c in keep for x in c])
        rl.single_material(gsc, 'rifle')
    pis = tp_copy([pistol['body'], pistol['slide'], pistol['mag']], 'pistol', TP['pistol'])
    psup = suppressor('pistol_suppressor', pistol['bore'], pistol['muzzle'].y - 0.125, 0.125, 0.0142, 12)
    rl.prepare(psup, patlas, 'pistol', swatch='metal', colour=SUPPRESSOR_RGBA)
    # Third person only: the character's cartoon fist is larger than a real Makarov and swallowed it, so the pistol
    # is drawn larger about its grip (its muzzles follow; the aim point is first-person only and stays real).
    for o in (pis, psup):
        o.data.transform(Matrix.Scale(TP_PISTOL_SCALE, 4))
    kn = tp_copy([knife['body']], 'knife', TP['knife'])
    tp = [gun, gsup, grd, gsc, pis, psup, kn]
    for o in (gsup, grd, gsc):
        o.parent = gun
    psup.parent = pis
    tp_empties = []
    for n, loc in (('gun_muzzle', rifle['muzzle']), ('gun_muzzle_bare', rifle['muzzle_bare'])):
        tp_empties.append(rl.add_empty(n, loc, parent=gun))
    for k, v in rifle_aims.items():
        tp_empties.append(rl.add_empty(f'gun_aim_{k}', v, parent=gun))
    for n, loc in (('pistol_muzzle', pistol['muzzle']), ('pistol_muzzle_bare', pistol['muzzle_bare'])):
        tp_empties.append(rl.add_empty(n, loc * TP_PISTOL_SCALE, parent=pis))
    for k, v in pistol_aims.items():
        tp_empties.append(rl.add_empty(f'pistol_aim_{k}', v, parent=pis))
    for o in tp:
        lo, hi = rl.bounds(o)
        log('third person', o.name, 'tris', rl.tris(o.data), 'verts', len(o.data.vertices),
            'bounds lo', tuple(round(c, 3) for c in lo), 'hi', tuple(round(c, 3) for c in hi))
    for e in tp_empties:
        x, y, z = e.matrix_world.translation
        log(e.name, '(Blender)', (round(x, 4), round(y, 4), round(z, 4)), '-> glTF', (round(x, 4), round(z, 4), round(-y, 4)))
    export(tp + tp_empties, OUT)


def export(objs, path):
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_tangents=False, export_vertex_color='ACTIVE', export_all_vertex_colors=False,
        export_materials='EXPORT', export_image_format='NONE', export_animations=False, export_skins=False,
        export_morph=False, export_extras=False, export_cameras=False, export_lights=False)
    log('wrote', path, os.path.getsize(path), 'bytes')
    if path == OUT:
        rl.quantize(path)


main()
