import type { CarryState } from './bomb';
import type { Phase, RoundReason } from './rules';
import type { GunState, LoadoutState } from './gun';
import type { KnifeState } from './knife';
import type { RoomOptions } from './room-options';
import type { InputCmd, Vec3 } from './types';
import { GUN_COUNT, SIGHT_COUNT } from './weapons';
import type { HitZone } from './zones';

export { default as PROTOCOL_VERSION } from './protocol-version.json';
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
    /** Weapon select: 0 for none, n for slot n - 1 (keys 1, 2, 3; the mouse wheel picks one too). */
    slot: number;
    /** Q: back to the previous weapon (ignored when `slot` is set). */
    swap: boolean;
    /** Aim down sights held (right mouse). */
    aim: boolean;
    /** Drop the bomb (ghost carrying it; one command per key press). Refused while planting. */
    drop: boolean;
    /** Sent before this client has a living body. Counts activity without advancing a new spawn. */
    observerOnly?: boolean;
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
    /** Weapon slot in a defender's hands (index into WEAPONS, or SLOT_KNIFE); 0 for ghosts. */
    weapon: number;
    /** A defender drawing the weapon it just switched to. */
    switching: boolean;
    /** A defender aiming down sights (more than half way in). */
    aiming: boolean;
}

export interface SelfSnap {
    /** Sides swap at halftime, so the team can change during a match. */
    team: Team;
    /**
     * Consecutive commands spent planting or defusing (0 when doing neither), exact: the client predicts
     * when a plant completes (PLANT_TICKS, shared/rules.ts) from it.
     */
    actionTicks: number;
    /** The local player's own visibility (see PlayerSnap.vis). */
    vis: number;
    pos: Vec3;
    vel: Vec3;
    onGround: boolean;
    crouched: boolean;
    health: number;
    /** This player's own armor (shared/armor.ts), 0..MAX_ARMOR. Only ever sent to its owner, never to anyone else. */
    armor: number;
    alive: boolean;
    /** Server time (ms) of the next respawn; meaningful only while dead. */
    respawnAt: number;
    /** The living teammate determining this spectator’s view and cues, or 0. */
    spectateId: number;
    /** The defender's weapons including its knife, predicted by the client: sent exactly (all small integers). */
    loadout: LoadoutState;
    /** The ghost knife timing, predicted by the client: sent exactly (small integers). */
    knife: KnifeState;
    /**
     * Whether this player carries the bomb, and the repick wait after a deliberate drop (shared/bomb.ts),
     * predicted by the client: sent exactly. Always false and 0 for defenders.
     */
    carry: CarryState;
}

/**
 * A gunshot. Sent to the shooter, the player hit, everyone within earshot (GUNSHOT_RANGE, or
 * GUNSHOT_RANGE_SUPPRESSED in a suppressed room) and, flagged `silent`, to anyone further away whose
 * eye can see the shooter's eye: they see the flash and tracer but are too far to hear it.
 */
