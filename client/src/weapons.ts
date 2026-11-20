import * as pc from 'playcanvas';
import { defaultLight, LIGHT_FLOATS, useProbeLighting } from './lighting';
import { readStream } from './meshdata';
import { SIGHTS, SIGHT_COUNT, SIGHT_IRON, type WeaponId } from '@shared/weapons';
import type { Tier } from './graphics';
import { loadAssetTracked } from './fetch-progress';
import type { FileTrack, LoadReporter } from './loading';

/**
 * Weapon meshes: client/public/models/weapons.glb, built by tools/blender/weapons.py from the models in
 * client/public/models/CREDITS.md: the M4 from the owner's animation pack (the rifle, package T; the same gun the
 * first-person rig holds), a Makarov PM (the pistol) and a tactical knife, with a red dot sight, a 2x scope and
 * generated suppressors. Third-person (reduced) meshes; the
 * first-person rigs (viewmodel.ts) carry the full-detail ones. Every mesh has UVs into its gun's texture atlas and a
 * vertex colour (RGB tints the atlas, A = emission: the red dot's reticle); `WeaponMaterials` below draws them.
 *
 * Node layout and axis convention (engine space, metres, origin at the centre of the hand's grip):
 *   gun        : -Z = muzzle direction, +Y = sights up (magazine and grip hang toward -Y), +X = right.
 *                Origin = a third of the way down the pistol grip. The M4: 0.87 m long bare, 1.0 m with the
 *                suppressor; its folding rear sight stays up in third person.
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
/** Texture atlas (and material) per mesh: tools/blender/realistic.py writes <atlas>_{albedo,normal}_<size>.webp. */
export type WeaponAtlas = 'rifle' | 'pistol' | 'knife';
export const ATLAS_OF: Record<WeaponName, WeaponAtlas> = { gun: 'rifle', pistol: 'pistol', knife: 'knife' };
/**
 * Every textured atlas the client loads by tier: the three guns' and (package O) the characters' (tools/blender/
 * soldier.py writes character_{albedo,normal}_<size>.webp; the defender's mesh samples it, the ghost's never does).
 */
export type AtlasName = WeaponAtlas | 'character';

export interface WeaponModel {
    asset: pc.Asset;
    /**
     * Per gun: one mesh per look, built once at load, indexed by `lookIndex(suppressed, sight)`: the bare gun (the
     * model's own mesh), and the gun with its suppressor and/or a mounted sight merged in.
     */
    readonly looks: Map<GunName, pc.Mesh[]>;
    /**
     * Per gun, per sight (SIGHTS index; the pistol has only iron): where the eye sits when aiming with it, in the
     * gun's own frame (engine axes, metres; the `<gun>_aim_<sight>` nodes), or null if the model has no such node.
     */
    readonly aims: Map<GunName, (pc.Vec3 | null)[]>;
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

/** A mesh and its transform relative to the gun (null: already in the gun's frame). */
interface MeshPart { mesh: pc.Mesh; toGun: pc.Mat4 | null }

/**
 * One mesh from `parts` (each moved by its transform relative to the gun: the suppressor's, a sight's): positions,
 * normals, UVs and vertex colours, indexed triangles. Used at load only.
 */
function mergedMesh(device: pc.GraphicsDevice, parts: readonly MeshPart[]): pc.Mesh {
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
    const p = new pc.Vec3(), n = new pc.Vec3();
    const normalMat = new pc.Mat3();
    let base = 0;
    for (const { mesh: m, toGun: xf } of parts) {
        if (xf) normalMat.setFromMat4(xf);
        const ps = readStream(m, pc.SEMANTIC_POSITION)!;
        const ns = readStream(m, pc.SEMANTIC_NORMAL);
        const cs = readStream(m, pc.SEMANTIC_COLOR);
        const ts = readStream(m, pc.SEMANTIC_TEXCOORD0);
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
            if (ts) uv.push(ts.data[i * ts.components], ts.data[i * ts.components + 1]);
            else uv.push(0, 0);
            if (cs) {
                const c = cs.components;
                col.push(cs.data[i * c], cs.data[i * c + 1], cs.data[i * c + 2], c > 3 ? cs.data[i * c + 3] : 1);
            } else col.push(1, 1, 1, 0);
        }
        const ind: number[] = [];
        m.getIndices(ind);
        for (let i = 0; i < ind.length; i++) idx.push(ind[i] + base);
        base += count;
    }
    const mesh = new pc.Mesh(device);
    mesh.setPositions(pos);
    mesh.setNormals(nrm);
    mesh.setUvs(0, uv);
    mesh.setColors(col);
    mesh.setIndices(idx);
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    return mesh;
}

