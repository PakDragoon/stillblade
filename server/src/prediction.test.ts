import { describe, expect, it } from 'vitest';
import { TICK_DT, TICK_RATE } from '../../shared/constants';
import { MELEE_SLASH, MELEE_SWING, aimFraction, copyLoadout, createLoadout, emptyReload, resetLoadout, sameLoadout, stepLoadout } from '../../shared/gun';
import {
    CARRY_DROPPED, CARRY_PICKED, copyCarry, createCarry, resetCarry, restingPoint, sameCarry, stepCarry
} from '../../shared/bomb';
import { copyKnifeState, createKnifeState, resetKnife, sameKnifeState, stepKnife } from '../../shared/knife';
import { copyPlayerState, createPlayerState, stepPlayer } from '../../shared/movement';
import { decodeClient, decodeServer, encodeClient, encodeServer, type NetCmd, type ServerMsg, type Wire } from '../../shared/protocol';
import { FREEZE_MS, PLANT_TICKS, canAct, gateWeaponInput, movementLocked, type Phase } from '../../shared/rules';
import type { MapData, Vec3 } from '../../shared/types';
import { SLOT_KNIFE, SLOT_PISTOL, SLOT_RIFLE } from '../../shared/weapons';
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
function playThrough(opts: {
    seed: number; ticks: number; upTicks: number; downTicks: number; seqJump?: () => number;
    /**
     * Rifle sights (package M): the first is chosen at join (join query), then every `lifeTicks` the client
     * sends the next one as a `sight` message (mid-life, through the JSON wire) and the server kills it a
     * moment later; it respawns 3 s after (warmup) with the new sight mounted.
     */
    sights?: number[]; lifeTicks?: number;
}) {
    const game = new Game(map, { rounds: false });
    // A still ghost far away, so the defender has a team to play against.
    const ghostId = game.join({ send: () => {} });
    const down: { at: number; wire: Wire }[] = [];
    const up: { at: number; wire: Wire }[] = [];
    let tick = 0;
    const sights = opts.sights ?? [];
    const id = game.join({ send: (m: ServerMsg) => down.push({ at: tick + opts.downTicks, wire: encodeServer(m) }) }, '',
        sights.length ? { sight: sights[0] } : {});
    // Test-only reach into the server's damage rule, to end a life on cue.
    const kill = (): void => {
        (game as unknown as { damage(v: unknown, amount: number, by: unknown, kind: 'knife'): boolean })
            .damage(game.players.get(id), 1000, game.players.get(ghostId), 'knife');
    };
    let sightIndex = 0, lifeAt = 0;

    const curr = createPlayerState([0, 0, 0]);
    const loadout = createLoadout();
    const before = createLoadout();
    const pending: Pending[] = [];
    let alive = false, started = false, yaw = 0, seq = 0, ghostSeq = 0;
    const result = {
        snapshots: 0, gunMismatches: 0, knifeMismatches: 0, posMismatches: 0, shots: [0, 0], switches: 0, reloads: 0, emptyReloads: 0, aimedShots: 0,
        swings: 0, slashes: 0, knifeSnapshots: 0,
        /** Snapshots of a living defender fully aimed with the rifle, per active sight; and lives started. */
        aimedBySight: [0, 0, 0], spawns: 0, spawnSights: [] as number[]
    };

    const rand = rng(opts.seed);
    let fireHold = 0, aimHold = 0, moveHold = 0, forward = 0, right = 0, crouch = false;

    for (tick = 1; tick <= opts.ticks; tick++) {
        game.tick(tick * TICK_MS);
        game.handleCmd(ghostId, {
            seq: ghostSeq++, forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, walk: false, crouch: false, fire: false,
            use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: game.now
        });

        // Deliver what has reached the client.
        while (down.length && down[0].at <= tick) {
            const raw = down.shift()!.wire;
            const msg = decodeServer(typeof raw === 'string' ? raw : raw);
            if (msg.type === 'spawn') {
                pending.length = 0;
                copyPlayerState(curr, createPlayerState(msg.pos));
                yaw = Math.fround(msg.yaw);
                alive = true;
                resetLoadout(loadout, msg.sight);
                result.spawns++;
                result.spawnSights.push(msg.sight);
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
                    if (!c.live) continue;
                    stepPlayer(curr, c, TICK_DT, map.boxes);
                    stepLoadout(loadout, c, c.armed);
                }
                if (!sameLoadout(loadout, before)) result.gunMismatches++;
                if (!sameKnifeState(loadout.knife, before.knife)) result.knifeMismatches++;
                if (loadout.slot === SLOT_KNIFE) result.knifeSnapshots++;
                if (loadout.slot === SLOT_RIFLE && aimFraction(loadout) === 1) result.aimedBySight[loadout.sight]++;
                if (curr.pos[0] !== px || curr.pos[1] !== py || curr.pos[2] !== pz) result.posMismatches++;
            }
        }

        // Like the real client, which starts its simulation only once the welcome and spawn are in.
        if (!started) { if (!alive) continue; started = true; lifeAt = tick; }

        // Sights: choose the next one mid-life, then die a little later and come back with it.
        if (sights.length && opts.lifeTicks) {
            const age = tick - lifeAt;
            if (alive && age === opts.lifeTicks) {
                sightIndex = (sightIndex + 1) % sights.length;
                up.push({ at: tick + opts.upTicks, wire: encodeClient({ type: 'sight', sight: sights[sightIndex] }) });
            }
            if (alive && age === opts.lifeTicks + 30) kill();
            if (!alive && age > opts.lifeTicks) lifeAt = tick + 1; // counts again from the respawn
        }

        // A restless player: bursts and taps, knife swings, switches by key (1, 2, 3, and a slot that does not
        // exist) and by Q, aiming, reloads, moving about.
        if (fireHold > 0) fireHold--; else if (rand() < 0.04) fireHold = rand() < 0.5 ? 1 + Math.floor(rand() * 3) : Math.floor(rand() * 60);
        if (aimHold > 0) aimHold--; else if (rand() < (sights.length ? 0.03 : 0.01)) aimHold = Math.floor(rand() * 90); // sight runs aim more
        if (moveHold > 0) moveHold--; else {
            moveHold = Math.floor(rand() * 40);
            forward = Math.floor(rand() * 3) - 1;
            right = Math.floor(rand() * 3) - 1;
            crouch = rand() < 0.15;
        }
        yaw = Math.fround(yaw + (rand() - 0.5) * 0.02);
        const r = rand();
        // Keep generating controls even while dead. Late observer commands must not move the newly spawned body.
        const cmd: Pending = {
            seq, forward, right, yaw, pitch: Math.fround(0.5 + rand() * 0.2), jump: rand() < 0.01, walk: rand() < 0.2, crouch,
            fire: fireHold > 0, use: false, reload: alive && rand() < 0.01,
            slot: !alive ? 0 : r < 0.006 ? 1 : r < 0.012 ? 2 : r < 0.018 ? 3 : r < 0.019 ? 7 : 0, swap: alive && rand() < 0.005, aim: aimHold > 0,
            drop: seq % 97 === 0, viewTime: game.now, live: alive, observerOnly: !alive, armed: true
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
            // Package R: a reload started on an empty magazine is the longer empty reload, predicted the same way.
            if (shot === -2 && emptyReload(loadout.guns[loadout.slot])) result.emptyReloads++;
            if (shot === MELEE_SWING) result.swings++;
            if (shot === MELEE_SLASH) result.slashes++;
        }
        up.push({ at: tick + opts.upTicks, wire: encodeClient({ type: 'cmd', cmd }) });
        while (up.length && up[0].at <= tick) {
            const msg = decodeClient(up.shift()!.wire);
            if (msg.type === 'cmd') game.handleCmd(id, msg.cmd);
            else game.handleMessage(id, msg);
        }
    }
    return result;
}

