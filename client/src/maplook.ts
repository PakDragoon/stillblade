import * as pc from 'playcanvas';
import type { MapData, MapLook } from '@shared/types';
import type { Tier } from './graphics';

/**
 * Map look: baked light x tiling albedo, plus the sky.
 *
 * The world's lighting (HDRI sky, sun, bounce, accent lamps) is baked offline in Blender
 * (tools/blender/mapbuilder.py) into ONE atlas that stores light only, no surface colour.
 * Every map mesh instance gets a tiny unlit ShaderMaterial:
 *
 *     colour = albedo(uv0 / tile) * COLOR_0 * tint * light(uv1)
 *
 * so the world costs two texture fetches per pixel, ignores the realtime sun/ambient (those
 * still light players and the viewmodel) and is one draw call per surface material. Package G adds, in the same
 * shader and pass: a colour grade and distance fog (both tiers; arithmetic only, see LookTuning) and, in the High
 * tier only, up to DYN_LIGHTS dynamic point lights (muzzle flashes, the bomb).
 *
 * GLB layout contract (written by tools/blender/mapbuilder.py):
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

/**
 * Per-map look tuning (package G): distance fog and a colour grade applied inside the world and sky shaders,
 * so they cost a few arithmetic instructions per pixel and no extra pass or texture read. The same fog is set on
 * the scene for the lit materials (players, weapons). Values are linear colours; `contrast` is a power around
 * mid grey (0.18), `saturation` mixes toward luminance, `gain` multiplies (a cool or warm cast).
 */
export interface LookTuning {
    fogColor: [number, number, number];
    /** Fog starts at `fogStart` metres and reaches `fogMax` at `fogEnd`. */
    fogStart: number;
    fogEnd: number;
    fogMax: number;
    contrast: number;
    saturation: number;
    gain: [number, number, number];
    /** How far the sky blends into the fog colour at the horizon (0..1). */
    skyHaze: number;
}

const DEFAULT_TUNING: LookTuning = {
    fogColor: [0.52, 0.6, 0.7], fogStart: 18, fogEnd: 120, fogMax: 0.55,
    contrast: 1.08, saturation: 1.06, gain: [1.0, 0.99, 0.96], skyHaze: 0.35
};
const LOOK_TUNING: Record<string, Partial<LookTuning>> = {
    // Open air: a light blue haze down the long lanes, warm sun, slightly lifted contrast.
    greybox: { fogColor: [0.55, 0.63, 0.74], fogStart: 14, fogEnd: 110, fogMax: 0.5, contrast: 1.1, saturation: 1.08, gain: [1.02, 1.0, 0.95] },
    // Indoors: a dusty warm-grey depth haze that separates the racks and the far hall, cooler shade.
    warehouse: { fogColor: [0.34, 0.33, 0.31], fogStart: 9, fogEnd: 70, fogMax: 0.42, contrast: 1.1, saturation: 1.05, gain: [1.0, 0.98, 0.95] }
};

/** The look tuning for a map id (defaults filled in). */
export function lookTuning(mapId: string): LookTuning {
    return { ...DEFAULT_TUNING, ...(LOOK_TUNING[mapId] ?? {}) };
}

/**
 * Dynamic world lights (High tier only): muzzle flashes, the bomb and its explosion. The presenter writes the
 * uniforms below straight into the device scope every frame (xyz position and radius in metres; rgb colour times
 * intensity, 0 when unused); the High world shader adds them to the baked light, with a flat face normal from
 * screen-space derivatives (the map has no normals). The Low shader is compiled without them.
 */
export const DYN_LIGHTS = 4;
export const DYN_POS_UNIFORM = 'sbDynPos[0]';
export const DYN_COL_UNIFORM = 'sbDynCol[0]';

const WORLD_VS = /* glsl */ `
attribute vec3 aPosition;
attribute vec2 aUv0;
attribute vec2 aUv1;
attribute vec4 aColor;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform vec3 view_position;
uniform float uTileInv;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vColor;
varying float vDist;
#ifdef DYN_LIGHTS
varying vec3 vWorld;
#endif
#ifdef PREPASS_PASS
uniform mat4 matrix_view;
varying float vLinearDepth;
#endif
void main(void) {
    vec4 world = matrix_model * vec4(aPosition, 1.0);
#ifdef PREPASS_PASS
    vLinearDepth = -(matrix_view * world).z;
#endif
    vUv0 = aUv0 * uTileInv;
    vUv1 = aUv1;
    vColor = aColor.rgb;
    vDist = length(world.xyz - view_position);
#ifdef DYN_LIGHTS
    vWorld = world.xyz;
#endif
    gl_Position = matrix_viewProjection * world;
}
`;

