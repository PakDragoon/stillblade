import { describe, expect, it } from 'vitest';
import { BREATH_RANGE, KNIFE_RANGE, TICK_RATE } from '../../shared/constants';
import { CHAT_MAX_CHARS, type ChatMsg, type DamageMsg, type NetCmd, type ServerMsg, type Team } from '../../shared/protocol';
import {
    FREEZE_MS, GRACE_MS, IDLE_ROUNDS, MATCH_OVER_MS, OVER_MS, PLANT_TICKS, ROUNDS_TO_WIN, ROUND_MS
} from '../../shared/rules';
import { cleanChat } from '../../shared/chat';
import { mvpScore, pickMvp } from '../../shared/stats';
import type { Box, MapData } from '../../shared/types';
import { Game } from './game';

const TICK_MS = 1000 / TICK_RATE;
const ticks = (ms: number): number => Math.ceil(ms / TICK_MS);
/**
 * No gun kills with one shot (a headshot is twice the body damage). Aimed slightly down from 20 m and held for
 * KILL_TICKS, the rifle (a shot every 6 commands) puts three shots into the torso as the recoil climbs: 102.
 */
const KILL = { fire: true, pitch: -0.03 };
const KILL_TICKS = 2 * 6 + 1;

/** Ghost spawns at z = ghostZ facing -Z; defender at z = defenderZ facing +Z. A bomb site covers the ghost spawn. */
function makeMap(ghostZ = 10, defenderZ = -10, extra: Box[] = []): MapData {
    return {
        name: 'test',
        bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
        boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }, ...extra],
        spawns: { ghosts: [{ pos: [0, 0, ghostZ], yaw: 0 }], defenders: [{ pos: [0, 0, defenderZ], yaw: 180 }] },
        bombSites: [{ name: 'A', min: [-3, 0, ghostZ - 3], max: [3, 2.5, ghostZ + 3], }]
    };
}

class Client {
    readonly inbox: ServerMsg[] = [];
    readonly id: number;
    yaw = 0;
    seq = 0;
    constructor(readonly game: Game, name = '') {
        this.id = game.join({
            send: m => {
                if (m.type === 'spawn') this.yaw = m.yaw;
                this.inbox.push(structuredClone(m));
            }
        }, name);
    }
    cmd(over: Partial<NetCmd> = {}): void {
        this.game.handleCmd(this.id, {
            seq: this.seq++, forward: 0, right: 0, yaw: this.yaw, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: this.game.now, ...over
        });
    }
    ready(ready = true): void { this.game.handleMessage(this.id, { type: 'ready', ready }); }
    start(): void { this.game.handleMessage(this.id, { type: 'start' }); }
    switchTeam(): void { this.game.handleMessage(this.id, { type: 'team' }); }
    say(text: string, team = false): void { this.game.handleMessage(this.id, { type: 'chat', team, text }); }
    all<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }>[] {
        return this.inbox.filter(m => m.type === type) as Extract<ServerMsg, { type: T }>[];
    }
    last<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }> {
        const m = this.all(type).at(-1);
        if (!m) throw new Error(`no ${type}`);
        return m;
    }
    texts(): string[] { return this.all('chat').map(m => m.text); }
    team(): Team { return this.game.players.get(this.id)!.team; }
}

/** A lobby room with a clock; clients wiggle their view each tick unless told otherwise (so they are never idle). */
function room(map = makeMap(), names: string[] = ['A', 'B']) {
    const game = new Game(map, { lobby: true });
    const clients = names.map(n => new Client(game, n));
    let t = 0;
    const run = (n: number, each: (c: Client) => Partial<NetCmd> | null = c => ({ pitch: (c.seq % 2) * 0.001 })): void => {
        for (let i = 0; i < n; i++) {
            game.tick(++t * TICK_MS);
            for (const c of clients) { const o = each(c); if (o) c.cmd(o); }
        }
    };
    const join = (name = ''): Client => { const c = new Client(game, name); clients.push(c); return c; };
    const live = (): void => {
        for (const c of clients) c.ready();
        run(ticks(FREEZE_MS) + 2);
    };
    return { game, clients, run, join, live, P: (c: Client) => game.players.get(c.id)! };
}

