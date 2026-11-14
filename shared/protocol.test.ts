import { describe, expect, it } from 'vitest';
import { createLoadout } from './gun';
import { createKnifeState } from './knife';
import { PROTOCOL_VERSION, decodeClient, decodeServer, encodeClient, encodeServer, type NetCmd, type ServerMsg } from './protocol';
import { WEAPON_COUNT } from './weapons';

const cmd: NetCmd = {
    seq: 123456, forward: 1, right: -1, yaw: Math.fround(7.123456), pitch: Math.fround(-0.4321),
    jump: true, walk: false, crouch: true, fire: false, use: true, reload: true, slot: 2, swap: true, aim: true,
    viewTime: 98765.4321
};
const SNAP_HEAD = 75 + 5 + 7 * WEAPON_COUNT + 3;

describe('wire format', () => {
    it('is protocol version 7', () => {
        expect(PROTOCOL_VERSION).toBe(7);
    });

    it('round-trips a command exactly, in 25 bytes', () => {
        const wire = encodeClient({ type: 'cmd', cmd });
        expect(wire).toBeInstanceOf(Uint8Array);
        expect((wire as Uint8Array).byteLength).toBe(25);
        // Exact equality matters: the server must simulate the very inputs the client predicted with.
        expect(decodeClient(wire as Uint8Array).cmd).toEqual(cmd);
    });

    it('round-trips every command flag on its own', () => {
        for (const flag of ['jump', 'walk', 'crouch', 'fire', 'use', 'reload', 'swap', 'aim'] as const) {
            const only: NetCmd = {
                ...cmd, jump: false, walk: false, crouch: false, fire: false, use: false, reload: false, swap: false, aim: false,
                slot: 0, [flag]: true
            };
            expect(decodeClient(encodeClient({ type: 'cmd', cmd: only }) as Uint8Array).cmd).toEqual(only);
        }
    });

    it('round-trips every weapon slot request', () => {
        for (let slot = 0; slot <= 255; slot++) {
            const c: NetCmd = { ...cmd, slot, swap: false, aim: false };
            expect(decodeClient(encodeClient({ type: 'cmd', cmd: c }) as Uint8Array).cmd.slot).toBe(slot);
        }
    });

    it('decodes a command from a view into a larger buffer', () => {
        const wire = encodeClient({ type: 'cmd', cmd }) as Uint8Array;
        const padded = new Uint8Array(64);
        padded.set(wire, 10);
        expect(decodeClient(padded.subarray(10, 35)).cmd).toEqual(cmd);
    });

    it('rejects malformed commands', () => {
        expect(() => decodeClient(new Uint8Array(3))).toThrow();
        expect(() => decodeClient(new Uint8Array(25))).toThrow(); // wrong tag
        const short = encodeClient({ type: 'cmd', cmd }) as Uint8Array;
        expect(() => decodeClient(short.subarray(0, 24))).toThrow(); // a version 6 command
        expect(() => decodeClient(new Uint8Array(4096))).toThrow();
    });

    it('round-trips a snapshot: local player exactly, others within rendering precision', () => {
        const snap: ServerMsg = {
            type: 'snap', time: 123456.789, ack: 4242,
            me: {
                team: 'ghosts', action: 0.5, vis: 0.35, pos: [1.23456789012345, 0, -19.87654321098765],
                vel: [5.2, -3.3333333333, 0.000001], onGround: true, crouched: false, health: 66, alive: true,
                respawnAt: 0,
                loadout: {
                    slot: 1, prev: 0, draw: 24, aim: 12, trigger: 1,
                    guns: [
                        { mag: 17, reserve: 90, reload: 132, cooldown: 6, burst: 29, sinceShot: 255, shots: 201 },
                        { mag: 11, reserve: 36, reload: 84, cooldown: 9, burst: 11, sinceShot: 3, shots: 255 }
                    ]
                },
                knife: { cooldown: 41, windup: 12 }
            },
            players: [
                {
                    id: 7, team: 'defenders', pos: [3.5, 1.2, -8.25], yaw: 9.5, pitch: -0.6, crouched: true, alive: true, vis: 1,
                    reloading: true, weapon: 1, switching: true, aiming: true
                },
                {
                    id: 300, team: 'ghosts', pos: [-14.9, 0, 21.1], yaw: -2, pitch: 1.2, crouched: false, alive: false, vis: 0.2,
                    reloading: false, weapon: 0, switching: false, aiming: false
                }
            ]
        };
        const wire = encodeServer(snap) as Uint8Array;
        expect(wire.byteLength).toBe(SNAP_HEAD + 2 * 20);
        const back = decodeServer(wire);
        if (back.type !== 'snap') throw new Error('wrong type');

        expect(back.time).toBe(snap.time);
        expect(back.ack).toBe(4242);
        expect(back.me.pos).toEqual(snap.me.pos); // float64: prediction replays from this exactly
        expect(back.me.vel).toEqual(snap.me.vel);
        expect(back.me.loadout).toEqual(snap.me.loadout); // the weapons are predicted too: integers, exact
        expect(back.me.knife).toEqual(snap.me.knife); // so is the knife timing
        expect(back.me).toMatchObject({ team: 'ghosts', onGround: true, crouched: false, alive: true, health: 66 });
        expect(back.me.action).toBeCloseTo(0.5, 4);
        expect(back.me.vis).toBeCloseTo(0.35, 4);

        const [a, b] = back.players;
        expect(a).toMatchObject({ id: 7, team: 'defenders', crouched: true, alive: true, vis: 1, reloading: true, weapon: 1, switching: true, aiming: true });
        expect(a.pos[0]).toBeCloseTo(3.5, 5);
        expect(a.pos[2]).toBeCloseTo(-8.25, 5);
        expect(Math.cos(a.yaw)).toBeCloseTo(Math.cos(9.5), 3); // same direction once wrapped
        expect(Math.sin(a.yaw)).toBeCloseTo(Math.sin(9.5), 3);
        expect(a.pitch).toBeCloseTo(-0.6, 1);
        expect(b).toMatchObject({ id: 300, team: 'ghosts', alive: false, reloading: false, weapon: 0, switching: false, aiming: false });
        expect(b.vis).toBeCloseTo(0.2, 2);
    });

    it('carries every loadout counter at its one-byte limits exactly', () => {
        for (const v of [0, 1, 127, 128, 254, 255]) {
            const loadout = createLoadout();
            loadout.slot = loadout.prev = v % WEAPON_COUNT;
            loadout.draw = loadout.aim = v;
            loadout.trigger = v & 1;
            for (const g of loadout.guns) { g.mag = g.reserve = g.reload = g.cooldown = g.burst = g.sinceShot = g.shots = v; }
            const back = decodeServer(encodeServer({
                type: 'snap', time: 1, ack: 2, players: [],
                me: { team: 'defenders', action: 0, vis: 1, pos: [0, 0, 0], vel: [0, 0, 0], onGround: true, crouched: false, health: 100, alive: true, respawnAt: 0, loadout, knife: createKnifeState() }
            }) as Uint8Array);
            expect(back.type === 'snap' && back.me.loadout).toEqual(loadout);
        }
    });

    it('keeps an acknowledgement of -1 (nothing simulated yet)', () => {
        const back = decodeServer(encodeServer({
            type: 'snap', time: 0, ack: -1, players: [],
            me: { team: 'defenders', action: 0, vis: 1, pos: [0, 0, 0], vel: [0, 0, 0], onGround: false, crouched: false, health: 100, alive: false, respawnAt: 0, loadout: createLoadout(), knife: createKnifeState() }
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
