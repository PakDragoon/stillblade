import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../shared/constants';
import { NavGraph } from '../../shared/nav';
import type { NetCmd, ServerMsg, Team } from '../../shared/protocol';
import { DEFAULT_ROOM_OPTIONS, type RoomOptions } from '../../shared/room-options';
import { insideSite } from '../../shared/rules';
import type { MapData, Vec3 } from '../../shared/types';
import { BotBrain, siteNodes } from './bots';
import { Game, type Player } from './game';
import { loadMaps } from './maps';
import { Rooms } from './rooms';

const MAPS = loadMaps(fileURLToPath(new URL('../../client/public/maps', import.meta.url)));
const MAP_IDS = ['greybox', 'warehouse'];
const TICK_MS = 1000 / TICK_RATE;

/** A person's connection that records what it is sent. */
function client(): { send(m: ServerMsg): void; msgs: ServerMsg[] } {
    const msgs: ServerMsg[] = [];
    return { msgs, send: m => { msgs.push(m); } };
}

/** Runs `game` for `ticks` ticks from its current time; `each` runs after every tick and may stop the run by returning true. */
function run(game: Game, ticks: number, each?: (t: number) => boolean | void): number {
    const start = Math.round(game.now / TICK_MS);
    for (let t = 1; t <= ticks; t++) {
        game.tick((start + t) * TICK_MS);
        if (each?.(t)) return t;
    }
    return ticks;
}

const knows = (game: Game, viewer: Player, other: Player): boolean =>
    (game as unknown as { knowsAbout(a: Player, b: Player): boolean }).knowsAbout(viewer, other);

const idle = (seq: number, yaw = 0): NetCmd => ({
    seq, forward: 0, right: 0, yaw, pitch: 0, jump: false, walk: false, crouch: false, fire: false, use: false,
    reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: 0
});

describe('navigation graph in the map files', () => {
    for (const id of MAP_IDS) {
        it(`${id}: every spawn has a path to every bomb site`, () => {
            const map = MAPS.get(id)!;
            expect(map.nav, 'rebuild the map: npm run map -- ' + id).toBeDefined();
            const nav = new NavGraph(map.nav!);
            expect(nav.count).toBeGreaterThan(500);
            const sites = siteNodes(map, nav);
            expect(sites.length).toBe(map.bombSites.length);
            const path: number[] = [];
            for (const team of ['ghosts', 'defenders'] as const) {
                for (const spawn of map.spawns[team]) {
                    const start = nav.nearest(spawn.pos);
                    expect(start).toBeGreaterThanOrEqual(0);
                    for (const nodes of sites) {
                        expect(nodes.length).toBeGreaterThan(0);
                        expect(nav.findPath(start, nodes[0], path)).toBe(true);
                        const end: Vec3 = [nav.x[path.at(-1)!], nav.y[path.at(-1)!], nav.z[path.at(-1)!]];
                        expect(insideSite(end, map)).toBe(true);
                    }
                }
            }
        });
    }
});

