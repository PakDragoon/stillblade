import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { overlapsAny } from '../../shared/collision';
import { EYE_HEIGHT, EYE_HEIGHT_CROUCHED, HULL_HALF_WIDTH, TICK_DT } from '../../shared/constants';
import { createPlayerState, stepPlayer } from '../../shared/movement';
import { NAV_CROUCH, NAV_DROP, NAV_JUMP, NavGraph } from '../../shared/nav';
import { rayWorld } from '../../shared/raycast';
import { canAct, DEFUSE_RANGE, insideSite } from '../../shared/rules';
import type { InputCmd, PlayerState, Vec3 } from '../../shared/types';
import { loadMaps } from './maps';

/**
 * Dry Creek's acceptance checks (the brief for the map, draft 4): every special way into the sites walked with the
 * shared movement code along the navigation graph the way a bot follows it (steer at each node in turn, jump on a
 * jump link, crouch along a crouch link), the lines of sight that matter, planting and defusing with the shared
 * rule (`canAct`), and timings. Points are given in PLAN metres (the plan's x east, y south, as in
 * tools/blender/maps/drycreek.py) and converted with E(): engine x = x - 40, z = y - 40, height as given.
 * The measured numbers are printed (`npx vitest run server/src/drycreek.test.ts`) and copied into
 * docs/review/maps/drycreek/README.md.
 */
const MAP = loadMaps(fileURLToPath(new URL('../../client/public/maps', import.meta.url))).get('drycreek')!;
const NAV = new NavGraph(MAP.nav!);
const BOXES = MAP.boxes;
const E = (x: number, y: number, h = 0): Vec3 => [x - 40, h, y - 40];
const BASIN = -1.2, RAISED = 1.2, LOW_ROOF = 2.05;
const JUMP_EYE = 1.17;                     // a standing jump lifts the eye about this much (tools/mount_check.ts)
const FENCE_ABOVE_WALKWAY = 2.2;           // stage 1: lane walls and fences 2.2 m above the floor on their higher side
const log = (...a: unknown[]): void => { if (!process.env.SB_QUIET) console.log(...a); };

function route(from: Vec3, to: Vec3): number[] {
    const a = NAV.nearest(from), b = NAV.nearest(to, 3, 0.6, 2.5);
    expect(a, `no node near ${from}`).toBeGreaterThanOrEqual(0);
    expect(b, `no node near ${to}`).toBeGreaterThanOrEqual(0);
    const path: number[] = [];
    expect(NAV.findPath(a, b, path), `no path ${from} -> ${to}`).toBe(true);
    return [a, ...path];
}

function via(...pts: Vec3[]): number[] {
    let out: number[] = [];
    for (let i = 1; i < pts.length; i++) {
        const leg = route(pts[i - 1], pts[i]);
        out = out.length ? [...out, ...leg.slice(out.at(-1) === leg[0] ? 1 : 0)] : leg;
    }
    return out;
}

function kinds(path: number[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < path.length; i++) out.push(NAV.linkKind(path[i - 1], path[i]));
    return out;
}

const node = (n: number): Vec3 => [NAV.x[n], NAV.y[n], NAV.z[n]];
const inPlan = (p: Vec3, x0: number, y0: number, x1: number, y1: number): boolean =>
    p[0] >= x0 - 40 && p[0] <= x1 - 40 && p[2] >= y0 - 40 && p[2] <= y1 - 40;

interface Walk { pos: Vec3; ticks: number; trace: Vec3[] }

