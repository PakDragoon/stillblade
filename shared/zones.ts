import { HEAD_ZONE } from './constants';
import type { Vec3 } from './types';
import type { WeaponDef } from './weapons';

/**
 * Body-part damage. A player stays one axis-aligned box for movement and for the ray test; where the
 * ray met the box decides the zone. Used by the server (`Game.fire`) and by anything that needs to
 * know what a hit would do (tests, later bots). Knife hits ignore zones.
 *
 * Starting numbers, untuned.
 */
export type HitZone = 'head' | 'torso' | 'arms' | 'legs';

/** The bottom share of the current hull height that counts as legs. */
export const LEG_SHARE = 0.45;
/**
 * In the band between legs and head, a hit further than this (m) from the hull's vertical centre
 * line, measured across the shot, counts as an arm. The hull is 0.3 m from centre to face.
 */
export const ARM_OFFSET = 0.2;

/** Multiplier on the weapon's `bodyDamage` per zone; the head uses the weapon's `headDamage` instead. */
export const ZONE_MULTIPLIER: Readonly<Record<Exclude<HitZone, 'head'>, number>> = {
    torso: 1.0,
    arms: 0.8,
    legs: 0.7
};

/**
 * The zone of a hit at `hit` on a hull standing at `feet` (the bottom centre of its box) that is
 * `height` tall (1.8 standing, 1.2 crouched), by a shot travelling along `dir`.
 *
 * - head: the top HEAD_ZONE (0.28 m), from exactly `height - HEAD_ZONE` up;
 * - legs: below `LEG_SHARE` of the height (exactly at it is no longer a leg);
 * - arms: in between, further than ARM_OFFSET from the centre line;
 * - torso: everything else.
 *
 * The arm test measures the distance across the shot, from the centre line to the shot's line, on the
 * ground plane. The hit point itself always lies on the box's surface, at least 0.3 m from the centre
 * line, so measuring from it would make every body hit an arm: what matters is how far off-centre the
 * shot passed, as the shooter saw the target. A shot straight down passes through the centre (torso).
 */
export function hitZone(hit: Vec3, feet: Vec3, height: number, dir: Vec3): HitZone {
    const y = hit[1] - feet[1];
    if (y >= height - HEAD_ZONE) return 'head';
    if (y < height * LEG_SHARE) return 'legs';
    const hx = dir[0], hz = dir[2];
    const len = Math.hypot(hx, hz);
    if (len < 1e-9) return 'torso';
    // Perpendicular distance on the ground plane from the centre line to the shot's line through `hit`.
    const across = Math.abs((feet[0] - hit[0]) * hz - (feet[2] - hit[2]) * hx) / len;
    return across > ARM_OFFSET ? 'arms' : 'torso';
}

/** Health a gun takes off with a hit in `zone`, rounded to a whole number. */
export function zoneDamage(def: WeaponDef, zone: HitZone): number {
    return zone === 'head' ? def.headDamage : Math.round(def.bodyDamage * ZONE_MULTIPLIER[zone]);
}