describe('lobby: ready and start', () => {
    it('lets a solo player walk around in warmup and does not start without an opponent', () => {
        const r = room(makeMap(), ['Solo']);
        const [a] = r.clients;
        a.ready();
        r.run(120, () => ({ forward: 1 }));
        expect(r.game.phase).toBe('warmup');
        expect(r.P(a).alive).toBe(true);
        expect(r.P(a).state.pos[2]).toBeLessThan(10);
        a.start();
        r.run(5);
        expect(r.game.phase).toBe('warmup');
        expect(a.all('notice').at(-1)!.text).toMatch(/each team/i);
    });

    it('stays in warmup until every connected player is ready, then starts', () => {
        const r = room();
        const [a, b] = r.clients;
        a.ready();
        r.run(30);
        expect(r.game.phase).toBe('warmup');
        b.ready();
        r.run(2);
        expect(r.game.phase).toBe('freeze');
        // A third player arriving mid-match does not matter; and unreadying before the last ready blocks the start.
        const r2 = room();
        r2.clients[0].ready(); r2.clients[1].ready(); r2.clients[1].ready(false);
        r2.run(30);
        expect(r2.game.phase).toBe('warmup');
    });

    it('lets only the creator start early, and only with a player on each team', () => {
        const r = room();
        const [a, b] = r.clients;
        b.start(); // not the creator
        r.run(5);
        expect(r.game.phase).toBe('warmup');
        expect(b.all('notice').at(-1)!.text).toMatch(/creator/i);
        a.start();
        r.run(2);
        expect(r.game.phase).toBe('freeze'); // nobody pressed ready
    });

    it('does not start on ready alone when a newly joined player has not readied', () => {
        const r = room();
        r.clients[0].ready(); r.clients[1].ready();
        const c = r.join('C'); // joins before the tick that would start the match
        r.run(30);
        expect(r.game.phase).toBe('warmup');
        c.ready();
        r.run(2);
        expect(r.game.phase).toBe('freeze');
    });

    it('lists ready state and the creator in the roster', () => {
        const r = room();
        r.clients[1].ready();
        const roster = r.clients[0].last('roster').players;
        expect(roster.find(p => p.id === r.clients[0].id)).toMatchObject({ creator: true, ready: false });
        expect(roster.find(p => p.id === r.clients[1].id)).toMatchObject({ creator: false, ready: true });
    });
});

describe('creator handover', () => {
    it('is the first player, then passes to the longest-connected player when they leave', () => {
        const r = room(makeMap(), ['A', 'B']);
        const [a, b] = r.clients;
        r.run(5);
        const c = r.join('C');
        expect(r.game.creatorId).toBe(a.id);
        r.game.leave(a.id);
        expect(r.game.creatorId).toBe(b.id);
        expect(c.last('roster').players.find(p => p.id === b.id)!.creator).toBe(true);
        r.game.leave(b.id);
        expect(r.game.creatorId).toBe(c.id);
    });
});

