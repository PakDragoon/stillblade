import type { Box, Vec3 } from './types';

const EPS = 1e-4;

/**
 * How far a hull can travel along one axis before touching a box.
 * Returns `d` clamped toward zero. Faces that merely touch on the other two axes do not block,
 * which is what lets the hull slide along walls and floors.
 */
export function sweepAxis(boxes: readonly Box[], hmin: Vec3, hmax: Vec3, axis: 0 | 1 | 2, d: number): number {
    if (d === 0) return 0;
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (hmax[u] <= b.min[u] + EPS || hmin[u] >= b.max[u] - EPS) continue;
        if (hmax[v] <= b.min[v] + EPS || hmin[v] >= b.max[v] - EPS) continue;
        if (d > 0) {
            if (b.min[axis] >= hmax[axis] - EPS) {
                const gap = b.min[axis] - hmax[axis];
                if (gap < d) d = gap > 0 ? gap : 0;
            }
        } else if (b.max[axis] <= hmin[axis] + EPS) {
            const gap = b.max[axis] - hmin[axis];
            if (gap > d) d = gap < 0 ? gap : 0;
        }
    }
    return d;
}

export function overlapsAny(boxes: readonly Box[], hmin: Vec3, hmax: Vec3): boolean {
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (
            hmax[0] > b.min[0] + EPS && hmin[0] < b.max[0] - EPS &&
            hmax[1] > b.min[1] + EPS && hmin[1] < b.max[1] - EPS &&
            hmax[2] > b.min[2] + EPS && hmin[2] < b.max[2] - EPS
        ) return true;
    }
    return false;
}

/** A player hull expressed as min/max corners, moved in place by the sweeps below. */
export class Hull {
    readonly min: Vec3 = [0, 0, 0];
    readonly max: Vec3 = [0, 0, 0];

    set(feet: Vec3, halfWidth: number, height: number): this {
        this.min[0] = feet[0] - halfWidth; this.max[0] = feet[0] + halfWidth;
        this.min[1] = feet[1];             this.max[1] = feet[1] + height;
        this.min[2] = feet[2] - halfWidth; this.max[2] = feet[2] + halfWidth;
        return this;
    }

    copy(o: Hull): this {
        for (let i = 0; i < 3; i++) { this.min[i] = o.min[i]; this.max[i] = o.max[i]; }
        return this;
    }

    /** Sweeps along one axis, moves by the allowed amount and returns it. */
    move(boxes: readonly Box[], axis: 0 | 1 | 2, d: number): number {
        const moved = sweepAxis(boxes, this.min, this.max, axis, d);
        this.min[axis] += moved;
        this.max[axis] += moved;
        return moved;
    }

    /** Horizontal slide: X then Z. Returns a bitmask: 1 if X was blocked, 2 if Z was blocked. */
    slideXZ(boxes: readonly Box[], dx: number, dz: number): number {
        const mx = this.move(boxes, 0, dx);
        const mz = this.move(boxes, 2, dz);
        return (mx !== dx ? 1 : 0) | (mz !== dz ? 2 : 0);
    }
}
