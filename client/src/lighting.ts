import * as pc from 'playcanvas';
import type { Box, MapData, Vec3 } from '@shared/types';
import { LightProbes, PROBE_SIZE, SUN_VIS, type ProbeSource } from './probes';
import { readStream } from './meshdata';
import type { LookSources, LookTuning } from './maplook';

/**
 * Lighting for players and the first-person weapon (package Q). The world is unlit (its light is baked); players
 * and weapons are StandardMaterials. Before this package they were lit by one fixed sun and a flat ambient colour
 * everywhere on a map, so the gun shone as brightly in the basement as in the yard, and metal reflected a fixed studio
 * picture. Now:
 *
 * - **Probes** (client/src/probes.ts) read the map's own baked light around a point, so the gun and every character
 *   take the light of where they stand: an ambient cube (light from six directions), and the share of the sun that
 *   reaches them. Built from small CPU copies of the lightmap, the albedo textures and the sky, at map load. Nothing is
 *   downloaded or baked anew.
 * - **One shader hook** on those materials (`useProbeLighting`) replaces the engine's flat ambient with the probe's
 *   ambient cube, adds a key light (the sun where it reaches, else a soft light from the brightest side), a rim light
 *   so the silhouette reads in the dark, and scales reflections by the local light. No realtime light remains for them
 *   (the engine's directional sun is gone), so they cost less than before.
 * - **An environment** made per map from its sky and its ground colour: a prefiltered atlas for metal reflections on
 *   High (PlayCanvas `EnvLighting`, generated on the GPU once per map), and a 64 x 64 sphere map with the same
 *   picture by height for Low (one texture read, as before).
 *
 * All of it is presentation: it reads only the map and never touches the simulation.
 */

/** Toward the sun, engine axes: matched to the bake (tools/blender/mapbuilder.py), 47.9 degrees up. */
export const SUN_DIR: Vec3 = [0.554, 0.742, 0.377];
/** Sun colour times strength on players and weapons (the old realtime sun: (1, 0.93, 0.78) at 0.95). */
const SUN_COLOR: readonly number[] = [0.95, 0.88, 0.74];
/** Gains from the probes' light (the world's colour, linear) to the players' ambient and the rim. */
const AMBIENT_GAIN = 1.0;
const RIM_GAIN = 0.55;
/** The share of the brightest side's light used as a soft key where the sun does not reach. */
const SOFT_KEY = 0.7;
/** Sky light seen by probe rays: the sky picture (an LDR strip) times this. */
const SKY_GAIN = 1.0;
/** Floats per object's light uniforms: `sbLight[10]` (vec3 each, see LIGHT_GLSL). */
export const LIGHT_FLOATS = 30;
/** Colour kept in the environment metal reflects (0 grey, 1 the sky's own). */
const ENV_SATURATION = 0.3;
/**
 * The ground in the environment metal reflects, relative to the ground's real light: darker, so a gun's lower faces
 * show a horizon line and the metal reads as metal instead of an evenly lit grey.
 */
const ENV_GROUND = 0.45;
/**
 * Readability floor: where the probes' average light (luminance) is below this, the light on players and the weapon
 * is lifted toward it by the square root of the ratio, so a dark basement stays dark but the gun never goes black.
 */
const MIN_AMBIENT = 0.075;
/** The rim light never drops below this (luminance-ish, linear): the silhouette reads in the darkest corner. */
const MIN_RIM = 0.03;
/** Probe grid spacing (metres). */
const PROBE_CELL = 1;
/** CPU copy of the lightmap (pixels a side): enough to tell lit from shaded patches, about 1 MB. */
const LIGHTMAP_CPU = 512;

/** The shared GLSL: the uniform and the light it describes (one guard so either chunk may come first). */
const LIGHT_DECL = /* glsl */ `
#ifndef SB_LIGHT
#define SB_LIGHT
// 0..5 light from +X, -X, +Y, -Y, +Z, -Z; 6 key direction (toward the light); 7 key colour; 8 rim colour;
// 9 reflection tint. Linear.
uniform vec3 sbLight[10];
vec3 sbKeySpec(vec3 r, float gloss) {
    float p = exp2(1.0 + 9.0 * gloss);
    return sbLight[7] * (pow(max(dot(r, sbLight[6]), 0.0), p) * min((p + 2.0) * 0.05, 5.0));
}
#endif
`;

