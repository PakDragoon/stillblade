import { KNIFE_COOLDOWN_TICKS, KNIFE_WINDUP_TICKS } from './constants';

/**
 * The ghosts' knife timing. Both fields count commands the server actually processed for this
 * player, never the client-chosen command number, so skipping ahead in `seq` gains nothing. They
 * travel exactly in the snapshot and the client predicts and replays them like the gun.
 */
export interface KnifeState {
    /** Commands left until a new swing may start. */
    cooldown: number;
    /** Commands left until the swing in progress lands; 0 when not swinging. */
    windup: number;
}

/** What `stepKnife` did this command. */
export const KNIFE_IDLE = 0;
/** A swing started (the windup: sound and visibility spike). */
export const KNIFE_SWING = 1;
/** The swing in progress landed: resolve the hit. */
export const KNIFE_SLASH = 2;

export function createKnifeState(): KnifeState {
    return { cooldown: 0, windup: 0 };
}

/** Nothing in progress: every spawn, and death. */
export function resetKnife(k: KnifeState): void {
    k.cooldown = 0;
    k.windup = 0;
}

export function copyKnifeState(dst: KnifeState, src: KnifeState): void {
    dst.cooldown = src.cooldown;
    dst.windup = src.windup;
}

export function sameKnifeState(a: KnifeState, b: KnifeState): boolean {
    return a.cooldown === b.cooldown && a.windup === b.windup;
}

/**
 * Advances the knife by one of its owner's commands. Run for every command a living ghost
 * simulates, by the server and by the client's prediction and replay alike. `armed` is false
 * during the round freeze and while planting; timers still run then, and a swing that is due
 * lands on the first armed command.
 */
export function stepKnife(k: KnifeState, fire: boolean, armed: boolean): number {
    if (k.cooldown > 0) k.cooldown--;
    if (k.windup > 0) {
        if (k.windup > 1) k.windup--;
        else if (armed) {
            k.windup = 0;
            return KNIFE_SLASH;
        }
        return KNIFE_IDLE;
    }
    if (!fire || !armed || k.cooldown > 0) return KNIFE_IDLE;
    // A swing is committed at the windup: it gives the ghost away before it can land.
    k.cooldown = KNIFE_COOLDOWN_TICKS;
    k.windup = KNIFE_WINDUP_TICKS;
    return KNIFE_SWING;
}
