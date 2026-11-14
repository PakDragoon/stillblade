import * as pc from 'playcanvas';
import type { WeaponId } from '@shared/weapons';

/**
 * Weapon meshes: client/public/models/weapons.glb, built by tools/blender/weapons.py from Quaternius's CC0
 * "Character Soldier" props (a suppressed SMG, a pistol given a suppressor, and a combat knife). One
 * vertex-coloured mesh each, one shared material.
 *
 * Node layout and axis convention (engine space, metres, origin at the centre of the hand's grip):
 *   gun        : -Z = muzzle direction, +Y = sights up (magazine and grip hang toward -Y), +X = right.
 *                Origin = middle of the pistol grip. 0.66 m long including the suppressor.
 *   gun_muzzle : child of gun, centre of the suppressor's front face (where tracers and flashes start).
 *   pistol     : same axes as gun; origin = middle of the grip. 0.31 m long including the suppressor.
 *   pistol_muzzle : child of pistol, centre of its suppressor's front face.
 *   knife      : -Z = blade tip, +Y = spine (cutting edge toward -Y). Origin = middle of the handle. 0.30 m.
 * The character GLB carries matching "socket_gun" / "socket_knife" nodes on the right wrist bone, so an
 * instance parented to a socket with an identity local transform sits in the hand (both guns share socket_gun).
 */

export type WeaponName = 'gun' | 'pistol' | 'knife';

/** Mesh node for each defender weapon in the table (shared/weapons.ts); the rifle's node is still "gun". */
export const WEAPON_MESH: Record<WeaponId, WeaponName> = { rifle: 'gun', pistol: 'pistol' };
const MUZZLES: Partial<Record<WeaponName, string>> = { gun: 'gun_muzzle', pistol: 'pistol_muzzle' };

export interface WeaponModel {
    asset: pc.Asset;
}

export interface WeaponInstance {
    entity: pc.Entity;
    meshInstance: pc.MeshInstance;
    /** Guns only: the muzzle point. */
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
            let ok = !!(probe.findByName('knife') as pc.Entity | null)?.render;
            for (const name of Object.values(WEAPON_MESH)) {
                ok = ok && !!(probe.findByName(name) as pc.Entity | null)?.render && !!probe.findByName(MUZZLES[name]!);
            }
            probe.destroy();
            if (!ok) { reject(new Error('weapon model lacks the gun / pistol (and muzzles) / knife nodes')); return; }
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
    const muzzle = MUZZLES[name];
    return { entity: e, meshInstance: mi, muzzle: muzzle ? e.findByName(muzzle) : null };
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
