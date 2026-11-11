import { describe, expect, it } from 'vitest';
import {
    BODY_DAMAGE, EYE_HEIGHT, GHOST_MAX_VIS, KNIFE_BACKSTAB_DAMAGE, KNIFE_DAMAGE, KNIFE_WINDUP_TICKS, MAX_HEALTH,
    RESPAWN_MS, RUN_SPEED, TICK_RATE, VIS_SWING_SPIKE
} from '../../shared/constants';
import type { NetCmd, ServerMsg, ShotEvent, SlashEvent, SoundEvent } from '../../shared/protocol';
import {
    BOMB_MS, DEFUSE_TICKS, FREEZE_MS, HALFTIME_ROUND, MATCH_OVER_MS, OVER_MS, PLANT_TICKS, ROUNDS_TO_WIN, ROUND_MS
} from '../../shared/rules';
import type { Box, MapData } from '../../shared/types';
import { Game } from './game';

const TICK_MS = 1000 / TICK_RATE;

/** Ghost faces -Z, defender faces +Z: by default they look straight at each other along Z. */
function makeMap(extra: Box[] = [], ghostZ = 10, defenderZ = -10): MapData {
    return {
        name: 'test',
        bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
        boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }, ...extra],
        spawns: { ghosts: [{ pos: [0, 0, ghostZ], yaw: 0 }], defenders: [{ pos: [0, 0, defenderZ], yaw: 180 }] },
        bombSites: []
    };
}

class Client {
    readonly inbox: ServerMsg[] = [];
    readonly id: number;
    yaw = 0;
    private seq = 0;
    constructor(private readonly game: Game, name = '') {
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
            fire: false, use: false, viewTime: this.game.now, ...over
        });
    }
    last<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }> {
        const m = this.inbox.findLast(x => x.type === type);
        if (!m) throw new Error(`no ${type} message`);
        return m as Extract<ServerMsg, { type: T }>;
    }
    all<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }>[] {
        return this.inbox.filter(m => m.type === type) as Extract<ServerMsg, { type: T }>[];
    }
    shots(): ShotEvent[] { return this.all('shot'); }
    slashes(): SlashEvent[] { return this.all('slash'); }
    sounds(kind: SoundEvent['kind']): SoundEvent[] { return this.all('sound').filter(s => s.kind === kind); }
}

/** `rounds` off keeps the match in warmup, so the core mechanics can be tested without round flow. */
function setup(map: MapData = makeMap(), rounds = false) {
    const game = new Game(map, { rounds });
    const ghost = new Client(game);
    const defender = new Client(game);
    let ticks = 0;
    /** Advances the server; every tick each client sends one command built by `each`. */
    const run = (n: number, each: (c: Client) => Partial<NetCmd> | null = () => ({})): void => {
        for (let i = 0; i < n; i++) {
            game.tick(++ticks * TICK_MS);
            for (const c of [ghost, defender]) {
                const over = each(c);
                if (over) c.cmd(over);
            }
        }
    };
    run(30); // settle onto the floor
    return { game, ghost, defender, run, G: game.players.get(ghost.id)!, D: game.players.get(defender.id)!, clients: [ghost, defender] };
}

// Eye is at 1.62 m; aiming slightly down lands in the body, below the head zone.
const BODY_AIM = { fire: true, pitch: -0.03 };

