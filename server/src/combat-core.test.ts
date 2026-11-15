import { describe, expect, it } from 'vitest';
import {
    EYE_HEIGHT, GUNSHOT_RANGE, GUNSHOT_RANGE_SUPPRESSED, HULL_HALF_WIDTH, KNIFE_COOLDOWN_TICKS, KNIFE_WINDUP_TICKS,
    MAX_HEALTH, TICK_RATE
} from '../../shared/constants';
import type { NetCmd, ServerMsg, ShotEvent, SlashEvent, SoundEvent } from '../../shared/protocol';
import { parseRoomOptions } from '../../shared/room-options';
import type { Box, MapData, Vec3 } from '../../shared/types';
import { DEFENDER_KNIFE, SLOT_KNIFE, SLOT_RIFLE, WEAPONS } from '../../shared/weapons';
import { zoneDamage } from '../../shared/zones';
import { Game } from './game';
import { Rooms } from './rooms';

const TICK_MS = 1000 / TICK_RATE;
const RIFLE = WEAPONS[SLOT_RIFLE];

/** Ghost at z = ghostZ facing -Z, defender at z = defenderZ facing +Z: face to face along Z. */
function makeMap(ghostZ: number, defenderZ = -10, extra: Box[] = [], size = 50): MapData {
    return {
        name: 'test',
        bounds: { min: [-size, -0.5, -size], max: [size, 12, size] },
        boxes: [{ min: [-size, -0.5, -size], max: [size, 0, size] }, ...extra],
        spawns: { ghosts: [{ pos: [0, 0, ghostZ], yaw: 0 }], defenders: [{ pos: [0, 0, defenderZ], yaw: 180 }] },
        bombSites: []
    };
}

class Client {
    readonly inbox: ServerMsg[] = [];
    readonly id: number;
    yaw = 0;
    seq = 0;
    constructor(private readonly game: Game, name = '') {
        this.id = game.join({ send: m => { if (m.type === 'spawn') this.yaw = m.yaw; this.inbox.push(structuredClone(m)); } }, name);
    }
    cmd(over: Partial<NetCmd> = {}): void {
        this.game.handleCmd(this.id, {
            seq: this.seq++, forward: 0, right: 0, yaw: this.yaw, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, use: false, reload: false, slot: 0, swap: false, aim: false, viewTime: this.game.now, ...over
        });
    }
    all<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }>[] {
        return this.inbox.filter(m => m.type === type) as Extract<ServerMsg, { type: T }>[];
    }
    last<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }> {
        const m = this.all(type).at(-1);
        if (!m) throw new Error(`no ${type} message`);
        return m;
    }
    shots(): ShotEvent[] { return this.all('shot'); }
    slashes(): SlashEvent[] { return this.all('slash'); }
    sounds(kind: SoundEvent['kind']): SoundEvent[] { return this.all('sound').filter(s => s.kind === kind); }
}

/** Players join alternately ghost, defender, ghost, ... `rounds: false` keeps the room in warmup. */
function world(map: MapData, players = 2, options?: { suppressed: boolean }) {
    const game = new Game(map, { rounds: false, options });
    const clients: Client[] = [];
    for (let i = 0; i < players; i++) clients.push(new Client(game));
    let t = 0;
    const run = (n: number, each: (c: Client) => Partial<NetCmd> | null = () => ({})): void => {
        for (let i = 0; i < n; i++) {
            game.tick(++t * TICK_MS);
            for (const c of clients) { const o = each(c); if (o) c.cmd(o); }
        }
    };
    run(30); // settle onto the floor
    const P = (c: Client) => game.players.get(c.id)!;
    /** Puts a player's feet at `pos` (they stay there while they send no movement). */
    const place = (c: Client, pos: Vec3): void => { const s = P(c).state; s.pos[0] = pos[0]; s.pos[1] = pos[1]; s.pos[2] = pos[2]; };
    return { game, clients, run, P, place };
}