const AMBIENT_GLSL = /* glsl */ `
${LIGHT_DECL}
void addAmbient(vec3 worldNormal) {
    vec3 n = worldNormal;
    vec3 n2 = n * n;
    vec3 amb = n2.x * (n.x >= 0.0 ? sbLight[0] : sbLight[1])
             + n2.y * (n.y >= 0.0 ? sbLight[2] : sbLight[3])
             + n2.z * (n.z >= 0.0 ? sbLight[4] : sbLight[5]);
    // The key wraps a little round the shape so the shadow side is not flat black.
    float ndl = max(dot(n, sbLight[6]) * 0.85 + 0.15, 0.0);
    float rim = 1.0 - max(dot(n, dViewDirW), 0.0);
    rim *= rim * rim;
    dDiffuseLight += amb + sbLight[7] * ndl + sbLight[8] * rim;
}
`;

const REFLECTION_LINE = 'dReflection += vec4(calcReflection(reflDir, gloss), material_reflectivity);';
const REFLECTION_NEW = 'dReflection += vec4(calcReflection(reflDir, gloss) * sbLight[9] + sbKeySpec(reflDir, gloss), material_reflectivity);';

/**
 * Lights `material` from the probes: its own `sbLight` values by default (`params`, LIGHT_FLOATS floats, which the
 * caller keeps current), and any mesh instance may override them with its own (`setParameter('sbLight[0]', ...)`).
 * GLSL only (the game runs on WebGL); with WebGPU, or if a future engine words its reflection chunk differently, the
 * material keeps the engine's lighting and a warning is logged.
 */
export function useProbeLighting(device: pc.GraphicsDevice, material: pc.StandardMaterial, params: Float32Array): void {
    if (device.isWebGPU) {
        console.warn('[stillblade] probe lighting is GLSL only; keeping the engine lighting.');
        return;
    }
    const chunks = material.getShaderChunks('glsl');
    chunks.set('ambientPS', AMBIENT_GLSL);
    for (const name of ['reflectionEnvPS', 'reflectionSpherePS']) {
        const src = pc.ShaderChunks.get(device, 'glsl').get(name);
        if (!src || !src.includes(REFLECTION_LINE)) {
            console.warn(`[stillblade] ${name} changed; reflections are not tinted by the probes.`);
            continue;
        }
        chunks.set(name, LIGHT_DECL + src.replace(REFLECTION_LINE, REFLECTION_NEW));
    }
    // Written against this engine's chunks (2.24): the chunk text is checked above, and a later engine that rewords
    // it falls back with a warning.
    material.shaderChunksVersion = '2.24';
    material.setParameter('sbLight[0]', params);
    material.update();
}

/** The light uniforms for open air before any map is known: about the old fixed sun and ambient. */
export function defaultLight(out: Float32Array): Float32Array {
    const amb = [0.42, 0.44, 0.49];
    for (let a = 0; a < 6; a++) {
        const k = a === 2 ? 1.1 : a === 3 ? 0.6 : 0.85;
        out[a * 3] = amb[0] * k; out[a * 3 + 1] = amb[1] * k; out[a * 3 + 2] = amb[2] * k;
    }
    out[18] = SUN_DIR[0]; out[19] = SUN_DIR[1]; out[20] = SUN_DIR[2];
    out[21] = SUN_COLOR[0]; out[22] = SUN_COLOR[1]; out[23] = SUN_COLOR[2];
    out[24] = amb[0] * RIM_GAIN; out[25] = amb[1] * RIM_GAIN; out[26] = amb[2] * RIM_GAIN;
    out[27] = out[28] = out[29] = 1;
    return out;
}

const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Turns a probe sample (PROBE_SIZE floats) into the light uniforms (LIGHT_FLOATS floats). `envLum` is the brightness
 * of the environment picture metal reflects (its average), so reflections are scaled to the light around.
 */