describe('core rules', () => {
    it('puts the first two players on opposite teams and spawns them', () => {
        const { ghost, defender, D } = setup();
        expect(ghost.last('welcome').team).toBe('ghosts');
        expect(defender.last('welcome').team).toBe('defenders');
        expect(ghost.last('spawn').pos).toEqual([0, 0, 10]);
        expect(D.alive).toBe(true);
    });

    it('simulates movement authoritatively and acknowledges commands', () => {
        const { ghost, run } = setup();
        run(120, c => (c === ghost ? { forward: 1 } : {}));
        const snap = ghost.last('snap');
        expect(snap.ack).toBeGreaterThanOrEqual(148); // the last snapshot may predate the final command
        expect(snap.me.pos[2]).toBeLessThan(10 - RUN_SPEED * 1.5);
        expect(snap.players).toHaveLength(1);
        expect(snap.players[0].pos[2]).toBeCloseTo(-10, 5);
    });

    it('refuses to simulate faster than real time', () => {
        const { ghost, run, G } = setup();
        const before = G.state.pos[2];
        for (let i = 0; i < 300; i++) ghost.cmd({ forward: 1 });
        run(1, () => null);
        expect(before - G.state.pos[2]).toBeLessThan(RUN_SPEED * (13 / TICK_RATE));
        expect(ghost.last('snap').ack).toBeLessThan(30 + 13);
    });

    it('ignores malformed commands', () => {
        const { ghost, G } = setup();
        const before = [...G.state.pos];
        ghost.cmd({ forward: NaN });
        ghost.cmd({ yaw: Infinity });
        ghost.cmd({ seq: -5, forward: 1 });
        expect(G.state.pos).toEqual(before);
    });
});

describe('defender gun', () => {
    it('registers a body shot, then kills and respawns', () => {
        const { ghost, defender, run, G } = setup();
        run(1, c => (c === defender ? BODY_AIM : {}));
        expect(G.health).toBe(MAX_HEALTH - BODY_DAMAGE);
        const shot = ghost.shots().at(-1)!;
        expect(shot).toMatchObject({ shooter: defender.id, victim: ghost.id, head: false, damage: BODY_DAMAGE });
        expect(shot.to[2]).toBeCloseTo(10 - 0.3, 3);

        run(30, c => (c === defender ? BODY_AIM : {}));
        expect(G.alive).toBe(false);
        expect(defender.shots().some(s => s.killed)).toBe(true);
        const deadPos = [...G.state.pos];
        run(10, c => (c === ghost ? { forward: 1 } : {}));
        expect(G.state.pos).toEqual(deadPos); // the dead do not move

        run(Math.ceil(RESPAWN_MS / TICK_MS) + 1);
        expect(G.alive).toBe(true);
        expect(G.health).toBe(MAX_HEALTH);
    });

    it('scores a headshot when the ray enters the head zone', () => {
        const { ghost, defender, run, G } = setup();
        expect(EYE_HEIGHT).toBeGreaterThan(1.8 - 0.28); // level aim from eye height is a headshot
        run(1, c => (c === defender ? { fire: true } : {}));
        expect(defender.shots().at(-1)).toMatchObject({ victim: ghost.id, head: true, killed: true });
        expect(G.alive).toBe(false);
    });

    it('hits a ghost that is completely invisible', () => {
        const { defender, run, G } = setup();
        expect(G.vis).toBe(0);
        run(1, c => (c === defender ? BODY_AIM : {}));
        expect(defender.shots().at(-1)!.victim).toBe(G.id);
    });

    it('enforces the fire rate', () => {
        const { defender, run } = setup();
        run(60, c => (c === defender ? { fire: true, pitch: 0.5 } : {})); // 1 s of holding fire at the sky
        expect(defender.shots().length).toBeGreaterThanOrEqual(9);
        expect(defender.shots().length).toBeLessThanOrEqual(11);
    });

    it('stops bullets at walls', () => {
        const { defender, run, G } = setup(makeMap([{ min: [-5, 0, -1], max: [5, 4, 1] }]));
        run(1, c => (c === defender ? { fire: true } : {}));
        const shot = defender.shots().at(-1)!;
        expect(shot.victim).toBeUndefined();
        expect(shot.to[2]).toBeCloseTo(-1, 3);
        expect(G.health).toBe(MAX_HEALTH);
    });

    it('rewinds targets to what the shooter saw (lag compensation)', () => {
        const { game, ghost, defender, run, G } = setup();
        const seenAt = game.now;
        // The ghost strafes for 150 ms: far enough to leave the line of fire.
        run(9, c => (c === ghost ? { right: 1 } : {}));
        expect(Math.abs(G.state.pos[0])).toBeGreaterThan(0.31);

        // Shooting at the present misses...
        run(1, c => (c === defender ? BODY_AIM : { right: 1 }));
        expect(defender.shots().at(-1)!.victim).toBeUndefined();

        // ...but a shot aimed at where the shooter's screen showed the target still lands.
        run(6, c => (c === ghost ? { right: 1 } : {}));
        run(1, c => (c === defender ? { ...BODY_AIM, viewTime: seenAt } : {}));
        expect(defender.shots().at(-1)!.victim).toBe(ghost.id);
    });

    it('will not rewind further than the cap', () => {
        const { ghost, defender, run } = setup();
        const seenAt = defender.last('snap').time;
        run(60, c => (c === ghost ? { right: 1 } : {}));
        run(1, c => (c === defender ? { ...BODY_AIM, viewTime: seenAt } : {}));
        expect(defender.shots().at(-1)!.victim).toBeUndefined();
    });
});