describe('teams', () => {
    it('puts new players on the smaller team', () => {
        const r = room(makeMap(), ['A', 'B']);
        const c = r.join('C'), d = r.join('D'), e = r.join('E');
        const n = { ghosts: 0, defenders: 0 };
        for (const x of [...r.clients]) n[x.team()]++;
        expect(Math.abs(n.ghosts - n.defenders)).toBeLessThanOrEqual(1);
        // Drain one side, then the next joiner lands on it.
        const ghosts = r.clients.filter(x => x.team() === 'ghosts');
        for (const g of ghosts.slice(0, 2)) r.game.leave(g.id);
        const f = r.join('F');
        const counts = { ghosts: 0, defenders: 0 };
        for (const p of r.game.players.values()) counts[p.team]++;
        expect(Math.abs(counts.ghosts - counts.defenders)).toBeLessThanOrEqual(1);
        void [c, d, e, f];
    });

    it('allows a warmup switch only if the teams then differ by at most one', () => {
        const r = room(makeMap(), ['A', 'B']);
        const [a, b] = r.clients;
        a.switchTeam(); // 1 v 1 -> 0 v 2: refused
        expect(a.team()).toBe('ghosts');
        expect(a.all('notice').at(-1)!.text).toMatch(/uneven/);
        const c = r.join('C'); // 2 ghosts v 1 defender
        expect(c.team()).toBe('ghosts');
        c.switchTeam(); // 1 v 2: fine
        expect(c.team()).toBe('defenders');
        expect(r.game.players.get(c.id)!.alive).toBe(true); // respawned on its new side
        void b;
    });

    it('refuses a switch once the match has started', () => {
        const r = room(makeMap(), ['A', 'B', 'C']);
        r.live();
        const before = r.clients[2].team();
        r.clients[2].switchTeam();
        expect(r.clients[2].team()).toBe(before);
    });
});

describe('stats', () => {
    it('counts kills, deaths, damage, headshots and resets for the next match', () => {
        const r = room();
        const [ghost, defender] = r.clients;
        r.live();
        r.run(1, c => (c === defender ? { fire: true, pitch: -0.03 } : null)); // body shot at 20 m: 34
        const afterBody = r.game.players.get(defender.id)!.stats;
        expect(afterBody).toMatchObject({ damage: 34, kills: 0, headshots: 0 });
        r.run(ticks(3000), c => (c === defender ? { fire: false } : null));
        r.run(1, c => (c === defender ? { fire: true } : null)); // head shot: 100 but only 66 left
        const s = r.game.players.get(defender.id)!.stats;
        expect(s).toMatchObject({ kills: 1, headshots: 1, damage: 100 });
        expect(r.game.players.get(ghost.id)!.stats.deaths).toBe(1);
        const roster = ghost.last('roster').players.find(p => p.id === defender.id)!;
        expect(roster).toMatchObject({ kills: 1, headshots: 1, damage: 100, assists: 0, plants: 0 });
    });

    it('credits an assist to a recent damager but not a stale one, and backstabs count', () => {
        // Two ghosts knife one defender 1.5 m away, from behind (the ghosts face the same way as the defender).
        const map = makeMap(-11.5, -10);
        const r = room(map, ['G1', 'D', 'G2']);
        const [g1, d, g2] = r.clients;
        expect([g1.team(), d.team(), g2.team()]).toEqual(['ghosts', 'defenders', 'ghosts']);
        r.live();
        r.run(ticks(300)); // freeze is over; settle
        r.run(14, c => (c === d ? {} : { fire: true, yaw: Math.PI }));
        const S = (c: Client) => r.game.players.get(c.id)!.stats;
        expect(S(g1)).toMatchObject({ backstabs: 1, damage: 100, kills: 1, assists: 0 }); // the first hit kills: 100 from behind
        expect(S(d).deaths).toBe(1);
        void g2;
    });

    it('credits assists: front knife hits by two attackers', () => {
        const map = makeMap(-8.5, -10); // ghosts 1.5 m in front of the defender
        const r = room(map, ['G1', 'D', 'G2']);
        const [g1, d, g2] = r.clients;
        r.live();
        r.run(14, c => (c === d ? {} : { fire: true }));
        const S = (c: Client) => r.game.players.get(c.id)!.stats;
        expect(S(g1)).toMatchObject({ damage: 55, kills: 0, assists: 1 });
        expect(S(g2)).toMatchObject({ damage: 45, kills: 1, assists: 0 });
        expect(S(d)).toMatchObject({ deaths: 1 });
    });

    it('counts plants and defuses', () => {
        const r = room();
        const [ghost, defender] = r.clients;
        r.live();
        r.run(PLANT_TICKS + 2, c => (c === ghost ? { use: true } : { pitch: (c.seq % 2) * 0.001 }));
        expect(r.game.phase).toBe('planted');
        expect(r.game.players.get(ghost.id)!.stats.plants).toBe(1);
        void defender;
    });

    it('scores the MVP and breaks ties on deaths, then id', () => {
        const base = { kills: 0, deaths: 0, assists: 0, headshots: 0, backstabs: 0, damage: 0, plants: 0, defuses: 0 };
        expect(mvpScore({ ...base, kills: 5, assists: 2, headshots: 2, damage: 600, plants: 1, deaths: 3 })).toBeCloseTo(10 + 2 + 1 + 6 + 3 - 1.5);
        expect(pickMvp([{ id: 1, ...base, kills: 1 }, { id: 2, ...base, kills: 3 }])).toBe(2);
        expect(pickMvp([{ id: 5, ...base, kills: 2, deaths: 1 }, { id: 3, ...base, kills: 2, deaths: 1 }])).toBe(3);
        expect(pickMvp([{ id: 5, ...base, kills: 2, deaths: 2, plants: 0 }, { id: 3, ...base, kills: 2.5 * 0, deaths: 0, assists: 4 }])).toBe(3);
    });
});

