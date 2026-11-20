/**
 * Package W: input recordings. One gzip file per match (`recordings/<date>-<room>-<n>.sbrec.gz`), holding
 * everything the server's `Game` was given from outside during the match, so `server/src/replay.ts` can run
 * the same match again through the same code and check that it comes out the same.
 *
 * File layout (inside the gzip):
 *
 *   "SBREC1\n"                    7 bytes, the format
 *   u32 n, then n bytes           the header, JSON (`RecordingHeader`)
 *   records until the end         one tag byte each, then:
 *     TICK   f64 now               `Game.tick(now)` began
 *     CMD    u16 id, 26 bytes      a processed command, in the wire format of shared/protocol.ts (`writeCmd`)
 *     CMDX   u16 id, 51 bytes      the same, with every number as float64: for commands the wire format
 *                                  cannot hold exactly (the server's bots compute theirs at full precision;
 *                                  a real client's always fit the wire format, which is how they arrived)
 *     EVENT  u16 n, n bytes JSON   joins, leaves, lobby messages (never chat), spawns, deaths, round events
 *     CHECK  u8 phase, u16 rounds, u8 score0, u8 score1, u16 carrier, u16 count, then per player:
 *            u16 id, u8 flags (alive 1, onGround 2, crouched 4, ghost 8), f64 x y z, f64 health, f64 armor,
 *            u32 loadout hash (`stateHash`: loadout, ghost knife, bomb carry)
 *
 * All numbers little-endian. Ticks run from the match start to its end (freeze, live, planted, the result
 * pause between rounds, and warmup while a match is held), not only the live part: commands in those
 * phases still move players and count down weapon timers, so the replay needs them.
 *
 * The recorder is a passive observer: it appends to one reused buffer inside the tick and hands a copy of it
 * to the data store (gzip in the thread pool, the file written asynchronously) at the end of a tick once it
 * is three quarters full.
 */
import { createHash } from 'node:crypto';
import { CMD_BYTES, PROTOCOL_VERSION, writeCmd, type ClientMsg, type DamageKind, type NetCmd, type Team } from '../../shared/protocol';
import { TICK_RATE } from '../../shared/constants';
import type { Phase, RoundReason } from '../../shared/rules';
import type { MapData, Vec3 } from '../../shared/types';
import type { HitZone } from '../../shared/zones';
import { dayOf, type RecordingSink } from './datastore';
import type { Game, Player } from './game';
import type { GameObserver } from './game-events';

export const REC_MAGIC = 'SBREC1\n';
export const REC_FORMAT = 1;
export const TAG_TICK = 1;
export const TAG_CMD = 2;
export const TAG_CMDX = 3;
export const TAG_EVENT = 4;
export const TAG_CHECK = 5;
/** Bytes of a CMDX body after the id. */
export const CMDX_BYTES = 51;
/** A checkpoint every this many ticks (one second). */
export const CHECK_EVERY = TICK_RATE;
export const PHASES: readonly Phase[] = ['warmup', 'freeze', 'live', 'planted', 'over'];

/** One player as the match began. */
export interface HeaderPlayer {
    id: number;
    name: string;
    /** The name the player asked for, cleaned (people only; '' for bots). */
    base: string;
    team: Team;
    side: 0 | 1;
    bot: boolean;
    /** Added by the room's fill option (only these come and go by themselves). */
    filler: boolean;
    joinedAt: number;
    idle: boolean;
    /** The sight the next spawn mounts. */
    sight: number;
    /** The last command processed for this player before the match began, if any (to continue the idle rule exactly). */
    lastCmd?: NetCmd;
    /** Only for a player sitting out (idle), who keeps where they were: */
    state?: { alive: boolean; pos: Vec3; vel: Vec3; onGround: boolean; crouched: boolean; health: number; armor: number };
}

export interface RecordingHeader {
    format: number;
    protocol: number;
    /** The server's git commit, when known (SB_COMMIT, or the checkout it runs from). */
    commit: string;
    /** Wall-clock start (ISO), for people. */
    started: string;
    room: string;
    map: string;
    /** sha256 of the map's collision boxes, spawns and sites: a rebuilt map cannot replay an old match. */
    mapHash: string;
    options: Record<string, unknown>;
    tickRate: number;
    /** The tick (`Game.now`) during which the match began; the first TICK record. */
    startNow: number;
    /** The id the next player to join gets. */
    nextId: number;
    players: HeaderPlayer[];
}