/** A bot's view of a hidden still ghost, and of everything else, comes only from its messages. */
describe('bots use only what their team is sent', () => {
    it('a defender bot never fires unless its last snapshot showed it a living ghost, and keeps only copies of what it was sent', () => {
        const game = new Game(MAPS.get('greybox')!, { options: { botLevel: 'hard' } });
        game.code = 'info-test';
        for (let i = 0; i < 4; i++) { game.addBot('ghosts'); game.addBot('defenders'); }
        const bots = [...game.players.values()];
        // Every shot fired by a defender bot: its newest snapshot (copied when it arrived) must have held a living ghost
        // that the server's knowsAbout let through.
        const lastSnap = new Map<number, Set<number>>();
        let shots = 0, checked = 0;
        for (const p of bots) {
            const brain = p.brain!;
            const deliver = brain.conn.send;
            brain.conn.send = (m: ServerMsg) => {
                if (m.type === 'snap') {
                    const ghosts = new Set<number>();
                    for (const s of m.players) {
                        const o = game.players.get(s.id)!;
                        // What arrives is exactly the knowsAbout filter at this moment.
                        expect(knows(game, p, o)).toBe(true);
                        if (s.team !== p.team && s.alive) ghosts.add(s.id);
                    }
                    lastSnap.set(p.id, ghosts);
                }
                if (m.type === 'shot' && m.shooter === p.id) {
                    shots++;
                    expect((lastSnap.get(p.id)?.size ?? 0) > 0, 'shot with no enemy in its last snapshot').toBe(true);
                    checked++;
                }
                deliver(m);
            };
        }
        run(game, 120 * TICK_RATE, () => {
            // The picture in each brain matches what was sent and is not a live reference to the real player.
            for (const p of bots) {
                for (const c of (p.brain!.view as unknown as { contacts: Map<number, { pos: Vec3 }> }).contacts.values()) {
                    const real = [...game.players.values()].find(o => o.state.pos === c.pos);
                    expect(real, 'a contact position is the live position array of a player').toBeUndefined();
                }
            }
        });
        expect(shots).toBeGreaterThan(0);
        expect(checked).toBe(shots);
    }, 30_000); // two minutes of an eight-bot round with a check after every tick

    it('a still ghost behind a wall and out of breathing range is never known, aimed at or shot by a defender bot', () => {
        const map = MAPS.get('warehouse')!;
        const game = new Game(map, { rounds: false, options: { botLevel: 'hard' } });
        game.code = 'hidden';
        const defenderId = game.addBot('defenders');
        const ghostConn = client();
        const ghostId = game.join(ghostConn, 'Hidden', { team: 'ghosts' });
        const defender = game.players.get(defenderId)!, ghost = game.players.get(ghostId)!;
        // Put the ghost somewhere the defender cannot see and is more than 8 m away from (checked, not assumed).
        const nav = game.nav!;
        let spot = -1;
        for (let n = 0; n < nav.count && spot < 0; n += 7) {
            ghost.state.pos[0] = nav.x[n]; ghost.state.pos[1] = nav.y[n]; ghost.state.pos[2] = nav.z[n];
            if (Math.hypot(nav.x[n] - defender.state.pos[0], nav.z[n] - defender.state.pos[2]) > 15 && !knows(game, defender, ghost)) spot = n;
        }
        expect(spot).toBeGreaterThanOrEqual(0);
        const where: Vec3 = [nav.x[spot], nav.y[spot], nav.z[spot]];
        let seq = 0, shots = 0;
        const deliver = defender.brain!.conn.send;
        defender.brain!.conn.send = m => { if (m.type === 'shot') shots++; deliver(m); };
        run(game, 30 * TICK_RATE, () => {
            // The ghost stands perfectly still where it was put; the defender wanders as it likes.
            ghost.state.pos[0] = where[0]; ghost.state.pos[1] = where[1]; ghost.state.pos[2] = where[2];
            ghost.state.vel[0] = ghost.state.vel[1] = ghost.state.vel[2] = 0;
            game.handleCmd(ghostId, idle(++seq));
            if (knows(game, defender, ghost)) return true; // the defender walked into breathing range or sight: stop here
        });
        // Whatever happened, while the ghost was unknown the bot never had it in its picture.
        const view = defender.brain!.view as unknown as { contacts: Map<number, unknown> };
        if (!knows(game, defender, ghost)) expect(view.contacts.has(ghostId)).toBe(false);
        expect(shots).toBe(0);
        expect(ghost.health).toBe(100);
    });

    it('a defender bot learns of a dropped bomb only from the bomb message sent while it is in sight', () => {
        const game = new Game(MAPS.get('greybox')!, {});
        game.code = 'bomb-sight';
        const d = game.addBot('defenders');
        const g = game.addBot('ghosts');
        run(game, 10);
        const defender = game.players.get(d)!;
        const view = defender.brain!.view;
        const sent: (Vec3 | null)[] = [];
        const deliver = defender.brain!.conn.send;
        defender.brain!.conn.send = m => { if (m.type === 'bomb') sent.push(m.dropped); deliver(m); };
        run(game, 40 * TICK_RATE, () => {
            const last = sent.length ? sent[sent.length - 1] : null;
            expect(view.dropped).toEqual(last);
            expect(view.carrier).toBe(0); // never told who carries it
        });
        void g;
    });
});

