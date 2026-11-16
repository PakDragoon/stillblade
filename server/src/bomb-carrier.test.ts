import { describe, expect, it } from 'vitest';
import { BREATH_RANGE, EYE_HEIGHT, TICK_RATE } from '../../shared/constants';
import { BOMB_SOUND_RANGE, DROP_REPICK_TICKS } from '../../shared/bomb';
import { decodeServer, encodeServer, type BombMsg, type NetCmd, type ServerMsg, type ShotEvent } from '../../shared/protocol';
import { FREEZE_MS, PLANT_TICKS } from '../../shared/rules';
import type { Box, MapData, Vec3 } from '../../shared/types';
import { Game, type Player } from './game';

const TICK_MS = 1000 / TICK_RATE;

/**
 * Floor, a site A around the origin, ghosts spawning at z = 20 and defenders at z = -20. Players are
 * moved around by setting their state directly: these tests are about the bomb rules, not walking.
 */
function makeMap(extra: Box[] = []): MapData {
    return {
        name: 'bombtest',
        bounds: { min: [-60, -0.5, -60], max: [60, 10, 60] },
        boxes: [{ min: [-60, -0.5, -60], max: [60, 0, 60] }, ...extra],
        spawns: {
            ghosts: [{ pos: [-4, 0, 20], yaw: 0 }, { pos: [0, 0, 20], yaw: 0 }, { pos: [4, 0, 20], yaw: 0 }],
            defenders: [{ pos: [-4, 0, -20], yaw: 180 }, { pos: [0, 0, -20], yaw: 180 }, { pos: [4, 0, -20], yaw: 180 }]
        },
        bombSites: [{ name: 'A', min: [-4, 0, -4], max: [4, 3, 4] }]
    };
}

