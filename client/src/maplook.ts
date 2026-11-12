import * as pc from 'playcanvas';
import type { MapData, MapLook } from '@shared/types';

/**
 * Map look: baked light x tiling albedo, plus the sky.
 *
 * The world's lighting (HDRI sky, sun, bounce, accent lamps) is baked offline in Blender
 * (tools/blender/greybox.py) into ONE atlas that stores light only, no surface colour.
 * Every map mesh instance gets a tiny unlit ShaderMaterial:
 *
 *     colour = albedo(uv0 / tile) * COLOR_0 * tint * light(uv1)
 *
 * so the world costs two texture fetches per pixel, ignores the realtime sun/ambient (those
 * still light players and the viewmodel) and is one draw call per surface material.
 *
 * GLB layout contract (written by greybox.py):
 *   TEXCOORD_0  world-space planar UVs in metres  -> albedo, divided by the material's tile size
 *   TEXCOORD_1  lightmap UVs into the baked atlas
 *   COLOR_0     linear albedo multiplier (skirting, grime, variation, paint colour)
 *   material names  map_floor, map_wall_outer, ... -> look.materials in the map JSON
 *
 * Colour space: albedo textures and the atlas are sRGB images loaded with `srgb: true`, so
 * the GPU decodes them to linear on sampling. The atlas encodes light / lightScale, so the
 * shader multiplies it back. The result goes through the engine's own tonemapping and
 * gamma chunks (the camera's linear tonemap, exposure and sRGB output), exactly like the
 * StandardMaterial players on the same camera.
 *
 * Sky: an equirect strip of the same HDRI (tonemapped LDR, upper hemisphere) drawn on a
 * camera-attached sphere in the Skybox layer, after the world's opaque pass, at the far
 * plane, so only uncovered pixels are shaded. One draw call, one texture fetch.
 */

/** Anisotropic filtering keeps glancing floors/walls crisp; 4x is cheap even on integrated GPUs. */
const MAX_ANISOTROPY = 4;

const WORLD_VS = /* glsl */ `
attribute vec3 aPosition;
attribute vec2 aUv0;
attribute vec2 aUv1;
attribute vec4 aColor;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform float uTileInv;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vColor;
void main(void) {
    vUv0 = aUv0 * uTileInv;
    vUv1 = aUv1;
    vColor = aColor.rgb;
    gl_Position = matrix_viewProjection * (matrix_model * vec4(aPosition, 1.0));
}
`;

const WORLD_FS = /* glsl */ `
#include "gammaPS"
#include "tonemappingPS"
uniform sampler2D uAlbedo;
uniform sampler2D uLight;
uniform float uLightScale;
uniform float uTint;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vColor;
void main(void) {
    vec3 albedo = texture2D(uAlbedo, vUv0).rgb;
    vec3 light = texture2D(uLight, vUv1).rgb * uLightScale;
    vec3 colour = albedo * vColor * (uTint * light);
    gl_FragColor = vec4(gammaCorrectOutput(toneMap(colour)), 1.0);
}
`;

const SKY_VS = /* glsl */ `
attribute vec3 aPosition;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform vec3 view_position;
varying vec3 vDir;
void main(void) {
    vec4 world = matrix_model * vec4(aPosition, 1.0);
    vDir = world.xyz - view_position;
    gl_Position = matrix_viewProjection * world;
    gl_Position.z = gl_Position.w * 0.999999;   // at the far plane: behind everything
}
`;

/**
 * Engine direction (x, y, z) = Blender (x, z, -y). The strip uses Cycles' equirect mapping on
 * the Blender direction: u = 0.5 - atan(by, bx) / 2pi; v runs from uElevMin (bottom of the
 * image) to 90 degrees (top row). Textures are not flipped on upload, so v = 0 is the top row.
 */
const SKY_FS = /* glsl */ `
#include "gammaPS"
#include "tonemappingPS"
uniform sampler2D uSky;
uniform float uElevMin;
varying vec3 vDir;
void main(void) {
    vec3 d = normalize(vDir);
    float u = 0.5 - atan(-d.z, d.x) * 0.15915494;
    float elev = degrees(asin(clamp(d.y, -1.0, 1.0)));
    float f = clamp((elev - uElevMin) / (90.0 - uElevMin), 0.0, 1.0);
    vec3 colour = texture2D(uSky, vec2(u, 1.0 - f)).rgb;
    gl_FragColor = vec4(gammaCorrectOutput(toneMap(colour)), 1.0);
}
`;

const WORLD_ATTRIBUTES = {
    aPosition: pc.SEMANTIC_POSITION,
    aUv0: pc.SEMANTIC_TEXCOORD0,
    aUv1: pc.SEMANTIC_TEXCOORD1,
    aColor: pc.SEMANTIC_COLOR
};

interface TextureOptions {
    mipmaps: boolean;
    repeat: boolean;
    clampV?: boolean;
    anisotropy: number;
}

