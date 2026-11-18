import { describe, expect, it } from 'vitest';
import { DRY_FIRE_TICKS, KNIFE_COOLDOWN_TICKS, KNIFE_WINDUP_TICKS, RUN_SPEED, WALK_SPEED } from './constants';
import {
    GUN_DRY, GUN_IDLE, GUN_RELOAD, aimFraction, cancelReloads, copyLoadout, createGunState, createLoadout, emptyReload, heldGun,
    justSwitched, recoilPitch, reloadProgress, reloadTicksOf, recoilScale, recoilYaw, resetGun, resetLoadout, sameLoadout, shotDirection,
    shotDirectionFor, spreadAngle, spreadOffset, spreadSeed, stepGun, stepLoadout, type GunState, type LoadoutInput,
    type LoadoutState
} from './gun';
import { createPlayerState } from './movement';
import { viewDir } from './raycast';
import type { Vec3 } from './types';
import {
    DEFENDER_KNIFE, GUN_COUNT, SIGHTS, SIGHT_COUNT, SIGHT_IRON, adsTicksOf, adsZoomOf, cleanSight, sightDef, SLOT_COUNT, SLOT_PISTOL, SLOT_RIFLE, WEAPONS, type WeaponDef
} from './weapons';

const RIFLE = WEAPONS[SLOT_RIFLE];
const PISTOL = WEAPONS[SLOT_PISTOL];

/** Runs `n` commands of one weapon with the given buttons; returns what each one did. */
function run(g: GunState, def: WeaponDef, n: number, fire: boolean, reload = false, armed = true): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(stepGun(g, def, fire, reload, armed));
    return out;
}
const shotsIn = (results: number[]) => results.filter(r => r >= 0).length;

const input = (over: Partial<LoadoutInput> = {}): LoadoutInput =>
    ({ fire: false, reload: false, slot: 0, swap: false, aim: false, ...over });
/** Runs `n` loadout commands built by `each(i)`; returns what each one did. */
function runL(l: LoadoutState, n: number, each: (i: number) => Partial<LoadoutInput> = () => ({}), armed = true): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(stepLoadout(l, input(each(i)), armed));
    return out;
}
/** A fresh loadout with the pistol drawn and ready. */
function pistolReady(): LoadoutState {
    const l = createLoadout();
    runL(l, PISTOL.drawTicks + 1, i => (i === 0 ? { slot: 2 } : {}));
    expect(l).toMatchObject({ slot: SLOT_PISTOL, draw: 0 });
    return l;
}

describe('weapon table', () => {
    it('keeps the rifle as it was and gives the pistol its own numbers', () => {
        expect(RIFLE).toMatchObject({ auto: true, fireInterval: 6, magSize: 30, reserve: 90, reloadTicks: 132, bodyDamage: 34 });
        expect(PISTOL).toMatchObject({ auto: false, fireInterval: 9, magSize: 12, reserve: 36, reloadTicks: 84, bodyDamage: 26 });
        expect(RIFLE.drawTicks).toBe(24); // 0.4 s
        expect(PISTOL.drawTicks).toBe(15); // 0.25 s
        expect(PISTOL.spreadStill).toBeLessThan(RIFLE.spreadStill);
        expect(PISTOL.spreadMoving).toBeLessThan(RIFLE.spreadMoving);
        expect(RIFLE.adsZoom).toBe(1.3); // the iron sight's (package M; was 1.5 before sights)
        expect(PISTOL.adsZoom).toBe(1.2);
    });

    it('fits every counter of every weapon in the one byte the snapshot gives it', () => {
        expect(SLOT_COUNT).toBeLessThanOrEqual(15); // the command's slot field and the remote weapon byte
        for (const d of WEAPONS) {
            for (const v of [d.magSize, d.reserve, d.reloadTicks, d.reloadEmptyTicks, d.drawTicks, d.adsTicks, d.fireInterval, d.patternDeg.length, DRY_FIRE_TICKS]) {
                expect(Number.isInteger(v)).toBe(true);
                expect(v).toBeGreaterThan(0);
                expect(v).toBeLessThanOrEqual(255);
            }
            // A full pattern recovers before the since-shot counter saturates at 255.
            expect(d.recoilRecoverTicks + d.patternDeg.length * d.recoilDecayTicks).toBeLessThan(255);
            expect(d.recoilRecoverTicks).toBeGreaterThan(d.fireInterval); // firing at the limit never recovers
            expect(d.adsSpread).toBeGreaterThan(0);
            expect(d.adsSpread).toBeLessThan(1);
            expect(d.adsRecoil).toBeGreaterThan(0);
            expect(d.adsRecoil).toBeLessThan(1);
        }
        // The spread seed (shots + 256 * slot) stays a small integer; the knife timing travels in one byte each too.
        expect(255 + 256 * (GUN_COUNT - 1)).toBeLessThan(2 ** 31);
        for (const v of [KNIFE_COOLDOWN_TICKS, KNIFE_WINDUP_TICKS]) expect(v).toBeLessThanOrEqual(255);
        // The defender knife (slot 3): its draw, windup and cooldown counters travel in one byte each.
        for (const v of [DEFENDER_KNIFE.drawTicks, DEFENDER_KNIFE.windupTicks, DEFENDER_KNIFE.cooldownTicks]) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThan(0);
            expect(v).toBeLessThanOrEqual(255);
        }
    });
});

