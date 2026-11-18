"""
Stillblade character pipeline (package O): a rigged humanoid FBX -> client/public/models/character_{high,low}.glb and
the character texture atlas client/public/models/textures/character_{albedo,normal}_{2048,1024}.webp.

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup \
        --python tools/blender/soldier.py [-- --tier high|low]

Run weapons.py first (the hand poses read the guns' landmarks from source-art/realistic/build/weapons_fp.glb).

Sources (git-ignored, tools/blender/source-art/):
  realistic/soldier/src/FBX/*.fbx and PBR_Textures/  "Quantum Modular Character Free Sample" by Quantum Assets (Fab
      Standard License; credited in client/public/models/CREDITS.md; never ship these files outside the game build).
      Extracted from the owner's fbx_all_assets.zip and pbr_textures.zip (only the BaseColor, OcclusionRoughnessMetallic
      and Unity_Normal maps are needed).
  characters/quaternius-swat/SWAT.glb  "SWAT" by Quaternius (CC0): the source of the animation clips (idle, walk, run,
      death, hit), retargeted here onto the new skeleton.

Model-agnostic on purpose (the soldier is a stopgap; ROADMAP.md, package O): everything model-specific is in the
tables at the top: which FBX parts make each look (PARTS), the bone map from the source skeleton to the shipped one
(BONES), the atlas layout (REGIONS). Any rigged humanoid with a UE5-style skeleton plugs in by editing those.

What it does:
  1. Imports the soldier (SKM_Character.fbx: clothes, head, forearms; SKM_Body_Full.fbx: the bare body the ghost is
     made from). Blender's FBX importer fails on these files (a mesh bound to a bone it never registered as a bind
     pose: KeyError in link_hierarchy); `patch_fbx_importer` falls back to the armature's other bind matrices.
  2. Builds the shipped skeleton (51 bones, SWAT-style names so the client and the clip code are unchanged): root,
     hips, three spine bones, neck, head, per side shoulder, upper arm, forearm, wrist, three bones per finger and the
     thumb, thigh, shin, foot. Every other source bone (twist, corrective, face, metacarpal, toe) is folded into its
     nearest kept ancestor: its skin weights move there.
  3. Two looks, each ONE mesh with ONE material (the atlas), per tier:
       char_defender: cap, head, eyes, rolled-up shirt dyed team orange, plate carrier, drop-leg pouch, holster,
                      jeans with boots, forearms and hands (the holstered pistol, patches, teeth and lashes are left out)
       char_ghost:    the bare body as a close-fitting dark suit with a balaclava (the face smoothed and the head
                      inflated a little); no cap, no vest, no gear. Ghosts are only ever drawn with the
                      shimmer shader (characters.ts), which uses the shape and normals, not the texture, so the ghost
                      points at a dark swatch of the atlas.
     Reduced per part to the tier's triangle budget (BUDGET), weights cleaned to 4 influences.
  4. One atlas for both tiers: each source material gets a rectangle, cropped to the part of its 4K maps the meshes use.
  5. Clips: idle, walk, run, death and hit retargeted from SWAT (rest poses aligned bone by bone, rotations copied in
     world space, hips scaled by leg length, feet put back where the source's feet are by two-bone IK); crouch_idle and
     crouch_walk derived from idle and walk; the held-weapon clips generated from the AK-105, Makarov and knife
     landmarks with the hands on the real grips and fingers closed round them: aim, shoot, pistol, pistol_shoot,
     reload_rifle (2.2 s), reload_pistol (1.4 s), knife_hold, knife_swing. Same names and timings as before.
  6. Sockets on the right wrist: socket_gun (the rifle), socket_pistol, socket_knife.
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
import realistic as rl  # noqa: E402
import rigkit as rk  # noqa: E402

ROOT = rl.ROOT
SRC = os.path.join(HERE, 'source-art', 'realistic', 'soldier', 'src')
SWAT = os.path.join(HERE, 'source-art', 'characters', 'quaternius-swat', 'SWAT.glb')
OUT_DIR = os.path.join(ROOT, 'client', 'public', 'models')
FPS = 24
TARGET_HEIGHT = 1.8           # top of the cap, standing idle

# ---------------------------------------------------------------------------------------------
# Model tables

# Shipped bone <- source bone, parent. Fingers: 2..4 are the three phalanges (the metacarpals fold into the wrist),
# thumb 1..3.
FINGERS = ('Index', 'Middle', 'Ring', 'Pinky')


def _bones():
    out = [('Root', None, None), ('Hips', 'pelvis', 'Root'), ('Abdomen', 'spine_01', 'Hips'),
           ('Torso', 'spine_03', 'Abdomen'), ('Chest', 'spine_05', 'Torso'), ('Neck', 'neck_01', 'Chest'),
           ('Head', 'head', 'Neck')]
    for S, s in (('L', 'l'), ('R', 'r')):
        out += [(f'Shoulder.{S}', f'clavicle_{s}', 'Chest'), (f'UpperArm.{S}', f'upperarm_{s}', f'Shoulder.{S}'),
                (f'LowerArm.{S}', f'lowerarm_{s}', f'UpperArm.{S}'), (f'Wrist.{S}', f'hand_{s}', f'LowerArm.{S}')]
        for F in FINGERS:
            f = F.lower()
            out += [(f'{F}2.{S}', f'{f}_01_{s}', f'Wrist.{S}'), (f'{F}3.{S}', f'{f}_02_{s}', f'{F}2.{S}'),
                    (f'{F}4.{S}', f'{f}_03_{s}', f'{F}3.{S}')]
        out += [(f'Thumb1.{S}', f'thumb_01_{s}', f'Wrist.{S}'), (f'Thumb2.{S}', f'thumb_02_{s}', f'Thumb1.{S}'),
                (f'Thumb3.{S}', f'thumb_03_{s}', f'Thumb2.{S}')]
        out += [(f'UpperLeg.{S}', f'thigh_{s}', 'Hips'), (f'LowerLeg.{S}', f'calf_{s}', f'UpperLeg.{S}'),
                (f'Foot.{S}', f'foot_{s}', f'LowerLeg.{S}')]
    return out


BONES = _bones()

# Looks: FBX file -> [(mesh name prefix, material names dropped)].
PARTS = {
    'defender': {'SKM_Character.fbx': [('Bulletproof', ()), ('Cap', ()), ('Drops_1', ()), ('Eye', ('M_Sclera',)),
                                        ('Head', ()), ('Holster_Hard', ()), ('Jeans_Tactic', ()),
                                        ('Shirt_RolledUp', ()), ('Quantum_Arms', ())]},
    'ghost': {'SKM_Body_Full.fbx': [('Body_Full', ())]},
}
# Triangles per part and tier.
BUDGET = {
    'high': {'Bulletproof': 3300, 'Jeans_Tactic': 2300, 'Shirt_RolledUp': 1500, 'Head': 2300, 'Quantum_Arms': 2000,
             'Drops_1': 700, 'Holster_Hard': 450, 'Cap': 300, 'Eye': 120, 'Body_Full': 10500},
    'low': {'Bulletproof': 1700, 'Jeans_Tactic': 1150, 'Shirt_RolledUp': 800, 'Head': 1100, 'Quantum_Arms': 1000,
            'Drops_1': 300, 'Holster_Hard': 220, 'Cap': 160, 'Eye': 40, 'Body_Full': 5500},
}
# Source material -> (atlas region, texture stem under PBR_Textures).
MATERIALS = {
    'M_Bulletproof_Light': ('vest', 'Bulletproof/T_Bulletproof_Bege', 'Bulletproof/T_Bulletproof_Light'),
    'M_Jeans': ('jeans', 'Jeans/T_Jeans_Bege', 'Jeans/T_Jeans'),
    'M_Shirt_RolledUp': ('shirt', 'Shirt_RolledUp/T_Shirt_RolledUp_Blue', 'Shirt_RolledUp/T_Shirt_RolledUp'),
    'M_Head': ('head', 'Body/T_Head', 'Body/T_Head'),
    'M_Quantum_Head': ('head', 'Body/T_Head', 'Body/T_Head'),
    'M_Quantum_Arms': ('arms', 'Arms/T_Quantum_Basemesh_Arms', 'Arms/T_Quantum_Basemesh_Arms'),
    'M_Quantum_Body': ('body', 'Body/T_Body', 'Body/T_Body'),
    'M_Body': ('body', 'Body/T_Body', 'Body/T_Body'),
    'M_Drops_Tactical': ('drops', 'Drops/T_Drops_Tactical_Bege', 'Drops/T_Drops_Tactical'),
    'M_Holster_Hard': ('holster', 'Holdster_Hard/M_Holster_Hard_Bege', 'Holdster_Hard/M_Holster_Hard'),
    'M_Cap': ('cap', 'Cap/T_Cap_Bege', 'Cap/T_Cap'),
    'M_Eyeball': ('eye', 'Body/T_Eyeball', 'Body/T_Eyeball'),
}
# Atlas rectangles (u0, v0, u1, v1).
REGIONS = {
    'vest': (0.0, 0.5, 0.5, 1.0), 'jeans': (0.5, 0.5, 1.0, 1.0), 'shirt': (0.0, 0.0, 0.5, 0.5),
    'head': (0.5, 0.25, 0.75, 0.5), 'arms': (0.75, 0.25, 1.0, 0.5), 'drops': (0.5, 0.0, 0.625, 0.25),
    'holster': (0.625, 0.0, 0.75, 0.125), 'cap': (0.625, 0.125, 0.75, 0.25), 'body': (0.75, 0.125, 0.875, 0.25),
    'eye': (0.875, 0.125, 0.9375, 0.1875),
}
SWATCHES = (0.75, 0.0, 1.0, 0.125)
# Team colour: the shirt dyed orange (sRGB), keeping the fabric's shading; and the ghost suit's vertex colour.
TEAM_ORANGE = (0.86, 0.38, 0.09)
GHOST_SUIT = (0.05, 0.052, 0.06, 0.0)
CHARACTER_NORMAL_QUALITY = 60
BALACLAVA_SMOOTH = 18
BALACLAVA_INFLATE = 0.006
BOOT_TOP = 0.13


def log(*a):
    rk.log('soldier', *a)


# ---------------------------------------------------------------------------------------------
# Import

def patch_fbx_importer():
    """Blender's FBX importer raises KeyError when a mesh is bound to a node it never saw a bind pose for (these files);
    fall back to another bind matrix of the same armature (they are all the same here)."""
    import io_scene_fbx.import_fbx as imf
    if getattr(imf, '_sb_patched', False):
        return

    class Setup(dict):
        def __missing__(self, key):
            return next(iter(self.values())) if self else (Matrix(), Matrix())

    orig = imf.FbxImportHelperNode.__init__

    def init(self, *a, **k):
        orig(self, *a, **k)
        self.armature_setup = Setup()
    imf.FbxImportHelperNode.__init__ = init
    imf._sb_patched = True


def import_fbx(name):
    """Imports one FBX; returns (armature, {mesh object name: object}) with everything in world space (metres)."""
    patch_fbx_importer()
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(SRC, 'FBX', name))
    bpy.context.view_layer.update()
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    meshes = {}
    for o in new:
        if o.type == 'MESH':
            me = o.data.copy()
            me.transform(o.matrix_world)
            c = bpy.data.objects.new(o.name.split('.')[0] + '_src', me)
            bpy.context.scene.collection.objects.link(c)
            for g in o.vertex_groups:
                c.vertex_groups.new(name=g.name)
            meshes[o.name.split('.')[0]] = c
    for o in new:
        if o is not arm:
            bpy.data.objects.remove(o)
    return arm, meshes


def fold_map(arm):
    """Every source bone -> the shipped bone its weights go to (its nearest kept ancestor)."""
    kept = {src: tgt for tgt, src, _ in BONES if src}
    out = {}
    for b in arm.data.bones:
        p = b
        while p is not None and p.name not in kept:
            p = p.parent
        out[b.name] = kept[p.name] if p is not None else 'Hips'
    return out


def build_armature(q):
    """The shipped skeleton at the source's rest pose (world space, the armature object at identity)."""
    data = bpy.data.armatures.new('Armature')
    arm = bpy.data.objects.new('Armature', data)
    bpy.context.scene.collection.objects.link(arm)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones
    heads = {tgt: (q.matrix_world @ q.data.bones[src].head_local if src else Vector((0, 0, 0))) for tgt, src, _ in BONES}
    children = {}
    for tgt, _, par in BONES:
        if par:
            children.setdefault(par, []).append(tgt)
    main_child = {'Hips': 'Abdomen', 'Chest': 'Neck', 'Root': 'Hips'}
    for S in 'LR':
        main_child[f'Wrist.{S}'] = f'Middle2.{S}'
    for tgt, _, par in BONES:
        b = eb.new(tgt)
        b.head = heads[tgt]
        kids = children.get(tgt, [])
        c = main_child.get(tgt) or (kids[0] if kids else None)
        if c is not None and (heads[c] - heads[tgt]).length > 1e-3:
            d = heads[c] - heads[tgt]
        elif par is not None:
            d = (heads[tgt] - heads[par]).normalized() * 0.04
        else:
            d = Vector((0, 0, 0.1))
        if tgt == 'Root':
            d = Vector((0, 0, 0.1))
        if tgt.startswith('Foot'):
            d = Vector((0, -0.12, -0.06))
        if tgt == 'Head':
            d = Vector((0, 0, 0.18))
        b.tail = b.head + d
        b.align_roll(Vector((0, 0, 1)) if abs(d.normalized().z) < 0.7 else Vector((0, -1, 0)))
    for tgt, _, par in BONES:
        if par:
            eb[tgt].parent = eb[par]
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm


