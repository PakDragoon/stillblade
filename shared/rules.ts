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
/** Pause after the deciding round before a fresh match begins. */
export const MATCH_OVER_MS = 10_000;
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

/** Whether holding the use key does something for this player right now (plant or defuse). */
export function canAct(team: Team, phase: Phase, state: PlayerState, map: MapData, bomb: Vec3 | null): boolean {
    if (!state.onGround) return false;
    if (team === 'ghosts') return phase === 'live' && insideSite(state.pos, map);
    return phase === 'planted' && bomb !== null &&
        Math.hypot(state.pos[0] - bomb[0], state.pos[2] - bomb[2]) <= DEFUSE_RANGE &&
        Math.abs(state.pos[1] - bomb[1]) < 1.5;
}

/**
 * Whether a player is rooted this tick: during the freeze, and while planting or defusing.
 * Client and server both apply this before simulating, so prediction matches.
 */
export function movementLocked(
    use: boolean, team: Team, phase: Phase, state: PlayerState, map: MapData, bomb: Vec3 | null
): boolean {
    return phase === 'freeze' || (use && canAct(team, phase, state, map, bomb));
}
