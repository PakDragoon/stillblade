import type { Vec3 } from './types';

/**
 * The bots' navigation graph, exported by the map verifier (`nav_graph` in tools/blender/mapkit.py)
 * into the map JSON as `nav`. Nodes are feet positions (engine coordinates) on the walkable space,
 * about one per square metre and floor; an edge means a player walking the straight line from one
 * node to the other gets there with ordinary moves (walk, a stair, a jump or a drop).
 *
 * File format (flat arrays to keep the JSON small): `nodes` is x, y, z per node; `edges` is
 * from, to, kind per link, where kind is NAV_WALK, NAV_STEP, NAV_JUMP or NAV_DROP, plus NAV_BOTH
 * when the same link also goes the other way.
 */
export interface NavData {
    /** Side of the blocks the nodes were grouped by (metres). */
    cell: number;
    nodes: number[];
    edges: number[];
}

export const NAV_WALK = 0;
export const NAV_STEP = 1;
export const NAV_JUMP = 2;
export const NAV_DROP = 3;
export const NAV_BOTH = 4;

/** Extra cost of a jump and a drop, in metres of walking: a bot takes them only when they save time. */
const JUMP_COST = 1.5;
const DROP_COST = 0.5;
/** Spatial buckets for `nearest` (metres). */
const BUCKET = 2;

/**
 * The graph in a form fast to search: adjacency in flat typed arrays, a bucket grid for the
 * nearest-node lookup, and scratch arrays reused by every search (one search at a time).
 */
export class NavGraph {
    readonly count: number;
    readonly x: Float32Array;
    readonly y: Float32Array;
    readonly z: Float32Array;
    /** Edges leaving node n are `first[n]` to `first[n + 1] - 1`. */
    private readonly first: Int32Array;
    readonly to: Int32Array;
    readonly kind: Uint8Array;
    readonly cost: Float32Array;
    private readonly bx0: number;
    private readonly bz0: number;
    private readonly bw: number;
    private readonly bh: number;
    private readonly bucketFirst: Int32Array;
    private readonly bucketNodes: Int32Array;
    // A* scratch.
    private readonly g: Float64Array;
    private readonly came: Int32Array;
    private readonly stamp: Uint32Array;
    private readonly closed: Uint32Array;
    private search = 0;
    private readonly heapNode: Int32Array;
    private readonly heapKey: Float64Array;

