/**
 * Package W: runs a recorded match again through the real `Game` (the same shared rules and the same
 * server code) and checks every checkpoint. Used by `tools/replay.ts` and the tests.
 *
 * How: a fresh `Game` on the recorded map with the recorded options gets the recorded players with their
 * recorded ids (spare ids are used up by short-lived placeholder bots so the next ids match), each bot's
 * mind replaced by one that plays back its recorded commands. Then the records are fed in order: each TICK
 * runs `Game.tick(now)` with the bots' commands of that tick queued, each person's command goes to
 * `Game.handleCmd`, joins, leaves and lobby messages go where `Rooms` and the socket would send them, and
 * each CHECK is compared with the replayed game. Bots the room's fill option adds or removes during the
 * match are added and removed by the replayed `Game` itself (the same rule), and get a playback mind too.
 */
import { gunzipSync, constants as zc } from 'node:zlib';
import { CMD_BYTES, readCmd, type NetCmd, type Team } from '../../shared/protocol';
import { cleanRoomOptions, DEFAULT_ROOM_OPTIONS } from '../../shared/room-options';
import type { MapData } from '../../shared/types';
import type { BotBrain } from './bots';
import { Game, type Player } from './game';
import type { GameObserver } from './game-events';
import { cleanName } from './namefilter';
import {
    CMDX_BYTES, PHASES, REC_MAGIC, TAG_CHECK, TAG_CMD, TAG_CMDX, TAG_EVENT, TAG_TICK, mapHash, readCmdX, stateHash,
    type RecEvent, type RecordingHeader
} from './recording';

export type Rec =
    | { t: 'tick'; now: number }
    | { t: 'cmd'; id: number; cmd: NetCmd }
    | { t: 'event'; ev: RecEvent }
    | { t: 'check'; phase: number; rounds: number; score: [number, number]; carrier: number; players: CheckPlayer[] };

export interface CheckPlayer { id: number; flags: number; pos: [number, number, number]; health: number; armor: number; hash: number }

export interface ParsedRecording {
    header: RecordingHeader;
    records: Rec[];
    /** The file ended without its closing event (the server stopped, or the file is cut short). */
    truncated: boolean;
    rawBytes: number;
}

/** Unzips (tolerating a cut-off end) and reads a recording. */
export function parseRecording(file: Uint8Array): ParsedRecording {
    const raw = gunzipSync(file, { finishFlush: zc.Z_SYNC_FLUSH });
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const dec = new TextDecoder();
    if (dec.decode(raw.subarray(0, REC_MAGIC.length)) !== REC_MAGIC) throw new Error('not a Stillblade recording');
    const hlen = v.getUint32(REC_MAGIC.length, true);
    let o = REC_MAGIC.length + 4;
    const header = JSON.parse(dec.decode(raw.subarray(o, o + hlen))) as RecordingHeader;
    o += hlen;
    const records: Rec[] = [];
    let ended = false;
    while (o < raw.length) {
        const tag = v.getUint8(o);
        if (tag === TAG_TICK) { if (o + 9 > raw.length) break; records.push({ t: 'tick', now: v.getFloat64(o + 1, true) }); o += 9; }
        else if (tag === TAG_CMD) {
            if (o + 3 + CMD_BYTES > raw.length) break;
            records.push({ t: 'cmd', id: v.getUint16(o + 1, true), cmd: readCmd(v, o + 3) });
            o += 3 + CMD_BYTES;
        } else if (tag === TAG_CMDX) {
            if (o + 3 + CMDX_BYTES > raw.length) break;
            records.push({ t: 'cmd', id: v.getUint16(o + 1, true), cmd: readCmdX(v, o + 3) });
            o += 3 + CMDX_BYTES;
        } else if (tag === TAG_EVENT) {
            const n = o + 3 <= raw.length ? v.getUint16(o + 1, true) : Infinity;
            if (o + 3 + n > raw.length) break;
            const ev = JSON.parse(dec.decode(raw.subarray(o + 3, o + 3 + n))) as RecEvent;
            records.push({ t: 'event', ev });
            if (ev.e === 'end') ended = true;
            o += 3 + n;
        } else if (tag === TAG_CHECK) {
            if (o + 10 > raw.length) break;
            const n = v.getUint16(o + 8, true);
            if (o + 10 + n * 47 > raw.length) break;
            const players: CheckPlayer[] = [];
            let q = o + 10;
            for (let i = 0; i < n; i++, q += 47) {
                players.push({
                    id: v.getUint16(q, true), flags: v.getUint8(q + 2),
                    pos: [v.getFloat64(q + 3, true), v.getFloat64(q + 11, true), v.getFloat64(q + 19, true)],
                    health: v.getFloat64(q + 27, true), armor: v.getFloat64(q + 35, true), hash: v.getUint32(q + 43, true)
                });
            }
            records.push({
                t: 'check', phase: v.getUint8(o + 1), rounds: v.getUint16(o + 2, true),
                score: [v.getUint8(o + 4), v.getUint8(o + 5)], carrier: v.getUint16(o + 6, true), players
            });
            o = q;
        } else throw new Error(`unknown record ${tag} at byte ${o}`);
    }
    return { header, records, truncated: !ended, rawBytes: raw.length };
}

