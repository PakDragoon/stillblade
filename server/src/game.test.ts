import { describe, expect, it } from 'vitest';
import {
    EYE_HEIGHT, GHOST_MAX_VIS, KNIFE_BACKSTAB_DAMAGE, KNIFE_DAMAGE,
    KNIFE_COOLDOWN_TICKS, KNIFE_WINDUP_TICKS, MAX_HEALTH, RELOAD_SOUND_RANGE, RESPAWN_MS, RUN_SPEED,
    TICK_RATE, VIS_SWING_SPIKE
} from '../../shared/constants';
import { shotDirection, spreadAngle } from '../../shared/gun';
import { SLOT_PISTOL, SLOT_RIFLE, WEAPONS } from '../../shared/weapons';
import type { NetCmd, ServerMsg, ShotEvent, SlashEvent, SoundEvent } from '../../shared/protocol';
import {
    BOMB_MS, DEFUSE_TICKS, FREEZE_MS, HALFTIME_ROUND, MATCH_OVER_MS, OVER_MS, PLANT_TICKS, ROUNDS_TO_WIN, ROUND_MS
} from '../../shared/rules';
import type { Box, MapData, Vec3 } from '../../shared/types';
import { Game } from './game';

const TICK_MS = 1000 / TICK_RATE;
const RIFLE = WEAPONS[SLOT_RIFLE];
const PISTOL = WEAPONS[SLOT_PISTOL];
const { bodyDamage: BODY_DAMAGE, fireInterval: FIRE_INTERVAL_TICKS, magSize: MAG_SIZE, reloadTicks: RELOAD_TICKS, reserve: RESERVE_AMMO } = RIFLE;

/** Ghost faces -Z, defender faces +Z: by default they look straight at each other along Z. */
function makeMap(extra: Box[] = [], ghostZ = 10, defenderZ = -10): MapData {
    return {
        name: 'test',
        bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
        boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }, ...extra],
        spawns: { ghosts: [{ pos: [0, 0, ghostZ], yaw: 0 }], defenders: [{ pos: [0, 0, defenderZ], yaw: 180 }] },
        bombSites: []
    };
}

class Client {
    readonly inbox: ServerMsg[] = [];
    readonly id: number;
    yaw = 0;
    /** Next command number. Tests may jump it, as a modified client could. */
    seq = 0;
    constructor(private readonly game: Game, name = '') {
        this.id = game.join({
            send: m => {
                if (m.type === 'spawn') this.yaw = m.yaw;
                this.inbox.push(structuredClone(m));
            }
        }, name);
    }
    cmd(over: Partial<NetCmd> = {}): void {
        this.game.handleCmd(this.id, {
            seq: this.seq++, forward: 0, right: 0, yaw: this.yaw, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, use: false, reload: false, slot: 0, swap: false, aim: false, viewTime: this.game.now, ...over
        });
    }
    last<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }> {
        const m = this.inbox.findLast(x => x.type === type);
        if (!m) throw new Error(`no ${type} message`);
        return m as Extract<ServerMsg, { type: T }>;
    }
    all<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }>[] {
        return this.inbox.filter(m => m.type === type) as Extract<ServerMsg, { type: T }>[];
    }
    shots(): ShotEvent[] { return this.all('shot'); }
    slashes(): SlashEvent[] { return this.all('slash'); }
    sounds(kind: SoundEvent['kind']): SoundEvent[] { return this.all('sound').filter(s => s.kind === kind); }
}

/** `rounds` off keeps the match in warmup, so the core mechanics can be tested without round flow. */
function setup(map: MapData = makeMap(), rounds = false) {
    const game = new Game(map, { rounds });
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
    return { game, ghost, defender, run, G: game.players.get(ghost.id)!, D: game.players.get(defender.id)!, clients: [ghost, defender] };
}

/** A client that keeps nudging its view, so it is never moved to spectate for being idle. */
const present = (c: Client): Partial<NetCmd> => ({ pitch: (c.seq % 2) * 0.001 });

// Eye is at 1.62 m; aiming slightly down lands in the body, below the head zone.
const BODY_AIM = { fire: true, pitch: -0.03 };

describe('core rules', () => {
    it('puts the first two players on opposite teams and spawns them', () => {
        const { ghost, defender, D } = setup();
        expect(ghost.last('welcome').team).toBe('ghosts');
        expect(defender.last('welcome').team).toBe('defenders');
        expect(ghost.last('spawn').pos).toEqual([0, 0, 10]);
        expect(D.alive).toBe(true);
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
        const { ghost, run, G } = setup();
        const before = G.state.pos[2];
        for (let i = 0; i < 300; i++) ghost.cmd({ forward: 1 });
        run(1, () => null);
        expect(before - G.state.pos[2]).toBeLessThan(RUN_SPEED * (13 / TICK_RATE));
        expect(ghost.last('snap').ack).toBeLessThan(30 + 13);
    });

    it('ignores malformed commands', () => {
        const { ghost, G } = setup();
        const before = [...G.state.pos];
        ghost.cmd({ forward: NaN });
        ghost.cmd({ yaw: Infinity });
        ghost.cmd({ seq: -5, forward: 1 });
        expect(G.state.pos).toEqual(before);
    });
});

