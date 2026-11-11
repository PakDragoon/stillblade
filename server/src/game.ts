import {
    BODY_DAMAGE, BREATH_RANGE, EYE_HEIGHT, EYE_HEIGHT_CROUCHED, FIRE_INTERVAL_TICKS, HEAD_DAMAGE, HEAD_ZONE,
    HULL_HALF_WIDTH, HULL_HEIGHT, HULL_HEIGHT_CROUCHED, KNIFE_BACKSTAB_DAMAGE, KNIFE_CONE_COS,
    KNIFE_COOLDOWN_TICKS, KNIFE_DAMAGE, KNIFE_RANGE, KNIFE_SOUND_RANGE, KNIFE_WINDUP_TICKS, MAX_HEALTH,
    MAX_REWIND_MS, RESPAWN_MS, SHOT_RANGE, STEP_DISTANCE, STEP_LOUD_CROUCH, STEP_LOUD_RUN, STEP_LOUD_WALK,
    STEP_RANGE, TICK_DT, TICK_RATE, VIS_HURT_SPIKE, VIS_SWING_SPIKE
} from '../../shared/constants';
import { createPlayerState, horizontalSpeed, stepPlayer } from '../../shared/movement';
import {
    PROTOCOL_VERSION, SNAPSHOT_RATE, type NetCmd, type PlayerSnap, type ServerMsg, type ShotEvent,
    type SlashEvent, type SoundEvent, type Team
} from '../../shared/protocol';
import { rayBox, rayWorld, viewDir } from '../../shared/raycast';
import type { MapData, PlayerState, Vec3 } from '../../shared/types';
import { ghostVisTarget, stepVis } from '../../shared/visibility';

export interface Connection {
    send(msg: ServerMsg): void;
}

const HISTORY = 64; // ticks of position history kept per player (just over 1 s)
/** Commands a client may bank; bounds how far a burst (or a speed hack) can advance in one go. */
const MAX_CMD_CREDITS = 12;
const PITCH_LIMIT = Math.PI / 2;
const SNAPSHOT_EVERY = Math.round(TICK_RATE / SNAPSHOT_RATE);
/** Below this a ghost is not drawn at all, so its position is not sent on sight alone. */
const VIS_SEND_THRESHOLD = 0.01;

export class Player {
    state: PlayerState = createPlayerState([0, 0, 0]);
    yaw = 0;
    pitch = 0;
    health = MAX_HEALTH;
    alive = false;
    respawnAt = 0;
    lastSeq = -1;
    credits = MAX_CMD_CREDITS;
    /** Earliest command that may start the next attack (shot or knife swing). */
    nextFireSeq = 0;
    /** Command at which a knife swing in progress lands; -1 when none. */
    slashAtSeq = -1;
    /** 0..1 opacity: always 1 for defenders. */
    vis: number;
    /** Ground distance covered since the last footstep. */
    stepAccum = 0;

    // Ring buffer of where this player was on recent ticks, for lag compensation.
    private readonly histTime = new Float64Array(HISTORY).fill(-Infinity);
    private readonly histPos = new Float64Array(HISTORY * 3);
    private readonly histCrouched = new Uint8Array(HISTORY);
    private histHead = 0;

    constructor(readonly id: number, readonly team: Team, readonly conn: Connection) {
        this.vis = team === 'ghosts' ? 0 : 1;
    }

    get height(): number {
        return this.state.crouched ? HULL_HEIGHT_CROUCHED : HULL_HEIGHT;
    }

    get eyeY(): number {
        return this.state.pos[1] + (this.state.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT);
    }

    record(time: number): void {
        const i = this.histHead = (this.histHead + 1) % HISTORY;
        this.histTime[i] = time;
        this.histPos.set(this.state.pos, i * 3);
        this.histCrouched[i] = this.state.crouched ? 1 : 0;
    }