/** Defender draws the knife (key 3) and waits out the draw. */
function drawKnife(w: ReturnType<typeof world>, defender: Client): void {
    w.run(1, c => (c === defender ? { slot: 3 } : {}));
    w.run(DEFENDER_KNIFE.drawTicks);
    expect(w.P(defender).loadout).toMatchObject({ slot: SLOT_KNIFE, draw: 0 });
}

describe('defender knife on the server', () => {
    // Ghost 1.5 m in front of the defender, face to face.
    const close = () => world(makeMap(-8.5));

    it('warns with the same windup sound as a ghost, then lands 35 from the front after the windup', () => {
        const w = close();
        const [ghost, defender] = w.clients;
        drawKnife(w, defender);
        w.run(1, c => (c === defender ? { fire: true } : {}));
        expect(ghost.sounds('windup')).toMatchObject([{ id: defender.id, loud: 1 }]);
        w.run(KNIFE_WINDUP_TICKS - 1);
        expect(ghost.slashes()).toHaveLength(0);
        w.run(1);
        expect(ghost.slashes()).toEqual([{
            type: 'slash', attacker: defender.id, pos: w.P(defender).state.pos, victim: ghost.id, damage: 35, backstab: false
        }]);
        expect(w.P(ghost).health).toBe(MAX_HEALTH - DEFENDER_KNIFE.damage);
        expect(ghost.last('dmg')).toMatchObject({ amount: 35, kind: 'knife' });
        expect(ghost.last('dmg').zone).toBeUndefined(); // knife hits ignore zones
        expect(defender.last('hitconfirm')).toEqual({ type: 'hitconfirm', kind: 'knife', kill: false });
        expect(defender.shots()).toHaveLength(0); // no gunshot either
    });

    it('does 70 from behind, counts the backstab, and two kill a full-health ghost', () => {
        const w = close();
        const [ghost, defender] = w.clients;
        drawKnife(w, defender);
        // The ghost turns its back on the defender (both now face +Z).
        const back = (c: Client): Partial<NetCmd> => (c === ghost ? { yaw: Math.PI } : { fire: true });
        w.run(KNIFE_WINDUP_TICKS + 1, back);
        expect(ghost.slashes()[0]).toMatchObject({ damage: 70, backstab: true });
        expect(w.P(ghost).health).toBe(MAX_HEALTH - DEFENDER_KNIFE.backstabDamage);
        w.run(KNIFE_COOLDOWN_TICKS, back);
        expect(w.P(ghost).alive).toBe(false);
        expect(w.P(defender).stats).toMatchObject({ backstabs: 2, kills: 1, headshots: 0 });
        expect(defender.last('kill')).toEqual({ type: 'kill', killer: defender.id, victim: ghost.id, kind: 'backstab' });
        expect(ghost.last('dmg')).toMatchObject({ kind: 'backstab', killed: true, by: defender.id });
    });

    it('only hits ghosts: a teammate in reach is never hurt', () => {
        const w = world(makeMap(10), 4); // ghost, defender, ghost, defender
        const [, d1, g2, d2] = w.clients;
        w.place(g2, [30, 0, 30]);
        w.place(d2, [0, 0, -8.6]); // a defender right in front of the swinging one
        drawKnife(w, d1);
        w.run(KNIFE_WINDUP_TICKS + 1, c => (c === d1 ? { fire: true } : null));
        expect(d1.slashes()).toHaveLength(1);
        expect(d1.slashes()[0].victim).toBeUndefined();
        expect(w.P(d2).health).toBe(MAX_HEALTH);
    });

    it('resolves against the same lag-compensated positions as shots', () => {
        const swing = (rewind: boolean) => {
            const w = close();
            const [ghost, defender] = w.clients;
            drawKnife(w, defender);
            // The ghost backs away; the defender swings when it is still in reach on the defender's screen.
            const seenAt = w.game.now;
            // 4 + 1 + 12 commands: the swing lands 17 ticks (283 ms) after the moment the defender saw, inside the rewind cap.
            w.run(4, c => (c === ghost ? { forward: -1 } : { viewTime: seenAt }));
            w.run(1, c => (c === ghost ? { forward: -1 } : { fire: true, viewTime: seenAt }));
            w.run(KNIFE_WINDUP_TICKS, c => (c === ghost ? { forward: -1 } : { viewTime: rewind ? seenAt : w.game.now }));
            return { slash: defender.slashes()[0], gap: w.P(ghost).state.pos[2] - HULL_HALF_WIDTH - w.P(defender).state.pos[2] };
        };
        const present = swing(false);
        expect(present.gap).toBeGreaterThan(2); // out of reach by the time it lands
        expect(present.slash.victim).toBeUndefined();
        expect(swing(true).slash.victim).toBeDefined();
    });

    it('tells other defenders who were hit only if they already know where that ghost is', () => {
        // ghost, swinging defender, a second ghost, and a defender 10 m away behind a wall: in earshot of the
        // knife (14 m), out of breathing range (8 m) and sight of the ghost.
        const wall: Box = { min: [5, 0, -30], max: [5.2, 10, 10] };
        const w = world(makeMap(-8.5, -10, [wall]), 4);
        const [ghost, defender, ghost2, far] = w.clients;
        w.place(ghost2, [0, 0, 0]);
        w.place(far, [10, 0, -10]);
        drawKnife(w, defender);
        w.run(KNIFE_WINDUP_TICKS + 1, c => (c === defender ? { fire: true } : null));
        const hit = { attacker: defender.id, victim: ghost.id, damage: 35 };
        expect(defender.slashes()[0]).toMatchObject(hit);
        expect(ghost.slashes()[0]).toMatchObject(hit);
        expect(ghost2.slashes()[0]).toMatchObject(hit); // the ghost's teammate always knows where it is
        // The far defender hears a knife land, nothing more: no victim, damage or outcome.
        expect(far.slashes()).toEqual([{ type: 'slash', attacker: defender.id, pos: w.P(defender).state.pos }]);
        expect(far.sounds('windup')).toHaveLength(1);
        // And it is not given the ghost on the next snapshots either.
        w.run(4, () => null);
        expect(far.last('snap').players.some(p => p.id === ghost.id)).toBe(false);
    });

    it('counts windup and cooldown in processed commands: jumping command numbers gains nothing', () => {
        const w = close();
        const [ghost, defender] = w.clients;
        drawKnife(w, defender);
        const jumping = (c: Client): Partial<NetCmd> => {
            if (c !== defender) return {};
            defender.seq += 100_000;
            return { fire: true };
        };
        w.run(1, jumping);
        expect(ghost.sounds('windup')).toHaveLength(1);
        w.run(KNIFE_WINDUP_TICKS - 1, jumping);
        expect(ghost.slashes()).toHaveLength(0);
        w.run(1, jumping);
        expect(ghost.slashes()).toHaveLength(1);
        w.run(KNIFE_COOLDOWN_TICKS - KNIFE_WINDUP_TICKS - 1, jumping);
        expect(ghost.sounds('windup')).toHaveLength(1);
        w.run(1, jumping);
        expect(ghost.sounds('windup')).toHaveLength(2);
    });

    it('cancels a swing in progress when the defender switches away', () => {
        const w = close();
        const [ghost, defender] = w.clients;
        drawKnife(w, defender);
        w.run(1, c => (c === defender ? { fire: true } : {}));
        w.run(4);
        w.run(1, c => (c === defender ? { slot: 1 } : {}));
        w.run(KNIFE_WINDUP_TICKS * 2);
        expect(ghost.sounds('windup')).toHaveLength(1);
        expect(ghost.slashes()).toHaveLength(0);
        expect(w.P(ghost).health).toBe(MAX_HEALTH);
    });
});

