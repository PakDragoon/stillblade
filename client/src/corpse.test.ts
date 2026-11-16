import { describe, expect, it } from 'vitest';
import type { Box } from '@shared/types';
import { corpseYaw } from './corpse';

/** Backward unit direction for facing yaw y (yaw 0 faces -Z). */
const back = (y: number): [number, number] => [Math.sin(y), Math.cos(y)];
const wall = (min: [number, number, number], max: [number, number, number]): Box => ({ min, max }) as Box;

describe('corpseYaw', () => {
    it('keeps the facing in open floor and with no map', () => {
        expect(corpseYaw([], [0, 0, 0], 1.2)).toBe(1.2);
        const far = [wall([20, 0, 20], [21, 3, 21])];
        expect(corpseYaw(far, [0, 0, 0], 0.4)).toBeCloseTo(0.4);
    });

    it('turns away from a wall right behind the player', () => {
        // Facing -Z (yaw 0): backward is +Z; a wall 0.5 m behind.
        const boxes = [wall([-5, 0, 0.5], [5, 3, 1])];
        const y = corpseYaw(boxes, [0, 0, 0], 0);
        const [bx, bz] = back(y);
        // The head now points away from the wall (not toward +Z) and the fall is clear.
        expect(bz).toBeLessThan(0.3);
        expect(Math.hypot(bx, bz)).toBeCloseTo(1);
    });

    it('in a corridor 1.2 m wide, lies along it', () => {
        // Walls at x = -0.6 and x = +0.6, facing +X (yaw -pi/2: forward (1,0,0)).
        const boxes = [wall([-1.6, 0, -20], [-0.6, 3, 20]), wall([0.6, 0, -20], [1.6, 3, 20])];
        const y = corpseYaw(boxes, [0, 0, 0], -Math.PI / 2);
        const [bx, bz] = back(y);
        expect(Math.abs(bz)).toBeGreaterThan(0.9);
        expect(Math.abs(bx)).toBeLessThan(0.45);
    });

    it('with no clear direction, picks the one with the most room', () => {
        // A 2 m square room, player in the middle: nothing is fully clear (1.35 m head + arms).
        const boxes = [
            wall([-2, 0, -2], [-1, 3, 2]), wall([1, 0, -2], [2, 3, 2]),
            wall([-2, 0, -2], [2, 3, -1]), wall([-2, 0, 1], [2, 3, 2])
        ];
        const y = corpseYaw(boxes, [0, 0, 0], 0);
        expect(Number.isFinite(y)).toBe(true);
        // Diagonals have the most room in a square.
        const [bx, bz] = back(y);
        expect(Math.abs(Math.abs(bx) - Math.abs(bz))).toBeLessThan(0.1);
    });
});