describe('client prediction of the loadout through the wire', () => {
    it('never disagrees with the server at 150 ms round trip', () => {
        // 9 ticks each way is 150 ms of round trip; two minutes of play.
        // Seed 5: a script that spends a fair share of time on all three slots. The rifle's count is capped by
        // its 120 rounds (nothing refills them here) and by the time now spent on the knife.
        const r = playThrough({ seed: 5, ticks: 120 * TICK_RATE, upTicks: 4, downTicks: 5 });
        expect(r.snapshots).toBeGreaterThan(3000);
        expect(r.shots[SLOT_RIFLE]).toBeGreaterThan(80);
        expect(r.shots[SLOT_PISTOL]).toBeGreaterThan(30);
        expect(r.switches).toBeGreaterThan(20);
        expect(r.reloads).toBeGreaterThan(5);
        expect(r.emptyReloads).toBeGreaterThan(0);
        expect(r.emptyReloads).toBeLessThan(r.reloads);
        expect(r.aimedShots).toBeGreaterThan(10);
        expect(r.swings).toBeGreaterThan(15); // the knife (slot 3) is predicted and replayed like the guns
        expect(r.slashes).toBeGreaterThan(10);
        expect(r.knifeSnapshots).toBeGreaterThan(300);
        expect(r.gunMismatches).toBe(0);
        expect(r.knifeMismatches).toBe(0);
        expect(r.posMismatches).toBe(0);
    });

    it('never disagrees across other seeds and delays, or when the client jumps its command numbers', () => {
        for (const [seed, upTicks, downTicks] of [[2, 1, 1], [3, 9, 9], [4, 0, 15]]) {
            const r = playThrough({ seed, ticks: 40 * TICK_RATE, upTicks, downTicks });
            expect(r.shots[SLOT_PISTOL]).toBeGreaterThan(5);
            expect(r.swings).toBeGreaterThan(3);
            expect(r.gunMismatches).toBe(0);
            expect(r.knifeMismatches).toBe(0);
            expect(r.posMismatches).toBe(0);
        }
        const jumpy = rng(9);
        const r = playThrough({ seed: 5, ticks: 40 * TICK_RATE, upTicks: 4, downTicks: 5, seqJump: () => 1 + Math.floor(jumpy() * 1000) });
        expect(r.switches).toBeGreaterThan(5);
        expect(r.swings).toBeGreaterThan(3);
        expect(r.gunMismatches).toBe(0);
        expect(r.knifeMismatches).toBe(0);
    });
});