describe('match end and rematch', () => {
    /** The defender shoots the ghost down at the start of each round until someone has the win target. */
    function playMatch(r: ReturnType<typeof room>): void {
        while (r.game.phase !== 'over' || !r.game.players.size || !r.game.score.some(s => s >= ROUNDS_TO_WIN)) {
            if (r.game.phase === 'over') r.run(ticks(OVER_MS) + 2);
            while (r.game.phase !== 'live') r.run(1);
            r.run(KILL_TICKS + 1, c => (r.P(c).team === 'defenders' ? KILL : { pitch: (c.seq % 2) * 0.001 }));
        }
    }

    it('sends a final summary, holds the result for 20 s, then starts a fresh match on the same map', () => {
        expect(MATCH_OVER_MS).toBe(20_000);
        const r = room();
        const [a, b] = r.clients;
        r.live();
        playMatch(r);
        const sum = a.last('summary');
        expect(sum).toMatchObject({ type: 'summary', winner: 'defenders' });
        expect(sum.score.ghosts + sum.score.defenders).toBeGreaterThanOrEqual(ROUNDS_TO_WIN);
        expect(sum.players).toHaveLength(2);
        expect(sum.mvp).toBe(pickMvp(sum.players));
        expect(sum.players.reduce((n, p) => n + p.kills, 0)).toBeGreaterThanOrEqual(ROUNDS_TO_WIN);
        const nextAt = sum.nextAt;
        expect(nextAt - a.last('round').endsAt).toBe(0);

        // Held: still the result 19 s later (ticks since the round ended), then a new match.
        r.run(ticks(MATCH_OVER_MS - 1000));
        expect(r.game.phase).toBe('over');
        r.run(ticks(1500));
        expect(r.game.phase).toBe('freeze');
        expect(a.last('round')).toMatchObject({ phase: 'freeze', round: 1, score: { ghosts: 0, defenders: 0 } });
        expect(r.game.players.get(a.id)!.stats.kills + r.game.players.get(b.id)!.stats.kills).toBe(0);
        expect(r.game.map.name).toBe('test');
    });

    it('makes a player who joins during the result screen wait for the new match, and shows them the result', () => {
        const r = room();
        r.live();
        playMatch(r);
        const late = r.join('Late');
        expect(late.last('summary').players).toHaveLength(2);
        expect(r.P(late).alive).toBe(false);
        r.run(ticks(MATCH_OVER_MS) + 2);
        expect(r.game.phase).toBe('freeze');
        expect(r.P(late).alive).toBe(true);
    });
});