describe.each([
    ['rifle', RIFLE],
    ['pistol', PISTOL]
] as const)('%s ammunition and reload', (_name, def) => {
    it('empties the magazine at the fire rate, then refuses to fire', () => {
        const g = createGunState(def);
        expect(g).toMatchObject({ mag: def.magSize, reserve: def.reserve, reload: 0 });
        const results = run(g, def, def.magSize * def.fireInterval, true);
        expect(shotsIn(results)).toBe(def.magSize);
        expect(results.slice(0, def.fireInterval + 1)).toEqual([0, ...Array(def.fireInterval - 1).fill(GUN_IDLE), 1]);
        expect(g.mag).toBe(0);
        expect(g.reserve).toBe(def.reserve);
    });

    it('reloads automatically when firing on empty, blocking fire for exactly the empty reload time', () => {
        const g = createGunState(def);
        g.mag = 0;
        expect(stepGun(g, def, true, false, true)).toBe(GUN_RELOAD);
        expect(g.reload).toBe(def.reloadEmptyTicks);
        const during = run(g, def, def.reloadEmptyTicks - 1, true);
        expect(during.every(r => r === GUN_IDLE)).toBe(true);
        expect(g.mag).toBe(0);
        expect(stepGun(g, def, true, false, true)).toBe(0); // reload completes and the shot goes
        expect(g).toMatchObject({ mag: def.magSize - 1, reserve: def.reserve - def.magSize, reload: 0 });
    });

    it('starts a reload on R only with a partial magazine and spare rounds', () => {
        const g = createGunState(def);
        expect(stepGun(g, def, false, true, true)).toBe(GUN_IDLE); // full magazine
        run(g, def, 5 * def.fireInterval, true);
        expect(g.mag).toBe(def.magSize - 5);
        expect(stepGun(g, def, false, true, false)).toBe(GUN_IDLE); // not while hands are busy or frozen
        expect(stepGun(g, def, false, true, true)).toBe(GUN_RELOAD);
        expect(stepGun(g, def, false, true, true)).toBe(GUN_IDLE); // already reloading: no restart
        run(g, def, def.reloadTicks - 1, false);
        expect(g).toMatchObject({ mag: def.magSize, reserve: def.reserve - 5, reload: 0 });

        const empty = createGunState(def);
        empty.mag = 3;
        empty.reserve = 0;
        expect(stepGun(empty, def, false, true, true)).toBe(GUN_IDLE);
    });

    it('tops up from a short reserve and then runs dry with a rate-limited click', () => {
        const g = createGunState(def);
        g.mag = 0;
        g.reserve = 7;
        stepGun(g, def, true, false, true);
        run(g, def, def.reloadEmptyTicks, false);
        expect(g).toMatchObject({ mag: 7, reserve: 0 });
        const results = run(g, def, 7 * def.fireInterval + 2 * DRY_FIRE_TICKS, true);
        expect(shotsIn(results)).toBe(7);
        expect(results.filter(r => r === GUN_DRY)).toHaveLength(2);
        expect(results.includes(GUN_RELOAD)).toBe(false);
    });

    it('resets to a full weapon, cancelling a reload', () => {
        const g = createGunState(def);
        g.mag = 2; g.reserve = 11; g.reload = 50; g.burst = 9; g.cooldown = 3; g.sinceShot = 1; g.shots = 40;
        resetGun(g, def);
        expect(g).toEqual(createGunState(def));
    });

    it('does not recover recoil during sustained fire, then recovers one row at a time after a pause', () => {
        const g = createGunState(def);
        g.reserve = 0;
        const shots = Math.min(10, def.magSize);
        run(g, def, shots * def.fireInterval - (def.fireInterval - 1), true); // the last shot on the final command
        expect(g.burst).toBe(shots);
        run(g, def, def.recoilRecoverTicks - 1, false);
        expect(g.burst).toBe(shots); // short pause: nothing yet
        stepGun(g, def, false, false, true);
        expect(g.burst).toBe(shots - 1);
        run(g, def, def.recoilDecayTicks, false);
        expect(g.burst).toBe(shots - 2);
        run(g, def, 255, false);
        expect(g.burst).toBe(0);
    });
});