/** Follows a node path with stepPlayer. `walk` holds quiet walk; crouch is held along crouch links. */
function follow(path: number[], opts: { crouch: boolean; walk?: boolean; start?: Vec3 }): Walk {
    const n0 = path[0];
    const s = createPlayerState(opts.start ? [opts.start[0], opts.start[1] + 0.01, opts.start[2]] : [NAV.x[n0], NAV.y[n0] + 0.01, NAV.z[n0]]);
    const cmd: InputCmd = { forward: 0, right: 0, yaw: 0, jump: false, walk: !!opts.walk, crouch: false };
    const trace: Vec3[] = [];
    let ticks = 0;
    for (let i = 1; i < path.length; i++) {
        const n = path[i], kind = NAV.linkKind(path[i - 1], n);
        const nextCrouch = i + 1 < path.length && NAV.linkKind(n, path[i + 1]) === NAV_CROUCH;
        for (let t = 0; t < 8 * 60; t++) {
            const dx = NAV.x[n] - s.pos[0], dz = NAV.z[n] - s.pos[2];
            const flat = Math.hypot(dx, dz);
            // arrived: standing at the node's height (a node above is not reached in mid-jump)
            if (flat < 0.4 && (NAV.y[n] < s.pos[1] - 0.3 ? true : s.onGround && Math.abs(NAV.y[n] - s.pos[1]) < 0.4)) break;
            cmd.forward = -dz / Math.max(flat, 1e-6);
            cmd.right = dx / Math.max(flat, 1e-6);
            const stalled = Math.hypot(s.vel[0], s.vel[2]) < 0.5 && t > 10;      // pressed against the ledge
            cmd.jump = kind === NAV_JUMP && (flat < 1.3 || stalled) && NAV.y[n] > s.pos[1] + 0.3 && s.onGround;
            cmd.crouch = opts.crouch && (kind === NAV_CROUCH || (nextCrouch && flat < 1.0));
            stepPlayer(s, cmd, TICK_DT, BOXES);
            ticks++;
            if (process.env.SB_DEBUG && t === 479) console.log('STUCK node', i, kind, (NAV.x[n] + 40).toFixed(2), NAV.y[n].toFixed(2), (NAV.z[n] + 40).toFixed(2), 'at', (s.pos[0] + 40).toFixed(2), s.pos[1].toFixed(2), (s.pos[2] + 40).toFixed(2));
            if (ticks % 6 === 0) trace.push([s.pos[0], s.pos[1], s.pos[2]]);
        }
    }
    cmd.forward = cmd.right = 0; cmd.jump = cmd.crouch = false;
    for (let t = 0; t < 30; t++) stepPlayer(s, cmd, TICK_DT, BOXES);
    if (process.env.SB_DEBUG) console.log('FOLLOW end', s.pos.map(v => v.toFixed(2)).join(','));
    return { pos: [s.pos[0], s.pos[1], s.pos[2]], ticks, trace };
}

const near = (p: Vec3, q: Vec3, r = 1.0): boolean => Math.hypot(p[0] - q[0], p[2] - q[2]) < r && Math.abs(p[1] - q[1]) < 0.3;

const DIR: Vec3 = [0, 0, 0];
// The boxes bucketed on a 4 m grid over x and z, so a line test only looks at the boxes near the line. The result
// is the server's line test (Game.lineClear: rayWorld over every box), checked against it below.
const CELL = 4, GX0 = MAP.bounds.min[0], GZ0 = MAP.bounds.min[2];
const GW = Math.ceil((MAP.bounds.max[0] - GX0) / CELL) + 1, GD = Math.ceil((MAP.bounds.max[2] - GZ0) / CELL) + 1;
const GRID: number[][] = Array.from({ length: GW * GD }, () => []);
BOXES.forEach((b, i) => {
    for (let gx = Math.floor((b.min[0] - GX0) / CELL); gx <= Math.floor((b.max[0] - GX0) / CELL); gx++) {
        for (let gz = Math.floor((b.min[2] - GZ0) / CELL); gz <= Math.floor((b.max[2] - GZ0) / CELL); gz++) {
            if (gx >= 0 && gz >= 0 && gx < GW && gz < GD) GRID[gx + gz * GW].push(i);
        }
    }
});
const SEEN = new Uint32Array(BOXES.length);
let stamp = 0;
const NEAR: typeof BOXES = [];

/** Nothing solid between two points (the server's line test, Game.lineClear). */
function clear(a: Vec3, b: Vec3): boolean {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d < 1e-6) return true;
    DIR[0] = (b[0] - a[0]) / d; DIR[1] = (b[1] - a[1]) / d; DIR[2] = (b[2] - a[2]) / d;
    stamp++;
    NEAR.length = 0;
    const flat = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const steps = Math.max(1, Math.ceil(flat / (CELL / 2)));
    for (let k = 0; k <= steps; k++) {
        const x = a[0] + (b[0] - a[0]) * (k / steps), z = a[2] + (b[2] - a[2]) * (k / steps);
        const cx = Math.floor((x - GX0) / CELL), cz = Math.floor((z - GZ0) / CELL);
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
            for (let gz = cz - 1; gz <= cz + 1; gz++) {
                if (gx < 0 || gz < 0 || gx >= GW || gz >= GD) continue;
                for (const i of GRID[gx + gz * GW]) if (SEEN[i] !== stamp) { SEEN[i] = stamp; NEAR.push(BOXES[i]); }
            }
        }
    }
    return rayWorld(NEAR, a, DIR, d) >= d - 1e-3;
}

function clearAll(a: Vec3, b: Vec3): boolean {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const dir: Vec3 = [(b[0] - a[0]) / d, (b[1] - a[1]) / d, (b[2] - a[2]) / d];
    return rayWorld(BOXES, a, dir, d) >= d - 1e-3;
}

/** A free standing spot: the hull fits and something is under it. */
function standable(p: Vec3, crouched = false): boolean {
    const h = HULL_HALF_WIDTH;
    if (overlapsAny(BOXES, [p[0] - h, p[1] + 0.002, p[2] - h], [p[0] + h, p[1] + (crouched ? 1.2 : 1.8), p[2] + h])) return false;
    return overlapsAny(BOXES, [p[0] - h + 0.001, p[1] - 0.02, p[2] - h + 0.001], [p[0] + h - 0.001, p[1] - 0.001, p[2] + h - 0.001]);
}