describe('chat', () => {
    it('strips control characters, collapses whitespace and caps at 120 characters', () => {
        expect(cleanChat('  hi\u0000 ‮there\n\tfriend\u0007 ')).toBe('hi there friend');
        expect(cleanChat('x'.repeat(500))).toHaveLength(CHAT_MAX_CHARS);
        expect(Array.from(cleanChat('😀'.repeat(300)))).toHaveLength(CHAT_MAX_CHARS);
        expect(cleanChat('\u0000\u0001  ')).toBe('');
        const r = room();
        r.clients[0].say('a\u0000b'.repeat(80));
        expect(Array.from(r.clients[1].texts()[0])).toHaveLength(CHAT_MAX_CHARS);
        r.clients[0].say('   \u0001  ');
        expect(r.clients[1].texts()).toHaveLength(1); // empty after cleaning: dropped
    });

    it('sends all-chat to everyone and team chat only to the sender\'s team', () => {
        const r = room(makeMap(), ['G1', 'D1', 'G2', 'D2']);
        const [g1, d1, g2, d2] = r.clients;
        g1.say('hello all');
        for (const c of r.clients) expect(c.texts()).toContain('hello all');
        g1.say('ghost secret', true);
        expect(g2.texts()).toContain('ghost secret');
        expect(g1.texts()).toContain('ghost secret');
        expect(d1.texts()).not.toContain('ghost secret');
        expect(d2.texts()).not.toContain('ghost secret');
        expect(g2.all('chat').at(-1)).toMatchObject({ team: true, dead: false, name: 'G1' });
    });

    it('rate limits a spammer on the server and recovers over time', () => {
        const r = room();
        const [a, b] = r.clients;
        for (let i = 0; i < 20; i++) a.say(`m${i}`);
        const got = b.texts().length;
        expect(got).toBeGreaterThanOrEqual(3);
        expect(got).toBeLessThanOrEqual(5);
        expect(a.all('notice').some(n => /too fast/.test(n.text))).toBe(true);
        r.run(ticks(3000));
        a.say('later');
        expect(b.texts().at(-1)).toBe('later');
    });

    it('never shows a dead player\'s messages to the living during a live round, but lets the dead talk', () => {
        const r = room(makeMap(), ['G1', 'D1', 'G2', 'D2']);
        const [g1, d1, g2, d2] = r.clients;
        r.live();
        r.run(ticks(300)); // d1 will kill g1 below: aim
        r.run(KILL_TICKS, c => (c === d1 ? KILL : null));
        expect(r.P(g1).alive).toBe(false);
        // Dead ghost speaks: all-chat and team chat both stay away from the living.
        g1.say('d1 is at the stairs');
        g1.say('d1 is at the stairs', true);
        for (const c of [d1, g2, d2]) expect(c.texts()).not.toContain('d1 is at the stairs');
        // Kill g2 too: the two dead can talk to each other.
        r.run(KILL_TICKS, c => (c === d2 ? KILL : null));
        expect(r.P(g2).alive).toBe(false);
        g2.say('hi dead', true);
        expect(g1.texts()).toContain('hi dead');
        expect(d1.texts()).not.toContain('hi dead');
        // The living can still talk to the dead.
        d1.say('gg');
        expect(g1.texts()).toContain('gg');
    });

    it('is open again between rounds (nothing left to leak)', () => {
        const r = room();
        const [a, b] = r.clients;
        r.live();
        r.run(KILL_TICKS + 1, c => (c === b ? KILL : null));
        expect(r.game.phase).toBe('over');
        a.say('gg wp');
        expect(b.texts()).toContain('gg wp');
    });
});

