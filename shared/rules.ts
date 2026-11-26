import type { Team } from './protocol';
import type { MapData, PlayerState, Vec3 } from './types';

/**
 * warmup: not enough players; free roam with respawns.
 * freeze: round about to start; everyone is placed and cannot move.
 * live: ghosts try to plant, defenders try to stop them.
 * planted: the bomb is ticking; defenders must defuse it.
 * over: the round has a winner; short pause before the next one.
 */
export type Phase = 'warmup' | 'freeze' | 'live' | 'planted' | 'over';

export type RoundReason = 'eliminated' | 'time' | 'exploded' | 'defused';

export const FREEZE_MS = 4000;
export const ROUND_MS = 120_000;
export const BOMB_MS = 35_000;
export const OVER_MS = 5000;
/** The result screen is held this long after the deciding round, then a fresh match begins. */
export const MATCH_OVER_MS = 20_000;
/** Complete rounds in a row (freeze to round end) without one input change before a player sits out. */
export const IDLE_ROUNDS = 2;
/** A match that lost a whole team is held this long, waiting for players to return, before the room resets. */
export const GRACE_MS = 60_000;
/** Hold times, counted in the player's own commands (60 per second). */
export const PLANT_TICKS = 180;
export const DEFUSE_TICKS = 300;
/** Horizontal reach for defusing. */
export const DEFUSE_RANGE = 1.6;
export const ROUNDS_TO_WIN = 6;
/** Teams trade sides once this many rounds have been played. */
export const HALFTIME_ROUND = 5;

export function insideSite(pos: Vec3, map: MapData): boolean {
    for (const s of map.bombSites) {
        if (pos[0] >= s.min[0] && pos[0] <= s.max[0] && pos[2] >= s.min[2] && pos[2] <= s.max[2] &&
            pos[1] >= s.min[1] - 0.1 && pos[1] <= s.max[1]) return true;
    }
    return false;
}

/**
 * Whether holding the use key does something for this player right now: plant (only the ghost carrying
 * the bomb, `carrier`, in a site during a live round) or defuse. `carrier` is ignored for defenders.
 */
export function canAct(team: Team, phase: Phase, state: PlayerState, map: MapData, bomb: Vec3 | null, carrier: boolean): boolean {
    if (!state.onGround) return false;
    if (team === 'ghosts') return carrier && phase === 'live' && insideSite(state.pos, map);
    return phase === 'planted' && bomb !== null &&
        Math.hypot(state.pos[0] - bomb[0], state.pos[2] - bomb[2]) <= DEFUSE_RANGE &&
        Math.abs(state.pos[1] - bomb[1]) < 1.5;
}

/**
 * Whether a player is rooted this tick: during the freeze, and while planting or defusing.
 * Client and server both apply this before simulating, so prediction matches.
 */
export function movementLocked(
    use: boolean, team: Team, phase: Phase, state: PlayerState, map: MapData, bomb: Vec3 | null, carrier: boolean
): boolean {
    return phase === 'freeze' || (use && canAct(team, phase, state, map, bomb, carrier));
}

/** Attacks and new reloads are locked during freeze, round results and objective interactions. */
export function weaponsArmed(phase: Phase, acting: boolean): boolean {
    return !acting && phase !== 'freeze' && phase !== 'over';
}

/** Mask the delayed client's trigger and reload intent before prediction and transmission. */
export function gateWeaponInput(input: { fire: boolean; reload: boolean }, phase: Phase, acting: boolean): boolean {
    const armed = weaponsArmed(phase, acting);
    if (!armed) {
        input.fire = false;
        input.reload = false;
    }
    return armed;
}