function settled(p: Vec3): PlayerState {
    const s = createPlayerState([p[0], p[1] + 0.01, p[2]]);
    const cmd: InputCmd = { forward: 0, right: 0, yaw: 0, jump: false, walk: false, crouch: false };
    for (let t = 0; t < 20; t++) stepPlayer(s, cmd, TICK_DT, BOXES);
    return s;
}

/** The highest the eye gets in a standing jump from p (the shared movement code, so a roof overhead stops it). */
function jumpEye(p: Vec3): number {
    const s = createPlayerState([p[0], p[1] + 0.01, p[2]]);
    const cmd: InputCmd = { forward: 0, right: 0, yaw: 0, jump: false, walk: false, crouch: false };
    for (let t = 0; t < 10; t++) stepPlayer(s, cmd, TICK_DT, BOXES);
    let top = s.pos[1];
    cmd.jump = true;
    for (let t = 0; t < 90; t++) {
        stepPlayer(s, cmd, TICK_DT, BOXES);
        cmd.jump = false;
        top = Math.max(top, s.pos[1]);
        if (t > 5 && s.onGround) break;
    }
    return top + EYE_HEIGHT;
}

// ---- named places (plan metres) ------------------------------------------------------------------------------
const CONSOLE = E(29.25, 16.2);              // in the plant zone, just south of the console
const WEST_DOOR_OUT = E(19.5, 13.75);        // the corridor outside west door 22
const A_SHORT_OUT = E(32.0, 33.5);           // mid's side of A short
const BY_BOX9 = E(18.8, 19.75);              // the ground west of box 9
const ROOF_BY_HOLE = E(30.4, 20.0, LOW_ROOF);
const ROOF_WEST = E(23.0, 20.0, LOW_ROOF);
const UNDER_HOLE = E(32.0, 20.0);
const C6_OUT = E(26.7, 8.6), C6_IN = E(26.7, 11.6);
const C8_OUT = E(30.7, 30.4), C8_IN = E(30.7, 27.4);
const WALKWAY = E(77.8, 47.5, RAISED);
const LANDING = E(74.5, 47.5, RAISED);
const WELL = E(74.5, 52.5);                  // the stairwell floor at the plank's foot
const BASIN_E = E(70.2, 52.5, BASIN);
const SITE_B = { x0: 62.5, y0: 44.5, x1: 69.5, y1: 55.5 };
const RIM = { x0: 60, y0: 42, x1: 72, y1: 58 };

describe('Dry Creek: the line test used here', () => {
    it('agrees with the server line test over every box, on 4000 random lines', () => {
        let s = 12345;
        const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
        let blocked = 0;
        for (let i = 0; i < 4000; i++) {
            const a = E(rnd() * 80, rnd() * 80, -1 + rnd() * 4), b = E(rnd() * 80, rnd() * 80, -1 + rnd() * 4);
            const c = clear(a, b);
            expect(c).toBe(clearAll(a, b));
            if (!c) blocked++;
        }
        expect(blocked).toBeGreaterThan(1000);
    }, 60_000);
});