describe('body-part damage on the server', () => {
    // Defender 4 m from the ghost: spread is about 1.5 cm there, far inside every margin below.
    const GHOST_Z = -6;
    const FACE_Z = GHOST_Z - HULL_HALF_WIDTH;
    const EYE_Z = -10;
    /** The yaw and pitch from the defender's eye to a point on the ghost's front face. */
    const aimAt = (x: number, y: number): Partial<NetCmd> => {
        const dx = x, dy = y - EYE_HEIGHT, dz = FACE_Z - EYE_Z;
        return { yaw: Math.fround(Math.atan2(-dx, -dz)), pitch: Math.fround(Math.atan2(dy, Math.hypot(dx, dz))) };
    };
    const shoot = (x: number, y: number, crouch = false) => {
        const w = world(makeMap(GHOST_Z));
        const [ghost, defender] = w.clients;
        if (crouch) w.run(20, c => (c === ghost ? { crouch: true } : {}));
        w.run(1, c => (c === defender ? { fire: true, ...aimAt(x, y) } : c === ghost ? { crouch } : {}));
        return { w, ghost, defender, shot: defender.shots().at(-1)! };
    };

    it('classifies standing hits: head, torso, arms, legs, with their damage', () => {
        for (const [x, y, zone] of [[0, 1.65, 'head'], [0, 1.2, 'torso'], [0.26, 1.2, 'arms'], [-0.26, 1.2, 'arms'], [0, 0.4, 'legs']] as const) {
            const { shot, ghost, w } = shoot(x, y);
            expect(shot).toMatchObject({ victim: ghost.id, zone, damage: zoneDamage(RIFLE, zone) });
            if (zone !== 'head') expect(w.P(ghost).health).toBe(MAX_HEALTH - zoneDamage(RIFLE, zone));
            expect(ghost.last('dmg')).toMatchObject({ kind: 'shot', zone, weapon: SLOT_RIFLE });
        }
        expect(shoot(0.26, 1.2).shot.damage).toBe(27);
        expect(shoot(0, 0.4).shot.damage).toBe(24);
    });

    it('moves the bands down with a crouched hull', () => {
        // 0.7 m is a leg standing (below 0.81) but torso crouched (0.54 to 0.92); 1.05 m is the crouched head.
        expect(shoot(0, 0.7).shot.zone).toBe('legs');
        expect(shoot(0, 0.7, true).shot.zone).toBe('torso');
        expect(shoot(0, 1.05, true).shot.zone).toBe('head');
        expect(shoot(0, 0.45, true).shot.zone).toBe('legs');
        expect(shoot(0.26, 0.75, true).shot.zone).toBe('arms');
    });

    it('confirms the zone to the shooter, counts headshots by zone, and names the zone in the kill', () => {
        const limb = shoot(0, 0.4);
        expect(limb.defender.last('hitconfirm')).toEqual({ type: 'hitconfirm', kind: 'shot', zone: 'legs', kill: false });
        const head = shoot(0, 1.65);
        expect(head.defender.last('hitconfirm')).toEqual({ type: 'hitconfirm', kind: 'shot', zone: 'head', kill: true });
        expect(head.w.P(head.defender).stats.headshots).toBe(1);
        expect(limb.w.P(limb.defender).stats.headshots).toBe(0);
        // Every player gets the kill, with how but not where.
        for (const c of head.w.clients) {
            expect(c.last('kill')).toEqual({ type: 'kill', killer: head.defender.id, victim: head.ghost.id, kind: 'shot', weapon: SLOT_RIFLE, zone: 'head' });
        }
    });
});