/** The events written as JSON. Kept small: only ids and game facts, never chat or addresses. */
export type RecEvent =
    | { e: 'join'; id: number; name: string; base: string; team: Team; side: 0 | 1; bot: boolean; filler: boolean; sight: number }
    | { e: 'leave'; id: number }
    | { e: 'msg'; id: number; m: ClientMsg }
    | { e: 'team'; id: number; team: Team }
    | { e: 'spawn'; id: number; team: Team; pos: Vec3; yaw: number; sight: number }
    | { e: 'death'; victim: number; killer: number; kind: DamageKind; weapon?: number; zone?: HitZone }
    | { e: 'round'; round: number; ghostSide: 0 | 1; carrier: number }
    | { e: 'phase'; phase: Phase }
    | { e: 'plant'; id: number; pos: Vec3 }
    | { e: 'defuse'; id: number }
    | { e: 'roundEnd'; winner: Team; reason: RoundReason; score: [number, number] }
    | { e: 'swap' }
    | { e: 'held' }
    | { e: 'end'; why: string; score: [number, number]; rounds: number };

/**
 * Messages a match in progress can act on (warmup ones count while a match is held). Chat and reports are
 * never recorded; nor are room options (refused once a match has begun, and free-form) or map votes (cast after
 * the match, when its recording has ended).
 */
const RECORDED_MESSAGES = new Set<ClientMsg['type']>(['ready', 'start', 'team', 'votekick', 'votecast', 'removeplayer', 'sight']);

export function mapHash(map: MapData): string {
    return createHash('sha256').update(JSON.stringify([map.boxes.map(b => [b.min, b.max]), map.spawns, map.bombSites])).digest('hex').slice(0, 16);
}

/** True when the wire format (`writeCmd`) holds `c` exactly, so decoding it gives back the very same command. */
export function fitsWire(c: NetCmd): boolean {
    return Number.isInteger(c.seq) && c.seq >= 0 && c.seq <= 0xffffffff &&
        Math.round(c.forward * 127) / 127 === c.forward && Math.round(c.right * 127) / 127 === c.right &&
        Math.abs(c.forward) <= 1 && Math.abs(c.right) <= 1 &&
        Math.fround(c.yaw) === c.yaw && Math.fround(c.pitch) === c.pitch &&
        Number.isInteger(c.slot) && c.slot >= 0 && c.slot <= 255 &&
        typeof c.jump === 'boolean' && typeof c.walk === 'boolean' && typeof c.crouch === 'boolean' && typeof c.fire === 'boolean' &&
        typeof c.use === 'boolean' && typeof c.reload === 'boolean' && typeof c.swap === 'boolean' && typeof c.aim === 'boolean' &&
        typeof c.drop === 'boolean';
}

const cmdFlags = (c: NetCmd): number => (c.jump ? 1 : 0) | (c.walk ? 2 : 0) | (c.crouch ? 4 : 0) | (c.fire ? 8 : 0) | (c.use ? 16 : 0) |
    (c.reload ? 32 : 0) | (c.swap ? 64 : 0) | (c.aim ? 128 : 0);

/** Writes a CMDX body (after the id) at `o`. */
export function writeCmdX(v: DataView, o: number, c: NetCmd): void {
    v.setFloat64(o, c.seq, true);
    v.setFloat64(o + 8, c.forward, true);
    v.setFloat64(o + 16, c.right, true);
    v.setFloat64(o + 24, c.yaw, true);
    v.setFloat64(o + 32, c.pitch, true);
    v.setUint8(o + 40, cmdFlags(c));
    v.setFloat64(o + 41, c.viewTime, true);
    // Slots the game would treat as "none" (not an integer) are stored as 0, which it treats the same.
    v.setInt8(o + 49, Number.isInteger(c.slot) && c.slot >= -128 && c.slot <= 127 ? c.slot : c.slot > 127 ? 127 : 0);
    v.setUint8(o + 50, c.drop ? 1 : 0);
}