describe('Dry Creek: Site A', () => {
    it('west door 22 leads to the console (standing)', () => {
        const path = route(WEST_DOOR_OUT, CONSOLE);
        expect(path.some(n => inPlan(node(n), 20.5, 12.5, 21.5, 15.0))).toBe(true);
        expect(near(follow(path, { crouch: false }).pos, CONSOLE)).toBe(true);
    });

    it('A short leads to the console through crouch gap 8, the south barrack and the passage', () => {
        const path = route(A_SHORT_OUT, CONSOLE);
        expect(kinds(path)).toContain(NAV_CROUCH);
        expect(path.some(n => inPlan(node(n), 30.0, 28.6, 31.4, 29.4))).toBe(true);
        expect(path.some(n => inPlan(node(n), 30.0, 18.2, 34.0, 21.8))).toBe(true);     // the passage
        expect(near(follow(path, { crouch: true }).pos, CONSOLE)).toBe(true);
    });

    it('box 9 onto the low roof (two jumps), then down roof hole 10 to the console; the hole is one way', () => {
        const up = route(BY_BOX9, ROOF_WEST);
        expect(kinds(up).filter(k => k === NAV_JUMP).length).toBeGreaterThanOrEqual(2);
        expect(near(follow(up, { crouch: true }).pos, ROOF_WEST)).toBe(true);
        const down = route(ROOF_BY_HOLE, CONSOLE);
        const ks = kinds(down);
        const i = ks.indexOf(NAV_DROP);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(inPlan(node(down[i + 1]), 30.0, 18.2, 34.0, 21.8)).toBe(true);               // lands in the passage
        expect(near(follow(down, { crouch: true }).pos, CONSOLE)).toBe(true);
        // nothing climbs back up through the hole
        const back = route(UNDER_HOLE, ROOF_BY_HOLE);
        expect(back.some(n => inPlan(node(n), 18.0, 18.0, 21.0, 22.0)), 'the way back up is box 9').toBe(true);
    });

    for (const [name, out, inside] of [['6 (north, the watchtower flank)', C6_OUT, C6_IN], ['8 (south, A short)', C8_OUT, C8_IN]] as const) {
        it(`crouch gap ${name}: a crouch link, passable crouched and blocked standing, both ways`, () => {
            const path = route(out, inside);
            expect(kinds(path)).toContain(NAV_CROUCH);
            expect(near(follow(path, { crouch: true }).pos, inside)).toBe(true);
            expect(near(follow(path, { crouch: false }).pos, inside)).toBe(false);
            const back = route(inside, out);
            expect(kinds(back)).toContain(NAV_CROUCH);
            expect(near(follow(back, { crouch: true }).pos, out)).toBe(true);
            expect(near(follow(back, { crouch: false }).pos, out)).toBe(false);
        });
    }

    it('a standing player fits in the passage under the low roof and cannot jump there', () => {
        const s = createPlayerState(E(32.0, 18.6, 0.01));
        const cmd: InputCmd = { forward: 0, right: 0, yaw: 0, jump: true, walk: false, crouch: false };
        let top = 0;
        for (let t = 0; t < 60; t++) { stepPlayer(s, cmd, TICK_DT, BOXES); top = Math.max(top, s.pos[1]); }
        expect(s.crouched).toBe(false);
        expect(top).toBeLessThan(0.11);
    });

    it('one defender at the console: which of the three entries (west door, A short, roof hole) one spot sees', () => {
        // What a ghost coming in by each entry shows: its body at chest and head height where it comes into the
        // north barrack. West door 22: in the doorway. A short and the roof hole both arrive through the passage: the
        // passage mouth (y 18), and for the roof the landing spot under the hole as well.
        const body = (x: number, y: number): Vec3[] => [E(x, y, 1.0), E(x, y, 1.7)];
        const entries: Record<string, Vec3[]> = {
            'west door 22': [20.8, 21.0, 21.3].flatMap(x => [12.8, 13.75, 14.7].flatMap(y => body(x, y))),
            'A short (passage mouth)': [30.4, 31.2, 32.0, 32.8, 33.6].flatMap(x => body(x, 18.2)),
            'roof hole 10 (under the hole)': [31.5, 32.0, 32.5].flatMap(x => [19.5, 20.0, 20.5].flatMap(y => body(x, y))),
        };
        // Every free standing spot within 2.5 m of the console (0.25 m grid).
        const spots: Vec3[] = [];
        for (let x = 24.5; x <= 34.0; x += 0.25) {
            for (let y = 10.2; y <= 17.8; y += 0.25) {
                const p = E(x, y);
                const dx = Math.max(27.0 - x, 0, x - 31.5), dy = Math.max(12.6 - y, 0, y - 15.0);
                if (Math.hypot(dx, dy) <= 2.5 && standable(p)) spots.push(p);
            }
        }
        const names = Object.keys(entries);
        const counts = new Map<string, number>();
        let allThree = 0, doorAndPassage = 0, onScreen = 0;
        const spans: number[] = [];
        // The default view is 74 degrees tall; on a 16:9 screen that is about 106 degrees wide.
        const HFOV = 2 * Math.atan(Math.tan((74 / 2) * Math.PI / 180) * 16 / 9) * 180 / Math.PI;
        const door = E(21.0, 13.75), mouth = E(32.0, 18.0);
        for (const p of spots) {
            const eye: Vec3 = [p[0], p[1] + EYE_HEIGHT, p[2]];
            const seen = names.filter(k => entries[k].some(q => clear(eye, q)));
            const key = seen.length ? seen.join(' + ') : 'none';
            counts.set(key, (counts.get(key) ?? 0) + 1);
            if (seen.length === 3) {
                allThree++;
                // the horizontal angle between the west doorway and the passage mouth, seen from this spot
                const a1 = Math.atan2(door[2] - p[2], door[0] - p[0]), a2 = Math.atan2(mouth[2] - p[2], mouth[0] - p[0]);
                let span = Math.abs(a1 - a2) * 180 / Math.PI;
                if (span > 180) span = 360 - span;
                spans.push(span);
                if (span <= HFOV) onScreen++;
            }
            if (seen.includes('west door 22') && seen.includes('A short (passage mouth)')) doorAndPassage++;
        }
        spans.sort((x, y) => x - y);
        log(`\n[console] ${spots.length} standing spots within 2.5 m of the console; what each sees:`);
        for (const [k, c] of [...counts].sort((a, b) => b[1] - a[1])) log(`  ${String(c).padStart(4)}  ${k}`);
        log(`  spots that see all three: ${allThree}; see the west door and the passage mouth together: ${doorAndPassage}`);
        log(`  angle between the west door and the passage mouth from the all-three spots: ${spans[0]?.toFixed(0)} to ` +
            `${spans.at(-1)?.toFixed(0)} degrees (median ${spans[spans.length >> 1]?.toFixed(0)}); both on screen at once ` +
            `(within the ${HFOV.toFixed(0)} degree default view) from ${onScreen} of them`);
        expect(spots.length).toBeGreaterThan(100);
        // A short and the roof both arrive by the passage, so a defender who watches the passage mouth sees both: the
        // console splits the room into two angles (west door, passage), not three. Recorded, not a design rule.
        expect(counts.size).toBeGreaterThan(1);
    }, 60_000);
});