describe('empty reload (package R)', () => {
    it('makes the rifle take 2.7 s (162 commands) from an empty magazine and keeps 2.2 s for a tactical reload', () => {
        expect(RIFLE.reloadEmptyTicks).toBe(162);
        expect(RIFLE.reloadTicks).toBe(132);
        // The pistol has no separate empty reload.
        expect(PISTOL.reloadEmptyTicks).toBe(PISTOL.reloadTicks);
        for (const d of WEAPONS) expect(d.reloadEmptyTicks).toBeGreaterThanOrEqual(d.reloadTicks);
    });

    for (const def of WEAPONS) {
        it(`${def.id}: R on an empty magazine starts the empty reload, R on a partial one the tactical reload`, () => {
            const empty = createGunState(def);
            empty.mag = 0;
            expect(reloadTicksOf(empty, def)).toBe(def.reloadEmptyTicks);
            expect(stepGun(empty, def, false, true, true)).toBe(GUN_RELOAD);
            expect(empty.reload).toBe(def.reloadEmptyTicks);
            expect(emptyReload(empty)).toBe(true);

            const partial = createGunState(def);
            partial.mag = 1;
            expect(reloadTicksOf(partial, def)).toBe(def.reloadTicks);
            expect(stepGun(partial, def, false, true, true)).toBe(GUN_RELOAD);
            expect(partial.reload).toBe(def.reloadTicks);
            expect(emptyReload(partial)).toBe(false);
        });
    }

    it('stays an empty reload from its first to its last command, its progress running 0 to 1 over its own length', () => {
        const g = createGunState(RIFLE);
        g.mag = 0;
        stepGun(g, RIFLE, true, false, true);
        expect(reloadProgress(g, RIFLE)).toBe(0);
        const seen: number[] = [];
        for (let i = 1; i < RIFLE.reloadEmptyTicks; i++) {
            expect(stepGun(g, RIFLE, false, false, true)).toBe(GUN_IDLE);
            expect(emptyReload(g)).toBe(true); // the magazine stays empty until the last command
            seen.push(reloadProgress(g, RIFLE));
        }
        expect(seen[0]).toBeCloseTo(1 / RIFLE.reloadEmptyTicks, 9);
        expect(seen[seen.length - 1]).toBeCloseTo(1 - 1 / RIFLE.reloadEmptyTicks, 9);
        for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
        stepGun(g, RIFLE, false, false, true); // completes
        expect(g).toMatchObject({ mag: RIFLE.magSize, reload: 0 });
        expect(emptyReload(g)).toBe(false);
        expect(reloadProgress(g, RIFLE)).toBe(0);
    });

    it('counts only commands the loadout steps: frozen or busy commands still run it, a switch cancels it for nothing', () => {
        const l = createLoadout();
        l.guns[SLOT_RIFLE].mag = 0;
        expect(stepLoadout(l, input({ fire: true }), true)).toBe(GUN_RELOAD);
        // Timers run while unarmed (freeze, defusing): the reload completes exactly its length after it started.
        runL(l, RIFLE.reloadEmptyTicks - 1, () => ({}), false);
        expect(l.guns[SLOT_RIFLE]).toMatchObject({ mag: 0, reload: 1 });
        runL(l, 1, () => ({}), false);
        expect(l.guns[SLOT_RIFLE]).toMatchObject({ mag: RIFLE.magSize, reload: 0 });

        const c = createLoadout();
        c.guns[SLOT_RIFLE].mag = 0;
        stepLoadout(c, input({ reload: true }), true);
        runL(c, RIFLE.reloadTicks); // past a tactical reload's length: still going
        expect(c.guns[SLOT_RIFLE]).toMatchObject({ mag: 0, reload: RIFLE.reloadEmptyTicks - RIFLE.reloadTicks });
        stepLoadout(c, input({ slot: 2 }), true);
        expect(c.guns[SLOT_RIFLE]).toMatchObject({ mag: 0, reserve: RIFLE.reserve, reload: 0 });
    });
});