describe('defender gun', () => {
    it('registers a body shot, then kills and respawns', () => {
        const { ghost, defender, run, G } = setup();
        run(1, c => (c === defender ? BODY_AIM : {}));
        expect(G.health).toBe(MAX_HEALTH - BODY_DAMAGE);
        const shot = ghost.shots().at(-1)!;
        expect(shot).toMatchObject({ shooter: defender.id, victim: ghost.id, head: false, damage: BODY_DAMAGE });
        expect(shot.to[2]).toBeCloseTo(10 - 0.3, 3);

        run(30, c => (c === defender ? BODY_AIM : {}));
        expect(G.alive).toBe(false);
        expect(defender.shots().some(s => s.killed)).toBe(true);
        const deadPos = [...G.state.pos];
        run(10, c => (c === ghost ? { forward: 1 } : {}));
        expect(G.state.pos).toEqual(deadPos); // the dead do not move

        run(Math.ceil(RESPAWN_MS / TICK_MS) + 1);
        expect(G.alive).toBe(true);
        expect(G.health).toBe(MAX_HEALTH);
    });

    it('scores a headshot when the ray enters the head zone', () => {
        const { ghost, defender, run, G } = setup();
        expect(EYE_HEIGHT).toBeGreaterThan(1.8 - 0.28); // level aim from eye height is a headshot
        run(1, c => (c === defender ? { fire: true } : {}));
        expect(defender.shots().at(-1)).toMatchObject({ victim: ghost.id, head: true, killed: true });
        expect(G.alive).toBe(false);
    });

    it('hits a ghost that is completely invisible', () => {
        const { defender, run, G } = setup();
        expect(G.vis).toBe(0);
        run(1, c => (c === defender ? BODY_AIM : {}));
        expect(defender.shots().at(-1)!.victim).toBe(G.id);
    });

    it('enforces the fire rate', () => {
        const { defender, run } = setup();
        run(60, c => (c === defender ? { fire: true, pitch: 0.5 } : {})); // 1 s of holding fire at the sky
        expect(defender.shots().length).toBeGreaterThanOrEqual(9);
        expect(defender.shots().length).toBeLessThanOrEqual(11);
    });

    it('stops bullets at walls', () => {
        const { defender, run, G } = setup(makeMap([{ min: [-5, 0, -1], max: [5, 4, 1] }]));
        run(1, c => (c === defender ? { fire: true } : {}));
        const shot = defender.shots().at(-1)!;
        expect(shot.victim).toBeUndefined();
        expect(shot.to[2]).toBeCloseTo(-1, 3);
        expect(G.health).toBe(MAX_HEALTH);
    });

    it('rewinds targets to what the shooter saw (lag compensation)', () => {
        const { game, ghost, defender, run, G } = setup();
        const seenAt = game.now;
        // The ghost strafes for 150 ms: far enough to leave the line of fire.
        run(9, c => (c === ghost ? { right: 1 } : {}));
        expect(Math.abs(G.state.pos[0])).toBeGreaterThan(0.31);

        // Shooting at the present misses...
        run(1, c => (c === defender ? BODY_AIM : { right: 1 }));
        expect(defender.shots().at(-1)!.victim).toBeUndefined();

        // ...but a shot aimed at where the shooter's screen showed the target still lands.
        run(6, c => (c === ghost ? { right: 1 } : {}));
        run(1, c => (c === defender ? { ...BODY_AIM, viewTime: seenAt } : {}));
        expect(defender.shots().at(-1)!.victim).toBe(ghost.id);
    });

    it('will not rewind further than the cap', () => {
        const { ghost, defender, run } = setup();
        const seenAt = defender.last('snap').time;
        run(60, c => (c === ghost ? { right: 1 } : {}));
        run(1, c => (c === defender ? { ...BODY_AIM, viewTime: seenAt } : {}));
        expect(defender.shots().at(-1)!.victim).toBeUndefined();
    });
});

