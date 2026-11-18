import type { Box, Vec3 } from '@shared/types';

/**
 * Light probes for the players and the first-person weapon (package Q). Presentation only: nothing here feeds the
 * simulation, and it reads only the map (its boxes and its baked look), never another player.
 *
 * The world is drawn from a lightmap baked in Blender; players and weapons are lit at run time. To make them match
 * where they stand (dark in the basement, bright in the yard), each probe looks around from its point: rays against
 * the map's boxes find the surfaces around it, and `ProbeSource.surface` gives the light leaving each hit (the baked
 * light times the surface's colour, read from small CPU copies of the map's textures, client/src/lighting.ts). Rays
 * that leave the map see the sky. The result is an "ambient cube": the light arriving from +X, -X, +Y, -Y, +Z and -Z
 * (each a cosine-weighted average of what the rays saw), plus how much of the sun reaches the point (a few rays toward
 * it from points around the probe, so the edge of a shadow is soft).
 *
 * Probes sit on a grid (`cell` metres) over the map's bounds and are computed lazily, the first time a sample needs
 * them, into preallocated arrays (no allocation per sample). A sample blends the 8 probes around it (trilinear),
 * skipping probes buried in solids.
 */

/** Floats per probe and per sample: the ambient cube (6 x rgb), then the sun's visibility 0..1. */
export const PROBE_SIZE = 19;
export const SUN_VIS = 18;

export interface ProbeSource {
    /** Solids: what rays hit. */
    readonly boxes: readonly Box[];
    /** The grid covers these bounds. */
    readonly min: Vec3;
    readonly max: Vec3;
    /**
     * Linear light leaving the face of a box at (x, y, z): the face is the one whose normal is +/- `axis` (`sign`).
     * Writes rgb into `out` and returns true, or returns false if nothing is known there (the ray is then ignored).
     */
    surface(x: number, y: number, z: number, axis: number, sign: number, out: Float32Array): boolean;
    /** Linear light from the sky in direction (dx, dy, dz) (unit), into `out`. */
    sky(dx: number, dy: number, dz: number, out: Float32Array): void;
    /** Unit vector toward the sun. */
    readonly sunDir: Vec3;
}

/** Rays per probe (a Fibonacci sphere: even coverage, the same every time). */
export const PROBE_RAYS = 48;
/** Beyond this a ray is taken to reach the sky. */
const RAY_MAX = 90;
/** Points around the probe (metres) from which the sun is tested; their average is the visibility. */
const SUN_OFFSETS: readonly number[] = [0, 0, 0, 0.3, 0, 0, -0.3, 0, 0, 0, 0, 0.3, 0, 0, -0.3, 0, 0.25, 0];
/** Where to look for open space when a probe's centre is inside a solid (fractions of a cell). */
const NUDGES: readonly number[] = [0, 0, 0, 0, 0.45, 0, 0, -0.45, 0, 0.45, 0, 0, -0.45, 0, 0, 0, 0, 0.45, 0, 0, -0.45];

const DIRS = ((): Float32Array => {
    const d = new Float32Array(PROBE_RAYS * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < PROBE_RAYS; i++) {
        const y = 1 - ((i + 0.5) / PROBE_RAYS) * 2;
        const r = Math.sqrt(1 - y * y);
        const a = golden * i;
        d[i * 3] = Math.cos(a) * r;
        d[i * 3 + 1] = y;
        d[i * 3 + 2] = Math.sin(a) * r;
    }
    return d;
})();

/** Ray hit, filled by `trace`. */
interface Hit { t: number; axis: number; sign: number }

/** Is the point inside any box (by more than a millimetre)? */
export function insideSolid(boxes: readonly Box[], x: number, y: number, z: number): boolean {
    const e = 1e-3;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (x > b.min[0] + e && x < b.max[0] - e && y > b.min[1] + e && y < b.max[1] - e && z > b.min[2] + e && z < b.max[2] - e) return true;
    }
    return false;
}