/** A ghost team of bots and a defender that does nothing: the carrier must reach the chosen site and plant there. */
describe('bots reach both sites, plant and defuse', () => {
    for (const id of MAP_IDS) {
        const map = MAPS.get(id)!;
        for (let site = 0; site < map.bombSites.length; site++) {
            it(`${id}: a ghost bot carries the bomb to site ${map.bombSites[site].name} and plants it`, { timeout: 20_000 }, () => {
                const game = new Game(map, { options: { botLevel: 'easy' } });
                game.code = `plant-${id}-${site}`;
                game.addBot('ghosts');
                const still = client();
                const defenderId = game.join(still, 'Still', { team: 'defenders' });
                let seq = 0;
                const sites = (game as unknown as { teamSites: Record<Team, number> }).teamSites;
                const done = run(game, 140 * TICK_RATE, () => {
                    sites.ghosts = site; // the team's plan, fixed for the test
                    const me = game.players.get(defenderId)!;
                    // The defender stays in its spawn, looking at the floor (never sees anyone).
                    game.handleCmd(defenderId, { ...idle(++seq), pitch: -1.5, yaw: me.yaw });
                    return game.phase === 'planted';
                });
                expect(game.phase, `no plant within ${(done / TICK_RATE).toFixed(0)} s`).toBe('planted');
                const s = map.bombSites[site];
                const b = game.bomb!;
                expect(b[0] >= s.min[0] && b[0] <= s.max[0] && b[2] >= s.min[2] && b[2] <= s.max[2]).toBe(true);
            });

            it(`${id}: a defender bot goes to a bomb planted on site ${map.bombSites[site].name} and defuses it`, { timeout: 20_000 }, () => {
                const game = new Game(map, { options: { botLevel: 'easy' } });
                game.code = `defuse-${id}-${site}`;
                game.addBot('defenders');
                const ghostConn = client();
                const ghostId = game.join(ghostConn, 'Planter', { team: 'ghosts' });
                const ghost = game.players.get(ghostId)!;
                let seq = 0;
                run(game, 5 * TICK_RATE); // freeze over, round live
                expect(game.phase).toBe('live');
                // The bomb goes down in the site (set up directly: planting itself is covered above and in
                // bomb-carrier.test.ts; a 3 s plant in view of the bot would only get the planter shot).
                const nav = game.nav!;
                const n = siteNodes(map, nav)[site][0];
                ghost.state.pos[0] = nav.x[n]; ghost.state.pos[1] = nav.y[n]; ghost.state.pos[2] = nav.z[n];
                (game as unknown as { plant(p: Player): void }).plant(ghost);
                expect(game.phase).toBe('planted');
                // The ghost leaves to its spawn and stays still there; the defender bot has to find the bomb and defuse it.
                const sp = map.spawns.ghosts[0].pos;
                ghost.state.pos[0] = sp[0]; ghost.state.pos[1] = sp[1]; ghost.state.pos[2] = sp[2];
                let reason = '';
                run(game, 36 * TICK_RATE, () => {
                    game.handleCmd(ghostId, idle(++seq));
                    if (game.phase === 'over') { reason = (game as unknown as { reason: string }).reason; return true; }
                });
                expect(reason).toBe('defused');
            });
        }
    }
});

describe('bot matches are deterministic', () => {
    it('two runs of the same room give the same result, tick for tick', { timeout: 20_000 }, () => {
        const result = (): string => {
            const game = new Game(MAPS.get('greybox')!, {});
            game.code = 'same';
            for (let i = 0; i < 3; i++) { game.addBot('ghosts'); game.addBot('defenders'); }
            run(game, 50 * TICK_RATE);
            return JSON.stringify([...game.players.values()].map(p => [p.state.pos, p.health, p.stats])) + game.score.join();
        };
        expect(result()).toBe(result());
    });
});