describe('idle handling', () => {
    /** Everyone keeps moving their view except `still`, who sends the same command every tick. */
    const except = (still: Client) => (c: Client): Partial<NetCmd> => (c === still ? {} : { pitch: (c.seq % 2) * 0.001 });

    it('never removes a ghost that stands perfectly still for a whole live round', () => {
        const r = room(makeMap(), ['G', 'D']);
        const [g] = r.clients;
        r.live();
        r.run(2, except(g)); // g's commands settle: from here nothing about them changes
        r.run(ticks(ROUND_MS) - 10, except(g));
        expect(r.P(g).alive).toBe(true);
        expect(r.P(g).idle).toBe(false);
        r.run(20, except(g));
        // The round ends by the clock and the defenders win it as normal; the ghost was never touched.
        expect(g.last('round')).toMatchObject({ phase: 'over', winner: 'defenders', reason: 'time' });
        expect(r.P(g).stats.deaths).toBe(0);
    });

    it('marks a player idle only after two whole rounds with no input change, effective at the next round start', () => {
        expect(IDLE_ROUNDS).toBe(2);
        const r = room(makeMap(), ['G1', 'D1', 'G2', 'D2']);
        const [g1, d1, g2, d2] = r.clients;
        const quiet = except(g1);
        const winRound = (): void => {
            while (r.game.phase !== 'live') r.run(1, quiet);
            r.run(KILL_TICKS + 2, c => (c === d1 || c === d2 ? KILL : quiet(c)));
            r.run(1, quiet);
        };
        r.live(); // round 1: everyone, g1 included, moved during the freeze
        winRound();
        r.run(ticks(OVER_MS) + 2, quiet);
        winRound(); // round 2: g1 quiet from the freeze on
        expect(r.P(g1).idle).toBe(false); // one quiet round is not enough
        r.run(ticks(OVER_MS) + 2, quiet);
        expect(r.P(g1).alive).toBe(true);
        winRound(); // round 3: quiet again
        expect(r.P(g1).idle).toBe(true); // flagged when the second quiet round ends
        expect(g1.all('notice').at(-1)!.text).toMatch(/2 rounds/);
        expect(r.P(g2).idle).toBe(false);
        r.run(ticks(OVER_MS) + 2, quiet);
        expect(r.game.phase).toBe('freeze');
        expect(r.P(g1).alive).toBe(false); // sits this round out
        expect(r.P(g2).alive).toBe(true);
        // Any input change clears it; they are spawned at the following round start, not mid-round.
        g1.cmd({ yaw: 1 });
        expect(r.P(g1).idle).toBe(false);
        expect(r.P(g1).alive).toBe(false);
        winRound();
        r.run(ticks(OVER_MS) + 2, quiet);
        expect(r.P(g1).alive).toBe(true);
        void d2;
    });

    it('does not count a round a player joined in the middle of', () => {
        const r = room(makeMap(), ['G', 'D']);
        r.live();
        const late = r.join('Late');
        r.run(ticks(OVER_MS));
        expect(r.P(late).quietRounds).toBe(0);
        expect(r.P(late).inRound).toBe(false);
    });
});

