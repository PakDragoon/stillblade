import {
    DRY_FIRE_TICKS, FIRE_INTERVAL_TICKS, MAG_SIZE, RECOIL_DECAY_TICKS, RECOIL_RECOVER_TICKS, RELOAD_TICKS,
    RESERVE_AMMO, RUN_SPEED, SPREAD_AIR, SPREAD_CROUCHED, SPREAD_MOVING, SPREAD_STILL
} from './constants';
import { horizontalSpeed } from './movement';
import { viewDir } from './raycast';
import type { PlayerState, Vec3 } from './types';

/**
 * The defenders' gun. Every field is a small integer counted in the shooter's own commands, so it
 * travels exactly in the snapshot and the client can predict it and replay it like movement.
 */
export interface GunState {
    /** Rounds in the magazine. */
    mag: number;
    /** Spare rounds. */
    reserve: number;
    /** Commands left until the reload in progress completes; 0 when not reloading. */
    reload: number;
    /** Commands left until the trigger may act again (fire interval, dry-fire click). */
    cooldown: number;
    /** Index into the recoil pattern of the next shot; recovers toward 0 when not firing. */
    burst: number;
    /** Commands since the last shot, capped at 255. */
    sinceShot: number;
    /**
     * Shots fired since the spawn, wrapping at 256. Seeds the spread of the next shot: the server
     * counts it, so a client cannot choose its spread by choosing its command numbers.
     */
    shots: number;
}

/** What `stepGun` did this command. A shot returns its recoil pattern index instead (0 or more). */
export const GUN_IDLE = -1;
export const GUN_RELOAD = -2;
export const GUN_DRY = -3;

const SINCE_SHOT_CAP = 255;

export function createGunState(): GunState {
    return { mag: MAG_SIZE, reserve: RESERVE_AMMO, reload: 0, cooldown: 0, burst: 0, sinceShot: SINCE_SHOT_CAP, shots: 0 };
}

/** Full magazine and reserve, nothing in progress: every spawn (so every round start). */
export function resetGun(g: GunState): void {
    g.mag = MAG_SIZE;
    g.reserve = RESERVE_AMMO;
    g.reload = 0;
    g.cooldown = 0;
    g.burst = 0;
    g.sinceShot = SINCE_SHOT_CAP;
    g.shots = 0;
}

export function copyGunState(dst: GunState, src: GunState): void {
    dst.mag = src.mag;
    dst.reserve = src.reserve;
    dst.reload = src.reload;
    dst.cooldown = src.cooldown;
    dst.burst = src.burst;
    dst.sinceShot = src.sinceShot;
    dst.shots = src.shots;
}

export function sameGunState(a: GunState, b: GunState): boolean {
    return a.mag === b.mag && a.reserve === b.reserve && a.reload === b.reload &&
        a.cooldown === b.cooldown && a.burst === b.burst && a.sinceShot === b.sinceShot && a.shots === b.shots;
}

function canReload(g: GunState): boolean {
    return g.reload === 0 && g.mag < MAG_SIZE && g.reserve > 0;
}

/**
 * Advances the gun by one of its owner's commands. Run for every command a living defender
 * simulates, by the server and by the client's prediction and replay alike.
 * `armed` is false while the trigger cannot act (round freeze, hands busy planting or defusing);
 * timers still run then. Returns the recoil pattern index of a shot fired this command, or one
 * of GUN_IDLE, GUN_RELOAD (a reload started) and GUN_DRY (an empty click). After a shot,
 * `spreadSeed(g)` is the seed for that shot's spread.
 */
export function stepGun(g: GunState, fire: boolean, reload: boolean, armed: boolean): number {
    if (g.sinceShot < SINCE_SHOT_CAP) {
        g.sinceShot++;
        // Recoil recovers one pattern step at a time once the shooter pauses. The whole pattern is
        // undone long before the counter reaches its cap.
        if (g.burst > 0 && g.sinceShot >= RECOIL_RECOVER_TICKS &&
            (g.sinceShot - RECOIL_RECOVER_TICKS) % RECOIL_DECAY_TICKS === 0) g.burst--;
    }
    if (g.cooldown > 0) g.cooldown--;

    if (g.reload > 0) {
        // Firing is impossible until the reload completes; it may fire on the completing command.
        if (--g.reload > 0) return GUN_IDLE;
        const take = Math.min(MAG_SIZE - g.mag, g.reserve);
        g.mag += take;
        g.reserve -= take;
    } else if (reload && armed && canReload(g)) {
        g.reload = RELOAD_TICKS;
        return GUN_RELOAD;
    }

    if (!fire || !armed || g.cooldown > 0) return GUN_IDLE;
    if (g.mag > 0) {
        g.mag--;
        g.cooldown = FIRE_INTERVAL_TICKS;
        const index = g.burst;
        if (g.burst < RECOIL_SHOTS - 1) g.burst++;
        g.sinceShot = 0;
        g.shots = (g.shots + 1) & 0xff;
        return index;
    }
    if (canReload(g)) {
        g.reload = RELOAD_TICKS; // empty magazine: pulling the trigger reloads
        return GUN_RELOAD;
    }
    g.cooldown = DRY_FIRE_TICKS;
    return GUN_DRY;
}