/** Nearest box face hit along the ray (origin outside every box), within `maxT`: fills `hit`, false if none. */
export function trace(boxes: readonly Box[], ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    maxT: number, hit: Hit): boolean {
    let best = maxT, axis = -1, sign = 0;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        let t0x = (b.min[0] - ox) * ix, t1x = (b.max[0] - ox) * ix;
        if (t0x > t1x) { const s = t0x; t0x = t1x; t1x = s; }
        let t0y = (b.min[1] - oy) * iy, t1y = (b.max[1] - oy) * iy;
        if (t0y > t1y) { const s = t0y; t0y = t1y; t1y = s; }
        let t0z = (b.min[2] - oz) * iz, t1z = (b.max[2] - oz) * iz;
        if (t0z > t1z) { const s = t0z; t0z = t1z; t1z = s; }
        let tn = t0x, a = 0;
        if (t0y > tn) { tn = t0y; a = 1; }
        if (t0z > tn) { tn = t0z; a = 2; }
        const tf = Math.min(t1x, t1y, t1z);
        if (tn > tf || tn < 0 || tn >= best) continue; // missed, behind, inside, or farther than the best
        best = tn;
        axis = a;
        sign = a === 0 ? (dx > 0 ? -1 : 1) : a === 1 ? (dy > 0 ? -1 : 1) : (dz > 0 ? -1 : 1);
    }
    if (axis < 0) return false;
    hit.t = best; hit.axis = axis; hit.sign = sign;
    return true;
}

export class LightProbes {
    readonly cell: number;
    readonly nx: number;
    readonly ny: number;
    readonly nz: number;
    /** Probes computed so far (for tests and the debug line). */
    computed = 0;
    private readonly ox: number;
    private readonly oy: number;
    private readonly oz: number;
    private readonly data: Float32Array;
    /** Per probe: 0 not computed yet, 1 valid, 2 buried in solids (skipped by samples). */
    private readonly state: Uint8Array;
    private readonly hit: Hit = { t: 0, axis: 0, sign: 0 };
    private readonly rgb = new Float32Array(3);
    private readonly sum = new Float32Array(18);
    private readonly wsum = new Float32Array(6);

    constructor(private readonly src: ProbeSource, cell = 1) {
        this.cell = cell;
        this.ox = src.min[0]; this.oy = src.min[1]; this.oz = src.min[2];
        this.nx = Math.max(1, Math.ceil((src.max[0] - src.min[0]) / cell));
        this.ny = Math.max(1, Math.ceil((src.max[1] - src.min[1]) / cell));
        this.nz = Math.max(1, Math.ceil((src.max[2] - src.min[2]) / cell));
        const n = this.nx * this.ny * this.nz;
        this.data = new Float32Array(n * PROBE_SIZE);
        this.state = new Uint8Array(n);
    }

    /**
     * The lighting at (x, y, z), blended from the 8 probes around it, into `out` (PROBE_SIZE floats). Returns false
     * (leaving `out` unchanged) when every probe around the point is buried in solids.
     */
    sample(x: number, y: number, z: number, out: Float32Array): boolean {
        const c = this.cell;
        // Probe centres sit at origin + (i + 0.5) * cell.
        const fx = Math.min(Math.max((x - this.ox) / c - 0.5, 0), this.nx - 1);
        const fy = Math.min(Math.max((y - this.oy) / c - 0.5, 0), this.ny - 1);
        const fz = Math.min(Math.max((z - this.oz) / c - 0.5, 0), this.nz - 1);
        const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
        const tx = fx - x0, ty = fy - y0, tz = fz - z0;
        let wTotal = 0;
        for (let k = 0; k < 8; k++) {
            const ix = Math.min(x0 + (k & 1), this.nx - 1);
            const iy = Math.min(y0 + ((k >> 1) & 1), this.ny - 1);
            const iz = Math.min(z0 + ((k >> 2) & 1), this.nz - 1);
            const w = ((k & 1) ? tx : 1 - tx) * (((k >> 1) & 1) ? ty : 1 - ty) * (((k >> 2) & 1) ? tz : 1 - tz);
            if (w <= 0) continue;
            const i = ix + this.nx * (iy + this.ny * iz);
            if (this.state[i] === 0) this.compute(i, ix, iy, iz);
            if (this.state[i] !== 1) continue;
            const o = i * PROBE_SIZE;
            if (wTotal === 0) for (let j = 0; j < PROBE_SIZE; j++) out[j] = 0;
            for (let j = 0; j < PROBE_SIZE; j++) out[j] += this.data[o + j] * w;
            wTotal += w;
        }
        if (wTotal <= 0) return false;
        const inv = 1 / wTotal;
        for (let j = 0; j < PROBE_SIZE; j++) out[j] *= inv;
        return true;
    }