describe('Dry Creek: Site B east (walkway, stairwell 23, plank, east stairs)', () => {
    it('walks walkway -> top landing -> plank -> stairwell -> east stairs -> basin, and back', () => {
        const down = route(WALKWAY, BASIN_E);
        expect(down.some(n => near(node(n), LANDING, 1.2))).toBe(true);
        expect(down.some(n => near(node(n), WELL, 1.6))).toBe(true);
        expect(kinds(down)).not.toContain(NAV_DROP);
        expect(near(follow(down, { crouch: false }).pos, BASIN_E)).toBe(true);
        const up = route(BASIN_E, WALKWAY);
        expect(up.some(n => near(node(n), WELL, 1.6))).toBe(true);
        expect(up.some(n => near(node(n), LANDING, 1.2))).toBe(true);
        expect(kinds(up)).not.toContain(NAV_JUMP);
        expect(near(follow(up, { crouch: false }).pos, WALKWAY)).toBe(true);
    });

    it('no line of sight from the walkway, its stairs or the top landing to any point of the B plant zone', () => {
        const eyes: Vec3[] = [];
        const addEyes = (x: number, y: number, h: number): void => {
            const p = E(x, y, h);
            if (!standable(p)) return;
            // standing, crouched, and the top of a jump (simulated: the gantry roof stops it)
            for (const e of [h + EYE_HEIGHT, h + EYE_HEIGHT_CROUCHED, jumpEye(p)]) eyes.push([p[0], e, p[2]]);
        };
        for (let x = 75.95; x <= 79.7; x += 0.5) for (let y = 34.0; y <= 64.0; y += 0.5) addEyes(x, y, RAISED);
        for (let x = 73.95; x <= 75.6; x += 0.4) for (let y = 46.95; y <= 48.4; y += 0.35) addEyes(x, y, RAISED);
        for (let x = 75.95; x <= 79.7; x += 0.5) for (const [y, h] of [[30.4, 0.2], [31.2, 0.4], [32.0, 0.6], [32.8, 0.8], [33.6, 1.0],
            [67.6, 0.2], [66.8, 0.4], [66.0, 0.6], [65.2, 0.8], [64.4, 1.0]]) addEyes(x, y, h);
        const targets: Vec3[] = [];
        for (let x = SITE_B.x0; x <= SITE_B.x1 + 1e-6; x += 0.5) {
            for (let y = SITE_B.y0; y <= SITE_B.y1 + 1e-6; y += 0.5) {
                for (const h of [0.1, 0.9, 1.7]) targets.push(E(x, y, BASIN + h));
            }
        }
        let seen = 0;
        for (const e of eyes) for (const t of targets) if (clear(e, t)) seen++;
        const jumps = eyes.filter((_e, i) => i % 3 === 2).map(e => e[1]);
        log(`\n[walkway] ${eyes.length} eye points (standing, crouched, top of a jump) x ${targets.length} plant-zone points: ${seen} clear lines; ` +
            `highest jumping eye ${Math.max(...jumps).toFixed(2)} m (fence top ${(RAISED + FENCE_ABOVE_WALKWAY).toFixed(2)} m)`);
        expect(eyes.length).toBeGreaterThan(1000);
        expect(seen).toBe(0);
    }, 60_000);

    it('the fence and the stairwell walls stand 2.2 m above the walkway, under the gantry canopy', () => {
        const byName = (name: string) => BOXES.find(x => (x as { name?: string }).name === name);
        for (const name of ['b_fence_n', 'b_fence_s', 'b23_stairwell_s', 'b23_stairwell_n', 'b23_stairwell_w']) {
            const b = byName(name);
            expect(b, name).toBeDefined();
            expect(b!.max[1]).toBeCloseTo(RAISED + FENCE_ABOVE_WALKWAY, 3);
            expect(b!.min[1]).toBeLessThanOrEqual(0);
        }
        for (const name of ['b_gantry_roof', 'b23_stairwell_roof']) {
            const r = byName(name);
            expect(r, name).toBeDefined();
            expect(r!.min[1]).toBeCloseTo(RAISED + FENCE_ABOVE_WALKWAY, 3);     // it rests on the fence: 2.2 m headroom
        }
        // under the 2 m canopy along the fence (and in the roofed stairwell) a jump keeps the eye under the fence top;
        // farther out it does not, and the line test above covers those eyes
        let worst = 0;
        for (const [x, y] of [[76.0, 40.0], [77.0, 47.5], [77.0, 60.0], [74.5, 47.5], [76.0, 35.0]]) worst = Math.max(worst, jumpEye(E(x, y, RAISED)));
        expect(worst).toBeLessThan(RAISED + FENCE_ABOVE_WALKWAY);
        expect(jumpEye(E(79.0, 50.0, RAISED))).toBeGreaterThan(RAISED + FENCE_ABOVE_WALKWAY);
        expect(JUMP_EYE).toBeGreaterThan(1.1);
    });
});