const meshOf = (e: pc.Entity | null): pc.Mesh | null => e?.render?.meshInstances[0]?.mesh ?? null;

/** Loads the shared weapons GLB. Rejects if it fails to load or lacks a required node. */
export function loadWeaponModel(app: pc.Application, url: string, filename = 'weapons.glb', file: FileTrack | null = null): Promise<WeaponModel> {
    return new Promise((resolve, reject) => {
        const asset = new pc.Asset('weapons', 'container', { url, filename });
        asset.once('load', () => {
            const res = asset.resource as pc.ContainerResource | undefined;
            if (!res) { reject(new Error('weapon model loaded without a resource')); return; }
            // Check the layout once, and build every look's mesh, on a throwaway instance.
            const probe = res.instantiateRenderEntity();
            let ok = !!(probe.findByName('knife') as pc.Entity | null)?.render;
            const looks = new Map<GunName, pc.Mesh[]>();
            const aims = new Map<GunName, (pc.Vec3 | null)[]>();
            for (const name of GUN_NAMES) {
                const gun = probe.findByName(name) as pc.Entity | null;
                const sup = probe.findByName(`${name}_suppressor`) as pc.Entity | null;
                const body = meshOf(gun), supMesh = meshOf(sup);
                ok = ok && !!body && !!supMesh && !!probe.findByName(`${name}_muzzle`) && !!probe.findByName(`${name}_muzzle_bare`);
                if (!ok || !body || !supMesh || !gun || !sup) continue;
                const toGun = (e: pc.GraphNode): pc.Mat4 => new pc.Mat4().copy(gun.getWorldTransform()).invert().mul(e.getWorldTransform());
                aims.set(name, SIGHTS.map(def => {
                    const node = probe.findByName(`${name}_aim_${def.id}`);
                    return node ? toGun(node).getTranslation(new pc.Vec3()) : null;
                }));
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
            resolve({ asset, looks, aims });
        });
        asset.once('error', (err: unknown) => {
            app.assets.remove(asset);
            reject(new Error(`Failed to load ${url}: ${String(err)}`));
        });
        loadAssetTracked(app, asset, file);
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

/** Emission colour of the red dot's reticle (vertex alpha 1 on its few triangles, 0 everywhere else). */
const RETICLE_GLOW = new pc.Color(1, 0.1, 0.05);
const RETICLE_GLOW_INTENSITY = 4;
/** Strength of the reflection on metal (the map's environment, scaled by the local light: lighting.ts). */
const REFLECTIVITY = 0.75;
/** Atlas size per graphics tier: at most 1024 on Low, 2048 on High. */
export const ATLAS_SIZE: Record<Tier, number> = { low: 1024, high: 2048 };

/**
 * A small studio environment as a sphere map (a mirror ball seen from the viewer), generated here, nothing downloaded:
 * bright overhead, a soft key light up and to the left, a darker floor. Metal reflects it; it is in view space, so it
 * stays put relative to the camera, which suits a first-person weapon (players and weapons are lit by the same fixed
 * sun and ambient everywhere on a map anyway).
 */
function makeStudioSphere(device: pc.GraphicsDevice): pc.Texture {
    const n = 64;
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const u = ((x + 0.5) / n) * 2 - 1, v = 1 - ((y + 0.5) / n) * 2;
            const nz = Math.sqrt(Math.max(0, 1 - u * u - v * v));
            // Reflected view direction off a mirror ball at this point (y up).
            const ry = 2 * nz * v, rx = 2 * nz * u;
            const up = Math.max(-1, Math.min(1, ry));
            let c = 0.22 + 0.5 * Math.max(0, up) - 0.12 * Math.max(0, -up);
            c += 0.9 * Math.exp(-((rx + 0.45) ** 2 + (ry - 0.55) ** 2) * 6);
            const g = Math.round(Math.max(0, Math.min(1, c)) * 255);
            const i = (y * n + x) * 4;
            data[i] = Math.round(g * 0.98); data[i + 1] = g; data[i + 2] = Math.min(255, Math.round(g * 1.04)); data[i + 3] = 255;
        }
    }
    const t = new pc.Texture(device, { width: n, height: n, format: pc.PIXELFORMAT_RGBA8, mipmaps: false, name: 'weapon-studio' });
    t.addressU = t.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
    t.minFilter = t.magFilter = pc.FILTER_LINEAR;
    t.lock().set(data);
    t.unlock();
    return t;
}

/**
 * Skinned normals for the first-person rigs, which presenter.ts scales across the view (not in depth) to hold their
 * size at any field of view (VM_FOV). The engine turns a skinned normal by the skin matrix itself, which is only right
 * for uniform scale; this uses the matrix's cofactor (its inverse transpose up to a factor, which the normalize after
 * it removes), right for any scale. A per-material override of the engine's `normalCoreVS` chunk (GLSL and WGSL),
 * changing only the skinned line; skipped, with a warning, if a future engine version words that line differently.
 */
export function fovLockNormals(device: pc.GraphicsDevice, materials: pc.StandardMaterial[]): void {
    const swaps: [string, string, string][] = [
        ['glsl', 'return mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz);',
            'return mat3(cross(modelMatrix[1].xyz, modelMatrix[2].xyz), cross(modelMatrix[2].xyz, modelMatrix[0].xyz), cross(modelMatrix[0].xyz, modelMatrix[1].xyz));'],
        ['wgsl', 'return mat3x3f(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz);',
            'return mat3x3f(cross(modelMatrix[1].xyz, modelMatrix[2].xyz), cross(modelMatrix[2].xyz, modelMatrix[0].xyz), cross(modelMatrix[0].xyz, modelMatrix[1].xyz));']
    ];
    for (const [lang, from, to] of swaps) {
        const src = pc.ShaderChunks.get(device, lang).get('normalCoreVS');
        if (!src || !src.includes(from)) {
            console.warn(`[stillblade] normalCoreVS (${lang}) changed; first-person normals keep the engine's.`);
            continue;
        }
        const chunk = src.replace(from, to);
        for (const m of materials) m.getShaderChunks(lang).set('normalCoreVS', chunk);
    }
    for (const m of materials) m.update();
}

/**
 * The weapons' materials: one per atlas (rifle, pistol, knife), shared by first and third person (and by the arms in
 * the rigs, whose UVs point at a flat white swatch so their vertex colours show). Each samples its gun's albedo atlas
 * (RGB colour times the vertex colour; alpha = the surface value, read as both gloss and metalness), its normal map
 * and the studio sphere map: 3 texture reads per weapon pixel on both tiers. The atlases load when the tier is first
 * set (1024 on Low, 2048 on High, swapped when the tier changes); until then the guns are a flat dark grey.
 */
export class WeaponMaterials {
    readonly byAtlas: Record<AtlasName, pc.StandardMaterial>;
    /**
     * The light uniforms every weapon material uses unless a mesh instance has its own (package Q, lighting.ts): the
     * presenter keeps it at the first-person weapon's light every frame; characters and their guns set their own.
     */
    readonly light: Float32Array = defaultLight(new Float32Array(LIGHT_FLOATS));
    private tier: Tier | null = null;
    private readonly studio: pc.Texture;
    private env: { atlas: pc.Texture; sphere: pc.Texture } | null = null;
    private readonly loaded = new Map<string, Promise<pc.Texture>>();

    constructor(private readonly app: pc.Application, private readonly baseUrl: string, private readonly loads: LoadReporter | null = null) {
        const env = makeStudioSphere(app.graphicsDevice);
        this.studio = env;
        const make = (): pc.StandardMaterial => {
            const m = new pc.StandardMaterial();
            m.diffuse = new pc.Color(0.1, 0.1, 0.11);
            m.diffuseVertexColor = true;
            m.diffuseVertexColorChannel = 'rgb';
            m.useMetalness = true;
            m.metalness = 0.3;
            m.gloss = 0.45;
            m.sphereMap = env;
            m.reflectivity = REFLECTIVITY;
            m.emissive = RETICLE_GLOW;
            m.emissiveIntensity = RETICLE_GLOW_INTENSITY;
            m.emissiveVertexColor = true;
            m.emissiveVertexColorChannel = 'a';
            m.update();
            return m;
        };
        this.byAtlas = { rifle: make(), pistol: make(), knife: make(), character: make() };
        fovLockNormals(app.graphicsDevice, [this.byAtlas.rifle, this.byAtlas.pistol, this.byAtlas.knife]);
        for (const m of Object.values(this.byAtlas)) useProbeLighting(app.graphicsDevice, m, this.light);
        // Characters: no glowing reticle; a mid grey until the atlas arrives.
        const ch = this.byAtlas.character;
        ch.emissive = new pc.Color(0, 0, 0);
        ch.emissiveVertexColor = false;
        ch.diffuse = new pc.Color(0.35, 0.33, 0.3);
        ch.update();
    }

    /** The characters' material (the defender look; package O). */
    character(): pc.StandardMaterial {
        return this.byAtlas.character;
    }

    /** The material for a weapon mesh. */
    of(name: WeaponName): pc.StandardMaterial {
        return this.byAtlas[ATLAS_OF[name]];
    }

    /**
     * The map's environment for metal to reflect (lighting.ts), or null (the generated studio picture): the prefiltered
     * atlas on High, the sphere map on Low (one texture read).
     */
    setEnvironment(env: { atlas: pc.Texture; sphere: pc.Texture } | null): void {
        this.env = env;
        this.applyEnvironment();
    }

    private applyEnvironment(): void {
        const high = this.tier === 'high' && this.env;
        for (const m of Object.values(this.byAtlas)) {
            m.envAtlas = high ? this.env!.atlas : null;
            m.sphereMap = high ? null : this.env?.sphere ?? this.studio;
            m.update();
        }
    }

    /** Loads (once per size) and applies the atlases for this tier. */
    setTier(tier: Tier): void {
        if (tier === this.tier) return;
        this.tier = tier;
        this.applyEnvironment();
        const size = ATLAS_SIZE[tier];
        for (const atlas of Object.keys(this.byAtlas) as AtlasName[]) {
            const m = this.byAtlas[atlas];
            Promise.all([this.texture(`${atlas}_albedo_${size}.webp`, true), this.texture(`${atlas}_normal_${size}.webp`, false)])
                .then(([albedo, normal]) => {
                    if (this.tier !== tier) return; // a later tier change won
                    m.diffuse = new pc.Color(1, 1, 1);
                    m.diffuseMap = albedo;
                    // Cloth and skin: the surface value is read as gloss only (no metal).
                    m.metalness = atlas === 'character' ? 0 : 1;
                    m.metalnessMap = atlas === 'character' ? null : albedo;
                    m.metalnessMapChannel = 'a';
                    m.gloss = 1;
                    m.glossMap = albedo;
                    m.glossMapChannel = 'a';
                    m.normalMap = normal;
                    m.bumpiness = 1;
                    m.update();
                })
                .catch((err: unknown) => console.warn(`[stillblade] ${atlas} weapon textures failed to load; flat colour kept.`, err));
        }
    }

    private texture(file: string, srgb: boolean): Promise<pc.Texture> {
        const have = this.loaded.get(file);
        if (have) return have;
        const url = `${this.baseUrl}models/textures/${file}`;
        const p = new Promise<pc.Texture>((resolve, reject) => {
            const asset = new pc.Asset(file, 'texture', { url }, { srgb, mipmaps: true });
            asset.once('load', () => {
                const t = asset.resource as pc.Texture | undefined;
                if (!t) { reject(new Error(`${file} loaded without a resource`)); return; }
                t.minFilter = pc.FILTER_LINEAR_MIPMAP_LINEAR;
                t.magFilter = pc.FILTER_LINEAR;
                t.addressU = t.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
                t.anisotropy = Math.min(4, this.app.graphicsDevice.maxAnisotropy);
                resolve(t);
            });
            asset.once('error', (err: unknown) => {
                this.app.assets.remove(asset);
                this.loaded.delete(file);
                reject(new Error(`Failed to load ${url}: ${String(err)}`));
            });
            // The loading screen lists the characters' atlas under Characters, the rest under Weapons by gun.
            const forChar = file.startsWith('character');
            const track = this.loads?.file(forChar ? 'characters' : 'weapons', url, forChar ? 'textures' : file.replace(/_.*$/, '')) ?? null;
            loadAssetTracked(this.app, asset, track);
        });
        this.loaded.set(file, p);
        return p;
    }
}
