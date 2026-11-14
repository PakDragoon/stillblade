import { DRY_FIRE_TICKS, RUN_SPEED } from './constants';
import { horizontalSpeed } from './movement';
import { viewDir } from './raycast';
import type { PlayerState, Vec3 } from './types';
import { WEAPONS, WEAPON_COUNT, type WeaponDef } from './weapons';

/**
 * One defender weapon's state. Every field is a small integer counted in the shooter's own
 * commands, so it travels exactly in the snapshot and the client can predict it and replay it like
 * movement. Its numbers (magazine size, timings, pattern) come from its `WeaponDef`.
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
     * Shots fired from this weapon since the spawn, wrapping at 256. Seeds the spread of the next
     * shot: the server counts it, so a client cannot choose its spread by choosing its command numbers.
     */
    shots: number;
}

/**
 * Everything a defender carries: one `GunState` per slot of `WEAPONS`, which one is in hand, the
 * switch and aim timers, and the trigger edge. Small integers only, sent exactly in the snapshot,
 * stepped once per processed command by `stepLoadout` on the server and in the client's prediction
 * and replay.
 */
export interface LoadoutState {
    /** Slot in hand (index into `WEAPONS`); changes the moment a switch starts. */
    slot: number;
    /** The slot held before the last switch: where Q goes. */
    prev: number;
    /** Commands left until the weapon in hand can fire or reload; 0 when ready. */
    draw: number;
    /** Aim-down-sights progress in commands, 0 (hip) to the weapon's `adsTicks` (fully aimed). */
    aim: number;
    /**
     * 1 once the trigger has done something (a shot, a dry click, a reload on empty) and is still
     * held; 0 once released. A semi-automatic weapon fires only while this is 0, so every shot needs
     * a new press. Part of the stepped state, never of wall-clock input.
     */
    trigger: number;
    readonly guns: GunState[];
}

/** The fields of a command `stepLoadout` reads. `NetCmd` has them all. */
export interface LoadoutInput {
    fire: boolean;
    reload: boolean;
    /** 0: no request; n: select slot n - 1 (key n). */
    slot: number;
    /** Q: back to the previous weapon. Ignored when `slot` asks for something. */
    swap: boolean;
    /** Aim down sights held. */
    aim: boolean;
}

/** What `stepGun` did this command. A shot returns its recoil pattern index instead (0 or more). */
export const GUN_IDLE = -1;
export const GUN_RELOAD = -2;
export const GUN_DRY = -3;

const SINCE_SHOT_CAP = 255;

export function createGunState(def: WeaponDef = WEAPONS[0]): GunState {
    return { mag: def.magSize, reserve: def.reserve, reload: 0, cooldown: 0, burst: 0, sinceShot: SINCE_SHOT_CAP, shots: 0 };
}

