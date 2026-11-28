import * as pc from 'playcanvas';
import type { Box } from '@shared/types';
import type { Tier } from './graphics';
import type { LookTuning } from './maplook';

/**
 * Pooled visual effects (package G): particles, tracers, glows, blob shadows and decals, each kind drawn as ONE
 * dynamic mesh (a batch of camera-facing or surface-aligned quads), so the whole of it costs at most four draw
 * calls whatever is going on: additive (sparks, tracers, glows, fire), alpha (dust, smoke, shadows), decals
 * (bullet holes, scorch marks) and, in the High tier only, the static floor clutter. A batch with nothing in it
 * is not drawn at all. Before package G every tracer and every impact was its own draw call (up to 48).
 *
 * Everything is preallocated: particles live in typed arrays, the vertex data is written into each batch's
 * vertex buffer in place, and `update` allocates nothing. One procedural texture atlas (drawn once on a canvas)
 * holds every sprite, so an effect pixel costs one texture read. Effects are looks only: callers decide what may
 * be shown (the presenter never spawns an effect for something the player was not told about).
 */

/** What a bullet hit, from the map's box category: decides the decal, the dust colour and sparks. */
export type Surface = 'concrete' | 'metal' | 'wood';

const SURFACE_BY_CATEGORY: Record<string, Surface> = {
    crate: 'wood', rack: 'wood', furniture: 'wood', wood_floor: 'wood', barrack_wall: 'wood',
    stairs: 'metal', platform: 'metal', rail: 'metal', deck: 'metal', roof: 'metal', vehicle: 'metal',
    container: 'metal', car: 'metal', machine: 'metal', shed: 'metal', cabin: 'metal'
    // Everything else is concrete: floors, slabs, walls, and Dry Creek's sand ('floor') and Hesco or sandbags ('hesco'),
    // which have no footstep or impact set of their own yet; concrete is the nearest.
};

/** The surface a map box is made of (concrete unless its category says otherwise). */
export function surfaceOf(category: string | undefined): Surface {
    return (category && SURFACE_BY_CATEGORY[category]) || 'concrete';
}

/**
 * Where `p` lies on the map: the box face within 3 cm of it, as the outward axis (0 x, 1 y, 2 z) and sign, and the
 * box's surface. Writes into `out` and returns true, or false when `p` is on no box face (a player, or the end of
 * the range). Pure, for tests.
 */
export function faceAt(boxes: readonly Box[], p: readonly number[], out: { axis: number; sign: number; surface: Surface }): boolean {
    const E = 0.03;
    let best = E;
    let found = false;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const mn = b.min, mx = b.max;
        if (p[0] < mn[0] - E || p[0] > mx[0] + E || p[1] < mn[1] - E || p[1] > mx[1] + E || p[2] < mn[2] - E || p[2] > mx[2] + E) continue;
        for (let a = 0; a < 3; a++) {
            const dLo = Math.abs(p[a] - mn[a]), dHi = Math.abs(p[a] - mx[a]);
            if (dLo < best) { best = dLo; out.axis = a; out.sign = -1; out.surface = surfaceOf(b.category); found = true; }
            if (dHi < best) { best = dHi; out.axis = a; out.sign = 1; out.surface = surfaceOf(b.category); found = true; }
        }
    }
    return found;
}

// Atlas cells (4 x 4 grid of 128 px). The canvas is drawn once at start (makeAtlas).
const CELL_PUFF = 0, CELL_STREAK = 1, CELL_GLOW = 2, CELL_HOLE = 3, CELL_SCORCH = 4, CELL_TRACER = 5,
    CELL_CRACK = 6, CELL_STAIN = 7, CELL_CHIP = 8, CELL_SMOKE = 9, CELL_SHADOW = 10, CELL_SLASH = 11,
    CELL_HOLE_METAL = 12;
const ATLAS_CELLS = 4;
const ATLAS_SIZE = 512;

/** A fixed-seed generator for visual variety (never the game's simulation). */
let seed = 0x2545f491;
function rnd(): number {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
}
const spread = (r: number): number => (rnd() * 2 - 1) * r;