export interface ReplayResult {
    header: RecordingHeader;
    checkpoints: number;
    ticks: number;
    commands: number;
    truncated: boolean;
    /** The first disagreement, or null when every checkpoint matched. */
    mismatch: null | { checkpoint: number; now: number; detail: string };
    /** Round results the replay produced, beside the recorded ones. */
    rounds: { recorded: string[]; replayed: string[] };
}

/** A bot mind that plays back recorded commands (one per tick, queued before each tick). */
class Playback {
    readonly queue: NetCmd[] = [];
    /** Returned when nothing was recorded for a tick: `handleCmd` ignores it without side effects (NaN order number). */
    private static readonly NONE: NetCmd = {
        seq: NaN, forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, walk: false, crouch: false, fire: false, use: false,
        reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: 0
    };
    think(): NetCmd { return this.queue.shift() ?? Playback.NONE; }
}

const silent = { send(): void { /* the replay has no players to tell */ } };

/** Replays `file` against `maps` (every installed map, by id). */
export function replayRecording(file: Uint8Array, maps: ReadonlyMap<string, MapData>): ReplayResult {
    return replayParsed(parseRecording(file), maps);
}

/** Replays an already parsed recording (tests change records to prove a difference is caught). */
export function replayParsed({ header, records, truncated }: ParsedRecording, maps: ReadonlyMap<string, MapData>): ReplayResult {
    const map = maps.get(header.map);
    if (!map) throw new Error(`the recording is on map "${header.map}", which is not installed`);
    if (mapHash(map) !== header.mapHash) throw new Error(`map "${header.map}" has changed since this recording was made (its boxes, spawns or sites differ)`);

    const playback = new Map<number, Playback>();
    const give = (p: Player): void => {
        if (!p.bot || playback.has(p.id)) return;
        const pb = new Playback();
        playback.set(p.id, pb);
        p.brain = pb as unknown as BotBrain;
    };
    const replayed: string[] = [];
    /** The id the replayed game gives next (it numbers players itself, bots it adds included). */
    let nextId = 1;
    const obs: GameObserver = {
        join: (_g, p) => { give(p); if (p.id >= nextId) nextId = p.id + 1; },
        roundEnd: (g, winner, reason) => { replayed.push(`${winner} ${reason} ${g.score[0]}:${g.score[1]}`); }
    };
    const options = cleanRoomOptions({ ...header.options }, DEFAULT_ROOM_OPTIONS);
    // Lobby off: the match starts on the first tick, as it did (everyone was ready or the creator started it).
    // Filling off while the recorded players are put back; the recorded options are restored afterwards.
    const game = new Game(map, { lobby: false, options: { ...options, fillBots: false } });
    game.code = header.room;
    game.now = header.startNow;
    game.observer = obs;
    const burnTo = (id: number): void => {
        while (nextId < id) {
            const spare = game.join(silent, 'spare', { team: 'ghosts', brain: new Playback() as unknown as BotBrain });
            game.leave(spare);
            playback.delete(spare);
        }
    };
    const placeIn = (hp: RecordingHeader['players'][number] | Extract<RecEvent, { e: 'join' }>, team: Team): Player => {
        const id = hp.bot
            ? game.join(silent, hp.name, { team, brain: new Playback() as unknown as BotBrain })
            : game.join(silent, cleanName(hp.base || hp.name) || 'player', { team, sight: hp.sight });
        if (id !== hp.id) throw new Error(`replay gave player ${hp.name} id ${id}, recorded ${hp.id}`);
        const p = game.players.get(id)!;
        (p as { name: string }).name = hp.name; // the name the filter and numbering chose then
        p.baseName = hp.base;
        p.sightPending = hp.sight;
        give(p);
        return p;
    };
    for (const hp of header.players) {
        burnTo(hp.id);
        const p = placeIn(hp, hp.team);
        p.group = hp.side;
        p.team = hp.team;
        p.joinedAt = hp.joinedAt;
        p.idle = hp.idle;
        if (hp.lastCmd) p.inputChanged(hp.lastCmd);
        if (hp.state) {
            p.alive = hp.state.alive;
            p.state.pos = [...hp.state.pos];
            p.state.vel = [...hp.state.vel];
            p.state.onGround = hp.state.onGround;
            p.state.crouched = hp.state.crouched;
            p.health = hp.state.health;
            p.armor = hp.state.armor;
            p.respawnAt = 0;
        }
    }
    burnTo(header.nextId);
    // Set only now: a person's join runs the fill rule, which (switched off here) would remove fill bots.
    for (const hp of header.players) game.players.get(hp.id)!.filler = hp.filler;
    game.options = options;

    const recordedRounds: string[] = [];
    let checkpoints = 0, ticks = 0, commands = 0;
    let mismatch: ReplayResult['mismatch'] = null;
    const isBot = (id: number): boolean => game.players.get(id)?.bot === true || playback.has(id);

    for (let i = 0; i < records.length && !mismatch; i++) {
        const r = records[i];
        if (r.t === 'tick') {
            // The bots' commands of this tick are the bot commands that follow, up to the first record that
            // can only come between ticks (a person's command, a join or leave, a lobby message, the next tick).
            for (let j = i + 1; j < records.length; j++) {
                const q = records[j];
                if (q.t === 'tick') break;
                if (q.t === 'cmd') {
                    if (!isBot(q.id)) break;
                    playback.get(q.id)?.queue.push(q.cmd);
                } else if (q.t === 'event' && (q.ev.e === 'msg' || (q.ev.e === 'join' && !q.ev.bot) || (q.ev.e === 'leave' && !isBot(q.ev.id)))) break;
            }
            game.tick(r.now);
            ticks++;
            for (const pb of playback.values()) pb.queue.length = 0;
        } else if (r.t === 'cmd') {
            commands++;
            if (isBot(r.id)) continue; // already played during its tick
            game.handleCmd(r.id, r.cmd);
        } else if (r.t === 'event') {
            const ev = r.ev;
            if (ev.e === 'join' && !ev.bot) {
                burnTo(ev.id);
                // A person joins the smaller team unless returning; the recorded side is the result, so give it.
                placeIn(ev, ev.team).filler = ev.filler;
            } else if (ev.e === 'leave' && !isBot(ev.id)) game.leave(ev.id); // a kick has already removed them: then nothing happens
            else if (ev.e === 'msg') game.handleMessage(ev.id, ev.m);
            else if (ev.e === 'roundEnd') recordedRounds.push(`${ev.winner} ${ev.reason} ${ev.score[0]}:${ev.score[1]}`);
        } else {
            checkpoints++;
            const why = compare(game, r);
            if (why) mismatch = { checkpoint: checkpoints, now: game.now, detail: why };
        }
    }
    return { header, checkpoints, ticks, commands, truncated, mismatch, rounds: { recorded: recordedRounds, replayed } };
}