describe('client prediction with every rifle sight (package M)', () => {
    it('never disagrees with any sight, or when the sight changes across respawns', () => {
        // Iron, red dot, 2x scope, and back: each life chooses the next mid-life and gets it at the respawn.
        for (const [seed, upTicks, downTicks] of [[5, 4, 5], [3, 9, 9], [4, 0, 15], [2, 1, 1]]) {
            const r = playThrough({ seed, ticks: 150 * TICK_RATE, upTicks, downTicks, sights: [0, 1, 2], lifeTicks: 20 * TICK_RATE });
            expect(r.spawns).toBeGreaterThanOrEqual(5);
            // Every life after the first mounts the sight chosen during the life before it.
            for (let i = 0; i < r.spawnSights.length; i++) expect(r.spawnSights[i]).toBe([0, 1, 2][i % 3]);
            for (let sight = 0; sight < 3; sight++) expect(r.aimedBySight[sight]).toBeGreaterThan(15);
            expect(r.shots[SLOT_RIFLE]).toBeGreaterThan(30);
            expect(r.aimedShots).toBeGreaterThan(5);
            expect(r.gunMismatches).toBe(0);
            expect(r.knifeMismatches).toBe(0);
            expect(r.posMismatches).toBe(0);
        }
    });

    it('never disagrees with each sight held for a whole session', () => {
        for (let sight = 0; sight < 3; sight++) {
            const r = playThrough({ seed: 7 + sight, ticks: 40 * TICK_RATE, upTicks: 4, downTicks: 5, sights: [sight] });
            expect(r.spawnSights).toEqual([sight]);
            expect(r.aimedBySight[sight]).toBeGreaterThan(30);
            expect(r.gunMismatches).toBe(0);
            expect(r.posMismatches).toBe(0);
        }
    });

    it('never disagrees across respawns when the client jumps its command numbers', () => {
        const jumpy = rng(13);
        const r = playThrough({
            seed: 6, ticks: 90 * TICK_RATE, upTicks: 4, downTicks: 5, sights: [2, 0, 1], lifeTicks: 15 * TICK_RATE,
            seqJump: () => 1 + Math.floor(jumpy() * 1000)
        });
        expect(r.spawns).toBeGreaterThanOrEqual(3);
        expect(r.gunMismatches).toBe(0);
        expect(r.posMismatches).toBe(0);
    });
});