export function readCmdX(v: DataView, o: number): NetCmd {
    const f = v.getUint8(o + 40);
    return {
        seq: v.getFloat64(o, true), forward: v.getFloat64(o + 8, true), right: v.getFloat64(o + 16, true),
        yaw: v.getFloat64(o + 24, true), pitch: v.getFloat64(o + 32, true),
        jump: (f & 1) !== 0, walk: (f & 2) !== 0, crouch: (f & 4) !== 0, fire: (f & 8) !== 0, use: (f & 16) !== 0,
        reload: (f & 32) !== 0, swap: (f & 64) !== 0, aim: (f & 128) !== 0,
        viewTime: v.getFloat64(o + 41, true), slot: v.getInt8(o + 49), drop: v.getUint8(o + 50) !== 0
    };
}

/**
 * A 32-bit FNV-1a hash of everything a player's weapons and bomb carry hold (every number and flag, in
 * the objects' own field order, which the shared factories fix). Equal hashes: the same weapon state.
 */
export function stateHash(p: Player): number {
    let h = 0x811c9dc5;
    const mix = (n: number): void => {
        // Integers (all counters are) mix exactly; anything else by its float64 bits.
        if (Number.isInteger(n) && Math.abs(n) < 2 ** 31) {
            h = Math.imul(h ^ (n & 0xffff), 16777619);
            h = Math.imul(h ^ ((n >>> 16) & 0xffff), 16777619);
        } else {
            scratch.setFloat64(0, n);
            for (let i = 0; i < 8; i++) h = Math.imul(h ^ scratch.getUint8(i), 16777619);
        }
    };
    const walk = (o: unknown): void => {
        if (typeof o === 'number') mix(o);
        else if (typeof o === 'boolean') mix(o ? 1 : 0);
        else if (Array.isArray(o)) { mix(o.length); for (const x of o) walk(x); }
        else if (o && typeof o === 'object') for (const k in o) walk((o as Record<string, unknown>)[k]);
    };
    walk(p.loadout);
    walk(p.knife);
    walk(p.carry);
    return h >>> 0;
}
const scratch = new DataView(new ArrayBuffer(8));

/** The git commit for the header: SB_COMMIT, else what `git` says in the folder the server runs from (asked once). */
export function commitFromEnv(env: NodeJS.ProcessEnv = process.env, git: () => string = () => ''): string {
    return (env.SB_COMMIT ?? '').trim() || git().trim();
}

const BUF_BYTES = 256 * 1024;

/**
 * Records every match in one room. `open(base)` starts a file (`<date>-<room>`, the data store adds `-<n>`
 * and the extension); null means "do not record".
 */
export class Recorder implements GameObserver {
    private readonly buf = new Uint8Array(BUF_BYTES);
    private readonly view = new DataView(this.buf.buffer);
    private used = 0;
    private sink: RecordingSink | null = null;
    private ticksSinceCheck = 0;
    /** Highest id ever seen in this room, for the next id at a match start. */
    private maxId = 0;
    /** The last command each player sent, kept (copied field by field, no allocation) for the next match's header. */
    private readonly lastCmd = new Map<number, NetCmd>();
    private readonly enc = new TextEncoder();
    /** The file of the match being recorded (or of the last one, until the next starts). */
    current: string | null = null;
    /** Bytes handed to the sink for the current recording (uncompressed). */
    rawBytes = 0;

    constructor(
        private readonly open: (base: string) => RecordingSink | null,
        private readonly commit: string = '',
        private readonly clock: () => number = () => Date.now()
    ) {}

    get recording(): boolean { return this.sink !== null; }

    // ---- low-level writing

    private room(n: number): void {
        if (this.used + n > this.buf.length) this.flush();
    }

    private flush(): void {
        if (!this.sink || this.used === 0) return;
        this.sink.write(this.buf.slice(0, this.used)); // a copy: the buffer is reused at once
        this.rawBytes += this.used;
        this.used = 0;
    }