describe('fill with bots', () => {
    const room = (options: Partial<RoomOptions>): { rooms: Rooms; join(name: string): { id: number; conn: ReturnType<typeof client> } } => {
        const rooms = new Rooms(MAPS, 'greybox');
        return {
            rooms,
            join(name: string) {
                const conn = client();
                const r = rooms.join('fill', 'greybox', conn, name, 0, { ...DEFAULT_ROOM_OPTIONS, ...options });
                if (!r.ok) throw new Error(r.reason);
                return { id: r.id, conn };
            }
        };
    };
    const bots = (g: Game, team?: Team): Player[] => [...g.players.values()].filter(p => p.bot && (!team || p.team === team));

    it('keeps both teams at half the room size, marks bots in the roster and lets people take their places', () => {
        const r = room({ fillBots: true, maxPlayers: 6 });
        const a = r.join('Ann');
        const game = r.rooms.rooms.get('fill')!;
        expect(game.players.size).toBe(6);
        expect(bots(game, 'ghosts').length).toBe(2);
        expect(bots(game, 'defenders').length).toBe(3);
        const roster = a.conn.msgs.filter(m => m.type === 'roster').at(-1) as Extract<ServerMsg, { type: 'roster' }>;
        expect(roster.players.filter(p => p.bot).length).toBe(5);
        for (const p of roster.players.filter(p => p.bot)) expect(p.name.startsWith('BOT ')).toBe(true);
        expect(roster.players.find(p => p.id === a.id)!.bot).toBe(false);
        // Bots are never the creator and never fill the room for people.
        expect(game.creatorId).toBe(a.id);
        for (let i = 0; i < 5; i++) r.join(`P${i}`);
        expect(game.humanCount()).toBe(6);
        expect(bots(game).length).toBe(0);
        expect(game.players.size).toBe(6);
        // A seventh person is refused: the room is full of people.
        expect(r.rooms.join('fill', null, client(), 'Late', 0).ok).toBe(false);
        // People leave in warmup: bots come back.
        for (const p of [...game.players.values()].filter(p => p.id !== a.id).slice(0, 3)) r.rooms.leave('fill', p.id);
        expect(game.players.size).toBe(6);
        expect(bots(game).length).toBe(3);
        // The last person leaves: the room closes, bots do not keep it open.
        for (const p of [...game.players.values()].filter(p => !p.bot)) r.rooms.leave('fill', p.id);
        expect(r.rooms.rooms.has('fill')).toBe(false);
    });

    it('a person who joins mid-round takes a bot\'s place at the next round start', () => {
        const r = room({ fillBots: true, maxPlayers: 4 });
        const a = r.join('Ann');
        const game = r.rooms.rooms.get('fill')!;
        game.handleMessage(a.id, { type: 'start' });
        run(game, 2 * TICK_RATE);
        expect(game.phase).toBe('freeze');
        r.join('Bob');
        expect(game.players.size).toBe(5); // the bot stays for this round
        // Next round start: back to two a side.
        run(game, 200 * TICK_RATE, () => game.roundsPlayed >= 1 && game.phase === 'freeze');
        expect(game.players.size).toBe(4);
        expect(game.humanCount()).toBe(2);
    });

    it('turning the option off removes the bots; bots never vote or sit out as idle', () => {
        const r = room({ fillBots: true, maxPlayers: 4 });
        const a = r.join('Ann');
        const game = r.rooms.rooms.get('fill')!;
        expect(bots(game).length).toBe(3);
        game.handleMessage(a.id, { type: 'options', options: { fillBots: false } });
        expect(bots(game).length).toBe(0);
        game.handleMessage(a.id, { type: 'options', options: { fillBots: true, botLevel: 'hard' } });
        expect(bots(game).length).toBe(3);
        for (const b of bots(game)) expect(b.brain!.level).toBe('hard');
        // Votes: a bot is not a player who can be voted on or vote.
        game.handleMessage(a.id, { type: 'votekick', target: bots(game)[0].id });
        expect((game as unknown as { kickVote: { active: unknown } }).kickVote.active).toBeNull();
    });

    it('does nothing on a map without a navigation graph', () => {
        const map: MapData = { ...MAPS.get('greybox')!, nav: undefined, name: 'greybox' };
        const game = new Game(map, { lobby: true, options: { fillBots: true } });
        game.join(client(), 'Ann');
        expect(game.players.size).toBe(1);
    });
});