describe('ghost visibility', () => {
    it('is zero when still, rises to the cap at a run, and fades after stopping', () => {
        const { ghost, run, G } = setup();
        expect(G.vis).toBe(0);
        run(60, c => (c === ghost ? { right: 1 } : {}));
        expect(G.vis).toBeCloseTo(GHOST_MAX_VIS, 2);
        run(6, () => ({}));
        expect(G.vis).toBeGreaterThan(0.1); // stopping does not hide a ghost instantly
        run(120, () => ({}));
        expect(G.vis).toBe(0);
    });

    it('is lower when walking or crouching than when running', () => {
        const { ghost, run, G } = setup();
        run(60, c => (c === ghost ? { right: 1, walk: true } : {}));
        const walking = G.vis;
        run(60, c => (c === ghost ? { right: 1, crouch: true } : {}));
        const crouching = G.vis;
        expect(walking).toBeGreaterThan(0.05);
        expect(walking).toBeLessThan(GHOST_MAX_VIS * 0.6);
        expect(crouching).toBeLessThan(walking);
        expect(crouching).toBeGreaterThan(0);
    });

    it('keeps defenders fully visible to ghosts', () => {
        const { ghost, defender } = setup();
        expect(ghost.last('snap').players).toMatchObject([{ id: defender.id, vis: 1 }]);
    });
});

describe('information culling', () => {
    const ghostSeenBy = (c: Client, id: number) => c.last('snap').players.find(p => p.id === id);

    it('does not tell a defender where a motionless ghost is, even in plain view', () => {
        const { ghost, defender } = setup();
        expect(ghostSeenBy(defender, ghost.id)).toBeUndefined();
    });

    it('reveals a moving ghost in line of sight, with its visibility', () => {
        const { ghost, defender, run } = setup();
        run(40, c => (c === ghost ? { right: 1 } : {}));
        const seen = ghostSeenBy(defender, ghost.id)!;
        expect(seen.vis).toBeGreaterThan(0.3);
        expect(seen.pos[0]).toBeGreaterThan(1);
    });

    it('hides a moving ghost that is behind a wall', () => {
        const { ghost, defender, run } = setup(makeMap([{ min: [-30, 0, -1], max: [30, 4, 1] }]));
        run(40, c => (c === ghost ? { right: 1 } : {}));
        expect(ghostSeenBy(defender, ghost.id)).toBeUndefined();
    });

    it('reveals a motionless ghost within breathing range, even through a wall', () => {
        const wall: Box = { min: [-30, 0, -6.2], max: [30, 4, -6] };
        const { ghost, defender } = setup(makeMap([wall], -4));
        expect(ghostSeenBy(defender, ghost.id)).toMatchObject({ vis: 0 });
    });
});

