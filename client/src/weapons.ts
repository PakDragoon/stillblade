import * as pc from 'playcanvas';
import { SIGHTS, SIGHT_COUNT, SIGHT_IRON, type WeaponId } from '@shared/weapons';

/**
 * Weapon meshes: client/public/models/weapons.glb, built by tools/blender/weapons.py from Quaternius's CC0
 * "Character Soldier" props (an SMG with its integral suppressor split off, a pistol with a generated one, and a
 * combat knife). One vertex-coloured mesh each, one shared material.
 *
 * Node layout and axis convention (engine space, metres, origin at the centre of the hand's grip):
 *   gun        : -Z = muzzle direction, +Y = sights up (magazine and grip hang toward -Y), +X = right.
 *                Origin = middle of the pistol grip. 0.39 m long bare, 0.66 m with the suppressor.
 *   gun_suppressor     : child mesh of gun, in gun's own frame (identity local transform).
 *   gun_muzzle         : child of gun, centre of the suppressor's front face.
 *   gun_muzzle_bare    : child of gun, centre of the bare barrel's front face.
 *   gun_sight_reddot / gun_sight_scope2x : child meshes of gun in its own frame (package M): the optional rifle
 *                sights, one per SIGHTS entry but iron (shared/weapons.ts), named gun_sight_<SightId>.
 *   pistol     : same axes as gun; origin = middle of the grip. 0.17 m bare, 0.28 m with the suppressor.
 *   pistol_suppressor / pistol_muzzle / pistol_muzzle_bare : as for gun.
 *   knife      : -Z = blade tip, +Y = spine (cutting edge toward -Y). Origin = middle of the handle. 0.30 m.
 * The character GLB carries matching "socket_gun" / "socket_knife" nodes on the right wrist bone, so an
 * instance parented to a socket with an identity local transform sits in the hand (both guns share socket_gun).
 *
 * Suppressors (the room option): a gun instance draws either its bare mesh or one mesh made at load from the bare
 * mesh plus its suppressor (`mergedMesh`), so a gun is always ONE draw call; `setSuppressed` swaps the mesh and
 * which muzzle node tracers and flashes start from. Two muzzle nodes per gun, rather than one offset in code, so
 * the script that builds the model is the one place that knows where each variant's muzzle is.
 *
 * Sights (package M) work the same way: at load every suppressor and sight combination of a gun becomes one mesh
 * (the rifle: 2 x 3), and `setSight` picks it, so a player's gun is still ONE draw call whatever is mounted. A gun
 * with no `<gun>_sight_<id>` node (the pistol, or an older model file) draws its plain mesh for that sight.
 */

export type WeaponName = 'gun' | 'pistol' | 'knife';
type GunName = Exclude<WeaponName, 'knife'>;

/** Mesh node for each defender gun in the table (shared/weapons.ts); the rifle's node is still "gun". */
export const WEAPON_MESH: Record<WeaponId, GunName> = { rifle: 'gun', pistol: 'pistol' };
const GUN_NAMES: readonly GunName[] = ['gun', 'pistol'];

export interface WeaponModel {
    asset: pc.Asset;
    /**
     * Per gun: one mesh per look, built once at load, indexed by `lookIndex(suppressed, sight)`: the bare gun (the
     * model's own mesh), and the gun with its suppressor and/or a mounted sight merged in.
     */
    readonly looks: Map<GunName, pc.Mesh[]>;
}

/** Index into `WeaponModel.looks` of a gun's look with or without its suppressor and with sight `sight` (SIGHTS). */
export const lookIndex = (suppressed: boolean, sight: number): number =>
    (suppressed ? SIGHT_COUNT : 0) + (sight >= 0 && sight < SIGHT_COUNT ? sight : SIGHT_IRON);

export interface WeaponInstance {
    entity: pc.Entity;
    meshInstance: pc.MeshInstance;
    /** Guns only: the muzzle point of the variant in use (suppressor front or bare barrel). */
    muzzle: pc.GraphNode | null;
    /** Guns only: switch between the bare and the suppressed look (mesh and muzzle); no-op for the knife. */
    setSuppressed(on: boolean): void;
    /** Guns only: the sight mounted (index into SIGHTS); a gun that takes none ignores it. No-op for the knife. */
    setSight(sight: number): void;
}

