import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../shared/constants';
import type { NetCmd, ServerMsg } from '../../shared/protocol';
import { DEFAULT_ROOM_OPTIONS, type RoomOptions } from '../../shared/room-options';
import { FREEZE_MS, MATCH_OVER_MS, OVER_MS } from '../../shared/rules';
import type { RoomListResponse } from '../../shared/room-list';
import type { MapData } from '../../shared/types';
import { Game } from './game';
import { RoomListCache, fullestPublicRoom, listPublicRooms } from './roomlist';
import { handleRoomsRequest } from './rooms-http';
import { Rooms } from './rooms';
import { BAN_MS, KICK_VOTE_MS, MAP_VOTE_LEAD_MS } from './votes';

const TICK_MS = 1000 / TICK_RATE;
const ticks = (ms: number): number => Math.ceil(ms / TICK_MS);
/** The defender, 20 m from the ghost, kills it in this many commands (see matchflow.test.ts). */
const KILL = { fire: true, pitch: -0.03 };
const KILL_TICKS = 31; // six torso shots with full armor

function makeMap(name: string, ghostZ = 10, defenderZ = -10): MapData {
    return {
        name, displayName: `Map ${name}`,
        bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
        boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }],
        spawns: { ghosts: [{ pos: [0, 0, ghostZ], yaw: 0 }], defenders: [{ pos: [0, 0, defenderZ], yaw: 180 }] },
        bombSites: [{ name: 'A', min: [-3, 0, ghostZ - 3], max: [3, 2.5, ghostZ + 3] }]
    };
}
const MAP_A = makeMap('alpha');
const MAP_B = makeMap('beta', 30, 10); // same 20 m gap, shifted 20 m toward +Z
const MAPS = new Map([['alpha', MAP_A], ['beta', MAP_B]]);

class Client {
    readonly inbox: ServerMsg[] = [];
    readonly id: number;
    closed: string | null = null;
    yaw = 0;
    seq = 0;
    constructor(readonly game: Game, name = '', readonly ip?: string) {
        this.id = game.join({
            ip,
            send: m => { if (m.type === 'spawn') this.yaw = m.yaw; this.inbox.push(structuredClone(m)); },
            close: reason => { this.closed = reason; }
        }, name);
    }
    cmd(over: Partial<NetCmd> = {}): void {
        this.game.handleCmd(this.id, {
            seq: this.seq++, forward: 0, right: 0, yaw: this.yaw, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: this.game.now, ...over
        });
    }
    send(msg: Parameters<Game['handleMessage']>[1]): void { this.game.handleMessage(this.id, msg); }
    ready(): void { this.send({ type: 'ready', ready: true }); }
    all<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }>[] {
        return this.inbox.filter(m => m.type === type) as Extract<ServerMsg, { type: T }>[];
    }
    last<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }> {
        const m = this.all(type).at(-1);
        if (!m) throw new Error(`no ${type}`);
        return m;
    }
    notices(): string[] { return this.all('notice').map(m => m.text); }
    get name(): string { return this.game.players.get(this.id)?.name ?? ''; }
}

function room(names: string[], options: Partial<RoomOptions> = {}, maps: ReadonlyMap<string, MapData> = MAPS, start = MAP_A) {
    const game = new Game(start, { lobby: true, options: { ...DEFAULT_ROOM_OPTIONS, ...options }, maps });
    const clients = names.map((n, i) => new Client(game, n, `10.0.0.${i + 1}`));
    let t = 0;
    const run = (n: number, each: (c: Client) => Partial<NetCmd> | null = c => ({ pitch: (c.seq % 2) * 0.001 })): void => {
        for (let i = 0; i < n; i++) {
            game.tick(++t * TICK_MS);
            for (const c of clients) if (game.players.has(c.id)) { const o = each(c); if (o) c.cmd(o); }
        }
    };
    return { game, clients, run, P: (c: Client) => game.players.get(c.id)! };
}
type Room = ReturnType<typeof room>;

