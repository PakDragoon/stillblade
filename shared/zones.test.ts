import { describe, expect, it } from 'vitest';
import { HEAD_ZONE, HULL_HALF_WIDTH, HULL_HEIGHT, HULL_HEIGHT_CROUCHED } from './constants';
import type { Vec3 } from './types';
import { SLOT_PISTOL, SLOT_RIFLE, WEAPONS } from './weapons';
import { ARM_OFFSET, LEG_SHARE, ZONE_MULTIPLIER, hitZone, zoneDamage } from './zones';

const RIFLE = WEAPONS[SLOT_RIFLE];
const PISTOL = WEAPONS[SLOT_PISTOL];
// Centred on x = 0 so offsets such as exactly 0.2 m are exact in floating point.
const FEET: Vec3 = [0, 1, -3];
/** A shot along +Z (from the -Z side), hitting the front face at `x` across and `y` up from the feet. */
const front = (x: number, y: number): Vec3 => [FEET[0] + x, FEET[1] + y, FEET[2] - HULL_HALF_WIDTH];
const ALONG_Z: Vec3 = [0, 0, 1];

describe.each([
    ['standing', HULL_HEIGHT],
    ['crouched', HULL_HEIGHT_CROUCHED]
] as const)('hit zones, %s', (_name, h) => {
    const headFrom = h - HEAD_ZONE;
    const legsBelow = h * LEG_SHARE;

    it('puts the top 0.28 m in the head, from its lower edge exactly', () => {
        expect(hitZone(front(0, h), FEET, h, ALONG_Z)).toBe('head');
        expect(hitZone(front(0, headFrom), FEET, h, ALONG_Z)).toBe('head');
        expect(hitZone(front(0.29, headFrom + 0.01), FEET, h, ALONG_Z)).toBe('head'); // the head is the whole width
        expect(hitZone(front(0, headFrom - 1e-6), FEET, h, ALONG_Z)).toBe('torso');
    });

    it('puts the bottom 45% in the legs, up to but not including its top edge', () => {
        expect(hitZone(front(0, 0), FEET, h, ALONG_Z)).toBe('legs');
        expect(hitZone(front(0.29, legsBelow - 1e-6), FEET, h, ALONG_Z)).toBe('legs'); // legs are the whole width
        expect(hitZone(front(0, legsBelow), FEET, h, ALONG_Z)).toBe('torso');
    });

    it('puts the band between them in the arms beyond 0.2 m from the centre line, across the shot', () => {
        const mid = (legsBelow + headFrom) / 2;
        expect(hitZone(front(0, mid), FEET, h, ALONG_Z)).toBe('torso');
        expect(hitZone(front(ARM_OFFSET, mid), FEET, h, ALONG_Z)).toBe('torso'); // exactly 0.2 m is still torso
        expect(hitZone(front(ARM_OFFSET + 1e-6, mid), FEET, h, ALONG_Z)).toBe('arms');
        expect(hitZone(front(-0.25, mid), FEET, h, ALONG_Z)).toBe('arms'); // either side
        expect(hitZone(front(-0.15, mid), FEET, h, ALONG_Z)).toBe('torso');
    });

    it('measures the arm offset across the shot, not from the hit point on the box', () => {
        const mid = (legsBelow + headFrom) / 2;
        // A shot from the side (along +X) striking the side face dead centre: 0.3 m from the centre line as
        // a point, but through the middle of the body as the shooter saw it.
        expect(hitZone([FEET[0] - HULL_HALF_WIDTH, FEET[1] + mid, FEET[2]], FEET, h, [1, 0, 0])).toBe('torso');
        // The same point by a shot along +Z grazes the edge: an arm.
        expect(hitZone([FEET[0] - HULL_HALF_WIDTH, FEET[1] + mid, FEET[2]], FEET, h, ALONG_Z)).toBe('arms');
        // Diagonal, through the corner region: offset along the shot's perpendicular.
        const d = Math.SQRT1_2;
        expect(hitZone([FEET[0] - 0.3, FEET[1] + mid, FEET[2] - 0.3], FEET, h, [d, 0, d])).toBe('torso');
        expect(hitZone([FEET[0] - 0.3, FEET[1] + mid, FEET[2] + 0.05], FEET, h, [d, 0, d])).toBe('arms');
        // A shot straight down passes through the centre line.
        expect(hitZone([FEET[0] + 0.25, FEET[1] + mid, FEET[2]], FEET, h, [0, -1, 0])).toBe('torso');
        // Height decides before the arm test: a sloped shot still uses only its horizontal direction.
        expect(hitZone(front(0.25, mid), FEET, h, [0, -0.6, 0.8])).toBe('arms');
    });
});

describe('zone damage', () => {
    it('scales the body damage: 2x head, 1x torso, 0.5x arms and legs, rounded; no one-shot headshot', () => {
        expect(ZONE_MULTIPLIER).toEqual({ head: 2, torso: 1, arms: 0.5, legs: 0.5 });
        expect(zoneDamage(RIFLE, 'head')).toBe(68);
        expect(zoneDamage(RIFLE, 'torso')).toBe(34);
        expect(zoneDamage(RIFLE, 'arms')).toBe(17);
        expect(zoneDamage(RIFLE, 'legs')).toBe(17);
        expect(zoneDamage(PISTOL, 'head')).toBe(52);
        expect(zoneDamage(PISTOL, 'torso')).toBe(26);
        expect(zoneDamage(PISTOL, 'arms')).toBe(13);
        expect(zoneDamage(PISTOL, 'legs')).toBe(13);
        for (const w of WEAPONS) expect(zoneDamage(w, 'head')).toBeLessThan(100);
        for (const w of WEAPONS) for (const z of ['head', 'torso', 'arms', 'legs'] as const) expect(Number.isInteger(zoneDamage(w, z))).toBe(true);
    });
});