    /** Writes the feet position at `time` into `out` and returns the hull height then. */
    rewind(time: number, out: Vec3): number {
        let newer = this.histHead;
        for (let n = 1; n < HISTORY; n++) {
            const older = (this.histHead - n + HISTORY) % HISTORY;
            if (this.histTime[newer] <= time || this.histTime[older] === -Infinity) break;
            if (this.histTime[older] <= time) {
                const span = this.histTime[newer] - this.histTime[older];
                const a = span > 0 ? (time - this.histTime[older]) / span : 0;
                for (let k = 0; k < 3; k++) {
                    const o = this.histPos[older * 3 + k];
                    out[k] = o + (this.histPos[newer * 3 + k] - o) * a;
                }
                return this.histCrouched[a < 0.5 ? older : newer] ? HULL_HEIGHT_CROUCHED : HULL_HEIGHT;
            }
            newer = older;
        }
        for (let k = 0; k < 3; k++) out[k] = this.histPos[newer * 3 + k];
        return this.histCrouched[newer] ? HULL_HEIGHT_CROUCHED : HULL_HEIGHT;
    }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The authoritative match. Knows nothing about sockets: the transport hands it commands and a
 * `Connection` to send through, which keeps it unit-testable and transport-agnostic.
 */
export class Game {
    readonly players = new Map<number, Player>();
    /** Server time in ms, advanced only by `tick`. */
    now = 0;
    private tickCount = 0;
    private nextId = 1;
    private readonly spawnCursor: Record<Team, number> = { ghosts: 0, defenders: 0 };

    // Scratch vectors: no allocation on the hot path.
    private readonly eye: Vec3 = [0, 0, 0];
    private readonly dir: Vec3 = [0, 0, 0];
    private readonly feet: Vec3 = [0, 0, 0];
    private readonly hmin: Vec3 = [0, 0, 0];
    private readonly hmax: Vec3 = [0, 0, 0];
    private readonly target: Vec3 = [0, 0, 0];

    constructor(readonly map: MapData) {}

    join(conn: Connection): number {
        let ghosts = 0;
        for (const p of this.players.values()) if (p.team === 'ghosts') ghosts++;
        const team: Team = ghosts <= this.players.size - ghosts ? 'ghosts' : 'defenders';
        const player = new Player(this.nextId++, team, conn);
        this.players.set(player.id, player);
        conn.send({ type: 'welcome', version: PROTOCOL_VERSION, id: player.id, team, map: this.map.name, time: this.now });
        this.spawn(player);
        return player.id;
    }

    leave(id: number): void {
        this.players.delete(id);
    }

    private spawn(p: Player): void {
        const spawns = this.map.spawns[p.team];
        const spawn = spawns[this.spawnCursor[p.team]++ % spawns.length];
        p.state = createPlayerState(spawn.pos);
        p.yaw = (spawn.yaw * Math.PI) / 180;
        p.pitch = 0;
        p.health = MAX_HEALTH;
        p.alive = true;
        p.slashAtSeq = -1;
        p.stepAccum = 0;
        p.vis = p.team === 'ghosts' ? 0 : 1;
        p.conn.send({ type: 'spawn', pos: spawn.pos, yaw: p.yaw });
    }

    /** Simulates one client command. Called as commands arrive, so each client drives its own clock. */
    handleCmd(id: number, cmd: NetCmd): void {
        const p = this.players.get(id);
        if (!p) return;
        if (!finite(cmd.seq) || cmd.seq <= p.lastSeq) return;
        if (!finite(cmd.forward) || !finite(cmd.right) || !finite(cmd.yaw) || !finite(cmd.pitch) || !finite(cmd.viewTime)) return;
        // No credit means the client is sending faster than real time; drop it unacknowledged
        // and the next snapshot pulls the client back.
        if (p.credits <= 0) return;
        p.credits--;
        p.lastSeq = cmd.seq;
        if (!p.alive) return;

        cmd.forward = clamp(cmd.forward, -1, 1);
        cmd.right = clamp(cmd.right, -1, 1);
        cmd.pitch = clamp(cmd.pitch, -PITCH_LIMIT, PITCH_LIMIT);
        cmd.jump = cmd.jump === true;
        cmd.walk = cmd.walk === true;
        cmd.crouch = cmd.crouch === true;

        const px = p.state.pos[0], pz = p.state.pos[2];
        stepPlayer(p.state, cmd, TICK_DT, this.map.boxes);
        p.yaw = cmd.yaw;
        p.pitch = cmd.pitch;

        if (p.state.onGround) {
            p.stepAccum += Math.hypot(p.state.pos[0] - px, p.state.pos[2] - pz);
            if (p.stepAccum >= STEP_DISTANCE) {
                p.stepAccum -= STEP_DISTANCE;
                const loud = p.state.crouched ? STEP_LOUD_CROUCH : cmd.walk ? STEP_LOUD_WALK : STEP_LOUD_RUN;
                this.emitSound(p, 'step', loud, STEP_RANGE * loud);
            }
        }

        if (p.team === 'defenders') {
            if (cmd.fire === true && cmd.seq >= p.nextFireSeq) {
                p.nextFireSeq = cmd.seq + FIRE_INTERVAL_TICKS;
                this.fire(p, cmd);
            }
        } else if (p.slashAtSeq >= 0) {
            if (cmd.seq >= p.slashAtSeq) {
                p.slashAtSeq = -1;
                this.slash(p, cmd);
            }
        } else if (cmd.fire === true && cmd.seq >= p.nextFireSeq) {
            // A swing is committed at the windup: it gives the ghost away by sight and by sound
            // before it can land.
            p.nextFireSeq = cmd.seq + KNIFE_COOLDOWN_TICKS;
            p.slashAtSeq = cmd.seq + KNIFE_WINDUP_TICKS;
            p.vis = Math.max(p.vis, VIS_SWING_SPIKE);
            this.emitSound(p, 'windup', 1, KNIFE_SOUND_RANGE);
        }
    }