    constructor(data: NavData) {
        const n = this.count = Math.floor(data.nodes.length / 3);
        this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            this.x[i] = data.nodes[i * 3]; this.y[i] = data.nodes[i * 3 + 1]; this.z[i] = data.nodes[i * 3 + 2];
        }
        // Expand the file's links (some both ways) into directed edges, grouped by source node.
        const from: number[] = [], to: number[] = [], kind: number[] = [];
        for (let i = 0; i + 2 < data.edges.length; i += 3) {
            const a = data.edges[i], b = data.edges[i + 1], k = data.edges[i + 2];
            if (a < 0 || b < 0 || a >= n || b >= n) continue;
            from.push(a); to.push(b); kind.push(k & 3);
            if (k & NAV_BOTH) { from.push(b); to.push(a); kind.push(k & 3); }
        }
        const m = from.length;
        this.first = new Int32Array(n + 1);
        for (let i = 0; i < m; i++) this.first[from[i] + 1]++;
        for (let i = 0; i < n; i++) this.first[i + 1] += this.first[i];
        const fill = this.first.slice(0, n);
        this.to = new Int32Array(m); this.kind = new Uint8Array(m); this.cost = new Float32Array(m);
        for (let i = 0; i < m; i++) {
            const e = fill[from[i]]++;
            const a = from[i], b = to[i];
            this.to[e] = b;
            this.kind[e] = kind[i];
            const d = Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a], this.z[b] - this.z[a]);
            this.cost[e] = d + (kind[i] === NAV_JUMP ? JUMP_COST : kind[i] === NAV_DROP ? DROP_COST : 0);
        }
        // Buckets over x and z.
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (let i = 0; i < n; i++) {
            x0 = Math.min(x0, this.x[i]); x1 = Math.max(x1, this.x[i]);
            z0 = Math.min(z0, this.z[i]); z1 = Math.max(z1, this.z[i]);
        }
        if (n === 0) { x0 = z0 = x1 = z1 = 0; }
        this.bx0 = x0; this.bz0 = z0;
        this.bw = Math.floor((x1 - x0) / BUCKET) + 1;
        this.bh = Math.floor((z1 - z0) / BUCKET) + 1;
        this.bucketFirst = new Int32Array(this.bw * this.bh + 1);
        const cellOf = (i: number): number =>
            Math.floor((this.z[i] - z0) / BUCKET) * this.bw + Math.floor((this.x[i] - x0) / BUCKET);
        for (let i = 0; i < n; i++) this.bucketFirst[cellOf(i) + 1]++;
        for (let i = 0; i < this.bw * this.bh; i++) this.bucketFirst[i + 1] += this.bucketFirst[i];
        const bfill = this.bucketFirst.slice(0, this.bw * this.bh);
        this.bucketNodes = new Int32Array(n);
        for (let i = 0; i < n; i++) this.bucketNodes[bfill[cellOf(i)]++] = i;

        this.g = new Float64Array(n);
        this.came = new Int32Array(n);
        this.stamp = new Uint32Array(n);
        this.closed = new Uint32Array(n);
        this.heapNode = new Int32Array(Math.max(16, m + n));
        this.heapKey = new Float64Array(Math.max(16, m + n));
    }

    edgesOf(n: number): [number, number] {
        return [this.first[n], this.first[n + 1]];
    }

    /** Horizontal distance from a point to node n. */
    flatDist(n: number, x: number, z: number): number {
        return Math.hypot(this.x[n] - x, this.z[n] - z);
    }

    /**
     * The node a player standing (or falling) at `p` is on: the nearest horizontally among nodes at
     * most `above` higher and `below` lower than the feet, height differences counted three times.
     * -1 when nothing is within `radius`.
     */
    nearest(p: Vec3, radius = 3, above = 0.6, below = 2.5): number {
        let best = -1, bestScore = Infinity;
        const r = Math.ceil(radius / BUCKET);
        const cx = Math.floor((p[0] - this.bx0) / BUCKET), cz = Math.floor((p[2] - this.bz0) / BUCKET);
        for (let gz = Math.max(0, cz - r); gz <= Math.min(this.bh - 1, cz + r); gz++) {
            for (let gx = Math.max(0, cx - r); gx <= Math.min(this.bw - 1, cx + r); gx++) {
                const b = gz * this.bw + gx;
                for (let k = this.bucketFirst[b]; k < this.bucketFirst[b + 1]; k++) {
                    const n = this.bucketNodes[k];
                    const dy = this.y[n] - p[1];
                    if (dy > above || dy < -below) continue;
                    const d = Math.hypot(this.x[n] - p[0], this.z[n] - p[2]);
                    if (d > radius) continue;
                    const score = d + Math.abs(dy) * 3;
                    if (score < bestScore) { bestScore = score; best = n; }
                }
            }
        }
        return best;
    }

    /** Every node within `radius` (horizontally, and within `dy` in height) of `p`, into `out`. */
    within(p: Vec3, radius: number, dy: number, out: number[]): number[] {
        out.length = 0;
        const r = Math.ceil(radius / BUCKET);
        const cx = Math.floor((p[0] - this.bx0) / BUCKET), cz = Math.floor((p[2] - this.bz0) / BUCKET);
        for (let gz = Math.max(0, cz - r); gz <= Math.min(this.bh - 1, cz + r); gz++) {
            for (let gx = Math.max(0, cx - r); gx <= Math.min(this.bw - 1, cx + r); gx++) {
                const b = gz * this.bw + gx;
                for (let k = this.bucketFirst[b]; k < this.bucketFirst[b + 1]; k++) {
                    const n = this.bucketNodes[k];
                    if (Math.abs(this.y[n] - p[1]) <= dy && Math.hypot(this.x[n] - p[0], this.z[n] - p[2]) <= radius) out.push(n);
                }
            }
        }
        return out;
    }

    /**
     * A* from `from` to `goal`. `penalty(node)` (>= 0, optional) adds cost per metre entering a node,
     * which a bot uses to vary its routes. Writes the nodes after `from` up to `goal` into `out` and
     * returns true, or returns false (and empties `out`) when there is no way. `greed` above 1 weights the
     * distance estimate (weighted A*): much faster, paths at most that factor longer than the best.
     */
    findPath(from: number, goal: number, out: number[], penalty?: (node: number) => number, greed = 1): boolean {
        out.length = 0;
        if (from < 0 || goal < 0) return false;
        if (from === goal) { out.push(goal); return true; }
        const s = ++this.search;
        const { g, came, stamp, closed, heapNode, heapKey } = this;
        const gx = this.x[goal], gy = this.y[goal], gz = this.z[goal];
        let size = 0;
        const push = (n: number, key: number): void => {
            let i = size++;
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (heapKey[parent] <= key) break;
                heapNode[i] = heapNode[parent]; heapKey[i] = heapKey[parent];
                i = parent;
            }
            heapNode[i] = n; heapKey[i] = key;
        };
        const pop = (): number => {
            const top = heapNode[0];
            const lastN = heapNode[--size], lastK = heapKey[size];
            let i = 0;
            for (;;) {
                let c = i * 2 + 1;
                if (c >= size) break;
                if (c + 1 < size && heapKey[c + 1] < heapKey[c]) c++;
                if (heapKey[c] >= lastK) break;
                heapNode[i] = heapNode[c]; heapKey[i] = heapKey[c];
                i = c;
            }
            heapNode[i] = lastN; heapKey[i] = lastK;
            return top;
        };
        const h = (n: number): number => greed * Math.hypot(this.x[n] - gx, this.y[n] - gy, this.z[n] - gz);
        g[from] = 0; came[from] = -1; stamp[from] = s;
        push(from, h(from));
        while (size > 0) {
            const n = pop();
            if (closed[n] === s) continue;
            closed[n] = s;
            if (n === goal) {
                for (let c = goal; c !== from; c = came[c]) out.push(c);
                out.reverse();
                return true;
            }
            for (let e = this.first[n]; e < this.first[n + 1]; e++) {
                const b = this.to[e];
                if (closed[b] === s) continue;
                const step = this.cost[e] * (penalty ? 1 + penalty(b) : 1);
                const cand = g[n] + step;
                if (stamp[b] === s && cand >= g[b]) continue;
                stamp[b] = s; g[b] = cand; came[b] = n;
                if (size < heapNode.length) push(b, cand + h(b));
            }
        }
        return false;
    }

    /** The kind of the edge from a to b (NAV_WALK when they are not linked). */
    linkKind(a: number, b: number): number {
        for (let e = this.first[a]; e < this.first[a + 1]; e++) if (this.to[e] === b) return this.kind[e];
        return NAV_WALK;
    }
}