describe('room options', () => {
    const map = makeMap(10);

    it('defaults to unsuppressed and reaches every welcome', () => {
        const g = new Game(map);
        expect(g.options).toEqual({ suppressed: false });
        expect(new Client(g).last('welcome').options).toEqual({ suppressed: false });
        const s = new Game(map, { options: { suppressed: true } });
        expect(new Client(s).last('welcome').options).toEqual({ suppressed: true });
    });

    it('is read from the creator\'s join query and kept for the life of the room', () => {
        const rooms = new Rooms(new Map([['test', map]]), 'test');
        const welcome = (q: string): Extract<ServerMsg, { type: 'welcome' }> => {
            const inbox: ServerMsg[] = [];
            const r = rooms.join('room1', null, { send: m => inbox.push(m) }, 'x', 0, parseRoomOptions(new URLSearchParams(q)));
            expect(r.ok).toBe(true);
            return inbox.find(m => m.type === 'welcome') as Extract<ServerMsg, { type: 'welcome' }>;
        };
        expect(welcome('room=room1&suppressed=1').options.suppressed).toBe(true);
        expect(welcome('room=room1').options.suppressed).toBe(true); // a joiner cannot change it
        expect(rooms.rooms.get('room1')!.options.suppressed).toBe(true);
        const other = new Rooms(new Map([['test', map]]), 'test');
        const inbox: ServerMsg[] = [];
        other.join('room2', null, { send: m => inbox.push(m) }, 'x', 0);
        expect(inbox.find(m => m.type === 'welcome')).toMatchObject({ options: { suppressed: false } });
    });
});

