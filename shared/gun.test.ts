import { describe, expect, it } from 'vitest';
import {
    DRY_FIRE_TICKS, FIRE_INTERVAL_TICKS, MAG_SIZE, RECOIL_DECAY_TICKS, RECOIL_RECOVER_TICKS, RELOAD_TICKS,
    RESERVE_AMMO, RUN_SPEED, SPREAD_AIR, SPREAD_CROUCHED, SPREAD_STILL, WALK_SPEED
} from './constants';
import {
    GUN_DRY, GUN_IDLE, GUN_RELOAD, RECOIL_SHOTS, createGunState, recoilPitch, recoilYaw, resetGun, shotDirection,
    spreadAngle, spreadOffset, stepGun, type GunState
} from './gun';
import { createPlayerState } from './movement';
import { viewDir } from './raycast';
import type { Vec3 } from './types';

/** Runs `n` commands with the given buttons; returns what each one did. */
function run(g: GunState, n: number, fire: boolean, reload = false, armed = true): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(stepGun(g, fire, reload, armed));
    return out;
}
const shotsIn = (results: number[]) => results.filter(r => r >= 0).length;

describe('ammunition and reload', () => {
    it('empties the magazine at the fire rate, then refuses to fire', () => {
        const g = createGunState();
        expect(g).toMatchObject({ mag: MAG_SIZE, reserve: RESERVE_AMMO, reload: 0 });
        const results = run(g, MAG_SIZE * FIRE_INTERVAL_TICKS, true);
        expect(shotsIn(results)).toBe(MAG_SIZE);
        expect(results.slice(0, FIRE_INTERVAL_TICKS + 1)).toEqual([0, ...Array(FIRE_INTERVAL_TICKS - 1).fill(GUN_IDLE), 1]);
        expect(g.mag).toBe(0);
        expect(g.reserve).toBe(RESERVE_AMMO);
    });

    it('reloads automatically when firing on empty, blocking fire for exactly the reload time', () => {
        const g = createGunState();
        g.mag = 0;
        expect(stepGun(g, true, false, true)).toBe(GUN_RELOAD);
        expect(g.reload).toBe(RELOAD_TICKS);
        // Holding fire through the reload does nothing until the last command of it.
        const during = run(g, RELOAD_TICKS - 1, true);
        expect(during.every(r => r === GUN_IDLE)).toBe(true);
        expect(g.mag).toBe(0);
        expect(stepGun(g, true, false, true)).toBe(0); // reload completes and the shot goes
        expect(g).toMatchObject({ mag: MAG_SIZE - 1, reserve: RESERVE_AMMO - MAG_SIZE, reload: 0 });
    });

    it('starts a reload on R only with a partial magazine and spare rounds', () => {
        const g = createGunState();
        expect(stepGun(g, false, true, true)).toBe(GUN_IDLE); // full magazine
        run(g, 5 * FIRE_INTERVAL_TICKS, true);
        expect(g.mag).toBe(MAG_SIZE - 5);
        expect(stepGun(g, false, true, false)).toBe(GUN_IDLE); // not while hands are busy or frozen
        expect(stepGun(g, false, true, true)).toBe(GUN_RELOAD);
        expect(stepGun(g, false, true, true)).toBe(GUN_IDLE); // already reloading: no restart
        run(g, RELOAD_TICKS - 1, false);
        // Only the five spent rounds come out of the reserve.
        expect(g).toMatchObject({ mag: MAG_SIZE, reserve: RESERVE_AMMO - 5, reload: 0 });

        const empty = createGunState();
        empty.mag = 10;
        empty.reserve = 0;
        expect(stepGun(empty, false, true, true)).toBe(GUN_IDLE);
    });

    it('keeps counting a reload while the trigger cannot act', () => {
        const g = createGunState();
        g.mag = 3;
        stepGun(g, false, true, true);
        run(g, RELOAD_TICKS - 1, false, false, false);
        expect(g.mag).toBe(3);
        stepGun(g, false, false, false);
        expect(g.mag).toBe(MAG_SIZE);
    });

    it('tops up from a short reserve and then runs dry with a rate-limited click', () => {
        const g = createGunState();
        g.mag = 0;
        g.reserve = 7;
        stepGun(g, true, false, true);
        run(g, RELOAD_TICKS, false);
        expect(g).toMatchObject({ mag: 7, reserve: 0 });
        const results = run(g, 7 * FIRE_INTERVAL_TICKS + 2 * DRY_FIRE_TICKS, true);
        expect(shotsIn(results)).toBe(7);
        expect(results.filter(r => r === GUN_DRY)).toHaveLength(2);
        expect(results.includes(GUN_RELOAD)).toBe(false);
    });

    it('resets to a full gun at spawn, cancelling a reload', () => {
        const g = createGunState();
        g.mag = 2; g.reserve = 11; g.reload = 50; g.burst = 9; g.cooldown = 3; g.sinceShot = 1;
        resetGun(g);
        expect(g).toEqual(createGunState());
    });
});

describe('gun tuning', () => {
    it('fits every counter in the one byte the snapshot gives it', () => {
        for (const v of [MAG_SIZE, RESERVE_AMMO, RELOAD_TICKS, DRY_FIRE_TICKS, FIRE_INTERVAL_TICKS]) expect(v).toBeLessThanOrEqual(255);
        // A full pattern recovers before the since-shot counter saturates at 255.
        expect(RECOIL_RECOVER_TICKS + RECOIL_SHOTS * RECOIL_DECAY_TICKS).toBeLessThan(255);
        expect(RECOIL_RECOVER_TICKS).toBeGreaterThan(FIRE_INTERVAL_TICKS); // sustained fire never recovers
        expect(RELOAD_TICKS).toBe(132); // 2.2 s
    });
});