/** Full magazine and reserve, nothing in progress. */
export function resetGun(g: GunState, def: WeaponDef): void {
    g.mag = def.magSize;
    g.reserve = def.reserve;
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

function canReload(g: GunState, def: WeaponDef): boolean {
    return g.reload === 0 && g.mag < def.magSize && g.reserve > 0;
}

/**
 * Advances one weapon by one of its owner's commands. `stepLoadout` calls it for every slot on
 * every command a living defender simulates (the weapons not in hand with everything false, so
 * their timers and recoil recovery still run). `armed` is false while the trigger cannot act
 * (round freeze, hands busy defusing, weapon still being drawn); timers still run then. `fire` is
 * the trigger as this weapon sees it (a semi-automatic's spent trigger is already filtered out).
 * Returns the recoil pattern index of a shot fired this command, or one of GUN_IDLE, GUN_RELOAD
 * (a reload started) and GUN_DRY (an empty click).
 */
export function stepGun(g: GunState, def: WeaponDef, fire: boolean, reload: boolean, armed: boolean): number {
    if (g.sinceShot < SINCE_SHOT_CAP) {
        g.sinceShot++;
        // Recoil recovers one pattern step at a time once the shooter pauses. The whole pattern is
        // undone long before the counter reaches its cap (a test checks every weapon).
        if (g.burst > 0 && g.sinceShot >= def.recoilRecoverTicks &&
            (g.sinceShot - def.recoilRecoverTicks) % def.recoilDecayTicks === 0) g.burst--;
    }
    if (g.cooldown > 0) g.cooldown--;

    if (g.reload > 0) {
        // Firing is impossible until the reload completes; it may fire on the completing command.
        if (--g.reload > 0) return GUN_IDLE;
        const take = Math.min(def.magSize - g.mag, g.reserve);
        g.mag += take;
        g.reserve -= take;
    } else if (reload && armed && canReload(g, def)) {
        g.reload = def.reloadTicks;
        return GUN_RELOAD;
    }

    if (!fire || !armed || g.cooldown > 0) return GUN_IDLE;
    if (g.mag > 0) {
        g.mag--;
        g.cooldown = def.fireInterval;
        const index = g.burst;
        if (g.burst < def.patternDeg.length - 1) g.burst++;
        g.sinceShot = 0;
        g.shots = (g.shots + 1) & 0xff;
        return index;
    }
    if (canReload(g, def)) {
        g.reload = def.reloadTicks; // empty magazine: pulling the trigger reloads
        return GUN_RELOAD;
    }
    g.cooldown = DRY_FIRE_TICKS;
    return GUN_DRY;
}

/** Where Q goes before any switch: the second slot. */
const FIRST_PREV = WEAPON_COUNT > 1 ? 1 : 0;

export function createLoadout(): LoadoutState {
    return { slot: 0, prev: FIRST_PREV, draw: 0, aim: 0, trigger: 0, guns: WEAPONS.map(d => createGunState(d)) };
}

/** Every weapon full, the first slot in hand and ready: every spawn (so every round start). */
export function resetLoadout(l: LoadoutState): void {
    l.slot = 0;
    l.prev = FIRST_PREV;
    l.draw = 0;
    l.aim = 0;
    l.trigger = 0;
    for (let i = 0; i < WEAPON_COUNT; i++) resetGun(l.guns[i], WEAPONS[i]);
}

/** Death: reloads in progress give nothing. */
export function cancelReloads(l: LoadoutState): void {
    for (let i = 0; i < WEAPON_COUNT; i++) l.guns[i].reload = 0;
}

export function copyLoadout(dst: LoadoutState, src: LoadoutState): void {
    dst.slot = src.slot;
    dst.prev = src.prev;
    dst.draw = src.draw;
    dst.aim = src.aim;
    dst.trigger = src.trigger;
    for (let i = 0; i < WEAPON_COUNT; i++) copyGunState(dst.guns[i], src.guns[i]);
}

export function sameLoadout(a: LoadoutState, b: LoadoutState): boolean {
    if (a.slot !== b.slot || a.prev !== b.prev || a.draw !== b.draw || a.aim !== b.aim || a.trigger !== b.trigger) return false;
    for (let i = 0; i < WEAPON_COUNT; i++) if (!sameGunState(a.guns[i], b.guns[i])) return false;
    return true;
}

/** The weapon in hand. */
export const heldWeapon = (l: LoadoutState): WeaponDef => WEAPONS[l.slot];
export const heldGun = (l: LoadoutState): GunState => l.guns[l.slot];

/** True only on the command a switch started (for its sound and motion). */
export const justSwitched = (l: LoadoutState): boolean => l.draw > 0 && l.draw === WEAPONS[l.slot].drawTicks;

/**
 * Advances everything a defender carries by one processed command: weapon selection, the switch,
 * aim down sights, the trigger edge, then every weapon. Run for every command a living defender
 * simulates, by the server and by the client's prediction and replay alike, with the same inputs.
 * `armed` is false during the freeze and while defusing. Returns what the weapon in hand did (see
 * `stepGun`); after a shot, `shotDirectionFor` gives where it went.
 */
export function stepLoadout(l: LoadoutState, c: LoadoutInput, armed: boolean): number {
    let want = l.slot;
    if (c.slot > 0 && c.slot <= WEAPON_COUNT) want = c.slot - 1;
    else if (c.swap) want = l.prev;
    if (want !== l.slot) {
        l.guns[l.slot].reload = 0; // switching cancels a reload, and a cancelled reload gives nothing
        l.prev = l.slot;
        l.slot = want;
        l.draw = WEAPONS[want].drawTicks;
        // Aim keeps easing out at the usual rate, measured in the new weapon's steps.
        if (l.aim > WEAPONS[want].adsTicks) l.aim = WEAPONS[want].adsTicks;
    } else if (l.draw > 0) l.draw--;

    const def = WEAPONS[l.slot];
    const gun = l.guns[l.slot];
    const ready = l.draw === 0;
    if (c.aim && ready && gun.reload === 0) {
        if (l.aim < def.adsTicks) l.aim++;
    } else if (l.aim > 0) l.aim--;

    const fire = c.fire && (def.auto || l.trigger === 0);
    let result = GUN_IDLE;
    for (let i = 0; i < WEAPON_COUNT; i++) {
        if (i === l.slot) result = stepGun(gun, def, fire, c.reload, armed && ready);
        else stepGun(l.guns[i], WEAPONS[i], false, false, false);
    }
    if (!c.fire) l.trigger = 0;
    else if (fire && result !== GUN_IDLE) l.trigger = 1;
    return result;
}

/** Aim-down-sights progress 0..1 of the weapon in hand. */
export function aimFraction(l: LoadoutState): number {
    return l.aim / WEAPONS[l.slot].adsTicks;
}

/** Recoil multiplier for the weapon in hand: 1 from the hip, `adsRecoil` fully aimed. */
export function recoilScale(l: LoadoutState): number {
    return 1 - aimFraction(l) * (1 - WEAPONS[l.slot].adsRecoil);
}

const DEG = Math.PI / 180;
/** Each weapon's pattern in radians, as flat [pitch, yaw] pairs. */
const PATTERNS = WEAPONS.map(d => {
    const p = new Float64Array(d.patternDeg.length * 2);
    for (let i = 0; i < d.patternDeg.length; i++) {
        p[i * 2] = d.patternDeg[i][0] * DEG;
        p[i * 2 + 1] = d.patternDeg[i][1] * DEG;
    }
    return p;
});

const patternRow = (def: WeaponDef, index: number): number =>
    Math.max(0, Math.min(def.patternDeg.length - 1, index | 0)) * 2;

/** Recoil pattern offset in radians for a shot index (see `stepGun`), before any aim scaling. */
export function recoilPitch(def: WeaponDef, index: number): number {
    return PATTERNS[WEAPONS.indexOf(def)][patternRow(def, index)];
}
export function recoilYaw(def: WeaponDef, index: number): number {
    return PATTERNS[WEAPONS.indexOf(def)][patternRow(def, index) + 1];
}

/** Spread cone half-angle (radians) for a shooter in this state with this weapon, `aim` 0..1. */
export function spreadAngle(s: PlayerState, def: WeaponDef, aim = 0): number {
    let base: number;
    if (!s.onGround) base = def.spreadAir;
    else base = (s.crouched ? def.spreadCrouched : def.spreadStill) + Math.min(horizontalSpeed(s) / RUN_SPEED, 1) * def.spreadMoving;
    return base * (1 - aim * (1 - def.adsSpread));
}

/** 32-bit integer hash (lowbias32); integer-only so every JavaScript engine gives the same bits. */
function hash32(x: number): number {
    x = (x ^ (x >>> 16)) >>> 0;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Spread seed of the shot `stepLoadout` just fired: the weapon's shot count, which the server
 * keeps, plus the slot so the two weapons do not repeat each other.
 */
export function spreadSeed(l: LoadoutState): number {
    return l.guns[l.slot].shots + l.slot * 256;
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
 * The direction a shot travels: the view, plus the weapon's recoil pattern row for this shot of
 * the burst times `recoil`, plus spread.
 */
export function shotDirection(
    yaw: number, pitch: number, def: WeaponDef, index: number, recoil: number, spread: number, seed: number,
    shooter: number, out: Vec3
): Vec3 {
    spreadOffset(seed, shooter, spread, scratch);
    const p = pitch + recoilPitch(def, index) * recoil + scratch[0];
    return viewDir(yaw + recoilYaw(def, index) * recoil + scratch[1],
        p < -PITCH_LIMIT ? -PITCH_LIMIT : p > PITCH_LIMIT ? PITCH_LIMIT : p, out);
}

/**
 * Where the shot `stepLoadout` just fired (pattern index `index`) went, for a shooter in state `s`
 * looking along `yaw`/`pitch`. The server traces this; the client draws its predicted tracer along it.
 */
export function shotDirectionFor(
    l: LoadoutState, s: PlayerState, yaw: number, pitch: number, index: number, shooter: number, out: Vec3
): Vec3 {
    const def = WEAPONS[l.slot];
    return shotDirection(yaw, pitch, def, index, recoilScale(l), spreadAngle(s, def, aimFraction(l)),
        spreadSeed(l), shooter, out);
}
