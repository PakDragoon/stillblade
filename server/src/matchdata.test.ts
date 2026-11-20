/**
 * Package W: match records and input recordings. Two scripted matches:
 *  A. a test map, two scripted people: a plant that explodes, shots, a reload, knife swings, kills by gun and
 *     by knife, halftime, a match won 3:2;
 *  B. Test Map 1 through `Rooms`, the fill option keeping three a side with bots, a person joining after the
 *     first round and leaving mid-match, ended by everyone leaving.
 * Both are recorded and replayed through `Game`; every checkpoint must match.
 */
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EYE_HEIGHT, TICK_RATE } from '../../shared/constants';
import { type NetCmd, type ServerMsg } from '../../shared/protocol';
import { DEFAULT_ROOM_OPTIONS } from '../../shared/room-options';
import type { Box, MapData } from '../../shared/types';
import type { RecordingSink } from './datastore';
import { Game, type Connection, type Player } from './game';
import { loadMaps } from './maps';
import type { MatchLogLine, MatchRecord, RoundRecord, AbandonedRecord } from './matchlog';
import { parseRecording, replayParsed, replayRecording } from './replay';
import { roomObserver, type RoomDataStore } from './roomdata';
import { Rooms } from './rooms';

const TICK_MS = 1000 / TICK_RATE;
const SECRET_CHAT = 'secret-chat-xyz';
const SECRET_IP = '203.0.113.9';
const maps = loadMaps(fileURLToPath(new URL('../../client/public/maps', import.meta.url)));

/** Keeps lines and recordings in memory, as the data folder would keep them on disk. */
class MemoryStore implements RoomDataStore {
    readonly lines: MatchLogLine[] = [];
    readonly files = new Map<string, Uint8Array[]>();
    readonly ended = new Set<string>();
    readonly warnings: string[] = [];
    openRecording(base: string): RecordingSink {
        const name = `${base}-${this.files.size + 1}.sbrec.gz`;
        const chunks: Uint8Array[] = [];
        this.files.set(name, chunks);
        return { name, write: b => { chunks.push(b); }, end: async () => { this.ended.add(name); } };
    }
    appendMatchLine(_file: string, line: () => string): void { this.lines.push(JSON.parse(line()) as MatchLogLine); }
    warn(_kind: string, msg: string): void { this.warnings.push(msg); }
    /** A recording as the file on disk would hold it. */
    file(name: string): Uint8Array { return gzipSync(Buffer.concat(this.files.get(name)!)); }
    raw(name: string): Buffer { return Buffer.concat(this.files.get(name)!); }
}

function testMap(): MapData {
    const extra: Box[] = [];
    return {
        name: 'greybox', // a name the replay can look up: tests pass this map in the map table themselves
        bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
        boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }, ...extra],
        spawns: { ghosts: [{ pos: [0, 0, 10], yaw: 0 }], defenders: [{ pos: [0, 0, -10], yaw: 180 }] },
        bombSites: [{ name: 'A', min: [-3, 0, 7], max: [3, 2.5, 13] }]
    };
}

class Person {
    readonly inbox: ServerMsg[] = [];
    seq = 0;
    yaw = 0;
    id = 0;
    readonly conn: Connection;
    constructor() {
        this.conn = {
            ip: SECRET_IP,
            send: m => { if (m.type === 'spawn') this.yaw = m.yaw; this.inbox.push(structuredClone(m)); }
        };
    }
    cmd(game: Game, over: Partial<NetCmd>): void {
        // Like a real client: view angles rounded to float32 before sending.
        const c: NetCmd = {
            seq: ++this.seq, forward: 0, right: 0, yaw: this.yaw, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: game.now, ...over
        };
        c.yaw = Math.fround(c.yaw);
        c.pitch = Math.fround(c.pitch);
        game.handleCmd(this.id, c);
    }
}

const bearing = (from: number[], to: number[]): number => Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
/** Yaw and pitch from `me`'s eye to `target`'s chest. */
function aimAt(me: Player, target: Player): { yaw: number; pitch: number } {
    const a = me.state.pos, b = target.state.pos;
    const flat = Math.hypot(b[0] - a[0], b[2] - a[2]);
    return { yaw: bearing(a, b), pitch: Math.atan2(b[1] + 1.1 - (a[1] + EYE_HEIGHT), flat) };
}

interface RunA { store: MemoryStore | null; inboxes: ServerMsg[][]; game: Game; stats: { reloads: number; swings: number; plants: number } }

