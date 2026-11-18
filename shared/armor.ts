import { ARMOR_ABSORB } from './constants';
import type { DamageKind } from './protocol';
import type { HitZone } from './zones';

/**
 * Armor (package P, rule approved by the owner 2026-11-18). Every player spawns with MAX_ARMOR and
 * MAX_HEALTH. A shot to the torso, arms or legs, or a knife hit from the front, puts
 * `floor(amount * ARMOR_ABSORB)` on the armor, as much of it as the armor has left; health takes the
 * rest. Headshots and knife back-stabs ignore armor: health takes the full amount and armor is unchanged.
 * A player dies when health reaches 0, whatever armor is left. This file is the only place the rule lives.
 */

/** A player's health and armor, changed in place by `applyDamage`. */
export interface Vitals {
    health: number;
    armor: number;
}

/** What one hit removed: `health` (capped at the health there was) and `armor`. */
export interface DamageSplit {
    health: number;
    armor: number;
}

/** True for the hits armor does not stop: a headshot, or a knife from behind. */
export function ignoresArmor(kind: DamageKind, zone?: HitZone): boolean {
    return kind === 'backstab' || zone === 'head';
}

/**
 * Applies a hit of `amount` (a whole number) to `v` and writes what it removed into `out` (returned).
 * Health never goes below 0; armor never below 0.
 */
export function applyDamage(v: Vitals, amount: number, kind: DamageKind, zone: HitZone | undefined, out: DamageSplit): DamageSplit {
    const absorbed = ignoresArmor(kind, zone) ? 0 : Math.min(v.armor, Math.floor(amount * ARMOR_ABSORB));
    const toHealth = amount - absorbed;
    out.armor = absorbed;
    out.health = Math.min(toHealth, v.health);
    v.armor -= absorbed;
    v.health = Math.max(0, v.health - toHealth);
    return out;
}
