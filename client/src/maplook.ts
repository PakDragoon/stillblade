import * as pc from 'playcanvas';

/**
 * Baked-lighting look for the map.
 *
 * The world's lighting (sun, sky, bounce) is baked offline in Blender into one atlas
 * (tools/blender/greybox.py). Here every map mesh instance is switched to ONE shared
 * unlit material that just samples that atlas, so the world costs a single cheap
 * texture fetch per pixel and ignores the realtime sun/ambient (those still light
 * players and the viewmodel).
 *
 * GLB layout contract (written by greybox.py):
 *   TEXCOORD_0  world-space planar UVs (unused here)
 *   TEXCOORD_1  lightmap UVs into the baked atlas  -> emissiveMapUv = 1
 *
 * Colour space: the atlas holds display-referred sRGB colour (Blender's "Standard"
 * view transform). Loading it with `srgb: true` gives the texture an sRGB pixel format
 * (SRGBA8), so the GPU decodes it to linear on sampling; the camera's sRGB output
 * gamma (with linear tonemapping and exposure 1) re-encodes it, so on screen the
 * pixels match the bake exactly.
 */

/** Anisotropic filtering keeps glancing floors/walls crisp; 4x is cheap even on integrated GPUs. */
const MAX_ANISOTROPY = 4;

function loadTexture(app: pc.Application, url: string): Promise<pc.Texture> {
    return new Promise((resolve, reject) => {
        const asset = new pc.Asset(url, 'texture', { url }, {
            srgb: true,
            mipmaps: true,
            minfilter: 'linear_mip_linear',
            magfilter: 'linear',
            addressu: 'clamp',
            addressv: 'clamp'
        });
        asset.once('load', () => {
            const texture = asset.resource as pc.Texture | undefined;
            if (!texture) {
                reject(new Error(`Baked lighting texture ${url} loaded without a resource`));
                return;
            }
            resolve(texture);
        });
        asset.once('error', (err: unknown) => {
            app.assets.remove(asset);
            reject(new Error(`Failed to load baked lighting texture ${url}: ${String(err)}`));
        });
        app.assets.add(asset);
        app.assets.load(asset);
    });
}

/**
 * Loads the baked atlas and makes every mesh instance under `mapRoot` render unlit from it,
 * all sharing one material. Rejects if the texture cannot be loaded (the map keeps its
 * original materials in that case).
 */
export async function applyBakedLighting(app: pc.Application, mapRoot: pc.Entity, textureUrl: string): Promise<void> {
    const texture = await loadTexture(app, textureUrl);
    // Enforce settings regardless of how the asset system interpreted the data block.
    texture.srgb = true;
    texture.minFilter = pc.FILTER_LINEAR_MIPMAP_LINEAR;
    texture.magFilter = pc.FILTER_LINEAR;
    texture.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
    texture.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
    texture.anisotropy = Math.max(1, Math.min(MAX_ANISOTROPY, app.graphicsDevice.maxAnisotropy));

    const material = new pc.StandardMaterial();
    material.name = 'map_baked_unlit';
    material.useLighting = false;
    material.useSkybox = false;
    material.diffuse.set(0, 0, 0);
    material.diffuseVertexColor = false;
    material.specular.set(0, 0, 0);
    material.useMetalness = false;
    material.emissive.set(1, 1, 1);
    material.emissiveIntensity = 1;
    material.emissiveMap = texture;
    material.emissiveMapUv = 1;
    material.emissiveVertexColor = false;
    // useFog / useTonemap / useGammaTonemap stay at their defaults, like every other material.
    material.update();

    let count = 0;
    for (const node of mapRoot.find((n: pc.GraphNode) => n instanceof pc.Entity && !!n.render)) {
        for (const mi of (node as pc.Entity).render!.meshInstances) {
            mi.material = material;
            count++;
        }
    }
    if (count === 0) {
        throw new Error('applyBakedLighting: no mesh instances found under the map root');
    }
}
