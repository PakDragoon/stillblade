import { describe, expect, it } from 'vitest';
import {
    CARRY_DROPPED, CARRY_NONE, CARRY_PICKED, DROP_REPICK_TICKS, createCarry, restingPoint, stepCarry, touchesBomb
} from './bomb';
import { createPlayerState } from './movement';
import { decodeServer, encodeServer } from './protocol';
import { createLoadout } from './gun';
import { createKnifeState } from './knife';
import type { Box, Vec3 } from './types';

const floor: Box = { min: [-10, -0.5, -10], max: [10, 0, 10] };
const crate: Box = { min: [1, 0, 1], max: [2, 1, 2] };

describe('where a dropped bomb comes to rest', () => {
    it('lies at the feet of a player standing on something', () => {
        const s = createPlayerState([3, 1, 4]);
        s.onGround = true;
        expect(restingPoint(s, [floor], [0, 0, 0], [0, 0, 0])).toEqual([3, 1, 4]);
    });

    it('falls to the first floor below a player in the air: a crate top, or the ground', () => {
        const s = createPlayerState([1.5, 2.7, 1.5]);
        s.onGround = false;
        const out = restingPoint(s, [floor, crate], [0, 0, 0], [0, 0, 0]);
        expect(out[0]).toBe(1.5);
        expect(out[1]).toBeCloseTo(1, 9);
        expect(out[2]).toBe(1.5);
        s.pos[0] = 5;
        expect(restingPoint(s, [floor, crate], [0, 0, 0], [0, 0, 0])[1]).toBeCloseTo(0, 9);
    });

    it('with no floor below at all, goes back to the last place the player stood', () => {
        const s = createPlayerState([50, 3, 50]);
        s.onGround = false;
        const last: Vec3 = [9, 0, 9];
        expect(restingPoint(s, [floor], last, [0, 0, 0])).toEqual([9, 0, 9]);
    });
});

describe('touching and carrying', () => {
    it('touches a bomb within reach of the hull, at the feet or a step below, not above the head', () => {
        const s = createPlayerState([0, 0, 0]);
        expect(touchesBomb(s, [0.45, 0, 0.45])).toBe(true);
        expect(touchesBomb(s, [0.55, 0, 0])).toBe(false);
        expect(touchesBomb(s, [0, -0.35, 0])).toBe(true);
        expect(touchesBomb(s, [0, -0.6, 0])).toBe(false);
        expect(touchesBomb(s, [0, 2.0, 0])).toBe(false);
    });

    it('drops on request (never while planting), then waits DROP_REPICK_TICKS commands before a pickup', () => {
        const s = createPlayerState([0, 0, 0]);
        const c = createCarry();
        c.carrier = true;
        expect(stepCarry(c, true, true, s, null)).toBe(CARRY_NONE); // planting: refused
        expect(c.carrier).toBe(true);
        expect(stepCarry(c, true, false, s, null)).toBe(CARRY_DROPPED);
        expect(c).toEqual({ carrier: false, wait: DROP_REPICK_TICKS });
        const at: Vec3 = [0, 0, 0];
        for (let i = 0; i < DROP_REPICK_TICKS; i++) expect(stepCarry(c, false, false, s, at)).toBe(CARRY_NONE);
        expect(stepCarry(c, false, false, s, at)).toBe(CARRY_PICKED);
        expect(c.carrier).toBe(true);
        // Not carrying and nothing dropped: nothing happens, whatever is pressed.
        const d = createCarry();
        expect(stepCarry(d, true, false, s, null)).toBe(CARRY_NONE);
    });
});

describe('the carry state on the wire', () => {
    it('carries the carrier flag and every wait value exactly', () => {
        for (const carrier of [false, true]) {
            for (const wait of [0, 1, 59, 60, 255]) {
                const back = decodeServer(encodeServer({
                    type: 'snap', time: 1, ack: 2, players: [],
                    me: {
                        team: 'ghosts', actionTicks: 65535, carry: { carrier, wait }, vis: 0, pos: [0, 0, 0], vel: [0, 0, 0],
                        onGround: true, crouched: false, health: 100, armor: 100, alive: true, respawnAt: 0, loadout: createLoadout(), knife: createKnifeState()
                    }
                }));
                if (back.type !== 'snap') throw new Error('wrong type');
                expect(back.me.carry).toEqual({ carrier, wait });
                expect(back.me).toMatchObject({ onGround: true, alive: true, team: 'ghosts', actionTicks: 65535 });
            }
        }
    });
});
