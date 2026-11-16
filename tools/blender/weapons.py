"""
Stillblade weapon pipeline: CC0 source models -> client/public/models/weapons.glb

    "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup \
        --python tools/blender/weapons.py [-- <source.glb> <out.glb>]

Source: "Character Soldier" by Quaternius (CC0 1.0, poly.pizza model PpLF4rt4ah), already downloaded for the
character work into tools/blender/source-art/characters/quaternius-soldier/CharacterSoldier.glb (see
client/public/models/CREDITS.md). It carries a set of hand-held props; three are used:
  - "SMG"     : compact SMG with an integral suppressor (1,006 triangles, 4 flat-colour materials): the rifle.
                The suppressor is every face with the "Black" material (nine parts, nothing else uses it); it is
                split off into its own node, and a short 12-sided barrel stub is added where it met the receiver
                (inside the suppressor's collar, so it is hidden when the suppressor is on).
  - "Pistol"  : semi-automatic pistol (990 triangles, 3 flat-colour materials); it has no suppressor, so a
                12-sided cylinder is generated at the muzzle as its own node
  - "Knife_1" : combat knife with a serrated spine (687 triangles, 4 flat-colour materials)

What it does:
  1. Imports the source GLB with the armature in its rest pose and bakes each prop's world transform.
  2. Re-orients each prop into the shipped axis convention (below), puts the origin at the grip, and scales it
     to real-world size (gun 0.66 m including the suppressor, pistol 0.20 m plus a 0.11 m suppressor,
     knife 0.30 m).
  3. Bakes the material colours into a vertex-colour attribute (a dark tactical palette), welds, decimates
     the knife to <= 400 triangles, removes UVs, and gives both meshes ONE shared vertex-colour material.
  4. Adds, as children of "gun" / "pistol": the suppressor mesh "gun_suppressor" / "pistol_suppressor" (vertices
     in the gun's own frame, identity local transform), the empty "gun_muzzle" / "pistol_muzzle" at the centre of
     the suppressor's front face, and the empty "gun_muzzle_bare" / "pistol_muzzle_bare" at the centre of the bare
     barrel's front face.
  5. Exports a GLB with nine nodes: gun (mesh) with gun_suppressor (mesh), gun_muzzle and gun_muzzle_bare (empties);
     pistol (mesh) with pistol_suppressor (mesh), pistol_muzzle and pistol_muzzle_bare (empties); knife (mesh).

Suppressor option (rooms choose it; client/src/weapons.ts): the client draws a gun either bare (the gun mesh alone,
tracers and flash from *_muzzle_bare) or suppressed (gun + its suppressor, merged into ONE mesh at load so a gun is
still one draw call, tracers and flash from *_muzzle). Gun body plus suppressor is exactly the earlier single mesh.

Axis convention (glTF / engine space, for both meshes), origin = centre of the hand's grip:
  -Z forward (gun: muzzle direction; knife: blade tip direction)
  +Y up      (gun: sights side, magazine and grip point to -Y; knife: spine side, cutting edge to -Y)
  +X right
The gun and pistol origins are the middle of the grip (where the fist closes), so both sit in the character's
one "socket_gun" with an identity transform; the knife origin is the middle of the handle. client/src/weapons.ts and tools/blender/characters.py (hand sockets) both rely on this.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
DEFAULT_SRC = os.path.join(HERE, 'source-art', 'characters', 'quaternius-soldier', 'CharacterSoldier.glb')
DEFAULT_OUT = os.path.join(ROOT, 'client', 'public', 'models', 'weapons.glb')

GUN_LENGTH = 0.66
PISTOL_LENGTH = 0.20
PISTOL_SUPPRESSOR = (0.11, 0.015)            # length, radius (m)
GUN_BARREL_STUB = (0.045, 0.0105)            # bare SMG barrel: length, radius (m)
KNIFE_LENGTH = 0.30
KNIFE_MAX_TRIS = 400

# Linear RGB per source material (matched by name prefix).
GUN_PALETTE = {
    'Black': (0.018, 0.018, 0.02, 1.0),     # suppressor, grip panels
    'DarkGrey': (0.045, 0.048, 0.052, 1.0),  # receiver
    'Grey2': (0.13, 0.135, 0.14, 1.0),       # small parts
    'Grey': (0.075, 0.078, 0.082, 1.0),      # magazine, trim
}
PISTOL_PALETTE = {
    'Black': (0.018, 0.018, 0.02, 1.0),     # added suppressor
    'DarkGrey': (0.045, 0.048, 0.052, 1.0),  # frame
    'Grey': (0.075, 0.078, 0.082, 1.0),      # slide
    'Wood': (0.03, 0.03, 0.032, 1.0),        # grip panels (black polymer, not wood)
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
#   Pistol: same axes as the SMG (muzzle at x = -1.385, sights toward -Y); its grip is the "Wood" material,
#   hanging toward +Y from the frame (y = 0.0) to y = 0.26.
PISTOL_AXES = (Vector((-1, 0, 0)), Vector((0, -1, 0)))
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


def front_face(obj):
    """Forward-most face of a mesh in the shipped frame: (centre x, front y, centre z, height)."""
    pts = [v.co for v in obj.data.vertices]
    ymax = max(p.y for p in pts)
    front = [p for p in pts if p.y > ymax - 0.004]
    lo, hi = min(p.z for p in front), max(p.z for p in front)
    return (min(p.x for p in front) + max(p.x for p in front)) / 2, ymax, (lo + hi) / 2, hi - lo


def cylinder(name, centre_x, back_y, centre_z, length, radius, material):
    """A 12-sided capped cylinder along +Y (shipped frame) from back_y to back_y + length, as its own object."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=12, radius1=radius, radius2=radius, depth=length)
    # The cone is built along Z: turn it to +Y and move it into place.
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.radians(-90), 3, 'X'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(centre_x, back_y + length / 2, centre_z))
    bm.to_mesh(me)
    bm.free()
    me.materials.append(bpy.data.materials.new(material))
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def join_into(obj, part):
    for o in bpy.context.scene.objects:
        o.select_set(o in (obj, part))
    bpy.context.view_layer.objects.active = obj
    with bpy.context.temp_override(active_object=obj, selected_editable_objects=[obj, part]):
        bpy.ops.object.join()


