import { describe, expect, it } from 'vitest';
import type { Box, Vec3 } from '@shared/types';
import { RUN_SPEED } from '@shared/constants';
import { LightProbes, PROBE_SIZE, SUN_VIS, insideSolid, trace, type ProbeSource } from './probes';
import { ViewFeel, shotVariation, type FeelInput, type RecoilFeel } from './vmfeel';
import { LIGHT_FLOATS, defaultLight, lightFromProbe } from './lighting';

// Package Q: the players' and weapon's light probes, and the first-person weapon's motion and recoil feel.

const box = (min: Vec3, max: Vec3): Box => ({ min, max });

/** A closed 10 x 4 x 10 m room: floor, ceiling, four walls (0.5 m thick). */
const ROOM: Box[] = [
    box([-5.5, -0.5, -5.5], [5.5, 0, 5.5]),     // floor (top at y 0)
    box([-5.5, 4, -5.5], [5.5, 4.5, 5.5]),      // ceiling
    box([-5.5, 0, -5.5], [-5, 4, 5.5]),         // west
    box([5, 0, -5.5], [5.5, 4, 5.5]),           // east
    box([-5, 0, -5.5], [5, 4, -5]),             // north
    box([-5, 0, 5], [5, 4, 5.5])                // south
];
const SUN: Vec3 = [0.554, 0.742, 0.377];

/** A source whose faces glow by direction: up-facing faces red, down-facing blue, side faces green; the sky white. */
function source(boxes: Box[], sky = 1): ProbeSource & { surfaceCalls: number } {
    const s = {
        boxes, min: [-6, -1, -6] as Vec3, max: [6, 5, 6] as Vec3, sunDir: SUN, surfaceCalls: 0,
        surface(_x: number, _y: number, _z: number, axis: number, sign: number, out: Float32Array): boolean {
            s.surfaceCalls++;
            out.fill(0);
            if (axis === 1) out[sign > 0 ? 0 : 2] = 1; else out[1] = 1;
            return true;
        },
        sky(_dx: number, _dy: number, _dz: number, out: Float32Array): void { out.fill(sky); }
    };
    return s;
}

describe('light probes', () => {
    it('traces to the nearest face and names it', () => {
        const hit = { t: 0, axis: -1, sign: 0 };
        expect(trace(ROOM, 0, 1, 0, 0, -1, 1e-9, 100, hit)).toBe(true);
        expect(hit.axis).toBe(1);
        expect(hit.sign).toBe(1); // the floor's top face
        expect(hit.t).toBeCloseTo(1, 5);
        expect(trace(ROOM, 0, 1, 0, 1, 1e-9, 1e-9, 100, hit)).toBe(true);
        expect(hit.axis).toBe(0);
        expect(hit.sign).toBe(-1); // the east wall's west face
        expect(hit.t).toBeCloseTo(5, 5);
        expect(trace([ROOM[0]], 0, 1, 0, 0, 1, 1e-9, 100, hit)).toBe(false);
        expect(insideSolid(ROOM, 0, -0.25, 0)).toBe(true);
        expect(insideSolid(ROOM, 0, 1, 0)).toBe(false);
    });

    it('sees the floor below, the ceiling above and the walls around', () => {
        const p = new LightProbes(source(ROOM), 1);
        const out = new Float32Array(PROBE_SIZE);
        expect(p.sample(0.2, 1.6, -0.3, out)).toBe(true);
        // Light arriving from below (-Y, index 3) is the floor's (red); from above (+Y, index 2) the ceiling's (blue).
        expect(out[9]).toBeGreaterThan(0.5);
        expect(out[9 + 2]).toBeLessThan(0.05);
        expect(out[6 + 2]).toBeGreaterThan(0.5);
        expect(out[6]).toBeLessThan(0.05);
        // From the side mostly the walls (green), with some floor and ceiling at grazing angles.
        expect(out[1]).toBeGreaterThan(out[0]);
        expect(out[1]).toBeGreaterThan(out[2]);
        // Closed room: no sun.
        expect(out[SUN_VIS]).toBe(0);
    });

    it('sees the sun and the sky in the open, not under a roof', () => {
        const open = new LightProbes(source([ROOM[0]], 0.5), 1);
        const out = new Float32Array(PROBE_SIZE);
        open.sample(0, 1.6, 0, out);
        expect(out[SUN_VIS]).toBe(1);
        expect(out[6]).toBeCloseTo(0.5, 5); // the sky from above
        const roofed = new LightProbes(source([ROOM[0], box([-30, 3, -30], [30, 3.3, 30])], 0.5), 1);
        roofed.sample(0, 1.6, 0, out);
        expect(out[SUN_VIS]).toBe(0);
    });

    it('skips probes buried in solids, computes each probe once, and repeats exactly', () => {
        const src = source(ROOM);
        const p = new LightProbes(src, 1);
        const a = new Float32Array(PROBE_SIZE), b = new Float32Array(PROBE_SIZE);
        p.sample(1.1, 1.2, 2.3, a);
        const computed = p.computed, calls = src.surfaceCalls;
        p.sample(1.1, 1.2, 2.3, b);
        expect(p.computed).toBe(computed);
        expect(src.surfaceCalls).toBe(calls);
        expect([...b]).toEqual([...a]);
        const q = new LightProbes(source(ROOM), 1);
        const c = new Float32Array(PROBE_SIZE);
        q.sample(1.1, 1.2, 2.3, c);
        expect([...c]).toEqual([...a]);
        // A point deep inside a wall: every probe around it is buried, so nothing is known there.
        const solid = new LightProbes(source([box([-6, -1, -6], [6, 5, 6])]), 1);
        const d = new Float32Array(PROBE_SIZE).fill(7);
        expect(solid.sample(0, 2, 0, d)).toBe(false);
        expect(d[0]).toBe(7);
    });
});