describe('holding a match when a team empties', () => {
    const wiggle = (c: Client): Partial<NetCmd> => ({ pitch: (c.seq % 2) * 0.001 });

    it('keeps score, stats and sides, and resumes with the next round without asking for ready', () => {
        const r = room(makeMap(), ['G', 'D', 'G2']);
        const [, d, g2] = r.clients;
        r.live();
        r.run(6 * 6 + 1, c => (c === d ? KILL : wiggle(c))); // round 1 to the defenders: both ghosts down
        expect(r.game.score[1]).toBe(1);
        const kills = r.P(d).stats.kills;
        expect(kills).toBeGreaterThanOrEqual(1);
        r.run(ticks(OVER_MS) + 2);
        expect(r.game.phase).toBe('freeze');
        r.game.leave(d.id); // the whole defender team is gone
        r.run(3);
        expect(r.game.phase).toBe('warmup');
        expect(r.game.score[1]).toBe(1); // held, not wiped
        expect(r.game.roundsPlayed).toBe(1);
        r.run(ticks(30_000));
        expect(r.game.phase).toBe('warmup');
        const back = r.join('Someone');
        expect(back.team()).toBe('defenders');
        r.run(3);
        expect(r.game.phase).toBe('freeze');
        expect(r.game.roundsPlayed).toBe(1);
        expect(g2.last('round')).toMatchObject({ round: 2, score: { ghosts: 0, defenders: 1 } });
    });

    it('does not count warmup fighting while the match is held', () => {
        const r = room(makeMap(), ['G', 'D', 'G2']);
        const [g, d] = r.clients;
        r.live();
        r.run(KILL_TICKS + 1, c => (c === d ? KILL : wiggle(c)));
        r.run(ticks(OVER_MS) + 2);
        r.game.leave(g.id);
        r.game.leave(r.clients[2].id);
        r.run(3);
        expect(r.game.phase).toBe('warmup');
        expect(r.P(d).stats.kills).toBe(1);
    });

    it('resets to a fresh lobby once the grace period has passed', () => {
        const r = room(makeMap(), ['G', 'D']);
        const [g, d] = r.clients;
        r.live();
        r.run(KILL_TICKS + 1, c => (c === d ? KILL : wiggle(c)));
        expect(r.game.score[1]).toBe(1);
        r.game.leave(d.id);
        r.run(ticks(OVER_MS + GRACE_MS) + 30, wiggle); // the hold starts when the round-over pause ends
        expect(r.game.score[1]).toBe(0);
        expect(r.game.roundsPlayed).toBe(0);
        expect(r.P(g).stats.kills + r.P(g).stats.deaths).toBe(0);
        r.join('New'); // a fresh lobby needs the usual ready-up
        r.run(30, wiggle);
        expect(r.game.phase).toBe('warmup');
    });

    it('gives a returning player their statistics and side back by name within the grace period', () => {
        const r = room(makeMap(), ['Ann', 'Bob', 'Cy']);
        const bob = r.clients[1];
        r.live();
        r.P(bob).stats.kills = 4;
        r.P(bob).stats.damage = 250;
        const team = bob.team();
        r.game.leave(bob.id);
        r.run(ticks(20_000));
        const back = r.join('Bob');
        expect(r.P(back).stats).toMatchObject({ kills: 4, damage: 250 });
        expect(back.team()).toBe(team);
    });

    it('restores nothing when two players share the name, or after the grace period', () => {
        const r = room(makeMap(), ['Ann', 'Eve', 'Eve']);
        r.live();
        for (const c of r.clients.slice(1)) r.P(c).stats.kills = 3;
        for (const c of r.clients.slice(1)) r.game.leave(c.id);
        const back = r.join('Eve');
        expect(r.P(back).stats.kills).toBe(0); // two Eves left: which one is this?

        const r2 = room(makeMap(), ['Ann', 'Bob', 'Cy']);
        const bob = r2.clients[1];
        r2.live();
        r2.P(bob).stats.kills = 4;
        r2.game.leave(bob.id);
        r2.run(ticks(GRACE_MS) + 30);
        expect(r2.P(r2.join('Bob')).stats.kills).toBe(0);

        // A name that is already connected is never given someone else's numbers.
        const r3 = room(makeMap(), ['Ann', 'Bob', 'Cy']);
        const b3 = r3.clients[1];
        r3.live();
        r3.P(b3).stats.kills = 4;
        r3.game.leave(b3.id);
        const first = r3.join('Bob');
        const second = r3.join('Bob');
        expect(r3.P(first).stats.kills).toBe(4);
        expect(r3.P(second).stats.kills).toBe(0);
    });
});