/** Everyone ready, then the defenders kill the ghost at the start of every round until the match is over. */
function playMatch(r: Room, roundsToWin: number): void {
    for (const c of r.clients) c.ready();
    for (let guard = 0; guard < 40; guard++) {
        if (r.game.phase === 'over' && r.game.score.some(s => s >= roundsToWin)) return;
        if (r.game.phase === 'over') r.run(ticks(OVER_MS) + 2);
        while (r.game.phase !== 'live') r.run(1);
        r.run(KILL_TICKS + 1, c => (r.P(c).team === 'defenders' ? KILL : { pitch: (c.seq % 2) * 0.001 }));
    }
    throw new Error('match did not finish');
}

describe('room options: who may change them and when', () => {
    it('only the creator, only in warmup, validated like the join query, and broadcast to everyone', () => {
        const r = room(['Cre', 'Bob']);
        const [creator, bob] = r.clients;
        bob.send({ type: 'options', options: { maxPlayers: 4 } });
        expect(bob.notices().at(-1)).toMatch(/creator/);
        expect(r.game.options.maxPlayers).toBe(10);

        creator.send({ type: 'options', options: { maxPlayers: 4, roundsToWin: 9, public: true, suppressed: true, fillBots: true } });
        expect(r.game.options).toEqual({ maxPlayers: 4, roundsToWin: 9, public: true, suppressed: true, fillBots: true, botLevel: 'normal' });
        for (const c of r.clients) expect(c.last('options').options).toEqual(r.game.options);

        // Invalid fields keep their value; the valid ones in the same message still apply.
        creator.send({ type: 'options', options: { maxPlayers: 99, roundsToWin: 4, public: 'x', suppressed: false } });
        expect(r.game.options).toEqual({ maxPlayers: 4, roundsToWin: 9, public: true, suppressed: false, fillBots: true, botLevel: 'normal' });
        // An unchanged message sends nothing.
        const n = bob.all('options').length;
        creator.send({ type: 'options', options: {} });
        expect(bob.all('options')).toHaveLength(n);
    });

    it('refuses to lower the player limit below the players already in the room', () => {
        const r = room(['A', 'B', 'C']);
        r.clients[0].send({ type: 'options', options: { maxPlayers: 2 } });
        expect(r.game.options.maxPlayers).toBe(10);
        expect(r.clients[0].notices().at(-1)).toMatch(/already 3 players/);
        r.clients[0].send({ type: 'options', options: { maxPlayers: 3 } });
        expect(r.game.options.maxPlayers).toBe(3);
    });

    it('refuses once the match has started, and while a match is held', () => {
        const r = room(['A', 'B']);
        for (const c of r.clients) c.ready();
        r.run(5);
        expect(r.game.phase).toBe('freeze');
        r.clients[0].send({ type: 'options', options: { roundsToWin: 3 } });
        expect(r.game.options.roundsToWin).toBe(6);
        expect(r.clients[0].notices().at(-1)).toMatch(/before the match starts/);
        // One team empties: back to warmup, but the match is held, so rules cannot change.
        r.game.leave(r.clients[1].id);
        r.run(5);
        expect(r.game.phase).toBe('warmup');
        r.clients[0].send({ type: 'options', options: { roundsToWin: 3 } });
        expect(r.game.options.roundsToWin).toBe(6);
    });

    it('a changed suppressed option changes the range gunshots are sent to (and reaches clients as an options message)', () => {
        const r = room(['A', 'B']);
        r.clients[0].send({ type: 'options', options: { suppressed: true } });
        expect(r.clients[1].last('options').options.suppressed).toBe(true);
        expect(r.game.options.suppressed).toBe(true);
    });

    it('a new joiner is told the current options and the room code in the welcome', () => {
        const r = room(['A']);
        r.game.code = 'quiet-owl-42';
        r.clients[0].send({ type: 'options', options: { maxPlayers: 5 } });
        const late = new Client(r.game, 'Late');
        expect(late.last('welcome')).toMatchObject({ room: 'quiet-owl-42', options: { maxPlayers: 5 } });
    });
});

