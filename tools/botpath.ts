// Path finding for the scripted test bot (tools/bot.ts): a grid over one floor level, walkable where a
// standing hull fits on a floor box, searched with A*. Good enough to walk a bot from the ghost spawn to a
// bomb site on the same level for scripted checks; it is not the navigation package E will build (no
// stairs, jumps or drops, and it walks close to corners).
import { HULL_HALF_WIDTH, HULL_HEIGHT, STEP_HEIGHT } from '../shared/constants';
import type { MapData, Vec3 } from '../shared/types';

const CELL = 0.25;
/** Extra clearance around the hull so the bot does not scrape walls. */
const MARGIN = 0.1;

/** Waypoints (feet positions) from `from` to `to` over the floor at height `from[1]`, or null when there is no way. */
export function findPath(map: MapData, from: Vec3, to: Vec3): Vec3[] | null {
    const y = from[1];
    const x0 = map.bounds.min[0], z0 = map.bounds.min[2];
    const w = Math.ceil((map.bounds.max[0] - x0) / CELL), d = Math.ceil((map.bounds.max[2] - z0) / CELL);
    const r = HULL_HALF_WIDTH + MARGIN;
    const open = new Uint8Array(w * d);
    for (let i = 0; i < w; i++) {
        for (let k = 0; k < d; k++) {
            const cx = x0 + (i + 0.5) * CELL, cz = z0 + (k + 0.5) * CELL;
            let floor = false, blocked = false;
            for (const b of map.boxes) {
                const top = b.max[1];
                if (cx >= b.min[0] && cx <= b.max[0] && cz >= b.min[2] && cz <= b.max[2] && top >= y - 0.05 && top <= y + STEP_HEIGHT) floor = true;
                if (cx + r > b.min[0] && cx - r < b.max[0] && cz + r > b.min[2] && cz - r < b.max[2] &&
                    b.min[1] < y + HULL_HEIGHT && top > y + STEP_HEIGHT) blocked = true;
            }
            open[i + k * w] = floor && !blocked ? 1 : 0;
        }
    }
    const cellOf = (p: Vec3): number => {
        const i = Math.min(w - 1, Math.max(0, Math.floor((p[0] - x0) / CELL)));
        const k = Math.min(d - 1, Math.max(0, Math.floor((p[2] - z0) / CELL)));
        return i + k * w;
    };
    const start = cellOf(from);
    // A goal inside a solid (a bomb site's centre under a crate) becomes the nearest open cell within 4 m.
    let goal = cellOf(to);
    if (!open[goal]) {
        const gi = goal % w, gk = Math.floor(goal / w);
        let best = -1, bestD = Infinity;
        const r = Math.ceil(4 / CELL);
        for (let di = -r; di <= r; di++) {
            for (let dk = -r; dk <= r; dk++) {
                const ni = gi + di, nk = gk + dk;
                if (ni < 0 || nk < 0 || ni >= w || nk >= d || !open[ni + nk * w]) continue;
                const dd = di * di + dk * dk;
                if (dd < bestD) { bestD = dd; best = ni + nk * w; }
            }
        }
        if (best >= 0) goal = best;
    }
    const cost = new Float64Array(w * d).fill(Infinity);
    const came = new Int32Array(w * d).fill(-1);
    const h = (c: number): number => Math.hypot((c % w) - (goal % w), Math.floor(c / w) - Math.floor(goal / w));
    const queue: [number, number][] = [[h(start), start]];
    cost[start] = 0;
    open[start] = 1;
    open[goal] = 1;
    while (queue.length) {
        let best = 0;
        for (let q = 1; q < queue.length; q++) if (queue[q][0] < queue[best][0]) best = q;
        const [, c] = queue.splice(best, 1)[0];
        if (c === goal) break;
        const ci = c % w, ck = Math.floor(c / w);
        for (let di = -1; di <= 1; di++) {
            for (let dk = -1; dk <= 1; dk++) {
                if (!di && !dk) continue;
                const ni = ci + di, nk = ck + dk;
                if (ni < 0 || nk < 0 || ni >= w || nk >= d) continue;
                const n = ni + nk * w;
                if (!open[n] || (di && dk && (!open[ci + di + ck * w] || !open[ci + nk * w]))) continue;
                const nc = cost[c] + (di && dk ? Math.SQRT2 : 1);
                if (nc >= cost[n]) continue;
                cost[n] = nc;
                came[n] = c;
                queue.push([nc + h(n), n]);
            }
        }
    }
    if (cost[goal] === Infinity) return null;
    const cells: number[] = [];
    for (let c = goal; c !== -1; c = came[c]) cells.push(c);
    cells.reverse();
    // Keep only the turns, so the bot heads straight between them.
    const path: Vec3[] = [];
    for (let n = 1; n < cells.length; n++) {
        const a = cells[n - 1], b = cells[n], c = cells[n + 1];
        if (c !== undefined && b - a === c - b) continue;
        path.push([x0 + ((b % w) + 0.5) * CELL, y, z0 + (Math.floor(b / w) + 0.5) * CELL]);
    }
    path.push([to[0], y, to[2]]);
    return path;
}

/** The centre of each bomb site whose floor is at the level `y`. */
export function sitesAt(map: MapData, y: number): Vec3[] {
    return map.bombSites
        .filter(s => Math.abs(s.min[1] - y) < 0.5)
        .map(s => [(s.min[0] + s.max[0]) / 2, s.min[1], (s.min[2] + s.max[2]) / 2] as Vec3);
}