/** Scenario A. `withData` false runs it with no observer at all, to prove the observer changes nothing anyone receives. */
function runA(withData: boolean): RunA {
    const store = withData ? new MemoryStore() : null;
    const game = new Game(testMap(), { lobby: true, options: { roundsToWin: 3 } });
    game.code = 'test-a';
    if (store) game.observer = roomObserver(store, { record: true, commit: 'test' });
    const gina = new Person(), dan = new Person();
    gina.id = game.join(gina.conn, 'Gina');
    dan.id = game.join(dan.conn, 'Dan');
    const P = (x: Person): Player => game.players.get(x.id)!;
    const other = (x: Person): Person => (x === gina ? dan : gina);
    const stats = { reloads: 0, swings: 0, plants: 0 };
    let t = 0;
    let liveTick = 0;
    let lastPhase = game.phase;
    game.handleMessage(gina.id, { type: 'ready', ready: true });
    game.handleMessage(dan.id, { type: 'ready', ready: true });
    const wiggle = (x: Person): Partial<NetCmd> => ({ pitch: (x.seq % 2) * 0.01 });
    const behave = (x: Person): Partial<NetCmd> => {
        const me = P(x), them = P(other(x));
        if (!me.alive || (game.phase !== 'live' && game.phase !== 'planted')) return wiggle(x);
        const round = game.roundsPlayed + 1;
        const k = t - liveTick;
        if (me.team === 'ghosts') {
            if (round === 1) return { use: true };
            if (round === 3) { // run at the defender and knife it
                const aim = aimAt(me, them);
                const d = Math.hypot(them.state.pos[0] - me.state.pos[0], them.state.pos[2] - me.state.pos[2]);
                return d > 1.2 ? { yaw: aim.yaw, forward: 1 } : { yaw: aim.yaw, fire: true };
            }
            return wiggle(x);
        }
        if (round === 1) { // shots into the sky, a reload, then knife swings at nothing
            if (k < 20) return { fire: true, pitch: 0.6 };
            if (k === 30) { stats.reloads++; return { reload: true }; }
            if (k > 200 && k < 210) return { slot: 3 };
            if (k >= 240 && k < 420) { if (k % 42 === 0) stats.swings++; return { fire: true, pitch: 0.6 }; }
            return wiggle(x);
        }
        if (round === 3) return wiggle(x);
        return { ...aimAt(me, them), fire: true };
    };
    while (t < 60 * 60 * TICK_RATE) {
        game.tick(++t * TICK_MS);
        if (game.phase !== lastPhase) {
            if (game.phase === 'live') liveTick = t;
            if (game.phase === 'planted') stats.plants++;
            lastPhase = game.phase;
        }
        // The two people's commands arrive in a different order on even ticks, as sockets would deliver them.
        const order = t % 2 === 0 ? [gina, dan] : [dan, gina];
        for (const x of order) x.cmd(game, behave(x));
        if (game.roundsPlayed === 1 && game.phase === 'live' && t - liveTick === 50) {
            game.handleMessage(dan.id, { type: 'chat', team: false, text: SECRET_CHAT });
        }
        if (gina.inbox.some(m => m.type === 'summary')) break;
    }
    return { store, inboxes: [gina.inbox, dan.inbox], game, stats };
}

const mapsWithTest = (): Map<string, MapData> => new Map([['greybox', testMap()]]);