describe('practice range', () => {
    it('a private solo room with targets on the other side, reserves kept full, damage and zone reported per hit', () => {
        const rooms = new Rooms(MAPS, 'greybox');
        const conn = client();
        const r = rooms.join('practice-test', 'warehouse', conn, 'Ann', 0, DEFAULT_ROOM_OPTIONS, 'defenders');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const game = r.game;
        const welcome = conn.msgs.find(m => m.type === 'welcome') as Extract<ServerMsg, { type: 'welcome' }>;
        expect(welcome.practice).toBe(true);
        expect(welcome.team).toBe('defenders');
        expect(game.options.public).toBe(false);
        const targets = [...game.players.values()].filter(p => p.bot);
        expect(targets.length).toBe(5);
        for (const t of targets) expect(t.team).toBe('ghosts');
        // Nobody else gets in.
        expect(rooms.join('practice-test', null, client(), 'Bob', 0).ok).toBe(false);

        // Rounds are off; targets stand where they were placed and are fully visible.
        run(game, 30);
        expect(game.phase).toBe('warmup');
        const me = game.players.get(r.id)!;
        for (const t of targets) expect(t.vis).toBe(1);
        // Empty the rifle at the nearest static target, reload, keep going: the reserve never drops.
        const target = targets[0];
        const eye: Vec3 = [me.state.pos[0], me.eyeY, me.state.pos[2]];
        let seq = 0, hits = 0;
        for (let i = 0; i < 400; i++) {
            const tp = target.state.pos;
            const dx = tp[0] - eye[0], dz = tp[2] - eye[2], dy = tp[1] + 1.2 - eye[1];
            const yaw = Math.fround(Math.atan2(-dx, -dz)), pitch = Math.fround(Math.atan2(dy, Math.hypot(dx, dz)));
            game.handleCmd(r.id, { ...idle(++seq, yaw), pitch, fire: i % 2 === 0, viewTime: game.now });
            game.tick(game.now + TICK_MS);
            expect(me.loadout.guns[0].reserve).toBe(90);
        }
        for (const m of conn.msgs) {
            if (m.type !== 'hitconfirm') continue;
            hits++;
            expect(m.damage).toBeGreaterThan(0);
            expect(m.zone).toBeDefined();
        }
        expect(hits).toBeGreaterThan(0);

        // Switching side moves the targets to the other team.
        game.handleMessage(r.id, { type: 'team' });
        expect(me.team).toBe('ghosts');
        const after = [...game.players.values()].filter(p => p.bot);
        expect(after.length).toBe(5);
        for (const t of after) expect(t.team).toBe('defenders');
        // Moving targets move, static ones do not, and none of them fires.
        const start = new Map(after.map(t => [t.id, [...t.state.pos]]));
        let shots = 0;
        const d2 = conn.send;
        conn.send = m => { if (m.type === 'shot') shots++; d2(m); };
        run(game, 3 * TICK_RATE);
        const moved = after.filter(t => Math.hypot(t.state.pos[0] - start.get(t.id)![0], t.state.pos[2] - start.get(t.id)![2]) > 0.5);
        expect(moved.length).toBe(2);
        expect(shots).toBe(0);
    });
});

describe('BotBrain', () => {
    it('produces strictly increasing commands without a map graph, and does nothing then', () => {
        const brain = new BotBrain('player', 'normal', 7);
        const self = {
            id: 1, team: 'ghosts' as Team, alive: true, state: { pos: [0, 0, 0] as Vec3, vel: [0, 0, 0] as Vec3, onGround: true, crouched: false },
            loadout: game0().players.values().next().value!.loadout, knife: { cooldown: 0, windup: 0 }, carry: { carrier: false, wait: 0 }, health: 100
        };
        const world = { map: MAPS.get('greybox')!, nav: null, clearLine: () => true, teamSite: () => 0 };
        const a = brain.think(self, world).seq;
        const c = brain.think(self, world);
        expect(c.seq).toBe(a + 1);
        expect(c.forward).toBe(0);
        expect(c.fire).toBe(false);
    });
});

function game0(): Game {
    const g = new Game(MAPS.get('greybox')!, { rounds: false });
    g.join(client(), 'X');
    return g;
}