describe('footsteps', () => {
    it('are heard by a defender within range of a running ghost, about every 2 m', () => {
        const { ghost, defender, run } = setup(makeMap([], 2));
        run(120, c => (c === ghost ? { right: 1 } : {}));
        const steps = defender.sounds('step');
        expect(steps.length).toBeGreaterThanOrEqual(4);
        expect(steps.length).toBeLessThanOrEqual(6);
        expect(steps[0]).toMatchObject({ id: ghost.id, loud: 1 });
        expect(ghost.sounds('step')).toHaveLength(0); // a player's own steps are not echoed back
    });

    it('are not sent beyond earshot', () => {
        const { ghost, defender, run } = setup(); // 20 m apart, steps carry 18 m
        run(60, c => (c === ghost ? { right: 1 } : {}));
        expect(defender.sounds('step')).toHaveLength(0);
    });

    it('carry far less when walking quietly', () => {
        const { ghost, defender, run } = setup(makeMap([], -2)); // 8 m apart
        run(180, c => (c === ghost ? { right: 1, walk: true } : {}));
        expect(defender.sounds('step')).toHaveLength(0); // quiet steps carry 5.4 m
    });
});

describe('ghost knife', () => {
    // Ghost 1.5 m in front of the defender, face to face.
    const close = () => setup(makeMap([], -8.5));

    it('warns with a windup, then lands a frontal slash after the delay', () => {
        const { ghost, defender, run, G, D } = close();
        run(1, c => (c === ghost ? { fire: true } : {}));
        expect(defender.sounds('windup')).toHaveLength(1);
        expect(G.vis).toBeGreaterThanOrEqual(VIS_SWING_SPIKE - 0.05); // swinging exposes the ghost
        expect(D.health).toBe(MAX_HEALTH);

        run(KNIFE_WINDUP_TICKS - 1);
        expect(defender.slashes()).toHaveLength(0);
        run(1);
        expect(defender.slashes()).toMatchObject([{ attacker: ghost.id, victim: defender.id, damage: KNIFE_DAMAGE, backstab: false }]);
        expect(D.health).toBe(MAX_HEALTH - KNIFE_DAMAGE);
    });

    it('kills in one hit from behind', () => {
        const { ghost, defender, run, D } = close();
        run(1, c => (c === defender ? { yaw: 0 } : {})); // defender turns its back
        run(KNIFE_WINDUP_TICKS + 1, c => (c === ghost ? { fire: true } : { yaw: 0 }));
        expect(ghost.slashes().at(-1)).toMatchObject({ victim: defender.id, damage: KNIFE_BACKSTAB_DAMAGE, backstab: true, killed: true });
        expect(D.alive).toBe(false);
    });

    it('cannot be spammed', () => {
        const { ghost, run } = close();
        run(60, c => (c === ghost ? { fire: true } : {}));
        expect(ghost.slashes().length).toBeLessThanOrEqual(2);
    });

    it('misses out of reach, when facing away, and through walls', () => {
        const far = setup(makeMap([], -6.5)); // 3.5 m apart
        far.run(KNIFE_WINDUP_TICKS + 1, c => (c === far.ghost ? { fire: true } : {}));
        expect(far.ghost.slashes()).toMatchObject([{ attacker: far.ghost.id }]);
        expect(far.ghost.slashes()[0].victim).toBeUndefined();

        const away = close();
        away.run(KNIFE_WINDUP_TICKS + 1, c => (c === away.ghost ? { fire: true, yaw: Math.PI } : {}));
        expect(away.ghost.slashes()[0].victim).toBeUndefined();

        const walled = setup(makeMap([{ min: [-5, 0, -9.4], max: [5, 4, -9.2] }], -8.5));
        walled.run(KNIFE_WINDUP_TICKS + 1, c => (c === walled.ghost ? { fire: true } : {}));
        expect(walled.ghost.slashes()[0].victim).toBeUndefined();
        expect(walled.D.health).toBe(MAX_HEALTH);
    });

    it('gives ghosts no gun', () => {
        const { ghost, run } = setup();
        run(30, c => (c === ghost ? { fire: true } : {}));
        expect(ghost.shots()).toHaveLength(0);
    });
});

