import { describe, expect, it } from 'vitest';
import { TICK_DT, TICK_RATE } from '../../shared/constants';
import { copyLoadout, createLoadout, resetLoadout, sameLoadout, stepLoadout } from '../../shared/gun';
import { copyPlayerState, createPlayerState, stepPlayer } from '../../shared/movement';
import { decodeClient, decodeServer, encodeClient, encodeServer, type NetCmd, type ServerMsg, type Wire } from '../../shared/protocol';
import type { MapData } from '../../shared/types';
import { SLOT_PISTOL, SLOT_RIFLE } from '../../shared/weapons';
import { Game } from './game';

const TICK_MS = 1000 / TICK_RATE;

const map: MapData = {
    name: 'test',
    bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
    boxes: [
        { min: [-50, -0.5, -50], max: [50, 0, 50] },
        { min: [2, 0, -14], max: [4, 1, -12] }, // a crate to bump into and jump on
        { min: [-6, 0, -16], max: [-5, 3, -4] } // a wall
    ],
    spawns: { ghosts: [{ pos: [0, 0, 20], yaw: 0 }], defenders: [{ pos: [0, 0, -10], yaw: 180 }] },
    bombSites: []
};

/** Small seeded generator so the input script is the same every run. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Pending extends NetCmd { live: boolean; armed: boolean }

/**
 * A client that predicts exactly as client/src/main.ts does (movement plus the weapon loadout,
 * replayed on every snapshot), talking to the real server through the binary wire format with a
 * fixed one-way delay each way. Every snapshot whose replay disagrees with the prediction counts.
 */
function playThrough(opts: { seed: number; ticks: number; upTicks: number; downTicks: number; seqJump?: () => number }) {
    const game = new Game(map, { rounds: false });
    // A still ghost far away, so the defender has a team to play against.
    const ghostId = game.join({ send: () => {} });
    const down: { at: number; wire: Wire }[] = [];
    const up: { at: number; wire: Wire }[] = [];
    let tick = 0;
    const id = game.join({ send: (m: ServerMsg) => down.push({ at: tick + opts.downTicks, wire: encodeServer(m) }) });

    const curr = createPlayerState([0, 0, 0]);
    const loadout = createLoadout();
    const before = createLoadout();
    const pending: Pending[] = [];
    let alive = false, started = false, yaw = 0, seq = 0, ghostSeq = 0;
    const result = { snapshots: 0, gunMismatches: 0, posMismatches: 0, shots: [0, 0], switches: 0, reloads: 0, aimedShots: 0 };

    const rand = rng(opts.seed);
    let fireHold = 0, aimHold = 0, moveHold = 0, forward = 0, right = 0, crouch = false;

    for (tick = 1; tick <= opts.ticks; tick++) {
        game.tick(tick * TICK_MS);
        game.handleCmd(ghostId, {
            seq: ghostSeq++, forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, walk: false, crouch: false, fire: false,
            use: false, reload: false, slot: 0, swap: false, aim: false, viewTime: game.now
        });

        // Deliver what has reached the client.
        while (down.length && down[0].at <= tick) {
            const raw = down.shift()!.wire;
            const msg = decodeServer(typeof raw === 'string' ? raw : raw);
            if (msg.type === 'spawn') {
                copyPlayerState(curr, createPlayerState(msg.pos));
                yaw = Math.fround(msg.yaw);
                alive = true;
                resetLoadout(loadout);
            } else if (msg.type === 'snap') {
                result.snapshots++;
                alive = msg.me.alive;
                while (pending.length && pending[0].seq <= msg.ack) pending.shift();
                if (!msg.me.alive) continue;
                const px = curr.pos[0], py = curr.pos[1], pz = curr.pos[2];
                curr.pos[0] = msg.me.pos[0]; curr.pos[1] = msg.me.pos[1]; curr.pos[2] = msg.me.pos[2];
                curr.vel[0] = msg.me.vel[0]; curr.vel[1] = msg.me.vel[1]; curr.vel[2] = msg.me.vel[2];
                curr.onGround = msg.me.onGround;
                curr.crouched = msg.me.crouched;
                copyLoadout(before, loadout);
                copyLoadout(loadout, msg.me.loadout);
                for (const c of pending) {
                    stepPlayer(curr, c, TICK_DT, map.boxes);
                    if (c.live) stepLoadout(loadout, c, c.armed);
                }
                if (!sameLoadout(loadout, before)) result.gunMismatches++;
                if (curr.pos[0] !== px || curr.pos[1] !== py || curr.pos[2] !== pz) result.posMismatches++;
            }
        }

        // Like the real client, which starts its simulation only once the welcome and spawn are in.
        if (!started) { if (!alive) continue; started = true; }

        // A restless player: bursts and taps, switches by key and by Q, aiming, reloads, moving about.
        if (fireHold > 0) fireHold--; else if (rand() < 0.04) fireHold = rand() < 0.5 ? 1 + Math.floor(rand() * 3) : Math.floor(rand() * 60);
        if (aimHold > 0) aimHold--; else if (rand() < 0.01) aimHold = Math.floor(rand() * 90);
        if (moveHold > 0) moveHold--; else {
            moveHold = Math.floor(rand() * 40);
            forward = Math.floor(rand() * 3) - 1;
            right = Math.floor(rand() * 3) - 1;
            crouch = rand() < 0.15;
        }
        yaw = Math.fround(yaw + (rand() - 0.5) * 0.02);
        const r = rand();
        const cmd: Pending = {
            seq, forward, right, yaw, pitch: Math.fround(0.5 + rand() * 0.2), jump: rand() < 0.01, walk: rand() < 0.2, crouch,
            fire: fireHold > 0, use: false, reload: rand() < 0.01,
            slot: r < 0.006 ? 1 : r < 0.012 ? 2 : r < 0.013 ? 7 : 0, swap: rand() < 0.005, aim: aimHold > 0,
            viewTime: game.now, live: alive, armed: true
        };
        seq += opts.seqJump ? opts.seqJump() : 1;
        pending.push(cmd);
        if (alive) {
            stepPlayer(curr, cmd, TICK_DT, map.boxes);
            const slot = loadout.slot;
            const shot = stepLoadout(loadout, cmd, cmd.armed);
            if (loadout.slot !== slot) result.switches++;
            if (shot >= 0) { result.shots[loadout.slot]++; if (loadout.aim > 0) result.aimedShots++; }
            if (shot === -2) result.reloads++;
        }
        up.push({ at: tick + opts.upTicks, wire: encodeClient({ type: 'cmd', cmd }) });
        while (up.length && up[0].at <= tick) {
            const msg = decodeClient(up.shift()!.wire as Uint8Array);
            game.handleCmd(id, msg.cmd);
        }
    }
    return result;
}

