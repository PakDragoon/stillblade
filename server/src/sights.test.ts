import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNIFE_COOLDOWN_TICKS, RESPAWN_MS, TICK_RATE } from '../../shared/constants';
import type { NetCmd, ServerMsg } from '../../shared/protocol';
import { FREEZE_MS } from '../../shared/rules';
import type { MapData } from '../../shared/types';
import { SIGHTS, SIGHT_IRON } from '../../shared/weapons';
import { Game } from './game';
import { loadMaps } from './maps';
import { Rooms } from './rooms';

const TICK_MS = 1000 / TICK_RATE;
const MAPS = loadMaps(fileURLToPath(new URL('../../client/public/maps', import.meta.url)));

/** The ghost spawns 1.5 m in front of the defender, facing it: two knife hits kill. */
const map: MapData = {
    name: 'test',
    bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
    boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }],
    spawns: { ghosts: [{ pos: [0, 0, -8.5], yaw: 0 }], defenders: [{ pos: [0, 0, -10], yaw: 180 }] },
    bombSites: []
};

class Client {
    readonly inbox: ServerMsg[] = [];
    readonly id: number;
    seq = 0;
    yaw = 0;
    constructor(private readonly game: Game, sight?: number) {
        this.id = game.join({
            send: m => {
                if (m.type === 'spawn') this.yaw = m.yaw;
                this.inbox.push(structuredClone(m));
            }
        }, '', sight === undefined ? {} : { sight });
    }
    cmd(over: Partial<NetCmd> = {}): void {
        this.game.handleCmd(this.id, {
            seq: this.seq++, forward: 0, right: 0, yaw: this.yaw, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: this.game.now, ...over
        });
    }
    all<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }>[] {
        return this.inbox.filter(m => m.type === type) as Extract<ServerMsg, { type: T }>[];
    }
    rosterSight(id: number): number | undefined {
        const r = this.all('roster').at(-1);
        return r?.players.find(p => p.id === id)?.sight;
    }
}

function setup(defenderSight?: number, rounds = false) {
    const game = new Game(map, { rounds });
    const ghost = new Client(game);
    const defender = new Client(game, defenderSight);
    let ticks = 0;
    const run = (n: number, each: (c: Client) => Partial<NetCmd> = () => ({})): void => {
        for (let i = 0; i < n; i++) {
            game.tick(++ticks * TICK_MS);
            for (const c of [ghost, defender]) c.cmd(each(c));
        }
    };
    const P = (c: Client) => game.players.get(c.id)!;
    /** The ghost stabs the defender until it dies, then the server runs until it respawns. */
    const killAndRespawn = (): void => {
        expect(P(defender).alive).toBe(true);
        run(KNIFE_COOLDOWN_TICKS * 3, c => (c === ghost ? { fire: true } : {}));
        expect(P(defender).alive).toBe(false);
        run(Math.ceil(RESPAWN_MS / TICK_MS) + 2);
        expect(P(defender).alive).toBe(true);
    };
    return { game, ghost, defender, run, P, killAndRespawn };
}