describe('damage events', () => {
    const dmgs = (c: Client): DamageMsg[] => c.all('dmg');

    it('tells a hit ghost the bearing of the shot and tells the shooter the hit landed', () => {
        const r = room();
        const [ghost, defender] = r.clients;
        r.live();
        r.run(1, c => (c === defender ? { fire: true, pitch: -0.03 } : null));
        const d = dmgs(ghost)[0];
        // The defender is at -Z of the ghost: bearing 0 faces -Z.
        expect(d.dir).toBeCloseTo(0, 5);
        expect(d).toMatchObject({ amount: 34, kind: 'shot', weapon: 0 }); // the rifle's slot
        expect(d.killed).toBeUndefined();
        expect(defender.last('hitconfirm')).toEqual({ type: 'hitconfirm', kind: 'shot', zone: 'torso', kill: false });
        r.run(ticks(3000)); // recoil recovers in commands, so keep sending them
        r.run(1, c => (c === defender ? { fire: true } : null));
        const k = dmgs(ghost).at(-1)!;
        expect(k).toMatchObject({ killed: true, by: defender.id, kind: 'shot', zone: 'head', amount: 66 });
        expect(k.dist).toBeCloseTo(20, 0);
        expect(defender.last('hitconfirm')).toEqual({ type: 'hitconfirm', kind: 'shot', zone: 'head', kill: true });
    });

    it('confirms a knife hit with its kind and no zone', () => {
        const r = room(makeMap(-8.5, -10));
        const [ghost, defender] = r.clients;
        r.live();
        r.run(14, c => (c === ghost ? { fire: true } : {}));
        expect(ghost.last('hitconfirm')).toEqual({ type: 'hitconfirm', kind: 'knife', kill: false });
        expect(defender.all('dmg')[0]).toMatchObject({ amount: 55, kind: 'knife' });
        expect(defender.all('dmg')[0].zone).toBeUndefined();
    });

    it('gives a defender hit by a knife only a bearing and amount, never a position', () => {
        const r = room(makeMap(-8.5, -10));
        const [ghost, defender] = r.clients;
        r.live();
        r.run(14, c => (c === ghost ? { fire: true } : {}));
        const d = dmgs(defender)[0];
        // Ghost is at +Z of the defender: bearing pi.
        expect(Math.abs(d.dir)).toBeCloseTo(Math.PI, 1);
        expect(Object.keys(d).sort()).toEqual(['amount', 'dir', 'kind', 'type']);
        r.run(ticks(1500), c => (c === ghost ? { fire: true } : {}));
        const k = dmgs(defender).find(m => m.killed)!;
        expect(k.dist!).toBeLessThanOrEqual(KNIFE_RANGE + 0.1);
        expect(k.dist!).toBeLessThan(BREATH_RANGE); // already inside what the defender may know
        // Anything sent to the defender stays inside what knowsAbout allows: no message carries a ghost position beyond range.
        for (const m of defender.inbox) {
            if (m.type === 'snap') for (const p of m.players) {
                if (p.team !== 'ghosts') continue;
                const me = m.me.pos;
                expect(Math.hypot(p.pos[0] - me[0], p.pos[2] - me[2])).toBeLessThanOrEqual(BREATH_RANGE + 1);
            }
        }
    });

    it('does not change what a defender is sent about a distant, hidden ghost when another player is hit', () => {
        const r = room(makeMap(), ['G1', 'D1', 'G2', 'D2']);
        const [g1, d1, , d2] = r.clients;
        r.live();
        r.run(60);
        r.run(1, c => (c === d1 ? { fire: true, pitch: -0.03 } : null));
        expect(dmgs(g1).length).toBeGreaterThan(0);
        // d2 saw nothing about g1 or g2 (they stand still at 20 m, vis 0), and got no damage message at all.
        expect(dmgs(d2)).toHaveLength(0);
        const snap = d2.last('snap');
        expect(snap.players.filter(p => p.team === 'ghosts')).toHaveLength(0);
    });
});

describe('anything the server sends outside the match is JSON', () => {
    it('keeps new messages free of positions', () => {
        const r = room();
        r.live();
        r.run(5);
        r.clients[0].say('x');
        for (const c of r.clients) {
            for (const m of c.inbox as (ServerMsg | ChatMsg)[]) {
                if (m.type === 'chat' || m.type === 'dmg' || m.type === 'hitconfirm' || m.type === 'notice') {
                    expect(JSON.stringify(m)).not.toMatch(/"pos"/);
                }
            }
        }
    });
});