describe('recoil patterns', () => {
    it('gives each rifle shot of a burst its own row, climbing first, then drifting side to side', () => {
        const g = createGunState(RIFLE);
        const results = run(g, RIFLE, 12 * RIFLE.fireInterval, true).filter(r => r >= 0);
        expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        expect(recoilPitch(RIFLE, 0)).toBe(0);
        expect(recoilYaw(RIFLE, 0)).toBe(0);
        for (let i = 1; i < 8; i++) expect(recoilPitch(RIFLE, i)).toBeGreaterThan(recoilPitch(RIFLE, i - 1));
        let min = 0, max = 0;
        for (let i = 10; i < RIFLE.patternDeg.length; i++) {
            min = Math.min(min, recoilYaw(RIFLE, i));
            max = Math.max(max, recoilYaw(RIFLE, i));
        }
        expect(min).toBeLessThan(-0.01);
        expect(max).toBeGreaterThan(0.01);
        // The original rifle pattern, unchanged.
        expect(recoilPitch(RIFLE, 29)).toBeCloseTo(4.75 * Math.PI / 180, 12);
    });

    it('kicks the pistol harder per shot than the rifle', () => {
        expect(recoilPitch(PISTOL, 1)).toBeGreaterThan(2 * recoilPitch(RIFLE, 1));
        for (let i = 1; i < PISTOL.patternDeg.length; i++) expect(recoilPitch(PISTOL, i)).toBeGreaterThan(recoilPitch(PISTOL, i - 1));
    });

    it('stays on the last row past the end of the table', () => {
        for (const def of WEAPONS) {
            const g = createGunState(def);
            const last = def.patternDeg.length - 1;
            g.burst = last;
            expect(stepGun(g, def, true, false, true)).toBe(last);
            expect(g.burst).toBe(last);
            expect(recoilPitch(def, last + 5)).toBe(recoilPitch(def, last));
        }
    });

    it('lets measured pistol taps recover fully between shots', () => {
        const l = pistolReady();
        // One press every 12 commands, a little slower than the 9-command limit.
        const results = runL(l, 6 * 12, i => ({ fire: i % 12 === 0 }));
        expect(results.filter(r => r >= 0)).toEqual([0, 0, 0, 0, 0, 0]);
        // At the limit (a press every 9 commands) it climbs.
        const fast = pistolReady();
        const climbing = runL(fast, 6 * 9, i => ({ fire: i % 9 === 0 }));
        expect(climbing.filter(r => r >= 0)).toEqual([0, 1, 2, 3, 4, 5]);
    });
});

describe('semi-automatic trigger', () => {
    it('fires the pistol once per press however long the trigger is held', () => {
        const l = pistolReady();
        const held = runL(l, 120, () => ({ fire: true }));
        expect(shotsIn(held)).toBe(1);
        expect(l.trigger).toBe(1);
        runL(l, 1); // release
        expect(l.trigger).toBe(0);
        expect(shotsIn(runL(l, 1, () => ({ fire: true })))).toBe(1);
    });

    it('holds a press made during the interval until the weapon is ready, and never faster than the interval', () => {
        const l = pistolReady();
        expect(stepLoadout(l, input({ fire: true }), true)).toBe(0);
        runL(l, 1); // release, then press again straight away and hold
        const again = runL(l, PISTOL.fireInterval, () => ({ fire: true }));
        // The second shot goes on the first command the interval allows: 1 + 1 + (interval - 2) commands later.
        expect(again.findIndex(r => r >= 0)).toBe(PISTOL.fireInterval - 2);
        expect(shotsIn(again)).toBe(1);
        // Pressing on every other command cannot beat the interval.
        const spam = pistolReady();
        const r = runL(spam, 10 * PISTOL.fireInterval, i => ({ fire: i % 2 === 0 }));
        expect(shotsIn(r)).toBeLessThanOrEqual(10);
        expect(shotsIn(r)).toBeGreaterThanOrEqual(9);
    });

    it('needs a new press after a reload on empty and between dry clicks', () => {
        const l = pistolReady();
        heldGun(l)!.mag = 0;
        expect(stepLoadout(l, input({ fire: true }), true)).toBe(GUN_RELOAD);
        // Still holding through the reload: nothing fires when it completes.
        expect(shotsIn(runL(l, PISTOL.reloadTicks + 30, () => ({ fire: true })))).toBe(0);
        expect(heldGun(l)!.mag).toBe(PISTOL.magSize);
        runL(l, 1);
        expect(stepLoadout(l, input({ fire: true }), true)).toBe(0);

        const dry = pistolReady();
        heldGun(dry)!.mag = 0;
        heldGun(dry)!.reserve = 0;
        const held = runL(dry, 100, () => ({ fire: true }));
        expect(held.filter(r => r === GUN_DRY)).toHaveLength(1);
    });

    it('keeps the rifle automatic', () => {
        const l = createLoadout();
        expect(shotsIn(runL(l, 10 * RIFLE.fireInterval, () => ({ fire: true })))).toBe(10);
    });

    it('does not fire a freshly drawn pistol from a trigger held since the rifle', () => {
        const l = createLoadout();
        runL(l, 3, () => ({ fire: true }));
        runL(l, PISTOL.drawTicks + 10, i => ({ fire: true, slot: i === 0 ? 2 : 0 }));
        expect(l.slot).toBe(SLOT_PISTOL);
        expect(heldGun(l)!.mag).toBe(PISTOL.magSize);
        runL(l, 1);
        expect(stepLoadout(l, input({ fire: true }), true)).toBe(0);
    });
});