describe('client prediction of the loadout through the wire', () => {
    it('never disagrees with the server at 150 ms round trip', () => {
        // 9 ticks each way is 150 ms of round trip; two minutes of play.
        const r = playThrough({ seed: 1, ticks: 120 * TICK_RATE, upTicks: 4, downTicks: 5 });
        expect(r.snapshots).toBeGreaterThan(3000);
        expect(r.shots[SLOT_RIFLE]).toBeGreaterThan(100);
        expect(r.shots[SLOT_PISTOL]).toBeGreaterThan(30);
        expect(r.switches).toBeGreaterThan(20);
        expect(r.reloads).toBeGreaterThan(5);
        expect(r.aimedShots).toBeGreaterThan(10);
        expect(r.gunMismatches).toBe(0);
        expect(r.posMismatches).toBe(0);
    });

    it('never disagrees across other seeds and delays, or when the client jumps its command numbers', () => {
        for (const [seed, upTicks, downTicks] of [[2, 1, 1], [3, 9, 9], [4, 0, 15]]) {
            const r = playThrough({ seed, ticks: 40 * TICK_RATE, upTicks, downTicks });
            expect(r.shots[SLOT_PISTOL]).toBeGreaterThan(5);
            expect(r.gunMismatches).toBe(0);
            expect(r.posMismatches).toBe(0);
        }
        const jumpy = rng(9);
        const r = playThrough({ seed: 5, ticks: 40 * TICK_RATE, upTicks: 4, downTicks: 5, seqJump: () => 1 + Math.floor(jumpy() * 1000) });
        expect(r.switches).toBeGreaterThan(5);
        expect(r.gunMismatches).toBe(0);
    });
});
