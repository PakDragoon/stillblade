import type { Box, Vec3 } from './types';

/** Unit view direction for a yaw/pitch in radians (yaw 0 faces -Z, positive pitch looks up). */
export function viewDir(yaw: number, pitch: number, out: Vec3): Vec3 {
    const c = Math.cos(pitch);
    out[0] = -Math.sin(yaw) * c;
    out[1] = Math.sin(pitch);
    out[2] = -Math.cos(yaw) * c;
    return out;
}

/** Distance along a ray (unit `dir`) to where it enters a box; Infinity on a miss, 0 if it starts inside. */
export function rayBox(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3): number {
    let near = 0, far = Infinity;
    for (let i = 0; i < 3; i++) {
        if (Math.abs(dir[i]) < 1e-9) {
            if (origin[i] < min[i] || origin[i] > max[i]) return Infinity;
            continue;
        }
        const inv = 1 / dir[i];
        let t1 = (min[i] - origin[i]) * inv;
        let t2 = (max[i] - origin[i]) * inv;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > near) near = t1;
        if (t2 < far) far = t2;
        if (near > far) return Infinity;
    }
    return near;
}

/** Distance to the nearest world box along a ray, capped at `maxDist`. */
export function rayWorld(boxes: readonly Box[], origin: Vec3, dir: Vec3, maxDist: number): number {
    let best = maxDist;
    for (let i = 0; i < boxes.length; i++) {
        const t = rayBox(origin, dir, boxes[i].min, boxes[i].max);
        if (t < best) best = t;
    }
    return best;
}