describe('switching', () => {
    it('starts with the rifle in hand and every weapon full', () => {
        const l = createLoadout();
        expect(l).toMatchObject({ slot: SLOT_RIFLE, prev: SLOT_PISTOL, draw: 0, aim: 0, trigger: 0 });
        WEAPONS.forEach((d, i) => expect(l.guns[i]).toEqual(createGunState(d)));
    });

    it('blocks fire for exactly the draw time of the weapon selected', () => {
        for (const [slot, def] of [[SLOT_PISTOL, PISTOL], [SLOT_RIFLE, RIFLE]] as const) {
            const l = createLoadout();
            if (slot === SLOT_RIFLE) { runL(l, PISTOL.drawTicks, i => (i === 0 ? { slot: 2 } : {})); runL(l, 1); }
            // Select on the first command and hold the trigger (press again each command for the pistol's sake).
            const results = runL(l, def.drawTicks + 1, i => ({ slot: i === 0 ? slot + 1 : 0, fire: true }));
            expect(results.findIndex(r => r >= 0)).toBe(def.drawTicks);
            expect(justSwitched(l)).toBe(false);
        }
    });

    it('reports the switch only on the command it starts', () => {
        const l = createLoadout();
        stepLoadout(l, input({ slot: 2 }), true);
        expect(justSwitched(l)).toBe(true);
        stepLoadout(l, input(), true);
        expect(justSwitched(l)).toBe(false);
        expect(l.draw).toBe(PISTOL.drawTicks - 1);
    });

    it('ignores a request for the slot in hand or a slot that does not exist', () => {
        const l = createLoadout();
        for (const slot of [1, 0, SLOT_COUNT + 1, 15, 255]) stepLoadout(l, input({ slot }), true);
        expect(l).toMatchObject({ slot: SLOT_RIFLE, draw: 0 });
        expect(sameLoadout(l, createLoadout())).toBe(true);
    });

    it('goes back to the previous weapon on Q, and a slot key wins over Q', () => {
        const l = createLoadout();
        stepLoadout(l, input({ swap: true }), true);
        expect(l).toMatchObject({ slot: SLOT_PISTOL, prev: SLOT_RIFLE });
        stepLoadout(l, input({ swap: true }), true); // mid-draw: back again
        expect(l).toMatchObject({ slot: SLOT_RIFLE, prev: SLOT_PISTOL, draw: RIFLE.drawTicks });
        stepLoadout(l, input({ swap: true, slot: 1 }), true);
        expect(l).toMatchObject({ slot: SLOT_RIFLE, draw: RIFLE.drawTicks - 1 });
    });

    it('cancels a reload in progress without giving ammunition, and keeps each magazine and reserve', () => {
        const l = createLoadout();
        runL(l, 5 * RIFLE.fireInterval, () => ({ fire: true }));
        expect(l.guns[SLOT_RIFLE].mag).toBe(RIFLE.magSize - 5);
        expect(stepLoadout(l, input({ reload: true }), true)).toBe(GUN_RELOAD);
        runL(l, RIFLE.reloadTicks - 2); // one command short of completing
        stepLoadout(l, input({ slot: 2 }), true);
        expect(l.guns[SLOT_RIFLE]).toMatchObject({ mag: RIFLE.magSize - 5, reserve: RIFLE.reserve, reload: 0 });
        // Fire three pistol rounds, then switch back: both weapons kept their own counts.
        runL(l, PISTOL.drawTicks);
        runL(l, 3 * 12, i => ({ fire: i % 12 === 0 }));
        expect(l.guns[SLOT_PISTOL]).toMatchObject({ mag: PISTOL.magSize - 3, reserve: PISTOL.reserve });
        runL(l, RIFLE.drawTicks + 300, i => (i === 0 ? { slot: 1 } : {}));
        expect(l.guns[SLOT_RIFLE]).toMatchObject({ mag: RIFLE.magSize - 5, reserve: RIFLE.reserve, reload: 0 });
        expect(l.guns[SLOT_PISTOL]).toMatchObject({ mag: PISTOL.magSize - 3, reserve: PISTOL.reserve, reload: 0 });
    });

    it('cannot reload while drawing, and switches even when the trigger cannot act', () => {
        const l = createLoadout();
        l.guns[SLOT_PISTOL].mag = 4;
        stepLoadout(l, input({ slot: 2 }), false); // frozen: the switch still happens
        expect(l.slot).toBe(SLOT_PISTOL);
        expect(runL(l, PISTOL.drawTicks - 1, () => ({ reload: true })).includes(GUN_RELOAD)).toBe(false);
        expect(stepLoadout(l, input({ reload: true }), true)).toBe(GUN_RELOAD);
    });

    it('lets the weapon not in hand recover its recoil', () => {
        const l = createLoadout();
        runL(l, 10 * RIFLE.fireInterval, () => ({ fire: true }));
        expect(l.guns[SLOT_RIFLE].burst).toBe(10);
        runL(l, 200, i => (i === 0 ? { slot: 2 } : {}));
        expect(l.guns[SLOT_RIFLE].burst).toBe(0);
    });

    it('resets to the rifle with every weapon full at spawn, and death cancels every reload', () => {
        const l = pistolReady();
        heldGun(l)!.mag = 1;
        stepLoadout(l, input({ reload: true, aim: true }), true);
        cancelReloads(l);
        expect(l.guns.every(g => g.reload === 0)).toBe(true);
        expect(heldGun(l)!.mag).toBe(1);
        resetLoadout(l, SIGHT_IRON);
        expect(sameLoadout(l, createLoadout())).toBe(true);
        const copy = createLoadout();
        l.guns[1].shots = 9;
        copyLoadout(copy, l);
        expect(sameLoadout(copy, l)).toBe(true);
        expect(copy.guns[1]).not.toBe(l.guns[1]);
    });
});

