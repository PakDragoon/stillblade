import { describe, expect, it } from 'vitest';
import { decodeClient, decodeServer, encodeClient, encodeServer, type NetCmd, type ServerMsg } from './protocol';

const cmd: NetCmd = {
    seq: 123456, forward: 1, right: -1, yaw: Math.fround(7.123456), pitch: Math.fround(-0.4321),
    jump: true, walk: false, crouch: true, fire: false, use: true, viewTime: 98765.4321
};

describe('wire format', () => {
    it('round-trips a command exactly, in 24 bytes', () => {
        const wire = encodeClient({ type: 'cmd', cmd });
        expect(wire).toBeInstanceOf(Uint8Array);
        expect((wire as Uint8Array).byteLength).toBe(24);
        // Exact equality matters: the server must simulate the very inputs the client predicted with.
        expect(decodeClient(wire as Uint8Array).cmd).toEqual(cmd);
    });

    it('decodes a command from a view into a larger buffer', () => {
        const wire = encodeClient({ type: 'cmd', cmd }) as Uint8Array;
        const padded = new Uint8Array(64);
        padded.set(wire, 10);
        expect(decodeClient(padded.subarray(10, 34)).cmd).toEqual(cmd);
    });

    it('rejects malformed commands', () => {
        expect(() => decodeClient(new Uint8Array(3))).toThrow();
        expect(() => decodeClient(new Uint8Array(24))).toThrow(); // wrong tag
        expect(() => decodeClient(new Uint8Array(4096))).toThrow();
    });

    it('round-trips a snapshot: local player exactly, others within rendering precision', () => {
        const snap: ServerMsg = {
            type: 'snap', time: 123456.789, ack: 4242,
            me: {
                team: 'ghosts', action: 0.5, vis: 0.35, pos: [1.23456789012345, 0, -19.87654321098765],
                vel: [5.2, -3.3333333333, 0.000001], onGround: true, crouched: false, health: 66, alive: true,
                respawnAt: 0
            },
            players: [
                { id: 7, team: 'defenders', pos: [3.5, 1.2, -8.25], yaw: 9.5, pitch: -0.6, crouched: true, alive: true, vis: 1 },
                { id: 300, team: 'ghosts', pos: [-14.9, 0, 21.1], yaw: -2, pitch: 1.2, crouched: false, alive: false, vis: 0.2 }
            ]
        };
        const wire = encodeServer(snap) as Uint8Array;
        expect(wire.byteLength).toBe(76 + 2 * 19);
        const back = decodeServer(wire);
        if (back.type !== 'snap') throw new Error('wrong type');

        expect(back.time).toBe(snap.time);
        expect(back.ack).toBe(4242);
        expect(back.me.pos).toEqual(snap.me.pos); // float64: prediction replays from this exactly
        expect(back.me.vel).toEqual(snap.me.vel);
        expect(back.me).toMatchObject({ team: 'ghosts', onGround: true, crouched: false, alive: true, health: 66 });
        expect(back.me.action).toBeCloseTo(0.5, 4);
        expect(back.me.vis).toBeCloseTo(0.35, 4);

        const [a, b] = back.players;
        expect(a).toMatchObject({ id: 7, team: 'defenders', crouched: true, alive: true, vis: 1 });
        expect(a.pos[0]).toBeCloseTo(3.5, 5);
        expect(a.pos[2]).toBeCloseTo(-8.25, 5);
        expect(Math.cos(a.yaw)).toBeCloseTo(Math.cos(9.5), 3); // same direction once wrapped
        expect(Math.sin(a.yaw)).toBeCloseTo(Math.sin(9.5), 3);
        expect(a.pitch).toBeCloseTo(-0.6, 1);
        expect(b).toMatchObject({ id: 300, team: 'ghosts', alive: false });
        expect(b.vis).toBeCloseTo(0.2, 2);
    });

    it('keeps an acknowledgement of -1 (nothing simulated yet)', () => {
        const back = decodeServer(encodeServer({
            type: 'snap', time: 0, ack: -1, players: [],
            me: { team: 'defenders', action: 0, vis: 1, pos: [0, 0, 0], vel: [0, 0, 0], onGround: false, crouched: false, health: 100, alive: false, respawnAt: 0 }
        }) as Uint8Array);
        expect(back.type === 'snap' && back.ack).toBe(-1);
    });

    it('sends rare events as JSON text', () => {
        const msg: ServerMsg = { type: 'spawn', pos: [1, 2, 3], yaw: 1.5 };
        const wire = encodeServer(msg);
        expect(typeof wire).toBe('string');
        expect(decodeServer(wire as string)).toEqual(msg);
    });

    it('rejects unknown binary from the server', () => {
        expect(() => decodeServer(new Uint8Array(10))).toThrow();
    });
});