function makeAtlas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = ATLAS_SIZE;
    const g = c.getContext('2d')!;
    const S = ATLAS_SIZE / ATLAS_CELLS;
    const cell = (i: number, draw: (cx: number, cy: number, r: number) => void): void => {
        const x = (i % ATLAS_CELLS) * S, y = Math.floor(i / ATLAS_CELLS) * S;
        g.save();
        g.beginPath(); g.rect(x, y, S, S); g.clip();
        draw(x + S / 2, y + S / 2, S / 2);
        g.restore();
    };
    const radial = (cx: number, cy: number, r: number, stops: [number, string][]): void => {
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
        for (const [o, col] of stops) gr.addColorStop(o, col);
        g.fillStyle = gr;
        g.fillRect(cx - r, cy - r, r * 2, r * 2);
    };
    let s = 7;
    const r01 = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    cell(CELL_PUFF, (cx, cy, r) => {
        for (let k = 0; k < 7; k++) {
            const a = r01() * Math.PI * 2, d = r01() * r * 0.35;
            radial(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.45 + r01() * 0.3), [[0, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
        }
    });
    cell(CELL_SMOKE, (cx, cy, r) => {
        for (let k = 0; k < 12; k++) {
            const a = r01() * Math.PI * 2, d = r01() * r * 0.45;
            radial(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.3 + r01() * 0.3), [[0, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]);
        }
    });
    cell(CELL_STREAK, (cx, cy, r) => {
        g.translate(cx, cy); g.scale(1, 0.12);
        radial(0, 0, r, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.7)'], [1, 'rgba(255,255,255,0)']]);
    });
    cell(CELL_GLOW, (cx, cy, r) => radial(cx, cy, r, [[0, 'rgba(255,255,255,1)'], [0.15, 'rgba(255,255,255,0.8)'], [0.5, 'rgba(255,255,255,0.18)'], [1, 'rgba(255,255,255,0)']]));
    cell(CELL_TRACER, (cx, cy, r) => {
        const gr = g.createLinearGradient(cx, cy - r, cx, cy + r);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    });
    const hole = (cx: number, cy: number, r: number, ring: string): void => {
        radial(cx, cy, r * 0.62, [[0, ring], [0.55, ring], [1, 'rgba(0,0,0,0)']]);
        g.strokeStyle = 'rgba(20,20,20,0.6)'; g.lineWidth = 2;
        for (let k = 0; k < 6; k++) {
            const a = r01() * Math.PI * 2, l = r * (0.35 + r01() * 0.5);
            g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l); g.stroke();
        }
        radial(cx, cy, r * 0.2, [[0, 'rgba(0,0,0,1)'], [0.7, 'rgba(0,0,0,0.95)'], [1, 'rgba(0,0,0,0)']]);
    };
    cell(CELL_HOLE, (cx, cy, r) => hole(cx, cy, r, 'rgba(60,58,55,0.55)'));
    cell(CELL_HOLE_METAL, (cx, cy, r) => {
        radial(cx, cy, r * 0.45, [[0, 'rgba(150,150,150,0.7)'], [1, 'rgba(150,150,150,0)']]);
        radial(cx, cy, r * 0.17, [[0, 'rgba(0,0,0,1)'], [0.8, 'rgba(10,10,10,0.95)'], [1, 'rgba(0,0,0,0)']]);
    });
    cell(CELL_SCORCH, (cx, cy, r) => {
        for (let k = 0; k < 14; k++) {
            const a = r01() * Math.PI * 2, d = r01() * r * 0.4;
            radial(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.35 + r01() * 0.3), [[0, 'rgba(0,0,0,0.5)'], [1, 'rgba(0,0,0,0)']]);
        }
    });
    cell(CELL_CRACK, (cx, cy, r) => {
        g.strokeStyle = 'rgba(10,10,10,0.8)';
        for (let k = 0; k < 4; k++) {
            g.lineWidth = 3 - k * 0.5;
            let x = cx - r * 0.8, y = cy + (r01() - 0.5) * r * 0.6;
            g.beginPath(); g.moveTo(x, y);
            while (x < cx + r * 0.8) { x += r * 0.12; y += (r01() - 0.5) * r * 0.2; g.lineTo(x, y); }
            g.stroke();
        }
    });
    cell(CELL_STAIN, (cx, cy, r) => {
        for (let k = 0; k < 9; k++) {
            const a = r01() * Math.PI * 2, d = r01() * r * 0.4;
            radial(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.25 + r01() * 0.3), [[0, 'rgba(255,255,255,0.45)'], [0.7, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']]);
        }
    });
    cell(CELL_CHIP, (cx, cy, r) => { g.fillStyle = 'rgba(255,255,255,1)'; g.fillRect(cx - r * 0.35, cy - r * 0.3, r * 0.7, r * 0.6); });
    cell(CELL_SHADOW, (cx, cy, r) => radial(cx, cy, r, [[0, 'rgba(0,0,0,1)'], [0.45, 'rgba(0,0,0,0.75)'], [1, 'rgba(0,0,0,0)']]));
    cell(CELL_SLASH, (cx, cy, r) => {
        g.lineCap = 'round';
        for (let k = 0; k < 5; k++) {
            g.strokeStyle = `rgba(255,255,255,${0.2 + k * 0.18})`;
            g.lineWidth = 14 - k * 2.5;
            g.beginPath(); g.arc(cx, cy + r * 0.6, r * 0.85, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
        }
    });
    return c;
}

const VS = /* glsl */ `
attribute vec3 aPosition;
attribute vec2 aUv0;
attribute vec4 aColor;
uniform mat4 matrix_viewProjection;
uniform vec3 view_position;
varying vec2 vUv;
varying vec4 vColor;
varying float vDist;
void main(void) {
    vUv = aUv0;
    vColor = aColor;
    vDist = length(aPosition - view_position);
    gl_Position = matrix_viewProjection * vec4(aPosition, 1.0);
}
`;

const FS = /* glsl */ `
#include "gammaPS"
#include "tonemappingPS"
uniform sampler2D uAtlas;
uniform float uIntensity;
uniform vec3 uFogColor;
uniform vec4 uFog;
varying vec2 vUv;
varying vec4 vColor;
varying float vDist;
void main(void) {
    vec4 t = texture2D(uAtlas, vUv);
    float f = clamp((vDist - uFog.x) * uFog.y, 0.0, 1.0) * uFog.z;
#ifdef ADDITIVE
    vec3 c = t.rgb * vColor.rgb * (t.a * vColor.a * uIntensity * (1.0 - f));
    gl_FragColor = vec4(gammaCorrectOutput(toneMap(c)), 1.0);
#else
    vec3 c = mix(t.rgb * vColor.rgb, uFogColor, f);
    gl_FragColor = vec4(gammaCorrectOutput(toneMap(c)), t.a * vColor.a);
#endif
}
`;

/** One dynamic mesh of up to `max` quads: written from scratch every frame (or once, for static clutter). */
class QuadBatch {
    readonly mi: pc.MeshInstance;
    readonly material: pc.ShaderMaterial;
    private readonly vb: pc.VertexBuffer;
    private readonly mesh: pc.Mesh;
    private readonly f32: Float32Array;
    private readonly u32: Uint32Array;
    count = 0;

    constructor(device: pc.GraphicsDevice, readonly max: number, atlas: pc.Texture, mode: 'add' | 'alpha' | 'decal', root: pc.Entity) {
        const format = new pc.VertexFormat(device, [
            { semantic: pc.SEMANTIC_POSITION, components: 3, type: pc.TYPE_FLOAT32 },
            { semantic: pc.SEMANTIC_TEXCOORD0, components: 2, type: pc.TYPE_FLOAT32 },
            { semantic: pc.SEMANTIC_COLOR, components: 4, type: pc.TYPE_UINT8, normalize: true }
        ]);
        this.vb = new pc.VertexBuffer(device, format, max * 4, { usage: pc.BUFFER_DYNAMIC });
        const storage = this.vb.lock() as ArrayBuffer;
        this.f32 = new Float32Array(storage);
        this.u32 = new Uint32Array(storage);
        this.vb.unlock();
        const idx = new Uint16Array(max * 6);
        for (let q = 0; q < max; q++) {
            const o = q * 4, i = q * 6;
            idx[i] = o; idx[i + 1] = o + 1; idx[i + 2] = o + 2; idx[i + 3] = o; idx[i + 4] = o + 2; idx[i + 5] = o + 3;
        }
        const ib = new pc.IndexBuffer(device, pc.INDEXFORMAT_UINT16, max * 6, pc.BUFFER_STATIC, idx.buffer);
        this.mesh = new pc.Mesh(device);
        this.mesh.vertexBuffer = this.vb;
        this.mesh.indexBuffer[0] = ib;
        this.mesh.primitive[0] = { type: pc.PRIMITIVE_TRIANGLES, base: 0, baseVertex: 0, count: 0, indexed: true };
        this.mesh.aabb = new pc.BoundingBox(new pc.Vec3(), new pc.Vec3(1e4, 1e4, 1e4));
        this.material = new pc.ShaderMaterial({
            uniqueName: `sbEffects_${mode}`,
            attributes: { aPosition: pc.SEMANTIC_POSITION, aUv0: pc.SEMANTIC_TEXCOORD0, aColor: pc.SEMANTIC_COLOR },
            vertexGLSL: VS,
            fragmentGLSL: FS
        });
        this.material.setParameter('uAtlas', atlas);
        this.material.setParameter('uIntensity', 1);
        if (mode === 'add') { this.material.setDefine('ADDITIVE', true); this.material.blendType = pc.BLEND_ADDITIVE; }
        else this.material.blendType = pc.BLEND_NORMAL;
        this.material.depthWrite = false;
        this.material.cull = pc.CULLFACE_NONE;
        if (mode === 'decal') { this.material.depthBias = -2; this.material.slopeDepthBias = -2; }
        this.material.update();
        this.mi = new pc.MeshInstance(this.mesh, this.material);
        this.mi.cull = false;
        this.mi.visible = false;
        const e = new pc.Entity(`effects-${mode}`);
        e.addComponent('render', { meshInstances: [this.mi], castShadows: false, receiveShadows: false });
        root.addChild(e);
    }

    begin(): void { this.count = 0; }

    /** One quad from four corners (x, y, z each) with the atlas cell and a colour (0..1, alpha included). */
    quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
        dx: number, dy: number, dz: number, cell: number, r: number, g: number, b: number, a: number): void {
        if (this.count >= this.max) return;
        const u0 = (cell % ATLAS_CELLS) / ATLAS_CELLS + 0.002, v0 = Math.floor(cell / ATLAS_CELLS) / ATLAS_CELLS + 0.002;
        const u1 = u0 + 1 / ATLAS_CELLS - 0.004, v1 = v0 + 1 / ATLAS_CELLS - 0.004;
        const col = ((Math.min(255, a * 255) & 255) << 24 | (Math.min(255, b * 255) & 255) << 16 |
            (Math.min(255, g * 255) & 255) << 8 | (Math.min(255, r * 255) & 255)) >>> 0;
        let o = this.count * 24;
        const f = this.f32, u = this.u32;
        f[o] = ax; f[o + 1] = ay; f[o + 2] = az; f[o + 3] = u0; f[o + 4] = v1; u[o + 5] = col; o += 6;
        f[o] = bx; f[o + 1] = by; f[o + 2] = bz; f[o + 3] = u1; f[o + 4] = v1; u[o + 5] = col; o += 6;
        f[o] = cx; f[o + 1] = cy; f[o + 2] = cz; f[o + 3] = u1; f[o + 4] = v0; u[o + 5] = col; o += 6;
        f[o] = dx; f[o + 1] = dy; f[o + 2] = dz; f[o + 3] = u0; f[o + 4] = v0; u[o + 5] = col;
        this.count++;
    }

    end(): void {
        this.mi.visible = this.count > 0;
        if (this.count === 0) return;
        this.mesh.primitive[0].count = this.count * 6;
        this.vb.lock();
        this.vb.unlock();
    }
}

/** Particle fields in one typed array each (structure of arrays). */
const P_FIELDS = 17;
// x y z vx vy vz age life size0 size1 rot spin gravity drag cell batch stretch | colour in separate arrays

/** Caps per tier: particles alive at once, decals kept, and tracers. */
const CAPS: Record<Tier, { particles: number; decals: number; spawn: number }> = {
    low: { particles: 160, decals: 48, spawn: 0.55 },
    high: { particles: 480, decals: 160, spawn: 1 }
};
const MAX_PARTICLES = 480;
const MAX_DECALS = 160;
const MAX_TRACERS = 24;
const DECAL_LIFE = 25;
const DECAL_FADE = 3;

export class Effects {
    private readonly add: QuadBatch;
    private readonly alpha: QuadBatch;
    private readonly decal: QuadBatch;
    private readonly clutter: QuadBatch;
    private readonly p = new Float32Array(MAX_PARTICLES * P_FIELDS);
    private readonly pc4 = new Float32Array(MAX_PARTICLES * 4);
    private pCount = 0;
    private readonly d = new Float32Array(MAX_DECALS * 12);   // x y z axis sign size rot cell r g b age
    private dNext = 0;
    private dCount = 0;
    private readonly t = new Float32Array(MAX_TRACERS * 12);  // ax ay az bx by bz age life width r g b
    private tNext = 0;
    private tier: Tier = 'low';
    private caps = CAPS.low;
    private readonly glowQ = new Float32Array(64 * 8);       // one-frame glows: x y z size r g b a
    private glowN = 0;
    private readonly shadowQ = new Float32Array(16 * 5);     // one-frame blob shadows: x y z radius alpha
    private shadowN = 0;
    private readonly cam = new Float32Array(9);              // position, right, up

    constructor(app: pc.Application) {
        const device = app.graphicsDevice;
        const atlas = new pc.Texture(device, {
            name: 'sb-effects-atlas', width: ATLAS_SIZE, height: ATLAS_SIZE, format: pc.PIXELFORMAT_RGBA8,
            mipmaps: true, minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR, magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE
        });
        atlas.setSource(makeAtlas());
        const root = new pc.Entity('effects');
        app.root.addChild(root);
        this.decal = new QuadBatch(device, MAX_DECALS, atlas, 'decal', root);
        this.clutter = new QuadBatch(device, 256, atlas, 'decal', root);
        this.alpha = new QuadBatch(device, MAX_PARTICLES + 16, atlas, 'alpha', root);
        this.add = new QuadBatch(device, MAX_PARTICLES + MAX_TRACERS + 64, atlas, 'add', root);
        this.setTier('low');
    }

    setTier(tier: Tier): void {
        this.tier = tier;
        this.caps = CAPS[tier];
        // High renders to a linear HDR target before tone mapping: bright additive light feeds the bloom.
        this.add.material.setParameter('uIntensity', tier === 'high' ? 2.2 : 1.1);
        this.clutter.mi.visible = tier === 'high' && this.clutter.count > 0;
        if (this.pCount > this.caps.particles) this.pCount = this.caps.particles;
        if (this.dCount > this.caps.decals) this.dCount = this.caps.decals;
    }

    get currentTier(): Tier { return this.tier; }

    setFog(t: LookTuning): void {
        const color = new Float32Array(t.fogColor);
        const fog = new Float32Array([t.fogStart, 1 / Math.max(1, t.fogEnd - t.fogStart), t.fogMax, 0]);
        for (const b of [this.add, this.alpha, this.decal, this.clutter]) {
            b.material.setParameter('uFogColor', color);
            b.material.setParameter('uFog', fog);
        }
    }

    /** A map change: every decal and particle goes, and the clutter is rebuilt for the new map. */
    reset(boxes: readonly Box[]): void {
        this.pCount = 0;
        this.dCount = 0;
        this.dNext = 0;
        for (let i = 0; i < MAX_TRACERS; i++) this.t[i * 12 + 6] = 1e9;
        this.buildClutter(boxes);
    }

    // ---- spawning -------------------------------------------------------------------------------

    private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size0: number, size1: number,
        gravity: number, drag: number, cell: number, additive: boolean, stretch: number, r: number, g: number, b: number, a: number): void {
        if (this.pCount >= this.caps.particles) return;
        const i = this.pCount++;
        const o = i * P_FIELDS, p = this.p;
        p[o] = x; p[o + 1] = y; p[o + 2] = z; p[o + 3] = vx; p[o + 4] = vy; p[o + 5] = vz;
        p[o + 6] = 0; p[o + 7] = life; p[o + 8] = size0; p[o + 9] = size1; p[o + 10] = rnd() * 6.283; p[o + 11] = spread(1.5);
        p[o + 12] = gravity; p[o + 13] = drag; p[o + 14] = cell; p[o + 15] = additive ? 1 : 0; p[o + 16] = stretch;
        const c = i * 4;
        this.pc4[c] = r; this.pc4[c + 1] = g; this.pc4[c + 2] = b; this.pc4[c + 3] = a;
    }

    /** How many of `n` to spawn in this tier (Low spawns fewer). */
    private n(count: number): number {
        return Math.max(1, Math.round(count * this.caps.spawn));
    }

    private addDecal(x: number, y: number, z: number, axis: number, sign: number, size: number, cell: number, r: number, g: number, b: number): void {
        const i = this.dNext;
        this.dNext = (this.dNext + 1) % this.caps.decals;
        if (this.dCount < this.caps.decals) this.dCount++;
        const o = i * 12, d = this.d;
        d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = axis; d[o + 4] = sign; d[o + 5] = size;
        d[o + 6] = rnd() * 6.283; d[o + 7] = cell; d[o + 8] = r; d[o + 9] = g; d[o + 10] = b; d[o + 11] = 0;
    }

    /** A tracer from a to b, `width` metres wide, fading over `life` seconds. */
    tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number, life: number): void {
        const o = this.tNext * 12;
        this.tNext = (this.tNext + 1) % MAX_TRACERS;
        const t = this.t;
        t[o] = ax; t[o + 1] = ay; t[o + 2] = az; t[o + 3] = bx; t[o + 4] = by; t[o + 5] = bz;
        t[o + 6] = 0; t[o + 7] = life; t[o + 8] = width; t[o + 9] = 1; t[o + 10] = 0.9; t[o + 11] = 0.6;
    }

    /**
     * A bullet hitting the map at (x, y, z) on a face with outward normal along `axis` (sign), coming from the
     * direction (dx, dy, dz) (unit, the way the bullet travelled). Dust, chips or sparks by surface, and a hole.
     */
    impact(x: number, y: number, z: number, axis: number, sign: number, surface: Surface, dx: number, dy: number, dz: number): void {
        const nx = axis === 0 ? sign : 0, ny = axis === 1 ? sign : 0, nz = axis === 2 ? sign : 0;
        // The bounce direction: the incoming ray reflected about the face, then mostly along the normal.
        const dot = dx * nx + dy * ny + dz * nz;
        const rx = (dx - 2 * dot * nx) * 0.4 + nx * 0.6, ry = (dy - 2 * dot * ny) * 0.4 + ny * 0.6, rz = (dz - 2 * dot * nz) * 0.4 + nz * 0.6;
        const px = x + nx * 0.02, py = y + ny * 0.02, pz = z + nz * 0.02;
        if (surface === 'metal') {
            for (let k = this.n(7); k > 0; k--) {
                const s = 3 + rnd() * 5;
                this.spawn(px, py, pz, (rx + spread(0.6)) * s, (ry + spread(0.6)) * s + 1, (rz + spread(0.6)) * s,
                    0.12 + rnd() * 0.18, 0.025, 0.012, 9, 2, CELL_STREAK, true, 0.035, 1, 0.75 + rnd() * 0.2, 0.35, 1);
            }
            this.spawn(px, py, pz, 0, 0, 0, 0.06, 0.12, 0.2, 0, 0, CELL_GLOW, true, 0, 1, 0.8, 0.45, 1);
            this.spawn(px, py, pz, rx * 0.4, ry * 0.4 + 0.2, rz * 0.4, 0.5, 0.06, 0.25, -0.2, 2, CELL_PUFF, false, 0, 0.42, 0.42, 0.42, 0.3);
            this.addDecal(x, y, z, axis, sign, 0.09, CELL_HOLE_METAL, 1, 1, 1);
            return;
        }
        const wood = surface === 'wood';
        const cr = wood ? 0.42 : 0.44, cg = wood ? 0.33 : 0.42, cb = wood ? 0.24 : 0.39;   // unlit: mid-dark so it never glows in the dark
        for (let k = this.n(3); k > 0; k--) {
            const s = 0.4 + rnd() * 0.8;
            this.spawn(px, py, pz, (rx + spread(0.5)) * s, (ry + spread(0.5)) * s + 0.2, (rz + spread(0.5)) * s,
                0.6 + rnd() * 0.5, 0.06, 0.32 + rnd() * 0.15, -0.3, 2.2, CELL_PUFF, false, 0, cr, cg, cb, 0.42);
        }
        for (let k = this.n(5); k > 0; k--) {
            const s = 2 + rnd() * 3;
            this.spawn(px, py, pz, (rx + spread(0.7)) * s, (ry + spread(0.7)) * s + 1.5, (rz + spread(0.7)) * s,
                0.35 + rnd() * 0.25, 0.018, 0.012, 12, 0.5, CELL_CHIP, false, 0, cr * 0.7, cg * 0.7, cb * 0.7, 1);
        }
        this.addDecal(x, y, z, axis, sign, wood ? 0.1 : 0.12, CELL_HOLE, 1, 1, 1);
    }

    /** A bullet hitting a player: a small puff (dark red for a defender, the shimmer's pale blue for a ghost). */
    bodyHit(x: number, y: number, z: number, dx: number, dy: number, dz: number, ghost: boolean): void {
        const r = ghost ? 0.6 : 0.42, g = ghost ? 0.75 : 0.05, b = ghost ? 0.95 : 0.04;
        for (let k = this.n(4); k > 0; k--) {
            this.spawn(x, y, z, -dx * 0.6 + spread(0.5), -dy * 0.6 + spread(0.4) + 0.2, -dz * 0.6 + spread(0.5),
                0.3 + rnd() * 0.2, 0.05, 0.22, 1, 3, CELL_PUFF, ghost, 0, r, g, b, ghost ? 0.5 : 0.7);
        }
    }

    /** A knife landing on a player standing at (x, y, z) (feet): a bright slash arc and a puff at the chest. */
    knifeHit(x: number, y: number, z: number, ghost: boolean): void {
        const cy = y + 1.15;
        this.spawn(x, cy, z, 0, 0, 0, 0.16, 0.35, 0.5, 0, 0, CELL_SLASH, true, 0, 1, 0.95, 0.85, 1);
        this.bodyHit(x, cy, z, 0, 0, 0, ghost);
    }

    /** Dust kicked up by a footstep at the feet position (x, y, z); `amount` 0..1 (a run is 1), `alpha` scales it. */
    footstep(x: number, y: number, z: number, amount: number, alpha: number): void {
        if (alpha <= 0.02) return;
        for (let k = this.n(2); k > 0; k--) {
            this.spawn(x + spread(0.15), y + 0.04, z + spread(0.15), spread(0.3), 0.15 + rnd() * 0.2, spread(0.3),
                0.5 + rnd() * 0.4, 0.08, 0.3 + 0.2 * amount, -0.1, 2, CELL_PUFF, false, 0, 0.46, 0.44, 0.4, 0.3 * alpha * (0.5 + 0.5 * amount));
        }
    }

    /** A wisp of smoke from a muzzle at (x, y, z) pointing (dx, dy, dz). */
    muzzleSmoke(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
        this.spawn(x, y, z, dx * 0.6 + spread(0.1), dy * 0.6 + 0.25, dz * 0.6 + spread(0.1), 0.7, 0.05, 0.3, -0.25, 1.5,
            CELL_SMOKE, false, 0, 0.5, 0.5, 0.5, 0.12);
    }

    /** The bomb going off at (x, y, z) (on the floor): fireball, smoke column, sparks and a scorch mark. */
    explosion(x: number, y: number, z: number): void {
        for (let k = this.n(16); k > 0; k--) {
            const a = rnd() * 6.283, s = 1.5 + rnd() * 3.5;
            this.spawn(x + spread(0.5), y + 0.7 + rnd() * 0.8, z + spread(0.5), Math.cos(a) * s, 1.5 + rnd() * 3, Math.sin(a) * s,
                0.45 + rnd() * 0.35, 0.5, 1.6 + rnd() * 0.9, -0.8, 3, CELL_SMOKE, true, 0, 1, 0.42 + rnd() * 0.18, 0.1, 0.55);
        }
        for (let k = this.n(14); k > 0; k--) {
            const a = rnd() * 6.283, s = 0.5 + rnd() * 2;
            this.spawn(x + spread(0.8), y + 0.8 + rnd(), z + spread(0.8), Math.cos(a) * s, 1 + rnd() * 2.5, Math.sin(a) * s,
                2.5 + rnd() * 2, 0.8, 2.6 + rnd() * 1.6, -0.35, 0.8, CELL_SMOKE, false, 0, 0.14, 0.13, 0.12, 0.6);
        }
        for (let k = this.n(28); k > 0; k--) {
            const a = rnd() * 6.283, e = rnd() * 1.2, s = 6 + rnd() * 10;
            this.spawn(x, y + 0.5, z, Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + 2, Math.sin(a) * Math.cos(e) * s,
                0.5 + rnd() * 0.6, 0.04, 0.015, 9, 0.6, CELL_STREAK, true, 0.06, 1, 0.65, 0.25, 1);
        }
        this.spawn(x, y + 1, z, 0, 0, 0, 0.3, 1.5, 4.5, 0, 0, CELL_GLOW, true, 0, 1, 0.6, 0.25, 0.8);
        this.addDecal(x, y + 0.001, z, 1, 1, 2.6, CELL_SCORCH, 1, 1, 1);
    }

    /** A glow sprite for this frame only (the bomb's light, a muzzle's bloom): call every frame it should show. */
    glow(x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number): void {
        if (this.glowN >= 64) return;
        const o = this.glowN++ * 8, q = this.glowQ;
        q[o] = x; q[o + 1] = y; q[o + 2] = z; q[o + 3] = size; q[o + 4] = r; q[o + 5] = g; q[o + 6] = b; q[o + 7] = a;
    }

    /** A soft shadow on the floor under a player for this frame only (feet at x, y, z). */
    blobShadow(x: number, y: number, z: number, radius: number, alpha: number): void {
        if (this.shadowN >= 16 || alpha <= 0.01) return;
        const o = this.shadowN++ * 5, q = this.shadowQ;
        q[o] = x; q[o + 1] = y; q[o + 2] = z; q[o + 3] = radius; q[o + 4] = alpha;
    }

    // ---- static clutter (High) ------------------------------------------------------------------

    /**
     * Denser floor detail for the High tier, built once per map into its own batch: stains, cracks and loose paper
     * on walkable floors, kept off spots covered by a solid. Placement is a fixed hash of the floor box, so it is the
     * same on every machine.
     */
    private buildClutter(boxes: readonly Box[]): void {
        const c = this.clutter;
        c.begin();
        let h = 0x9e3779b9;
        const hr = (): number => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
        const blocked = (x: number, y: number, z: number): boolean => {
            for (let i = 0; i < boxes.length; i++) {
                const b = boxes[i];
                if (x > b.min[0] - 0.3 && x < b.max[0] + 0.3 && z > b.min[2] - 0.3 && z < b.max[2] + 0.3 && b.max[1] > y + 0.01 && b.min[1] < y + 1.5) return true;
            }
            return false;
        };
        for (let i = 0; i < boxes.length && c.count < c.max; i++) {
            const b = boxes[i];
            if (b.category !== 'floor' && b.category !== 'deck' && b.category !== 'floor_tiles') continue;
            const area = (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
            const n = Math.min(60, Math.round(area / 9));
            const y = b.max[1] + 0.004;
            for (let k = 0; k < n && c.count < c.max; k++) {
                const x = b.min[0] + 0.5 + hr() * (b.max[0] - b.min[0] - 1);
                const z = b.min[2] + 0.5 + hr() * (b.max[2] - b.min[2] - 1);
                const kind = hr() * 0.8;
                const size = kind < 0.5 ? 0.5 + hr() * 0.9 : 0.4 + hr() * 0.5;
                if (blocked(x, y, z)) continue;
                const rot = hr() * 6.283, cs = Math.cos(rot) * size, sn = Math.sin(rot) * size;
                // Decals are unlit, so clutter only darkens: oil and water stains, and cracks.
                const cell = kind < 0.5 ? CELL_STAIN : CELL_CRACK;
                const alpha = kind < 0.5 ? 0.3 + hr() * 0.15 : 0.4;
                c.quad(x - cs + sn, y, z - sn - cs, x + cs + sn, y, z + sn - cs, x + cs - sn, y, z + sn + cs, x - cs - sn, y, z - sn + cs,
                    cell, 0.03, 0.03, 0.025, alpha);
            }
        }
        c.end();
        c.mi.visible = this.tier === 'high' && c.count > 0;
    }

    /** How many clutter decals the map got (for the review numbers). */
    get clutterCount(): number { return this.clutter.count; }

    // ---- per frame ----------------------------------------------------------------------------

    /** Steps every effect by `dt` and writes the batches for `camera`. Allocation-free. */
    update(dt: number, camera: pc.Entity): void {
        const m = camera.getWorldTransform().data;
        const cam = this.cam;
        cam[0] = m[12]; cam[1] = m[13]; cam[2] = m[14];
        cam[3] = m[0]; cam[4] = m[1]; cam[5] = m[2];
        cam[6] = m[4]; cam[7] = m[5]; cam[8] = m[6];
        this.add.begin();
        this.alpha.begin();
        this.updateParticles(dt);
        this.updateTracers(dt);
        this.drawGlows();
        this.drawShadows();
        this.add.end();
        this.alpha.end();
        this.updateDecals(dt);
    }

    private updateParticles(dt: number): void {
        const p = this.p, col = this.pc4, cam = this.cam;
        const rx = cam[3], ry = cam[4], rz = cam[5], ux = cam[6], uy = cam[7], uz = cam[8];
        let i = 0;
        while (i < this.pCount) {
            const o = i * P_FIELDS;
            const age = p[o + 6] + dt;
            if (age >= p[o + 7]) {
                // swap-remove with the last live particle
                const last = --this.pCount;
                if (i !== last) {
                    p.copyWithin(o, last * P_FIELDS, last * P_FIELDS + P_FIELDS);
                    col.copyWithin(i * 4, last * 4, last * 4 + 4);
                }
                continue;
            }
            p[o + 6] = age;
            const drag = Math.exp(-p[o + 13] * dt);
            p[o + 3] *= drag; p[o + 5] *= drag;
            p[o + 4] = p[o + 4] * drag - p[o + 12] * dt;
            p[o] += p[o + 3] * dt; p[o + 1] += p[o + 4] * dt; p[o + 2] += p[o + 5] * dt;
            p[o + 10] += p[o + 11] * dt;
            const u = age / p[o + 7];
            const size = p[o + 8] + (p[o + 9] - p[o + 8]) * Math.sqrt(u);
            const fade = u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85;
            const c = i * 4;
            const batch = p[o + 15] > 0 ? this.add : this.alpha;
            const x = p[o], y = p[o + 1], z = p[o + 2];
            const stretch = p[o + 16];
            if (stretch > 0) {
                // Along the velocity, facing the camera: a streak whose length follows the speed.
                let ax = p[o + 3], ay = p[o + 4], az = p[o + 5];
                const sp = Math.sqrt(ax * ax + ay * ay + az * az) + 1e-5;
                const len = Math.min(0.5, sp * stretch);
                ax /= sp; ay /= sp; az /= sp;
                const vx = cam[0] - x, vy = cam[1] - y, vz = cam[2] - z;
                let sx = ay * vz - az * vy, sy = az * vx - ax * vz, sz = ax * vy - ay * vx;
                const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) + 1e-5;
                sx *= size / sl; sy *= size / sl; sz *= size / sl;
                ax *= len; ay *= len; az *= len;
                batch.quad(x - ax - sx, y - ay - sy, z - az - sz, x + ax - sx, y + ay - sy, z + az - sz,
                    x + ax + sx, y + ay + sy, z + az + sz, x - ax + sx, y - ay + sy, z - az + sz,
                    p[o + 14], col[c], col[c + 1], col[c + 2], col[c + 3] * fade);
            } else {
                const cs = Math.cos(p[o + 10]) * size, sn = Math.sin(p[o + 10]) * size;
                const ax = rx * cs + ux * sn, ay = ry * cs + uy * sn, az = rz * cs + uz * sn;
                const bx = -rx * sn + ux * cs, by = -ry * sn + uy * cs, bz = -rz * sn + uz * cs;
                batch.quad(x - ax - bx, y - ay - by, z - az - bz, x + ax - bx, y + ay - by, z + az - bz,
                    x + ax + bx, y + ay + by, z + az + bz, x - ax + bx, y - ay + by, z - az + bz,
                    p[o + 14], col[c], col[c + 1], col[c + 2], col[c + 3] * fade);
            }
            i++;
        }
    }

    private updateTracers(dt: number): void {
        const t = this.t, cam = this.cam;
        for (let i = 0; i < MAX_TRACERS; i++) {
            const o = i * 12;
            if (t[o + 6] >= t[o + 7]) continue;
            t[o + 6] += dt;
            const k = 1 - t[o + 6] / t[o + 7];
            if (k <= 0) continue;
            const ax = t[o], ay = t[o + 1], az = t[o + 2], bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
            const dx = bx - ax, dy = by - ay, dz = bz - az;
            const mx = (ax + bx) * 0.5 - cam[0], my = (ay + by) * 0.5 - cam[1], mz = (az + bz) * 0.5 - cam[2];
            let sx = dy * mz - dz * my, sy = dz * mx - dx * mz, sz = dx * my - dy * mx;
            const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) + 1e-6;
            const w = t[o + 8] * 0.5 / sl;
            sx *= w; sy *= w; sz *= w;
            this.add.quad(ax - sx, ay - sy, az - sz, bx - sx, by - sy, bz - sz, bx + sx, by + sy, bz + sz, ax + sx, ay + sy, az + sz,
                CELL_TRACER, t[o + 9], t[o + 10], t[o + 11], 0.9 * k);
        }
    }

    private drawGlows(): void {
        const q = this.glowQ, cam = this.cam;
        const rx = cam[3], ry = cam[4], rz = cam[5], ux = cam[6], uy = cam[7], uz = cam[8];
        for (let i = 0; i < this.glowN; i++) {
            const o = i * 8, x = q[o], y = q[o + 1], z = q[o + 2], s = q[o + 3];
            this.add.quad(x - (rx + ux) * s, y - (ry + uy) * s, z - (rz + uz) * s, x + (rx - ux) * s, y + (ry - uy) * s, z + (rz - uz) * s,
                x + (rx + ux) * s, y + (ry + uy) * s, z + (rz + uz) * s, x - (rx - ux) * s, y - (ry - uy) * s, z - (rz - uz) * s,
                CELL_GLOW, q[o + 4], q[o + 5], q[o + 6], q[o + 7]);
        }
        this.glowN = 0;
    }

    private drawShadows(): void {
        const q = this.shadowQ;
        for (let i = 0; i < this.shadowN; i++) {
            const o = i * 5, x = q[o], y = q[o + 1] + 0.025, z = q[o + 2], r = q[o + 3];
            this.alpha.quad(x - r, y, z + r, x + r, y, z + r, x + r, y, z - r, x - r, y, z - r, CELL_SHADOW, 0, 0, 0, q[o + 4]);
        }
        this.shadowN = 0;
    }

    private updateDecals(dt: number): void {
        const d = this.d, b = this.decal;
        b.begin();
        for (let i = 0; i < this.dCount; i++) {
            const o = i * 12;
            const age = d[o + 11] + dt;
            d[o + 11] = age;
            if (age >= DECAL_LIFE) continue;
            const a = age > DECAL_LIFE - DECAL_FADE ? (DECAL_LIFE - age) / DECAL_FADE : 1;
            const axis = d[o + 3], sign = d[o + 4], s = d[o + 5], rot = d[o + 6];
            const lift = 0.006 * sign;
            const x = d[o] + (axis === 0 ? lift : 0), y = d[o + 1] + (axis === 1 ? lift : 0), z = d[o + 2] + (axis === 2 ? lift : 0);
            const cs = Math.cos(rot) * s, sn = Math.sin(rot) * s;
            // Two tangents of the face, rotated by `rot`.
            if (axis === 0) {
                b.quad(x, y - cs + sn, z - sn - cs, x, y + cs + sn, z + sn - cs, x, y + cs - sn, z + sn + cs, x, y - cs - sn, z - sn + cs,
                    d[o + 7], d[o + 8], d[o + 9], d[o + 10], a);
            } else if (axis === 1) {
                b.quad(x - cs + sn, y, z - sn - cs, x + cs + sn, y, z + sn - cs, x + cs - sn, y, z + sn + cs, x - cs - sn, y, z - sn + cs,
                    d[o + 7], d[o + 8], d[o + 9], d[o + 10], a);
            } else {
                b.quad(x - cs + sn, y - sn - cs, z, x + cs + sn, y + sn - cs, z, x + cs - sn, y + sn + cs, z, x - cs - sn, y - sn + cs, z,
                    d[o + 7], d[o + 8], d[o + 9], d[o + 10], a);
            }
        }
        b.end();
    }
}