describe('Dry Creek: Site B plant and defuse', () => {
    const site = MAP.bombSites.find(s => s.name === 'B')!;
    // The legal plant point closest to each rim (the plant zone's edge, 2.5 m in), and a point just outside it.
    const plants: [string, Vec3, Vec3][] = [
        ['west', E(SITE_B.x0, 50.0, BASIN), E(SITE_B.x0 - 0.05, 50.0, BASIN)],
        ['east', E(SITE_B.x1, 47.0, BASIN), E(SITE_B.x1 + 0.05, 47.0, BASIN)],
        ['north', E(66.0, SITE_B.y0, BASIN), E(66.0, SITE_B.y0 - 0.05, BASIN)],
        ['south', E(66.0, SITE_B.y1, BASIN), E(66.0, SITE_B.y1 + 0.05, BASIN)],
    ];

    it('the site box stays below the rim, 2.5 m in from every rim', () => {
        expect(site.max[1]).toBeLessThan(0);
        expect(site.min[0]).toBeCloseTo(RIM.x0 + 2.5 - 40, 3);
        expect(site.max[0]).toBeCloseTo(RIM.x1 - 2.5 - 40, 3);
        expect(site.min[2]).toBeCloseTo(RIM.y0 + 2.5 - 40, 3);
        expect(site.max[2]).toBeCloseTo(RIM.y1 - 2.5 - 40, 3);
    });

    for (const [rim, inside, outside] of plants) {
        it(`plants at the closest legal point to the ${rim} rim, and not 5 cm nearer`, () => {
            const s = settled(inside);
            expect(s.onGround).toBe(true);
            expect(s.pos[1]).toBeCloseTo(BASIN, 3);
            expect(canAct('ghosts', 'live', s, MAP, null, true)).toBe(true);
            expect(canAct('ghosts', 'live', settled(outside), MAP, null, true)).toBe(false);
        });
    }

    it('nobody plants from the rim, the walkway or a stair landing', () => {
        let spots = 0;
        for (let x = 55.0; x <= 80.0; x += 0.25) {
            for (let y = 36.0; y <= 64.0; y += 0.25) {
                for (const h of [0, RAISED]) {
                    const p = E(x, y, h);
                    if (!standable(p)) continue;
                    spots++;
                    expect(insideSite(p, MAP), `site B from ${x}, ${y}, ${h}`).toBe(false);
                }
            }
        }
        expect(spots).toBeGreaterThan(3000);
    }, 60_000);

    it('defusing fails from the ground at the rim, the walkway and the stair landings, against every legal bomb spot', () => {
        // Every legal bomb spot on the plant zone's edge (the closest a bomb can lie to anything outside), 0.25 m apart.
        const bombs: Vec3[] = [];
        for (let x = SITE_B.x0; x <= SITE_B.x1 + 1e-6; x += 0.25) bombs.push(E(x, SITE_B.y0, BASIN), E(x, SITE_B.y1, BASIN));
        for (let y = SITE_B.y0; y <= SITE_B.y1 + 1e-6; y += 0.25) bombs.push(E(SITE_B.x0, y, BASIN), E(SITE_B.x1, y, BASIN));
        // Every standing spot at ground level (the rim, the stair tops, the stairwell floor) and at walkway height (the
        // walkway, the top landing), 0.1 m apart, including spots overhanging the rim by up to the half hull.
        let spots = 0, closest = Infinity;
        const steps: string[] = [];
        for (let x = 55.0; x <= 80.0; x += 0.1) {
            for (let y = 36.0; y <= 64.0; y += 0.1) {
                for (const h of [0, RAISED, -0.2, -0.4, -0.6, -0.8, -1.0]) {
                    const p = E(x, y, h);
                    if (!standable(p)) continue;
                    const s: PlayerState = { pos: p, vel: [0, 0, 0], onGround: true, crouched: false };
                    const can = bombs.some(b => canAct('defenders', 'planted', s, MAP, b, false));
                    if (h >= 0) {
                        spots++;
                        expect(can, `defused from ${x.toFixed(1)}, ${y.toFixed(1)} at ${h}`).toBe(false);
                        for (const b of bombs) closest = Math.min(closest, Math.hypot(p[0] - b[0], p[2] - b[2]));
                    } else if (can) {
                        const onStairs = inPlan(p, 71.3, 51.6, 73.4, 53.4) || inPlan(p, 57.9, 47, 60.1, 51) ||
                            inPlan(p, 62, 39.9, 66, 42.1) || inPlan(p, 62, 57.9, 66, 60.1);
                        steps.push(`${onStairs ? 'stairs' : 'basin jump box'} ${x.toFixed(1)},${y.toFixed(1)}@${h}`);
                    }
                }
            }
        }
        log(`\n[defuse] ${spots} ground and walkway spots; closest any of them stands to a legal bomb spot: ${closest.toFixed(2)} m (range ${DEFUSE_RANGE} m)`);
        const stairs = steps.filter(t => t.startsWith('stairs'));
        log(`[defuse] spots below the rim (in the basin) within reach of a legal bomb spot: ${steps.length - stairs.length} on the basin's jump box, ` +
            `${stairs.length} on stair steps${stairs.length ? ', e.g. ' + stairs.slice(0, 3).join('; ') : ''}`);
        expect(spots).toBeGreaterThan(20000);
        expect(closest).toBeGreaterThan(DEFUSE_RANGE);
    }, 60_000);

    it('defusing works from inside the basin, next to the bomb', () => {
        for (const [, bomb] of plants) {
            const p: Vec3 = [bomb[0] + (bomb[0] < 26 ? 1.0 : -1.0), BASIN, bomb[2]];
            const s = settled(p);
            expect(s.onGround).toBe(true);
            expect(canAct('defenders', 'planted', s, MAP, bomb, false)).toBe(true);
        }
    });
});

