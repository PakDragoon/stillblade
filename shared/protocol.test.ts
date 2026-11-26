import { describe, expect, it } from 'vitest';
import { createLoadout } from './gun';
import { createKnifeState } from './knife';
import { PROTOCOL_VERSION, decodeClient, decodeServer, encodeClient, encodeServer, type NetCmd, type ServerMsg } from './protocol';
import { GUN_COUNT, SIGHT_COUNT, SLOT_COUNT, SLOT_KNIFE } from './weapons';

const cmd: NetCmd = {
    seq: 123456, forward: 1, right: -1, yaw: Math.fround(7.123456), pitch: Math.fround(-0.4321),
    jump: true, walk: false, crouch: true, fire: false, use: true, reload: true, slot: 2, swap: true, aim: true, drop: true,
    viewTime: 98765.4321
};
/** Self state, loadout (6 with the sight + 7 per gun + 2 for the defender knife), ghost knife (2), bomb repick wait (1), spectator id (2), player count (1). */
const SNAP_HEAD = 76 + 6 + 7 * GUN_COUNT + 2 + 2 + 1 + 2 + 1;

describe('wire format', () => {
    it('is protocol version 18', () => {
        expect(PROTOCOL_VERSION).toBe(18);
    });

    it('carries the active sight in the self snapshot exactly, for every sight', () => {
        for (let sight = 0; sight < SIGHT_COUNT; sight++) {
            const loadout = createLoadout();
            loadout.sight = sight;
            const back = decodeServer(encodeServer({
                type: 'snap', time: 0, ack: 1, players: [],
                me: { team: 'defenders', actionTicks: 0, carry: { carrier: false, wait: 0 }, vis: 1, pos: [0, 0, 0], vel: [0, 0, 0], onGround: true, crouched: false, health: 100, armor: 100, alive: true, respawnAt: 0, spectateId: 0, loadout, knife: createKnifeState() }
            }) as Uint8Array);
            expect(back.type === 'snap' && back.me.loadout.sight).toBe(sight);
        }
    });

    it('validates the sight choice message', () => {
        for (let sight = 0; sight < SIGHT_COUNT; sight++) {
            expect(decodeClient(encodeClient({ type: 'sight', sight }) as string)).toEqual({ type: 'sight', sight });
        }
        for (const bad of [-1, SIGHT_COUNT, 1.5, '1', null, true, 1e9]) {
            expect(() => decodeClient(JSON.stringify({ type: 'sight', sight: bad }))).toThrow();
        }
        expect(() => decodeClient(JSON.stringify({ type: 'sight' }))).toThrow();
        // Extra fields are dropped, not passed on.
        expect(decodeClient(JSON.stringify({ type: 'sight', sight: 2, pos: [1, 2, 3] }))).toEqual({ type: 'sight', sight: 2 });
    });

    it('validates the spectator target selection', () => {
        const msg = { type: 'spectate', target: 3 } as const;
        expect(decodeClient(JSON.stringify(msg))).toEqual(msg);
        for (const target of [0, -1, 1.5, '1', null, true]) {
            expect(() => decodeClient(JSON.stringify({ type: 'spectate', target }))).toThrow();
        }
    });

    it('round-trips a command exactly, in 26 bytes', () => {
        const wire = encodeClient({ type: 'cmd', cmd });
        expect(wire).toBeInstanceOf(Uint8Array);
        expect((wire as Uint8Array).byteLength).toBe(26);
        // Exact equality matters: the server must simulate the very inputs the client predicted with.
        expect(decodeClient(wire as Uint8Array)).toEqual({ type: "cmd", cmd: cmd });
    });

    it('round-trips every command flag on its own', () => {
        for (const flag of ['jump', 'walk', 'crouch', 'fire', 'use', 'reload', 'swap', 'aim', 'drop', 'observerOnly'] as const) {
            const only: NetCmd = {
                ...cmd, jump: false, walk: false, crouch: false, fire: false, use: false, reload: false, swap: false, aim: false, drop: false,
                slot: 0, [flag]: true
            };
            expect(decodeClient(encodeClient({ type: 'cmd', cmd: only }) as Uint8Array)).toEqual({ type: 'cmd', cmd: only });
        }
    });

    it('round-trips every weapon slot request', () => {
        for (let slot = 0; slot <= 255; slot++) {
            const c: NetCmd = { ...cmd, slot, swap: false, aim: false };
            expect((decodeClient(encodeClient({ type: 'cmd', cmd: c }) as Uint8Array) as { cmd: NetCmd }).cmd.slot).toBe(slot);
        }
    });

    it('decodes a command from a view into a larger buffer', () => {
        const wire = encodeClient({ type: 'cmd', cmd }) as Uint8Array;
        const padded = new Uint8Array(64);
        padded.set(wire, 10);
        expect(decodeClient(padded.subarray(10, 36))).toEqual({ type: 'cmd', cmd });
    });

    it('rejects malformed commands', () => {
        expect(() => decodeClient(new Uint8Array(3))).toThrow();
        expect(() => decodeClient(new Uint8Array(26))).toThrow(); // wrong tag
        const short = encodeClient({ type: 'cmd', cmd }) as Uint8Array;
        expect(() => decodeClient(short.subarray(0, 24))).toThrow(); // a version 6 command
        expect(() => decodeClient(short.subarray(0, 25))).toThrow(); // a version 10 command (no drop byte)
        expect(() => decodeClient(new Uint8Array(4096))).toThrow();
    });

    it('carries the own armor exactly from 0 to 100, next to health', () => {
        for (const armor of [0, 1, 17, 99, 100]) {
            const snap: ServerMsg = {
                type: 'snap', time: 1, ack: 1,
                me: { team: 'defenders', actionTicks: 300, carry: { carrier: false, wait: 0 }, vis: 1, pos: [0, 0, 0], vel: [0, 0, 0], onGround: true, crouched: false, health: 100 - armor, armor, alive: true, respawnAt: 77.5, spectateId: 0, loadout: createLoadout(), knife: createKnifeState() },
                players: []
            };
            const back = decodeServer(encodeServer(snap) as Uint8Array);
            if (back.type !== 'snap') throw new Error('wrong type');
            expect(back.me.armor).toBe(armor);
            expect(back.me.health).toBe(100 - armor);
            expect(back.me.actionTicks).toBe(300);
            expect(back.me.respawnAt).toBe(77.5);
        }
    });

    it('round-trips a snapshot: local player exactly, others within rendering precision', () => {
        const snap: ServerMsg = {
            type: 'snap', time: 123456.789, ack: 4242,
            me: {
                team: 'ghosts', actionTicks: 179, vis: 0.35, pos: [1.23456789012345, 0, -19.87654321098765],
                vel: [5.2, -3.3333333333, 0.000001], onGround: true, crouched: false, health: 66, armor: 37, alive: true,
                respawnAt: 0, spectateId: 321,
                loadout: {
                    slot: 1, prev: 0, draw: 24, aim: 12, trigger: 1, sight: 2,
                    guns: [
                        { mag: 17, reserve: 90, reload: 132, cooldown: 6, burst: 29, sinceShot: 255, shots: 201 },
                        { mag: 11, reserve: 36, reload: 84, cooldown: 9, burst: 11, sinceShot: 3, shots: 255 }
                    ],
                    knife: { cooldown: 30, windup: 7 }
                },
                knife: { cooldown: 41, windup: 12 },
                carry: { carrier: true, wait: 60 }
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
        if (back.type !== 'snap' || snap.type !== 'snap') throw new Error('wrong type');

        expect(back.time).toBe(snap.time);
        expect(back.ack).toBe(4242);
        expect(back.me.pos).toEqual(snap.me.pos); // float64: prediction replays from this exactly
        expect(back.me.vel).toEqual(snap.me.vel);
        expect(back.me.loadout).toEqual(snap.me.loadout); // the weapons are predicted too: integers, exact
        expect(back.me.knife).toEqual(snap.me.knife); // so is the knife timing
        expect(back.me).toMatchObject({ team: 'ghosts', onGround: true, crouched: false, alive: true, health: 66, armor: 37 });
        expect(back.me.actionTicks).toBe(179); // exact: the client predicts when a plant completes
        // Every self field survives (vis is quantised): nothing shifted when armor took byte 15.
        expect({ ...back.me, vis: 0 }).toEqual({ ...snap.me, vis: 0 });
        expect(back.me.carry).toEqual({ carrier: true, wait: 60 }); // exact: the client predicts the bomb carry
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
            loadout.slot = loadout.prev = v % SLOT_COUNT;
            loadout.draw = loadout.aim = v;
            loadout.trigger = v & 1;
            for (const g of loadout.guns) { g.mag = g.reserve = g.reload = g.cooldown = g.burst = g.sinceShot = g.shots = v; }
            loadout.knife.cooldown = v;
            loadout.knife.windup = 255 - v; // the defender knife's two counters, independently of the ghost knife's
            const back = decodeServer(encodeServer({
                type: 'snap', time: 1, ack: 2, players: [],
                me: { team: 'defenders', actionTicks: 0, carry: { carrier: false, wait: 0 }, vis: 1, pos: [0, 0, 0], vel: [0, 0, 0], onGround: true, crouched: false, health: 100, armor: 100, alive: true, respawnAt: 0, spectateId: 0, loadout, knife: { cooldown: 255 - v, windup: v } }
            }) as Uint8Array);
            expect(back.type === 'snap' && back.me.loadout).toEqual(loadout);
            expect(back.type === 'snap' && back.me.knife).toEqual({ cooldown: 255 - v, windup: v });
        }
    });

    it('tells others a defender holds the knife (slot 3)', () => {
        const back = decodeServer(encodeServer({
            type: 'snap', time: 1, ack: 2,
            me: { team: 'defenders', actionTicks: 0, carry: { carrier: false, wait: 0 }, vis: 1, pos: [0, 0, 0], vel: [0, 0, 0], onGround: true, crouched: false, health: 100, armor: 100, alive: true, respawnAt: 0, spectateId: 0, loadout: createLoadout(), knife: createKnifeState() },
            players: [{ id: 3, team: 'defenders', pos: [0, 0, 0], yaw: 0, pitch: 0, crouched: false, alive: true, vis: 1, reloading: false, weapon: SLOT_KNIFE, switching: true, aiming: false }]
        }) as Uint8Array);
        expect(back.type === 'snap' && back.players[0]).toMatchObject({ weapon: SLOT_KNIFE, switching: true });
    });

    it('decodes a report frame, keeps its shape only, and refuses a malformed one', () => {
        const msg = { type: 'report' as const, kind: 'error' as const, text: 'boom', stack: 'at x', ctx: { fps: 60, ua: 'x' } };
        expect(decodeClient(encodeClient(msg) as string)).toEqual(msg);
        expect(decodeClient('{"type":"report","kind":"feedback","text":"hi","ctx":{}}')).toEqual({ type: 'report', kind: 'feedback', text: 'hi', ctx: {} });
        for (const bad of [
            '{"type":"report","kind":"other","text":"x","ctx":{}}', '{"type":"report","kind":"feedback","text":5,"ctx":{}}',
            '{"type":"report","kind":"feedback","text":"x"}', '{"type":"report","kind":"feedback","text":"x","ctx":[]}'
        ]) expect(() => decodeClient(bad)).toThrow();
        // Reports may be long; every other JSON message keeps the 600 character limit.
        expect(decodeClient(JSON.stringify({ type: 'report', kind: 'feedback', text: 'x'.repeat(3000), ctx: {} })).type).toBe('report');
        expect(() => decodeClient(JSON.stringify({ type: 'chat', team: false, text: 'x'.repeat(700) }))).toThrow();
        expect(() => decodeClient(JSON.stringify({ type: 'report', kind: 'feedback', text: 'x'.repeat(5000), ctx: {} }))).toThrow();
    });

    it('keeps an acknowledgement of -1 (nothing simulated yet)', () => {
        const back = decodeServer(encodeServer({
            type: 'snap', time: 0, ack: -1, players: [],
            me: { team: 'defenders', actionTicks: 0, carry: { carrier: false, wait: 0 }, vis: 1, pos: [0, 0, 0], vel: [0, 0, 0], onGround: false, crouched: false, health: 100, armor: 100, alive: false, respawnAt: 0, spectateId: 0, loadout: createLoadout(), knife: createKnifeState() }
        }) as Uint8Array);
        expect(back.type === 'snap' && back.ack).toBe(-1);
    });

    it('sends rare events as JSON text', () => {
        const msg: ServerMsg = { type: 'spawn', pos: [1, 2, 3], yaw: 1.5, sight: 1 };
        const wire = encodeServer(msg);
        expect(typeof wire).toBe('string');
        expect(decodeServer(wire as string)).toEqual(msg);
    });

    it('rejects unknown binary from the server', () => {
        expect(() => decodeServer(new Uint8Array(10))).toThrow();
    });

    it('round-trips the JSON client messages and rejects junk', () => {
        expect(decodeClient(encodeClient({ type: 'chat', team: true, text: 'hi' }) as string)).toEqual({ type: 'chat', team: true, text: 'hi' });
        expect(decodeClient(encodeClient({ type: 'ready', ready: true }) as string)).toEqual({ type: 'ready', ready: true });
        expect(decodeClient('{"type":"start"}')).toEqual({ type: 'start' });
        expect(decodeClient('{"type":"team"}')).toEqual({ type: 'team' });
        expect(() => decodeClient('{"type":"chat","text":5}')).toThrow();
        expect(() => decodeClient('{"type":"nope"}')).toThrow();
        expect(() => decodeClient('x'.repeat(700))).toThrow();
    });
});
