import * as pc from 'playcanvas';

/**
 * Weapon meshes: client/public/models/weapons.glb, built by tools/blender/weapons.py from Quaternius's CC0
 * "Character Soldier" props (a suppressed SMG and a combat knife). One vertex-coloured mesh each.
 *
 * Node layout and axis convention (engine space, metres, origin at the centre of the hand's grip):
 *   gun        : -Z = muzzle direction, +Y = sights up (magazine and grip hang toward -Y), +X = right.
 *                Origin = middle of the pistol grip. 0.66 m long including the suppressor.
 *   gun_muzzle : child of gun, centre of the suppressor's front face (where tracers and flashes start).
 *   knife      : -Z = blade tip, +Y = spine (cutting edge toward -Y). Origin = middle of the handle. 0.30 m.
 * The character GLB carries matching "socket_gun" / "socket_knife" nodes on the right wrist bone, so an
 * instance parented to a socket with an identity local transform sits in the hand.
 */

export type WeaponName = 'gun' | 'knife';

export interface WeaponModel {
    asset: pc.Asset;
}

export interface WeaponInstance {
    entity: pc.Entity;
    meshInstance: pc.MeshInstance;
    /** gun only: the muzzle point. */
    muzzle: pc.GraphNode | null;
}

/** Loads the shared weapons GLB. Rejects if it fails to load or lacks a required node. */
export function loadWeaponModel(app: pc.Application, url: string, filename = 'weapons.glb'): Promise<WeaponModel> {
    return new Promise((resolve, reject) => {
        const asset = new pc.Asset('weapons', 'container', { url, filename });
        asset.once('load', () => {
            const res = asset.resource as pc.ContainerResource | undefined;
            if (!res) { reject(new Error('weapon model loaded without a resource')); return; }
            // Check the layout once, on a throwaway instance.
            const probe = res.instantiateRenderEntity();
            const ok = !!(probe.findByName('gun') as pc.Entity | null)?.render &&
                !!(probe.findByName('knife') as pc.Entity | null)?.render && !!probe.findByName('gun_muzzle');
            probe.destroy();
            if (!ok) { reject(new Error('weapon model lacks the gun / gun_muzzle / knife nodes')); return; }
            resolve({ asset });
        });
        asset.once('error', (err: unknown) => {
            app.assets.remove(asset);
            reject(new Error(`Failed to load ${url}: ${String(err)}`));
        });
        app.assets.add(asset);
        app.assets.load(asset);
    });
}

/** A new entity drawing one weapon with `material`, origin at the grip (not parented to anything). */
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
    return { entity: e, meshInstance: mi, muzzle: name === 'gun' ? e.findByName('gun_muzzle') : null };
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
