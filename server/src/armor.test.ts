import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_ARMOR, MAX_HEALTH, RESPAWN_MS, TICK_RATE } from '../../shared/constants';
import { decodeServer, encodeServer, type NetCmd, type ServerMsg } from '../../shared/protocol';
import { DEFAULT_ROOM_OPTIONS } from '../../shared/room-options';
import { FREEZE_MS, ROUND_MS } from '../../shared/rules';
import type { MapData, Vec3 } from '../../shared/types';
import { Game, type Player } from './game';
import { loadMaps } from './maps';
import { Rooms } from './rooms';

/** Package P: armor on the server. The rule itself is tested in shared/armor.test.ts. */

const TICK_MS = 1000 / TICK_RATE;
const ticks = (ms: number): number => Math.ceil(ms / TICK_MS);
const MAPS = loadMaps(fileURLToPath(new URL('../../client/public/maps', import.meta.url)));

/** Ghosts spawn at z = ghostZ facing -Z, defenders at z = defenderZ facing +Z, two spawns per side 3 m apart. */
function makeMap(ghostZ = 10, defenderZ = -10): MapData {
    return {
        name: 'test',
        bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
        boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }],
        spawns: {
            ghosts: [{ pos: [0, 0, ghostZ], yaw: 0 }, { pos: [3, 0, ghostZ], yaw: 0 }],
            defenders: [{ pos: [0, 0, defenderZ], yaw: 180 }, { pos: [3, 0, defenderZ], yaw: 180 }]
        },
        bombSites: [{ name: 'A', min: [20, 0, 20], max: [26, 2.5, 26] }]
    };
}

/** A player whose every message is kept, and checked as it is sent against what this player may know. */
class Client {
    readonly inbox: ServerMsg[] = [];
    readonly id: number;
    yaw = 0;
    seq = 0;
    constructor(readonly game: Game, name: string, onSend: (c: Client, m: ServerMsg) => void = () => {}) {
        this.id = game.join({
            send: m => {
                if (m.type === 'spawn') this.yaw = m.yaw;
                onSend(this, m);
                // Through the real wire format: snapshots are binary, everything else JSON.
                this.inbox.push(decodeServer(encodeServer(m) as string | Uint8Array));
            }
        }, name);
    }
    get P(): Player { return this.game.players.get(this.id)!; }
    cmd(over: Partial<NetCmd> = {}): void {
        this.game.handleCmd(this.id, {
            seq: this.seq++, forward: 0, right: 0, yaw: this.yaw, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: this.game.now, ...over
        });
    }
    all<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }>[] {
        return this.inbox.filter(m => m.type === type) as Extract<ServerMsg, { type: T }>[];
    }
}

function room(names: string[], onSend?: (c: Client, m: ServerMsg) => void) {
    const game = new Game(makeMap()); // rounds on, starts as soon as both teams have a player
    const clients = names.map(n => new Client(game, n, onSend));
    let t = 0;
    const run = (n: number, each: (c: Client) => Partial<NetCmd> = c => ({ pitch: (c.seq % 2) * 0.001 })): void => {
        for (let i = 0; i < n; i++) {
            game.tick(++t * TICK_MS);
            for (const c of clients) c.cmd(each(c));
        }
    };
    return { game, clients, run };
}

/** Level aim at 20 m from the eye goes into the torso a little below the head when tipped down by this. */
const BODY = { fire: true, pitch: -0.03 };

