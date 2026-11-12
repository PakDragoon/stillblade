"""
Stillblade weapon pipeline: CC0 source models -> client/public/models/weapons.glb

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup \
        --python tools/blender/weapons.py [-- <source.glb> <out.glb>]

Source: "Character Soldier" by Quaternius (CC0 1.0, poly.pizza model PpLF4rt4ah), already downloaded for the
character work into tools/blender/source-art/characters/quaternius-soldier/CharacterSoldier.glb (see
client/public/models/CREDITS.md). It carries a set of hand-held props; two are used:
  - "SMG"     : compact SMG with an integral suppressor (1,006 triangles, 4 flat-colour materials)
  - "Knife_1" : combat knife with a serrated spine (687 triangles, 4 flat-colour materials)

What it does:
  1. Imports the source GLB with the armature in its rest pose and bakes each prop's world transform.
  2. Re-orients each prop into the shipped axis convention (below), puts the origin at the grip, and scales it
     to real-world size (gun 0.66 m including the suppressor, knife 0.30 m).
  3. Bakes the material colours into a vertex-colour attribute (a dark tactical palette), welds, decimates
     the knife to <= 400 triangles, removes UVs, and gives both meshes ONE shared vertex-colour material.
  4. Adds an empty "gun_muzzle" (child of "gun") at the centre of the suppressor's front face.
  5. Exports a GLB with three nodes: gun (mesh), gun_muzzle (empty), knife (mesh).

Axis convention (glTF / engine space, for both meshes), origin = centre of the hand's grip:
  -Z forward (gun: muzzle direction; knife: blade tip direction)
  +Y up      (gun: sights side, magazine and grip point to -Y; knife: spine side, cutting edge to -Y)
  +X right
The gun origin is the middle of the pistol grip (where the fist closes); the knife origin is the middle of the
handle. client/src/weapons.ts and tools/blender/characters.py (hand sockets) both rely on this.
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
DEFAULT_SRC = os.path.join(HERE, 'source-art', 'characters', 'quaternius-soldier', 'CharacterSoldier.glb')
DEFAULT_OUT = os.path.join(ROOT, 'client', 'public', 'models', 'weapons.glb')

GUN_LENGTH = 0.66
KNIFE_LENGTH = 0.30
KNIFE_MAX_TRIS = 400

# Linear RGB per source material (matched by name prefix).
GUN_PALETTE = {
    'Black': (0.018, 0.018, 0.02, 1.0),     # suppressor, grip panels
    'DarkGrey': (0.045, 0.048, 0.052, 1.0),  # receiver
    'Grey2': (0.13, 0.135, 0.14, 1.0),       # small parts
    'Grey': (0.075, 0.078, 0.082, 1.0),      # magazine, trim
}
KNIFE_PALETTE = {
    'LightGrey': (0.42, 0.43, 0.45, 1.0),    # blade
    'Grey': (0.20, 0.21, 0.23, 1.0),         # guard, pommel
    'DarkWood': (0.022, 0.022, 0.02, 1.0),   # grip wrap
    'Wood': (0.05, 0.05, 0.045, 1.0),        # handle
}

# Source-space landmarks (CharacterSoldier.glb, armature in rest pose, Blender world coordinates), measured
# once with a slice profile of each prop (see the report printed below to re-check them):
#   SMG: barrel along -X (muzzle at x = -1.733), sights toward -Y, magazine and grip toward +Y.
#        Pistol grip: x in [-0.78, -0.64]; its middle, a third of the way down, is the grip origin.
#   Knife_1: blade along -Y (tip at y = -0.965), handle y in [-0.03, 0.444], spine toward -X.
GUN_AXES = (Vector((-1, 0, 0)), Vector((0, -1, 0)))     # (forward, up) in source space
GUN_GRIP_X = (-0.78, -0.64)
KNIFE_AXES = (Vector((0, -1, 0)), Vector((-1, 0, 0)))
KNIFE_HANDLE_Y = (-0.03, 0.444)


def log(*a):
    print('[weapons]', *a, flush=True)


def args():
    if '--' in sys.argv:
        rest = sys.argv[sys.argv.index('--') + 1:]
        if len(rest) >= 2:
            return rest[0], rest[1]
    return DEFAULT_SRC, DEFAULT_OUT


def tris(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def basis(forward, up):
    """Matrix whose rows map source vectors to (right, forward, up) = Blender (X, Y, Z)."""
    f = forward.normalized()
    u = (up - f * up.dot(f)).normalized()
    r = f.cross(u)
    return Matrix((r, f, u)).to_4x4()


def bake_colours(obj, palette):
    me = obj.data
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    names = [s.material.name if s.material else '' for s in obj.material_slots]
    for poly in me.polygons:
        name = names[poly.material_index] if poly.material_index < len(names) else ''
        key = max((k for k in palette if name.startswith(k)), key=len, default=None)
        col = palette[key] if key else (1, 0, 1, 1)
        if key is None:
            log('WARNING unknown material', name)
        for li in poly.loop_indices:
            attr.data[li].color = col
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find('Col')
    me.materials.clear()
    # The importer stores custom split normals; drop them so the sharp-edge angle below decides shading.
    if me.has_custom_normals:
        with bpy.context.temp_override(object=obj, active_object=obj):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
    for uv in list(me.uv_layers):
        me.uv_layers.remove(uv)


def isolate(name):
    """Copy of a prop with its world transform baked in, unparented."""
    src = bpy.data.objects[name]
    me = src.data.copy()
    me.transform(src.matrix_world)
    obj = bpy.data.objects.new(name + '_baked', me)
    bpy.context.scene.collection.objects.link(obj)
    # The mesh copy keeps its material list, so colours can still be baked by material name.
    return obj


def weld(obj, dist=1e-5):
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.scene.objects:
        o.select_set(o is obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=dist)
    bpy.ops.object.mode_set(mode='OBJECT')


def decimate(obj, max_tris):
    n = tris(obj.data)
    if n <= max_tris:
        return
    # Planar dissolve first (removes coplanar splits for free), then collapse if still over budget.
    m = obj.modifiers.new('Planar', 'DECIMATE')
    m.decimate_type = 'DISSOLVE'
    m.angle_limit = math.radians(2.0)
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=m.name)
    tri = obj.modifiers.new('Tri', 'TRIANGULATE')
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=tri.name)
    n = tris(obj.data)
    if n > max_tris:
        m = obj.modifiers.new('Collapse', 'DECIMATE')
        m.ratio = (max_tris - 2) / n
        m.use_collapse_triangulate = True
        with bpy.context.temp_override(object=obj, active_object=obj):
            bpy.ops.object.modifier_apply(modifier=m.name)


def main():
    src, out = args()
    log('source', src)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()

    gun = isolate('SMG')
    knife = isolate('Knife_1')
    for o in list(bpy.data.objects):
        if o not in (gun, knife):
            bpy.data.objects.remove(o)

    # --- Gun --------------------------------------------------------------------------------------
    pts = [v.co.copy() for v in gun.data.vertices]
    grip_pts = [p for p in pts if GUN_GRIP_X[0] <= p.x <= GUN_GRIP_X[1]]
    # Receiver bottom = lowest sights-side extent of the grip slice is not needed: take the grip's own span
    # along the up axis and sit the origin a third of the way down from its top (where the fist closes).
    fwd, up = GUN_AXES
    ups = [-p.y for p in grip_pts]                      # height along "up" (= -Y in source)
    top, bottom = max(ups), min(ups)
    receiver_bottom = sorted(ups)[len(ups) // 2]          # median: the receiver body dominates the slice
    grip_y = -(receiver_bottom - (receiver_bottom - bottom) * 0.4)
    grip = Vector(((GUN_GRIP_X[0] + GUN_GRIP_X[1]) / 2, grip_y, sum(p.z for p in pts) / len(pts)))
    length = max(p.dot(fwd) for p in pts) - min(p.dot(fwd) for p in pts)
    s = GUN_LENGTH / length
    gun.data.transform(Matrix.Scale(s, 4) @ basis(fwd, up) @ Matrix.Translation(-grip))
    gun.data.update()
    log('gun: source length', round(length, 4), 'scale', round(s, 5), 'grip (source)', tuple(round(c, 3) for c in grip),
        'grip top/bottom/receiver', round(top, 3), round(bottom, 3), round(receiver_bottom, 3))

    # --- Knife ----------------------------------------------------------------------------------
    pts = [v.co.copy() for v in knife.data.vertices]
    fwd, up = KNIFE_AXES
    handle = [p for p in pts if KNIFE_HANDLE_Y[0] <= p.y <= KNIFE_HANDLE_Y[1]]
    hc = Vector((sum(p.x for p in handle) / len(handle), (KNIFE_HANDLE_Y[0] + KNIFE_HANDLE_Y[1]) / 2,
                 sum(p.z for p in handle) / len(handle)))
    # Centre of the handle cross-section (bounding box, not vertex mean).
    hc.x = (min(p.x for p in handle) + max(p.x for p in handle)) / 2
    hc.z = (min(p.z for p in handle) + max(p.z for p in handle)) / 2
    length = max(p.dot(fwd) for p in pts) - min(p.dot(fwd) for p in pts)
    s = KNIFE_LENGTH / length
    knife.data.transform(Matrix.Scale(s, 4) @ basis(fwd, up) @ Matrix.Translation(-hc))
    knife.data.update()
    log('knife: source length', round(length, 4), 'scale', round(s, 5), 'handle centre (source)', tuple(round(c, 3) for c in hc))

    # --- Colours, weld, budget, one material ---------------------------------------------------
    bake_colours(gun, GUN_PALETTE)
    bake_colours(knife, KNIFE_PALETTE)
    for o in (gun, knife):
        weld(o)
    decimate(knife, KNIFE_MAX_TRIS)

    mat = bpy.data.materials.new('weapon')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    ca = nt.nodes.new('ShaderNodeVertexColor')
    ca.layer_name = 'Col'
    nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.55
    bsdf.inputs['Metallic'].default_value = 0.0
    for o, name in ((gun, 'gun'), (knife, 'knife')):
        o.name = name
        o.data.name = name
        o.data.materials.append(mat)
        o.data.set_sharp_from_angle(angle=math.radians(40))

    # --- Muzzle: centre of the front face of the suppressor ------------------------------------
    pts = [v.co for v in gun.data.vertices]
    ymax = max(p.y for p in pts)
    front = [p for p in pts if p.y > ymax - 0.004]
    mx = (min(p.x for p in front) + max(p.x for p in front)) / 2
    mz = (min(p.z for p in front) + max(p.z for p in front)) / 2
    muzzle = bpy.data.objects.new('gun_muzzle', None)
    bpy.context.scene.collection.objects.link(muzzle)
    muzzle.parent = gun
    muzzle.location = (mx, ymax, mz)

    # --- Report ---------------------------------------------------------------------------------
    for o in (gun, knife):
        p = [v.co for v in o.data.vertices]
        lo = Vector((min(v.x for v in p), min(v.y for v in p), min(v.z for v in p)))
        hi = Vector((max(v.x for v in p), max(v.y for v in p), max(v.z for v in p)))
        log(o.name, 'tris', tris(o.data), 'verts', len(o.data.vertices),
            'bounds (Blender X right, Y forward, Z up) lo', tuple(round(c, 3) for c in lo), 'hi', tuple(round(c, 3) for c in hi))
    log('gun_muzzle (Blender)', tuple(round(c, 4) for c in muzzle.location),
        '-> glTF', (round(mx, 4), round(mz, 4), round(-ymax, 4)))
    # Gun landmarks for the support hand (characters.py): front of the magazine, under the receiver.
    gp = [v.co for v in gun.data.vertices]
    mag = [v for v in gp if v.z < -0.03 and v.y > 0.05]
    if mag:
        log('magazine span forward', round(min(v.y for v in mag), 3), round(max(v.y for v in mag), 3),
            'lowest', round(min(v.z for v in mag), 3))
    rec = [v for v in gp if v.z > -0.01]
    log('receiver top', round(max(v.z for v in gp), 3), 'rear', round(min(v.y for v in gp), 3))

    # --- Export ---------------------------------------------------------------------------------
    for o in bpy.data.objects:
        o.select_set(True)
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
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=False,
        export_cameras=False,
        export_lights=False,
    )
    log('wrote', out, os.path.getsize(out), 'bytes')


main()
