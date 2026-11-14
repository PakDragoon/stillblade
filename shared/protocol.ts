import type { Phase, RoundReason } from './rules';
import type { GunState, LoadoutState } from './gun';
import type { KnifeState } from './knife';
import type { InputCmd, Vec3 } from './types';
import { WEAPON_COUNT } from './weapons';

export const PROTOCOL_VERSION = 7;
export const DEFAULT_PORT = 8080;
/** Snapshots per second sent to each client. */
export const SNAPSHOT_RATE = 30;

export type Team = 'ghosts' | 'defenders';

/** One client tick: movement intent plus everything the server needs to resolve a shot. */
export interface NetCmd extends InputCmd {
    /** Monotonic per client; the server acknowledges the last one it simulated. */
    seq: number;
    /** View pitch in radians, positive looks up. */
    pitch: number;
    fire: boolean;
    /** Use key held: plant (ghosts) or defuse (defenders). */
    use: boolean;
    /** Reload key (R) pressed; acted on only if the magazine is not full and there is reserve. */
    reload: boolean;
    /** Weapon select: 0 for none, n for slot n - 1 (keys 1, 2; the mouse wheel picks one too). */
    slot: number;
    /** Q: back to the previous weapon (ignored when `slot` is set). */
    swap: boolean;
    /** Aim down sights held (right mouse). */
    aim: boolean;
    /** Server time (ms) at which this client was drawing other players: the lag-compensation target. */
    viewTime: number;
}

export interface PlayerSnap {
    id: number;
    team: Team;
    pos: Vec3;
    yaw: number;
    pitch: number;
    crouched: boolean;
    alive: boolean;
    /** Opacity 0..1: 1 for defenders, velocity-driven for ghosts. */
    vis: number;
    /** A defender in the middle of a reload (for its animation). */
    reloading: boolean;
    /** Weapon slot in a defender's hands (index into WEAPONS); 0 for ghosts. */
    weapon: number;
    /** A defender drawing the weapon it just switched to. */
    switching: boolean;
    /** A defender aiming down sights (more than half way in). */
    aiming: boolean;
}

export interface SelfSnap {
    /** Sides swap at halftime, so the team can change during a match. */
    team: Team;
    /** Plant or defuse progress, 0..1; 0 when not doing either. */
    action: number;
    /** The local player's own visibility (see PlayerSnap.vis). */
    vis: number;
    pos: Vec3;
    vel: Vec3;
    onGround: boolean;
    crouched: boolean;
    health: number;
    alive: boolean;
    /** Server time (ms) of the next respawn; meaningful only while dead. */
    respawnAt: number;
    /** The defender's weapons, predicted by the client: sent exactly (all small integers). */
    loadout: LoadoutState;
    /** The ghost knife timing, predicted by the client: sent exactly (small integers). */
    knife: KnifeState;
}

export interface ShotEvent {
    type: 'shot';
    shooter: number;
    /** Slot of the weapon that fired (index into WEAPONS), for its sound and tracer. */
    weapon: number;
    from: Vec3;
    to: Vec3;
    /** Present when a player was hit. */
    victim?: number;
    head?: boolean;
    damage?: number;
    killed?: boolean;
}

/** A knife swing landing (or missing) after its windup. */
export interface SlashEvent {
    type: 'slash';
    attacker: number;
    pos: Vec3;
    victim?: number;
    damage?: number;
    backstab?: boolean;
    killed?: boolean;
}

/** A sound the recipient is close enough to hear. Never sent to players out of range. */
export interface SoundEvent {
    type: 'sound';
    kind: 'step' | 'windup' | 'reload';
    id: number;
    pos: Vec3;
    /** 0..1 loudness at the source. */
    loud: number;
    /** For 'reload': the slot of the weapon being reloaded. */
    weapon?: number;
}

/** The state of the round. Sent whenever it changes and to every player who joins. */
export interface RoundMsg {
    type: 'round';
    phase: Phase;
    /** Server time (ms) when this phase ends; 0 for warmup. */
    endsAt: number;
    /** 1-based number of the current round. */
    round: number;
    score: Record<Team, number>;
    /** Where the bomb sits once planted. */
    bomb: Vec3 | null;
    /** Set during `over`. */
    winner?: Team;
    reason?: RoundReason;
    /** The round just won also decided the match. */
    matchOver?: boolean;
}

export interface RosterEntry {
    id: number;
    name: string;
    team: Team;
    kills: number;
    deaths: number;
    alive: boolean;
}

export type ServerMsg =
    /** `map` is the room's map id (load maps/<map>.json and .glb before spawning); `mapName` its display name. */
    | { type: 'welcome'; version: number; id: number; team: Team; map: string; mapName: string; time: number }
    | { type: 'snap'; time: number; ack: number; me: SelfSnap; players: PlayerSnap[] }
    | { type: 'spawn'; pos: Vec3; yaw: number }
    | ShotEvent
    | SlashEvent
    | SoundEvent
    | RoundMsg
    | { type: 'roster'; players: RosterEntry[] };

export type ClientMsg = { type: 'cmd'; cmd: NetCmd };

