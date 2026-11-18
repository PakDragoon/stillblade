import { describe, expect, it } from 'vitest';
import { applyDamage, ignoresArmor, type DamageSplit, type Vitals } from './armor';
import { ARMOR_ABSORB, KNIFE_BACKSTAB_DAMAGE, KNIFE_DAMAGE, MAX_ARMOR, MAX_HEALTH } from './constants';
import type { DamageKind } from './protocol';
import { DEFENDER_KNIFE, SLOT_PISTOL, SLOT_RIFLE, WEAPONS } from './weapons';
import { zoneDamage, type HitZone } from './zones';

const fresh = (): Vitals => ({ health: MAX_HEALTH, armor: MAX_ARMOR });
const out = (): DamageSplit => ({ health: -1, armor: -1 });

/** Hits of one kind until health reaches 0, from a fresh spawn. */
function hitsToKill(amount: number, kind: DamageKind, zone?: HitZone): number {
    const v = fresh(), o = out();
    let n = 0;
    while (v.health > 0) { applyDamage(v, amount, kind, zone, o); n++; }
    return n;
}

describe('armor rule', () => {
    it('is one named constant of one half', () => {
        expect(ARMOR_ABSORB).toBe(0.5);
        expect(MAX_ARMOR).toBe(100);
    });

    it.each([
        ['torso', 34, 17, 17], ['arms', 17, 8, 9], ['legs', 17, 8, 9]
    ] as const)('a rifle %s shot puts half (rounded down) on armor', (zone, amount, armor, health) => {
        expect(zoneDamage(WEAPONS[SLOT_RIFLE], zone)).toBe(amount);
        const v = fresh(), o = applyDamage(fresh(), amount, 'shot', zone, out());
        applyDamage(v, amount, 'shot', zone, out());
        expect(o).toEqual({ armor, health });
        expect(v).toEqual({ health: MAX_HEALTH - health, armor: MAX_ARMOR - armor });
    });

    it.each([
        ['torso', 26, 13, 13], ['arms', 13, 6, 7], ['legs', 13, 6, 7]
    ] as const)('a pistol %s shot rounds odd halves toward health', (zone, amount, armor, health) => {
        expect(zoneDamage(WEAPONS[SLOT_PISTOL], zone)).toBe(amount);
        expect(applyDamage(fresh(), amount, 'shot', zone, out())).toEqual({ armor, health });
    });

    it('headshots ignore armor for both guns', () => {
        for (const slot of [SLOT_RIFLE, SLOT_PISTOL]) {
            const amount = zoneDamage(WEAPONS[slot], 'head');
            const v = fresh();
            expect(applyDamage(v, amount, 'shot', 'head', out())).toEqual({ armor: 0, health: amount });
            expect(v).toEqual({ health: MAX_HEALTH - amount, armor: MAX_ARMOR });
        }
    });

    it('a knife from the front goes half to armor, from behind straight to health (both knives)', () => {
        expect(applyDamage(fresh(), KNIFE_DAMAGE, 'knife', undefined, out())).toEqual({ armor: 27, health: 28 });
        expect(applyDamage(fresh(), DEFENDER_KNIFE.damage, 'knife', undefined, out())).toEqual({ armor: 17, health: 18 });
        const v = fresh();
        expect(applyDamage(v, KNIFE_BACKSTAB_DAMAGE, 'backstab', undefined, out())).toEqual({ armor: 0, health: 100 });
        expect(v).toEqual({ health: 0, armor: MAX_ARMOR });
        expect(applyDamage(fresh(), DEFENDER_KNIFE.backstabDamage, 'backstab', undefined, out())).toEqual({ armor: 0, health: 70 });
        expect(ignoresArmor('backstab')).toBe(true);
        expect(ignoresArmor('knife')).toBe(false);
        expect(ignoresArmor('shot', 'head')).toBe(true);
        expect(ignoresArmor('shot', 'torso')).toBe(false);
    });

    it('armor running out mid-hit takes only what is left; health takes the rest', () => {
        const v: Vitals = { health: 80, armor: 5 };
        expect(applyDamage(v, 34, 'shot', 'torso', out())).toEqual({ armor: 5, health: 29 });
        expect(v).toEqual({ health: 51, armor: 0 });
        // With no armor left the whole hit goes to health.
        expect(applyDamage(v, 34, 'shot', 'torso', out())).toEqual({ armor: 0, health: 34 });
        expect(v).toEqual({ health: 17, armor: 0 });
    });

    it('caps the health removed at the health there was, and kills at 0 whatever armor is left', () => {
        const v: Vitals = { health: 10, armor: 90 };
        const o = applyDamage(v, 34, 'shot', 'torso', out());
        expect(o).toEqual({ armor: 17, health: 10 });
        expect(v).toEqual({ health: 0, armor: 73 });
    });

    it('a hit of 1 puts nothing on armor (floor of a half)', () => {
        expect(applyDamage(fresh(), 1, 'shot', 'legs', out())).toEqual({ armor: 0, health: 1 });
    });

    it('hits to kill from a fresh spawn (the numbers in HANDOFF "Package P")', () => {
        expect(hitsToKill(68, 'shot', 'head')).toBe(2);
        expect(hitsToKill(34, 'shot', 'torso')).toBe(6);
        expect(hitsToKill(17, 'shot', 'legs')).toBe(12);
        expect(hitsToKill(52, 'shot', 'head')).toBe(2);
        expect(hitsToKill(26, 'shot', 'torso')).toBe(8);
        expect(hitsToKill(13, 'shot', 'legs')).toBe(15);
        expect(hitsToKill(DEFENDER_KNIFE.damage, 'knife')).toBe(6);
        expect(hitsToKill(DEFENDER_KNIFE.backstabDamage, 'backstab')).toBe(2);
        expect(hitsToKill(KNIFE_DAMAGE, 'knife')).toBe(4);
        expect(hitsToKill(KNIFE_BACKSTAB_DAMAGE, 'backstab')).toBe(1);
    });
});