describe('defender ammunition, reload and recoil', () => {
    const SKY = { fire: true, pitch: 0.5 }; // misses everything, so nobody dies mid-test

    it('runs dry after a magazine, reloads automatically, and accounts the reserve', () => {
        const { defender, run, D } = setup();
        run(MAG_SIZE * FIRE_INTERVAL_TICKS, c => (c === defender ? SKY : {}));
        expect(defender.shots()).toHaveLength(MAG_SIZE);
        expect(D.loadout.guns[0]).toMatchObject({ mag: 0, reserve: RESERVE_AMMO });
        // Holding the trigger on empty starts the reload; nothing fires until it completes.
        run(RELOAD_TICKS, c => (c === defender ? SKY : {}));
        expect(defender.shots()).toHaveLength(MAG_SIZE);
        expect(D.loadout.guns[0].reload).toBeGreaterThan(0);
        run(1, c => (c === defender ? SKY : {}));
        expect(defender.shots()).toHaveLength(MAG_SIZE + 1);
        expect(D.loadout.guns[0]).toMatchObject({ mag: MAG_SIZE - 1, reserve: RESERVE_AMMO - MAG_SIZE, reload: 0 });
        // The snapshot carries the gun exactly, for the client to predict from.
        run(2, () => null); // no commands, so the last snapshot shows the current state
        expect(defender.last('snap').me.loadout.guns[0]).toEqual(D.loadout.guns[0]);
    });

    it('reloads on R, keeps reloading while moving, and blocks fire meanwhile', () => {
        const { defender, run, D } = setup();
        run(3 * FIRE_INTERVAL_TICKS, c => (c === defender ? SKY : {}));
        expect(D.loadout.guns[0].mag).toBe(MAG_SIZE - 3);
        run(1, c => (c === defender ? { reload: true } : {}));
        expect(D.loadout.guns[0].reload).toBe(RELOAD_TICKS);
        const fired = defender.shots().length;
        run(RELOAD_TICKS - 1, c => (c === defender ? { ...SKY, forward: 1 } : {}));
        expect(defender.shots()).toHaveLength(fired);
        run(1, c => (c === defender ? { forward: 1 } : {}));
        expect(D.loadout.guns[0]).toMatchObject({ mag: MAG_SIZE, reserve: RESERVE_AMMO - 3, reload: 0 });
    });

    it('sends the reload sound only within earshot, and shows others the reload', () => {
        const far = setup(); // 20 m apart
        far.run(1, c => (c === far.defender ? SKY : {}));
        far.run(1, c => (c === far.defender ? { reload: true } : {}));
        expect(far.ghost.sounds('reload')).toHaveLength(0);
        expect(far.defender.sounds('reload')).toHaveLength(0); // the shooter predicts its own

        const near = setup(makeMap([], -10 + RELOAD_SOUND_RANGE - 1));
        near.run(1, c => (c === near.defender ? SKY : {}));
        near.run(1, c => (c === near.defender ? { reload: true } : {}));
        expect(near.ghost.sounds('reload')).toMatchObject([{ id: near.defender.id }]);
        near.run(2);
        expect(near.ghost.last('snap').players.find(p => p.id === near.defender.id)!.reloading).toBe(true);
        near.run(RELOAD_TICKS + 2);
        expect(near.ghost.last('snap').players.find(p => p.id === near.defender.id)!.reloading).toBe(false);
    });

    it('cancels a reload on death and refills on respawn', () => {
        const { ghost, defender, run, D } = setup(makeMap([], -8.5)); // ghost within knife reach
        run(1, c => (c === defender ? SKY : {}));
        run(1, c => (c === defender ? { reload: true, yaw: 0 } : { }));
        expect(D.loadout.guns[0].reload).toBeGreaterThan(0);
        run(KNIFE_WINDUP_TICKS + 1, c => (c === ghost ? { fire: true } : { yaw: 0 })); // backstab
        expect(D.alive).toBe(false);
        expect(D.loadout.guns[0].reload).toBe(0);
        run(Math.ceil(RESPAWN_MS / TICK_MS) + 1);
        expect(D.alive).toBe(true);
        expect(D.loadout.guns[0]).toMatchObject({ mag: MAG_SIZE, reserve: RESERVE_AMMO, reload: 0, burst: 0 });
    });

    it('traces the view plus the recoil pattern plus spread, exactly as shared/gun.ts says', () => {
        const { defender, run, D } = setup();
        const pitch = Math.fround(0.4);
        run(10 * FIRE_INTERVAL_TICKS, c => (c === defender ? { fire: true, pitch } : {}));
        const shots = defender.shots();
        expect(shots).toHaveLength(10);
        // Shot n of the life is spread-seeded by the shot count after it, n + 1.
        const dir: Vec3 = [0, 0, 0];
        shots.forEach((s, n) => {
            const len = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]);
            shotDirection(defender.yaw, pitch, RIFLE, n, 1, spreadAngle(D.state, RIFLE), n + 1, D.id, dir);
            for (let k = 0; k < 3; k++) expect((s.to[k] - s.from[k]) / len).toBeCloseTo(dir[k], 9);
        });
        // The burst climbs.
        expect(shots[9].to[1] - shots[9].from[1]).toBeGreaterThan(shots[0].to[1] - shots[0].from[1]);
    });

    it('spreads shots the same whatever command numbers the client sends', () => {
        const directions = (jump: number): number[][] => {
            const { defender, run } = setup();
            // Moving widens the spread, so the seed matters.
            run(10 * FIRE_INTERVAL_TICKS, c => {
                if (c !== defender) return {};
                defender.seq += jump;
                return { fire: true, pitch: 0.4, right: 1 };
            });
            return defender.shots().map(s => {
                const len = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]);
                return [0, 1, 2].map(k => (s.to[k] - s.from[k]) / len);
            });
        };
        const honest = directions(0);
        expect(honest).toHaveLength(10);
        for (const jump of [1, 7, 1000, 123457]) expect(directions(jump)).toEqual(honest);
    });

    it('refills at the start of each round and cancels a reload in progress', () => {
        const { game, defender, run, D } = setup(makeMap(), true);
        run(Math.ceil(FREEZE_MS / TICK_MS) - 30 + 1);
        expect(game.phase).toBe('live');
        run(5 * FIRE_INTERVAL_TICKS, c => (c === defender ? SKY : {}));
        run(1, c => (c === defender ? { reload: true } : {}));
        expect(D.loadout.guns[0].reload).toBeGreaterThan(0);
        run(Math.ceil(ROUND_MS / TICK_MS) + 1, present); // time runs out (players keep moving their view: not idle)
        expect(game.phase).toBe('over');
        run(Math.ceil(OVER_MS / TICK_MS) + 1);
        expect(game.phase).toBe('freeze');
        expect(D.loadout.guns[0]).toMatchObject({ mag: MAG_SIZE, reserve: RESERVE_AMMO, reload: 0 });
    });

    it('does not fire or reload during the freeze', () => {
        const { defender, run, D } = setup(makeMap(), true);
        D.loadout.guns[0].mag = 10;
        run(20, c => (c === defender ? { fire: true, reload: true } : {}));
        expect(defender.shots()).toHaveLength(0);
        expect(D.loadout.guns[0]).toMatchObject({ mag: 10, reload: 0 });
    });
});