function loadTexture(app: pc.Application, url: string, opt: TextureOptions): Promise<pc.Texture> {
    return new Promise((resolve, reject) => {
        const asset = new pc.Asset(url, 'texture', { url }, { srgb: true, mipmaps: opt.mipmaps });
        asset.once('load', () => {
            const texture = asset.resource as pc.Texture | undefined;
            if (!texture) {
                reject(new Error(`Texture ${url} loaded without a resource`));
                return;
            }
            // Enforce settings regardless of how the asset system interpreted the data block.
            texture.minFilter = opt.mipmaps ? pc.FILTER_LINEAR_MIPMAP_LINEAR : pc.FILTER_LINEAR;
            texture.magFilter = pc.FILTER_LINEAR;
            const wrap = opt.repeat ? pc.ADDRESS_REPEAT : pc.ADDRESS_CLAMP_TO_EDGE;
            texture.addressU = wrap;
            texture.addressV = opt.clampV ? pc.ADDRESS_CLAMP_TO_EDGE : wrap;
            texture.anisotropy = Math.max(1, Math.min(opt.anisotropy, app.graphicsDevice.maxAnisotropy));
            resolve(texture);
        });
        asset.once('error', (err: unknown) => {
            app.assets.remove(asset);
            reject(new Error(`Failed to load texture ${url}: ${String(err)}`));
        });
        app.assets.add(asset);
        app.assets.load(asset);
    });
}

function worldMaterial(name: string, albedo: pc.Texture, light: pc.Texture, tile: number, tint: number,
    lightScale: number, decal: boolean): pc.ShaderMaterial {
    const material = new pc.ShaderMaterial({
        uniqueName: 'map_baked_albedo',
        attributes: WORLD_ATTRIBUTES,
        vertexGLSL: WORLD_VS,
        fragmentGLSL: WORLD_FS
    });
    material.name = name;
    material.setParameter('uAlbedo', albedo);
    material.setParameter('uLight', light);
    material.setParameter('uTileInv', 1 / tile);
    material.setParameter('uTint', tint);
    material.setParameter('uLightScale', lightScale);
    if (decal) {
        // Paint sits a few mm above its surface; a small bias keeps it from z-fighting far away.
        material.depthBias = -1;
        material.slopeDepthBias = -1;
    }
    material.update();
    return material;
}

function addSky(camera: pc.Entity, sky: pc.Texture, elevMin: number): void {
    const material = new pc.ShaderMaterial({
        uniqueName: 'map_sky',
        attributes: { aPosition: pc.SEMANTIC_POSITION },
        vertexGLSL: SKY_VS,
        fragmentGLSL: SKY_FS
    });
    material.name = 'map_sky';
    material.setParameter('uSky', sky);
    material.setParameter('uElevMin', elevMin);
    material.cull = pc.CULLFACE_NONE;
    material.depthWrite = false;
    material.update();

    const entity = new pc.Entity('sky');
    entity.addComponent('render', {
        type: 'sphere',
        material,
        castShadows: false,
        receiveShadows: false,
        layers: [pc.LAYERID_SKYBOX]
    });
    // Rotation does not matter (the shader uses world direction), so it can simply ride the camera.
    entity.setLocalScale(10, 10, 10);
    camera.addChild(entity);
    for (const mi of entity.render!.meshInstances) mi.cull = false;
}

/**
 * Loads the lightmap, albedo textures and sky named in `mapData.look`, gives every mesh
 * instance under `mapRoot` its baked-light material and adds the sky to `camera`.
 * Rejects if anything fails to load (the map then keeps its plain GLB materials).
 */
export async function applyMapLook(app: pc.Application, mapRoot: pc.Entity, camera: pc.Entity,
    mapData: MapData, baseUrl: string): Promise<void> {
    const look: MapLook | undefined = mapData.look;
    if (!look) throw new Error('applyMapLook: map has no look data');
    const albedoFiles = [...new Set(Object.values(look.materials).map(m => m.albedo))];
    const [light, sky, ...albedos] = await Promise.all([
        loadTexture(app, baseUrl + look.lightmap, { mipmaps: true, repeat: false, anisotropy: MAX_ANISOTROPY }),
        loadTexture(app, baseUrl + look.sky.texture, { mipmaps: false, repeat: true, clampV: true, anisotropy: 1 }),
        ...albedoFiles.map(f => loadTexture(app, baseUrl + f, { mipmaps: true, repeat: true, anisotropy: MAX_ANISOTROPY }))
    ]);
    const albedoByFile = new Map(albedoFiles.map((f, i) => [f, albedos[i]]));

    const materials = new Map<string, pc.ShaderMaterial>();
    for (const [name, m] of Object.entries(look.materials)) {
        materials.set(name, worldMaterial(name, albedoByFile.get(m.albedo)!, light, m.tile, m.tint ?? 1,
            look.lightScale, m.decal ?? false));
    }

    let count = 0;
    for (const node of mapRoot.find((n: pc.GraphNode) => n instanceof pc.Entity && !!n.render)) {
        for (const mi of (node as pc.Entity).render!.meshInstances) {
            // The GLB has no normals (unlit), so the glTF parser names its material copies "<name>-flatShaded".
            const name = (mi.material?.name ?? '').replace(/-flatShaded$/, '');
            const material = materials.get(name);
            if (!material) throw new Error(`applyMapLook: no look for map material "${name}"`);
            mi.material = material;
            count++;
        }
    }
    if (count === 0) throw new Error('applyMapLook: no mesh instances found under the map root');
    addSky(camera, sky, look.sky.elevMin);
}