describe('rifle sights (package M)', () => {
    it('keeps every sight number that travels within one byte, and the table small enough for its byte', () => {
        expect(SIGHT_COUNT).toBeGreaterThanOrEqual(3);
        expect(SIGHT_COUNT).toBeLessThanOrEqual(255); // LoadoutState.sight, roster, spawn message
        expect(new Set(SIGHTS.map(x => x.id)).size).toBe(SIGHT_COUNT);
        for (const x of SIGHTS) {
            expect(Number.isInteger(x.adsTicks)).toBe(true);
            expect(x.adsTicks).toBeGreaterThan(0);
            expect(x.adsTicks).toBeLessThanOrEqual(255); // LoadoutState.aim travels in one byte
            expect(x.adsZoom).toBeGreaterThanOrEqual(1);
            expect(x.label.length).toBeGreaterThan(0);
            expect(x.blurb.length).toBeGreaterThan(0);
        }
        expect(SIGHTS[SIGHT_IRON].id).toBe('iron');
    });

    it("starts with the brief's untuned values: iron 1.3x/12, red dot 1.4x/12, 2x scope 2.0x/16", () => {
        expect(SIGHTS.map(x => [x.id, x.adsZoom, x.adsTicks])).toEqual([
            ['iron', 1.3, 12], ['reddot', 1.4, 12], ['scope2x', 2.0, 16]
        ]);
    });

    it('applies only to the rifle: the pistol keeps its own aim, the knife has none', () => {
        expect(RIFLE.takesSights).toBe(true);
        expect(PISTOL.takesSights).toBe(false);
        for (let sight = 0; sight < SIGHT_COUNT; sight++) {
            expect(adsTicksOf(SLOT_RIFLE, sight)).toBe(SIGHTS[sight].adsTicks);
            expect(adsZoomOf(SLOT_RIFLE, sight)).toBe(SIGHTS[sight].adsZoom);
            expect(adsTicksOf(SLOT_PISTOL, sight)).toBe(PISTOL.adsTicks);
            expect(adsZoomOf(SLOT_PISTOL, sight)).toBe(PISTOL.adsZoom);
            expect(adsZoomOf(SLOT_COUNT - 1, sight)).toBe(1);
        }
        // The rifle's own numbers are the iron sight's, for code with no loadout at hand.
        expect(RIFLE.adsTicks).toBe(SIGHTS[SIGHT_IRON].adsTicks);
        expect(RIFLE.adsZoom).toBe(SIGHTS[SIGHT_IRON].adsZoom);
    });

    it('cleans any outside value to a valid index, iron when unreadable', () => {
        expect(cleanSight(0)).toBe(0);
        expect(cleanSight(2)).toBe(2);
        expect(cleanSight('1')).toBe(1);
        for (const bad of [-1, SIGHT_COUNT, 1.5, '1.5', '', 'x', null, undefined, {}, '0001', NaN]) expect(cleanSight(bad)).toBe(SIGHT_IRON);
        expect(sightDef(99)).toBe(SIGHTS[SIGHT_IRON]);
    });

    it("mounts the sight only at a spawn and aims in at that sight's pace", () => {
        for (let sight = 0; sight < SIGHT_COUNT; sight++) {
            const l = createLoadout();
            resetLoadout(l, sight);
            expect(l.sight).toBe(sight);
            const t = SIGHTS[sight].adsTicks;
            runL(l, t - 1, () => ({ aim: true }));
            expect(aimFraction(l)).toBeLessThan(1);
            stepLoadout(l, input({ aim: true }), true);
            expect(aimFraction(l)).toBe(1);
            runL(l, 5, () => ({ aim: true }));
            expect(l.aim).toBe(t);
            // Recoil and spread scale by aim fraction exactly as before: the sight does not change them.
            expect(recoilScale(l)).toBeCloseTo(RIFLE.adsRecoil, 15);
            // Commands never change the sight.
            runL(l, 30, i => ({ slot: (i % 3) + 1, aim: true, fire: i % 2 === 0, reload: true, swap: true }));
            expect(l.sight).toBe(sight);
        }
        const bad = createLoadout();
        resetLoadout(bad, 77);
        expect(bad.sight).toBe(SIGHT_IRON);
    });

    it("eases a 2x scope out into the pistol's range on a switch", () => {
        const l = createLoadout();
        resetLoadout(l, 2);
        runL(l, SIGHTS[2].adsTicks, () => ({ aim: true }));
        expect(l.aim).toBe(16);
        stepLoadout(l, input({ slot: 2, aim: true }), true);
        expect(l.aim).toBe(PISTOL.adsTicks - 1);
    });

    it('copies and compares the sight with the rest of the loadout', () => {
        const a = createLoadout(), b = createLoadout();
        resetLoadout(a, 1);
        expect(sameLoadout(a, b)).toBe(false);
        copyLoadout(b, a);
        expect(b.sight).toBe(1);
        expect(sameLoadout(a, b)).toBe(true);
    });
});