describe('defender loadout: rifle and pistol', () => {
    const SKY = { pitch: 0.5 }; // misses everything
    /** Advances to just past the next snapshot so `last('snap')` is current. */
    const snapNow = (run: (n: number) => void) => run(2);

    it('switches to the pistol in its draw time, then fires it, and tells others which weapon is held', () => {
        const { ghost, defender, run, D } = setup();
        run(1, c => (c === defender ? { slot: 2, fire: true, ...SKY } : {}));
        expect(D.loadout).toMatchObject({ slot: SLOT_PISTOL, prev: SLOT_RIFLE, draw: PISTOL.drawTicks });
        run(1, c => (c === defender ? { fire: true, ...SKY } : {}));
        const seen = ghost.last('snap').players.find(p => p.id === defender.id)!;
        expect(seen).toMatchObject({ weapon: SLOT_PISTOL, switching: true, aiming: false });
        run(PISTOL.drawTicks - 2, c => (c === defender ? { fire: true, ...SKY } : {}));
        expect(defender.shots()).toHaveLength(0); // nothing fires while drawing
        run(1, c => (c === defender ? { fire: true, ...SKY } : {}));
        expect(defender.shots()).toMatchObject([{ shooter: defender.id, weapon: SLOT_PISTOL }]);
        snapNow(run);
        expect(ghost.last('snap').players.find(p => p.id === defender.id)).toMatchObject({ weapon: SLOT_PISTOL, switching: false });
        // Q goes back to the rifle, which takes longer to draw.
        run(1, c => (c === defender ? { swap: true } : {}));
        expect(D.loadout).toMatchObject({ slot: SLOT_RIFLE, draw: RIFLE.drawTicks });
        run(RIFLE.drawTicks - 1, c => (c === defender ? { fire: true, ...SKY } : {}));
        expect(defender.shots()).toHaveLength(1);
        run(1, c => (c === defender ? { fire: true, ...SKY } : {}));
        expect(defender.shots().at(-1)).toMatchObject({ weapon: SLOT_RIFLE });
    });

    it('fires the pistol once per trigger press and at most once per interval', () => {
        const { defender, run } = setup();
        run(PISTOL.drawTicks + 1, c => (c === defender ? { slot: 2 } : {}));
        run(60, c => (c === defender ? { fire: true, ...SKY } : {}));
        expect(defender.shots()).toHaveLength(1);
        run(1); // release
        let t = 0;
        run(5 * PISTOL.fireInterval, c => (c === defender ? { fire: t++ % PISTOL.fireInterval === 0, ...SKY } : {}));
        expect(defender.shots()).toHaveLength(1 + 5);
        t = 0;
        run(5 * PISTOL.fireInterval, c => (c === defender ? { fire: t++ % 2 === 0, ...SKY } : {}));
        expect(defender.shots().length - 6).toBeLessThanOrEqual(5);
    });

    it('does pistol damage: less than the rifle to the body, still a kill to the head', () => {
        const body = setup();
        body.run(PISTOL.drawTicks + 1, c => (c === body.defender ? { slot: 2 } : {}));
        body.run(1, c => (c === body.defender ? BODY_AIM : {}));
        expect(body.G.health).toBe(MAX_HEALTH - PISTOL.bodyDamage);
        expect(body.defender.shots().at(-1)).toMatchObject({ weapon: SLOT_PISTOL, head: false, damage: PISTOL.bodyDamage });
        expect(PISTOL.bodyDamage).toBeLessThan(RIFLE.bodyDamage);

        const head = setup();
        head.run(PISTOL.drawTicks + 1, c => (c === head.defender ? { slot: 2 } : {}));
        head.run(1, c => (c === head.defender ? { fire: true } : {}));
        expect(head.defender.shots().at(-1)).toMatchObject({ weapon: SLOT_PISTOL, head: true, damage: PISTOL.headDamage, killed: true });
        expect(head.G.alive).toBe(false);
    });

    it('cancels a reload on switching, keeps each magazine, and sends the reload sound with its weapon', () => {
        const { ghost, defender, run, D } = setup(makeMap([], -8.5));
        run(3 * FIRE_INTERVAL_TICKS, c => (c === defender ? { fire: true, ...SKY } : {}));
        run(1, c => (c === defender ? { reload: true } : {}));
        expect(ghost.sounds('reload').at(-1)).toMatchObject({ weapon: SLOT_RIFLE });
        run(RIFLE.reloadTicks - 2);
        run(1, c => (c === defender ? { slot: 2 } : {}));
        expect(D.loadout.guns[SLOT_RIFLE]).toMatchObject({ mag: MAG_SIZE - 3, reserve: RESERVE_AMMO, reload: 0 });
        run(PISTOL.drawTicks);
        run(1, c => (c === defender ? { fire: true, ...SKY } : {}));
        run(1);
        run(1, c => (c === defender ? { reload: true } : {}));
        expect(ghost.sounds('reload').at(-1)).toMatchObject({ weapon: SLOT_PISTOL });
        snapNow(run);
        expect(ghost.last('snap').players.find(p => p.id === defender.id)).toMatchObject({ weapon: SLOT_PISTOL, reloading: true });
        run(PISTOL.reloadTicks);
        expect(D.loadout.guns[SLOT_PISTOL]).toMatchObject({ mag: PISTOL.magSize, reserve: PISTOL.reserve - 1, reload: 0 });
        expect(D.loadout.guns[SLOT_RIFLE]).toMatchObject({ mag: MAG_SIZE - 3, reserve: RESERVE_AMMO });
    });

    it('aims down sights, shows it to others, and traces the narrowed, softer shot', () => {
        const { ghost, defender, run, D } = setup();
        run(RIFLE.adsTicks, c => (c === defender ? { aim: true } : {}));
        expect(D.loadout.aim).toBe(RIFLE.adsTicks);
        run(2, c => (c === defender ? { aim: true } : {}));
        expect(ghost.last('snap').players.find(p => p.id === defender.id)).toMatchObject({ aiming: true });
        // Moving widens the spread so the aim scaling shows; ten shots into the sky.
        const pitch = Math.fround(0.4);
        run(10 * FIRE_INTERVAL_TICKS, c => (c === defender ? { fire: true, aim: true, pitch, right: 1 } : {}));
        const shots = defender.shots();
        expect(shots).toHaveLength(10);
        const last = shots[9];
        const len = Math.hypot(last.to[0] - last.from[0], last.to[1] - last.from[1], last.to[2] - last.from[2]);
        const dir: Vec3 = [0, 0, 0];
        // The last shot fired on the final command, so the state it used is the current one.
        shotDirection(defender.yaw, pitch, RIFLE, 9, RIFLE.adsRecoil, spreadAngle(D.state, RIFLE, 1), 10, D.id, dir);
        for (let k = 0; k < 3; k++) expect((last.to[k] - last.from[k]) / len).toBeCloseTo(dir[k], 9);
        run(RIFLE.adsTicks);
        snapNow(run);
        expect(ghost.last('snap').players.find(p => p.id === defender.id)).toMatchObject({ aiming: false });
    });

    it('times switches, aim and semi-automatic fire the same whatever command numbers the client sends', () => {
        const script = (jump: number) => {
            const { defender, run, D } = setup();
            let t = 0;
            /** Shots fired so far, seen before each command: when each shot happened. */
            const fired: number[] = [];
            run(240, c => {
                if (c !== defender) return {};
                defender.seq += jump;
                const i = t++;
                fired.push(defender.shots().length);
                return {
                    pitch: 0.4, right: i % 50 < 25 ? 1 : -1,
                    slot: i === 10 ? 2 : i === 150 ? 1 : 0, swap: i === 100 || i === 110,
                    aim: i > 30 && i < 90, fire: i % 3 === 0, reload: i === 60
                };
            });
            const dirs = defender.shots().map(s => [s.weapon, ...[0, 1, 2].map(k => s.to[k] - s.from[k])]);
            return { dirs, loadout: structuredClone(D.loadout), fired };
        };
        const honest = script(0);
        expect(honest.dirs.length).toBeGreaterThan(10);
        expect(new Set(honest.dirs.map(d => d[0]))).toEqual(new Set([SLOT_RIFLE, SLOT_PISTOL]));
        for (const jump of [1, 7, 1000, 123457]) expect(script(jump)).toEqual(honest);
    });

    it('gives ghosts no loadout to switch, and ignores slots that do not exist', () => {
        const { ghost, defender, run, G, D } = setup();
        run(30, c => (c === ghost ? { slot: 2, aim: true, swap: true } : {}));
        expect(G.loadout).toMatchObject({ slot: 0, draw: 0, aim: 0 });
        expect(ghost.shots()).toHaveLength(0);
        for (const slot of [3, 15, 255, -1, 1.5, NaN]) run(1, c => (c === defender ? { slot } : {}));
        expect(D.loadout).toMatchObject({ slot: SLOT_RIFLE, draw: 0 });
    });

    it('refills both weapons and puts the rifle back in hand every round', () => {
        const { game, defender, run, D } = setup(makeMap(), true);
        run(Math.ceil(FREEZE_MS / TICK_MS) - 30 + 1);
        expect(game.phase).toBe('live');
        run(1, c => (c === defender ? { slot: 2 } : {}));
        run(PISTOL.drawTicks);
        run(1, c => (c === defender ? { fire: true, ...SKY } : {}));
        expect(D.loadout.guns[SLOT_PISTOL].mag).toBe(PISTOL.magSize - 1);
        run(Math.ceil(ROUND_MS / TICK_MS) + 1, () => null);
        run(Math.ceil(OVER_MS / TICK_MS) + 1);
        expect(game.phase).toBe('freeze');
        expect(D.loadout).toMatchObject({ slot: SLOT_RIFLE, draw: 0, aim: 0 });
        expect(D.loadout.guns[SLOT_PISTOL]).toMatchObject({ mag: PISTOL.magSize, reserve: PISTOL.reserve });
    });
});

