import { BREATH_RANGE, EYE_HEIGHT, EYE_HEIGHT_CROUCHED, HULL_HEIGHT, HULL_HEIGHT_CROUCHED, KNIFE_RANGE, KNIFE_SOUND_RANGE, STEP_RANGE } from '../../shared/constants';
import { heldGun } from '../../shared/gun';
import type { LoadoutState } from '../../shared/gun';
import type { KnifeState } from '../../shared/knife';
import type { CarryState } from '../../shared/bomb';
import { NAV_JUMP, NavGraph } from '../../shared/nav';
import { SNAPSHOT_RATE, type NetCmd, type ServerMsg, type Team } from '../../shared/protocol';
import type { BotLevel } from '../../shared/room-options';
import { DEFUSE_RANGE, insideSite, type Phase } from '../../shared/rules';
import type { MapData, PlayerState, Vec3 } from '../../shared/types';
import { SLOT_KNIFE, SLOT_PISTOL, SLOT_RIFLE, WEAPONS } from '../../shared/weapons';
import type { Connection } from './game';

/*
 * Bots: server-side players without a socket (package E).
 *
 * A bot is a `Player` whose `Connection` delivers every message into a `BotView` instead of a socket,
 * and whose brain produces one `NetCmd` per server tick that goes through `Game.handleCmd` like a
 * person's, so every rule applies to it. **The brain sees only what a person on its team is sent**:
 * its own player (a person knows their own state), the map (public), and the messages its connection
 * received: snapshots already filtered by `Game.knowsAbout`, sound, shot and slash events within
 * earshot, the bomb messages (a defender learns of a dropped bomb only while it is in its line of
 * sight), damage taken, the round and the roster. Positions in those messages are copied the moment
 * they arrive: the snapshot holds live references to other players' state, which would otherwise keep
 * moving after the bot stopped being told about them.
 *
 * No randomness from `Math.random`, no wall-clock time, no client `seq`: every timer counts the bot's
 * own think calls (one per server tick), and variation comes from a seeded generator stepped once per
 * think.
 */

/** Deterministic generator (mulberry32): the only source of a bot's variation. */
export class BotRng {
    private s: number;
    constructor(seed: number) { this.s = seed >>> 0; }
    /** Uniform in [0, 1). */
    next(): number {
        let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    /** Uniform in [-1, 1). */
    signed(): number { return this.next() * 2 - 1; }
    int(n: number): number { return Math.floor(this.next() * n) % Math.max(1, n); }
}

/** A string hash for seeds (room code, names). */
export function hashSeed(text: string, salt = 0): number {
    let h = (2166136261 ^ salt) >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    return h;
}

/** What differs between the difficulty levels. Times are in ticks (60 per second). */
export interface LevelParams {
    /** From first sight of a target to the first shot. */
    react: number;
    /** Aim error when a target is acquired (radians); it shrinks while the bot tracks. */
    aimErr: number;
    /** The error is multiplied by this every tick of tracking. */
    settle: number;
    /** Fastest view turn per tick (radians). */
    turn: number;
    /** Share of a sound's carrying distance within which the bot reacts to it. */
    hear: number;
    /** A ghost at least this visible is spotted by eye. */
    spotVis: number;
    /** Shoots at a ghost in sight that it can only hear breathing (invisible), within this distance (at most 8 m). */
    breath: number;
    /** How long a last-known position or a heard sound is worth chasing. */
    memory: number;
    /** Rifle shots per burst before a pause for the recoil to settle. */
    burst: number;
    /** Ghost: longest it stands still while a defender looks its way. */
    patience: number;
    /** Ghost: from this distance it goes for a defender who is looking away. */
    stalk: number;
    /** Chance per acquired target of aiming at the head. */
    head: number;
}

const DEG = Math.PI / 180;
export const LEVELS: Readonly<Record<BotLevel, LevelParams>> = {
    easy: { react: 42, aimErr: 7 * DEG, settle: 0.97, turn: 4 * DEG, hear: 0.5, spotVis: 0.22, breath: 0, memory: 150, burst: 4, patience: 150, stalk: 9, head: 0 },
    normal: { react: 24, aimErr: 3.5 * DEG, settle: 0.95, turn: 7 * DEG, hear: 0.8, spotVis: 0.12, breath: 4, memory: 300, burst: 6, patience: 360, stalk: 13, head: 0.15 },
    hard: { react: 13, aimErr: 1.6 * DEG, settle: 0.92, turn: 12 * DEG, hear: 1, spotVis: 0.07, breath: BREATH_RANGE, memory: 420, burst: 8, patience: 600, stalk: 17, head: 0.35 }
};

/** What a bot can read about itself: the same things the person playing it would know. */
export interface BotSelf {
    readonly id: number;
    readonly team: Team;
    readonly alive: boolean;
    readonly state: PlayerState;
    readonly loadout: LoadoutState;
    readonly knife: KnifeState;
    readonly carry: CarryState;
    readonly health: number;
}

/** The public facts a bot may use besides its messages. Implemented by `Game`. */
export interface BotWorld {
    readonly map: MapData;
    /** The map's navigation graph, null when the map has none (then no bots can be added). */
    readonly nav: NavGraph | null;
    /** Nothing solid between the two points (map geometry only). */
    clearLine(a: Vec3, b: Vec3): boolean;
    /** The site the team's bots go for (ghosts) or start at (defenders) this round: a plan, not information. */
    teamSite(team: Team): number;
}

/** One other player as last told. */
interface Contact {
    id: number;
    team: Team;
    pos: Vec3;
    yaw: number;
    crouched: boolean;
    alive: boolean;
    vis: number;
    /** The snapshot count when last in a snapshot. */
    seen: number;
    /** The bot's tick when last in a snapshot. */
    seenTick: number;
    /** Ground speed (m/s) between its last two snapshots, when they were consecutive. */
    speed: number;
}

/** Something heard: a footstep, a windup, a slash, a bomb noise. */
interface Heard {
    pos: Vec3;
    tick: number;
}

/**
 * Everything the bot has been sent, copied out of the messages as they arrive. Nothing else feeds
 * the brain's picture of other players.
 */
export class BotView {
    id = 0;
    phase: Phase = 'warmup';
    round = 0;
    planted: Vec3 | null = null;
    /** Server time the current phase ends (0 in warmup). */
    endsAt = 0;
    /** Server time of the newest snapshot: what the bot's view shows (its lag-compensation time). */
    snapTime = 0;
    /** Snapshots received. */
    snaps = 0;
    readonly contacts = new Map<number, Contact>();
    readonly roster = new Map<number, { team: Team; alive: boolean; bot: boolean }>();
    /** The newest enemy noise in earshot. */
    heard: Heard | null = null;
    /** Damage taken: the bearing toward the attacker and when. */
    hurtDir = 0;
    hurtTick = -1;
    /** A dropped bomb: ghosts always know; defenders only while it is in their sight. */
    dropped: Vec3 | null = null;
    /** Ghosts only: who carries the bomb (0: nobody). */
    carrier = 0;
    /** The bot's tick, set by the brain before each think (for message time stamps). */
    tick = 0;
    /** Incremented on every spawn message. */
    spawns = 0;
    /** The hit confirmations received (for tests and the practice range). */
    hits = 0;
    /** Filled in by the brain: which ids are heard as enemies. */
    myTeam: Team = 'ghosts';