export interface ShotEvent {
    type: 'shot';
    shooter: number;
    /** Slot of the gun that fired (index into WEAPONS), for its sound and tracer. */
    weapon: number;
    from: Vec3;
    to: Vec3;
    /** Seen but out of earshot: draw it, play no sound. */
    silent?: boolean;
    /** Present when a player was hit. */
    victim?: number;
    /** Where the hit landed (shared/zones.ts); present with `victim`. */
    zone?: HitZone;
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

/**
 * A sound the recipient is close enough to hear. Never sent to players out of range. For the bomb sounds
 * (`bombDrop`, `bombPickup`) a defender gets `id` 0: who carries the bomb is never told to defenders.
 */
export interface SoundEvent {
    type: 'sound';
    kind: 'step' | 'windup' | 'reload' | 'bombDrop' | 'bombPickup';
    id: number;
    pos: Vec3;
    /** 0..1 loudness at the source. */
    loud: number;
    /** For 'reload': the slot of the weapon being reloaded. */
    weapon?: number;
    /**
     * For 'reload' (protocol 17): true when it is an empty reload (the magazine was empty, so the bolt is worked and
     * the reload takes the weapon's `reloadEmptyTicks`); absent otherwise. Sent to the same players as the sound.
     */
    empty?: boolean;
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

/**
 * What happened to the bomb (ghosts only): `assign` at the round start (`by` carries it), `drop` (`by`
 * dropped it on purpose), `lost` (`by` died or left with it), `pickup` (`by` picked it up).
 */
export type BombEvent = 'assign' | 'drop' | 'lost' | 'pickup';

/**
 * The bomb before it is planted. Ghosts always know who carries it and where a dropped bomb lies, and get
 * this on every change. A defender gets only `dropped`, and only while the dropped bomb is in its line of
 * sight: sent when it comes into sight and again (null) when it leaves sight, is picked up or the round
 * resets. A defender is never told who carries the bomb. The planted bomb is in `RoundMsg.bomb`.
 */
export interface BombMsg {
    type: 'bomb';
    /** Where a dropped bomb lies (on the floor); null when none is dropped or (defenders) none is in sight. */
    dropped: Vec3 | null;
    /** Ghosts only: the carrier's player id, 0 when nobody carries it. */
    carrier?: number;
    /** Ghosts only: what changed, and who it is about. */
    event?: BombEvent;
    by?: number;
}

/** Per-player match statistics. Reset when a new match starts. */
export interface MatchStats {
    kills: number;
    deaths: number;
    /** Damage dealt to a player who died within ASSIST_MS (shared/stats.ts) to someone else's hit. */
    assists: number;
    headshots: number;
    backstabs: number;
    /** Health and armor actually removed from enemies (package P: armor counts too). */
    damage: number;
    plants: number;
    defuses: number;
}

export interface RosterEntry extends MatchStats {
    id: number;
    name: string;
    team: Team;
    alive: boolean;
    /** Pressed ready in the warmup lobby. */
    ready: boolean;
    /** The room creator: the only player who may start the match early. */
    creator: boolean;
    /** Moved to spectate-only for sending no input changes during live rounds. */
    idle: boolean;
    /** A computer player run by the server (its name also starts with "BOT"). */
    bot: boolean;
    /**
     * The rifle sight this player's current life uses (index into `SIGHTS`, shared/weapons.ts), for drawing it
     * on their gun. The active one only: a choice made mid-life shows from their next spawn. Bots: iron.
     */
    sight: number;
}

/**
 * What hit a player: used for the hit marker, the kill feed and the death recap. A shot also carries
 * its `HitZone` (a headshot is a shot with zone 'head'); knife hits have no zone.
 */
export type DamageKind = 'shot' | 'knife' | 'backstab';

/** Final result of a match, sent once when it is decided; the next match starts at `nextAt`. */
export interface SummaryMsg {
    type: 'summary';
    winner: Team;
    score: Record<Team, number>;
    players: RosterEntry[];
    /** Player id with the best `mvpScore` (shared/stats.ts). */
    mvp: number;
    /** Server time (ms) the fresh match starts. */
    nextAt: number;
}

/** A chat line as delivered to one recipient. */
export interface ChatMsg {
    type: 'chat';
    from: number;
    name: string;
    /** Team chat: only the sender's team receives it. */
    team: boolean;
    /** Sent by a dead player during a live round (so only dead players receive it). */
    dead: boolean;
    text: string;
}

/**
 * Sent to the player who was hit. `dir` is the world bearing (radians, yaw convention: 0 faces -Z)
 * from the victim toward the attacker, which a hit already reveals; no position, and `dist` only
 * with the killing blow (a knife kill is within knife reach, so inside breathing range).
 */
export interface DamageMsg {
    type: 'dmg';
    dir: number;
    /** Health the hit removed (capped at the health there was). */
    amount: number;
    /** Armor the hit removed (shared/armor.ts), absent when none: the victim's own armor, told only to the victim. */
    armor?: number;
    kind: DamageKind;
    killed?: boolean;
    by?: number;
    dist?: number;
    /** Slot (index into WEAPONS) of the gun that hit; absent for the knife. */
    weapon?: number;
    /** Where a shot landed; absent for the knife. */
    zone?: HitZone;
}

/** Sent to the attacker: the hit landed. */
export interface HitConfirmMsg {
    type: 'hitconfirm';
    kind: DamageKind;
    /** Where a shot landed; absent for the knife. */
    zone?: HitZone;
    /** The hit killed. */
    kill: boolean;
    /** The hit's full amount (before armor and before any cap at the victim's remaining health). */
    damage: number;
    /**
     * Practice range only: how much of `damage` went to the target's armor (the rest went to its health).
     * Never sent in a match, so an attacker learns nothing about an enemy's armor.
     */
    armor?: number;
}

/**
 * Someone was killed: sent to every player in the room, for the kill feed. Says who killed whom and
 * how, never where (the roster already tells everyone who is alive).
 */
export interface KillMsg {
    type: 'kill';
    killer: number;
    victim: number;
    kind: DamageKind;
    /** Slot (index into WEAPONS) of the gun; absent for a knife kill. */
    weapon?: number;
    zone?: HitZone;
}

export type ServerMsg =
    /** `map` is the room's map id (load maps/<map>.json and .glb before spawning); `mapName` its display name. */
    /** `practice`: the room is a private practice range (no rounds, reserves kept full: the client predicts that too). */
    | { type: 'welcome'; version: number; id: number; team: Team; map: string; mapName: string; time: number; options: RoomOptions; room: string; practice?: boolean }
    | { type: 'snap'; time: number; ack: number; me: SelfSnap; players: PlayerSnap[] }
    /** `sight`: the rifle sight active for this life (the client predicts aim with it until the first snapshot). */
    | { type: 'spawn'; pos: Vec3; yaw: number; sight: number }
    | ShotEvent
    | SlashEvent
    | SoundEvent
    | RoundMsg
    | { type: 'roster'; players: RosterEntry[] }
    /** Every few seconds: each human player's round trip to the server, measured by the server (never reported by a client). */
    | PingsMsg
    | SummaryMsg
    | ChatMsg
    | DamageMsg
    | HitConfirmMsg
    | KillMsg
    | BombMsg
    /** A server note for this player only (rate limited, idle, refused request). */
    | { type: 'notice'; text: string }
    /** The room's options changed (the creator, in warmup). */
    | { type: 'options'; options: RoomOptions }
    | KickVoteMsg
    | MapVoteMsg
    /** The room moved to another map between matches: unload the old one and load this before anything else arrives. */
    | { type: 'map'; map: string; mapName: string };

/** Longest ping the server reports, in milliseconds (anything slower reads as this). */
export const PING_MAX = 999;

/** `[player id, milliseconds]` for every human player with a measurement; bots and unmeasured players are absent. */
export interface PingsMsg {
    type: 'pings';
    pings: [number, number][];
}

/** A vote to remove a player, as everyone sees it. `vote` is null when none is running. */
export interface KickVoteInfo {
    target: number;
    targetName: string;
    caller: number;
    callerName: string;
    yes: number;
    no: number;
    /** Yes votes needed to pass. */
    needed: number;
    /** Server time (ms) the vote ends. */
    endsAt: number;
    /** This recipient's own vote, null while undecided (always null for the target, who cannot vote). */
    mine: boolean | null;
}
export interface KickVoteMsg { type: 'kickvote'; vote: KickVoteInfo | null }

/** The map vote on the result card. `mine` is the recipient's pick (a map id), null if none yet. */
export interface MapVoteMsg {
    type: 'mapvote';
    maps: { id: string; name: string; votes: number }[];
    /** The map the room is on now: a vote for it is "same map". */
    current: string;
    mine: string | null;
    /** Server time (ms) the vote closes. */
    closesAt: number;
    /** Set once the vote is closed: the map the next match is on. */
    next?: string;
}

/** Everything except `cmd` is rare and travels as JSON text. */
export type ClientMsg =
    | { type: 'cmd'; cmd: NetCmd }
    | { type: 'ready'; ready: boolean }
    | { type: 'start' }
    | { type: 'team' }
    | { type: 'chat'; team: boolean; text: string }
    /** Creator only, warmup only: any subset of the options (validated like the join query). */
    | { type: 'options'; options: Partial<Record<keyof RoomOptions, unknown>> }
    /** Start a vote to remove `target` (a player id). */
    | { type: 'votekick'; target: number }
    | { type: 'votecast'; yes: boolean }
    /** Creator only, warmup only, two players in the room: remove the other one directly. */
    | { type: 'removeplayer'; target: number }
    /** Result card: pick the next map (a map id; the current one means "same map"). */
    | { type: 'mapvote'; map: string }
    | { type: 'spectate'; target: number }
    /**
     * The rifle sight this player wants (index into `SIGHTS`). Sent on joining and on every change; the server
     * keeps it and mounts it at the player's next spawn, never mid-life.
     */
    | { type: 'sight'; sight: number }
    | ReportMsg;

export const CHAT_MAX_CHARS = 120;

/** What the client knows about its own machine when it files a report. The server adds everything it knows itself. */
export interface ReportCtx {
    /** Frames per second, render scale (0..1) and round-trip ping in ms. */
    fps?: number;
    renderScale?: number;
    ping?: number;
    /** Browser user agent, graphics card string and page path (no query). */
    ua?: string;
    gpu?: string;
    path?: string;
}

/**
 * A feedback note typed by the player, or an automatic error report. Never carries chat or the player's
 * name: the server attaches the room, map, team, player id and the name it already holds. `stack` is
 * only for errors.
 */
export interface ReportMsg { type: 'report'; kind: 'feedback' | 'error'; text: string; stack?: string; ctx: ReportCtx }

/** Caps in characters (code points). A report frame is at most REPORT_MAX_BYTES bytes in UTF-8. */
export const FEEDBACK_MAX_CHARS = 500;
export const ERROR_MAX_CHARS = 300;
export const STACK_MAX_CHARS = 1500;
export const REPORT_UA_MAX_CHARS = 200;
export const REPORT_GPU_MAX_CHARS = 200;
export const REPORT_PATH_MAX_CHARS = 100;
export const REPORT_MAX_BYTES = 4096;

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
/** Size of one binary command, its tag byte included. */
export const CMD_BYTES = 26;
/**
 * Self state up to the loadout, then 6 loadout bytes (slot, previous, draw, aim, trigger, sight), 7 per gun, 2 for the defender knife, 2 for the
 * ghost knife, 1 for the bomb repick wait (the carrier flag is a bit of the flags byte), 1 player count.
 */
const SNAP_LOADOUT = 76;
const SNAP_GUNS = SNAP_LOADOUT + 6;
const SNAP_MELEE = SNAP_GUNS + 7 * GUN_COUNT;
const SNAP_KNIFE = SNAP_MELEE + 2;
const SNAP_CARRY = SNAP_KNIFE + 2;
const SNAP_SPECTATE = SNAP_CARRY + 1;
const SNAP_COUNT = SNAP_SPECTATE + 2;
const SNAP_HEAD_BYTES = SNAP_COUNT + 1;
const SNAP_PLAYER_BYTES = 20;
const ANGLE_SCALE = 32767 / Math.PI;

export type Wire = string | Uint8Array<ArrayBuffer>;

const unit = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function encodeCmd(c: NetCmd): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(CMD_BYTES);
    writeCmd(new DataView(out.buffer), 0, c);
    return out;
}

/**
 * Writes one command in the wire format (CMD_BYTES bytes, tag included) at `offset`. The same bytes the
 * client sends; also how the server's input recordings store a command (server/src/recording.ts).
 */
export function writeCmd(v: DataView, offset: number, c: NetCmd): void {
    v.setUint8(offset, CMD_TAG);
    v.setUint32(offset + 1, c.seq, true);
    v.setInt8(offset + 5, Math.round(c.forward * 127));
    v.setInt8(offset + 6, Math.round(c.right * 127));
    v.setFloat32(offset + 7, c.yaw, true);
    v.setFloat32(offset + 11, c.pitch, true);
    v.setUint8(offset + 15, (c.jump ? 1 : 0) | (c.walk ? 2 : 0) | (c.crouch ? 4 : 0) | (c.fire ? 8 : 0) | (c.use ? 16 : 0) |
        (c.reload ? 32 : 0) | (c.swap ? 64 : 0) | (c.aim ? 128 : 0));
    v.setFloat64(offset + 16, c.viewTime, true);
    v.setUint8(offset + 24, c.slot);
    v.setUint8(offset + 25, (c.drop ? 1 : 0) | (c.observerOnly ? 2 : 0));
}

/** Reads one command written by `writeCmd` (or sent by a client) at `offset`. */
export function readCmd(v: DataView, offset = 0): NetCmd {
    const flags = v.getUint8(offset + 15);
    return {
        seq: v.getUint32(offset + 1, true),
        forward: v.getInt8(offset + 5) / 127,
        right: v.getInt8(offset + 6) / 127,
        yaw: v.getFloat32(offset + 7, true),
        pitch: v.getFloat32(offset + 11, true),
        jump: (flags & 1) !== 0, walk: (flags & 2) !== 0, crouch: (flags & 4) !== 0,
        fire: (flags & 8) !== 0, use: (flags & 16) !== 0, reload: (flags & 32) !== 0,
        swap: (flags & 64) !== 0, aim: (flags & 128) !== 0,
        viewTime: v.getFloat64(offset + 16, true),
        slot: v.getUint8(offset + 24),
        drop: (v.getUint8(offset + 25) & 1) !== 0,
        ...((v.getUint8(offset + 25) & 2) ? { observerOnly: true } : {})
    };
}

function encodeSnap(m: Extract<ServerMsg, { type: 'snap' }>): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(SNAP_HEAD_BYTES + m.players.length * SNAP_PLAYER_BYTES);
    const v = new DataView(out.buffer);
    const me = m.me;
    v.setUint8(0, SNAP_TAG);
    v.setFloat64(1, m.time, true);
    v.setInt32(9, m.ack, true);
    v.setUint8(13, (me.team === 'ghosts' ? 1 : 0) | (me.onGround ? 2 : 0) | (me.crouched ? 4 : 0) | (me.alive ? 8 : 0) |
        (me.carry.carrier ? 16 : 0));
    v.setUint8(14, me.health);
    v.setUint8(15, me.armor);
    v.setUint16(16, Math.min(65535, me.actionTicks), true);
    v.setUint16(18, Math.round(unit(me.vis) * 65535), true);
    for (let k = 0; k < 3; k++) {
        v.setFloat64(20 + k * 8, me.pos[k], true);
        v.setFloat64(44 + k * 8, me.vel[k], true);
    }
    v.setFloat64(68, me.respawnAt, true);
    const l = me.loadout;
    v.setUint8(SNAP_LOADOUT, l.slot);
    v.setUint8(SNAP_LOADOUT + 1, l.prev);
    v.setUint8(SNAP_LOADOUT + 2, l.draw);
    v.setUint8(SNAP_LOADOUT + 3, l.aim);
    v.setUint8(SNAP_LOADOUT + 4, l.trigger);
    v.setUint8(SNAP_LOADOUT + 5, l.sight);
    for (let i = 0; i < GUN_COUNT; i++) {
        const g = l.guns[i], o = SNAP_GUNS + 7 * i;
        v.setUint8(o, g.mag);
        v.setUint8(o + 1, g.reserve);
        v.setUint8(o + 2, g.reload);
        v.setUint8(o + 3, g.cooldown);
        v.setUint8(o + 4, g.burst);
        v.setUint8(o + 5, g.sinceShot);
        v.setUint8(o + 6, g.shots);
    }
    v.setUint8(SNAP_MELEE, l.knife.cooldown);
    v.setUint8(SNAP_MELEE + 1, l.knife.windup);
    v.setUint8(SNAP_KNIFE, me.knife.cooldown);
    v.setUint8(SNAP_KNIFE + 1, me.knife.windup);
    v.setUint8(SNAP_CARRY, me.carry.wait);
    v.setUint16(SNAP_SPECTATE, me.spectateId, true);
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
    for (let i = 0; i < GUN_COUNT; i++) {
        const o = SNAP_GUNS + 7 * i;
        guns.push({
            mag: v.getUint8(o), reserve: v.getUint8(o + 1), reload: v.getUint8(o + 2), cooldown: v.getUint8(o + 3),
            burst: v.getUint8(o + 4), sinceShot: v.getUint8(o + 5), shots: v.getUint8(o + 6)
        });
    }
    return {
        slot: v.getUint8(SNAP_LOADOUT), prev: v.getUint8(SNAP_LOADOUT + 1), draw: v.getUint8(SNAP_LOADOUT + 2),
        aim: v.getUint8(SNAP_LOADOUT + 3), trigger: v.getUint8(SNAP_LOADOUT + 4), sight: v.getUint8(SNAP_LOADOUT + 5), guns,
        knife: { cooldown: v.getUint8(SNAP_MELEE), windup: v.getUint8(SNAP_MELEE + 1) }
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
            armor: v.getUint8(15),
            actionTicks: v.getUint16(16, true),
            vis: v.getUint16(18, true) / 65535,
            pos: [v.getFloat64(20, true), v.getFloat64(28, true), v.getFloat64(36, true)],
            vel: [v.getFloat64(44, true), v.getFloat64(52, true), v.getFloat64(60, true)],
            respawnAt: v.getFloat64(68, true),
            spectateId: v.getUint16(SNAP_SPECTATE, true),
            loadout: decodeLoadout(v),
            knife: { cooldown: v.getUint8(SNAP_KNIFE), windup: v.getUint8(SNAP_KNIFE + 1) },
            carry: { carrier: (flags & 16) !== 0, wait: v.getUint8(SNAP_CARRY) }
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
    return m.type === 'cmd' ? encodeCmd(m.cmd) : JSON.stringify(m);
}

/** Throws on anything that is not a well-formed message: the server treats that as "ignore". */
export function decodeClient(data: ArrayBuffer | Uint8Array | string): ClientMsg {
    if (typeof data === 'string') {
        if (data.length > REPORT_MAX_BYTES) throw new Error('message too long');
        const m = JSON.parse(data) as Record<string, unknown>;
        if (m.type !== 'report' && data.length > 600) throw new Error('message too long');
        switch (m.type) {
            case 'ready': return { type: 'ready', ready: m.ready === true };
            case 'start': return { type: 'start' };
            case 'team': return { type: 'team' };
            case 'chat':
                if (typeof m.text !== 'string') throw new Error('bad chat');
                return { type: 'chat', team: m.team === true, text: m.text };
            case 'options':
                if (typeof m.options !== 'object' || m.options === null || Array.isArray(m.options)) throw new Error('bad options');
                return { type: 'options', options: m.options as Partial<Record<keyof RoomOptions, unknown>> };
            case 'votekick':
                if (!Number.isInteger(m.target)) throw new Error('bad vote');
                return { type: 'votekick', target: m.target as number };
            case 'removeplayer':
                if (!Number.isInteger(m.target)) throw new Error('bad removal');
                return { type: 'removeplayer', target: m.target as number };
            case 'votecast': return { type: 'votecast', yes: m.yes === true };
            case 'mapvote':
                if (typeof m.map !== 'string' || m.map.length > 40) throw new Error('bad map vote');
                return { type: 'mapvote', map: m.map };
            case 'spectate':
                if (typeof m.target !== 'number' || !Number.isSafeInteger(m.target) || m.target <= 0) throw new Error('bad spectator target');
                return { type: 'spectate', target: m.target as number };
            case 'sight':
                if (!Number.isInteger(m.sight) || (m.sight as number) < 0 || (m.sight as number) >= SIGHT_COUNT) throw new Error('bad sight');
                return { type: 'sight', sight: m.sight as number };
            case 'report': {
                // Shape only; the server cleans and caps every field (server/src/reports.ts).
                if ((m.kind !== 'feedback' && m.kind !== 'error') || typeof m.text !== 'string') throw new Error('bad report');
                if (typeof m.ctx !== 'object' || m.ctx === null || Array.isArray(m.ctx)) throw new Error('bad report');
                const msg: ReportMsg = { type: 'report', kind: m.kind, text: m.text, ctx: m.ctx as ReportCtx };
                if (typeof m.stack === 'string') msg.stack = m.stack;
                return msg;
            }
            default: throw new Error('unknown client message');
        }
    }
    const v = view(data);
    if (v.byteLength !== CMD_BYTES || v.getUint8(0) !== CMD_TAG) throw new Error('unknown client message');
    return { type: 'cmd', cmd: readCmd(v) };
}