describe('ghost visibility', () => {
    it('is zero when still, rises to the cap at a run, and fades after stopping', () => {
        const { ghost, run, G } = setup();
        expect(G.vis).toBe(0);
        run(60, c => (c === ghost ? { right: 1 } : {}));
        expect(G.vis).toBeCloseTo(GHOST_MAX_VIS, 2);
        run(6, () => ({}));
        expect(G.vis).toBeGreaterThan(0.1); // stopping does not hide a ghost instantly
        run(120, () => ({}));
        expect(G.vis).toBe(0);
    });

    it('is lower when walking or crouching than when running', () => {
        const { ghost, run, G } = setup();
        run(60, c => (c === ghost ? { right: 1, walk: true } : {}));
        const walking = G.vis;
        run(60, c => (c === ghost ? { right: 1, crouch: true } : {}));
        const crouching = G.vis;
        expect(walking).toBeGreaterThan(0.05);
        expect(walking).toBeLessThan(GHOST_MAX_VIS * 0.6);
        expect(crouching).toBeLessThan(walking);
        expect(crouching).toBeGreaterThan(0);
    });

    it('keeps defenders fully visible to ghosts', () => {
        const { ghost, defender } = setup();
        expect(ghost.last('snap').players).toMatchObject([{ id: defender.id, vis: 1 }]);
    });
});