describe('aim down sights', () => {
    it('takes the weapon\'s aim time to go in and out, and only when ready', () => {
        const l = createLoadout();
        runL(l, RIFLE.adsTicks - 1, () => ({ aim: true }));
        expect(aimFraction(l)).toBeLessThan(1);
        stepLoadout(l, input({ aim: true }), true);
        expect(aimFraction(l)).toBe(1);
        runL(l, 10, () => ({ aim: true }));
        expect(l.aim).toBe(RIFLE.adsTicks);
        runL(l, RIFLE.adsTicks - 1);
        expect(l.aim).toBe(1);
        stepLoadout(l, input(), true);
        expect(l.aim).toBe(0);
        // Not while drawing or reloading.
        stepLoadout(l, input({ slot: 2, aim: true }), true);
        runL(l, PISTOL.drawTicks - 1, () => ({ aim: true }));
        expect(l.aim).toBe(0);
        stepLoadout(l, input({ aim: true }), true);
        expect(l.aim).toBe(1);
        heldGun(l)!.mag = 3;
        runL(l, PISTOL.adsTicks, () => ({ aim: true }));
        stepLoadout(l, input({ aim: true, reload: true }), true);
        runL(l, PISTOL.adsTicks, () => ({ aim: true }));
        expect(l.aim).toBe(0);
    });

    it('eases out over a switch rather than snapping', () => {
        const l = createLoadout();
        runL(l, RIFLE.adsTicks, () => ({ aim: true }));
        stepLoadout(l, input({ slot: 2, aim: true }), true);
        expect(l.aim).toBe(PISTOL.adsTicks - 1); // clamped into the pistol's range, then one step out
    });

    it('narrows spread and softens recoil in proportion to aim', () => {
        const s = createPlayerState([0, 0, 0]);
        s.onGround = true;
        s.vel[0] = WALK_SPEED;
        for (const def of WEAPONS) {
            const hip = spreadAngle(s, def, 0);
            expect(spreadAngle(s, def, 1)).toBeCloseTo(hip * def.adsSpread, 15);
            expect(spreadAngle(s, def, 0.5)).toBeCloseTo(hip * (1 + def.adsSpread) / 2, 15);
        }
        const l = createLoadout();
        expect(recoilScale(l)).toBe(1);
        runL(l, RIFLE.adsTicks, () => ({ aim: true }));
        expect(recoilScale(l)).toBeCloseTo(RIFLE.adsRecoil, 15);

        // The shot direction carries the scaled recoil and narrowed spread.
        l.guns[0].burst = 9;
        const r = stepLoadout(l, input({ fire: true, aim: true }), true);
        expect(r).toBe(9);
        const dir: Vec3 = [0, 0, 0], expected: Vec3 = [0, 0, 0];
        shotDirectionFor(l, s, 0.2, 0.1, r, 3, dir);
        shotDirection(0.2, 0.1, RIFLE, 9, RIFLE.adsRecoil, spreadAngle(s, RIFLE, 1), spreadSeed(l), 3, expected);
        expect(dir).toEqual(expected);
        const hip: Vec3 = [0, 0, 0];
        shotDirection(0.2, 0.1, RIFLE, 9, 1, spreadAngle(s, RIFLE, 0), spreadSeed(l), 3, hip);
        expect(dir).not.toEqual(hip);
    });
});