// ---------------------------------------------------------------------------------------------
// The bomb carrier: a predicted ghost carries the bomb, drops it, picks it back up after the repick
// wait, loses it to a teammate (server-side only, so the client learns of it through `bomb` messages),
// picks it up again where the teammate dropped it, then plants in a site while still pushing the
// movement keys, and keeps them pressed after the plant completes.
// ---------------------------------------------------------------------------------------------

const siteMap: MapData = {
    name: 'site',
    bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
    boxes: [
        { min: [-50, -0.5, -50], max: [50, 0, 50] },
        { min: [8, 0, 4], max: [9, 2, 12] } // a wall to walk along
    ],
    spawns: { ghosts: [{ pos: [0, 0, 20], yaw: 0 }, { pos: [3, 0, 20], yaw: 0 }], defenders: [{ pos: [30, 0, -40], yaw: 0 }] },
    bombSites: [{ name: 'A', min: [-4, 0, -4], max: [4, 3, 4] }]
};

interface GhostPending extends NetCmd { live: boolean; armed: boolean; acting: boolean }

const yawToward = (from: Vec3, to: Vec3): number => Math.fround(Math.atan2(-(to[0] - from[0]), -(to[2] - from[2])));
const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[2] - b[2]);

function playGhost(opts: { seed: number; upTicks: number; downTicks: number; seqJump?: () => number }) {
    const game = new Game(siteMap, { rounds: true });
    const down: { at: number; wire: Wire }[] = [];
    const up: { at: number; wire: Wire }[] = [];
    let tick = 0;
    const id = game.join({ send: (m: ServerMsg) => down.push({ at: tick + opts.downTicks, wire: encodeServer(m) }) });
    const defenderId = game.join({ send: () => {} });
    const mateId = game.join({ send: () => {} });
    const mate = game.players.get(mateId)!;
    let mateSeq = 0, defenderSeq = 0;

    // The client's predicted state, as in client/src/main.ts.
    const curr = createPlayerState([0, 0, 0]);
    const knife = createKnifeState();
    const knifeBefore = createKnifeState();
    const carry = createCarry();
    const carryBefore = createCarry();
    const lastGround: Vec3 = [0, 0, 0];
    let droppedPred: Vec3 | null = null, serverDropped: Vec3 | null = null;
    let actionTicks = 0, phaseOverride: Phase | null = null;
    let phase: Phase = 'warmup', bombPos: Vec3 | null = null;
    const pending: GhostPending[] = [];
    let alive = false, seq = 0, yaw = 0;
    const result = {
        snapshots: 0, posMismatches: 0, knifeMismatches: 0, carryMismatches: 0,
        drops: 0, pickups: 0, mateHad: false, planted: false, movedAfterPlant: false, lockedTicks: 0
    };

    const stepObjective = (c: GhostPending): number => {
        if (curr.onGround) { lastGround[0] = curr.pos[0]; lastGround[1] = curr.pos[1]; lastGround[2] = curr.pos[2]; }
        const r = stepCarry(carry, c.drop, c.acting, curr, droppedPred);
        if (r === CARRY_DROPPED) droppedPred = restingPoint(curr, siteMap.boxes, lastGround, [0, 0, 0]);
        else if (r === CARRY_PICKED) droppedPred = null;
        if (!c.acting) actionTicks = 0;
        else if (++actionTicks >= PLANT_TICKS) { actionTicks = 0; carry.carrier = false; phaseOverride = 'planted'; }
        return r;
    };

    // The script: where to go next, and what to press there.
    const rand = rng(opts.seed);
    let stage = 0, stageTicks = 0, fireHold = 0;
    const DROP_A: Vec3 = [-10, 0, 10], DROP_B: Vec3 = [-14, 0, 4], MATE_DROP: Vec3 = [12, 0, 0], SITE: Vec3 = [0, 0, 0];
    let mateStage = 0, mateTicks = 0;

    for (tick = 1; tick <= 120 * TICK_RATE; tick++) {
        game.tick(tick * TICK_MS);
        game.handleCmd(defenderId, {
            seq: defenderSeq++, forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, walk: false, crouch: false, fire: false,
            use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: game.now
        });
        // The teammate, simulated by the server only: waits by its spawn, walks to where we dropped the
        // bomb the second time, carries it to MATE_DROP and drops it there, then walks away.
        {
            const m = mate.state.pos;
            let target: Vec3 | null = null, drop = false;
            if (mateStage === 0 && game.dropped && flat(game.dropped, DROP_B) < 0.5) mateStage = 1;
            if (mateStage === 1) { target = DROP_B; if (game.carrierId === mateId) { mateStage = 2; result.mateHad = true; } }
            if (mateStage === 2) { target = MATE_DROP; if (flat(m, MATE_DROP) < 0.3) { drop = true; mateStage = 3; } }
            if (mateStage === 3) { target = [20, 0, 10]; if (++mateTicks > 200) target = null; }
            const go = target !== null && flat(m, target) > 0.2;
            game.handleCmd(mateId, {
                seq: mateSeq++, forward: go ? 1 : 0, right: 0, yaw: target ? yawToward(m, target) : 0, pitch: 0, jump: false,
                walk: target !== null && flat(m, target) < 1.5, crouch: false, fire: false, use: false, reload: false, slot: 0,
                swap: false, aim: false, drop, viewTime: game.now
            });
        }

        while (down.length && down[0].at <= tick) {
            const msg = decodeServer(down.shift()!.wire);
            if (msg.type === 'spawn') {
                copyPlayerState(curr, createPlayerState(msg.pos));
                yaw = Math.fround(msg.yaw);
                alive = true;
                resetKnife(knife);
                resetCarry(carry);
                actionTicks = 0;
                phaseOverride = null;
            } else if (msg.type === 'round') {
                phase = msg.phase;
                bombPos = msg.bomb;
                phaseOverride = null;
                if (phase === 'planted') result.planted = true;
            } else if (msg.type === 'bomb') {
                serverDropped = msg.dropped ? [...msg.dropped] as Vec3 : null;
                // Handing out the bomb at the round start (and clearing it) happens outside any command.
                if (msg.carrier !== undefined && (msg.event === undefined || msg.event === 'assign')) carry.carrier = msg.carrier === id;
                if (!carry.carrier) droppedPred = serverDropped;
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
                copyKnifeState(knifeBefore, knife);
                copyKnifeState(knife, msg.me.knife);
                copyCarry(carryBefore, carry);
                copyCarry(carry, msg.me.carry);
                const actionBefore = actionTicks;
                actionTicks = msg.me.actionTicks;
                droppedPred = serverDropped;
                phaseOverride = null;
                for (const c of pending) {
                    stepPlayer(curr, c, TICK_DT, siteMap.boxes);
                    if (!c.live) continue;
                    stepKnife(knife, c.fire, c.armed);
                    stepObjective(c);
                }
                if (!sameKnifeState(knife, knifeBefore)) result.knifeMismatches++;
                if (!sameCarry(carry, carryBefore) || actionTicks !== actionBefore) result.carryMismatches++;
                if (curr.pos[0] !== px || curr.pos[1] !== py || curr.pos[2] !== pz) result.posMismatches++;
            }
        }
        if (!alive) continue;

        // Our script, steered on our own predicted position.
        stageTicks++;
        let target: Vec3 | null = null, use = false, drop = false, forward = 0, right = 0;
        if (fireHold > 0) fireHold--; else if (rand() < 0.03 && stage > 0) fireHold = Math.floor(rand() * 30);
        switch (stage) {
            case 0: // the freeze: hold use (nothing to plant yet). No movement keys or attack here: the
                // warmup-to-freeze and freeze-to-live edges reach the client late (HANDOFF.md, phase edges).
                use = rand() < 0.5;
                if (phase === 'live' && stageTicks > 60) { stage = 1; stageTicks = 0; }
                break;
            case 1: // walk to DROP_A, holding use now and then (outside a site: no effect), and drop it there
                target = DROP_A; use = rand() < 0.3;
                if (flat(curr.pos, DROP_A) < 0.25) { drop = true; stage = 2; stageTicks = 0; }
                break;
            case 2: // stand on it: picked up again on the 61st command after the drop
                if (carry.carrier) { stage = 3; stageTicks = 0; }
                break;
            case 3: // drop it at DROP_B for the teammate and step back out of reach
                target = DROP_B;
                if (carry.carrier && flat(curr.pos, DROP_B) < 0.25) drop = true;
                if (!carry.carrier && stageTicks > 5) { stage = 4; stageTicks = 0; }
                break;
            case 4: // wait well away while the teammate collects it and drops it at MATE_DROP
                target = [-20, 0, 15];
                if (serverDropped && flat(serverDropped, MATE_DROP) < 0.5 && mateStage === 3) { stage = 5; stageTicks = 0; }
                break;
            case 5: // fetch it from where the teammate left it (known only from the server's `bomb` message)
                target = MATE_DROP;
                if (carry.carrier) { stage = 6; stageTicks = 0; }
                break;
            case 6: // into the site
                target = SITE;
                if (flat(curr.pos, SITE) < 0.5) { stage = 7; stageTicks = 0; }
                break;
            case 7: // plant: hold use and keep pushing forward and sideways the whole time, and after
                use = true; forward = 1; right = rand() < 0.5 ? 1 : -1;
                if (stageTicks > PLANT_TICKS + 90) { stage = 8; stageTicks = 0; }
                break;
            default: // let go
                forward = rand() < 0.5 ? 1 : 0;
        }
        if (target) {
            yaw = yawToward(curr.pos, target);
            forward = flat(curr.pos, target) > 0.15 ? 1 : 0;
        }
        const cmd: GhostPending = {
            seq, forward, right, yaw, pitch: 0, jump: false, walk: target !== null && flat(curr.pos, target) < 1.5, crouch: false,
            fire: fireHold > 0 && stage !== 7, use, reload: false, slot: 0, swap: false, aim: false, drop,
            viewTime: game.now, live: alive, armed: false, acting: false
        };
        const ph = phaseOverride ?? phase;
        const acting = cmd.use && canAct('ghosts', ph, curr, siteMap, bombPos, carry.carrier);
        if (movementLocked(cmd.use, 'ghosts', ph, curr, siteMap, bombPos, carry.carrier)) {
            cmd.forward = 0; cmd.right = 0; cmd.jump = false;
            if (acting) result.lockedTicks++;
        }
        cmd.armed = !acting && ph !== 'freeze';
        cmd.acting = acting;
        seq += opts.seqJump ? opts.seqJump() : 1;
        pending.push(cmd);
        const bx = curr.pos[0], bz = curr.pos[2];
        stepPlayer(curr, cmd, TICK_DT, siteMap.boxes);
        stepKnife(knife, cmd.fire, cmd.armed);
        const r = stepObjective(cmd);
        if (r === CARRY_DROPPED) result.drops++;
        if (r === CARRY_PICKED) result.pickups++;
        if (stage === 7 && ph === 'planted' && (curr.pos[0] !== bx || curr.pos[2] !== bz)) result.movedAfterPlant = true;

        up.push({ at: tick + opts.upTicks, wire: encodeClient({ type: 'cmd', cmd }) });
        while (up.length && up[0].at <= tick) {
            const msg = decodeClient(up.shift()!.wire as Uint8Array);
            game.handleCmd(id, (msg as { cmd: NetCmd }).cmd);
        }
        if (stage === 8 && stageTicks > 60) break;
    }
    return { ...result, stage };
}

