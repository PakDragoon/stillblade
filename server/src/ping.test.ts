import { describe, expect, it } from 'vitest';
import { PING_MAX, decodeClient, type ServerMsg } from '../../shared/protocol';
import type { MapData } from '../../shared/types';
import { PingProbe } from './ping-probe';
import { Game, smoothPing } from './game';

const MAP: MapData = {
    name: 'ping', displayName: 'Ping',
    bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
    boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }],
    spawns: { ghosts: [{ pos: [0, 0, 10], yaw: 0 }], defenders: [{ pos: [0, 0, -10], yaw: 180 }] },
    bombSites: [{ name: 'A', min: [-3, 0, 7], max: [3, 2.5, 13] }]
};

function room(): { game: Game; inbox: ServerMsg[][]; ids: number[] } {
    const game = new Game(MAP, { lobby: true });
    const inbox: ServerMsg[][] = [];
    const ids: number[] = [];
    for (const name of ['Ann', 'Bo']) {
        const box: ServerMsg[] = [];
        inbox.push(box);
        ids.push(game.join({ send: m => { box.push(structuredClone(m)); } }, name));
    }
    return { game, inbox, ids };
}

describe('scoreboard ping', () => {
    it('smooths samples and keeps them whole numbers from 0 to the cap', () => {
        expect(smoothPing(-1, 80.4)).toBe(80);
        expect(smoothPing(100, 200)).toBe(135);
        expect(smoothPing(-1, 5000)).toBe(PING_MAX);
        expect(smoothPing(50, -20)).toBeGreaterThanOrEqual(0);
    });

    it('sends every measured human to every player, as server-measured numbers', () => {
        const { game, inbox, ids } = room();
        game.setPing(ids[0], 42);
        game.sendPings();
        for (const box of inbox) {
            const m = box.filter(x => x.type === 'pings').at(-1);
            expect(m).toEqual({ type: 'pings', pings: [[ids[0], 42]] }); // Bo has no measurement yet
        }
        game.setPing(ids[1], 99999);
        game.sendPings();
        const last = inbox[0].filter(x => x.type === 'pings').at(-1) as { pings: [number, number][] };
        expect(last.pings.find(p => p[0] === ids[1])?.[1]).toBe(PING_MAX);
    });

    it('never has a ping for a bot, and says nothing when nobody is measured', () => {
        const { game, inbox } = room();
        const bot = game.addBot('defenders');
        game.setPing(bot, 30);
        game.sendPings();
        expect(inbox[0].some(x => x.type === 'pings')).toBe(false);
    });

    it('is not part of the roster and cannot be set by a client message', () => {
        const { game, inbox, ids } = room();
        game.setPing(ids[0], 42);
        game.handleMessage(ids[0], { type: 'ready', ready: true });
        const roster = inbox[0].filter(x => x.type === 'roster').at(-1) as { players: object[] };
        expect(roster.players.every(p => !('ping' in p))).toBe(true);
        expect(() => decodeClient(JSON.stringify({ type: 'pings', pings: [[1, 1]] }))).toThrow();
        expect(() => decodeClient(JSON.stringify({ type: 'ping', ping: 1 }))).toThrow();
    });
});

describe('PingProbe', () => {
    it('samples only a pong that echoes its own token', () => {
        const probe = new PingProbe();
        expect(probe.busy).toBe(false);
        const payload = probe.start(1000);
        expect(probe.busy).toBe(true);
        expect(probe.pong(Buffer.alloc(0), 1010)).toBeUndefined(); // a heartbeat pong (empty payload)
        expect(probe.pong(Buffer.from([0, 0, 0, 99]), 1010)).toBeUndefined(); // some other token
        expect(probe.busy).toBe(true);
        expect(probe.pong(payload, 1042)).toBe(42);
        expect(probe.busy).toBe(false);
        expect(probe.pong(payload, 1100)).toBeUndefined(); // the same pong twice gives nothing
    });
    it('ignores a late pong from an earlier probe', () => {
        const probe = new PingProbe();
        const first = Buffer.from(probe.start(0));
        probe.start(500);
        expect(probe.pong(first, 520)).toBeUndefined();
    });
});