def make_suppressor(obj, length, radius):
    """
    A 12-sided cylinder in front of `obj` (shipped frame, Y forward), centred on the forward-most face (the barrel
    tip), with a material named "Black" (baked like the others). Returned as its own object, not joined.
    """
    mx, ymax, bore_z, _ = front_face(obj)
    sup = cylinder('suppressor', mx, ymax - 0.004, bore_z, length, radius, 'Black')
    log('pistol suppressor radius', round(radius, 4), 'length', length, 'bore z', round(bore_z, 4))
    return sup


def split_off(obj, prefix, name):
    """Moves every face whose material name starts with `prefix` from `obj` into a new object (same frame)."""
    names = [m.name if m else '' for m in obj.data.materials]
    part = bpy.data.objects.new(name, obj.data.copy())
    bpy.context.scene.collection.objects.link(part)
    for o, keep in ((obj, False), (part, True)):
        bm = bmesh.new()
        bm.from_mesh(o.data)
        dead = [f for f in bm.faces if names[f.material_index].startswith(prefix) != keep]
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        loose = [v for v in bm.verts if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
        bm.to_mesh(o.data)
        bm.free()
        o.data.update()
    log('split', name, 'off', obj.name, ':', tris(part.data), 'tris moved,', tris(obj.data), 'left')
    return part


def add_empty(parent, name, loc):
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    e.parent = parent
    e.location = loc
    return e


def main():
    src, out = args()
    log('source', src)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()

    gun = isolate('SMG')
    pistol = isolate('Pistol')
    knife = isolate('Knife_1')
    for o in list(bpy.data.objects):
        if o not in (gun, pistol, knife):
            bpy.data.objects.remove(o)
    # Muzzle points (shipped frame), found below: suppressed (suppressor front) and bare (barrel front).
    muzzles = {}

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
    # The integral suppressor (the length above, and so the scale, still includes it: suppressed is unchanged).
    gun_sup = split_off(gun, 'Black', 'gun_suppressor')
    sp = [v.co for v in gun_sup.data.vertices]
    bore_x = (min(p.x for p in sp) + max(p.x for p in sp)) / 2
    bore_z = (min(p.z for p in sp) + max(p.z for p in sp)) / 2
    mx, ymax, mz, _ = front_face(gun_sup)
    muzzles['gun_muzzle'] = (mx, ymax, mz)
    # Bare barrel: a short stub from the receiver's front on the suppressor's axis.
    front = max(v.co.y for v in gun.data.vertices)
    stub_len, stub_r = GUN_BARREL_STUB
    join_into(gun, cylinder('barrel', bore_x, front - 0.004, bore_z, stub_len, stub_r, 'Grey2'))
    muzzles['gun_muzzle_bare'] = (bore_x, front - 0.004 + stub_len, bore_z)
    log('gun: receiver front', round(front, 4), 'bore', round(bore_x, 4), round(bore_z, 4),
        'suppressor front', round(ymax, 4))

    # --- Pistol ---------------------------------------------------------------------------------
    me = pistol.data
    names = [m.name if m else '' for m in me.materials]
    idx = sorted({vi for p in me.polygons if names[p.material_index].startswith('Wood') for vi in p.vertices})
    grip_pts = [me.vertices[i].co.copy() for i in idx]
    pts = [v.co.copy() for v in me.vertices]
    fwd, up = PISTOL_AXES
    ups = [p.dot(up) for p in grip_pts]
    top, bottom = max(ups), min(ups)
    # A third of the way down the grip, centred in the grip's cross-section at that height. The grip is a
    # few long quads (no vertices midway) and raked back, so interpolate between its top and bottom ends.
    span = top - bottom
    h = top - span * 0.35
    ends = []
    for lo_, hi_ in ((top - span * 0.25, top), (bottom, bottom + span * 0.25)):
        e = [p.x for p in grip_pts if lo_ <= p.dot(up) <= hi_]
        ends.append((min(e) + max(e)) / 2)
    # Sideways, centre on the slide (front half), not the grip panels: they sit off to one side.
    xmin = min(p.x for p in pts)
    slide = [p for p in pts if p.x < xmin + (max(p.x for p in pts) - xmin) * 0.4]
    grip = Vector((ends[0] + (ends[1] - ends[0]) * 0.35, -h,
                   (min(p.z for p in slide) + max(p.z for p in slide)) / 2))
    length = max(p.dot(fwd) for p in pts) - min(p.dot(fwd) for p in pts)
    s = PISTOL_LENGTH / length
    pistol.data.transform(Matrix.Scale(s, 4) @ basis(fwd, up) @ Matrix.Translation(-grip))
    # The prop is rolled in the source (its grip leans to one side under the slide, which reads as a canted gun
    # when aimed): turn it about the barrel axis so the grip's bottom sits straight under the slide's centre,
    # then put the grip back on the origin sideways.
    pts = [v.co for v in pistol.data.vertices]
    zs = [p.z for p in pts]
    ztop, zbot = max(zs), min(zs)
    slide = [p for p in pts if p.z > ztop - 0.02 and p.y > 0.06]
    foot = [p for p in pts if p.z < zbot + 0.012]
    xs, zs_ = (min(p.x for p in slide) + max(p.x for p in slide)) / 2, sum(p.z for p in slide) / len(slide)
    xb, zb = (min(p.x for p in foot) + max(p.x for p in foot)) / 2, sum(p.z for p in foot) / len(foot)
    roll = math.atan2(xb - xs, zs_ - zb)
    rot = Matrix.Rotation(roll, 4, 'Y')
    pistol.data.transform(rot)
    a, b = rot @ Vector((xs, 0, zs_)), rot @ Vector((xb, 0, zb))
    x0 = a.x + (b.x - a.x) * (0 - a.z) / (b.z - a.z)
    pistol.data.transform(Matrix.Translation((-x0, 0, 0)))
    pistol.data.update()
    log('pistol: roll corrected by', round(math.degrees(roll), 2), 'deg; slide/foot x after', round(a.x - x0, 4), round(b.x - x0, 4))
    log('pistol: source length', round(length, 4), 'scale', round(s, 5), 'grip (source)',
        tuple(round(c, 3) for c in grip), 'grip top/bottom', round(top, 3), round(bottom, 3))
    mx, ymax, mz, _ = front_face(pistol)
    muzzles['pistol_muzzle_bare'] = (mx, ymax, mz)
    pistol_sup = make_suppressor(pistol, *PISTOL_SUPPRESSOR)
    pistol_sup.name = 'pistol_suppressor'
    mx, ymax, mz, _ = front_face(pistol_sup)
    muzzles['pistol_muzzle'] = (mx, ymax, mz)

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
    bake_colours(gun_sup, GUN_PALETTE)
    bake_colours(pistol, PISTOL_PALETTE)
    bake_colours(pistol_sup, PISTOL_PALETTE)
    bake_colours(knife, KNIFE_PALETTE)
    for o in (gun, gun_sup, pistol, pistol_sup, knife):
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
    for o, name in ((gun, 'gun'), (gun_sup, 'gun_suppressor'), (pistol, 'pistol'), (pistol_sup, 'pistol_suppressor'),
                    (knife, 'knife')):
        o.name = name
        o.data.name = name
        o.data.materials.append(mat)
        o.data.set_sharp_from_angle(angle=math.radians(40))

    # --- Suppressors as children; muzzles: suppressor front and bare barrel front -----------------
    # Both meshes are in the gun's own frame and the gun object sits at the origin, so the child keeps an
    # identity local transform (the client merges the two meshes for the suppressed look).
    gun_sup.parent = gun
    pistol_sup.parent = pistol
    empties = [add_empty(gun, n, muzzles[n]) for n in ('gun_muzzle', 'gun_muzzle_bare')]
    empties += [add_empty(pistol, n, muzzles[n]) for n in ('pistol_muzzle', 'pistol_muzzle_bare')]

    # --- Report ---------------------------------------------------------------------------------
    for o in (gun, gun_sup, pistol, pistol_sup, knife):
        p = [v.co for v in o.data.vertices]
        lo = Vector((min(v.x for v in p), min(v.y for v in p), min(v.z for v in p)))
        hi = Vector((max(v.x for v in p), max(v.y for v in p), max(v.z for v in p)))
        log(o.name, 'tris', tris(o.data), 'verts', len(o.data.vertices),
            'bounds (Blender X right, Y forward, Z up) lo', tuple(round(c, 3) for c in lo), 'hi', tuple(round(c, 3) for c in hi))
    for m in empties:
        x, y, z = m.location
        log(m.name, '(Blender)', tuple(round(c, 4) for c in m.location), '-> glTF',
            (round(x, 4), round(z, 4), round(-y, 4)))
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