describe('client prediction of the bomb carrier through the wire', () => {
    it('never disagrees around a drop, the repick wait, a pickup, a teammate pickup and a plant', () => {
        for (const [seed, upTicks, downTicks] of [[1, 4, 5], [2, 1, 1], [3, 9, 9], [4, 0, 15]]) {
            const r = playGhost({ seed, upTicks, downTicks });
            expect(r.stage).toBe(8); // the whole script ran
            expect(r.drops).toBe(2); // at DROP_A, and at DROP_B for the teammate
            expect(r.pickups).toBe(2); // our own bomb after the wait, and the teammate's drop
            expect(r.mateHad).toBe(true);
            expect(r.planted).toBe(true);
            expect(r.lockedTicks).toBe(PLANT_TICKS); // rooted for exactly the plant, not a command more
            expect(r.movedAfterPlant).toBe(true); // and free the moment it completed, before the round message
            expect(r.posMismatches).toBe(0);
            expect(r.knifeMismatches).toBe(0);
            expect(r.carryMismatches).toBe(0);
        }
    });

    it('never disagrees when the client jumps its command numbers', () => {
        const jumpy = rng(11);
        const r = playGhost({ seed: 1, upTicks: 4, downTicks: 5, seqJump: () => 1 + Math.floor(jumpy() * 1000) });
        expect(r.stage).toBe(8);
        expect(r.pickups).toBe(2);
        expect(r.planted).toBe(true);
        expect(r.posMismatches).toBe(0);
        expect(r.carryMismatches).toBe(0);
    });
});