describe('package W: scenario A (a scripted match on a test map)', () => {
    const a = runA(true);
    const store = a.store!;
    const rounds = store.lines.filter((l): l is RoundRecord => l.type === 'round');
    const match = store.lines.find((l): l is MatchRecord => l.type === 'match');

    it('plays the scripted match to the end: a plant, a reload, knife swings, five rounds', () => {
        expect(a.stats.plants).toBe(1);
        expect(a.stats.reloads).toBe(1);
        expect(a.stats.swings).toBeGreaterThan(2);
        expect(a.game.roundsPlayed).toBe(5);
    });

    it('writes one line per round end with how it ended, the plant, the kills and every player', () => {
        expect(rounds.map(r => `${r.round} ${r.winner} ${r.reason}`)).toEqual([
            '1 ghosts exploded', '2 defenders eliminated', '3 ghosts eliminated', '4 defenders eliminated', '5 defenders eliminated'
        ]);
        const r1 = rounds[0];
        expect(r1.room).toBe('test-a');
        expect(r1.map).toBe('greybox');
        expect(r1.options.roundsToWin).toBe(3);
        expect(r1.plant).toMatchObject({ name: 'Gina', site: 'A' });
        expect(r1.plant!.at).toBeCloseTo(180 / 60, 1);
        expect(r1.seconds).toBeGreaterThan(35);
        expect(r1.kills).toEqual([]);
        expect(r1.players.map(p => `${p.name} ${p.team} ${p.alive}`)).toEqual(['Gina ghosts true', 'Dan defenders true']);
        const r2 = rounds[1];
        expect(r2.kills).toHaveLength(1);
        expect(r2.kills[0]).toMatchObject({ killerName: 'Dan', victimName: 'Gina', weapon: 'rifle', kind: 'shot', killerTeam: 'defenders' });
        expect(r2.kills[0].dist).toBeCloseTo(20, 0);
        // Health and armor removed: all 100 health and what the armor took on the way.
        const dealt = r2.players.find(p => p.name === 'Dan')!.damageDealt;
        expect(dealt).toBeGreaterThan(100);
        expect(r2.players.find(p => p.name === 'Gina')!.damageTaken).toBe(dealt);
        expect(r2.players.find(p => p.name === 'Gina')!.alive).toBe(false);
        // Halftime after round 2: Dan plays ghost in round 3 and knifes Gina.
        expect(rounds[2].ghostSide).toBe(1);
        expect(rounds[2].kills[0]).toMatchObject({ killerName: 'Dan', weapon: 'ghost knife' });
        expect(['knife', 'backstab']).toContain(rounds[2].kills[0].kind);
        expect(rounds[4].sideScore).toEqual([3, 2]);
    });

    it('writes the match line with the score, every player\'s statistics, the MVP and the recording', () => {
        expect(match).toBeDefined();
        expect(match!.rounds).toBe(5);
        expect(match!.sideScore).toEqual([3, 2]);
        expect(match!.winnerSide).toBe(0);
        expect(match!.players.map(p => p.name).sort()).toEqual(['Dan', 'Gina']);
        const gina = match!.players.find(p => p.name === 'Gina')!;
        expect(gina).toMatchObject({ kills: 2, plants: 1, bot: false });
        expect(match!.mvpName).not.toBe('');
        expect(match!.recording).toBe([...store.files.keys()][0]);
        expect(store.ended.has(match!.recording!)).toBe(true);
        expect(store.warnings).toEqual([]);
    });

    it('keeps no address and no chat text in the records or the recording', () => {
        const all = JSON.stringify(store.lines);
        expect(all).not.toContain(SECRET_IP);
        expect(all).not.toContain(SECRET_CHAT);
        expect(all).not.toMatch(/"ip"/);
        const raw = store.raw(match!.recording!).toString('latin1');
        expect(raw).not.toContain(SECRET_IP);
        expect(raw).not.toContain(SECRET_CHAT);
    });

    it('sends nobody anything different: every message is the same with and without the observer', () => {
        const bare = runA(false);
        expect(a.inboxes).toEqual(bare.inboxes);
        expect(a.game.roundsPlayed).toBe(bare.game.roundsPlayed);
    });

    it('replays the recording through Game with every checkpoint matching', () => {
        const res = replayRecording(store.file(match!.recording!), mapsWithTest());
        expect(res.mismatch).toBeNull();
        expect(res.truncated).toBe(false);
        expect(res.checkpoints).toBeGreaterThan(60);
        expect(res.rounds.replayed).toEqual(res.rounds.recorded);
        expect(res.rounds.recorded).toHaveLength(5);
        expect(res.header.players.map(p => p.name)).toEqual(['Gina', 'Dan']);
        expect(res.header.commit).toBe('test');
    });

    it('finds the first checkpoint that disagrees when one command is changed', () => {
        const parsed = parseRecording(store.file(match!.recording!));
        // Dan lets go of the trigger for his first round-2 shots: Gina is not hit when she was.
        const danId = parsed.header.players.find(p => p.name === 'Dan')!.id;
        const shots = parsed.records.filter(r => r.t === 'cmd' && r.id === danId && r.cmd.fire && r.cmd.pitch < 0.5).slice(0, 12);
        expect(shots).toHaveLength(12);
        for (const r of shots) if (r.t === 'cmd') r.cmd.fire = false;
        const res = replayParsed(parsed, mapsWithTest());
        expect(res.mismatch).not.toBeNull();
        expect(res.mismatch!.detail).toMatch(/health|armor|weapon|at /);
    });

    it('holds the header, the roster and the wire format of the commands', () => {
        const parsed = parseRecording(store.file(match!.recording!));
        expect(parsed.header.map).toBe('greybox');
        expect(parsed.header.tickRate).toBe(TICK_RATE);
        expect(parsed.header.players.every(p => !p.bot)).toBe(true);
        const cmds = parsed.records.filter(r => r.t === 'cmd');
        expect(cmds.length).toBeGreaterThan(1000);
        const events = parsed.records.filter(r => r.t === 'event').map(r => (r.t === 'event' ? r.ev.e : ''));
        for (const e of ['spawn', 'death', 'round', 'roundEnd', 'plant', 'swap', 'end']) expect(events).toContain(e);
        expect(gunzipSync(store.file(match!.recording!)).subarray(0, 7).toString()).toBe('SBREC1\n');
    });
});