// ---------------------------------------------------------------------------------------------
// Wire format. The two messages that flow constantly (commands up, snapshots down) are packed
// binary; everything else is rare and stays JSON text. These four functions are the only place
// the format lives.
//
// Values the client predicts with must survive the trip bit-for-bit, or the client and server
// simulate slightly different inputs and prediction drifts: so the local player's state is sent
// as float64, and the client rounds its view angles to float32 (Math.fround) BEFORE using them.
// ---------------------------------------------------------------------------------------------

const CMD_TAG = 1;
const SNAP_TAG = 2;
const CMD_BYTES = 25;
/** Self state up to the loadout, then 5 loadout bytes, 7 per weapon, 2 knife, 1 player count. */
const SNAP_LOADOUT = 75;
const SNAP_GUNS = SNAP_LOADOUT + 5;
const SNAP_KNIFE = SNAP_GUNS + 7 * WEAPON_COUNT;
const SNAP_COUNT = SNAP_KNIFE + 2;
const SNAP_HEAD_BYTES = SNAP_COUNT + 1;
const SNAP_PLAYER_BYTES = 20;
const ANGLE_SCALE = 32767 / Math.PI;

export type Wire = string | Uint8Array<ArrayBuffer>;

const unit = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function encodeCmd(c: NetCmd): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(CMD_BYTES);
    const v = new DataView(out.buffer);
    v.setUint8(0, CMD_TAG);
    v.setUint32(1, c.seq, true);
    v.setInt8(5, Math.round(c.forward * 127));
    v.setInt8(6, Math.round(c.right * 127));
    v.setFloat32(7, c.yaw, true);
    v.setFloat32(11, c.pitch, true);
    v.setUint8(15, (c.jump ? 1 : 0) | (c.walk ? 2 : 0) | (c.crouch ? 4 : 0) | (c.fire ? 8 : 0) | (c.use ? 16 : 0) |
        (c.reload ? 32 : 0) | (c.swap ? 64 : 0) | (c.aim ? 128 : 0));
    v.setFloat64(16, c.viewTime, true);
    v.setUint8(24, c.slot);
    return out;
}

function decodeCmd(v: DataView): NetCmd {
    const flags = v.getUint8(15);
    return {
        seq: v.getUint32(1, true),
        forward: v.getInt8(5) / 127,
        right: v.getInt8(6) / 127,
        yaw: v.getFloat32(7, true),
        pitch: v.getFloat32(11, true),
        jump: (flags & 1) !== 0, walk: (flags & 2) !== 0, crouch: (flags & 4) !== 0,
        fire: (flags & 8) !== 0, use: (flags & 16) !== 0, reload: (flags & 32) !== 0,
        swap: (flags & 64) !== 0, aim: (flags & 128) !== 0,
        viewTime: v.getFloat64(16, true),
        slot: v.getUint8(24)
    };
}

function encodeSnap(m: Extract<ServerMsg, { type: 'snap' }>): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(SNAP_HEAD_BYTES + m.players.length * SNAP_PLAYER_BYTES);
    const v = new DataView(out.buffer);
    const me = m.me;
    v.setUint8(0, SNAP_TAG);
    v.setFloat64(1, m.time, true);
    v.setInt32(9, m.ack, true);
    v.setUint8(13, (me.team === 'ghosts' ? 1 : 0) | (me.onGround ? 2 : 0) | (me.crouched ? 4 : 0) | (me.alive ? 8 : 0));
    v.setUint8(14, me.health);
    v.setUint16(15, Math.round(unit(me.action) * 65535), true);
    v.setUint16(17, Math.round(unit(me.vis) * 65535), true);
    for (let k = 0; k < 3; k++) {
        v.setFloat64(19 + k * 8, me.pos[k], true);
        v.setFloat64(43 + k * 8, me.vel[k], true);
    }
    v.setFloat64(67, me.respawnAt, true);
    const l = me.loadout;
    v.setUint8(SNAP_LOADOUT, l.slot);
    v.setUint8(SNAP_LOADOUT + 1, l.prev);
    v.setUint8(SNAP_LOADOUT + 2, l.draw);
    v.setUint8(SNAP_LOADOUT + 3, l.aim);
    v.setUint8(SNAP_LOADOUT + 4, l.trigger);
    for (let i = 0; i < WEAPON_COUNT; i++) {
        const g = l.guns[i], o = SNAP_GUNS + 7 * i;
        v.setUint8(o, g.mag);
        v.setUint8(o + 1, g.reserve);
        v.setUint8(o + 2, g.reload);
        v.setUint8(o + 3, g.cooldown);
        v.setUint8(o + 4, g.burst);
        v.setUint8(o + 5, g.sinceShot);
        v.setUint8(o + 6, g.shots);
    }
    v.setUint8(SNAP_KNIFE, me.knife.cooldown);
    v.setUint8(SNAP_KNIFE + 1, me.knife.windup);
    v.setUint8(SNAP_COUNT, m.players.length);
    let o = SNAP_HEAD_BYTES;
    for (const p of m.players) {
        v.setUint16(o, p.id, true);
        v.setUint8(o + 2, (p.team === 'ghosts' ? 1 : 0) | (p.crouched ? 2 : 0) | (p.alive ? 4 : 0) | (p.reloading ? 8 : 0) |
            (p.switching ? 16 : 0) | (p.aiming ? 32 : 0));
        v.setUint8(o + 3, Math.round(unit(p.vis) * 255));
        for (let k = 0; k < 3; k++) v.setFloat32(o + 4 + k * 4, p.pos[k], true);
        // Yaw accumulates without bound on the client; wrap it into one turn before packing.
        v.setInt16(o + 16, Math.round(Math.atan2(Math.sin(p.yaw), Math.cos(p.yaw)) * ANGLE_SCALE), true);
        v.setInt8(o + 18, Math.round(Math.max(-1, Math.min(1, p.pitch / (Math.PI / 2))) * 127));
        v.setUint8(o + 19, p.weapon);
        o += SNAP_PLAYER_BYTES;
    }
    return out;
}