const DEG = Math.PI / 180;

/**
 * Where each shot of a burst lands relative to the view, in degrees [pitch up, yaw left]. Shot n
 * of an uninterrupted burst uses row n. It climbs for the first shots, then wanders right, left
 * and right again: a fixed pattern a player can learn to pull against.
 */
const PATTERN_DEG: readonly (readonly [number, number])[] = [
    [0.00, 0.00], [0.30, 0.04], [0.70, -0.04], [1.15, 0.08], [1.65, -0.06],
    [2.15, 0.10], [2.60, 0.02], [3.00, -0.10], [3.35, -0.25], [3.60, -0.45],
    [3.80, -0.70], [3.95, -0.95], [4.05, -1.20], [4.15, -1.40], [4.20, -1.50],
    [4.25, -1.35], [4.30, -1.00], [4.35, -0.55], [4.40, -0.05], [4.45, 0.45],
    [4.50, 0.90], [4.55, 1.20], [4.55, 1.35], [4.60, 1.25], [4.60, 0.95],
    [4.65, 0.55], [4.65, 0.15], [4.70, -0.20], [4.70, -0.45], [4.75, -0.60]
];
/** The pattern in radians, as flat [pitch, yaw] pairs. */
const PATTERN = new Float64Array(PATTERN_DEG.length * 2);
for (let i = 0; i < PATTERN_DEG.length; i++) {
    PATTERN[i * 2] = PATTERN_DEG[i][0] * DEG;
    PATTERN[i * 2 + 1] = PATTERN_DEG[i][1] * DEG;
}
/** Rows in the recoil pattern; a burst longer than this repeats the last row. */
export const RECOIL_SHOTS = PATTERN_DEG.length;

const patternRow = (index: number): number => Math.max(0, Math.min(PATTERN_DEG.length - 1, index | 0)) * 2;

/** Recoil pattern offset in radians for a shot index (see `stepGun`). */
export function recoilPitch(index: number): number {
    return PATTERN[patternRow(index)];
}
export function recoilYaw(index: number): number {
    return PATTERN[patternRow(index) + 1];
}

/** Spread cone half-angle (radians) for a shooter in this state. */
export function spreadAngle(s: PlayerState): number {
    if (!s.onGround) return SPREAD_AIR;
    const moving = Math.min(horizontalSpeed(s) / RUN_SPEED, 1) * SPREAD_MOVING;
    return (s.crouched ? SPREAD_CROUCHED : SPREAD_STILL) + moving;
}

/** 32-bit integer hash (lowbias32); integer-only so every JavaScript engine gives the same bits. */
function hash32(x: number): number {
    x = (x ^ (x >>> 16)) >>> 0;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
}

/** Spread seed of the shot `stepGun` just fired: the shooter's shot count, which the server keeps. */
export function spreadSeed(g: GunState): number {
    return g.shots;
}

/**
 * Deterministic spread offset for one shot, in radians, written as [pitch, yaw] into `out`.
 * Uniform over a disc of radius `spread`, seeded by `spreadSeed` and the shooter, never by
 * Math.random or the client-chosen command number: the client predicts exactly the offset the
 * server will use but cannot pick it.
 */
export function spreadOffset(seed: number, shooter: number, spread: number, out: [number, number]): [number, number] {
    const h = hash32((seed >>> 0) ^ Math.imul(shooter >>> 0, 0x9e3779b9));
    const u = (h & 0xffff) / 65536;
    const v = (h >>> 16) / 65535;
    const r = spread * Math.sqrt(v);
    const a = u * 2 * Math.PI;
    out[0] = r * Math.sin(a);
    out[1] = r * Math.cos(a);
    return out;
}

const PITCH_LIMIT = Math.PI / 2;
const scratch: [number, number] = [0, 0];

/**
 * The direction a shot actually travels: the view, plus the recoil pattern for this shot of the
 * burst, plus spread. The server traces this; the client draws its predicted tracer along it.
 */
export function shotDirection(
    yaw: number, pitch: number, index: number, spread: number, seed: number, shooter: number, out: Vec3
): Vec3 {
    spreadOffset(seed, shooter, spread, scratch);
    const p = pitch + recoilPitch(index) + scratch[0];
    return viewDir(yaw + recoilYaw(index) + scratch[1], p < -PITCH_LIMIT ? -PITCH_LIMIT : p > PITCH_LIMIT ? PITCH_LIMIT : p, out);
}