export function lightFromProbe(s: Float32Array, envLum: number, out: Float32Array): void {
    let r = 0, g = 0, b = 0;
    for (let a = 0; a < 6; a++) { r += s[a * 3]; g += s[a * 3 + 1]; b += s[a * 3 + 2]; }
    r /= 6; g /= 6; b /= 6;
    // The readability floor (see MIN_AMBIENT).
    const avg = lum(r, g, b);
    const lift = AMBIENT_GAIN * (avg < MIN_AMBIENT ? Math.sqrt(MIN_AMBIENT / Math.max(1e-4, avg)) : 1);
    for (let i = 0; i < 18; i++) out[i] = s[i] * lift;
    r *= lift; g *= lift; b *= lift;
    // The brightest side: where the light mostly comes from when the sun does not reach.
    let dx = lum(s[0], s[1], s[2]) - lum(s[3], s[4], s[5]);
    let dy = lum(s[6], s[7], s[8]) - lum(s[9], s[10], s[11]);
    let dz = lum(s[12], s[13], s[14]) - lum(s[15], s[16], s[17]);
    const dl = Math.hypot(dx, dy, dz);
    if (dl > 1e-5) { dx /= dl; dy /= dl; dz /= dl; } else { dx = 0; dy = 1; dz = 0; }
    const sun = s[SUN_VIS];
    const soft = (1 - sun) * SOFT_KEY * Math.min(1, dl / Math.max(1e-4, lum(r, g, b)));
    let kx = SUN_DIR[0] * sun * 2 + dx * (1 - sun), ky = SUN_DIR[1] * sun * 2 + dy * (1 - sun), kz = SUN_DIR[2] * sun * 2 + dz * (1 - sun);
    const kl = Math.hypot(kx, ky, kz) || 1;
    kx /= kl; ky /= kl; kz /= kl;
    out[18] = kx; out[19] = ky; out[20] = kz;
    out[21] = SUN_COLOR[0] * sun + r * soft;
    out[22] = SUN_COLOR[1] * sun + g * soft;
    out[23] = SUN_COLOR[2] * sun + b * soft;
    const rimLum = Math.max(1e-4, lum(r, g, b) + 0.2 * sun) * RIM_GAIN;
    const rimK = rimLum < MIN_RIM ? MIN_RIM / rimLum : 1;
    out[24] = (r + SUN_COLOR[0] * sun * 0.2) * RIM_GAIN * rimK;
    out[25] = (g + SUN_COLOR[1] * sun * 0.2) * RIM_GAIN * rimK;
    out[26] = (b + SUN_COLOR[2] * sun * 0.2) * RIM_GAIN * rimK;
    // Reflections: the environment picture scaled to the light here (never brighter than 1.5 times it).
    const k = Math.min(1, Math.max(0.04, (lum(r, g, b) + 0.25 * sun) / Math.max(0.05, envLum)));
    const l = Math.max(1e-4, lum(r, g, b));
    out[27] = k * (0.6 + 0.4 * r / l); out[28] = k * (0.6 + 0.4 * g / l); out[29] = k * (0.6 + 0.4 * b / l);
}

/** sRGB byte to linear. */
const SRGB = ((): Float32Array => {
    const t = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return t;
})();

/** A texture's image as RGBA bytes at `w` x `h` (scaled by the browser), or null if it has no image source. */
function pixelsOf(texture: pc.Texture, w: number, h: number): Uint8ClampedArray | null {
    const img = texture.getSource() as CanvasImageSource | null;
    if (!img) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
}