/** What differs between the replayed game and a checkpoint, or '' when nothing does. */
function compare(game: Game, c: Extract<Rec, { t: 'check' }>): string {
    const out: string[] = [];
    if (PHASES[c.phase] !== game.phase) out.push(`phase ${game.phase}, recorded ${PHASES[c.phase]}`);
    if (c.rounds !== game.roundsPlayed) out.push(`rounds played ${game.roundsPlayed}, recorded ${c.rounds}`);
    if (c.score[0] !== game.score[0] || c.score[1] !== game.score[1]) out.push(`score ${game.score.join(':')}, recorded ${c.score.join(':')}`);
    if (c.carrier !== game.carrierId) out.push(`bomb carrier ${game.carrierId}, recorded ${c.carrier}`);
    if (c.players.length !== game.players.size) out.push(`${game.players.size} players, recorded ${c.players.length}`);
    for (const cp of c.players) {
        const p = game.players.get(cp.id);
        if (!p) { out.push(`player ${cp.id} missing`); continue; }
        const flags = (p.alive ? 1 : 0) | (p.state.onGround ? 2 : 0) | (p.state.crouched ? 4 : 0) | (p.team === 'ghosts' ? 8 : 0);
        const tag = `player ${cp.id} (${p.name})`;
        if (flags !== cp.flags) out.push(`${tag} flags ${flags}, recorded ${cp.flags}`);
        if (p.state.pos[0] !== cp.pos[0] || p.state.pos[1] !== cp.pos[1] || p.state.pos[2] !== cp.pos[2]) {
            out.push(`${tag} at ${p.state.pos.map(n => n.toFixed(4)).join(', ')}, recorded ${cp.pos.map(n => n.toFixed(4)).join(', ')}`);
        }
        if (p.health !== cp.health) out.push(`${tag} health ${p.health}, recorded ${cp.health}`);
        if (p.armor !== cp.armor) out.push(`${tag} armor ${p.armor}, recorded ${cp.armor}`);
        if (stateHash(p) !== cp.hash) out.push(`${tag} weapon state differs`);
    }
    return out.join('; ');
}