    /** Sends a sound only to players close enough to hear it. */
    private emitSound(source: Player, kind: SoundEvent['kind'], loud: number, range: number): void {
        let event: SoundEvent | undefined;
        for (const p of this.players.values()) {
            if (p === source || dist(p.state.pos, source.state.pos) > range) continue;
            event ??= { type: 'sound', kind, id: source.id, pos: [...source.state.pos] as Vec3, loud };
            p.conn.send(event);
        }
    }

    private damage(victim: Player, amount: number): boolean {
        victim.health = Math.max(0, victim.health - amount);
        if (victim.team === 'ghosts') victim.vis = Math.max(victim.vis, VIS_HURT_SPIKE);
        if (victim.health > 0) return false;
        victim.alive = false;
        victim.respawnAt = this.now + RESPAWN_MS;
        victim.slashAtSeq = -1;
        return true;
    }

    private aimFrom(p: Player, cmd: NetCmd): void {
        this.eye[0] = p.state.pos[0];
        this.eye[1] = p.eyeY;
        this.eye[2] = p.state.pos[2];
        viewDir(cmd.yaw, cmd.pitch, this.dir);
    }

    /** Places `hmin`/`hmax` around where `other` stood at `time` (lag compensation). */
    private rewoundHull(other: Player, time: number): void {
        const { feet, hmin, hmax } = this;
        const height = other.rewind(time, feet);
        hmin[0] = feet[0] - HULL_HALF_WIDTH; hmax[0] = feet[0] + HULL_HALF_WIDTH;
        hmin[1] = feet[1];                   hmax[1] = feet[1] + height;
        hmin[2] = feet[2] - HULL_HALF_WIDTH; hmax[2] = feet[2] + HULL_HALF_WIDTH;
    }

    private fire(shooter: Player, cmd: NetCmd): void {
        const { eye, dir, hmin, hmax } = this;
        this.aimFrom(shooter, cmd);
        // Test against where the shooter saw everyone, within a bounded window.
        const viewTime = clamp(cmd.viewTime, this.now - MAX_REWIND_MS, this.now);
        let range = rayWorld(this.map.boxes, eye, dir, SHOT_RANGE);
        let victim: Player | undefined;
        let head = false;
        for (const other of this.players.values()) {
            if (other === shooter || !other.alive || other.team === shooter.team) continue;
            this.rewoundHull(other, viewTime);
            const t = rayBox(eye, dir, hmin, hmax);
            if (t < range) {
                range = t;
                victim = other;
                head = eye[1] + dir[1] * t >= hmax[1] - HEAD_ZONE;
            }
        }

        const event: ShotEvent = {
            type: 'shot', shooter: shooter.id,
            from: [eye[0], eye[1], eye[2]],
            to: [eye[0] + dir[0] * range, eye[1] + dir[1] * range, eye[2] + dir[2] * range]
        };
        if (victim) {
            const amount = head ? HEAD_DAMAGE : BODY_DAMAGE;
            event.victim = victim.id;
            event.head = head;
            event.damage = amount;
            if (this.damage(victim, amount)) event.killed = true;
        }
        for (const p of this.players.values()) p.conn.send(event);
    }

