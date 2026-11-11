import { GHOST_MAX_VIS, RUN_SPEED, VIS_FALL_TIME, VIS_RISE_TIME, VIS_STILL_SPEED } from './constants';

/** The visibility a ghost settles at for a given ground speed: 0 when still, GHOST_MAX_VIS at a run. */
export function ghostVisTarget(speed: number): number {
    const t = Math.min(1, Math.max(0, (speed - VIS_STILL_SPEED) / (RUN_SPEED - VIS_STILL_SPEED)));
    return GHOST_MAX_VIS * t * t * (3 - 2 * t);
}

/** Moves visibility toward its target: quickly when becoming visible, slowly when fading out. */
export function stepVis(vis: number, target: number, dt: number): number {
    const next = vis + (target - vis) * (1 - Math.exp(-dt / (target > vis ? VIS_RISE_TIME : VIS_FALL_TIME)));
    return target === 0 && next < 0.005 ? 0 : next;
}