# ---------------------------------------------------------------------------------------------
# Meshes

def tris(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def copy_part(src, name, drop_mats, fold):
    """A copy of a source mesh (world space) with its weights folded onto the shipped bones and dropped materials'
    faces removed."""
    me = src.data.copy()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    if drop_mats:
        bm = bmesh.new()
        bm.from_mesh(me)
        mats = [m.name.split('.')[0] if m else '' for m in me.materials]
        dead = [f for f in bm.faces if mats[f.material_index] in drop_mats]
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        bm.to_mesh(me)
        bm.free()
    gname = {i: g.name for i, g in enumerate(src.vertex_groups)}
    acc = []
    for v in me.vertices:
        w = {}
        for g in v.groups:
            t = fold.get(gname.get(g.group, ''), None)
            if t is None or g.weight <= 0:
                continue
            w[t] = w.get(t, 0.0) + g.weight
        acc.append(w)
    groups = {}
    for tgt, _, _ in BONES:
        groups[tgt] = obj.vertex_groups.new(name=tgt)
    for t in sorted({t for w in acc for t in w} - set(groups)):
        groups[t] = obj.vertex_groups.new(name=t)
    by = {}
    for i, w in enumerate(acc):
        tot = sum(w.values())
        if tot <= 0:
            w, tot = {'Hips': 1.0}, 1.0
        for t, x in w.items():
            by.setdefault((t, round(x / tot, 4)), []).append(i)
    for (t, x), idx in by.items():
        groups[t].add(idx, x, 'REPLACE')
    return obj


def material_names(obj):
    return [m.name.split('.')[0] if m else '' for m in obj.data.materials]


def uv_crops(sources):
    """Per atlas region: the bounding box of the UVs its materials' faces use (over every source mesh), padded."""
    box = {}
    for obj in sources:
        me = obj.data
        if not me.uv_layers:
            continue
        uv = np.zeros(len(me.loops) * 2, np.float32)
        me.uv_layers[0].data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        mats = material_names(obj)
        for p in me.polygons:
            m = mats[p.material_index] if p.material_index < len(mats) else ''
            if m not in MATERIALS:
                continue
            reg = MATERIALS[m][0]
            sel = uv[p.loop_start:p.loop_start + p.loop_total]
            lo, hi = sel.min(axis=0), sel.max(axis=0)
            b = box.get(reg)
            box[reg] = (np.minimum(b[0], lo), np.maximum(b[1], hi)) if b else (lo, hi)
    out = {}
    for reg, (lo, hi) in box.items():
        pad = 0.01
        out[reg] = (max(0.0, float(lo[0]) - pad), max(0.0, float(lo[1]) - pad),
                    min(1.0, float(hi[0]) + pad), min(1.0, float(hi[1]) + pad))
    return out


def texture_maps(stem_colour, stem_rest):
    root = os.path.join(SRC, 'PBR_Textures')

    def find(stem, suffix):
        d = os.path.join(root, os.path.dirname(stem))
        b = os.path.basename(stem) + suffix
        for f in sorted(os.listdir(d)):
            if f.startswith(b):
                return rl.load_image(os.path.join(d, f))
        raise FileNotFoundError(stem + suffix)
    base = find(stem_colour, '_BaseColor')
    orm = find(stem_rest, '_OcclusionRoughnessMetallic')
    try:
        nrm = find(stem_rest, '_Unity_Normal')
    except FileNotFoundError:
        nrm = opengl_normal(find(stem_rest, '_Normal'))
    return {'base': (base, None), 'ao': (orm, 0), 'rough': (orm, 1), 'metal': (orm, 2), 'normal': (nrm, None)}


def opengl_normal(img):
    """A DirectX-style (Unreal) normal map turned OpenGL-style (green flipped), as a new image."""
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    px[:, 1] = 1.0 - px[:, 1]
    out = bpy.data.images.new(img.name + '_gl', w, h, alpha=True, float_buffer=True)
    out.colorspace_settings.name = 'Non-Color'
    out.pixels.foreach_set(px.ravel())
    return out


def dye_orange(rgb, s):
    lum = rgb[..., 0] * 0.3 + rgb[..., 1] * 0.55 + rgb[..., 2] * 0.15
    k = lum / max(float(lum.mean()), 1e-3)
    for c in range(3):
        rgb[..., c] = np.clip(k * TEAM_ORANGE[c], 0, 1)


def make_atlas(crops):
    regions = []
    done = set()
    for mname, (reg, stem_c, stem_r) in MATERIALS.items():
        if reg in done:
            continue
        done.add(reg)
        regions.append(rl.Region(reg, REGIONS[reg], texture_maps(stem_c, stem_r), crop=crops.get(reg),
                                 post=dye_orange if reg == 'shirt' else None))
    return rl.Atlas('character', regions, SWATCHES)


def smooth_normals(obj):
    """Plain smooth vertex normals. The reduction's copied-back custom normals (realistic.decimate) are per face corner
    from the nearest original face: right for hard-surface guns, but on reduced skin and cloth neighbouring corners of
    one vertex get different normals and the surface looks faceted."""
    me = obj.data
    if me.has_custom_normals:
        with bpy.context.temp_override(object=obj, active_object=obj):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
    me.shade_smooth()


def balaclava(obj):
    """The ghost's head and feet: features smoothed and pushed out a few millimetres (a balaclava, boots)."""
    me = obj.data
    mats = material_names(obj)
    bm = bmesh.new()
    bm.from_mesh(me)
    head = set()
    for f in bm.faces:
        if mats[f.material_index] == 'M_Head':
            head.update(f.verts)
    head = list(head)
    # Feet: toes smoothed into a boot shape (the shimmer shows the silhouette).
    feet = [v for v in bm.verts if v.co.z < BOOT_TOP]
    for _ in range(BALACLAVA_SMOOTH):
        bmesh.ops.smooth_vert(bm, verts=head, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        bmesh.ops.smooth_vert(bm, verts=feet, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=False)
    bm.normal_update()
    for v in head + feet:
        v.co += v.normal * BALACLAVA_INFLATE
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    if me.has_custom_normals:
        me.free_normals_split() if hasattr(me, 'free_normals_split') else None
        bpy.context.view_layer.objects.active = obj
        with bpy.context.temp_override(object=obj, active_object=obj):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()


def build_look(look, tier, sources, fold, atlas):
    parts = []
    for fbx, items in PARTS[look].items():
        for name, drop in items:
            src = sources[fbx][name]
            obj = copy_part(src, f'{look}_{name}', set(drop), fold[fbx])
            if look == 'ghost' and name == 'Body_Full':
                balaclava(obj)
            rl.decimate(obj, BUDGET[tier][name], keep_normals=False)
            smooth_normals(obj)
            if look == 'ghost':
                atlas.remap(obj, swatch='polymer')
                rl.set_colour(obj, GHOST_SUIT)
            else:
                mats = obj.data.materials
                atlas.remap(obj, material_region={m.name: MATERIALS.get(m.name.split('.')[0], ('eye',))[0] for m in mats if m})
                rl.set_colour(obj, (1, 1, 1, 0))
            parts.append(obj)
    obj = rl.join(parts, f'char_{look}')
    rl.single_material(obj, 'character')
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.vertex_group_clean(group_select_mode='ALL', limit=0.01)
        bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    for g in list(obj.vertex_groups):
        pass
    log(look, tier, 'tris', tris(obj.data), 'verts', len(obj.data.vertices))
    return obj


# ---------------------------------------------------------------------------------------------
# First-person arms (viewmodel.py) and their regions in the gun atlases (weapons.py writes them)

ARM_BONES = set()
for _S in 'LR':
    ARM_BONES.update({f'UpperArm.{_S}', f'LowerArm.{_S}', f'Wrist.{_S}'})
    ARM_BONES.update(f'{F}{k}.{_S}' for F in FINGERS for k in (2, 3, 4))
    ARM_BONES.update(f'Thumb{k}.{_S}' for k in (1, 2, 3))
# First person only: two forearm twist bones per arm (from the source's lowerarm_twist_02 at mid forearm and _01 near
# the wrist), so the wrist's roll is spread along the forearm instead of wringing the skin at the elbow or the wrist.
FP_TWIST = {'ForeTwist1': 'lowerarm_twist_02', 'ForeTwist2': 'lowerarm_twist_01'}
for _S in 'LR':
    ARM_BONES.update(f'{t}.{_S}' for t in FP_TWIST)
HAND_BONES = {b for b in ARM_BONES if not b.startswith(('UpperArm', 'LowerArm', 'ForeTwist'))}
# Look -> [(FBX, mesh, triangles)]: the defender's forearms, hands and rolled sleeves; the ghost's suit arms.
FP_PARTS = {'defender': [('SKM_Character.fbx', 'Quantum_Arms', 4400), ('SKM_Character.fbx', 'Shirt_RolledUp', 600)],
            'ghost': [('SKM_Body_Full.fbx', 'Body_Full', 4500)]}
FP_REGION = {'M_Quantum_Arms': 'arms', 'M_Quantum_Head': 'arms', 'M_Quantum_Body': 'arms', 'M_Shirt_RolledUp': 'sleeve',
             'M_Body': 'ghostarms', 'M_Head': 'ghostarms'}
FP_TEXTURES = {'arms': MATERIALS['M_Quantum_Arms'][1:], 'sleeve': MATERIALS['M_Shirt_RolledUp'][1:],
               'ghostarms': MATERIALS['M_Body'][1:]}
# Ghost arms: a dark suit, darker gloves (vertex colours over a grey copy of the body's texture).
GHOST_SLEEVE = (0.11, 0.11, 0.13, 0.0)
GHOST_GLOVE = (0.05, 0.05, 0.055, 0.0)
FP_ARM_MIN_WEIGHT = 0.35


def fp_sources():
    """Imports the soldier into the current scene; returns (shipped skeleton armature, {look: [arm part objects]}):
    only the faces whose vertices are mostly weighted to the arm bones, weights folded and kept on the arm bones only,
    source UVs and materials kept."""
    sources, folds, q = {}, {}, None
    for fbx in ('SKM_Character.fbx', 'SKM_Body_Full.fbx'):
        a, meshes = import_fbx(fbx)
        sources[fbx], folds[fbx] = meshes, fold_map(a)
        if q is None:
            q = a
        else:
            bpy.data.objects.remove(a)
    arm = build_armature(q)
    add_fp_twist(arm, q)
    bpy.data.objects.remove(q)
    for fbx, fold in folds.items():
        for b in list(fold):
            for t, src in FP_TWIST.items():
                if b.startswith(src + '_'):
                    fold[b] = f'{t}.{"L" if b.endswith("_l") else "R"}'
    out = {}
    for look, items in FP_PARTS.items():
        out[look] = []
        for fbx, name, budget in items:
            obj = copy_part(sources[fbx][name], f'fp_{look}_{name}', set(), folds[fbx])
            cut_to_arms(obj)
            obj['budget'] = budget
            out[look].append(obj)
    for d in sources.values():
        for o in d.values():
            bpy.data.objects.remove(o)
    return arm, out


def add_fp_twist(arm, q):
    """The first-person twist bones (FP_TWIST) on the shipped skeleton `arm`, at the source's twist bones, along the
    forearm, parented to LowerArm."""
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    for S in 'LR':
        lo = eb[f'LowerArm.{S}']
        d = (eb[f'Wrist.{S}'].head - lo.head).normalized()
        for t, src in FP_TWIST.items():
            b = eb.new(f'{t}.{S}')
            b.head = q.matrix_world @ q.data.bones[f'{src}_{S.lower()}'].head_local
            b.tail = b.head + d * 0.05
            b.roll = lo.roll
            b.parent = lo
    bpy.ops.object.mode_set(mode='OBJECT')


def cut_to_arms(obj):
    me = obj.data
    gname = {g.index: g.name for g in obj.vertex_groups}
    keep = []
    for v in me.vertices:
        w = sum(g.weight for g in v.groups if gname[g.group] in ARM_BONES)
        keep.append(w >= FP_ARM_MIN_WEIGHT)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    dead = [f for f in bm.faces if not all(keep[v.index] for v in f.verts)]
    bmesh.ops.delete(bm, geom=dead, context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bm.to_mesh(me)
    bm.free()
    for g in list(obj.vertex_groups):
        if g.name not in ARM_BONES:
            obj.vertex_groups.remove(g)


def fp_crops(parts):
    box = {}
    for objs in parts.values():
        for obj in objs:
            me = obj.data
            uv = np.zeros(len(me.loops) * 2, np.float32)
            me.uv_layers[0].data.foreach_get('uv', uv)
            uv = uv.reshape(-1, 2)
            mats = material_names(obj)
            for p in me.polygons:
                reg = FP_REGION.get(mats[p.material_index])
                if reg is None:
                    continue
                sel = uv[p.loop_start:p.loop_start + p.loop_total]
                lo, hi = sel.min(axis=0), sel.max(axis=0)
                b = box.get(reg)
                box[reg] = (np.minimum(b[0], lo), np.maximum(b[1], hi)) if b else (lo, hi)
    return {reg: (max(0.0, float(lo[0]) - 0.01), max(0.0, float(lo[1]) - 0.01), min(1.0, float(hi[0]) + 0.01),
                  min(1.0, float(hi[1]) + 0.01)) for reg, (lo, hi) in box.items()}


def grey_suit(rgb, s):
    lum = rgb[..., 0] * 0.3 + rgb[..., 1] * 0.55 + rgb[..., 2] * 0.15
    k = lum / max(float(lum.mean()), 1e-3)
    rgb[...] = np.clip(k * 0.75, 0, 1)[..., None]
    s[...] = 0.08


def matte(rgb, s):
    """Skin and cloth in a gun atlas: the gun material reads the surface value as gloss AND metalness, so keep it low."""
    s[...] = np.minimum(s, 0.1)


def dye_matte(rgb, s):
    dye_orange(rgb, s)
    matte(rgb, s)


def fp_regions(rects, crops):
    """Atlas regions (with their maps) for the arms: `rects` = {region: rect} from realistic.ARM_LAYOUTS."""
    out = []
    for reg, rect in rects.items():
        stem_c, stem_r = FP_TEXTURES[reg]
        post = dye_matte if reg == 'sleeve' else grey_suit if reg == 'ghostarms' else matte
        out.append(rl.Region(reg, rect, texture_maps(stem_c, stem_r), crop=crops.get(reg), post=post))
    return out


# Share of an arm part's triangles kept for the hands (they fill the bottom of the screen with the pistol and knife).
FP_HAND_SHARE = 0.8


def reduce_hands_first(obj, budget):
    """Reduces the hands (faces mostly weighted to the wrist and finger bones) and the rest of `obj` separately, giving
    the hands FP_HAND_SHARE of `budget`, then joins them again (the cut edges are open, so collapse keeps them and the
    halves weld back together)."""
    gname = {g.index: g.name for g in obj.vertex_groups}
    hand = [sum(g.weight for g in v.groups if gname[g.group] in HAND_BONES) > 0.5 for v in obj.data.vertices]
    if not any(hand) or all(hand):
        rl.decimate(obj, budget, keep_normals=False)
        return obj
    other = rl.duplicate(obj, obj.name + '_rest')
    for o, keep_hand in ((obj, True), (other, False)):
        bm = bmesh.new()
        bm.from_mesh(o.data)
        dead = [f for f in bm.faces if (2 * sum(hand[v.index] for v in f.verts) > len(f.verts)) != keep_hand]
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        bm.to_mesh(o.data)
        bm.free()
    rl.decimate(obj, int(budget * FP_HAND_SHARE), keep_normals=False)
    rl.decimate(other, budget - int(budget * FP_HAND_SHARE), keep_normals=False)
    name = obj.name
    obj = rl.join([obj, other], name)
    rl.weld(obj, 1e-5)
    return obj


def fp_arms(look, parts, atlas, material):
    """One arms object for `look`: parts reduced, UVs into `atlas`, vertex colours, `material`."""
    done = []
    for obj in parts:
        reduce_hands_first(obj, obj['budget'])
        smooth_normals(obj)
        atlas.remap(obj, material_region={m.name: FP_REGION.get(m.name.split('.')[0], 'arms')
                                          for m in obj.data.materials if m})
        if look == 'ghost':
            me = obj.data
            gname = {g.index: g.name for g in obj.vertex_groups}
            hand = [sum(g.weight for g in v.groups if gname[g.group] in HAND_BONES) > 0.5 for v in me.vertices]
            rl.set_colour(obj, GHOST_SLEEVE)
            attr = me.color_attributes['Col']
            for lp in me.loops:
                if hand[lp.vertex_index]:
                    attr.data[lp.index].color = GHOST_GLOVE
        else:
            rl.set_colour(obj, (1, 1, 1, 0))
        done.append(obj)
    obj = rl.join(done, f'arms_{look}')
    rl.single_material(obj, material)
    return obj


# ---------------------------------------------------------------------------------------------

def args():
    rest = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    tiers = ['high', 'low']
    if '--tier' in rest:
        tiers = [rest[rest.index('--tier') + 1]]
    return tiers, '--no-atlas' in rest, '--static' in rest


def main():
    tiers, no_atlas, static = args()
    import clips as cl
    for tier in tiers:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scene = bpy.context.scene
        scene.render.fps = FPS
        sources, folds = {}, {}
        q = None
        for fbx in ('SKM_Character.fbx', 'SKM_Body_Full.fbx'):
            a, meshes = import_fbx(fbx)
            sources[fbx], folds[fbx] = meshes, fold_map(a)
            if fbx == 'SKM_Character.fbx':
                q = a
            else:
                bpy.data.objects.remove(a)
        crops = uv_crops([sources['SKM_Character.fbx'][n] for n, _ in PARTS['defender']['SKM_Character.fbx']])
        atlas = make_atlas(crops)
        arm = build_armature(q)
        bpy.data.objects.remove(q)
        looks = [build_look(look, tier, sources, folds, atlas) for look in ('defender', 'ghost')]
        for fbx in sources.values():
            for o in fbx.values():
                bpy.data.objects.remove(o)
        for o in looks:
            o.parent = arm
            m = o.modifiers.new('Armature', 'ARMATURE')
            m.object = arm
        cl.build(arm, looks, static)
        cl.export(arm, looks, os.path.join(OUT_DIR, f'character_{tier}.glb'))
        if not no_atlas and tier == tiers[0]:
            # Cloth normals are fine-grained noise that WebP spends many bytes on; a lower quality is not visible at
            # character distances and keeps the Low download near budget.
            rl.WEBP_QUALITY['normal'] = CHARACTER_NORMAL_QUALITY
            atlas.write(sizes=rl.ATLAS_SIZES)


if __name__ == '__main__':
    main()