describe('rounds to win', () => {
    it('3: sides swap after round 2 and the match ends at 3', () => {
        const r = room(['A', 'B'], { roundsToWin: 3 });
        for (const c of r.clients) c.ready();
        for (let round = 1; round <= 2; round++) {
            while (r.game.phase !== 'live') r.run(1);
            expect(r.game.ghostGroup).toBe(0);
            r.run(KILL_TICKS + 1, c => (r.P(c).team === 'defenders' ? KILL : { pitch: (c.seq % 2) * 0.001 }));
            r.run(ticks(OVER_MS) + 2);
        }
        expect(r.game.roundsPlayed).toBe(2);
        expect(r.game.ghostGroup).toBe(1);
        expect(r.game.score).toEqual([0, 2]);
        // The side that is now defending (group 0) wins the next three rounds: 3 to 2 after round 5.
        const r2 = room(['A', 'B'], { roundsToWin: 3 });
        playMatch(r2, 3);
        expect(r2.game.roundsPlayed).toBe(5);
        expect(r2.clients[0].last('summary').score).toBeDefined();
        expect(r2.game.score.slice().sort()).toEqual([2, 3]);
    });

    it('9: no swap at round 5 (the default halftime), swap after round 8', () => {
        const r = room(['A', 'B'], { roundsToWin: 9 });
        for (const c of r.clients) c.ready();
        const seen: number[] = [];
        for (let round = 1; round <= 8; round++) {
            while (r.game.phase !== 'live') r.run(1);
            r.run(KILL_TICKS + 1, c => (r.P(c).team === 'defenders' ? KILL : { pitch: (c.seq % 2) * 0.001 }));
            expect(r.game.phase).toBe('over');
            r.run(ticks(OVER_MS) + 2);
            seen.push(r.game.ghostGroup);
        }
        expect(seen).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
        expect(r.game.phase === 'freeze' || r.game.phase === 'live').toBe(true);
    });

    it('the default stays 6, swapping after round 5', () => {
        const r = room(['A', 'B']);
        for (const c of r.clients) c.ready();
        for (let round = 1; round <= 5; round++) {
            while (r.game.phase !== 'live') r.run(1);
            r.run(KILL_TICKS + 1, c => (r.P(c).team === 'defenders' ? KILL : { pitch: (c.seq % 2) * 0.001 }));
            r.run(ticks(OVER_MS) + 2);
        }
        expect(r.game.ghostGroup).toBe(1);
        expect(r.game.score).toEqual([0, 5]);
    });
});