/** Bilinear linear-light sample of an RGBA byte image at (u, v), v = 0 the top row (textures are not flipped). */
function sampleImage(px: Uint8ClampedArray, w: number, h: number, u: number, v: number, out: Float32Array): void {
    const x = Math.min(Math.max(u * w - 0.5, 0), w - 1), y = Math.min(Math.max(v * h - 0.5, 0), h - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const fx = x - x0, fy = y - y0;
    for (let c = 0; c < 3; c++) {
        const a = SRGB[px[(y0 * w + x0) * 4 + c]], b = SRGB[px[(y0 * w + x1) * 4 + c]];
        const d = SRGB[px[(y1 * w + x0) * 4 + c]], e = SRGB[px[(y1 * w + x1) * 4 + c]];
        out[c] = (a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy;
    }
}

/** Floats per face triangle: plane coordinates of 3 corners (6), lightmap UVs (6), surface colour (3), decal flag. */
const TRI = 16;

/**
 * Every axis-aligned triangle of the map's meshes, bucketed by the plane it lies in, so the colour leaving a box face
 * at a point can be looked up: find the triangle there, read its lightmap UV, times its surface colour.
 */
class FaceTable {
    private readonly buckets = new Map<number, number[]>();
    private readonly tris: Float32Array;
    /** Area-weighted average light leaving upward faces (the ground, for the environment below the horizon). */
    readonly ground = new Float32Array(3);
    private readonly rgb = new Float32Array(3);

    constructor(mapRoot: pc.Entity, src: LookSources, private readonly light: Uint8ClampedArray) {
        const albedoAvg = new Map<pc.Texture, Float32Array>();
        const avgOf = (t: pc.Texture): Float32Array => {
            let a = albedoAvg.get(t);
            if (a) return a;
            a = new Float32Array([0.5, 0.5, 0.5]);
            const px = pixelsOf(t, 8, 8);
            if (px) {
                a.fill(0);
                for (let i = 0; i < 64; i++) for (let c = 0; c < 3; c++) a[c] += SRGB[px[i * 4 + c]] / 64;
            }
            albedoAvg.set(t, a);
            return a;
        };
        const data: number[] = [];
        const p = [new pc.Vec3(), new pc.Vec3(), new pc.Vec3()];
        const e1 = new pc.Vec3(), e2 = new pc.Vec3(), n = new pc.Vec3();
        let gw = 0;
        for (const node of mapRoot.find((g: pc.GraphNode) => g instanceof pc.Entity && !!g.render)) {
            for (const mi of (node as pc.Entity).render!.meshInstances) {
                const look = src.materials.get(mi.material?.name ?? '');
                const mesh = mi.mesh;
                if (!look || !mesh) continue;
                const tint = look.tint * src.lightScale;
                const alb = avgOf(look.albedo);
                const pos = readStream(mesh, pc.SEMANTIC_POSITION);
                const uv1 = readStream(mesh, pc.SEMANTIC_TEXCOORD1);
                const col = readStream(mesh, pc.SEMANTIC_COLOR);
                if (!pos || !uv1) continue;
                const idx: number[] = [];
                mesh.getIndices(idx);
                const xf = mi.node.getWorldTransform();
                const pc3 = pos.components, uc = uv1.components;
                for (let t = 0; t + 2 < idx.length; t += 3) {
                    for (let k = 0; k < 3; k++) {
                        const v = idx[t + k];
                        p[k].set(pos.data[v * pc3], pos.data[v * pc3 + 1], pos.data[v * pc3 + 2]);
                        xf.transformPoint(p[k], p[k]);
                    }
                    e1.sub2(p[1], p[0]); e2.sub2(p[2], p[0]);
                    n.cross(e1, e2);
                    const area = n.length() / 2;
                    if (area < 1e-6) continue;
                    n.mulScalar(1 / (area * 2));
                    const ax = Math.abs(n.x) > 0.98 ? 0 : Math.abs(n.y) > 0.98 ? 1 : Math.abs(n.z) > 0.98 ? 2 : -1;
                    if (ax < 0) continue;
                    const sign = (ax === 0 ? n.x : ax === 1 ? n.y : n.z) > 0 ? 1 : -1;
                    const plane = ax === 0 ? p[0].x : ax === 1 ? p[0].y : p[0].z;
                    const key = FaceTable.key(ax, sign, plane);
                    const at = data.length / TRI;
                    for (let k = 0; k < 3; k++) {
                        data.push(ax === 0 ? p[k].y : p[k].x, ax === 2 ? p[k].y : p[k].z);
                    }
                    let cr = 0, cg = 0, cb = 0;
                    for (let k = 0; k < 3; k++) {
                        const v = idx[t + k];
                        data.push(uv1.data[v * uc], uv1.data[v * uc + 1]);
                        if (col) { const c = col.components; cr += col.data[v * c] / 3; cg += col.data[v * c + 1] / 3; cb += col.data[v * c + 2] / 3; }
                        else { cr += 1 / 3; cg += 1 / 3; cb += 1 / 3; }
                    }
                    data.push(alb[0] * cr * tint, alb[1] * cg * tint, alb[2] * cb * tint, look.decal ? 1 : 0);
                    let list = this.buckets.get(key);
                    if (!list) { list = []; this.buckets.set(key, list); }
                    list.push(at);
                }
            }
        }
        this.tris = new Float32Array(data);
        // The ground: upward faces' outgoing light, by area (sampled at each triangle's centre).
        const g = this.ground;
        for (const [key, list] of this.buckets) {
            if (FaceTable.faceOf(key) !== 2) continue; // +Y
            for (const t of list) {
                const o = t * TRI;
                if (this.tris[o + 15] > 0) continue;
                const area = Math.abs((this.tris[o + 2] - this.tris[o]) * (this.tris[o + 5] - this.tris[o + 1]) - (this.tris[o + 4] - this.tris[o]) * (this.tris[o + 3] - this.tris[o + 1])) / 2;
                this.colourAt(t, (this.tris[o] + this.tris[o + 2] + this.tris[o + 4]) / 3, (this.tris[o + 1] + this.tris[o + 3] + this.tris[o + 5]) / 3, this.rgb);
                g[0] += this.rgb[0] * area; g[1] += this.rgb[1] * area; g[2] += this.rgb[2] * area;
                gw += area;
            }
        }
        if (gw > 0) { g[0] /= gw; g[1] /= gw; g[2] /= gw; } else g.fill(0.2);
    }

    /** Bucket key: 2 cm slices of the plane coordinate, times six face directions. */
    private static key(axis: number, sign: number, plane: number): number {
        return Math.round(plane * 50) * 6 + axis * 2 + (sign > 0 ? 0 : 1);
    }
    private static faceOf(key: number): number {
        return ((key % 6) + 6) % 6;
    }

    /** Light leaving the triangle at plane coordinates (a, b) (inside it). */
    private colourAt(t: number, a: number, b: number, out: Float32Array): void {
        const d = this.tris, o = t * TRI;
        const x0 = d[o], y0 = d[o + 1], x1 = d[o + 2], y1 = d[o + 3], x2 = d[o + 4], y2 = d[o + 5];
        const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
        const w0 = ((y1 - y2) * (a - x2) + (x2 - x1) * (b - y2)) / den;
        const w1 = ((y2 - y0) * (a - x2) + (x0 - x2) * (b - y2)) / den;
        const w2 = 1 - w0 - w1;
        const u = d[o + 6] * w0 + d[o + 8] * w1 + d[o + 10] * w2;
        const v = d[o + 7] * w0 + d[o + 9] * w1 + d[o + 11] * w2;
        sampleImage(this.light, LIGHTMAP_CPU, LIGHTMAP_CPU, u, v, out);
        out[0] *= d[o + 12]; out[1] *= d[o + 13]; out[2] *= d[o + 14];
    }

    /** Is (a, b) inside triangle t (with a small tolerance)? */
    private inside(t: number, a: number, b: number): boolean {
        const d = this.tris, o = t * TRI;
        const x0 = d[o], y0 = d[o + 1], x1 = d[o + 2], y1 = d[o + 3], x2 = d[o + 4], y2 = d[o + 5];
        const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
        if (Math.abs(den) < 1e-12) return false;
        const w0 = ((y1 - y2) * (a - x2) + (x2 - x1) * (b - y2)) / den;
        const w1 = ((y2 - y0) * (a - x2) + (x0 - x2) * (b - y2)) / den;
        const e = -1e-3;
        return w0 >= e && w1 >= e && 1 - w0 - w1 >= e;
    }

    /** Light leaving the face (axis, sign) at the point, preferring paint over the surface under it. */
    surface(x: number, y: number, z: number, axis: number, sign: number, out: Float32Array): boolean {
        const plane = axis === 0 ? x : axis === 1 ? y : z;
        const a = axis === 0 ? y : x, b = axis === 2 ? y : z;
        let found = -1;
        // The face itself, and paint a few millimetres in front of it (decals sit just above their surface).
        for (let s = 0; s <= 1; s++) {
            const list = this.buckets.get(FaceTable.key(axis, sign, plane + sign * s * 0.02));
            if (!list) continue;
            for (let i = 0; i < list.length; i++) {
                const t = list[i];
                if (!this.inside(t, a, b)) continue;
                found = t;
                if (this.tris[t * TRI + 15] > 0) break;
            }
            if (found >= 0 && this.tris[found * TRI + 15] > 0) break;
        }
        if (found < 0) return false;
        this.colourAt(found, a, b, out);
        return true;
    }
}

/** A map's lighting for players and weapons: probes, the environment textures, and its brightness. */
export interface MapLighting {
    readonly probes: LightProbes;
    /** High: the prefiltered environment atlas metal reflects. */
    readonly envAtlas: pc.Texture;
    /** Low: the same environment as a sphere map (by height only, so it does not matter which way the view turns). */
    readonly sphere: pc.Texture;
    /** Brightness (luminance) of the environment picture, for scaling reflections to the local light. */
    readonly envLum: number;
    /** The light uniforms at a point (eye or chest height), from the probes. False where nothing is known. */
    sample(x: number, y: number, z: number, out: Float32Array): boolean;
    dispose(): void;
}

/**
 * Builds the lighting of a map whose look has been applied (`applyMapLook`): CPU copies of its lightmap, sky and
 * albedo averages, the face table, the probes, and the environment textures. Takes some tens of milliseconds and a
 * few GPU passes (the environment), once per map load.
 */
export function buildMapLighting(app: pc.Application, mapRoot: pc.Entity, mapData: MapData, src: LookSources,
    tuning: LookTuning, boxes: readonly Box[]): MapLighting {
    const device = app.graphicsDevice;
    const light = pixelsOf(src.light, LIGHTMAP_CPU, LIGHTMAP_CPU);
    if (!light) throw new Error('lightmap has no image source');
    const faces = new FaceTable(mapRoot, src, light);
    // The sky strip (the same picture and mapping as maplook.ts's sky shader).
    const SW = 256, SH = 64;
    const skyPx = pixelsOf(src.sky, SW, SH);
    const fog = tuning.fogColor;
    const ground = faces.ground;
    const elevMin = src.elevMin;
    const skyAt = (dx: number, dy: number, dz: number, out: Float32Array): void => {
        const elev = Math.asin(Math.max(-1, Math.min(1, dy))) * 180 / Math.PI;
        if (elev < elevMin || !skyPx) {
            // Below the strip: the ground's light, hazed toward the fog near the horizon.
            const h = Math.min(1, Math.max(0, (elev + 25) / 25));
            out[0] = ground[0] + (fog[0] - ground[0]) * h * 0.5;
            out[1] = ground[1] + (fog[1] - ground[1]) * h * 0.5;
            out[2] = ground[2] + (fog[2] - ground[2]) * h * 0.5;
            return;
        }
        const u = 0.5 - Math.atan2(-dz, dx) / (2 * Math.PI);
        const f = Math.min(1, Math.max(0, (elev - elevMin) / (90 - elevMin)));
        sampleImage(skyPx, SW, SH, ((u % 1) + 1) % 1, 1 - f, out);
        const haze = tuning.skyHaze * (1 - Math.min(1, Math.max(0, (elev + 2) / 16)));
        for (let c = 0; c < 3; c++) out[c] = (out[c] + (fog[c] - out[c]) * haze) * SKY_GAIN;
    };
    const source: ProbeSource = {
        boxes, min: mapData.bounds.min, max: mapData.bounds.max, sunDir: SUN_DIR,
        surface: (x, y, z, axis, sign, out) => faces.surface(x, y, z, axis, sign, out),
        sky: skyAt
    };
    const probes = new LightProbes(source, PROBE_CELL);

    // The environment: an equirect picture (sky above, ground below), prefiltered on the GPU for High, and a sphere map
    // of the same picture by height for Low.
    const EW = 128, EH = 64;
    const env = new Uint8Array(EW * EH * 4);
    const rgb = new Float32Array(3);
    const toSrgb = (c: number): number => Math.round(255 * Math.min(1, c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
    let envSum = 0;
    // Average by height (for the sphere map): 64 bands.
    const bands = new Float32Array(EH * 3);
    for (let y = 0; y < EH; y++) {
        const theta = ((y + 0.5) / EH) * Math.PI; // 0 = straight up
        const dy = Math.cos(theta), r = Math.sin(theta);
        for (let x = 0; x < EW; x++) {
            // Equirect as the engine reads it (toSphericalUv): u from atan(dir.x, dir.z) with x mirrored.
            const phi = ((x + 0.5) / EW) * 2 * Math.PI - Math.PI;
            const dx = -Math.sin(phi) * r, dz = Math.cos(phi) * r;
            skyAt(dx, dy, dz, rgb);
            // Half way to grey: a gun outdoors picks up the sky, but a strongly blue reflection reads as blue paint.
            const g = lum(rgb[0], rgb[1], rgb[2]);
            const gk = dy < 0 ? ENV_GROUND : 1;
            for (let c = 0; c < 3; c++) rgb[c] = (g + (rgb[c] - g) * ENV_SATURATION) * gk;
            const i = (y * EW + x) * 4;
            env[i] = toSrgb(rgb[0]); env[i + 1] = toSrgb(rgb[1]); env[i + 2] = toSrgb(rgb[2]); env[i + 3] = 255;
            bands[y * 3] += rgb[0] / EW; bands[y * 3 + 1] += rgb[1] / EW; bands[y * 3 + 2] += rgb[2] / EW;
            envSum += lum(rgb[0], rgb[1], rgb[2]) * r;
        }
    }
    const envLum = envSum / (EW * EH * (2 / Math.PI));
    const equirect = new pc.Texture(device, {
        name: 'sb-env-source', width: EW, height: EH, format: pc.PIXELFORMAT_SRGBA8, mipmaps: false,
        projection: pc.TEXTUREPROJECTION_EQUIRECT, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR, levels: [env]
    });
    const cube = pc.EnvLighting.generateLightingSource(equirect, { size: 64 });
    const envAtlas = pc.EnvLighting.generateAtlas(cube, { size: 512, numReflectionSamples: 256, numAmbientSamples: 256 });
    cube.destroy();
    equirect.destroy();

    // Sphere map for Low: a mirror ball seen from the viewer, the environment by height (view up taken as world up).
    const SN = 64;
    const sph = new Uint8Array(SN * SN * 4);
    for (let y = 0; y < SN; y++) {
        for (let x = 0; x < SN; x++) {
            const u = ((x + 0.5) / SN) * 2 - 1, v = 1 - ((y + 0.5) / SN) * 2;
            const nz = Math.sqrt(Math.max(0, 1 - u * u - v * v));
            const ry = Math.max(-1, Math.min(1, 2 * nz * v)), rx = 2 * nz * u;
            const band = Math.min(EH - 1, Math.max(0, Math.floor((Math.acos(ry) / Math.PI) * EH)));
            // A soft bright patch up and to the left (as a sky opening or a lamp would give): the sphere map turns with
            // the view, so without one a gun held level reflects one even colour along its whole side.
            const patch = 0.55 + 1.1 * Math.exp(-((rx + 0.45) ** 2 + (ry - 0.5) ** 2) * 5);
            const i = (y * SN + x) * 4;
            sph[i] = toSrgb(bands[band * 3] * patch); sph[i + 1] = toSrgb(bands[band * 3 + 1] * patch); sph[i + 2] = toSrgb(bands[band * 3 + 2] * patch); sph[i + 3] = 255;
        }
    }
    const sphere = new pc.Texture(device, {
        name: 'sb-env-sphere', width: SN, height: SN, format: pc.PIXELFORMAT_SRGBA8, mipmaps: false,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR, levels: [sph]
    });

    const probe = new Float32Array(PROBE_SIZE);
    return {
        probes, envAtlas, sphere, envLum,
        sample(x, y, z, out) {
            if (!probes.sample(x, y, z, probe)) return false;
            lightFromProbe(probe, envLum, out);
            return true;
        },
        dispose() {
            envAtlas.destroy();
            sphere.destroy();
        }
    };
}