it('keeps a held rifle trigger silent through the delayed freeze and matches every live shot', () => {
    const game = new Game(map);
    game.join({ send: () => {} });
    const down: { at: number; phase: Phase }[] = [];
    const up: { at: number; wire: Wire }[] = [];
    const authoritativeShots: number[] = [];
    const predictedShots: number[] = [];
    let phase: Phase = 'freeze';
    let tick = 0;
    const id = game.join({ send: m => {
        if (m.type === 'round') down.push({ at: tick + 5, phase: m.phase });
        if (m.type === 'shot' && m.shooter === id) authoritativeShots.push(tick - 4);
    } });
    const loadout = createLoadout();
    for (tick = 1; tick < FREEZE_MS / TICK_MS + 100; tick++) {
        game.tick(tick * TICK_MS);
        while (down.length && down[0].at <= tick) {
            const seen = down.shift()!.phase;
            if (seen !== 'warmup') phase = seen;
        }
        if (tick < 20) continue; // already in freeze, then hold both aim and fire through the transition
        const cmd: NetCmd = {
            seq: tick, forward: 0, right: 0, yaw: Math.fround(Math.PI), pitch: 1, jump: false,
            walk: false, crouch: false, fire: true, use: false, reload: false,
            slot: 0, swap: false, aim: true, drop: false, viewTime: game.now
        };
        const armed = gateWeaponInput(cmd, phase, false);
        if (stepLoadout(loadout, cmd, armed) >= 0) predictedShots.push(tick);
        if (tick < FREEZE_MS / TICK_MS + 90) up.push({ at: tick + 4, wire: encodeClient({ type: 'cmd', cmd }) });
        while (up.length && up[0].at <= tick) {
            const msg = decodeClient(up.shift()!.wire);
            if (msg.type === 'cmd') game.handleCmd(id, msg.cmd);
        }
    }
    expect(predictedShots[0]).toBeGreaterThan(FREEZE_MS / TICK_MS + 1);
    expect(authoritativeShots.length).toBeGreaterThan(0);
    expect(authoritativeShots).toEqual(predictedShots.filter(t => t < FREEZE_MS / TICK_MS + 90));
});