describe('vote to kick in a room', () => {
    it('needs three players, passes with the caller and one more of three, and closes the target with a reason', () => {
        const r = room(['A', 'B', 'C']);
        const [a, b, c] = r.clients;
        a.send({ type: 'votekick', target: c.id });
        const banner = b.last('kickvote').vote!;
        expect(banner).toMatchObject({ target: c.id, targetName: 'C', caller: a.id, yes: 1, no: 0, needed: 2, mine: null });
        expect(a.last('kickvote').vote!.mine).toBe(true);
        expect(c.last('kickvote').vote!.mine).toBeNull();
        c.send({ type: 'votecast', yes: false }); // the target cannot vote
        expect(r.game.players.has(c.id)).toBe(true);
        expect(b.last('kickvote').vote!.no).toBe(0);
        b.send({ type: 'votecast', yes: true });
        expect(r.game.players.has(c.id)).toBe(false);
        expect(c.closed).toMatch(/removed from this room by a vote/);
        expect(b.last('kickvote').vote).toBeNull();
        expect(b.notices().at(-1)).toMatch(/C was removed/);
    });

    it('does nothing in a room of two (the vote needs three)', () => {
        const r = room(['A', 'B']);
        r.clients[0].send({ type: 'votekick', target: r.clients[1].id });
        expect(r.clients[0].notices().at(-1)).toMatch(/at least 3/);
        expect(r.clients[0].all('kickvote')).toHaveLength(0);
    });

    it('4 players need 3 yes, 5 need 3; dead players and spectators vote like anyone', () => {
        const r4 = room(['A', 'B', 'C', 'D']);
        r4.clients[0].send({ type: 'votekick', target: r4.clients[3].id });
        r4.clients[1].send({ type: 'votecast', yes: true });
        expect(r4.game.players.size).toBe(4); // 2 of 4 is not more than half
        r4.clients[2].send({ type: 'votecast', yes: true });
        expect(r4.game.players.size).toBe(3);

        const r5 = room(['A', 'B', 'C', 'D', 'E']);
        for (const c of r5.clients) c.ready();
        r5.run(ticks(FREEZE_MS) + 2);
        r5.P(r5.clients[1]).alive = false; // a dead voter
        r5.clients[0].send({ type: 'votekick', target: r5.clients[4].id });
        r5.clients[1].send({ type: 'votecast', yes: false });
        r5.clients[2].send({ type: 'votecast', yes: true });
        expect(r5.game.players.size).toBe(5);
        r5.clients[3].send({ type: 'votecast', yes: true });
        expect(r5.game.players.size).toBe(4);
    });

    it('fails when too many say no, and the same player cannot be targeted again for two minutes', () => {
        const r = room(['A', 'B', 'C', 'D', 'E']);
        const [a, b, c, d, e] = r.clients;
        a.send({ type: 'votekick', target: e.id });
        b.send({ type: 'votecast', yes: false });
        c.send({ type: 'votecast', yes: false });
        expect(r.game.players.has(e.id)).toBe(true);
        expect(a.last('kickvote').vote).toBeNull();
        expect(d.notices().at(-1)).toMatch(/failed/);
        d.send({ type: 'votekick', target: e.id });
        expect(d.notices().at(-1)).toMatch(/just failed/);
        // The caller waits two minutes; another player may call a vote about someone else meanwhile.
        a.send({ type: 'votekick', target: d.id });
        expect(a.notices().at(-1)).toMatch(/Wait/);
        d.send({ type: 'votekick', target: c.id });
        expect(d.last('kickvote').vote!.target).toBe(c.id);
    });

    it('runs out after 30 s of server time, and only one vote runs at a time', () => {
        const r = room(['A', 'B', 'C', 'D', 'E']);
        const [a, b, , d] = r.clients;
        a.send({ type: 'votekick', target: r.clients[4].id });
        b.send({ type: 'votekick', target: d.id });
        expect(b.notices().at(-1)).toMatch(/already running/);
        r.run(ticks(KICK_VOTE_MS) - 5);
        expect(a.last('kickvote').vote).not.toBeNull();
        r.run(10);
        expect(a.last('kickvote').vote).toBeNull();
        expect(r.game.players.size).toBe(5);
    });

    it('is cancelled when the target leaves', () => {
        const r = room(['A', 'B', 'C']);
        r.clients[0].send({ type: 'votekick', target: r.clients[2].id });
        r.game.leave(r.clients[2].id);
        r.run(2);
        expect(r.clients[0].last('kickvote').vote).toBeNull();
        expect(r.game.players.size).toBe(2);
    });

    it('bots never count: a room of two humans and a bot cannot hold a vote', () => {
        const r = room(['A', 'B']);
        const bot = new Client(r.game, 'Bot');
        r.P(bot).bot = true;
        r.clients[0].send({ type: 'votekick', target: r.clients[1].id });
        expect(r.clients[0].notices().at(-1)).toMatch(/at least 3/);
    });
});