describe('rounds and the bomb', () => {
    const ticks = (ms: number) => Math.ceil(ms / TICK_MS);
    /** A bomb site around the ghost spawn, so a ghost can plant without travelling. */
    const siteMap = (defenderZ = -10): MapData => ({
        ...makeMap([], 10, defenderZ),
        bombSites: [{ name: 'A', min: [-3, 0, 7], max: [3, 2.5, 13] }]
    });
    /** Two players, rounds on, advanced to the moment the first round goes live. */
    const live = (map: MapData = siteMap()) => {
        const s = setup(map, true); // setup() already runs 30 ticks of the freeze
        s.run(ticks(FREEZE_MS) - 30 + 1);
        expect(s.game.phase).toBe('live');
        return s;
    };

    it('freezes players at the start of a round, then lets them go', () => {
        const { game, ghost, run, G } = setup(siteMap(), true);
        expect(game.phase).toBe('freeze');
        expect(ghost.last('round')).toMatchObject({ phase: 'freeze', round: 1, score: { ghosts: 0, defenders: 0 } });
        run(30, c => (c === ghost ? { forward: 1, fire: true } : {}));
        expect(G.state.pos[2]).toBeCloseTo(10, 5);
        expect(ghost.sounds('windup')).toHaveLength(0); // no attacking during the freeze either
        run(ticks(FREEZE_MS));
        expect(game.phase).toBe('live');
        run(30, c => (c === ghost ? { forward: 1 } : {}));
        expect(G.state.pos[2]).toBeLessThan(9);
    });

    it('plants after an uninterrupted hold inside a site, rooting and exposing the ghost', () => {
        const { game, ghost, run, G } = live();
        run(PLANT_TICKS - 20, c => (c === ghost ? { use: true, forward: 1 } : {}));
        expect(G.state.pos[2]).toBeCloseTo(10, 5); // cannot walk while planting
        expect(G.vis).toBeGreaterThan(0.5);
        expect(ghost.last('snap').me.action).toBeGreaterThan(0.8);
        run(5); // let go: progress is lost
        run(PLANT_TICKS - 20, c => (c === ghost ? { use: true } : {}));
        expect(game.phase).toBe('live');
        run(20, c => (c === ghost ? { use: true } : {}));
        expect(game.phase).toBe('planted');
        expect(ghost.last('round')).toMatchObject({ phase: 'planted', bomb: [0, 0, 10] });
    });

    it('cannot plant outside a site', () => {
        const { game, ghost, run } = live({ ...siteMap(), bombSites: [{ name: 'A', min: [20, 0, 20], max: [26, 2.5, 26] }] });
        run(PLANT_TICKS + 10, c => (c === ghost ? { use: true } : {}));
        expect(game.phase).toBe('live');
    });

    it('gives ghosts the round when the bomb explodes, even if they have all died', () => {
        const { game, ghost, defender, run, G } = live();
        run(PLANT_TICKS, c => (c === ghost ? { use: true } : {}));
        run(1, c => (c === defender ? { fire: true } : {})); // headshot the planter
        expect(G.alive).toBe(false);
        expect(game.phase).toBe('planted');
        run(ticks(BOMB_MS) + 1);
        expect(ghost.last('round')).toMatchObject({ phase: 'over', winner: 'ghosts', reason: 'exploded', score: { ghosts: 1, defenders: 0 } });
    });

    it('lets a defender defuse only from next to the bomb', () => {
        const far = live();
        far.run(PLANT_TICKS, c => (c === far.ghost ? { use: true } : {}));
        far.run(DEFUSE_TICKS + 10, c => (c === far.defender ? { use: true } : {}));
        expect(far.game.phase).toBe('planted');

        const near = live(siteMap(9)); // defender spawns 1 m from the ghost
        near.run(PLANT_TICKS, c => (c === near.ghost ? { use: true } : {}));
        near.run(DEFUSE_TICKS - 1, c => (c === near.defender ? { use: true } : {}));
        expect(near.game.phase).toBe('planted');
        near.run(1, c => (c === near.defender ? { use: true } : {}));
        expect(near.defender.last('round')).toMatchObject({ phase: 'over', winner: 'defenders', reason: 'defused' });
    });

    it('ends the round on elimination with no respawn, then starts the next one', () => {
        const { game, ghost, defender, run, G } = live();
        run(1, c => (c === defender ? { fire: true } : {}));
        run(1);
        expect(defender.last('round')).toMatchObject({ phase: 'over', winner: 'defenders', reason: 'eliminated' });
        run(ticks(OVER_MS) - 5);
        expect(G.alive).toBe(false);
        run(10);
        expect(G.alive).toBe(true);
        expect(ghost.last('round')).toMatchObject({ phase: 'freeze', round: 2, score: { ghosts: 0, defenders: 1 } });
        expect(game.bomb).toBeNull();
    });

    it('gives defenders the round when time runs out', () => {
        const { defender, run } = live();
        run(ticks(ROUND_MS) + 1, () => null);
        expect(defender.last('round')).toMatchObject({ phase: 'over', winner: 'defenders', reason: 'time' });
    });

    it('swaps sides at halftime and ends the match at the win target', () => {
        const s = live();
        const ghostGroupClient = s.ghost, defenderGroupClient = s.defender;
        /** Plays one round: whoever is currently a defender headshots the other as soon as it is live. */
        const playRound = (): void => {
            while (s.game.phase !== 'live') s.run(1);
            s.run(2, c => (s.game.players.get(c.id)!.team === 'defenders' ? { fire: true } : {}));
            expect(s.game.phase).toBe('over');
        };
        for (let i = 0; i < HALFTIME_ROUND; i++) playRound();
        expect(defenderGroupClient.last('round').score).toEqual({ ghosts: 0, defenders: HALFTIME_ROUND });

        s.run(ticks(OVER_MS) + 2);
        // Roles have traded; the score follows the players, not the role.
        expect(ghostGroupClient.last('snap').me.team).toBe('defenders');
        expect(defenderGroupClient.last('snap').me.team).toBe('ghosts');
        expect(ghostGroupClient.last('round').score).toEqual({ ghosts: HALFTIME_ROUND, defenders: 0 });
        expect(ghostGroupClient.last('spawn').pos).toEqual([0, 0, -10]); // now at the defender spawn

        for (let i = 0; i < ROUNDS_TO_WIN; i++) playRound();
        expect(ghostGroupClient.last('round')).toMatchObject({ winner: 'defenders', matchOver: true, score: { ghosts: HALFTIME_ROUND, defenders: ROUNDS_TO_WIN } });

        s.run(ticks(MATCH_OVER_MS) + 2);
        expect(ghostGroupClient.last('round')).toMatchObject({ phase: 'freeze', round: 1, score: { ghosts: 0, defenders: 0 } });
        expect(ghostGroupClient.last('snap').me.team).toBe('ghosts'); // a new match starts on the original sides
    });

    it('holds a mid-round joiner until the next round and tracks the roster', () => {
        const { game, ghost, defender, run } = live();
        const late = new Client(game, '  <b>Zoë_99</b> the very long named one ');
        const L = game.players.get(late.id)!;
        expect(L.alive).toBe(false);
        expect(L.name).toBe('bZoë_99b the ver');
        expect(late.last('round').phase).toBe('live');
        run(1, c => (c === defender ? { fire: true } : {}));
        const roster = ghost.last('roster').players;
        expect(roster.find(p => p.id === defender.id)).toMatchObject({ kills: 1, deaths: 0, alive: true });
        expect(roster.find(p => p.id === ghost.id)).toMatchObject({ kills: 0, deaths: 1, alive: false });
        expect(roster.find(p => p.id === late.id)!.name).toBe('bZoë_99b the ver');
    });

    it('returns to warmup when a team empties', () => {
        const { game, ghost, defender, run } = live();
        game.leave(defender.id);
        run(2, c => (c === ghost ? {} : null));
        expect(ghost.last('round').phase).toBe('warmup');
    });
});