describe('information culling', () => {
    const ghostSeenBy = (c: Client, id: number) => c.last('snap').players.find(p => p.id === id);

    it('does not tell a defender where a motionless ghost is, even in plain view', () => {
        const { ghost, defender } = setup();
        expect(ghostSeenBy(defender, ghost.id)).toBeUndefined();
    });

    it('reveals a moving ghost in line of sight, with its visibility', () => {
        const { ghost, defender, run } = setup();
        run(40, c => (c === ghost ? { right: 1 } : {}));
        const seen = ghostSeenBy(defender, ghost.id)!;
        expect(seen.vis).toBeGreaterThan(0.3);
        expect(seen.pos[0]).toBeGreaterThan(1);
    });

    it('hides a moving ghost that is behind a wall', () => {
        const { ghost, defender, run } = setup(makeMap([{ min: [-30, 0, -1], max: [30, 4, 1] }]));
        run(40, c => (c === ghost ? { right: 1 } : {}));
        expect(ghostSeenBy(defender, ghost.id)).toBeUndefined();
    });

    it('reveals a motionless ghost within breathing range, even through a wall', () => {
        const wall: Box = { min: [-30, 0, -6.2], max: [30, 4, -6] };
        const { ghost, defender } = setup(makeMap([wall], -4));
        expect(ghostSeenBy(defender, ghost.id)).toMatchObject({ vis: 0 });
    });
});

describe('footsteps', () => {
    it('are heard by a defender within range of a running ghost, about every 2 m', () => {
        const { ghost, defender, run } = setup(makeMap([], 2));
        run(120, c => (c === ghost ? { right: 1 } : {}));
        const steps = defender.sounds('step');
        expect(steps.length).toBeGreaterThanOrEqual(4);
        expect(steps.length).toBeLessThanOrEqual(6);
        expect(steps[0]).toMatchObject({ id: ghost.id, loud: 1 });
        expect(ghost.sounds('step')).toHaveLength(0); // a player's own steps are not echoed back
    });

    it('are not sent beyond earshot', () => {
        const { ghost, defender, run } = setup(); // 20 m apart, steps carry 18 m
        run(60, c => (c === ghost ? { right: 1 } : {}));
        expect(defender.sounds('step')).toHaveLength(0);
    });

    it('carry far less when walking quietly', () => {
        const { ghost, defender, run } = setup(makeMap([], -2)); // 8 m apart
        run(180, c => (c === ghost ? { right: 1, walk: true } : {}));
        expect(defender.sounds('step')).toHaveLength(0); // quiet steps carry 5.4 m
    });
});