describe('removal and rejoin bans', () => {
    it('the creator removes the other player directly in a two-player warmup; nobody else may', () => {
        const r = room(['Cre', 'Bob']);
        const [creator, bob] = r.clients;
        bob.send({ type: 'removeplayer', target: creator.id });
        expect(bob.notices().at(-1)).toMatch(/creator/);
        expect(r.game.players.size).toBe(2);
        creator.send({ type: 'removeplayer', target: bob.id });
        expect(bob.closed).toMatch(/creator removed you/);
        expect(r.game.players.size).toBe(1);
    });

    it('does not allow direct removal with three players or once the match is on', () => {
        const three = room(['A', 'B', 'C']);
        three.clients[0].send({ type: 'removeplayer', target: three.clients[1].id });
        expect(three.game.players.size).toBe(3);
        const two = room(['A', 'B']);
        for (const c of two.clients) c.ready();
        two.run(5);
        two.clients[0].send({ type: 'removeplayer', target: two.clients[1].id });
        expect(two.game.players.size).toBe(2);
    });

    it('a removed player cannot rejoin for 10 minutes, by address or by name, then can', () => {
        const rooms = new Rooms(MAPS, 'alpha');
        const conn = (ip: string) => ({ ip, send: () => {}, close: () => {} });
        const first = rooms.join('r', null, conn('1.1.1.1'), 'Cre', 0);
        const bobConn = conn('2.2.2.2');
        const bob = rooms.join('r', null, bobConn, 'Bob', 0);
        const third = rooms.join('r', null, conn('3.3.3.3'), 'Dee', 0);
        if (!first.ok || !bob.ok || !third.ok) throw new Error('setup');
        const game = first.game;
        game.now = 5000;
        game.handleMessage(first.id, { type: 'votekick', target: bob.id });
        game.handleMessage(third.id, { type: 'votecast', yes: true });
        expect(game.players.has(bob.id)).toBe(false);

        // Same address, another name; same name, another address; both are refused.
        expect(rooms.join('r', null, conn('2.2.2.2'), 'Other', 6000)).toEqual({ ok: false, reason: 'Removed from this room' });
        expect(rooms.join('r', null, conn('9.9.9.9'), 'bob', 6000)).toEqual({ ok: false, reason: 'Removed from this room' });
        // A different room is unaffected, and so is an unrelated player.
        expect(rooms.join('other-room', null, conn('2.2.2.2'), 'Bob', 6000).ok).toBe(true);
        expect(rooms.join('r', null, conn('8.8.8.8'), 'Eve', 6000).ok).toBe(true);
        // Expired: the ban lasted BAN_MS of room time.
        game.now = 5000 + BAN_MS - 1;
        expect(rooms.join('r', null, conn('2.2.2.2'), 'Bob', 0).ok).toBe(false);
        game.now = 5000 + BAN_MS;
        expect(rooms.join('r', null, conn('2.2.2.2'), 'Bob', 0).ok).toBe(true);
    });

    it('the ban dies with the room', () => {
        const rooms = new Rooms(MAPS, 'alpha');
        const conn = (ip: string) => ({ ip, send: () => {}, close: () => {} });
        const a = rooms.join('r', null, conn('1.1.1.1'), 'A', 0);
        const b = rooms.join('r', null, conn('2.2.2.2'), 'B', 0);
        const c = rooms.join('r', null, conn('3.3.3.3'), 'C', 0);
        if (!a.ok || !b.ok || !c.ok) throw new Error('setup');
        a.game.handleMessage(a.id, { type: 'votekick', target: b.id });
        a.game.handleMessage(c.id, { type: 'votecast', yes: true });
        rooms.leave('r', a.id);
        rooms.leave('r', c.id);
        expect(rooms.rooms.has('r')).toBe(false);
        expect(rooms.join('r', null, conn('2.2.2.2'), 'B', 0).ok).toBe(true);
    });
});

describe('names and chat in a room', () => {
    it('filtered and reserved names become Player; duplicates are numbered', () => {
        const r = room([]);
        const names = ['Sam', 'sam', 'Sam', 'Server', 'Admin', 'n1gger'].map(n => new Client(r.game, n).name);
        expect(names).toEqual(['Sam', 'sam (2)', 'Sam (3)', 'Player', 'Player (2)', 'Player (3)']);
        expect(new Client(r.game, '').name).toMatch(/^Player \d+$/);
    });

    it('the 60 s rejoin restore keeps working with numbered names', () => {
        const r = room(['Zed', 'Sam']);
        const second = new Client(r.game, 'Sam');
        expect(second.name).toBe('Sam (2)');
        for (const c of [...r.clients, second]) c.ready();
        r.run(5);
        expect(r.game.phase).toBe('freeze');
        r.P(second).stats.kills = 4;
        const group = r.P(second).group;
        r.game.leave(second.id);
        // Asking for "Sam" again, with the first Sam still here, is numbered the same way and gets the statistics back.
        const back = new Client(r.game, 'Sam');
        expect(back.name).toBe('Sam (2)');
        expect(r.P(back)).toMatchObject({ group });
        expect(r.P(back).stats.kills).toBe(4);
        // The first Sam is unaffected, and an unnumbered leaver is restored as before.
        expect(r.P(r.clients[1]).stats.kills).toBe(0);
        const zedStats = r.P(r.clients[0]);
        zedStats.stats.damage = 55;
        r.game.leave(r.clients[0].id);
        expect(r.P(new Client(r.game, 'Zed')).stats.damage).toBe(55);
        // Not within 60 s: nothing is restored.
        r.game.leave(back.id);
        r.run(ticks(61_000));
        expect(r.P(new Client(r.game, 'Sam')).stats.kills).toBe(0);
    });

    it('masks blocked words in chat with asterisks and still delivers the line', () => {
        const r = room(['A', 'B']);
        r.clients[0].send({ type: 'chat', team: false, text: 'you cunt, gg' });
        expect(r.clients[1].all('chat').at(-1)!.text).toBe('you ****, gg');
        r.clients[0].send({ type: 'chat', team: false, text: 'fine words' });
        expect(r.clients[1].all('chat').at(-1)!.text).toBe('fine words');
    });
});