    receive(msg: ServerMsg): void {
        switch (msg.type) {
            case 'welcome': this.id = msg.id; this.myTeam = msg.team; break;
            case 'round':
                this.phase = msg.phase;
                this.round = msg.round;
                this.endsAt = msg.endsAt;
                this.planted = msg.bomb ? [msg.bomb[0], msg.bomb[1], msg.bomb[2]] : null;
                break;
            case 'roster':
                this.roster.clear();
                for (const p of msg.players) this.roster.set(p.id, { team: p.team, alive: p.alive, bot: p.bot });
                break;
            case 'snap': {
                this.snapTime = msg.time;
                this.snaps++;
                this.myTeam = msg.me.team;
                for (const p of msg.players) {
                    let c = this.contacts.get(p.id);
                    if (!c) {
                        c = { id: p.id, team: p.team, pos: [p.pos[0], p.pos[1], p.pos[2]], yaw: 0, crouched: false, alive: false, vis: 0, seen: 0, seenTick: 0, speed: 0 };
                        this.contacts.set(p.id, c);
                    }
                    c.speed = c.seen === this.snaps - 1 ? Math.hypot(p.pos[0] - c.pos[0], p.pos[2] - c.pos[2]) * SNAPSHOT_RATE : 0;
                    c.team = p.team;
                    c.pos[0] = p.pos[0]; c.pos[1] = p.pos[1]; c.pos[2] = p.pos[2];
                    c.yaw = p.yaw; c.crouched = p.crouched; c.alive = p.alive; c.vis = p.vis;
                    c.seen = this.snaps; c.seenTick = this.tick;
                }
                break;
            }
            case 'spawn': this.spawns++; this.contacts.clear(); this.heard = null; this.hurtTick = -1; break;
            case 'sound':
                if (msg.kind === 'reload') break;
                if (this.isEnemy(msg.id)) this.hear(msg.pos, msg.kind === 'step' ? STEP_RANGE * msg.loud : msg.kind === 'windup' ? KNIFE_SOUND_RANGE : 8);
                break;
            case 'slash':
                if (this.isEnemy(msg.attacker)) this.hear(msg.pos, KNIFE_SOUND_RANGE);
                break;
            case 'dmg': this.hurtDir = msg.dir; this.hurtTick = this.tick; break;
            case 'kill': { const c = this.contacts.get(msg.victim); if (c) c.alive = false; break; } // the kill feed: everyone gets it
            case 'hitconfirm': this.hits++; break;
            case 'bomb':
                this.dropped = msg.dropped ? [msg.dropped[0], msg.dropped[1], msg.dropped[2]] : null;
                if (msg.carrier !== undefined) this.carrier = msg.carrier;
                break;
        }
    }

    /** A sound's source counts as an enemy if the roster says so; an anonymous source (id 0, a bomb noise heard by a defender) too. */
    private isEnemy(id: number): boolean {
        if (id === this.id) return false;
        if (id === 0) return true;
        const r = this.roster.get(id);
        return r !== undefined && r.team !== this.myTeam;
    }

    /** `range` is how far that sound carries; the brain decides whether it was close enough to react. */
    private hear(pos: Vec3, range: number): void {
        this.heard = { pos: [pos[0], pos[1], pos[2]], tick: this.tick };
        this.heardRange = range;
    }
    heardRange = 0;
}

export type BotRole = 'player' | 'target-static' | 'target-moving';

const tmpA: Vec3 = [0, 0, 0];
const tmpB: Vec3 = [0, 0, 0];

/** Half the horizontal field of view in which a defender bot can spot a ghost by eye (radians). */
const VIEW_HALF_ANGLE = 55 * DEG;
/** Defenders investigating a noise stop this far from it and watch. */
const INVESTIGATE_STOP = 5;
/** Weighted A* for bot paths: about three times fewer nodes searched, paths at most 1.6 times the cheapest. */
const PATH_GREED = 1.6;
/** Ghosts stop waiting (backing off, standing still) when the live round has less than this left. */
const URGENT_MS = 55_000;
/** A carrier in the site waits at most this long (ticks) for a spot no defender sees before planting anyway. */
const PLANT_WAIT_MAX = 600;
/** Ghosts rush a defender closer than this rather than wait to be found. */
const ALL_IN_RANGE = 4.5;
/** Ghost paths cost more within this distance of a defender. */
const DANGER_RADIUS = 10;

const wrap = (a: number): number => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
};
/** View yaw that faces from (ax, az) toward (bx, bz) (yaw 0 faces -Z, see shared/raycast.ts). */
const yawTo = (ax: number, az: number, bx: number, bz: number): number => Math.atan2(-(bx - ax), -(bz - az));
const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Nav nodes inside each bomb site (by map), a little in from the edges so a bot standing there is inside. */
const siteNodeCache = new WeakMap<MapData, number[][]>();
export function siteNodes(map: MapData, nav: NavGraph): number[][] {
    let out = siteNodeCache.get(map);
    if (out) return out;
    out = map.bombSites.map(s => {
        const ids: number[] = [];
        for (let pass = 0; pass < 2 && ids.length === 0; pass++) {
            const inset = pass === 0 ? 0.5 : 0;
            for (let n = 0; n < nav.count; n++) {
                const x = nav.x[n], y = nav.y[n], z = nav.z[n];
                if (x >= s.min[0] + inset && x <= s.max[0] - inset && z >= s.min[2] + inset && z <= s.max[2] - inset &&
                    y >= s.min[1] - 0.1 && y <= s.max[1]) ids.push(n);
            }
        }
        return ids;
    });
    siteNodeCache.set(map, out);
    return out;
}

/**
 * One bot's mind. `think` is called once per server tick and returns the command for that tick.
 */
