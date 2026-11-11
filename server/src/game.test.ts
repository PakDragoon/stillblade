import { describe, expect, it } from 'vitest';
import { BODY_DAMAGE, EYE_HEIGHT, MAX_HEALTH, RESPAWN_MS, RUN_SPEED, TICK_RATE } from '../../shared/constants';
import type { NetCmd, ServerMsg, ShotEvent } from '../../shared/protocol';
import type { Box, MapData } from '../../shared/types';
import { Game } from './game';

const TICK_MS = 1000 / TICK_RATE;

function makeMap(extra: Box[] = []): MapData {
    return {
        name: 'test',
        bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
        boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }, ...extra],
        // Ghost at z=+10 facing -Z, defender at z=-10 facing +Z: they look straight at each other.
        spawns: { ghosts: [{ pos: [0, 0, 10], yaw: 0 }], defenders: [{ pos: [0, 0, -10], yaw: 180 }] },
        bombSites: []
    };
}

class Client {
    readonly inbox: ServerMsg[] = [];
    readonly id: number;
    private seq = 0;
    constructor(private readonly game: Game) {
        this.id = game.join({ send: m => this.inbox.push(structuredClone(m)) });
    }
    cmd(over: Partial<NetCmd> = {}): void {
        this.game.handleCmd(this.id, {
            seq: this.seq++, forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, viewTime: this.game.now, ...over
        });
    }
    last<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }> {
        const m = this.inbox.findLast(x => x.type === type);
        if (!m) throw new Error(`no ${type} message`);
        return m as Extract<ServerMsg, { type: T }>;
    }
    shots(): ShotEvent[] {
        return this.inbox.filter((m): m is ShotEvent => m.type === 'shot');
    }
}

function setup(extra: Box[] = []) {
    const game = new Game(makeMap(extra));
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
    return { game, ghost, defender, run };
}

describe('Game', () => {
    it('puts the first two players on opposite teams and spawns them', () => {
        const { game, ghost, defender } = setup();
        expect(ghost.last('welcome').team).toBe('ghosts');
        expect(defender.last('welcome').team).toBe('defenders');
        expect(ghost.last('spawn').pos).toEqual([0, 0, 10]);
        expect(game.players.get(defender.id)!.alive).toBe(true);
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
        const { game, ghost, run } = setup();
        const before = game.players.get(ghost.id)!.state.pos[2];
        for (let i = 0; i < 300; i++) ghost.cmd({ forward: 1 });
        run(1, () => null);
        const moved = before - game.players.get(ghost.id)!.state.pos[2];
        expect(moved).toBeLessThan(RUN_SPEED * (13 / TICK_RATE));
        expect(ghost.last('snap').ack).toBeLessThan(30 + 13);
    });

    it('ignores malformed commands', () => {
        const { game, ghost } = setup();
        const before = [...game.players.get(ghost.id)!.state.pos];
        ghost.cmd({ forward: NaN });
        ghost.cmd({ yaw: Infinity });
        ghost.cmd({ seq: -5, forward: 1 });
        expect(game.players.get(ghost.id)!.state.pos).toEqual(before);
    });

    it('registers a body shot, then kills and respawns', () => {
        const { game, ghost, defender, run } = setup();
        const victim = game.players.get(defender.id)!;
        // Eye is at 1.62 m; aim slightly down so the ray lands in the body, below the head zone.
        const bodyAim = { fire: true, pitch: -0.03 };
        run(1, c => (c === ghost ? bodyAim : {}));
        expect(victim.health).toBe(MAX_HEALTH - BODY_DAMAGE);
        const shot = defender.shots().at(-1)!;
        expect(shot).toMatchObject({ shooter: ghost.id, victim: defender.id, head: false, damage: BODY_DAMAGE });
        expect(shot.to[2]).toBeCloseTo(-10 + 0.3, 3);

        run(30, c => (c === ghost ? bodyAim : {}));
        expect(victim.alive).toBe(false);
        expect(ghost.shots().some(s => s.killed)).toBe(true);
        const deadPos = [...victim.state.pos];
        run(10, c => (c === defender ? { forward: 1 } : {}));
        expect(victim.state.pos).toEqual(deadPos); // the dead do not move

        run(Math.ceil(RESPAWN_MS / TICK_MS) + 1);
        expect(victim.alive).toBe(true);
        expect(victim.health).toBe(MAX_HEALTH);
    });

    it('scores a headshot when the ray enters the head zone', () => {
        const { game, ghost, defender, run } = setup();
        // Level aim from eye height (1.62) hits inside the top 0.28 m of a 1.8 m hull.
        expect(EYE_HEIGHT).toBeGreaterThan(1.8 - 0.28);
        run(1, c => (c === ghost ? { fire: true } : {}));
        expect(ghost.shots().at(-1)).toMatchObject({ victim: defender.id, head: true, killed: true });
        expect(game.players.get(defender.id)!.alive).toBe(false);
    });

    it('enforces the fire rate', () => {
        const { ghost, run } = setup();
        const before = ghost.shots().length;
        run(60, c => (c === ghost ? { fire: true, pitch: 0.5 } : {})); // 1 s of holding fire at the sky
        const fired = ghost.shots().length - before;
        expect(fired).toBeGreaterThanOrEqual(9);
        expect(fired).toBeLessThanOrEqual(11);
    });

    it('stops bullets at walls', () => {
        const { game, ghost, defender, run } = setup([{ min: [-5, 0, -1], max: [5, 4, 1] }]);
        run(1, c => (c === ghost ? { fire: true } : {}));
        const shot = ghost.shots().at(-1)!;
        expect(shot.victim).toBeUndefined();
        expect(shot.to[2]).toBeCloseTo(1, 3);
        expect(game.players.get(defender.id)!.health).toBe(MAX_HEALTH);
    });

    it('rewinds targets to what the shooter saw (lag compensation)', () => {
        const { game, ghost, defender, run } = setup();
        const victim = game.players.get(defender.id)!;
        const seenAt = game.now;
        // The defender strafes for 150 ms: far enough to leave the line of fire.
        run(9, c => (c === defender ? { right: 1, yaw: Math.PI } : {}));
        expect(Math.abs(victim.state.pos[0])).toBeGreaterThan(0.31);

        // Shooting at the present misses...
        run(1, c => (c === ghost ? { fire: true, pitch: -0.03 } : { right: 1, yaw: Math.PI }));
        expect(ghost.shots().at(-1)!.victim).toBeUndefined();

        // ...but a shot aimed at where the shooter's screen showed the target still lands.
        run(6, c => (c === defender ? { right: 1, yaw: Math.PI } : {}));
        run(1, c => (c === ghost ? { fire: true, pitch: -0.03, viewTime: seenAt } : {}));
        expect(ghost.shots().at(-1)!.victim).toBe(defender.id);
    });

    it('will not rewind further than the cap', () => {
        const { ghost, defender, run } = setup();
        const seenAt = ghost.last('snap').time;
        run(60, c => (c === defender ? { right: 1, yaw: Math.PI } : {}));
        run(1, c => (c === ghost ? { fire: true, pitch: -0.03, viewTime: seenAt } : {}));
        expect(ghost.shots().at(-1)!.victim).toBeUndefined();
    });
});