describe('public room list and Quick play', () => {
    const conn = (ip = '1.1.1.1') => ({ ip, send: () => {}, close: () => {} });
    const open = (rooms: Rooms, code: string, players: number, options: Partial<RoomOptions> = {}, map = 'alpha') => {
        for (let i = 0; i < players; i++) {
            const r = rooms.join(code, map, conn(`10.${code.length}.${i}.1`), `P${i}`, 0, { ...DEFAULT_ROOM_OPTIONS, ...options });
            if (!r.ok) throw new Error(r.reason);
        }
    };

    it('lists public rooms only, with counts, capacity, phase and options, and never names or addresses', () => {
        const rooms = new Rooms(MAPS, 'alpha');
        open(rooms, 'pub-one', 2, { public: true, maxPlayers: 6 });
        open(rooms, 'secret', 3); // private by default
        open(rooms, 'pub-two', 1, { public: true, suppressed: true }, 'beta');
        const list = listPublicRooms(rooms.rooms);
        expect(list.map(e => e.code)).toEqual(['pub-one', 'pub-two']);
        expect(list[0]).toEqual({
            code: 'pub-one', map: 'alpha', mapName: 'Map alpha', players: 2, bots: 0, capacity: 6, phase: 'lobby', score: null,
            options: { suppressed: false, public: true, maxPlayers: 6, roundsToWin: 6, fillBots: false, botLevel: 'normal' }
        });
        expect(list[1]).toMatchObject({ map: 'beta', mapName: 'Map beta', capacity: 10, options: { suppressed: true } });
        const json = JSON.stringify(list);
        expect(json).not.toContain('secret');
        expect(json).not.toMatch(/P0|10\.\d+\.\d+\.1/);
    });

    it('shows a room in a match with its score, and a room that became private disappears', () => {
        const rooms = new Rooms(MAPS, 'alpha');
        open(rooms, 'pub', 2, { public: true });
        const game = rooms.rooms.get('pub')!;
        for (const p of game.players.values()) game.handleMessage(p.id, { type: 'ready', ready: true });
        game.tick(TICK_MS);
        expect(listPublicRooms(rooms.rooms)[0]).toMatchObject({ phase: 'match', score: { ghosts: 0, defenders: 0 } });
        game.options = { ...game.options, public: false };
        expect(listPublicRooms(rooms.rooms)).toEqual([]);
    });

    it('caches for one second', () => {
        const rooms = new Rooms(MAPS, 'alpha');
        open(rooms, 'pub', 1, { public: true });
        let now = 10_000;
        const cache = new RoomListCache(1000, () => now);
        expect(cache.get(rooms.rooms)).toHaveLength(1);
        open(rooms, 'pub-b', 1, { public: true });
        now += 999;
        expect(cache.get(rooms.rooms)).toHaveLength(1);
        now += 1;
        expect(cache.get(rooms.rooms)).toHaveLength(2);
    });

    it('enforces the room capacity at joining', () => {
        const rooms = new Rooms(MAPS, 'alpha');
        open(rooms, 'small', 2, { public: true, maxPlayers: 2 });
        expect(rooms.join('small', null, conn('7.7.7.7'), 'Late', 0)).toEqual({ ok: false, reason: 'Room full' });
    });

    it('Quick play picks the fullest public room with space, the oldest on a tie, and skips private and full rooms', () => {
        const rooms = new Rooms(MAPS, 'alpha');
        const quick = () => rooms.quickRoom(conn('5.5.5.5'), 'Me');
        expect(quick()).toBeNull();
        open(rooms, 'private-big', 5);
        expect(quick()).toBeNull();
        open(rooms, 'old', 2, { public: true });
        open(rooms, 'newer', 2, { public: true });
        expect(quick()).toBe('old');
        open(rooms, 'busy', 4, { public: true });
        expect(quick()).toBe('busy');
        open(rooms, 'full', 5, { public: true, maxPlayers: 5 });
        expect(quick()).toBe('busy');
        expect(fullestPublicRoom(rooms.rooms, () => false)).toBeNull();
        expect(rooms.newQuickCode()).toMatch(/^quick-[a-z0-9]+$/);
    });

    it('Quick play skips a room that removed this player', () => {
        const rooms = new Rooms(MAPS, 'alpha');
        open(rooms, 'pub', 3, { public: true });
        const game = rooms.rooms.get('pub')!;
        game.bans.add('5.5.5.5', 'Me', game.now);
        expect(rooms.quickRoom(conn('5.5.5.5'), 'Someone')).toBeNull();
        expect(rooms.quickRoom(conn('6.6.6.6'), 'Someone')).toBe('pub');
    });
});