describe('ghost knife', () => {
    // Ghost 1.5 m in front of the defender, face to face.
    const close = () => setup(makeMap([], -8.5));

    it('warns with a windup, then lands a frontal slash after the delay', () => {
        const { ghost, defender, run, G, D } = close();
        run(1, c => (c === ghost ? { fire: true } : {}));
        expect(defender.sounds('windup')).toHaveLength(1);
        expect(G.vis).toBeGreaterThanOrEqual(VIS_SWING_SPIKE - 0.05); // swinging exposes the ghost
        expect(D.health).toBe(MAX_HEALTH);

        run(KNIFE_WINDUP_TICKS - 1);
        expect(defender.slashes()).toHaveLength(0);
        run(1);
        expect(defender.slashes()).toMatchObject([{ attacker: ghost.id, victim: defender.id, damage: KNIFE_DAMAGE, backstab: false }]);
        expect(D.health).toBe(MAX_HEALTH - KNIFE_DAMAGE);
    });

    it('kills in one hit from behind', () => {
        const { ghost, defender, run, D } = close();
        run(1, c => (c === defender ? { yaw: 0 } : {})); // defender turns its back
        run(KNIFE_WINDUP_TICKS + 1, c => (c === ghost ? { fire: true } : { yaw: 0 }));
        expect(ghost.slashes().at(-1)).toMatchObject({ victim: defender.id, damage: KNIFE_BACKSTAB_DAMAGE, backstab: true, killed: true });
        expect(D.alive).toBe(false);
    });

    it('cannot be spammed', () => {
        const { ghost, run } = close();
        run(60, c => (c === ghost ? { fire: true } : {}));
        expect(ghost.slashes().length).toBeLessThanOrEqual(2);
    });

    it('misses out of reach, when facing away, and through walls', () => {
        const far = setup(makeMap([], -6.5)); // 3.5 m apart
        far.run(KNIFE_WINDUP_TICKS + 1, c => (c === far.ghost ? { fire: true } : {}));
        expect(far.ghost.slashes()).toMatchObject([{ attacker: far.ghost.id }]);
        expect(far.ghost.slashes()[0].victim).toBeUndefined();

        const away = close();
        away.run(KNIFE_WINDUP_TICKS + 1, c => (c === away.ghost ? { fire: true, yaw: Math.PI } : {}));
        expect(away.ghost.slashes()[0].victim).toBeUndefined();

        const walled = setup(makeMap([{ min: [-5, 0, -9.4], max: [5, 4, -9.2] }], -8.5));
        walled.run(KNIFE_WINDUP_TICKS + 1, c => (c === walled.ghost ? { fire: true } : {}));
        expect(walled.ghost.slashes()[0].victim).toBeUndefined();
        expect(walled.D.health).toBe(MAX_HEALTH);
    });

    it('counts the windup and cooldown in processed commands, not in client command numbers', () => {
        const { ghost, defender, run } = close();
        // A modified client skipping far ahead in `seq` on every command.
        const jumping = (c: Client) => {
            if (c !== ghost) return {};
            ghost.seq += 100_000;
            return { fire: true };
        };
        run(1, jumping);
        expect(defender.sounds('windup')).toHaveLength(1);
        run(KNIFE_WINDUP_TICKS - 1, jumping);
        expect(defender.slashes()).toHaveLength(0); // the swing does not land early
        run(1, jumping);
        expect(defender.slashes()).toHaveLength(1);
        run(KNIFE_COOLDOWN_TICKS - KNIFE_WINDUP_TICKS - 1, jumping);
        expect(defender.sounds('windup')).toHaveLength(1); // the cooldown is not shortened
        run(1, jumping);
        expect(defender.sounds('windup')).toHaveLength(2);
    });

    it('gives ghosts no gun', () => {
        const { ghost, run } = setup();
        run(30, c => (c === ghost ? { fire: true } : {}));
        expect(ghost.shots()).toHaveLength(0);
    });
});