class Client {
    /** Every message as the connection received it, through the real wire format. */
    readonly inbox: ServerMsg[] = [];
    readonly id: number;
    seq = 0;
    yaw = 0;
    constructor(private readonly game: Game, name = '') {
        this.id = game.join({
            send: m => {
                const back = decodeServer(encodeServer(m));
                if (back.type === 'spawn') this.yaw = back.yaw;
                this.inbox.push(back);
            }
        }, name);
    }
    get p(): Player { return this.game.players.get(this.id)!; }
    cmd(over: Partial<NetCmd> = {}): void {
        this.game.handleCmd(this.id, {
            seq: this.seq++, forward: 0, right: 0, yaw: this.yaw, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: this.game.now, ...over
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
    /** Puts the player's feet at `pos`, standing. */
    place(pos: Vec3): void {
        const s = this.p.state;
        s.pos[0] = pos[0]; s.pos[1] = pos[1]; s.pos[2] = pos[2];
        s.vel[0] = s.vel[1] = s.vel[2] = 0;
        s.onGround = true;
    }
    /** Looks from the eye toward a point. */
    aimAt(target: Vec3): Partial<NetCmd> {
        const p = this.p.state.pos;
        const dx = target[0] - p[0], dz = target[2] - p[2], dy = target[1] - (p[1] + EYE_HEIGHT);
        return { yaw: Math.fround(Math.atan2(-dx, -dz)), pitch: Math.fround(Math.atan2(dy, Math.hypot(dx, dz))) };
    }
}

/**
 * A room with `ghosts` ghosts and `defenders` defenders (joined alternately, ghosts first), advanced to
 * the live phase. `run` ticks the server; every client sends one command a tick unless `each` says null.
 */
function setup(ghosts: number, defenders: number, map = makeMap()) {
    const game = new Game(map, { rounds: true });
    const G: Client[] = [], D: Client[] = [];
    // Ghost, defender, ghost...: balanced rooms come out right by themselves (the leak tests use those).
    for (let i = 0; i < Math.max(ghosts, defenders); i++) {
        if (i < ghosts) G.push(new Client(game, `G${i}`));
        if (i < defenders) D.push(new Client(game, `D${i}`));
    }
    // Joining balances the teams; uneven rooms are set by hand (the round start respawns everyone).
    for (const c of G) { c.p.group = game.ghostGroup; c.p.team = 'ghosts'; }
    for (const c of D) { c.p.group = (1 - game.ghostGroup) as 0 | 1; c.p.team = 'defenders'; }
    for (const c of G) expect(c.p.team).toBe('ghosts');
    for (const c of D) expect(c.p.team).toBe('defenders');
    let ticks = 0;
    const run = (n: number, each: (c: Client) => Partial<NetCmd> | null = () => ({})): void => {
        for (let i = 0; i < n; i++) {
            game.tick(++ticks * TICK_MS);
            for (const c of [...G, ...D]) {
                if (!game.players.has(c.id)) continue;
                const over = each(c);
                if (over) c.cmd(over);
            }
        }
    };
    /** One server tick, then one command from `c` only (the others send nothing). */
    const step = (c: Client, over: Partial<NetCmd> = {}): void => {
        game.tick(++ticks * TICK_MS);
        c.cmd(over);
    };
    /** Runs until the phase is `phase` (at most two minutes of server time). */
    const until = (phase: string): void => {
        for (let i = 0; game.phase !== phase; i++) {
            if (i > 120 * TICK_RATE) throw new Error(`never reached ${phase} (still ${game.phase})`);
            run(1);
        }
    };
    const toLive = (): void => { run(1); until('live'); };
    const carrier = (): Client | undefined => G.find(c => c.id === game.carrierId);
    return { game, G, D, run, step, toLive, until, carrier };
}

const SITE: Vec3 = [0, 0, 0];

describe('bomb carrier: who carries it', () => {
    it('hands the bomb to one living ghost at the freeze, rotating through the team round by round', () => {
        const { game, G, run } = setup(3, 1);
        run(1);
        expect(game.phase).toBe('freeze');
        const carriers: number[] = [game.carrierId];
        expect(G.filter(c => c.p.carry.carrier).map(c => c.id)).toEqual([game.carrierId]);
        // Every ghost is told who has it; the carrier's snapshot carries the flag.
        for (const c of G) expect(c.last('bomb')).toMatchObject({ dropped: null, carrier: game.carrierId, event: 'assign', by: game.carrierId });
        run(2);
        expect(G.find(c => c.id === game.carrierId)!.last('snap').me.carry).toEqual({ carrier: true, wait: 0 });
        // Players who never change an input sit out after two rounds (the idle rule): keep looking around.
        const restless = (c: Client): Partial<NetCmd> => ({ pitch: (c.seq % 2) * 0.01 });
        for (let round = 2; round <= 4; round++) {
            run(1, restless);
            game['endRound']('defenders', 'time'); // end the round without playing it
            for (let i = 0; game.phase !== 'freeze'; i++) { if (i > 20 * TICK_RATE) throw new Error(`no next round: ${game.phase} ${[...game.players.values()].map(p => `${p.team}${p.idle ? ' idle' : ''}${p.alive ? '' : ' dead'}`)}`); run(1, restless); }
            carriers.push(game.carrierId);
        }
        // Join order: G0, G1, G2, then round and round again.
        expect(carriers).toEqual([G[0].id, G[1].id, G[2].id, G[0].id]);
    });

    it('never chooses an idle ghost, and warmup has no bomb', () => {
        const { game, G, run } = setup(2, 1);
        expect(game.phase).toBe('warmup');
        expect(game.carrierId).toBe(0);
        G[0].p.idle = true; // sits out: not spawned, so it cannot carry
        run(1);
        expect(game.phase).toBe('freeze');
        expect(game.carrierId).toBe(G[1].id);
    });

    it('lets only the carrier plant: another ghost in the site is not rooted and never plants', () => {
        const { game, G, run, toLive, carrier } = setup(2, 1);
        toLive();
        const c = carrier()!, other = G.find(g => g !== c)!;
        other.place([1, 0, 0]);
        c.place([20, 0, 0]);
        run(PLANT_TICKS + 30, g => (g === other ? { use: true, forward: 1 } : {}));
        expect(game.phase).toBe('live');
        expect(other.p.state.pos[2]).toBeLessThan(-1); // walked on while holding use
        expect(other.last('snap').me.actionTicks).toBe(0);
        c.place([-1, 0, 0]);
        run(PLANT_TICKS, g => (g === c ? { use: true, forward: 1 } : {}));
        expect(c.p.state.pos[2]).toBeCloseTo(0, 5); // rooted while planting
        expect(game.phase).toBe('planted');
        expect(game.carrierId).toBe(0);
        expect(c.p.carry.carrier).toBe(false);
        expect(c.last('bomb')).toEqual({ type: 'bomb', dropped: null, carrier: 0 });
    });
});

describe('bomb carrier: dropping and picking up', () => {
    it('drops at the feet on purpose, and the dropper cannot take it back for 60 of its own commands', () => {
        const { game, G, step, toLive, carrier } = setup(2, 1);
        toLive();
        const c = carrier()!, other = G.find(g => g !== c)!;
        c.place([10, 0, 10]);
        step(c, { drop: true });
        expect(game.dropped).toEqual([10, 0, 10]);
        expect(game.carrierId).toBe(0);
        expect(c.p.carry).toEqual({ carrier: false, wait: DROP_REPICK_TICKS });
        for (const g of G) expect(g.last('bomb')).toMatchObject({ dropped: [10, 0, 10], carrier: 0, event: 'drop', by: c.id });
        // Server time passing without commands does not count down the wait.
        for (let i = 0; i < 200; i++) game.tick(game.now + TICK_MS);
        expect(c.p.carry.wait).toBe(DROP_REPICK_TICKS);
        // Standing on it: commands 1 to 60 after the drop cannot pick it up, the 61st does.
        for (let i = 1; i <= DROP_REPICK_TICKS; i++) { game.tick(game.now + TICK_MS); c.cmd(); }
        expect(game.carrierId).toBe(0);
        game.tick(game.now + TICK_MS);
        c.cmd();
        expect(game.carrierId).toBe(c.id);
        expect(game.dropped).toBeNull();
        expect(other.last('bomb')).toMatchObject({ dropped: null, carrier: c.id, event: 'pickup', by: c.id });
    });

    it('counts the wait in processed commands, not in command numbers', () => {
        const { game, step, toLive, carrier } = setup(1, 1);
        toLive();
        const c = carrier()!;
        c.place([10, 0, 10]);
        step(c, { drop: true });
        // A modified client jumping its numbers gains nothing.
        for (let i = 1; i <= DROP_REPICK_TICKS; i++) { c.seq += 1000; step(c); }
        expect(game.carrierId).toBe(0);
        c.seq += 5000;
        step(c);
        expect(game.carrierId).toBe(c.id);
    });

    it('refuses a drop while planting', () => {
        const { game, run, toLive, carrier } = setup(1, 1);
        toLive();
        const c = carrier()!;
        c.place(SITE);
        run(30, g => (g === c ? { use: true } : {}));
        c.cmd({ use: true, drop: true });
        expect(game.carrierId).toBe(c.id);
        expect(game.dropped).toBeNull();
        run(PLANT_TICKS, g => (g === c ? { use: true } : {}));
        expect(game.phase).toBe('planted');
    });

    it('is picked up at once by a teammate walking over it, never by a defender', () => {
        const { game, G, D, run, toLive, carrier } = setup(2, 1);
        toLive();
        const c = carrier()!, mate = G.find(g => g !== c)!;
        D[0].place([10, 0, 10.4]); // a defender standing right on it
        c.place([10, 0, 10]);
        c.cmd({ drop: true });
        c.place([20, 0, 20]);
        run(120);
        expect(game.dropped).toEqual([10, 0, 10]);
        expect(game.carrierId).toBe(0);
        mate.place([10.3, 0, 10.4]); // its hull touches the bomb
        mate.cmd();
        expect(game.carrierId).toBe(mate.id);
        expect(mate.p.carry.carrier).toBe(true);
        expect(c.last('bomb')).toMatchObject({ dropped: null, carrier: mate.id, event: 'pickup', by: mate.id });
        // The pickup and drop are quiet sounds: ghosts in range learn who, the defender only that it happened.
        const heard = D[0].all('sound').filter(s => s.kind === 'bombDrop' || s.kind === 'bombPickup');
        expect(heard.map(s => s.kind)).toEqual(['bombDrop', 'bombPickup']);
        for (const s of heard) expect(s.id).toBe(0);
    });

    it('drops it where the carrier dies, on the floor under them if they were in the air', () => {
        const { game, D, run, toLive, carrier } = setup(2, 1, makeMap([{ min: [9, 0, 9], max: [11, 1, 11] }]));
        toLive();
        const c = carrier()!;
        // In the air above a crate: the bomb lands on the crate.
        c.place([10, 3, 10]);
        c.p.state.onGround = false;
        D[0].place([10, 0, 0]);
        const target: Vec3 = [10, 3 + 1.1, 10];
        for (let i = 0; i < 60 && c.p.alive; i++) {
            c.place([10, 3, 10]);
            c.p.state.onGround = false;
            run(1, g => (g === D[0] ? { fire: true, ...D[0].aimAt(target) } : null));
        }
        expect(c.p.alive).toBe(false);
        expect(game.dropped![0]).toBe(10);
        expect(game.dropped![1]).toBeCloseTo(1, 9); // on the crate's top, not in the air
        expect(game.dropped![2]).toBe(10);
        expect(game.carrierId).toBe(0);
        expect(c.last('bomb')).toMatchObject({ dropped: game.dropped, event: 'lost', by: c.id });
    });

    it('drops it where a disconnecting or idle carrier stood', () => {
        const left = setup(2, 1);
        left.toLive();
        const c = left.carrier()!;
        c.place([5, 0, 9]);
        left.game.leave(c.id);
        expect(left.game.dropped).toEqual([5, 0, 9]);
        expect(left.game.carrierId).toBe(0);
        const mate = left.G.find(g => g !== c)!;
        expect(mate.last('bomb')).toMatchObject({ event: 'lost', by: c.id, dropped: [5, 0, 9] });

        const idle = setup(2, 1);
        idle.toLive();
        const k = idle.carrier()!;
        k.place([6, 0, 9]);
        k.p.idle = true; // cannot happen mid-round today; the rule covers it anyway
        idle.run(1, c => (c === k ? null : {}));
        expect(idle.game.dropped).toEqual([6, 0, 9]);
        expect(idle.game.carrierId).toBe(0);
    });

    it('starts every round with a fresh carrier and no dropped bomb, and tells everyone', () => {
        const { game, G, D, toLive, until, carrier } = setup(2, 1);
        toLive();
        const c = carrier()!;
        c.cmd({ drop: true });
        expect(game.dropped).not.toBeNull();
        game['endRound']('defenders', 'time');
        until('freeze');
        expect(game.dropped).toBeNull();
        expect(game.carrierId).toBe(G.find(g => g !== c)!.id);
        for (const g of G) expect(g.last('bomb')).toMatchObject({ dropped: null, event: 'assign', by: game.carrierId });
        expect(D[0].last('bomb')).toEqual({ type: 'bomb', dropped: null });
    });
});

describe('bomb carrier: what defenders learn', () => {
    /** Every key of every JSON message a defender received, and the bomb sounds, must say nothing about the carrier. */
    function expectNoCarrierLeak(d: Client, carrierId: number): void {
        for (const m of d.inbox) {
            if (m.type === 'snap') continue; // binary: checked separately
            const text = JSON.stringify(m);
            expect(text).not.toMatch(/"carrier"/);
            expect(text).not.toMatch(/"event"/);
            if (m.type === 'bomb') expect(Object.keys(m).sort()).toEqual(['dropped', 'type']);
            if (m.type === 'sound' && (m.kind === 'bombDrop' || m.kind === 'bombPickup')) expect(m.id).toBe(0);
        }
        // The roster is the same for everyone and has no carrier field.
        for (const r of d.all('roster')) for (const e of r.players) expect(Object.keys(e)).not.toContain('carrier');
        // The defender's own snapshot never says "carrier".
        for (const s of d.all('snap')) expect(s.me.carry).toEqual({ carrier: false, wait: 0 });
        void carrierId;
    }

    it('a defender out of sight never receives the dropped position or who carries it, in any message', () => {
        // A long wall between the defender and the drop; the ghost is far beyond breathing range.
        const wall: Box = { min: [-30, 0, -2], max: [30, 4, -1] };
        const { game, G, D, run, toLive, carrier } = setup(2, 1, makeMap([wall]));
        toLive();
        const c = carrier()!, mate = G.find(g => g !== c)!;
        D[0].place([0, 0, -20]);
        c.place([10, 0, 15]);
        run(10);
        c.cmd({ drop: true });
        c.place([20, 0, 25]);
        run(70);
        mate.place([10, 0, 15.3]);
        run(10); // the teammate picks it up
        expect(game.carrierId).toBe(mate.id);
        mate.place([12, 0, 18]);
        mate.cmd({ drop: true });
        mate.place([25, 0, 25]);
        run(60);
        expect(game.dropped).not.toBeNull();
        expect(Math.hypot(game.dropped![0] - D[0].p.state.pos[0], game.dropped![2] - D[0].p.state.pos[2])).toBeGreaterThan(BOMB_SOUND_RANGE);
        // Nothing about the dropped bomb, or about any ghost, reached the defender.
        for (const b of D[0].all('bomb')) expect(b.dropped).toBeNull();
        for (const s of D[0].all('snap')) expect(s.players.filter(p => p.team === 'ghosts')).toEqual([]);
        expect(D[0].all('sound').filter(s => s.kind === 'bombDrop' || s.kind === 'bombPickup')).toEqual([]);
        expectNoCarrierLeak(D[0], mate.id);
    });

    it('a defender in sight is told where it lies, and told when sight is lost and when it is picked up', () => {
        const wall: Box = { min: [4, 0, -12], max: [30, 4, -11] };
        const { game, G, D, run, toLive, carrier } = setup(2, 1, makeMap([wall]));
        toLive();
        const c = carrier()!, mate = G.find(g => g !== c)!;
        D[0].place([0, 0, -20]);
        c.place([10, 0, 10]); // in the open: the defender can see the spot
        c.cmd({ drop: true });
        c.place([20, 0, 20]);
        run(2);
        const seen = D[0].last('bomb');
        expect(seen).toEqual({ type: 'bomb', dropped: [10, 0, 10] });
        // Behind the wall: told it is out of sight.
        D[0].place([10, 0, -20]);
        run(3);
        expect(D[0].last('bomb')).toEqual({ type: 'bomb', dropped: null });
        const n = D[0].all('bomb').length;
        run(30);
        expect(D[0].all('bomb').length).toBe(n); // only on a change
        // Back in sight, then a ghost picks it up in front of it.
        D[0].place([0, 0, -20]);
        run(2);
        expect(D[0].last('bomb')).toEqual({ type: 'bomb', dropped: [10, 0, 10] });
        mate.place([10, 0, 10.2]);
        run(1);
        expect(game.carrierId).toBe(mate.id);
        expect(D[0].last('bomb')).toEqual({ type: 'bomb', dropped: null });
        expectNoCarrierLeak(D[0], mate.id);
    });
});

describe('shot events tell only those who know about the victim', () => {
    /**
     * Two defenders: the shooter in the open in front of a ghost, a second one in earshot of the shot but
     * behind a wall and beyond breathing range of the ghost. The ghost stands still (invisible).
     */
    function shootGhost(bystander: Vec3, extra: Box[] = []) {
        const { game, G, D, run, toLive } = setup(1, 2, makeMap(extra));
        toLive();
        const ghost = G[0], shooter = D[0], other = D[1];
        ghost.place([0, 0, 10]);
        shooter.place([0, 0, 0]);
        other.place(bystander);
        run(30); // the ghost's visibility settles at zero
        const aim = shooter.aimAt([0, 1.1, 10]);
        shooter.cmd({ fire: true, ...aim });
        const hit = shooter.last('shot');
        expect(hit.victim).toBe(ghost.id); // the shot did land
        void game;
        return { hit, theirs: other.all('shot'), ghost };
    }

    it('a defender behind a wall and beyond breathing range gets no victim and no point on its body', () => {
        const wall: Box = { min: [10, 0, -10], max: [11, 4, 30] };
        const { hit, theirs, ghost } = shootGhost([20, 0, 10], [wall]);
        expect(Math.hypot(20, 0)).toBeGreaterThan(BREATH_RANGE);
        expect(theirs).toHaveLength(1); // heard: within gunshot range
        const s: ShotEvent = theirs[0];
        expect(s).not.toHaveProperty('victim');
        expect(s).not.toHaveProperty('zone');
        expect(s).not.toHaveProperty('damage');
        expect(s).not.toHaveProperty('killed');
        expect(s.from).toEqual(hit.from);
        // The tracer runs on through where the ghost stood, to the map behind it (here: the far edge of the floor,
        // as the ray dips into the ground well past the ghost).
        const reach = Math.hypot(s.to[0] - s.from[0], s.to[2] - s.from[2]);
        expect(reach).toBeGreaterThan(12);
        expect(Math.hypot(hit.to[0] - s.from[0], hit.to[2] - s.from[2])).toBeLessThan(10);
        void ghost;
    });

    it('a defender who can see the ghost (it flares when hit) receives the full event', () => {
        const { hit, theirs } = shootGhost([12, 0, 4]);
        expect(theirs).toHaveLength(1);
        expect(theirs[0]).toEqual(hit);
    });

    it('a defender within breathing range of the ghost receives the full event even behind a wall', () => {
        const wall: Box = { min: [2, 0, 5], max: [3, 4, 15] };
        const { hit, theirs } = shootGhost([6, 0, 10], [wall]);
        expect(theirs[0]).toEqual(hit);
    });
});

describe('bomb carrier: wire and state', () => {
    it('sends ghosts the bomb state on joining mid-round', () => {
        const { game, run, toLive } = setup(1, 1);
        toLive();
        const late = new Client(game, 'Late'); // joins the ghosts (tie)
        expect(late.p.team).toBe('ghosts');
        expect(late.last('bomb')).toEqual({ type: 'bomb', dropped: null, carrier: game.carrierId });
        run(1);
        void FREEZE_MS;
    });

    it('carries the carry flag in the snapshot exactly', () => {
        const { run, toLive, carrier } = setup(1, 1);
        toLive();
        const c = carrier()!;
        c.cmd({ drop: true });
        run(2, () => null);
        expect(c.last('snap').me.carry).toEqual({ carrier: false, wait: DROP_REPICK_TICKS });
        const m: BombMsg = c.last('bomb');
        expect(m.event).toBe('drop');
    });
});
