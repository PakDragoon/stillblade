import * as pc from 'playcanvas';

/**
 * Graphics tiers (package G). Two looks share the same map, models and rules:
 *
 *  - `low`  integrated graphics, and the default whenever unsure: baked lighting, distance fog and colour
 *           grading inside the map's own shader (no extra pass), pooled particles and decals in a few batched
 *           draw calls, no full-screen post-processing and no realtime lights.
 *  - `high` a graphics card: everything in Low plus bloom, ambient occlusion and filmic tone mapping (one
 *           CameraFrame), a few dynamic lights (muzzle flashes, the bomb, the explosion), soft blob shadows under
 *           players and denser floor detail.
 *
 * The settings choice ("Auto", "Low", "High") decides; `?tier=low|high` in the address overrides it. "Auto"
 * looks at the graphics chip's name first (integrated chips and software renderers are always Low) and
 * otherwise measures frame times under a fixed full-screen load while the map downloads (`measureTier`).
 */
export type Tier = 'low' | 'high';
/** The settings value: "auto" measures, the others force a tier. */
export type TierChoice = 'auto' | Tier;

/** `?tier=low` or `?tier=high` in the page address, or null. */
export function urlTier(search: string): Tier | null {
    const t = new URLSearchParams(search).get('tier');
    return t === 'low' || t === 'high' ? t : null;
}

/** The GPU's name from WEBGL_debug_renderer_info, or '' when the browser hides it. */
export function rendererName(device: pc.GraphicsDevice): string {
    const gl = (device as unknown as { gl?: WebGLRenderingContext }).gl;
    if (!gl) return '';
    try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        return typeof name === 'string' ? name : '';
    } catch {
        return '';
    }
}

/**
 * What the chip's name alone says: 'low' for integrated graphics and software renderers, 'high' for a known
 * discrete card, null when it cannot tell (then the frame-time measurement decides). Pure, for tests.
 */
export function tierFromRenderer(name: string): Tier | null {
    const n = name.toLowerCase();
    if (!n) return null;
    // Software rendering and integrated chips: Intel (HD, UHD, Iris), AMD APUs ("Radeon Graphics", "Vega 3/6/8"),
    // phones and tablets, Apple's M chips are fast but share memory: let the measurement decide those.
    if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(n)) return 'low';
    if (/intel/.test(n) && !/\barc\b/.test(n)) return 'low';
    if (/mali|adreno|powervr|videocore/.test(n)) return 'low';
    if (/radeon\(tm\) graphics|radeon graphics|vega \d\b|radeon(\(tm\))? (r[2-7]|610m|660m|680m|740m|760m|780m)/.test(n)) return 'low';
    if (/nvidia|geforce|rtx|gtx|quadro/.test(n)) return /\bmx\s?\d/.test(n) ? null : 'high';
    if (/radeon (rx|pro)|\brx \d{3,4}/.test(n)) return 'high';
    if (/intel.*\barc\b|\barc a\d/.test(n)) return 'high';
    return null;
}

/**
 * Decision from the measured frame times (seconds) under the benchmark load: High only when the median frame
 * stayed within 60 FPS with room to spare (the load is about what High adds at this resolution). Pure.
 */
export function tierFromFrameTimes(times: readonly number[]): Tier {
    if (times.length < 20) return 'low';
    const s = [...times].sort((a, b) => a - b);
    const median = s[s.length >> 1];
    const p90 = s[Math.floor(s.length * 0.9)];
    return median < 0.0175 && p90 < 0.022 ? 'high' : 'low';
}

/** The tier in force: the address first, then the setting, then the measurement (Low while it is unknown). */
export function resolveTier(url: Tier | null, choice: TierChoice, measured: Tier | null): Tier {
    return url ?? (choice === 'auto' ? measured ?? 'low' : choice);
}

const BENCH_VS = /* glsl */ `
attribute vec3 aPosition;
varying vec2 vUv;
void main(void) {
    vUv = aPosition.xy * 0.5 + 0.5;
    gl_Position = vec4(aPosition.xy, 0.5, 1.0);
}
`;

// A fill-rate and arithmetic load in the range of High's post-processing: a few texture-free noise octaves per
// layer, blended. Its output is almost exactly the camera's clear colour, so nothing shows behind the menu.
const BENCH_FS = /* glsl */ `
varying vec2 vUv;
float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(void) {
    vec2 p = vUv * 64.0 + gl_FragCoord.z;
    float v = 0.0;
    for (int i = 0; i < 6; i++) { v += h(floor(p)) * 0.15; p *= 1.7; }
    gl_FragColor = vec4(vec3(v * 0.002), 0.004);
}
`;

/**
 * Measures how the GPU copes with a fixed full-screen load (8 blended layers, about what High's bloom, ambient
 * occlusion and tone mapping cost) for `seconds`, discarding the first half second, then removes everything it
 * added. Resolves 'high' or 'low'. Runs while the map downloads; the scene behind the loading screen is empty.
 */
export function measureTier(app: pc.Application, camera: pc.Entity, seconds = 2.5): Promise<Tier> {
    return new Promise(resolve => {
        const device = app.graphicsDevice;
        const material = new pc.ShaderMaterial({
            uniqueName: 'sbTierBench',
            attributes: { aPosition: pc.SEMANTIC_POSITION },
            vertexGLSL: BENCH_VS,
            fragmentGLSL: BENCH_FS
        });
        material.blendType = pc.BLEND_NORMAL;
        material.depthTest = false;
        material.depthWrite = false;
        material.cull = pc.CULLFACE_NONE;
        material.update();
        const LAYERS = 8;
        const pos: number[] = [];
        const idx: number[] = [];
        for (let i = 0; i < LAYERS; i++) {
            const o = i * 4;
            pos.push(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0);
            idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
        }
        const mesh = new pc.Mesh(device);
        mesh.setPositions(pos);
        mesh.setIndices(idx);
        mesh.update(pc.PRIMITIVE_TRIANGLES);
        const mi = new pc.MeshInstance(mesh, material);
        mi.cull = false;
        const entity = new pc.Entity('tier-bench');
        entity.addComponent('render', { meshInstances: [mi], castShadows: false, receiveShadows: false });
        camera.addChild(entity);
        const times: number[] = [];
        let elapsed = 0;
        const onUpdate = (dt: number): void => {
            elapsed += dt;
            if (elapsed > 0.5 && dt > 0 && dt < 0.25) times.push(dt);
            if (elapsed < seconds) return;
            app.off('update', onUpdate);
            entity.destroy();
            mesh.destroy();
            material.destroy();
            resolve(tierFromFrameTimes(times));
        };
        app.on('update', onUpdate);
    });
}