    private writeBytes(bytes: Uint8Array): void {
        if (bytes.length > this.buf.length) { this.flush(); this.sink?.write(bytes.slice()); this.rawBytes += bytes.length; return; }
        this.room(bytes.length);
        this.buf.set(bytes, this.used);
        this.used += bytes.length;
    }

    private event(ev: RecEvent): void {
        if (!this.sink) return;
        const json = this.enc.encode(JSON.stringify(ev));
        this.room(3 + json.length);
        this.view.setUint8(this.used, TAG_EVENT);
        this.view.setUint16(this.used + 1, json.length, true);
        this.buf.set(json, this.used + 3);
        this.used += 3 + json.length;
    }

    // ---- observer

    join(game: Game, p: Player): void {
        if (p.id > this.maxId) this.maxId = p.id;
        this.event({ e: 'join', id: p.id, name: p.name, base: p.baseName, team: p.team, side: p.group, bot: p.bot, filler: p.filler, sight: p.sightPending });
        void game;
    }

    leave(_game: Game, p: Player): void {
        this.lastCmd.delete(p.id);
        this.event({ e: 'leave', id: p.id });
    }

    message(_game: Game, p: Player, msg: ClientMsg): void {
        if (!RECORDED_MESSAGES.has(msg.type)) return; // chat and reports never
        this.event({ e: 'msg', id: p.id, m: msg });
    }

    teamChange(_game: Game, p: Player): void {
        this.event({ e: 'team', id: p.id, team: p.team });
    }

    cmd(_game: Game, p: Player, c: NetCmd): void {
        // Kept for every player at all times (the next match's header needs the command before its start).
        let last = this.lastCmd.get(p.id);
        if (!last) this.lastCmd.set(p.id, last = { ...c });
        else Object.assign(last, c);
        if (!this.sink) return;
        const v = this.view;
        if (fitsWire(c)) {
            this.room(3 + CMD_BYTES);
            v.setUint8(this.used, TAG_CMD);
            v.setUint16(this.used + 1, p.id, true);
            writeCmd(v, this.used + 3, c);
            this.used += 3 + CMD_BYTES;
        } else {
            this.room(3 + CMDX_BYTES);
            v.setUint8(this.used, TAG_CMDX);
            v.setUint16(this.used + 1, p.id, true);
            writeCmdX(v, this.used + 3, c);
            this.used += 3 + CMDX_BYTES;
        }
    }

    tickStart(_game: Game, now: number): void {
        if (!this.sink) return;
        this.room(9);
        this.view.setUint8(this.used, TAG_TICK);
        this.view.setFloat64(this.used + 1, now, true);
        this.used += 9;
    }

    tickEnd(game: Game): void {
        if (!this.sink) return;
        if (++this.ticksSinceCheck >= CHECK_EVERY) { this.ticksSinceCheck = 0; this.checkpoint(game); }
        if (this.used >= (this.buf.length * 3) / 4) this.flush();
    }

    spawn(_game: Game, p: Player): void {
        this.event({ e: 'spawn', id: p.id, team: p.team, pos: [...p.state.pos] as Vec3, yaw: p.yaw, sight: p.loadout.sight });
    }

    kill(_game: Game, victim: Player, attacker: Player, kind: DamageKind, weapon?: number, zone?: HitZone): void {
        const ev: RecEvent = { e: 'death', victim: victim.id, killer: attacker.id, kind };
        if (weapon !== undefined) ev.weapon = weapon;
        if (zone !== undefined) ev.zone = zone;
        this.event(ev);
    }

    roundStart(game: Game): void {
        this.event({ e: 'round', round: game.roundsPlayed + 1, ghostSide: game.ghostGroup, carrier: game.carrierId });
    }

    phase(_game: Game, phase: Phase): void { this.event({ e: 'phase', phase }); }
    plant(_game: Game, p: Player, pos: Vec3): void { this.event({ e: 'plant', id: p.id, pos: [...pos] as Vec3 }); }
    defuse(_game: Game, p: Player): void { this.event({ e: 'defuse', id: p.id }); }
    sidesSwapped(): void { this.event({ e: 'swap' }); }
    matchHeld(): void { this.event({ e: 'held' }); }