describe('rifle sight: chosen any time, active from the next spawn', () => {
    it('defaults to iron sights, and a join-query sight counts from the first spawn', () => {
        const a = setup();
        expect(a.P(a.defender).loadout.sight).toBe(SIGHT_IRON);
        expect(a.defender.all('spawn').at(-1)!.sight).toBe(SIGHT_IRON);
        expect(a.defender.rosterSight(a.defender.id)).toBe(SIGHT_IRON);
        for (let sight = 0; sight < SIGHTS.length; sight++) {
            const b = setup(sight);
            expect(b.P(b.defender).loadout.sight).toBe(sight);
            expect(b.defender.all('spawn').at(-1)!.sight).toBe(sight);
            expect(b.ghost.rosterSight(b.defender.id)).toBe(sight); // others see it on the gun
        }
        // An invalid join value (the transport cleans it, but Game does too) mounts iron sights.
        expect(setup(9).P(setup(9).defender).loadout.sight).toBe(SIGHT_IRON);
    });

    it('keeps the active sight for the rest of a life and mounts the new one at the respawn', () => {
        const { game, ghost, defender, run, P, killAndRespawn } = setup(0);
        run(5);
        game.handleMessage(defender.id, { type: 'sight', sight: 2 });
        run(30, c => (c === defender ? { aim: true } : {}));
        // Mid-life: the loadout, the aim time and what everyone sees are unchanged.
        expect(P(defender).loadout.sight).toBe(0);
        expect(P(defender).loadout.aim).toBe(SIGHTS[0].adsTicks);
        expect(ghost.rosterSight(defender.id)).toBe(0);
        const rostersBefore = ghost.all('roster').length;

        killAndRespawn();
        expect(P(defender).loadout.sight).toBe(2);
        expect(defender.all('spawn').at(-1)!.sight).toBe(2);
        expect(ghost.rosterSight(defender.id)).toBe(2);
        expect(ghost.all('roster').length).toBeGreaterThan(rostersBefore);
        run(30, c => (c === defender ? { aim: true } : {}));
        expect(P(defender).loadout.aim).toBe(SIGHTS[2].adsTicks); // aims in at the scope's pace now

        // Changing back and forth without dying changes nothing until the next spawn, which takes the last choice.
        game.handleMessage(defender.id, { type: 'sight', sight: 0 });
        game.handleMessage(defender.id, { type: 'sight', sight: 1 });
        expect(P(defender).loadout.sight).toBe(2);
        killAndRespawn();
        expect(P(defender).loadout.sight).toBe(1);
        expect(ghost.rosterSight(defender.id)).toBe(1);
    });

    it('sends nothing for a choice, so repeating it is harmless', () => {
        const { game, ghost, defender, run } = setup(0);
        run(3);
        const before = [ghost.inbox.length, defender.inbox.length];
        for (let i = 0; i < 200; i++) game.handleMessage(defender.id, { type: 'sight', sight: i % 3 });
        expect([ghost.inbox.length, defender.inbox.length]).toEqual(before);
    });

    it('re-sends the roster at a spawn only when the mounted sight changes', () => {
        const { game, ghost, defender, run, killAndRespawn } = setup(1);
        run(3);
        game.handleMessage(defender.id, { type: 'sight', sight: 1 }); // the same as active
        const before = ghost.all('roster').length;
        killAndRespawn();
        // Death sends a roster (alive flags); the respawn with the same sight adds none of its own.
        const deathRosters = ghost.all('roster').length - before;
        expect(deathRosters).toBeLessThanOrEqual(1);
        expect(ghost.rosterSight(defender.id)).toBe(1);
    });

    it('cleans a sight that bypassed decoding to iron sights', () => {
        const { game, defender, P, killAndRespawn } = setup(2);
        game.handleMessage(defender.id, { type: 'sight', sight: 42 });
        killAndRespawn();
        expect(P(defender).loadout.sight).toBe(SIGHT_IRON);
    });

    it('mounts the choice at the round-start spawn in a real match', () => {
        const { game, defender, run, P } = setup(0, true);
        game.handleMessage(defender.id, { type: 'sight', sight: 2 });
        // Warmup to freeze: the round start spawns everyone with their chosen sight.
        run(Math.ceil(FREEZE_MS / TICK_MS) + 10);
        expect(game.phase).not.toBe('warmup');
        expect(P(defender).loadout.sight).toBe(2);
    });

    it('gives bots iron sights and ignores a sight sent for one', () => {
        const game = new Game(MAPS.get('greybox')!, { rounds: false });
        const d = game.addBot('defenders');
        expect(d).toBeGreaterThan(0);
        expect(game.players.get(d)!.loadout.sight).toBe(SIGHT_IRON);
        game.handleMessage(d, { type: 'sight', sight: 2 });
        expect(game.players.get(d)!.sightPending).toBe(SIGHT_IRON);
        const roster = (game as unknown as { rosterEntries(): { id: number; sight: number }[] }).rosterEntries();
        expect(roster.find(p => p.id === d)!.sight).toBe(SIGHT_IRON);
    });

    it('passes the join-query sight through Rooms', () => {
        const rooms = new Rooms(new Map([['test', map]]), 'test');
        const sent: ServerMsg[] = [];
        const r = rooms.join('abc', null, { send: (m: ServerMsg) => sent.push(structuredClone(m)), ip: '1.2.3.4' } as never, 'Sam', 0, undefined, undefined, 2);
        expect(r.ok).toBe(true);
        const spawn = sent.find(m => m.type === 'spawn');
        // A lobby room spawns in warmup at once with the join-query sight.
        expect(spawn && spawn.type === 'spawn' && spawn.sight).toBe(2);
    });
});
