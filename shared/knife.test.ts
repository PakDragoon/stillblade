import { describe, expect, it } from 'vitest';
import { KNIFE_COOLDOWN_TICKS, KNIFE_WINDUP_TICKS } from './constants';
import { KNIFE_IDLE, KNIFE_SLASH, KNIFE_SWING, createKnifeState, resetKnife, stepKnife, type KnifeState } from './knife';

function run(k: KnifeState, n: number, fire: boolean, armed = true): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(stepKnife(k, fire, armed));
    return out;
}

describe('knife timing', () => {
    it('swings, lands after the windup, and waits out the cooldown', () => {
        const k = createKnifeState();
        const r = run(k, KNIFE_COOLDOWN_TICKS * 2, true);
        expect(r.indexOf(KNIFE_SWING)).toBe(0);
        expect(r.indexOf(KNIFE_SLASH)).toBe(KNIFE_WINDUP_TICKS);
        expect(r.indexOf(KNIFE_SWING, 1)).toBe(KNIFE_COOLDOWN_TICKS); // the next swing
        expect(r.filter(x => x === KNIFE_SLASH)).toHaveLength(2);
    });

    it('keeps time while unarmed and lands a due swing on the first armed command', () => {
        const k = createKnifeState();
        expect(stepKnife(k, true, true)).toBe(KNIFE_SWING);
        // Hands busy past the moment it was due.
        expect(run(k, KNIFE_WINDUP_TICKS + 5, false, false).every(x => x === KNIFE_IDLE)).toBe(true);
        expect(stepKnife(k, false, true)).toBe(KNIFE_SLASH);
        // The cooldown ran meanwhile: it ends KNIFE_COOLDOWN_TICKS after the swing started.
        expect(k.cooldown).toBe(KNIFE_COOLDOWN_TICKS - (KNIFE_WINDUP_TICKS + 6));
    });

    it('does not swing unarmed, and resets', () => {
        const k = createKnifeState();
        expect(run(k, 10, true, false).every(x => x === KNIFE_IDLE)).toBe(true);
        stepKnife(k, true, true);
        resetKnife(k);
        expect(k).toEqual(createKnifeState());
    });
});