describe('spread', () => {
    const state = (speed: number, onGround = true, crouched = false) => {
        const s = createPlayerState([0, 0, 0]);
        s.vel[0] = speed; s.onGround = onGround; s.crouched = crouched;
        return s;
    };

    it('is smallest crouched and still, grows with speed, and is largest in the air, for every weapon', () => {
        for (const def of WEAPONS) {
            expect(spreadAngle(state(0, true, true), def)).toBe(def.spreadCrouched);
            expect(spreadAngle(state(0), def)).toBe(def.spreadStill);
            expect(spreadAngle(state(WALK_SPEED), def)).toBeGreaterThan(def.spreadStill);
            expect(spreadAngle(state(RUN_SPEED), def)).toBeGreaterThan(spreadAngle(state(WALK_SPEED), def));
            expect(spreadAngle(state(0, false), def)).toBe(def.spreadAir);
            expect(def.spreadAir).toBeGreaterThan(spreadAngle(state(RUN_SPEED), def));
        }
        expect(spreadAngle(state(RUN_SPEED), PISTOL)).toBeLessThan(spreadAngle(state(RUN_SPEED), RIFLE));
    });

    it('is a pure function of the shot count and the shooter, inside the cone', () => {
        const a: [number, number] = [0, 0], b: [number, number] = [0, 0];
        const seen = new Set<string>();
        for (let seed = 0; seed < 256; seed++) {
            spreadOffset(seed, 3, 0.01, a);
            spreadOffset(seed, 3, 0.01, b);
            expect(b).toEqual(a);
            expect(Math.hypot(a[0], a[1])).toBeLessThanOrEqual(0.01 + 1e-12);
            seen.add(a.join());
        }
        expect(seen.size).toBeGreaterThan(250);
        spreadOffset(42, 3, 0.01, a);
        spreadOffset(42, 4, 0.01, b);
        expect(b).not.toEqual(a);
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
        for (const count of [inner, right, up]) expect(Math.abs(count / n - 0.5)).toBeLessThan(0.05);
    });

    it('builds the shot direction from view, recoil and spread', () => {
        const dir: Vec3 = [0, 0, 0], plain: Vec3 = [0, 0, 0];
        shotDirection(0.3, -0.1, RIFLE, 0, 1, 0, 7, 1, dir);
        expect(dir).toEqual(viewDir(0.3, -0.1, plain));
        shotDirection(0.3, -0.1, RIFLE, 9, 1, 0, 7, 1, dir);
        expect(dir).toEqual(viewDir(0.3 + recoilYaw(RIFLE, 9), -0.1 + recoilPitch(RIFLE, 9), plain));
        const off: [number, number] = [0, 0];
        spreadOffset(7, 1, 0.02, off);
        shotDirection(0.3, -0.1, PISTOL, 4, 0.5, 0.02, 7, 1, dir);
        expect(dir).toEqual(viewDir(0.3 + recoilYaw(PISTOL, 4) * 0.5 + off[1], -0.1 + recoilPitch(PISTOL, 4) * 0.5 + off[0], plain));
    });
});

describe('spread seed', () => {
    it('counts each weapon\'s shots, wrapping at 256, offset by slot, and resets on spawn', () => {
        const l = createLoadout();
        const seeds: number[] = [];
        for (let i = 0; i < 300; i++) {
            l.guns[0].mag = RIFLE.magSize; // endless ammunition for the test
            l.guns[0].cooldown = 0;
            if (stepLoadout(l, input({ fire: true }), true) >= 0) seeds.push(spreadSeed(l));
        }
        expect(seeds).toHaveLength(300);
        expect(seeds.slice(0, 3)).toEqual([1, 2, 3]);
        expect(seeds[254]).toBe(255);
        expect(seeds[255]).toBe(0);
        const before = l.guns[0].shots;
        runL(l, 200);
        expect(l.guns[0].shots).toBe(before);
        // The pistol counts its own, in another range of seeds.
        runL(l, PISTOL.drawTicks, i => (i === 0 ? { slot: 2 } : {}));
        expect(stepLoadout(l, input({ fire: true }), true)).toBe(0);
        expect(spreadSeed(l)).toBe(256 + 1);
        resetLoadout(l, SIGHT_IRON);
        expect(l.guns.every(g => g.shots === 0)).toBe(true);
    });
});