describe('armor on the server', () => {
    it('every player spawns with full armor, and only its owner is sent it', () => {
        const r = room(['G', 'D']);
        r.run(2);
        for (const c of r.clients) {
            expect(c.P.armor).toBe(MAX_ARMOR);
            expect(c.all('snap').at(-1)!.me).toMatchObject({ health: MAX_HEALTH, armor: MAX_ARMOR });
        }
    });

    it('resets armor at every round start, for the hurt and the unhurt alike', () => {
        const r = room(['G', 'D']);
        const [ghost, defender] = r.clients;
        r.run(ticks(FREEZE_MS) + 2);
        expect(r.game.phase).toBe('live');
        r.run(1, c => (c === defender ? BODY : {})); // one torso shot: 17 armor, 17 health
        expect(ghost.P).toMatchObject({ health: 83, armor: 83, alive: true });
        r.run(2);
        expect(ghost.all('snap').at(-1)!.me).toMatchObject({ health: 83, armor: 83 }); // the victim's own view
        // The round runs out (defenders win on time); the next round's spawn restores both.
        r.run(ticks(ROUND_MS) + 1);
        expect(r.game.phase).toBe('over');
        expect(ghost.P.armor).toBe(83); // nothing heals between the end of a round and the next spawn
        while (r.game.phase !== 'freeze') r.run(1);
        expect(ghost.P).toMatchObject({ health: MAX_HEALTH, armor: MAX_ARMOR });
        expect(defender.P.armor).toBe(MAX_ARMOR);
        r.run(1);
        expect(ghost.all('snap').at(-1)!.me).toMatchObject({ health: MAX_HEALTH, armor: MAX_ARMOR });
    });

    it('never tells anyone an enemy\'s (or a teammate\'s) armor: only the own snapshot and the own damage message carry it', () => {
        const leaks: string[] = [];
        const check = (c: Client, m: ServerMsg): void => {
            const p = c.game.players.get(c.id);
            if (m.type === 'snap') {
                // The self part is the recipient's own armor; other players' entries have no armor at all.
                if (p && m.me.armor !== p.armor) leaks.push(`snap.me.armor ${m.me.armor} for player with ${p.armor}`);
                for (const o of m.players) if ('armor' in o) leaks.push('armor in a PlayerSnap');
                return;
            }
            const json = JSON.stringify(m);
            if (!/"armor"/.test(json)) return;
            // `dmg` goes only to the player hit, and its armor is what that hit took from the recipient's own armor.
            if (m.type === 'dmg' && p && m.armor! > 0 && p.armor <= MAX_ARMOR - m.armor!) return;
            leaks.push(`${m.type} to ${c.id}: ${json}`);
        };
        const r = room(['G1', 'D1', 'G2', 'D2'], check);
        const [g1, d1, g2, d2] = r.clients;
        r.run(ticks(FREEZE_MS) + 2);
        // Both defenders fire at the ghosts in front of them, the ghosts strafe a little; then a second burst.
        const fight = (c: Client): Partial<NetCmd> => (c.P.team === 'defenders' ? BODY : { right: (c.seq >> 4) % 2 ? 0.3 : -0.3 });
        r.run(20, fight);
        r.run(ticks(1000));
        r.run(40, fight);
        expect(leaks).toEqual([]);
        // The fight did hurt armor, and the hit messages say nothing about it to the shooters.
        expect(Math.min(g1.P.armor, g2.P.armor)).toBeLessThan(MAX_ARMOR);
        for (const c of [d1, d2]) for (const h of c.all('hitconfirm')) expect(h.armor).toBeUndefined();
        for (const c of [d1, d2]) expect(c.all('dmg')).toHaveLength(0); // nobody shot at them
        const hits = [...g1.all('dmg'), ...g2.all('dmg')];
        expect(hits.length).toBeGreaterThan(0);
        // Damage dealt counts health and armor: equal to everything the ghosts lost.
        // (Health removed stops at the health there was, so a kill counts only what the victim had left.)
        const lost = [g1, g2].reduce((s, c) => s + (MAX_HEALTH - c.P.health) + (MAX_ARMOR - c.P.armor), 0);
        expect(d1.P.stats.damage + d2.P.stats.damage).toBe(lost);
    });
});