export class BotBrain {
    readonly view = new BotView();
    readonly conn: Connection;
    /** Debugging hook (tools/bottrace.ts): told about decisions worth tracing. Unset in the game. */
    static debug: ((line: string) => void) | undefined;
    /** What the bot is doing (a constant label, for tools/bottrace.ts and tests). */
    mode = 'idle';
    private readonly rng: BotRng;
    private readonly lv: LevelParams;
    private tick = 0;
    private seq = 0;
    private readonly cmd: NetCmd = {
        seq: 0, forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, walk: false, crouch: false, fire: false,
        use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: 0
    };
    /** The view the bot is turning toward and where it looks now. */
    private yaw = 0;
    private pitch = 0;
    private lookInit = false;

    // Navigation.
    private readonly path: number[] = [];
    private pathAt = 0;
    private readonly goal: Vec3 = [0, 0, 0];
    private hasGoal = false;
    private goalNode = -1;
    private progressAt = 0;
    private readonly progressPos: Vec3 = [0, 0, 0];
    private stuck = 0;
    /** Per-bot route taste: a cost added per area, so bots of one team take different ways. */
    private readonly routeSeed: number;
    private readonly routeVariety: number;

    // Plans and memory.
    private planRound = -1;
    private planSpawns = -1;
    private holdNode = -1;
    private readonly lookAt: Vec3 = [0, 0, 0];
    private holdUntil = 0;
    private targetId = 0;
    private targetSince = 0;
    private errYaw = 0;
    private errPitch = 0;
    private aimHead = false;
    private burstShots = 0;
    private burstPause = 0;
    private lastMag = -1;
    private readonly lastKnown: Vec3 = [0, 0, 0];
    private lastKnownTick = -1;
    private investigateTick = -1;
    private readonly investigate: Vec3 = [0, 0, 0];
    private watchedTicks = 0;
    private frozenFor = 0;
    private losTick = -1;
    private losOk = false;
    private strafe = 1;
    private strafeTicks = 0;

    constructor(
        readonly role: BotRole, readonly level: BotLevel, seed: number,
        /** Practice targets: the way they face. */
        private readonly faceYaw = 0
    ) {
        this.rng = new BotRng(seed);
        this.lv = LEVELS[level];
        this.routeSeed = hashSeed('route', seed);
        this.routeVariety = 0.6 + this.rng.next() * 1.6;
        this.conn = { send: msg => this.view.receive(msg) };
    }

    /** One command for this tick. */
    think(self: BotSelf, world: BotWorld): NetCmd {
        this.tick++;
        this.view.tick = this.tick;
        this.rng.next(); // stepped once per tick, whatever the bot decides
        const c = this.cmd;
        c.seq = ++this.seq;
        c.forward = 0; c.right = 0; c.jump = false; c.walk = false; c.crouch = false; c.fire = false;
        c.use = false; c.reload = false; c.slot = 0; c.swap = false; c.aim = false; c.drop = false;
        c.viewTime = this.view.snapTime;
        this.mode = 'idle';
        if (!this.lookInit || this.view.spawns !== this.planSpawns) this.onSpawn(self, world);
        if (self.alive && world.nav) {
            if (this.role === 'player') {
                if (self.team === 'defenders') this.defender(self, world, world.nav);
                else this.ghost(self, world, world.nav);
            } else this.target(self);
        }
        c.yaw = this.yaw;
        c.pitch = this.pitch;
        return c;
    }

    private onSpawn(self: BotSelf, world: BotWorld): void {
        this.lookInit = true;
        this.planSpawns = this.view.spawns;
        this.planRound = -1;
        this.plantWait = 0;
        this.spotCheckAt = 0;
        this.clearPath();
        this.hasGoal = false;
        this.targetId = 0;
        this.lastKnownTick = -1;
        this.investigateTick = -1;
        this.holdNode = -1;
        this.lastMag = -1;
        this.burstShots = 0;
        this.burstPause = 0;
        this.watchedTicks = this.frozenFor = 0;
        // Face the way the spawn faces (the server's spawn yaw arrives with the spawn message; the self
        // state has the position). Practice targets face their set direction.
        this.yaw = this.role === 'player' ? this.spawnYaw(self, world) : this.faceYaw;
        this.pitch = 0;
    }

    private spawnYaw(self: BotSelf, world: BotWorld): number {
        let best = 0, bestD = Infinity;
        for (const s of world.map.spawns[self.team]) {
            const d = flat(s.pos, self.state.pos);
            if (d < bestD) { bestD = d; best = (s.yaw * Math.PI) / 180; }
        }
        return best;
    }

    // -----------------------------------------------------------------------------------------
    // Looking and moving
    // -----------------------------------------------------------------------------------------

    /** Turns the view toward a yaw and pitch, no faster than the level allows. */
    private turnTo(yaw: number, pitch: number, rate = this.lv.turn): void {
        const dy = wrap(yaw - this.yaw);
        this.yaw = wrap(this.yaw + Math.max(-rate, Math.min(rate, dy)));
        const dp = pitch - this.pitch;
        this.pitch += Math.max(-rate, Math.min(rate, dp));
    }

    private lookToward(self: BotSelf, p: Vec3, height: number, rate?: number): void {
        const eye = this.eye(self, tmpA);
        const dx = p[0] - eye[0], dz = p[2] - eye[2], dy = p[1] + height - eye[1];
        this.turnTo(yawTo(0, 0, dx, dz), Math.atan2(dy, Math.hypot(dx, dz)), rate);
    }

    private eye(self: BotSelf, out: Vec3): Vec3 {
        out[0] = self.state.pos[0];
        out[1] = self.state.pos[1] + (self.state.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT);
        out[2] = self.state.pos[2];
        return out;
    }