    private compute(i: number, ix: number, iy: number, iz: number): void {
        const src = this.src, boxes = src.boxes, c = this.cell;
        const cx = this.ox + (ix + 0.5) * c, cy = this.oy + (iy + 0.5) * c, cz = this.oz + (iz + 0.5) * c;
        let px = 0, py = 0, pz = 0, found = false;
        for (let n = 0; n < NUDGES.length && !found; n += 3) {
            px = cx + NUDGES[n] * c; py = cy + NUDGES[n + 1] * c; pz = cz + NUDGES[n + 2] * c;
            found = !insideSolid(boxes, px, py, pz);
        }
        this.computed++;
        if (!found) { this.state[i] = 2; return; }
        const sum = this.sum, wsum = this.wsum, rgb = this.rgb, hit = this.hit;
        sum.fill(0);
        wsum.fill(0);
        for (let r = 0; r < PROBE_RAYS; r++) {
            const dx = DIRS[r * 3], dy = DIRS[r * 3 + 1], dz = DIRS[r * 3 + 2];
            if (trace(boxes, px, py, pz, dx, dy, dz, RAY_MAX, hit)) {
                if (!src.surface(px + dx * hit.t, py + dy * hit.t, pz + dz * hit.t, hit.axis, hit.sign, rgb)) continue;
            } else {
                src.sky(dx, dy, dz, rgb);
            }
            // Cosine weights onto the six faces of the cube.
            for (let a = 0; a < 6; a++) {
                const comp = a < 2 ? dx : a < 4 ? dy : dz;
                const w = (a & 1) ? -comp : comp;
                if (w <= 0) continue;
                sum[a * 3] += rgb[0] * w; sum[a * 3 + 1] += rgb[1] * w; sum[a * 3 + 2] += rgb[2] * w;
                wsum[a] += w;
            }
        }
        const o = i * PROBE_SIZE;
        for (let a = 0; a < 6; a++) {
            const inv = wsum[a] > 0 ? 1 / wsum[a] : 0;
            this.data[o + a * 3] = sum[a * 3] * inv;
            this.data[o + a * 3 + 1] = sum[a * 3 + 1] * inv;
            this.data[o + a * 3 + 2] = sum[a * 3 + 2] * inv;
        }
        // The sun: the share of points around the probe that see it.
        const s = src.sunDir;
        let lit = 0, tried = 0;
        for (let n = 0; n < SUN_OFFSETS.length; n += 3) {
            const qx = px + SUN_OFFSETS[n], qy = py + SUN_OFFSETS[n + 1], qz = pz + SUN_OFFSETS[n + 2];
            if (insideSolid(boxes, qx, qy, qz)) continue;
            tried++;
            if (!trace(boxes, qx, qy, qz, s[0], s[1], s[2], RAY_MAX * 2, hit)) lit++;
        }
        this.data[o + SUN_VIS] = tried > 0 ? lit / tried : 0;
        this.state[i] = 1;
    }
}