describe('who receives a gunshot', () => {
    // The shooter stands at the origin; listeners along +X can see it, those along -X are behind a tall wall.
    const wall: Box = { min: [-5.2, 0, -80], max: [-5, 10, 80] };
    const AT = [10, 30, 70];
    const fire = (suppressed: boolean) => {
        const w = world(makeMap(40, 0, [wall], 100), 2 + 2 * AT.length, { suppressed });
        const [first, shooter, ...rest] = w.clients;
        const listeners = [first, ...rest];
        const seen = new Map<number, Client>(), hidden = new Map<number, Client>();
        AT.forEach((d, i) => {
            seen.set(d, listeners[i]);
            hidden.set(d, listeners[AT.length + i]);
            w.place(listeners[i], [d, 0, 0]);
            w.place(listeners[AT.length + i], [-d, 0, 0]);
        });
        w.place(shooter, [0, 0, 0]);
        expect(w.P(shooter).team).toBe('defenders');
        w.run(1, c => (c === shooter ? { fire: true, pitch: 1.4 } : null)); // into the sky: nobody is hit
        return { shooter, seen, hidden };
    };
    /** What a listener got: the full shot, a silent one, or nothing. */
    const got = (c: Client): 'heard' | 'silent' | 'none' => {
        const s = c.shots();
        expect(s.length).toBeLessThanOrEqual(1);
        return s.length === 0 ? 'none' : s[0].silent ? 'silent' : 'heard';
    };

    it('unsuppressed: heard to 60 m through walls; beyond, seen without sound, or not sent at all', () => {
        expect(GUNSHOT_RANGE).toBe(60);
        const { shooter, seen, hidden } = fire(false);
        expect(got(shooter)).toBe('heard');
        expect([10, 30, 70].map(d => got(seen.get(d)!))).toEqual(['heard', 'heard', 'silent']);
        expect([10, 30, 70].map(d => got(hidden.get(d)!))).toEqual(['heard', 'heard', 'none']);
        const silent = seen.get(70)!.shots()[0];
        expect(silent).toMatchObject({ type: 'shot', shooter: shooter.id, weapon: SLOT_RIFLE, silent: true });
        expect(silent.victim).toBeUndefined();
    });

    it('suppressed: heard to 20 m; beyond, seen without sound, or not sent at all', () => {
        expect(GUNSHOT_RANGE_SUPPRESSED).toBe(20);
        const { shooter, seen, hidden } = fire(true);
        expect(got(shooter)).toBe('heard');
        expect([10, 30, 70].map(d => got(seen.get(d)!))).toEqual(['heard', 'silent', 'silent']);
        expect([10, 30, 70].map(d => got(hidden.get(d)!))).toEqual(['heard', 'none', 'none']);
    });
});