describe('GET /rooms', () => {
    function call(origin: string | undefined, method = 'GET', allowed: string[] = ['https://play.example'], url = '/rooms') {
        const headers: Record<string, string> = {};
        const res = {
            status: 0, body: '', headers: {} as Record<string, string>,
            setHeader(k: string, v: string) { this.headers[k] = v; },
            writeHead(s: number) { this.status = s; return this; },
            end(b = '') { this.body = b; }
        };
        const entry = { code: 'x', map: 'alpha', mapName: 'A', players: 1, bots: 0, capacity: 10, phase: 'lobby' as const, score: null, options: { ...DEFAULT_ROOM_OPTIONS, public: true } };
        const handled = handleRoomsRequest({ url, method, headers: origin ? { origin } : headers } as never, res as never, { list: () => [entry], allowedOrigins: allowed });
        return { handled, res };
    }

    it('answers an allowed origin with the list and CORS headers for exactly that origin', () => {
        const { handled, res } = call('https://play.example');
        expect(handled).toBe(true);
        expect(res.status).toBe(200);
        expect((JSON.parse(res.body) as RoomListResponse).rooms[0].code).toBe('x');
        expect(res.headers['access-control-allow-origin']).toBe('https://play.example');
    });

    it('refuses other origins and callers without an origin when a list is configured, with no CORS header', () => {
        for (const o of ['https://evil.example', undefined]) {
            const { res } = call(o);
            expect(res.status).toBe(403);
            expect(res.headers['access-control-allow-origin']).toBeUndefined();
            expect(res.body).toBe('');
        }
    });

    it('with no configured origins (development) anyone may read it; preflight and other methods behave', () => {
        expect(call(undefined, 'GET', []).res.status).toBe(200);
        expect(call('https://play.example', 'OPTIONS').res.status).toBe(204);
        expect(call('https://evil.example', 'OPTIONS').res.status).toBe(403);
        expect(call('https://play.example', 'POST').res.status).toBe(405);
        expect(call('https://play.example', 'GET', ['https://play.example'], '/health').handled).toBe(false);
        expect(call('https://play.example', 'GET', ['https://play.example'], '/rooms?x=1').handled).toBe(true);
    });
});