describe('practice range with armor', () => {
    it('reports how a hit split between armor and health, and a target respawns with full armor', () => {
        const rooms = new Rooms(MAPS, 'greybox');
        const msgs: ServerMsg[] = [];
        const r = rooms.join('practice-armor', 'greybox', { send: m => { msgs.push(m); } }, 'Ann', 0, DEFAULT_ROOM_OPTIONS, 'defenders');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const game = r.game;
        const me = game.players.get(r.id)!;
        const target = [...game.players.values()].find(p => p.bot)!;
        let seq = 0, now = game.now;
        const step = (fire: boolean): void => {
            const eye: Vec3 = [me.state.pos[0], me.eyeY, me.state.pos[2]];
            const tp = target.state.pos;
            const dx = tp[0] - eye[0], dz = tp[2] - eye[2], dy = tp[1] + 1.1 - eye[1];
            const yaw = Math.fround(Math.atan2(-dx, -dz)), pitch = Math.fround(Math.atan2(dy, Math.hypot(dx, dz)));
            game.handleCmd(r.id, {
                seq: ++seq, forward: 0, right: 0, yaw, pitch, jump: false, walk: false, crouch: false, fire, use: false,
                reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: game.now
            });
            game.tick(now += TICK_MS);
        };
        for (let i = 0; i < 30; i++) step(false);
        // One shot at a time, waiting for the recoil to settle, until the target is down.
        for (let i = 0; i < 40 && target.alive; i++) { step(true); for (let k = 0; k < 40; k++) step(false); }
        expect(target.alive).toBe(false);
        const confirms = msgs.filter((m): m is Extract<ServerMsg, { type: 'hitconfirm' }> => m.type === 'hitconfirm');
        expect(confirms.length).toBeGreaterThanOrEqual(2);
        const first = confirms[0];
        // Practice tells the split: a torso hit is 17 armor + 17 health, a head hit 0 armor.
        expect(first.armor).toBe(first.zone === 'head' ? 0 : Math.floor(first.damage / 2));
        for (const c of confirms) expect(c.armor).toBeGreaterThanOrEqual(0);
        // The target comes back with full health and armor.
        for (let i = 0; i < ticks(RESPAWN_MS) + 5; i++) step(false);
        expect(target.alive).toBe(true);
        expect(target.health).toBe(MAX_HEALTH);
        expect(target.armor).toBe(MAX_ARMOR);
    });

    it('the person respawns with full armor in the practice range too', () => {
        const rooms = new Rooms(MAPS, 'greybox');
        const r = rooms.join('practice-armor-2', 'greybox', { send: () => {} }, 'Ann', 0, DEFAULT_ROOM_OPTIONS, 'ghosts');
        if (!r.ok) throw new Error('no room');
        const me = r.game.players.get(r.id)!;
        r.game.tick(r.game.now + TICK_MS);
        expect(me.armor).toBe(MAX_ARMOR);
        me.armor = 12;
        me.health = 1;
        // Practice targets never fire, so mark the person dead as the server's damage path would, with a respawn due:
        // the warmup respawn must bring back full armor.
        me.alive = false;
        me.respawnAt = r.game.now + 1;
        r.game.tick(r.game.now + 2 * TICK_MS);
        expect(me.alive).toBe(true);
        expect(me.armor).toBe(MAX_ARMOR);
        expect(me.health).toBe(MAX_HEALTH);
    });
});

describe('bots and armor', () => {
    it('bots take the same rule: in a bot match armor goes down, never below 0, and is full at every round start', { timeout: 20_000 }, () => {
        const game = new Game(MAPS.get('greybox')!, {});
        game.code = 'armor-bots';
        for (let i = 0; i < 3; i++) { game.addBot('ghosts'); game.addBot('defenders'); }
        let lowest = MAX_ARMOR, phase = game.phase, roundStarts = 0;
        for (let t = 1; t <= 90 * TICK_RATE; t++) {
            game.tick(t * TICK_MS);
            for (const p of game.players.values()) {
                expect(p.armor).toBeGreaterThanOrEqual(0);
                expect(p.armor).toBeLessThanOrEqual(MAX_ARMOR);
                if (p.alive) lowest = Math.min(lowest, p.armor);
            }
            if (game.phase === 'freeze' && phase !== 'freeze') {
                roundStarts++;
                for (const p of game.players.values()) if (p.alive) expect(p.armor).toBe(MAX_ARMOR);
            }
            phase = game.phase;
        }
        expect(lowest).toBeLessThan(MAX_ARMOR); // some bot was hit on the armor and lived
        expect(roundStarts).toBeGreaterThan(0);
    });
});