function decodeLoadout(v: DataView): LoadoutState {
    const guns: GunState[] = [];
    for (let i = 0; i < WEAPON_COUNT; i++) {
        const o = SNAP_GUNS + 7 * i;
        guns.push({
            mag: v.getUint8(o), reserve: v.getUint8(o + 1), reload: v.getUint8(o + 2), cooldown: v.getUint8(o + 3),
            burst: v.getUint8(o + 4), sinceShot: v.getUint8(o + 5), shots: v.getUint8(o + 6)
        });
    }
    return {
        slot: v.getUint8(SNAP_LOADOUT), prev: v.getUint8(SNAP_LOADOUT + 1), draw: v.getUint8(SNAP_LOADOUT + 2),
        aim: v.getUint8(SNAP_LOADOUT + 3), trigger: v.getUint8(SNAP_LOADOUT + 4), guns
    };
}

function decodeSnap(v: DataView): ServerMsg {
    const flags = v.getUint8(13);
    const count = v.getUint8(SNAP_COUNT);
    if (v.byteLength < SNAP_HEAD_BYTES + count * SNAP_PLAYER_BYTES) throw new Error('truncated snapshot');
    const players: PlayerSnap[] = [];
    let o = SNAP_HEAD_BYTES;
    for (let i = 0; i < count; i++) {
        const f = v.getUint8(o + 2);
        players.push({
            id: v.getUint16(o, true),
            team: f & 1 ? 'ghosts' : 'defenders',
            crouched: (f & 2) !== 0,
            alive: (f & 4) !== 0,
            reloading: (f & 8) !== 0,
            switching: (f & 16) !== 0,
            aiming: (f & 32) !== 0,
            weapon: v.getUint8(o + 19),
            vis: v.getUint8(o + 3) / 255,
            pos: [v.getFloat32(o + 4, true), v.getFloat32(o + 8, true), v.getFloat32(o + 12, true)],
            yaw: v.getInt16(o + 16, true) / ANGLE_SCALE,
            pitch: (v.getInt8(o + 18) / 127) * (Math.PI / 2)
        });
        o += SNAP_PLAYER_BYTES;
    }
    return {
        type: 'snap',
        time: v.getFloat64(1, true),
        ack: v.getInt32(9, true),
        me: {
            team: flags & 1 ? 'ghosts' : 'defenders',
            onGround: (flags & 2) !== 0,
            crouched: (flags & 4) !== 0,
            alive: (flags & 8) !== 0,
            health: v.getUint8(14),
            action: v.getUint16(15, true) / 65535,
            vis: v.getUint16(17, true) / 65535,
            pos: [v.getFloat64(19, true), v.getFloat64(27, true), v.getFloat64(35, true)],
            vel: [v.getFloat64(43, true), v.getFloat64(51, true), v.getFloat64(59, true)],
            respawnAt: v.getFloat64(67, true),
            loadout: decodeLoadout(v),
            knife: { cooldown: v.getUint8(SNAP_KNIFE), windup: v.getUint8(SNAP_KNIFE + 1) }
        },
        players
    };
}

const view = (data: ArrayBuffer | Uint8Array): DataView =>
    data instanceof Uint8Array ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);

export function encodeServer(m: ServerMsg): Wire {
    return m.type === 'snap' ? encodeSnap(m) : JSON.stringify(m);
}

export function decodeServer(data: string | ArrayBuffer | Uint8Array): ServerMsg {
    if (typeof data === 'string') return JSON.parse(data) as ServerMsg;
    const v = view(data);
    if (v.byteLength < SNAP_HEAD_BYTES || v.getUint8(0) !== SNAP_TAG) throw new Error('unknown server message');
    return decodeSnap(v);
}

export function encodeClient(m: ClientMsg): Wire {
    return encodeCmd(m.cmd);
}

/** Throws on anything that is not a well-formed command: the server treats that as "ignore". */
export function decodeClient(data: ArrayBuffer | Uint8Array): ClientMsg {
    const v = view(data);
    if (v.byteLength !== CMD_BYTES || v.getUint8(0) !== CMD_TAG) throw new Error('unknown client message');
    return { type: 'cmd', cmd: decodeCmd(v) };
}