    /** Sets forward/right so the bot moves along a world direction whatever way it looks. */
    private moveDir(dx: number, dz: number): void {
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) return;
        dx /= len; dz /= len;
        const s = Math.sin(this.yaw), co = Math.cos(this.yaw);
        // Inverse of the wish direction in shared/movement.ts.
        this.cmd.forward = -s * dx - co * dz;
        this.cmd.right = co * dx - s * dz;
    }

    private clearPath(): void {
        this.path.length = 0;
        this.pathAt = 0;
        this.goalNode = -1;
    }

    /** Path cost per node: this bot's route taste plus, for ghosts, nearness to defenders (see `costs`). */
    private readonly penalty = (n: number): number => this.areaCost![n] + this.dangerCost![n];
    /** Route taste: a random field over 6 m blocks, different for every bot (built once per map). */
    private areaCost: Float32Array | null = null;
    /** Ghosts: extra cost near each known defender when the path was planned, most of all its breathing range. */
    private dangerCost: Float32Array | null = null;
    private readonly dangerNodes: number[] = [];
    private readonly scratch: number[] = [];

    /** Fills the per-node path costs before a search. */
    private costs(nav: NavGraph): void {
        if (!this.areaCost || this.areaCost.length !== nav.count || this.navRef !== nav) {
            this.areaCost = new Float32Array(nav.count);
            this.dangerCost = new Float32Array(nav.count);
            this.dangerNodes.length = 0;
            for (let n = 0; n < nav.count; n++) {
                const bx = Math.floor(nav.x[n] / 6), bz = Math.floor(nav.z[n] / 6), by = Math.floor(nav.y[n] / 3);
                let h = (Math.imul(bx, 73856093) ^ Math.imul(bz, 19349663) ^ Math.imul(by, 83492791) ^ this.routeSeed) >>> 0;
                h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
                this.areaCost[n] = ((h & 0xffff) / 0xffff) * this.routeVariety;
            }
        }
        this.navRef = nav;
        const dc = this.dangerCost!;
        for (const n of this.dangerNodes) dc[n] = 0;
        this.dangerNodes.length = 0;
        const dz = this.danger;
        for (let i = 0; i < dz.length; i += 2) {
            tmpA[0] = dz[i]; tmpA[1] = this.dangerY[i >> 1]; tmpA[2] = dz[i + 1];
            for (const n of nav.within(tmpA, DANGER_RADIUS, 4, this.scratch)) {
                const d = Math.hypot(nav.x[n] - dz[i], nav.z[n] - dz[i + 1]);
                if (dc[n] === 0) this.dangerNodes.push(n);
                dc[n] += (DANGER_RADIUS - d) * 1.2;
            }
        }
    }
    private navRef: NavGraph | null = null;
    /** Ghosts: x, z of every defender when the path was planned (path cost rises near them), and their heights. */
    private readonly danger: number[] = [];
    private readonly dangerY: number[] = [];
    /** Plan the path again this often (ticks) while > 0: ghosts near defenders keep re-routing around them. */
    private replanEvery = 0;

    /**
     * Walks toward `goal` over the nav graph. Returns the remaining straight distance, or -1 when there is
     * no way there (the caller picks another goal).
     */
    private go(self: BotSelf, nav: NavGraph, goal: Vec3, walk: boolean, lookAhead = true): number {
        const pos = self.state.pos;
        const remaining = Math.hypot(goal[0] - pos[0], goal[1] - pos[1], goal[2] - pos[2]);
        if (!this.hasGoal || flat(goal, this.goal) > 1.5 || Math.abs(goal[1] - this.goal[1]) > 1.5) {
            this.goal[0] = goal[0]; this.goal[1] = goal[1]; this.goal[2] = goal[2];
            this.hasGoal = true;
            this.clearPath();
        }
        if (this.replanEvery > 0 && (this.tick + this.view.id) % this.replanEvery === 0) this.clearPath();
        if (this.goalNode < 0) {
            if (!this.plan(self, nav)) return -1;
        }
        // Progress check: no real movement for a second means stuck: jump, then plan again from here.
        if (this.tick - this.progressAt > 60) {
            const moved = flat(pos, this.progressPos);
            this.progressAt = this.tick;
            this.progressPos[0] = pos[0]; this.progressPos[1] = pos[1]; this.progressPos[2] = pos[2];
            if (moved < 0.4 && remaining > 0.6) {
                this.stuck++;
                this.cmd.jump = true;
                if (this.stuck >= 2) this.clearPath();
                if (this.stuck >= 5) { this.stuck = 0; this.hasGoal = false; return -1; }
                if (this.goalNode < 0 && !this.plan(self, nav)) return -1;
            } else this.stuck = 0;
        }
        let tx = goal[0], tz = goal[2];
        if (this.pathAt < this.path.length) {
            let n = this.path[this.pathAt];
            // Close enough to this node: head for the next one. Nodes are never skipped: only the straight
            // line between two linked nodes is known to be walkable (the map verifier tested it).
            while (this.pathAt < this.path.length) {
                n = this.path[this.pathAt];
                if (nav.flatDist(n, pos[0], pos[2]) < 0.4 && Math.abs(nav.y[n] - pos[1]) < 1.0) this.pathAt++;
                else break;
            }
            if (this.pathAt < this.path.length) {
                n = this.path[this.pathAt];
                tx = nav.x[n]; tz = nav.z[n];
                const prev = this.pathAt > 0 ? this.path[this.pathAt - 1] : -1;
                if (prev >= 0 && nav.linkKind(prev, n) === NAV_JUMP && nav.flatDist(n, pos[0], pos[2]) < 1.3 &&
                    nav.y[n] > pos[1] + 0.3 && self.state.onGround) this.cmd.jump = true;
            }
        }
        if (remaining < 0.15 && this.pathAt >= this.path.length) return remaining;
        const dx = tx - pos[0], dz = tz - pos[2];
        if (lookAhead) this.turnTo(yawTo(0, 0, dx, dz), 0, this.lv.turn * 0.7);
        this.moveDir(dx, dz);
        this.cmd.walk = walk;
        return remaining;
    }

    private plan(self: BotSelf, nav: NavGraph): boolean {
        this.costs(nav);
        const start = nav.nearest(self.state.pos);
        const end = nav.nearest(this.goal, 4, 1.2, 2);
        if (start < 0 || end < 0) return false;
        this.goalNode = end;
        this.pathAt = 0;
        if (!nav.findPath(start, end, this.path, this.penalty, PATH_GREED)) { this.goalNode = -1; return false; }
        this.progressAt = this.tick;
        const p = self.state.pos;
        this.progressPos[0] = p[0]; this.progressPos[1] = p[1]; this.progressPos[2] = p[2];
        return true;
    }

    /** A random nav node from a list (or -1). */
    private pick(list: readonly number[]): number {
        return list.length ? list[this.rng.int(list.length)] : -1;
    }

    private nodePos(nav: NavGraph, n: number, out: Vec3): Vec3 {
        out[0] = nav.x[n]; out[1] = nav.y[n]; out[2] = nav.z[n];
        return out;
    }

    // -----------------------------------------------------------------------------------------
    // Seeing enemies (from snapshots only)
    // -----------------------------------------------------------------------------------------

    /** The enemy to shoot: in the newest snapshot (so the server still tells us where it is), alive, closest. */
    private freshEnemy(self: BotSelf): Contact | null {
        let best: Contact | null = null, bestD = Infinity;
        for (const c of this.view.contacts.values()) {
            if (c.team === self.team || !c.alive || c.seen !== this.view.snaps) continue;
            const d = flat(c.pos, self.state.pos);
            if (d < bestD) { bestD = d; best = c; }
        }
        return best;
    }

    private aimPoint(c: Contact, head: boolean): number {
        const h = c.crouched ? HULL_HEIGHT_CROUCHED : HULL_HEIGHT;
        return head ? h - 0.13 : h * 0.68;
    }

    /** Clear line from the bot's eye to a contact's chest (cached for a few ticks per target). */
    private canSee(self: BotSelf, world: BotWorld, c: Contact): boolean {
        if (this.losTick >= 0 && this.tick - this.losTick < 4 && this.targetId === c.id) return this.losOk;
        this.eye(self, tmpA);
        tmpB[0] = c.pos[0]; tmpB[1] = c.pos[1] + this.aimPoint(c, false); tmpB[2] = c.pos[2];
        this.losOk = world.clearLine(tmpA, tmpB);
        this.losTick = this.tick;
        return this.losOk;
    }

    // -----------------------------------------------------------------------------------------
    // Defenders
    // -----------------------------------------------------------------------------------------

    private defender(self: BotSelf, world: BotWorld, nav: NavGraph): void {
        const v = this.view;
        const pos = self.state.pos;
        if (v.phase === 'freeze') { this.planDefender(world, nav); this.turnTo(this.yaw, 0); return; }
        if (this.planRound !== v.round || this.holdNode < 0) this.planDefender(world, nav);

        // 1. A ghost the bot has been told about and can see: shoot it.
        const enemy = this.freshEnemy(self);
        let engaged = false;
        if (enemy) {
            const d = flat(enemy.pos, pos);
            // Eyes see only ahead: a shimmer counts inside the field of view, easier to spot up close (the
            // visibility needed grows past 10 m). Breathing is heard all round: the bot turns toward it.
            const inView = Math.abs(wrap(yawTo(pos[0], pos[2], enemy.pos[0], enemy.pos[2]) - this.yaw)) < VIEW_HALF_ANGLE;
            const heard = d <= this.lv.breath || d < 2.5;
            const spotted = (inView && enemy.vis >= this.lv.spotVis * Math.max(1, d / 10)) || (inView && heard);
            if (spotted && this.canSee(self, world, enemy)) {
                if (this.targetId !== enemy.id) BotBrain.debug?.(`D${this.view.id} engages G${enemy.id} at ${d.toFixed(1)} m vis ${enemy.vis.toFixed(2)} speed ${enemy.speed.toFixed(1)} heard ${heard}`);
                engaged = true;
                this.lastKnown[0] = enemy.pos[0]; this.lastKnown[1] = enemy.pos[1]; this.lastKnown[2] = enemy.pos[2];
                this.lastKnownTick = this.tick;
                this.engage(self, enemy, d);
            } else if (heard) {
                this.mode = 'turn to breath';
                this.lookToward(self, enemy.pos, 1.1, this.lv.turn);
                return;
            }
        }
        if (!engaged) {
            this.targetId = 0;
            if (this.weaponsIdle(self)) return;
        }
        if (engaged) return;

        // 2. The planted bomb: go and defuse it.
        if (v.phase === 'planted' && v.planted) {
            const b = v.planted;
            const d = flat(b, pos);
            if (d <= DEFUSE_RANGE - 0.3 && Math.abs(pos[1] - b[1]) < 1.2 && self.state.onGround) {
                this.cmd.use = true;
                this.lookToward(self, b, 0.1);
                return;
            }
            this.go(self, nav, b, false);
            return;
        }

        // 3. Damage from an unseen attacker, a sound, or a lost target: turn and investigate.
        if (v.hurtTick >= 0 && this.tick - v.hurtTick < 40) {
            this.turnTo(v.hurtDir, 0, this.lv.turn * 1.3);
            if (this.tick - v.hurtTick < 2) this.setInvestigate(pos[0] - Math.sin(v.hurtDir) * 4, pos[1], pos[2] - Math.cos(v.hurtDir) * 4);
            this.cmd.crouch = false;
            return;
        }
        const h = v.heard;
        if (h && this.tick - h.tick < 3 && flat(h.pos, pos) <= v.heardRange * this.lv.hear) {
            // Close, or near the spot it holds: go and look. Further off: only turn toward it (keep the site).
            const holdD = this.holdNode >= 0 ? nav.flatDist(this.holdNode, h.pos[0], h.pos[2]) : 0;
            if (flat(h.pos, pos) < 9 || holdD < 12) this.setInvestigate(h.pos[0], h.pos[1], h.pos[2]);
            else { this.lookAt[0] = h.pos[0]; this.lookAt[1] = h.pos[1]; this.lookAt[2] = h.pos[2]; }
            v.heard = null;
        }
        if (this.lastKnownTick >= 0 && this.tick - this.lastKnownTick < this.lv.memory && this.lastKnownTick > this.investigateTick) {
            this.setInvestigate(this.lastKnown[0], this.lastKnown[1], this.lastKnown[2]);
        }
        if (this.investigateTick >= 0 && this.tick - this.investigateTick < this.lv.memory) {
            const left = flat(this.investigate, pos);
            if (this.tick - this.investigateTick < 30) {
                this.lookToward(self, this.investigate, 1.2); // first turn toward it
                return;
            }
            // Approach carefully: stop a few metres short and watch the spot (a still ghost there is
            // only found by its breathing, which the better bots hear further).
            if (left > INVESTIGATE_STOP) {
                const r = this.go(self, nav, this.investigate, true, false);
                this.lookToward(self, this.investigate, 1.2, this.lv.turn * 0.6);
                if (r >= 0) return;
            }
            this.investigateTick = -1;
        }

        // 4. A dropped bomb in sight: watch it. Otherwise hold the site, now and then moving to another spot.
        if (v.dropped && flat(v.dropped, pos) > 4) {
            this.go(self, nav, v.dropped, true);
            return;
        }
        const hold = this.nodePos(nav, this.holdNode, tmpB);
        if (flat(hold, pos) > 0.8 || Math.abs(hold[1] - pos[1]) > 1.2) {
            if (this.go(self, nav, hold, false) < 0) this.holdNode = -1;
            return;
        }
        this.hasGoal = false;
        this.lookToward(self, this.lookAt, 1.2, this.lv.turn * 0.4);
        if (this.tick > this.holdUntil) this.pickHold(world, nav, false);
    }

    private setInvestigate(x: number, y: number, z: number): void {
        this.investigate[0] = x; this.investigate[1] = y; this.investigate[2] = z;
        this.investigateTick = this.tick;
    }

    /** Which site this defender holds this round: the bots of the team split over the sites. */
    private planDefender(world: BotWorld, nav: NavGraph): void {
        if (this.planRound === this.view.round && this.holdNode >= 0) return;
        this.planRound = this.view.round;
        this.pickHold(world, nav, true);
    }

    private pickHold(world: BotWorld, nav: NavGraph, newRound: boolean): void {
        const sites = siteNodes(world.map, nav);
        if (sites.length === 0) { this.holdNode = nav.nearest(world.map.spawns.defenders[0].pos); return; }
        let index = 0;
        const bots: number[] = [];
        for (const [id, r] of this.view.roster) if (r.bot && r.team === 'defenders') bots.push(id);
        bots.sort((a, b) => a - b);
        index = Math.max(0, bots.indexOf(this.view.id));
        const site = (index + world.teamSite('defenders') + (newRound ? 0 : this.rng.int(2))) % sites.length;
        this.holdNode = this.pick(sites[site]);
        this.holdUntil = this.tick + 480 + this.rng.int(480);
        // Look toward where ghosts come from: a few nodes along the way to the ghost spawn.
        const ghostSpawn = nav.nearest(world.map.spawns.ghosts[0].pos);
        const way: number[] = [];
        if (this.holdNode >= 0 && nav.findPath(this.holdNode, ghostSpawn, way)) {
            this.nodePos(nav, way[Math.min(way.length - 1, 7)], this.lookAt);
        } else if (this.holdNode >= 0) this.nodePos(nav, this.holdNode, this.lookAt);
    }

    /** Aim at a ghost and fire with the level's reaction time, error and burst length. */
    private engage(self: BotSelf, c: Contact, d: number): void {
        if (this.targetId !== c.id) {
            this.targetId = c.id;
            this.targetSince = this.tick;
            this.errYaw = this.rng.signed() * this.lv.aimErr;
            this.errPitch = this.rng.signed() * this.lv.aimErr * 0.6;
            this.aimHead = this.rng.next() < this.lv.head;
        }
        this.errYaw *= this.lv.settle;
        this.errPitch *= this.lv.settle;
        const eye = this.eye(self, tmpA);
        const ty = c.pos[1] + this.aimPoint(c, this.aimHead);
        const dx = c.pos[0] - eye[0], dz = c.pos[2] - eye[2];
        const wantYaw = yawTo(0, 0, dx, dz);
        const wantPitch = Math.atan2(ty - eye[1], Math.hypot(dx, dz));
        this.turnTo(wantYaw + this.errYaw, wantPitch + this.errPitch);
        const off = Math.hypot(wrap(this.yaw - wantYaw), this.pitch - wantPitch);
        const tolerance = Math.atan2(0.28, Math.max(d, 0.5)) + 0.01;
        // Stand still to shoot (spread grows with speed); hard bots crouch at range.
        if (this.level === 'hard' && d > 10) this.cmd.crouch = true;
        const l = self.loadout;
        // Weapon: pistol when the rifle is empty in a fight, knife when both are, rifle back when it has rounds.
        const rifle = l.guns[SLOT_RIFLE], pistol = l.guns[SLOT_PISTOL];
        if (l.slot === SLOT_RIFLE && rifle.mag === 0 && pistol.mag > 0) { this.cmd.slot = SLOT_PISTOL + 1; return; }
        if (l.slot !== SLOT_KNIFE && rifle.mag === 0 && rifle.reserve === 0 && pistol.mag === 0 && pistol.reserve === 0) {
            this.cmd.slot = SLOT_KNIFE + 1;
        }
        if (l.slot === SLOT_KNIFE) {
            if (rifle.mag + rifle.reserve > 0) { this.cmd.slot = SLOT_RIFLE + 1; return; }
            // Out of everything: close in and stab.
            this.moveDir(dx, dz);
            this.cmd.fire = d < KNIFE_RANGE + 0.3;
            return;
        }
        const g = heldGun(l);
        if (!g) return;
        if (g.mag === 0) { this.cmd.reload = true; return; }
        this.cmd.aim = d > 15 && this.level !== 'easy';
        if (this.tick - this.targetSince < this.lv.react || off > tolerance) return;
        if (this.burstPause > 0) { this.burstPause--; return; }
        if (l.slot === SLOT_PISTOL) {
            this.cmd.fire = this.tick % 10 < 3;
        } else {
            this.cmd.fire = true;
            if (this.lastMag >= 0 && g.mag < this.lastMag) this.burstShots += this.lastMag - g.mag;
            const burst = d > 20 ? Math.max(2, this.lv.burst >> 1) : this.lv.burst;
            if (this.burstShots >= burst) { this.burstShots = 0; this.burstPause = 14 + this.rng.int(10); this.cmd.fire = false; }
        }
        this.lastMag = g.mag;
    }

    /** Out of a fight: reload a partly empty gun, go back to the rifle. True when the bot should stand still for it. */
    private weaponsIdle(self: BotSelf): boolean {
        const l = self.loadout;
        this.burstShots = 0;
        this.lastMag = -1;
        const rifle = l.guns[SLOT_RIFLE];
        if (l.slot !== SLOT_RIFLE && (rifle.mag > 0 || rifle.reserve > 0) && l.draw === 0) { this.cmd.slot = SLOT_RIFLE + 1; return false; }
        const g = heldGun(l);
        const def = WEAPONS[l.slot] ?? null;
        if (g && def && g.reload === 0 && g.reserve > 0 && g.mag < def.magSize * 0.5) this.cmd.reload = true;
        return false;
    }

    // -----------------------------------------------------------------------------------------
    // Ghosts
    // -----------------------------------------------------------------------------------------

    private ghost(self: BotSelf, world: BotWorld, nav: NavGraph): void {
        const v = this.view;
        const pos = self.state.pos;
        if (v.phase === 'freeze') return;
        if (this.planRound !== v.round || this.holdNode < 0) {
            this.planRound = v.round;
            const sites = siteNodes(world.map, nav);
            const site = sites.length ? world.teamSite('ghosts') % sites.length : 0;
            this.holdNode = sites.length ? this.pick(sites[site]) : -1;
            if (this.holdNode < 0) this.holdNode = nav.nearest(world.map.spawns.defenders[0].pos);
        }

        // Defenders are always known to ghosts. Find the nearest one and whether anyone is watching.
        let near: Contact | null = null, nearD = Infinity;
        let watched = false, seenD = Infinity;
        const checkWatch = (this.tick + this.view.id) % 6 === 0;
        for (const c of v.contacts.values()) {
            if (c.team === self.team || !c.alive || v.snaps - c.seen > 1) continue;
            const d = flat(c.pos, pos);
            if (d < nearD) { nearD = d; near = c; }
            if (checkWatch && d < 35) {
                tmpA[0] = c.pos[0]; tmpA[1] = c.pos[1] + (c.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT); tmpA[2] = c.pos[2];
                tmpB[0] = pos[0]; tmpB[1] = pos[1] + 1.0; tmpB[2] = pos[2];
                if (world.clearLine(tmpA, tmpB)) {
                    seenD = Math.min(seenD, d);
                    if (d < 22 && this.facing(c, pos) > Math.cos(50 * DEG)) watched = true;
                }
            }
        }
        if (checkWatch) {
            this.watchedTicks = watched ? this.watchedTicks + 6 : 0;
            this.inSightD = seenD;
        }
        this.danger.length = 0;
        this.dangerY.length = 0;
        for (const c of v.contacts.values()) {
            if (c.team !== self.team && c.alive && v.snaps - c.seen <= 1) { this.danger.push(c.pos[0], c.pos[2]); this.dangerY.push(c.pos[1]); }
        }
        this.replanEvery = nearD < 25 ? 40 : 0;

        // Late in the round there is no more time to wait: the bomb has to go down.
        const urgent = v.phase === 'live' && v.endsAt - v.snapTime < URGENT_MS;
        const objective = v.phase === 'live' && (self.carry.carrier || (v.dropped !== null && this.closestGhostBot(self, v.dropped, nav)));
        const facing = near ? this.facing(near, pos) : 0;
        const sameFloor = near !== null && Math.abs(near.pos[1] - pos[1]) < 1.5;
        // 1. All in: within reach, or close and not looked at, or already hit (fully visible): strike first
        //    (a hit from behind kills outright). Close and looked at: see 3, back off instead.
        if (near && sameFloor && (nearD < KNIFE_RANGE + 0.6 && this.canReach(self, world, near) || (!objective && nearD < ALL_IN_RANGE && facing < 0.3 && near.speed < 1.5) ||
            (!objective && self.health < 100 && nearD < BREATH_RANGE))) {
            this.mode = 'strike';
            // Straight at it when nothing is in the way, else around whatever is.
            tmpB[0] = near.pos[0]; tmpB[1] = near.pos[1]; tmpB[2] = near.pos[2];
            if (nearD > 2.5 || !this.canReach(self, world, near)) this.go(self, nav, tmpB, false, false);
            else this.moveDir(near.pos[0] - pos[0], near.pos[2] - pos[2]);
            this.lookToward(self, near.pos, near.crouched ? 0.7 : 1.1, this.lv.turn * 1.5);
            if (nearD < 1.0) { this.cmd.forward = 0; this.cmd.right = 0; }
            // The swing lands 0.2 s after it starts: start it a little early when closing in at a run.
            const reach = KNIFE_RANGE + 0.3 + Math.min(0.8, Math.hypot(self.state.vel[0], self.state.vel[2]) * 0.15);
            this.cmd.fire = nearD < reach && this.canReach(self, world, near);
            return;
        }
        // 2. A defender looking away (or busy defusing) within stalking range: get behind it and close in.
        const busy = v.planted !== null && near !== null && flat(near.pos, v.planted) < 2;
        if (!objective && near && nearD < this.lv.stalk && (facing < -0.1 || busy)) {
            this.mode = 'stalk';
            // Aim for a point behind its back, so the last steps come from behind.
            const s = Math.sin(near.yaw), co = Math.cos(near.yaw);
            tmpB[0] = near.pos[0] + s * 1.2; tmpB[1] = near.pos[1]; tmpB[2] = near.pos[2] + co * 1.2;
            this.go(self, nav, tmpB, true, false);
            this.cmd.crouch = nearD > KNIFE_RANGE + 0.4; // crouched steps carry about 3 m: quiet to the last step
            this.lookToward(self, near.pos, 1.1);
            return;
        }
        // 3. Inside its breathing range in front of it: back off out of it, quietly.
        if (!urgent && near && sameFloor && nearD < BREATH_RANGE + 0.5 && facing > 0.3) {
            this.mode = 'back off';
            this.moveDir(pos[0] - near.pos[0], pos[2] - near.pos[2]);
            this.cmd.crouch = true;
            this.lookToward(self, near.pos, 1.1);
            return;
        }
        // 3. Watched: stand still and stay invisible, up to the level's patience.
        if (!urgent && this.watchedTicks > 0 && this.frozenFor < this.lv.patience) {
            this.frozenFor++;
            this.mode = 'freeze';
            return;
        }
        if (this.watchedTicks === 0 && this.frozenFor > 0) this.frozenFor = Math.max(0, this.frozenFor - 2);

        // Carriers and assigned retrievers favor the objective over optional pursuits.
        // They still pause when watched and keep outside a facing defender’s breathing range.
        if (v.phase === 'live') {
            if (self.carry.carrier) {
                // Plant where no defender can see (planting makes a ghost visible for 3 s): inside the site,
                // out of every defender's line of sight, or anywhere in it once time runs short.
                const inside = insideSite(pos, world.map) && self.state.onGround;
                const exposed = this.inSightD < Infinity;
                if (inside && (!exposed || urgent || this.plantWait > PLANT_WAIT_MAX)) {
                    this.mode = 'plant';
                    this.cmd.use = true; // rooted by the server until planted
                    return;
                }
                if (inside || (this.holdNode >= 0 && nav.flatDist(this.holdNode, pos[0], pos[2]) < 12)) {
                    if (exposed) this.plantWait++;
                    if (this.tick >= this.spotCheckAt) {
                        this.spotCheckAt = this.tick + 60;
                        const hidden = this.hiddenSiteNode(self, world, nav);
                        if (hidden >= 0) this.holdNode = hidden;
                    }
                }
                this.mode = 'objective';
                this.goSite(self, nav, nearD);
                return;
            }
            if (v.dropped && objective) {
                this.mode = 'recover';
                this.sneak(this.go(self, nav, v.dropped, false), nearD);
                return;
            }
        }
        this.mode = 'objective';
        if (v.phase === 'live') {
            this.goSite(self, nav, nearD);
            return;
        }
        if (v.phase === 'planted' && v.planted) {
            // Guard the bomb from a few metres away, still (invisible).
            const d = flat(v.planted, pos);
            if (d > 9 || d < 4) {
                if (this.guardNode < 0 || this.guardRound !== v.round) {
                    const ring = nav.within(v.planted, 8, 2, []).filter(n => nav.flatDist(n, v.planted![0], v.planted![2]) > 5);
                    this.guardNode = this.pick(ring);
                    this.guardRound = v.round;
                }
                if (this.guardNode >= 0) {
                    const g = this.nodePos(nav, this.guardNode, tmpB);
                    if (flat(g, pos) > 0.6) { this.sneak(this.go(self, nav, g, true), nearD); return; }
                }
            }
            this.lookToward(self, v.planted, 1);
            return;
        }
        // Warmup: wander between the sites.
        const target = this.nodePos(nav, this.holdNode, tmpB);
        if (this.go(self, nav, target, false) < 0.8) this.holdNode = this.pick(siteNodes(world.map, nav)[this.rng.int(world.map.bombSites.length)] ?? []);
    }

    private guardNode = -1;
    private guardRound = -1;
    /** Distance to the nearest defender with a clear line to this ghost (updated every few ticks). */
    private inSightD = Infinity;

    /**
     * How fast to move: running (loud, most visible) only while no defender is near or in sight, walking
     * (quiet) closer in, crouching (quietest, nearly invisible) when one is close and in sight.
     */
    private sneak(remaining: number, nearD: number): void {
        if (remaining < 0) return;
        const seen = this.inSightD;
        this.cmd.walk = seen < 32 || nearD < 25;
        this.cmd.crouch = seen < 22 || nearD < 12;
    }

    private plantWait = 0;
    private spotCheckAt = 0;

    /** A node of the site the carrier is heading for that no known defender can see, or -1. */
    private hiddenSiteNode(self: BotSelf, world: BotWorld, nav: NavGraph): number {
        const sites = siteNodes(world.map, nav);
        const list = sites.length ? sites[world.teamSite('ghosts') % sites.length] : [];
        if (list.length === 0) return -1;
        const start = this.rng.int(list.length);
        const v = this.view;
        for (let k = 0; k < list.length; k++) {
            const n = list[(start + k) % list.length];
            tmpB[0] = nav.x[n]; tmpB[1] = nav.y[n] + 1.0; tmpB[2] = nav.z[n];
            let seen = false;
            for (const c of v.contacts.values()) {
                if (c.team === self.team || !c.alive || v.snaps - c.seen > 1) continue;
                tmpA[0] = c.pos[0]; tmpA[1] = c.pos[1] + EYE_HEIGHT; tmpA[2] = c.pos[2];
                if (Math.hypot(tmpA[0] - tmpB[0], tmpA[2] - tmpB[2]) < BREATH_RANGE || world.clearLine(tmpA, tmpB)) { seen = true; break; }
            }
            if (!seen) return n;
        }
        return -1;
    }

    /** Toward the chosen site. */
    private goSite(self: BotSelf, nav: NavGraph, nearD: number): void {
        const target = this.nodePos(nav, this.holdNode, tmpB);
        const r = this.go(self, nav, target, false);
        this.sneak(r, nearD);
        if (r >= 0 && r < 0.6) this.holdNode = -1; // arrived without the bomb: pick another spot next tick
        if (r < 0) this.holdNode = -1;
    }

    /** A clear line from the bot's eye to a contact's chest: a knife can reach it. */
    private canReach(self: BotSelf, world: BotWorld, c: Contact): boolean {
        this.eye(self, tmpA);
        tmpB[0] = c.pos[0]; tmpB[1] = c.pos[1] + 1.0; tmpB[2] = c.pos[2];
        return world.clearLine(tmpA, tmpB);
    }

    /** How directly a defender faces a point: 1 straight at it, -1 straight away. */
    private facing(c: Contact, p: Vec3): number {
        const dx = p[0] - c.pos[0], dz = p[2] - c.pos[2];
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) return 1;
        return (-Math.sin(c.yaw) * dx - Math.cos(c.yaw) * dz) / len;
    }

    // Routes depend only on the public graph and the dropped bomb's node. A search is reused
    // until the drop moves or a candidate steps onto a previously unseen node.
    private recoveryNav: NavGraph | null = null;
    private recoveryGoal = -1;
    private readonly recoveryDistances = new Map<number, number>();
    private readonly recoveryPath: number[] = [];

    private recoveryDistance(nav: NavGraph, from: Vec3, drop: Vec3): number {
        const start = nav.nearest(from);
        if (start < 0 || this.recoveryGoal < 0) return Infinity;
        if (start === this.recoveryGoal) return Math.hypot(from[0] - drop[0], from[1] - drop[1], from[2] - drop[2]);
        let length = this.recoveryDistances.get(start);
        if (length === undefined) {
            length = Infinity;
            if (nav.findPath(start, this.recoveryGoal, this.recoveryPath)) {
                let prev = start;
                length = 0;
                for (const n of this.recoveryPath) {
                    length += Math.hypot(nav.x[n] - nav.x[prev], nav.y[n] - nav.y[prev], nav.z[n] - nav.z[prev]);
                    prev = n;
                }
            }
            this.recoveryDistances.set(start, length);
        }
        return length;
    }

    /** Assign recovery by walkable route using only the team's most recent contacts. */
    private closestGhostBot(self: BotSelf, drop: Vec3, nav: NavGraph): boolean {
        const goal = nav.nearest(drop, 4, 1.2, 2);
        if (this.recoveryNav !== nav || this.recoveryGoal !== goal) {
            this.recoveryNav = nav;
            this.recoveryGoal = goal;
            this.recoveryDistances.clear();
        }
        const mine = this.recoveryDistance(nav, self.state.pos, drop);
        if (!Number.isFinite(mine)) return false;
        for (const c of this.view.contacts.values()) {
            if (c.id === self.id || c.team !== self.team || !c.alive || this.view.snaps - c.seen > 1) continue;
            if (!this.view.roster.get(c.id)?.bot) continue;
            const d = this.recoveryDistance(nav, c.pos, drop);
            if (d < mine || (d === mine && c.id < self.id)) return false;
        }
        return true;
    }

    // -----------------------------------------------------------------------------------------
    // Practice targets
    // -----------------------------------------------------------------------------------------

    private target(self: BotSelf): void {
        this.yaw = this.faceYaw;
        this.pitch = 0;
        if (this.role !== 'target-moving') return;
        // Strafe across the player's view, turning back after a while or when blocked.
        this.strafeTicks++;
        const speed = Math.hypot(self.state.vel[0], self.state.vel[2]);
        if (this.strafeTicks > 100 || (this.strafeTicks > 15 && speed < 0.3)) { this.strafe = -this.strafe; this.strafeTicks = 0; }
        this.cmd.right = this.strafe;
        this.cmd.walk = (this.tick >> 7) % 2 === 1; // alternates running and walking speed
    }
}

/** Names for bots: shown as "BOT <name>" so every list marks them. */
export const BOT_NAMES: readonly string[] = [
    'Alder', 'Birch', 'Cedar', 'Dune', 'Ember', 'Flint', 'Grove', 'Heron', 'Iris', 'Juniper',
    'Kestrel', 'Larch', 'Moss', 'Nettle', 'Onyx', 'Pike', 'Quill', 'Rook', 'Sorrel', 'Thorn'
];
