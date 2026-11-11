import { describe, expect, it } from 'vitest';
import { CROUCH_SPEED, RUN_SPEED, TICK_DT, WALK_SPEED } from './constants';
import { createPlayerState, horizontalSpeed, stepPlayer } from './movement';
import type { Box, InputCmd, PlayerState } from './types';

const floor: Box = { min: [-50, -0.5, -50], max: [50, 0, 50] };
const idle: InputCmd = { forward: 0, right: 0, yaw: 0, jump: false, walk: false, crouch: false };
const fwd: InputCmd = { ...idle, forward: 1 }; // yaw 0 => -Z

function run(s: PlayerState, input: InputCmd, seconds: number, boxes: Box[]): void {
    for (let i = 0; i < Math.round(seconds / TICK_DT); i++) stepPlayer(s, input, TICK_DT, boxes);
}

function grounded(boxes: Box[], x = 0, z = 0): PlayerState {
    const s = createPlayerState([x, 0.5, z]);
    run(s, idle, 1, boxes);
    return s;
}

describe('stepPlayer', () => {
    it('falls and lands on the floor', () => {
        const s = createPlayerState([0, 3, 0]);
        run(s, idle, 2, [floor]);
        expect(s.onGround).toBe(true);
        expect(s.pos[1]).toBeCloseTo(0, 5);
        expect(s.vel[1]).toBe(0);
    });

    it('reaches run, walk and crouch speeds and moves along -Z at yaw 0', () => {
        const s = grounded([floor]);
        run(s, fwd, 2, [floor]);
        expect(horizontalSpeed(s)).toBeCloseTo(RUN_SPEED, 2);
        expect(s.pos[2]).toBeLessThan(-5);
        expect(Math.abs(s.pos[0])).toBeLessThan(1e-6);

        run(s, { ...fwd, walk: true }, 2, [floor]);
        expect(horizontalSpeed(s)).toBeCloseTo(WALK_SPEED, 2);
        run(s, { ...fwd, crouch: true }, 2, [floor]);
        expect(horizontalSpeed(s)).toBeCloseTo(CROUCH_SPEED, 2);
    });

    it('strafes right along +X at yaw 0 and forward along -X at yaw 90 degrees', () => {
        const a = grounded([floor]);
        run(a, { ...idle, right: 1 }, 1, [floor]);
        expect(a.pos[0]).toBeGreaterThan(2);
        const b = grounded([floor]);
        run(b, { ...fwd, yaw: Math.PI / 2 }, 1, [floor]);
        expect(b.pos[0]).toBeLessThan(-2);
    });

    it('stops quickly when input is released', () => {
        const s = grounded([floor]);
        run(s, fwd, 1, [floor]);
        run(s, idle, 0.5, [floor]);
        expect(horizontalSpeed(s)).toBe(0);
    });

    it('is stopped by a wall and reports zero speed into it', () => {
        const wall: Box = { min: [-5, 0, -4], max: [5, 4, -3] };
        const s = grounded([floor, wall]);
        run(s, fwd, 3, [floor, wall]);
        expect(s.pos[2]).toBeCloseTo(-3 + 0.3, 4);
        expect(horizontalSpeed(s)).toBe(0);
    });

    it('slides along a wall when moving diagonally into it', () => {
        const wall: Box = { min: [-50, 0, -2], max: [50, 4, -1] };
        const s = grounded([floor, wall]);
        run(s, { ...fwd, right: 1 }, 2, [floor, wall]);
        expect(s.pos[2]).toBeCloseTo(-1 + 0.3, 4);
        expect(s.pos[0]).toBeGreaterThan(3);
    });

    it('walks up and back down a staircase without leaving the ground', () => {
        const steps: Box[] = [0, 1, 2, 3].map(i => ({
            min: [-1, 0, -2 - 0.5 * (i + 1)], max: [1, 0.3 * (i + 1), -2 - 0.5 * i]
        }));
        const top: Box = { min: [-1, 0, -10], max: [1, 1.2, -4] };
        const world = [floor, ...steps, top];
        const s = grounded(world);
        run(s, fwd, 2, world);
        expect(s.pos[1]).toBeCloseTo(1.2, 4);
        expect(s.onGround).toBe(true);

        let airborneTicks = 0;
        for (let i = 0; i < 120; i++) {
            stepPlayer(s, { ...fwd, yaw: Math.PI }, TICK_DT, world);
            if (!s.onGround) airborneTicks++;
        }
        expect(s.pos[1]).toBeCloseTo(0, 4);
        expect(airborneTicks).toBe(0);
    });

    it('cannot walk onto a 1 m crate but can jump onto it', () => {
        const crate: Box = { min: [-1, 0, -4], max: [1, 1, -2] };
        const world = [floor, crate];
        const s = grounded(world);
        run(s, fwd, 2, world);
        expect(s.pos[1]).toBeCloseTo(0, 5);
        expect(s.pos[2]).toBeCloseTo(-2 + 0.3, 4);

        stepPlayer(s, { ...fwd, jump: true }, TICK_DT, world);
        run(s, fwd, 0.8, world); // long enough to land, short enough not to walk off the far side
        expect(s.pos[1]).toBeCloseTo(1, 4);
        expect(s.onGround).toBe(true);
    });

    it('falls when walking off a ledge taller than a step', () => {
        const ledge: Box = { min: [-1, 0, -1], max: [1, 1.5, 1] };
        const world = [floor, ledge];
        const s = createPlayerState([0, 1.6, 0]);
        run(s, idle, 0.5, world);
        expect(s.pos[1]).toBeCloseTo(1.5, 5);
        run(s, fwd, 2, world);
        expect(s.pos[1]).toBeCloseTo(0, 5);
        expect(s.onGround).toBe(true);
    });

    it('stays crouched under a low ceiling', () => {
        const ceiling: Box = { min: [-2, 1.4, -6], max: [2, 3, -2] };
        const world = [floor, ceiling];
        const s = grounded(world);
        run(s, { ...fwd, crouch: true }, 1.5, world);
        expect(s.pos[2]).toBeLessThan(-2.5);
        run(s, idle, 0.5, world);
        expect(s.crouched).toBe(true);
    });

    it('is deterministic', () => {
        const crate: Box = { min: [1, 0, -4], max: [3, 1, -2] };
        const world = [floor, crate];
        const sim = () => {
            const s = createPlayerState([0, 1, 0]);
            for (let i = 0; i < 600; i++) {
                stepPlayer(s, {
                    forward: Math.sin(i * 0.05) > 0 ? 1 : -0.5, right: Math.cos(i * 0.03),
                    yaw: i * 0.01, jump: i % 90 === 0, walk: i % 200 > 150, crouch: i % 300 > 260
                }, TICK_DT, world);
            }
            return JSON.stringify(s);
        };
        expect(sim()).toBe(sim());
    });
});