describe('probe light to shader values', () => {
    const probe = (amb: number, sun: number): Float32Array => {
        const s = new Float32Array(PROBE_SIZE).fill(amb);
        s[SUN_VIS] = sun;
        return s;
    };
    it('keeps the sun as the key where it reaches, and none in the dark', () => {
        const out = new Float32Array(LIGHT_FLOATS);
        lightFromProbe(probe(0.4, 1), 0.3, out);
        expect(Math.hypot(out[18], out[19], out[20])).toBeCloseTo(1, 5);
        expect(out[19]).toBeGreaterThan(0.6); // the sun is high
        expect(out[21]).toBeGreaterThan(0.8);
        lightFromProbe(probe(0.02, 0), 0.3, out);
        expect(out[21]).toBeLessThan(0.05);
    });
    it('lifts the darkest places to stay readable, and dims reflections there', () => {
        const dark = new Float32Array(LIGHT_FLOATS), lit = new Float32Array(LIGHT_FLOATS);
        lightFromProbe(probe(0.01, 0), 0.3, dark);
        lightFromProbe(probe(0.4, 1), 0.3, lit);
        expect(dark[0]).toBeGreaterThan(0.01);        // lifted
        expect(dark[0]).toBeLessThan(lit[0] / 4);     // still clearly darker
        expect(dark[24]).toBeGreaterThan(0.02);       // a rim even there
        expect(dark[27]).toBeLessThan(lit[27] / 3);   // reflections follow the light
    });
    it('has an outdoor default before any map', () => {
        const out = defaultLight(new Float32Array(LIGHT_FLOATS));
        expect(out[21]).toBeGreaterThan(0.5);
        expect(out.every(Number.isFinite)).toBe(true);
    });
});

describe('weapon feel', () => {
    const still = (): FeelInput => ({ vx: 0, vy: 0, vz: 0, onGround: true, crouched: false, yaw: 0, pitch: 0, aim: 0 });
    const RIFLE: RecoilFeel = { back: 0.03, lift: 0.007, pitch: 3.2, side: 0.7, roll: 1.1, camRoll: 0.35, camPitch: 0.1 };
    const run = (f: ViewFeel, s: FeelInput, seconds: number, each?: () => void): void => {
        for (let t = 0; t < seconds; t += 1 / 60) { f.update(1 / 60, s); each?.(); }
    };

    it('stays put when nothing happens', () => {
        const f = new ViewFeel();
        run(f, still(), 1);
        expect([...f.pos, ...f.rot, ...f.cam].every(v => Math.abs(v) < 1e-9)).toBe(true);
    });

    it('kicks back about as far as asked on a shot and settles', () => {
        const f = new ViewFeel();
        f.shoot(RIFLE, 1, 0);
        let peak = 0;
        run(f, still(), 0.15, () => { peak = Math.max(peak, f.pos[2]); });
        expect(peak).toBeGreaterThan(RIFLE.back * 0.6);
        expect(peak).toBeLessThan(RIFLE.back * 1.3);
        run(f, still(), 0.8);
        expect(Math.abs(f.pos[2])).toBeLessThan(RIFLE.back * 0.05);
        expect(Math.abs(f.cam[1])).toBeLessThan(0.01);
    });

    it('varies each shot by its count, the same way every time', () => {
        expect(shotVariation(5, 1)).toBe(shotVariation(5, 1));
        expect(shotVariation(5, 1)).not.toBe(shotVariation(6, 1));
        for (let i = 0; i < 200; i++) {
            const v = shotVariation(i, 2);
            expect(v).toBeGreaterThanOrEqual(-1);
            expect(v).toBeLessThanOrEqual(1);
        }
        const a = new ViewFeel(), b = new ViewFeel();
        a.shoot(RIFLE, 9, 0); b.shoot(RIFLE, 9, 0);
        run(a, still(), 0.05); run(b, still(), 0.05);
        expect([...a.rot]).toEqual([...b.rot]);
    });

    it('bobs with running speed, much less when aiming, not at all in the air', () => {
        const bob = (s: FeelInput): number => {
            const f = new ViewFeel();
            let m = 0;
            run(f, s, 2, () => { m = Math.max(m, Math.abs(f.pos[0])); });
            return m;
        };
        const running = bob({ ...still(), vx: RUN_SPEED });
        const walking = bob({ ...still(), vx: RUN_SPEED / 2 });
        const aimed = bob({ ...still(), vx: RUN_SPEED, aim: 1 });
        const air = bob({ ...still(), vx: RUN_SPEED, onGround: false });
        expect(running).toBeGreaterThan(0.005);
        expect(walking).toBeLessThan(running);
        expect(aimed).toBeLessThan(running * 0.3);
        expect(air).toBeLessThan(running * 0.05);
    });

    it('dips on landing and trails a turn', () => {
        const f = new ViewFeel();
        run(f, { ...still(), onGround: false, vy: -8 }, 0.2);
        let low = 0;
        run(f, still(), 0.3, () => { low = Math.min(low, f.pos[1]); });
        expect(low).toBeLessThan(-0.01);
        const g = new ViewFeel();
        const s = still();
        let yawLag = 0;
        for (let i = 0; i < 20; i++) { s.yaw += 0.05; g.update(1 / 60, s); yawLag = g.rot[1]; } // turning left at 3 rad/s
        expect(yawLag).toBeLessThan(-1); // the weapon trails to the right
        run(g, s, 1.5);
        expect(Math.abs(g.rot[1])).toBeLessThan(0.05); // and settles back
    });
});