/** The grade and fog, shared by the world and the sky (GLSL). */
const LOOK_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform vec4 uFog;        // start, 1 / (end - start), max, unused
uniform vec4 uGrade;      // contrast, saturation, unused, unused
uniform vec3 uGain;
vec3 sbGrade(vec3 c) {
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = max(mix(vec3(lum), c, uGrade.y), 0.0);
    c = pow(c * (1.0 / 0.18), vec3(uGrade.x)) * 0.18;
    return c * uGain;
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
varying float vDist;
${LOOK_GLSL}
#ifdef DYN_LIGHTS
uniform vec4 sbDynPos[${DYN_LIGHTS}];
uniform vec3 sbDynCol[${DYN_LIGHTS}];
uniform vec3 view_position;
varying vec3 vWorld;
#endif
#ifdef PREPASS_PASS
// The High tier's depth prepass (for ambient occlusion) draws this material too: write the linear depth it expects.
#include "floatAsUintPS"
varying float vLinearDepth;
#endif
void main(void) {
#ifdef PREPASS_PASS
    gl_FragColor = float2vec4(vLinearDepth);
    return;
#endif
    vec3 albedo = texture2D(uAlbedo, vUv0).rgb * vColor;
    vec3 light = texture2D(uLight, vUv1).rgb * (uLightScale * uTint);
#ifdef DYN_LIGHTS
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (dot(n, view_position - vWorld) < 0.0) n = -n;
    for (int i = 0; i < ${DYN_LIGHTS}; i++) {
        vec3 l = sbDynPos[i].xyz - vWorld;
        float r = sbDynPos[i].w;
        float d2 = dot(l, l);
        float a = max(1.0 - d2 / (r * r), 0.0);
        light += sbDynCol[i] * (a * a * (0.25 + 0.75 * max(dot(n, l) * inversesqrt(d2 + 1e-4), 0.0)));
    }
#endif
    vec3 colour = sbGrade(albedo * light);
    float f = clamp((vDist - uFog.x) * uFog.y, 0.0, 1.0) * uFog.z;
    colour = mix(colour, uFogColor, f);
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
 * The same grade as the world, and a haze toward the fog colour near the horizon.
 */
const SKY_FS = /* glsl */ `
#include "gammaPS"
#include "tonemappingPS"
uniform sampler2D uSky;
uniform float uElevMin;
uniform float uSkyHaze;
varying vec3 vDir;
${LOOK_GLSL}
#ifdef PREPASS_PASS
#include "floatAsUintPS"
#endif
void main(void) {
#ifdef PREPASS_PASS
    gl_FragColor = float2vec4(10000.0);   // the sky is infinitely far: nothing is occluded by it
    return;
#endif
    vec3 d = normalize(vDir);
    float u = 0.5 - atan(-d.z, d.x) * 0.15915494;
    float elev = degrees(asin(clamp(d.y, -1.0, 1.0)));
    float f = clamp((elev - uElevMin) / (90.0 - uElevMin), 0.0, 1.0);
    vec3 colour = sbGrade(texture2D(uSky, vec2(u, 1.0 - f)).rgb);
    colour = mix(colour, uFogColor, uSkyHaze * (1.0 - smoothstep(-2.0, 14.0, elev)));
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

/**
 * Maps share texture files (the same URL is one cached resource), so unloading one map's texture would blank
 * the next map's. Each loaded texture counts its holders by URL and is unloaded only when the last one lets go.
 */
const textureHolders = new Map<string, number>();

function loadTexture(app: pc.Application, url: string, opt: TextureOptions, loaded: pc.Asset[]): Promise<pc.Texture> {
    return new Promise((resolve, reject) => {
        const asset = new pc.Asset(url, 'texture', { url }, { srgb: true, mipmaps: opt.mipmaps });
        loaded.push(asset);
        asset.once('load', () => {
            const texture = asset.resource as pc.Texture | undefined;
            if (!texture) {
                reject(new Error(`Texture ${url} loaded without a resource`));
                return;
            }
            textureHolders.set(url, (textureHolders.get(url) ?? 0) + 1);
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

/** The grade and fog uniforms (shared arrays, set once per material). */
function setLookParams(material: pc.Material, t: LookTuning): void {
    material.setParameter('uFogColor', new Float32Array(t.fogColor));
    material.setParameter('uFog', new Float32Array([t.fogStart, 1 / Math.max(1, t.fogEnd - t.fogStart), t.fogMax, 0]));
    material.setParameter('uGrade', new Float32Array([t.contrast, t.saturation, 0, 0]));
    material.setParameter('uGain', new Float32Array(t.gain));
}

function worldMaterial(name: string, albedo: pc.Texture, light: pc.Texture, tile: number, tint: number,
    lightScale: number, decal: boolean, tuning: LookTuning): pc.ShaderMaterial {
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
    setLookParams(material, tuning);
    if (decal) {
        // Paint sits a few mm above its surface; a small bias keeps it from z-fighting far away.
        material.depthBias = -1;
        material.slopeDepthBias = -1;
    }
    material.update();
    return material;
}

function addSky(camera: pc.Entity, sky: pc.Texture, elevMin: number, tuning: LookTuning): pc.Entity {
    const material = new pc.ShaderMaterial({
        uniqueName: 'map_sky',
        attributes: { aPosition: pc.SEMANTIC_POSITION },
        vertexGLSL: SKY_VS,
        fragmentGLSL: SKY_FS
    });
    material.name = 'map_sky';
    material.setParameter('uSky', sky);
    material.setParameter('uElevMin', elevMin);
    material.setParameter('uSkyHaze', tuning.skyHaze);
    setLookParams(material, tuning);
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
    return entity;
}

/** A map's look once applied: switch the tier's shader variant, and take it all away again. */
export interface MapLookHandle {
    /** The fog and grade in use (the scene fog for players and weapons is set to match by the caller). */
    readonly tuning: LookTuning;
    /** High compiles the world shader with the dynamic lights; Low without (the default). */
    setTier(tier: Tier): void;
    /** Removes the sky, the materials and the textures (a map change). */
    dispose(): void;
}

/**
 * Loads the lightmap, albedo textures and sky named in `mapData.look`, gives every mesh
 * instance under `mapRoot` its baked-light material and adds the sky to `camera`.
 * Rejects if anything fails to load (the map then keeps its plain GLB materials).
 * Returns a handle that switches the tier's shader variant and takes it all away again (the sky, the materials
 * and the textures) for a map change: call `dispose` when the map is unloaded.
 */
export async function applyMapLook(app: pc.Application, mapRoot: pc.Entity, camera: pc.Entity,
    mapData: MapData, baseUrl: string, tier: Tier): Promise<MapLookHandle> {
    const look: MapLook | undefined = mapData.look;
    if (!look) throw new Error('applyMapLook: map has no look data');
    const tuning = lookTuning(mapData.name);
    const loaded: pc.Asset[] = [];
    const albedoFiles = [...new Set(Object.values(look.materials).map(m => m.albedo))];
    const [light, sky, ...albedos] = await Promise.all([
        loadTexture(app, baseUrl + look.lightmap, { mipmaps: true, repeat: false, anisotropy: MAX_ANISOTROPY }, loaded),
        loadTexture(app, baseUrl + look.sky.texture, { mipmaps: false, repeat: true, clampV: true, anisotropy: 1 }, loaded),
        ...albedoFiles.map(f => loadTexture(app, baseUrl + f, { mipmaps: true, repeat: true, anisotropy: MAX_ANISOTROPY }, loaded))
    ]);
    const albedoByFile = new Map(albedoFiles.map((f, i) => [f, albedos[i]]));

    const materials = new Map<string, pc.ShaderMaterial>();
    for (const [name, m] of Object.entries(look.materials)) {
        materials.set(name, worldMaterial(name, albedoByFile.get(m.albedo)!, light, m.tile, m.tint ?? 1,
            look.lightScale, m.decal ?? false, tuning));
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
    const skyEntity = addSky(camera, sky, look.sky.elevMin, tuning);
    let current: Tier | null = null;
    const setTier = (t: Tier): void => {
        if (t === current) return;
        current = t;
        for (const m of materials.values()) {
            m.setDefine('DYN_LIGHTS', t === 'high');
            m.update();
        }
    };
    setTier(tier);
    return {
        tuning,
        setTier,
        dispose: () => {
            skyEntity.destroy();
            for (const m of materials.values()) m.destroy();
            for (const a of loaded) {
                const url = a.name; // the asset was named by its URL
                const left = (textureHolders.get(url) ?? 1) - 1;
                if (left > 0) textureHolders.set(url, left);
                else { textureHolders.delete(url); a.unload(); }
                app.assets.remove(a);
            }
        }
    };
}
