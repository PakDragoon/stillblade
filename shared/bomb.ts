import { HULL_HALF_WIDTH, HULL_HEIGHT, HULL_HEIGHT_CROUCHED } from './constants';
import { rayWorld } from './raycast';
import type { Box, PlayerState, Vec3 } from './types';

/**
 * The bomb carrier. One ghost carries the bomb from the round start; only the carrier can plant. The
 * carrier drops it on purpose (the drop bit of a command) or by dying or leaving; a dropped bomb lies on
 * the floor and any living ghost whose hull touches it picks it up, except the player who dropped it on
 * purpose, for DROP_REPICK_TICKS of their own processed commands.
 *
 * `stepCarry` is run by the server for every command a living ghost simulates and by the client for
 * every command it predicts and replays, so "I carry the bomb" is known exactly for each command (it
 * decides whether holding the use key roots the player, see `canAct` in shared/rules.ts). The carry state
 * travels exactly in the self snapshot.
 */

/** Commands after a deliberate drop (1 s) during which the dropper cannot pick the bomb back up. */
export const DROP_REPICK_TICKS = 60;
/** A bomb on the floor is picked up by a hull that comes this close to it, horizontally. */
export const BOMB_PICKUP_REACH = 0.2;
/** The bomb lies this far below the hull's feet and still counts as touching (a ledge a step down). */
const PICKUP_BELOW = 0.4;
/** Drop and pickup sounds: quiet, short range, like a crouched footstep (respects earshot). */
export const BOMB_SOUND_RANGE = 8;
export const BOMB_SOUND_LOUD = 0.35;
/** A defender sees a dropped bomb when the line from its eye to this point above the bomb is clear. */
export const BOMB_SIGHT_HEIGHT = 0.15;
/** How far below a drop in mid-air the floor is looked for. */
const FALL_SEARCH = 200;

/** What one ghost knows about carrying, stepped per processed command (all small integers and a flag). */
export interface CarryState {
    /** This ghost has the bomb. */
    carrier: boolean;
    /** Commands left before this ghost may pick the bomb up again after dropping it on purpose (0..255). */
    wait: number;
}

export const CARRY_NONE = 0;
/** The carrier dropped the bomb on purpose this command. */
export const CARRY_DROPPED = 1;
/** This ghost picked the bomb up this command. */
export const CARRY_PICKED = 2;

export function createCarry(): CarryState {
    return { carrier: false, wait: 0 };
}

export function resetCarry(c: CarryState): void {
    c.carrier = false;
    c.wait = 0;
}

export function copyCarry(out: CarryState, from: CarryState): void {
    out.carrier = from.carrier;
    out.wait = from.wait;
}

export function sameCarry(a: CarryState, b: CarryState): boolean {
    return a.carrier === b.carrier && a.wait === b.wait;
}

/** Whether a player's hull (with BOMB_PICKUP_REACH around it) touches a bomb lying at `bomb`. */
export function touchesBomb(state: PlayerState, bomb: Vec3): boolean {
    const r = HULL_HALF_WIDTH + BOMB_PICKUP_REACH;
    const p = state.pos;
    if (Math.abs(bomb[0] - p[0]) > r || Math.abs(bomb[2] - p[2]) > r) return false;
    const top = p[1] + (state.crouched ? HULL_HEIGHT_CROUCHED : HULL_HEIGHT);
    return bomb[1] >= p[1] - PICKUP_BELOW && bomb[1] <= top;
}

const DOWN: Vec3 = [0, -1, 0];
const origin: Vec3 = [0, 0, 0];

/**
 * Where a bomb dropped by this player comes to rest: at the feet when standing on something, otherwise on
 * the first floor straight below (the top of the nearest box under the feet). If nothing is below,
 * `fallback` (the player's last position on the ground). Writes into and returns `out`.
 */
export function restingPoint(state: PlayerState, boxes: readonly Box[], fallback: Vec3, out: Vec3): Vec3 {
    const p = state.pos;
    if (state.onGround) {
        out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
        return out;
    }
    // Start a hair above the feet so a floor the feet are touching is found, not skipped.
    origin[0] = p[0]; origin[1] = p[1] + 0.01; origin[2] = p[2];
    const t = rayWorld(boxes, origin, DOWN, FALL_SEARCH);
    if (t < FALL_SEARCH) {
        out[0] = p[0]; out[1] = origin[1] - t; out[2] = p[2];
    } else {
        out[0] = fallback[0]; out[1] = fallback[1]; out[2] = fallback[2];
    }
    return out;
}

/**
 * One processed command of a living ghost, after its movement. `drop`: the command asked to drop the
 * bomb; `acting`: this command plants (a drop is refused while planting); `dropped`: where a dropped bomb
 * lies, or null. Returns CARRY_DROPPED, CARRY_PICKED or CARRY_NONE; the caller moves the bomb.
 */
export function stepCarry(c: CarryState, drop: boolean, acting: boolean, state: PlayerState, dropped: Vec3 | null): number {
    const waiting = c.wait > 0;
    if (waiting) c.wait--;
    if (c.carrier) {
        if (!drop || acting) return CARRY_NONE;
        c.carrier = false;
        c.wait = DROP_REPICK_TICKS;
        return CARRY_DROPPED;
    }
    if (dropped === null || waiting || !touchesBomb(state, dropped)) return CARRY_NONE;
    c.carrier = true;
    return CARRY_PICKED;
}