/** Reads one vertex attribute of `mesh` as floats (normalised integer formats mapped to 0..1). */
function readStream(mesh: pc.Mesh, semantic: string): { data: number[]; components: number } | null {
    const vb = mesh.vertexBuffer;
    const el = vb?.getFormat().elements.find(e => e.name === semantic);
    if (!el) return null;
    const data: number[] = [];
    mesh.getVertexStream(semantic, data);
    if (el.normalize) {
        const max = el.dataType === pc.TYPE_UINT8 ? 255 : el.dataType === pc.TYPE_UINT16 ? 65535 : 1;
        for (let i = 0; i < data.length; i++) data[i] /= max;
    }
    return { data, components: el.numComponents };
}

/** A mesh and its transform relative to the gun (null: already in the gun's frame). */
interface MeshPart { mesh: pc.Mesh; toGun: pc.Mat4 | null }

/**
 * One mesh from `parts` (each moved by its transform relative to the gun: the suppressor's, a sight's): positions,
 * normals and vertex colours, indexed triangles. Used at load only.
 */
function mergedMesh(device: pc.GraphicsDevice, parts: readonly MeshPart[]): pc.Mesh {
    const pos: number[] = [], nrm: number[] = [], col: number[] = [], idx: number[] = [];
    const p = new pc.Vec3(), n = new pc.Vec3();
    const normalMat = new pc.Mat3();
    let base = 0;
    for (const { mesh: m, toGun: xf } of parts) {
        if (xf) normalMat.setFromMat4(xf);
        const ps = readStream(m, pc.SEMANTIC_POSITION)!;
        const ns = readStream(m, pc.SEMANTIC_NORMAL);
        const cs = readStream(m, pc.SEMANTIC_COLOR);
        const count = ps.data.length / ps.components;
        for (let i = 0; i < count; i++) {
            p.set(ps.data[i * 3], ps.data[i * 3 + 1], ps.data[i * 3 + 2]);
            if (xf) xf.transformPoint(p, p);
            pos.push(p.x, p.y, p.z);
            if (ns) {
                n.set(ns.data[i * 3], ns.data[i * 3 + 1], ns.data[i * 3 + 2]);
                if (xf) normalMat.transformVector(n, n).normalize();
                nrm.push(n.x, n.y, n.z);
            } else nrm.push(0, 1, 0);
            if (cs) {
                const c = cs.components;
                col.push(cs.data[i * c], cs.data[i * c + 1], cs.data[i * c + 2], c > 3 ? cs.data[i * c + 3] : 1);
            } else col.push(1, 1, 1, 1);
        }
        const ind: number[] = [];
        m.getIndices(ind);
        for (let i = 0; i < ind.length; i++) idx.push(ind[i] + base);
        base += count;
    }
    const mesh = new pc.Mesh(device);
    mesh.setPositions(pos);
    mesh.setNormals(nrm);
    mesh.setColors(col);
    mesh.setIndices(idx);
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    return mesh;
}

const meshOf = (e: pc.Entity | null): pc.Mesh | null => e?.render?.meshInstances[0]?.mesh ?? null;

