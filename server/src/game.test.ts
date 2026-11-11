import { describe, expect, it } from 'vitest';
import {
    BODY_DAMAGE, EYE_HEIGHT, GHOST_MAX_VIS, KNIFE_BACKSTAB_DAMAGE, KNIFE_DAMAGE, KNIFE_WINDUP_TICKS, MAX_HEALTH,
    RESPAWN_MS, RUN_SPEED, TICK_RATE, VIS_SWING_SPIKE
} from '../../shared/constants';
import type { NetCmd, ServerMsg, ShotEvent, SlashEvent, SoundEvent } from '../../shared/protocol';
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
    constructor(private readonly game: Game) {
        this.id = game.join({
            send: m => {
                if (m.type === 'spawn') this.yaw = m.yaw;
                this.inbox.push(structuredClone(m));
            }
        });
    }
    cmd(over: Partial<NetCmd> = {}): void {
        this.game.handleCmd(this.id, {
            seq: this.seq++, forward: 0, right: 0, yaw: this.yaw, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, viewTime: this.game.now, ...over
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

function setup(map: MapData = makeMap()) {
    const game = new Game(map);
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
    return { game, ghost, defender, run, G: game.players.get(ghost.id)!, D: game.players.get(defender.id)! };
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