describe('Dry Creek: spawns', () => {
    it('no spawn sees the other spawn or any point of either site, standing, crouched or mid-jump', () => {
        // standing, crouched and jumping eyes (stage 1: with 2.2 m walls a jump sees over them)
        const eyes = (team: 'ghosts' | 'defenders'): Vec3[] => MAP.spawns[team].flatMap(s => [
            [s.pos[0], s.pos[1] + EYE_HEIGHT, s.pos[2]] as Vec3, [s.pos[0], s.pos[1] + EYE_HEIGHT_CROUCHED, s.pos[2]] as Vec3,
            [s.pos[0], jumpEye(s.pos), s.pos[2]] as Vec3]);
        const targets: Vec3[] = [];
        for (const s of MAP.bombSites) {
            for (let x = s.min[0]; x <= s.max[0] + 1e-6; x += 0.5) {
                for (let z = s.min[2]; z <= s.max[2] + 1e-6; z += 0.5) for (const h of [0.1, 1.0, 1.7]) targets.push([x, s.min[1] + h, z]);
            }
        }
        let seen = 0;
        for (const [a, b] of [['ghosts', 'defenders'], ['defenders', 'ghosts']] as const) {
            for (const e of eyes(a)) {
                for (const o of eyes(b)) if (clear(e, o)) seen++;
                for (const o of MAP.spawns[b]) for (const h of [0.9, 1.7]) if (clear(e, [o.pos[0], o.pos[1] + h, o.pos[2]])) seen++;
                for (const t of targets) if (clear(e, t)) seen++;
            }
        }
        expect(seen).toBe(0);
    }, 60_000);
});

// ---- timings --------------------------------------------------------------------------------------------------
const RUN = 5.2, CROUCH = 2.0;

/** Seconds for a defender to reach each nav node from its spawn (Dijkstra over the graph, crouch links slower). */
function reachTimes(team: 'ghosts' | 'defenders', speed: number): Float64Array {
    const t = new Float64Array(NAV.count).fill(Infinity);
    const open: number[] = [];
    for (const s of MAP.spawns[team]) { const n = NAV.nearest(s.pos); t[n] = 0; open.push(n); }
    const done = new Uint8Array(NAV.count);
    // small graph: a simple binary heap would be faster, a sorted pick is fast enough here
    while (open.length) {
        let bi = 0;
        for (let i = 1; i < open.length; i++) if (t[open[i]] < t[open[bi]]) bi = i;
        const n = open.splice(bi, 1)[0];
        if (done[n]) continue;
        done[n] = 1;
        const [e0, e1] = NAV.edgesOf(n);
        for (let e = e0; e < e1; e++) {
            const b = NAV.to[e];
            const d = Math.hypot(NAV.x[b] - NAV.x[n], NAV.y[b] - NAV.y[n], NAV.z[b] - NAV.z[n]);
            const k = NAV.linkKind(n, b);
            const c = t[n] + d / (k === NAV_CROUCH ? Math.min(speed, CROUCH) : speed);
            if (c < t[b]) { t[b] = c; open.push(b); }
        }
    }
    return t;
}