describe('rounds and the bomb', () => {
    const ticks = (ms: number) => Math.ceil(ms / TICK_MS);
    /** A bomb site around the ghost spawn, so a ghost can plant without travelling. */
    const siteMap = (defenderZ = -10): MapData => ({
        ...makeMap([], 10, defenderZ),
        bombSites: [{ name: 'A', min: [-3, 0, 7], max: [3, 2.5, 13] }]
    });
    /** Two players, rounds on, advanced to the moment the first round goes live. */
    const live = (map: MapData = siteMap()) => {
        const s = setup(map, true); // setup() already runs 30 ticks of the freeze
        s.run(ticks(FREEZE_MS) - 30 + 1);
        expect(s.game.phase).toBe('live');
        return s;
    };

    it('freezes players at the start of a round, then lets them go', () => {
        const { game, ghost, run, G } = setup(siteMap(), true);
        expect(game.phase).toBe('freeze');
        expect(ghost.last('round')).toMatchObject({ phase: 'freeze', round: 1, score: { ghosts: 0, defenders: 0 } });
        run(30, c => (c === ghost ? { forward: 1, fire: true } : {}));
        expect(G.state.pos[2]).toBeCloseTo(10, 5);
        expect(ghost.sounds('windup')).toHaveLength(0); // no attacking during the freeze either
        run(ticks(FREEZE_MS));
        expect(game.phase).toBe('live');
        run(30, c => (c === ghost ? { forward: 1 } : {}));
        expect(G.state.pos[2]).toBeLessThan(9);
    });

    it('plants after an uninterrupted hold inside a site, rooting and exposing the ghost', () => {
        const { game, ghost, run, G } = live();
        run(PLANT_TICKS - 20, c => (c === ghost ? { use: true, forward: 1 } : {}));
        expect(G.state.pos[2]).toBeCloseTo(10, 5); // cannot walk while planting
        expect(G.vis).toBeGreaterThan(0.5);
        expect(ghost.last('snap').me.action).toBeGreaterThan(0.8);
        run(5); // let go: progress is lost
        run(PLANT_TICKS - 20, c => (c === ghost ? { use: true } : {}));
        expect(game.phase).toBe('live');
        run(20, c => (c === ghost ? { use: true } : {}));
        expect(game.phase).toBe('planted');
        expect(ghost.last('round')).toMatchObject({ phase: 'planted', bomb: [0, 0, 10] });
    });

    it('cannot plant outside a site', () => {
        const { game, ghost, run } = live({ ...siteMap(), bombSites: [{ name: 'A', min: [20, 0, 20], max: [26, 2.5, 26] }] });
        run(PLANT_TICKS + 10, c => (c === ghost ? { use: true } : {}));
        expect(game.phase).toBe('live');
    });

    it('gives ghosts the round when the bomb explodes, even if they have all died', () => {
        const { game, ghost, defender, run, G } = live();
        run(PLANT_TICKS, c => (c === ghost ? { use: true } : {}));
        run(1, c => (c === defender ? { fire: true } : {})); // headshot the planter
        expect(G.alive).toBe(false);
        expect(game.phase).toBe('planted');
        run(ticks(BOMB_MS) + 1);
        expect(ghost.last('round')).toMatchObject({ phase: 'over', winner: 'ghosts', reason: 'exploded', score: { ghosts: 1, defenders: 0 } });
    });

    it('lets a defender defuse only from next to the bomb', () => {
        const far = live();
        far.run(PLANT_TICKS, c => (c === far.ghost ? { use: true } : {}));
        far.run(DEFUSE_TICKS + 10, c => (c === far.defender ? { use: true } : {}));
        expect(far.game.phase).toBe('planted');

        const near = live(siteMap(9)); // defender spawns 1 m from the ghost
        near.run(PLANT_TICKS, c => (c === near.ghost ? { use: true } : {}));
        near.run(DEFUSE_TICKS - 1, c => (c === near.defender ? { use: true } : {}));
        expect(near.game.phase).toBe('planted');
        near.run(1, c => (c === near.defender ? { use: true } : {}));
        expect(near.defender.last('round')).toMatchObject({ phase: 'over', winner: 'defenders', reason: 'defused' });
    });

    it('ends the round on elimination with no respawn, then starts the next one', () => {
        const { game, ghost, defender, run, G } = live();
        run(1, c => (c === defender ? { fire: true } : {}));
        run(1);
        expect(defender.last('round')).toMatchObject({ phase: 'over', winner: 'defenders', reason: 'eliminated' });
        run(ticks(OVER_MS) - 5);
        expect(G.alive).toBe(false);
        run(10);
        expect(G.alive).toBe(true);
        expect(ghost.last('round')).toMatchObject({ phase: 'freeze', round: 2, score: { ghosts: 0, defenders: 1 } });
        expect(game.bomb).toBeNull();
    });

    it('gives defenders the round when time runs out', () => {
        const { defender, run } = live();
        run(ticks(ROUND_MS) + 1, present);
        expect(defender.last('round')).toMatchObject({ phase: 'over', winner: 'defenders', reason: 'time' });
    });

    it('swaps sides at halftime and ends the match at the win target', () => {
        const s = live();
        const ghostGroupClient = s.ghost, defenderGroupClient = s.defender;
        /** Plays one round: whoever is currently a defender headshots the other as soon as it is live. */
        const playRound = (): void => {
            while (s.game.phase !== 'live') s.run(1, present);
            s.run(2, c => (s.game.players.get(c.id)!.team === 'defenders' ? { fire: true } : present(c)));
            expect(s.game.phase).toBe('over');
        };
        for (let i = 0; i < HALFTIME_ROUND; i++) playRound();
        expect(defenderGroupClient.last('round').score).toEqual({ ghosts: 0, defenders: HALFTIME_ROUND });

        s.run(ticks(OVER_MS) + 2, present);
        // Roles have traded; the score follows the players, not the role.
        expect(ghostGroupClient.last('snap').me.team).toBe('defenders');
        expect(defenderGroupClient.last('snap').me.team).toBe('ghosts');
        expect(ghostGroupClient.last('round').score).toEqual({ ghosts: HALFTIME_ROUND, defenders: 0 });
        expect(ghostGroupClient.last('spawn').pos).toEqual([0, 0, -10]); // now at the defender spawn

        for (let i = 0; i < ROUNDS_TO_WIN; i++) playRound();
        expect(ghostGroupClient.last('round')).toMatchObject({ winner: 'defenders', matchOver: true, score: { ghosts: HALFTIME_ROUND, defenders: ROUNDS_TO_WIN } });

        s.run(ticks(MATCH_OVER_MS) + 2, present);
        expect(ghostGroupClient.last('round')).toMatchObject({ phase: 'freeze', round: 1, score: { ghosts: 0, defenders: 0 } });
        expect(ghostGroupClient.last('snap').me.team).toBe('ghosts'); // a new match starts on the original sides
    });

    it('holds a mid-round joiner until the next round and tracks the roster', () => {
        const { game, ghost, defender, run } = live();
        const late = new Client(game, '  <b>Zoë_99</b> the very long named one ');
        const L = game.players.get(late.id)!;
        expect(L.alive).toBe(false);
        expect(L.name).toBe('bZoë_99b the ver');
        expect(late.last('round').phase).toBe('live');
        run(1, c => (c === defender ? { fire: true } : {}));
        const roster = ghost.last('roster').players;
        expect(roster.find(p => p.id === defender.id)).toMatchObject({ kills: 1, deaths: 0, alive: true });
        expect(roster.find(p => p.id === ghost.id)).toMatchObject({ kills: 0, deaths: 1, alive: false });
        expect(roster.find(p => p.id === late.id)!.name).toBe('bZoë_99b the ver');
    });

    it('returns to warmup when a team empties', () => {
        const { game, ghost, defender, run } = live();
        game.leave(defender.id);
        run(2, c => (c === ghost ? {} : null));
        expect(ghost.last('round').phase).toBe('warmup');
    });
});