describe('package W: scenario B (Test Map 1 through Rooms, with bots)', () => {
    const store = new MemoryStore();
    const rooms = new Rooms(maps, 'greybox', { maxRooms: 5, maxPlayersPerRoom: 10 }, () => roomObserver(store, { record: true, commit: '' }));
    const options = { ...DEFAULT_ROOM_OPTIONS, fillBots: true, maxPlayers: 6, roundsToWin: 3 };
    const people: Person[] = [];
    const join = (name: string): Person => {
        const x = new Person();
        const r = rooms.join('room-b', 'greybox', x.conn, name, 0, options);
        if (!r.ok) throw new Error(r.reason);
        x.id = r.id;
        people.push(x);
        return x;
    };
    const ann = join('Ann'), bob = join('Bob');
    const game = rooms.rooms.get('room-b')!;
    game.handleMessage(ann.id, { type: 'ready', ready: true });
    game.handleMessage(bob.id, { type: 'ready', ready: true });
    let t = 0;
    let cy: Person | null = null;
    let cyLeftAt = 0;
    let plants = 0, reloads = 0, kills = 0;
    let last = game.phase;
    while (t < 40 * 60 * TICK_RATE) {
        rooms.tick(++t * TICK_MS);
        if (game.phase !== last) { if (game.phase === 'planted') plants++; last = game.phase; }
        if (!cy && game.roundsPlayed === 1 && game.phase === 'over') cy = join('Cy');
        if (cy && game.roundsPlayed === 2 && game.phase === 'live' && game.players.has(cy.id)) {
            rooms.leave('room-b', cy.id);
            people.splice(people.indexOf(cy), 1);
            cyLeftAt = t;
        }
        for (const x of people) {
            const me = game.players.get(x.id);
            if (!me) continue;
            const turn = Math.sin(t / 97 + x.id) * 2.5;
            if (me.team === 'defenders') {
                const reload = t % 240 === 0;
                if (reload) reloads++;
                x.cmd(game, { yaw: turn, pitch: -0.02, fire: t % 240 < 90, reload, slot: t % 900 === 450 ? 3 : t % 900 === 0 ? 1 : 0, forward: t % 300 < 60 ? 1 : 0 });
            } else {
                x.cmd(game, { yaw: turn, forward: t % 400 < 200 ? 1 : 0, fire: t % 120 < 10, crouch: t % 500 > 450 });
            }
        }
        kills = store.lines.filter((l): l is RoundRecord => l.type === 'round').reduce((n, r) => n + r.kills.length, 0);
        // Stop in the middle of round 3, after halftime, so the match is still on when everyone leaves.
        if (cyLeftAt > 0 && t - cyLeftAt > 600) break;
    }
    for (const x of [...people]) rooms.leave('room-b', x.id);
    const rounds = store.lines.filter((l): l is RoundRecord => l.type === 'round');
    const abandoned = store.lines.find((l): l is AbandonedRecord => l.type === 'abandoned');
    const name = [...store.files.keys()][0];

    it('played several rounds with bots, a mid-match join and leave, and closed the room', () => {
        expect(rounds.length).toBe(2);
        expect(game.roundsPlayed).toBe(2);
        expect(rounds[0].players.filter(p => p.bot).length).toBe(4);
        expect(kills).toBeGreaterThan(1);
        expect(reloads).toBeGreaterThan(0);
        expect(rooms.rooms.has('room-b')).toBe(false);
        expect(abandoned).toMatchObject({ why: 'room closed', rounds: 2, recording: name });
        expect(store.ended.has(name)).toBe(true);
        void plants;
    });

    it('replays the recording through Game with every checkpoint matching (bots played back)', () => {
        const res = replayRecording(store.file(name), maps);
        expect(res.mismatch).toBeNull();
        expect(res.checkpoints).toBeGreaterThan(60);
        expect(res.rounds.replayed).toEqual(res.rounds.recorded);
        expect(res.header.players.filter(p => p.bot).length).toBe(4);
        const parsed = parseRecording(store.file(name));
        const joins = parsed.records.filter(r => r.t === 'event' && r.ev.e === 'join');
        expect(joins.length).toBeGreaterThan(0); // Cy, and the bots the fill option brought back
    });
});