describe('map vote and swap', () => {
    function finishedMatch(options: Partial<RoomOptions> = { roundsToWin: 3 }): Room {
        const r = room(['A', 'B'], options);
        playMatch(r, options.roundsToWin ?? 3);
        return r;
    }

    it('sends the choices with the result card, counts picks and shows each player their own', () => {
        const r = finishedMatch();
        const [a, b] = r.clients;
        const first = a.last('mapvote');
        expect(first).toMatchObject({ current: 'alpha', mine: null, maps: [{ id: 'alpha', votes: 0 }, { id: 'beta', votes: 0 }] });
        expect(first.closesAt).toBe(r.game.phaseEndsAt - MAP_VOTE_LEAD_MS);
        a.send({ type: 'mapvote', map: 'beta' });
        expect(a.last('mapvote')).toMatchObject({ mine: 'beta', maps: [{ votes: 0 }, { votes: 1 }] });
        expect(b.last('mapvote')).toMatchObject({ mine: null, maps: [{ votes: 0 }, { votes: 1 }] });
        a.send({ type: 'mapvote', map: 'nonsense' });
        expect(a.last('mapvote').mine).toBe('beta');
    });

    it('moves the room to the winning map before the rematch, resets stats, keeps groups, and a round plays on the new map', () => {
        const r = finishedMatch();
        const [a, b] = r.clients;
        const groups = [r.P(a).group, r.P(b).group];
        a.send({ type: 'mapvote', map: 'beta' });
        b.send({ type: 'mapvote', map: 'beta' });
        r.run(ticks(MATCH_OVER_MS - MAP_VOTE_LEAD_MS) + 2);
        expect(r.game.map.name).toBe('beta');
        expect(a.last('map')).toEqual({ type: 'map', map: 'beta', mapName: 'Map beta' });
        expect(b.last('mapvote')).toMatchObject({ next: 'beta', current: 'beta' });
        // Between the swap and the new match nobody is alive, so no command is simulated on the new map.
        expect(r.P(a).alive || r.P(b).alive).toBe(false);
        const before = [...r.P(a).state.pos];
        r.run(5, () => ({ forward: 1 }));
        expect([...r.P(a).state.pos]).toEqual(before);

        r.run(ticks(MAP_VOTE_LEAD_MS) + 2);
        expect(r.game.phase).toBe('freeze');
        expect(r.game.score).toEqual([0, 0]);
        expect([r.P(a).group, r.P(b).group]).toEqual(groups);
        expect(r.P(a).stats.kills + r.P(b).stats.kills).toBe(0);
        // Spawned on beta: ghosts at z 30, defenders at z 10.
        const ghost = [a, b].find(c => r.P(c).team === 'ghosts')!;
        const defender = [a, b].find(c => r.P(c).team === 'defenders')!;
        expect(r.P(ghost).state.pos[2]).toBeCloseTo(30);
        expect(r.P(defender).state.pos[2]).toBeCloseTo(10);
        // A full round on the new map: the defender kills the ghost from 20 m, exactly as on the old one.
        while (r.game.phase !== 'live') r.run(1);
        r.run(KILL_TICKS + 1, c => (r.P(c).team === 'defenders' ? KILL : { pitch: (c.seq % 2) * 0.001 }));
        expect(r.game.phase).toBe('over');
        expect(r.game.score.reduce((x, y) => x + y)).toBe(1);
        expect(r.game.map.name).toBe('beta');
    });

    it('stays on the same map with no votes, or when the vote is for the current map, and says so without a map message', () => {
        const r = finishedMatch();
        r.run(ticks(MATCH_OVER_MS - MAP_VOTE_LEAD_MS) + 2);
        expect(r.game.map.name).toBe('alpha');
        expect(r.clients[0].all('map')).toHaveLength(0);
        expect(r.clients[0].last('mapvote')).toMatchObject({ next: 'alpha' });
        r.run(ticks(MAP_VOTE_LEAD_MS) + 2);
        expect(r.game.phase).toBe('freeze');
        expect(r.P(r.clients[0]).alive).toBe(true);
    });

    it('a tie goes to the current map; late picks after the vote closed are ignored; a joiner during the result gets the vote and the new map', () => {
        const r = finishedMatch();
        const [a, b] = r.clients;
        a.send({ type: 'mapvote', map: 'beta' });
        b.send({ type: 'mapvote', map: 'alpha' });
        r.run(ticks(MATCH_OVER_MS - MAP_VOTE_LEAD_MS) + 2);
        expect(r.game.map.name).toBe('alpha');
        const n = a.all('mapvote').length;
        a.send({ type: 'mapvote', map: 'beta' });
        expect(a.all('mapvote')).toHaveLength(n);

        const r2 = finishedMatch();
        r2.clients[0].send({ type: 'mapvote', map: 'beta' });
        r2.run(ticks(MATCH_OVER_MS - MAP_VOTE_LEAD_MS) + 2);
        const late = new Client(r2.game, 'Late');
        expect(late.last('welcome')).toMatchObject({ map: 'beta' });
        expect(late.last('mapvote')).toMatchObject({ next: 'beta' });
    });

    it('a room without the installed list can only stay on its map', () => {
        const solo = room(['A', 'B'], { roundsToWin: 3 }, undefined as never);
        void solo;
        const game = new Game(MAP_A, { lobby: true });
        const c = new Client(game, 'Only');
        game.handleMessage(c.id, { type: 'mapvote', map: 'beta' });
        expect(game.map.name).toBe('alpha');
    });
});