describe('recoil pattern', () => {
    it('gives each shot of a burst its own row, climbing first', () => {
        const g = createGunState();
        const results = run(g, 12 * FIRE_INTERVAL_TICKS, true).filter(r => r >= 0);
        expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        expect(recoilPitch(0)).toBe(0);
        expect(recoilYaw(0)).toBe(0);
        for (let i = 1; i < 8; i++) expect(recoilPitch(i)).toBeGreaterThan(recoilPitch(i - 1));
        // Later it drifts side to side.
        let min = 0, max = 0;
        for (let i = 10; i < RECOIL_SHOTS; i++) { min = Math.min(min, recoilYaw(i)); max = Math.max(max, recoilYaw(i)); }
        expect(min).toBeLessThan(-0.01);
        expect(max).toBeGreaterThan(0.01);
    });

    it('stays on the last row past the end of the table', () => {
        const g = createGunState();
        g.burst = RECOIL_SHOTS - 1;
        expect(stepGun(g, true, false, true)).toBe(RECOIL_SHOTS - 1);
        expect(g.burst).toBe(RECOIL_SHOTS - 1);
        expect(recoilPitch(RECOIL_SHOTS + 5)).toBe(recoilPitch(RECOIL_SHOTS - 1));
    });

    it('does not recover during sustained fire, then recovers one row at a time after a pause', () => {
        const g = createGunState();
        run(g, 10 * FIRE_INTERVAL_TICKS - (FIRE_INTERVAL_TICKS - 1), true); // exactly 10 shots, the last on the final command
        expect(g.burst).toBe(10);
        run(g, RECOIL_RECOVER_TICKS - 1, false);
        expect(g.burst).toBe(10); // short pause: nothing yet
        stepGun(g, false, false, true);
        expect(g.burst).toBe(9);
        run(g, RECOIL_DECAY_TICKS, false);
        expect(g.burst).toBe(8);
        run(g, 8 * RECOIL_DECAY_TICKS, false);
        expect(g.burst).toBe(0);
        run(g, 200, false);
        expect(g.burst).toBe(0);
        expect(stepGun(g, true, false, true)).toBe(0); // the next burst starts from the top
    });
});

describe('spread', () => {
    const state = (speed: number, onGround = true, crouched = false) => {
        const s = createPlayerState([0, 0, 0]);
        s.vel[0] = speed; s.onGround = onGround; s.crouched = crouched;
        return s;
    };

    it('is smallest crouched and still, grows with speed, and is largest in the air', () => {
        expect(spreadAngle(state(0, true, true))).toBe(SPREAD_CROUCHED);
        expect(spreadAngle(state(0))).toBe(SPREAD_STILL);
        expect(spreadAngle(state(WALK_SPEED))).toBeGreaterThan(SPREAD_STILL);
        expect(spreadAngle(state(RUN_SPEED))).toBeGreaterThan(spreadAngle(state(WALK_SPEED)));
        expect(spreadAngle(state(0, false))).toBe(SPREAD_AIR);
        expect(SPREAD_AIR).toBeGreaterThan(spreadAngle(state(RUN_SPEED)));
    });

    it('is a pure function of the command and the shooter, inside the cone', () => {
        const a: [number, number] = [0, 0], b: [number, number] = [0, 0];
        const seen = new Set<string>();
        for (let seq = 0; seq < 500; seq++) {
            spreadOffset(seq, 3, 0.01, a);
            spreadOffset(seq, 3, 0.01, b);
            expect(b).toEqual(a); // what the client predicts is what the server traces
            expect(Math.hypot(a[0], a[1])).toBeLessThanOrEqual(0.01 + 1e-12);
            seen.add(a.join());
        }
        expect(seen.size).toBeGreaterThan(490); // it actually varies shot to shot
        spreadOffset(42, 3, 0.01, a);
        spreadOffset(42, 4, 0.01, b);
        expect(b).not.toEqual(a); // and between shooters
        // Pinned values: a change to the hash is a protocol change (client and server must agree).
        spreadOffset(1000, 2, 1, a);
        expect(a[0]).toBeCloseTo(-0.9688058560798729, 12);
        expect(a[1]).toBeCloseTo(-0.0778169761949781, 12);
    });

    it('fills the cone roughly evenly', () => {
        const o: [number, number] = [0, 0];
        let inner = 0, right = 0, up = 0;
        const n = 4000;
        for (let seq = 0; seq < n; seq++) {
            spreadOffset(seq, 1, 1, o);
            if (Math.hypot(o[0], o[1]) < Math.SQRT1_2) inner++;
            if (o[1] > 0) right++;
            if (o[0] > 0) up++;
        }
        // Half the area of a disc lies inside radius 1/sqrt(2).
        for (const count of [inner, right, up]) expect(Math.abs(count / n - 0.5)).toBeLessThan(0.05);
    });

    it('builds the shot direction from view, recoil and spread', () => {
        const dir: Vec3 = [0, 0, 0], plain: Vec3 = [0, 0, 0];
        shotDirection(0.3, -0.1, 0, 0, 7, 1, dir);
        expect(dir).toEqual(viewDir(0.3, -0.1, plain)); // first shot, no spread: straight down the view
        shotDirection(0.3, -0.1, 9, 0, 7, 1, dir);
        expect(dir).toEqual(viewDir(0.3 + recoilYaw(9), -0.1 + recoilPitch(9), plain));
        const off: [number, number] = [0, 0];
        spreadOffset(7, 1, 0.02, off);
        shotDirection(0.3, -0.1, 9, 0.02, 7, 1, dir);
        expect(dir).toEqual(viewDir(0.3 + recoilYaw(9) + off[1], -0.1 + recoilPitch(9) + off[0], plain));
    });
});