/** Loads the shared weapons GLB. Rejects if it fails to load or lacks a required node. */
export function loadWeaponModel(app: pc.Application, url: string, filename = 'weapons.glb'): Promise<WeaponModel> {
    return new Promise((resolve, reject) => {
        const asset = new pc.Asset('weapons', 'container', { url, filename });
        asset.once('load', () => {
            const res = asset.resource as pc.ContainerResource | undefined;
            if (!res) { reject(new Error('weapon model loaded without a resource')); return; }
            // Check the layout once, and build every look's mesh, on a throwaway instance.
            const probe = res.instantiateRenderEntity();
            let ok = !!(probe.findByName('knife') as pc.Entity | null)?.render;
            const looks = new Map<GunName, pc.Mesh[]>();
            for (const name of GUN_NAMES) {
                const gun = probe.findByName(name) as pc.Entity | null;
                const sup = probe.findByName(`${name}_suppressor`) as pc.Entity | null;
                const body = meshOf(gun), supMesh = meshOf(sup);
                ok = ok && !!body && !!supMesh && !!probe.findByName(`${name}_muzzle`) && !!probe.findByName(`${name}_muzzle_bare`);
                if (!ok || !body || !supMesh || !gun || !sup) continue;
                const toGun = (e: pc.Entity): pc.Mat4 => new pc.Mat4().copy(gun.getWorldTransform()).invert().mul(e.getWorldTransform());
                const supPart: MeshPart = { mesh: supMesh, toGun: toGun(sup) };
                // The optional sights this gun's model carries (none for the pistol).
                const sightParts: (MeshPart | null)[] = SIGHTS.map((def, i) => {
                    if (i === SIGHT_IRON) return null;
                    const node = probe.findByName(`${name}_sight_${def.id}`) as pc.Entity | null;
                    const m = meshOf(node);
                    return node && m ? { mesh: m, toGun: toGun(node) } : null;
                });
                const list: pc.Mesh[] = [];
                for (const withSup of [false, true]) {
                    for (let i = 0; i < SIGHT_COUNT; i++) {
                        const parts: MeshPart[] = [{ mesh: body, toGun: null }];
                        if (withSup) parts.push(supPart);
                        const sp = sightParts[i];
                        if (sp) parts.push(sp);
                        // Combinations that add nothing to the plain gun share one mesh.
                        const same = i !== SIGHT_IRON && !sp ? list[lookIndex(withSup, SIGHT_IRON)] : null;
                        list.push(same ?? (parts.length === 1 ? body : mergedMesh(app.graphicsDevice, parts)));
                    }
                }
                looks.set(name, list);
            }
            probe.destroy();
            if (!ok) { reject(new Error('weapon model lacks the gun / pistol (suppressors, muzzles) / knife nodes')); return; }
            resolve({ asset, looks });
        });
        asset.once('error', (err: unknown) => {
            app.assets.remove(asset);
            reject(new Error(`Failed to load ${url}: ${String(err)}`));
        });
        app.assets.add(asset);
        app.assets.load(asset);
    });
}

/**
 * A new entity drawing one weapon with `material`, origin at the grip (not parented to anything). Guns start
 * bare; call `setSuppressed(true)` for the suppressed look.
 */
export function instantiateWeapon(model: WeaponModel, name: WeaponName, material: pc.Material,
    layers?: number[]): WeaponInstance {
    const res = model.asset.resource as pc.ContainerResource;
    const root = res.instantiateRenderEntity({ castShadows: false, receiveShadows: false });
    const e = root.findByName(name) as pc.Entity;
    e.parent!.removeChild(e);
    root.destroy();
    e.setLocalPosition(0, 0, 0);
    e.setLocalEulerAngles(0, 0, 0);
    e.setLocalScale(1, 1, 1);
    const r = e.render!;
    r.castShadows = false;
    r.receiveShadows = false;
    if (layers) r.layers = layers;
    const mi = r.meshInstances[0];
    mi.material = material;
    if (name === 'knife') return { entity: e, meshInstance: mi, muzzle: null, setSuppressed: () => {}, setSight: () => {} };

    // The suppressor and sight children are never drawn themselves: their geometry is in the merged meshes.
    (e.findByName(`${name}_suppressor`) as pc.Entity | null)?.destroy();
    for (const def of SIGHTS) (e.findByName(`${name}_sight_${def.id}`) as pc.Entity | null)?.destroy();
    const looks = model.looks.get(name)!;
    const muzzleSup = e.findByName(`${name}_muzzle`)!;
    const muzzleBare = e.findByName(`${name}_muzzle_bare`)!;
    let suppressed = false, sight = SIGHT_IRON;
    const apply = (): void => {
        const mesh = looks[lookIndex(suppressed, sight)];
        if (mi.mesh !== mesh) mi.mesh = mesh;
        inst.muzzle = suppressed ? muzzleSup : muzzleBare;
    };
    const inst: WeaponInstance = {
        entity: e, meshInstance: mi, muzzle: muzzleBare,
        setSuppressed(on: boolean): void { suppressed = on; apply(); },
        setSight(n: number): void { sight = n >= 0 && n < SIGHT_COUNT ? n : SIGHT_IRON; apply(); }
    };
    return inst;
}

/** Lit material for the weapon meshes (their colour is in the vertex colours). */
export function makeWeaponMaterial(gloss = 0.35): pc.StandardMaterial {
    const m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(1, 1, 1);
    m.diffuseVertexColor = true;
    m.diffuseVertexColorChannel = 'rgb';
    m.gloss = gloss;
    m.update();
    return m;
}