    roundEnd(game: Game, winner: Team, reason: RoundReason): void {
        this.event({ e: 'roundEnd', winner, reason, score: [game.score[0], game.score[1]] });
    }

    matchStart(game: Game): void {
        if (this.sink) this.finish(game, 'replaced'); // cannot happen (a match ends first), but never leak a file
        const sink = this.open(`${dayOf(this.clock())}-${game.code || 'room'}`);
        if (!sink) { this.current = null; return; }
        this.sink = sink;
        this.used = 0;
        this.rawBytes = 0;
        this.ticksSinceCheck = 0;
        const players: HeaderPlayer[] = [];
        for (const p of game.players.values()) {
            const hp: HeaderPlayer = {
                id: p.id, name: p.name, base: p.baseName, team: p.team, side: p.group, bot: p.bot, filler: p.filler,
                joinedAt: p.joinedAt, idle: p.idle, sight: p.sightPending
            };
            const last = this.lastCmd.get(p.id);
            if (last) hp.lastCmd = { ...last };
            if (p.idle) {
                hp.state = {
                    alive: p.alive, pos: [...p.state.pos] as Vec3, vel: [...p.state.vel] as Vec3, onGround: p.state.onGround,
                    crouched: p.state.crouched, health: p.health, armor: p.armor
                };
            }
            players.push(hp);
        }
        const header: RecordingHeader = {
            format: REC_FORMAT, protocol: PROTOCOL_VERSION, commit: this.commit, started: new Date(this.clock()).toISOString(),
            room: game.code, map: game.map.name, mapHash: mapHash(game.map), options: { ...game.options }, tickRate: TICK_RATE,
            startNow: game.now, nextId: this.maxId + 1, players
        };
        const json = this.enc.encode(JSON.stringify(header));
        const head = new Uint8Array(REC_MAGIC.length + 4 + json.length);
        head.set(this.enc.encode(REC_MAGIC), 0);
        new DataView(head.buffer).setUint32(REC_MAGIC.length, json.length, true);
        head.set(json, REC_MAGIC.length + 4);
        this.writeBytes(head);
        // The match began inside this tick: replays start by running it.
        this.tickStart(game, game.now);
        this.current = sink.name;
    }

    matchEnd(game: Game): void { this.finish(game, 'match over'); }

    matchAbandoned(game: Game, why: string): void { this.finish(game, why); }

    private finish(game: Game, why: string): void {
        if (!this.sink) return;
        this.checkpoint(game);
        this.event({ e: 'end', why, score: [game.score[0], game.score[1]], rounds: game.roundsPlayed });
        this.flush();
        const sink = this.sink;
        this.sink = null;
        this.current = sink.name;
        void sink.end();
    }

    /** The checkpoint: game phase and score, then every player's position, health, armor and weapon state. */
    private checkpoint(game: Game): void {
        const n = game.players.size;
        this.room(1 + 8 + 2 + n * 47);
        const v = this.view;
        let o = this.used;
        v.setUint8(o, TAG_CHECK);
        v.setUint8(o + 1, PHASES.indexOf(game.phase));
        v.setUint16(o + 2, game.roundsPlayed, true);
        v.setUint8(o + 4, game.score[0]);
        v.setUint8(o + 5, game.score[1]);
        v.setUint16(o + 6, game.carrierId, true);
        v.setUint16(o + 8, n, true);
        o += 10;
        for (const p of game.players.values()) {
            v.setUint16(o, p.id, true);
            v.setUint8(o + 2, (p.alive ? 1 : 0) | (p.state.onGround ? 2 : 0) | (p.state.crouched ? 4 : 0) | (p.team === 'ghosts' ? 8 : 0));
            v.setFloat64(o + 3, p.state.pos[0], true);
            v.setFloat64(o + 11, p.state.pos[1], true);
            v.setFloat64(o + 19, p.state.pos[2], true);
            v.setFloat64(o + 27, p.health, true);
            v.setFloat64(o + 35, p.armor, true);
            v.setUint32(o + 43, stateHash(p), true);
            o += 47;
        }
        this.used = o;
    }
}