    /** Resolves a knife swing: the nearest enemy inside the reach and cone, not behind a wall. */
    private slash(attacker: Player, cmd: NetCmd): void {
        const { eye, dir, hmin, hmax, target } = this;
        this.aimFrom(attacker, cmd);
        const viewTime = clamp(cmd.viewTime, this.now - MAX_REWIND_MS, this.now);
        let best = KNIFE_RANGE;
        let victim: Player | undefined;
        for (const other of this.players.values()) {
            if (other === attacker || !other.alive || other.team === attacker.team) continue;
            this.rewoundHull(other, viewTime);
            // Nearest point of the victim's hull to the knife hand.
            for (let k = 0; k < 3; k++) target[k] = clamp(eye[k], hmin[k], hmax[k]) - eye[k];
            const d = Math.hypot(target[0], target[1], target[2]);
            if (d >= best) continue;
            if (d > 1e-6) {
                const facing = (target[0] * dir[0] + target[1] * dir[1] + target[2] * dir[2]) / d;
                if (facing < KNIFE_CONE_COS) continue;
                for (let k = 0; k < 3; k++) target[k] /= d;
                if (rayWorld(this.map.boxes, eye, target, d) < d - 1e-3) continue;
            }
            best = d;
            victim = other;
        }

        const event: SlashEvent = { type: 'slash', attacker: attacker.id, pos: [...attacker.state.pos] as Vec3 };
        if (victim) {
            // From behind: attacker and victim are facing roughly the same way.
            const backstab = Math.cos(cmd.yaw - victim.yaw) > 0.5;
            const amount = backstab ? KNIFE_BACKSTAB_DAMAGE : KNIFE_DAMAGE;
            event.victim = victim.id;
            event.damage = amount;
            event.backstab = backstab;
            if (this.damage(victim, amount)) event.killed = true;
        }
        for (const p of this.players.values()) {
            if (p === attacker || p === victim || dist(p.state.pos, attacker.state.pos) <= KNIFE_SOUND_RANGE) p.conn.send(event);
        }
    }

    /** Advances server time by one tick. `now` is ms since the match started. */
    tick(now: number): void {
        this.now = now;
        this.tickCount++;
        for (const p of this.players.values()) {
            if (p.credits < MAX_CMD_CREDITS) p.credits++;
            if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt) this.spawn(p);
            if (p.team === 'ghosts') {
                p.vis = p.alive ? stepVis(p.vis, ghostVisTarget(horizontalSpeed(p.state)), TICK_DT) : 0;
            }
            p.record(now);
        }
        if (this.tickCount % SNAPSHOT_EVERY === 0) this.sendSnapshots();
    }

    /** True if nothing solid lies between two points. */
    private lineClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
        const { eye, target } = this;
        const d = Math.hypot(bx - ax, by - ay, bz - az);
        if (d < 1e-6) return true;
        eye[0] = ax; eye[1] = ay; eye[2] = az;
        target[0] = (bx - ax) / d; target[1] = (by - ay) / d; target[2] = (bz - az) / d;
        return rayWorld(this.map.boxes, eye, target, d) >= d - 1e-3;
    }

    /**
     * Whether `viewer` is told where `other` is. This is the anti-wallhack rule: a client that is
     * never sent an unseen, unheard ghost's position cannot reveal it, however it is modified.
     */
    private knowsAbout(viewer: Player, other: Player): boolean {
        if (other.team === viewer.team || other.team === 'defenders') return true;
        if (!other.alive) return false;
        const a = viewer.state.pos, b = other.state.pos;
        if (dist(a, b) <= BREATH_RANGE) return true; // close enough to hear breathing
        if (other.vis < VIS_SEND_THRESHOLD) return false;
        return this.lineClear(a[0], viewer.eyeY, a[2], b[0], b[1] + other.height - 0.1, b[2]) ||
            this.lineClear(a[0], viewer.eyeY, a[2], b[0], b[1] + other.height * 0.5, b[2]);
    }

    private sendSnapshots(): void {
        const snaps = new Map<Player, PlayerSnap>();
        for (const p of this.players.values()) {
            snaps.set(p, {
                id: p.id, team: p.team, pos: p.state.pos, yaw: p.yaw, pitch: p.pitch,
                crouched: p.state.crouched, alive: p.alive, vis: p.vis
            });
        }
        for (const p of this.players.values()) {
            const players: PlayerSnap[] = [];
            for (const [other, snap] of snaps) if (other !== p && this.knowsAbout(p, other)) players.push(snap);
            p.conn.send({
                type: 'snap', time: this.now, ack: p.lastSeq,
                me: {
                    pos: p.state.pos, vel: p.state.vel, onGround: p.state.onGround, crouched: p.state.crouched,
                    health: p.health, alive: p.alive, respawnAt: p.respawnAt, vis: p.vis
                },
                players
            });
        }
    }
}