const ROUTES: { site: 'A' | 'B'; name: string; via: Vec3[]; crouch?: boolean }[] = [
    { site: 'A', name: 'A long, south barrack door 7', via: [E(19.6, 26.0), E(26.0, 25.5), E(32.0, 20.0)] },
    { site: 'A', name: 'A long, west door 22', via: [E(19.6, 13.75)] },
    { site: 'A', name: 'A short, crouch gap 8', via: [E(32.0, 33.5), C8_OUT, C8_IN, E(32.0, 20.0)], crouch: true },
    { site: 'A', name: 'box 9, low roof, hole 10', via: [BY_BOX9, ROOF_WEST, ROOF_BY_HOLE, UNDER_HOLE] },
    { site: 'A', name: 'watchtower flank, crouch gap 6', via: [E(16.5, 9.0), C6_OUT, C6_IN], crouch: true },
    { site: 'B', name: 'B mid', via: [E(57.0, 48.0)] },
    { site: 'B', name: 'B south', via: [E(64.0, 65.5), E(64.0, 62.0)] },
    { site: 'B', name: 'walkway, stairwell 23, plank', via: [E(78.0, 66.0, 0.6), WALKWAY, LANDING, WELL, BASIN_E] },
];
const SITE_GOAL: Record<'A' | 'B', Vec3> = { A: CONSOLE, B: E(66.0, 53.5, BASIN) };

describe('Dry Creek: timings', () => {
    it('run and quiet-walk times from every spawn point to each plant zone', () => {
        log('\n[timing] spawn -> plant zone (s): run min / max, quiet walk min / max, over the five spawn points');
        for (const team of ['ghosts', 'defenders'] as const) {
            for (const site of MAP.bombSites) {
                const goal = SITE_GOAL[site.name as 'A' | 'B'];
                const run: number[] = [], walk: number[] = [];
                for (const sp of MAP.spawns[team]) {
                    const path = route(sp.pos, goal);
                    for (const [arr, quiet] of [[run, false], [walk, true]] as const) {
                        const w = follow(path, { crouch: true, walk: quiet, start: sp.pos });
                        // stop the clock where the walker first stands in the plant zone
                        const k = w.trace.findIndex(p => insideSite(p, MAP));
                        expect(k, `${team} never stood in site ${site.name}`).toBeGreaterThanOrEqual(0);
                        arr.push(((k + 1) * 6) / 60);
                    }
                }
                const f = (a: number[]): string => `${Math.min(...a).toFixed(1)} / ${Math.max(...a).toFixed(1)}`;
                log(`  ${team.padEnd(9)} -> ${site.name}: run ${f(run)}   quiet walk ${f(walk)}`);
                expect(Math.max(...run)).toBeLessThan(40);
            }
        }
    }, 60_000);

    it('first contact on each main route: when a running defender could first see a running ghost', () => {
        const dRun = reachTimes('defenders', RUN);
        log('\n[contact] ghost runs from its spawn by the route; defenders run from theirs. First moment a spot a defender');
        log('          could have reached by then has an eye-to-body line to the ghost (ghost invisibility ignored):');
        const gs = MAP.spawns.ghosts[2].pos;
        const reach: number[] = [];
        for (const r of ROUTES) {
            const path = via(gs, ...r.via, SITE_GOAL[r.site]);
            const w = follow(path, { crouch: true, start: gs });
            const k = w.trace.findIndex(p => insideSite(p, MAP));
            expect(k, `${r.name} never reached site ${r.site}; stopped at plan ${(w.pos[0] + 40).toFixed(2)}, ${(w.pos[2] + 40).toFixed(2)}, ${w.pos[1].toFixed(2)}`).toBeGreaterThanOrEqual(0);
            let contact = -1, where: Vec3 | null = null, from = -1;
            for (let i = 0; i <= k && contact < 0; i++) {
                const t = ((i + 1) * 6) / 60;
                const g = w.trace[i];
                const body: Vec3[] = [[g[0], g[1] + 1.0, g[2]], [g[0], g[1] + 1.6, g[2]]];
                for (let n = 0; n < NAV.count; n++) {
                    if (dRun[n] > t) continue;
                    const dx = NAV.x[n] - g[0], dz = NAV.z[n] - g[2];
                    if (dx * dx + dz * dz > 60 * 60) continue;
                    const eye: Vec3 = [NAV.x[n], NAV.y[n] + EYE_HEIGHT, NAV.z[n]];
                    if (body.some(b => clear(eye, b))) { contact = t; where = g; from = n; break; }
                }
            }
            const site = (((k + 1) * 6) / 60).toFixed(1);
            const at = where ? `(${(where[0] + 40).toFixed(1)}, ${(where[2] + 40).toFixed(1)})` : '-';
            const seer = from >= 0 ? `(${(NAV.x[from] + 40).toFixed(1)}, ${(NAV.z[from] + 40).toFixed(1)})` : '-';
            log(`  ${r.site} ${r.name.padEnd(32)} reaches the site ${site.padStart(5)} s; first contact ${contact < 0 ? 'none' : contact.toFixed(1) + ' s'} with the ghost at ${at}, seen from ${seer}`);
            reach.push(k);
        }
        expect(reach.length).toBe(ROUTES.length);
    }, 120_000);
});
