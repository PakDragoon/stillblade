import {
    BODY_DAMAGE, EYE_HEIGHT, EYE_HEIGHT_CROUCHED, FIRE_INTERVAL_TICKS, HEAD_DAMAGE, HEAD_ZONE, HULL_HALF_WIDTH,
    HULL_HEIGHT, HULL_HEIGHT_CROUCHED, MAX_HEALTH, MAX_REWIND_MS, RESPAWN_MS, SHOT_RANGE, TICK_DT, TICK_RATE
} from '../../shared/constants';
import { createPlayerState, stepPlayer } from '../../shared/movement';
import {
    PROTOCOL_VERSION, SNAPSHOT_RATE, type NetCmd, type PlayerSnap, type ServerMsg, type ShotEvent, type Team
} from '../../shared/protocol';
import { rayBox, rayWorld, viewDir } from '../../shared/raycast';
import type { MapData, PlayerState, Vec3 } from '../../shared/types';

export interface Connection {
    send(msg: ServerMsg): void;
}

const HISTORY = 64; // ticks of position history kept per player (just over 1 s)
/** Commands a client may bank; bounds how far a burst (or a speed hack) can advance in one go. */
const MAX_CMD_CREDITS = 12;
const PITCH_LIMIT = Math.PI / 2;
const SNAPSHOT_EVERY = Math.round(TICK_RATE / SNAPSHOT_RATE);

export class Player {
    state: PlayerState = createPlayerState([0, 0, 0]);
    yaw = 0;
    pitch = 0;
    health = MAX_HEALTH;
    alive = false;
    respawnAt = 0;
    lastSeq = -1;
    credits = MAX_CMD_CREDITS;
    nextFireSeq = 0;

    // Ring buffer of where this player was on recent ticks, for lag compensation.
    private readonly histTime = new Float64Array(HISTORY).fill(-Infinity);
    private readonly histPos = new Float64Array(HISTORY * 3);
    private readonly histCrouched = new Uint8Array(HISTORY);
    private histHead = 0;

    constructor(readonly id: number, readonly team: Team, readonly conn: Connection) {}

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

        stepPlayer(p.state, cmd, TICK_DT, this.map.boxes);
        p.yaw = cmd.yaw;
        p.pitch = cmd.pitch;

        if (cmd.fire === true && cmd.seq >= p.nextFireSeq) {
            p.nextFireSeq = cmd.seq + FIRE_INTERVAL_TICKS;
            this.fire(p, cmd);
        }
    }

    private fire(shooter: Player, cmd: NetCmd): void {
        const { eye, dir, feet, hmin, hmax } = this;
        eye[0] = shooter.state.pos[0];
        eye[1] = shooter.state.pos[1] + (shooter.state.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT);
        eye[2] = shooter.state.pos[2];
        viewDir(cmd.yaw, cmd.pitch, dir);

        // Lag compensation: test against where the shooter saw everyone, within a bounded window.
        const viewTime = clamp(cmd.viewTime, this.now - MAX_REWIND_MS, this.now);
        let dist = rayWorld(this.map.boxes, eye, dir, SHOT_RANGE);
        let victim: Player | undefined;
        let head = false;
        for (const other of this.players.values()) {
            if (other === shooter || !other.alive || other.team === shooter.team) continue;
            const height = other.rewind(viewTime, feet);
            hmin[0] = feet[0] - HULL_HALF_WIDTH; hmax[0] = feet[0] + HULL_HALF_WIDTH;
            hmin[1] = feet[1];                   hmax[1] = feet[1] + height;
            hmin[2] = feet[2] - HULL_HALF_WIDTH; hmax[2] = feet[2] + HULL_HALF_WIDTH;
            const t = rayBox(eye, dir, hmin, hmax);
            if (t < dist) {
                dist = t;
                victim = other;
                head = eye[1] + dir[1] * t >= hmax[1] - HEAD_ZONE;
            }
        }

        const event: ShotEvent = {
            type: 'shot', shooter: shooter.id,
            from: [eye[0], eye[1], eye[2]],
            to: [eye[0] + dir[0] * dist, eye[1] + dir[1] * dist, eye[2] + dir[2] * dist]
        };
        if (victim) {
            const damage = head ? HEAD_DAMAGE : BODY_DAMAGE;
            victim.health = Math.max(0, victim.health - damage);
            event.victim = victim.id;
            event.head = head;
            event.damage = damage;
            if (victim.health === 0) {
                victim.alive = false;
                victim.respawnAt = this.now + RESPAWN_MS;
                event.killed = true;
            }
        }
        for (const p of this.players.values()) p.conn.send(event);
    }

    /** Advances server time by one tick. `now` is ms since the match started. */
    tick(now: number): void {
        this.now = now;
        this.tickCount++;
        for (const p of this.players.values()) {
            if (p.credits < MAX_CMD_CREDITS) p.credits++;
            if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt) this.spawn(p);
            p.record(now);
        }
        if (this.tickCount % SNAPSHOT_EVERY === 0) this.sendSnapshots();
    }

    private sendSnapshots(): void {
        const all: PlayerSnap[] = [];
        for (const p of this.players.values()) {
            all.push({
                id: p.id, team: p.team, pos: p.state.pos, yaw: p.yaw, pitch: p.pitch,
                crouched: p.state.crouched, alive: p.alive
            });
        }
        // Milestone 3 hooks in here: ghosts a defender cannot see or hear must be left out.
        for (const p of this.players.values()) {
            p.conn.send({
                type: 'snap', time: this.now, ack: p.lastSeq,
                me: {
                    pos: p.state.pos, vel: p.state.vel, onGround: p.state.onGround, crouched: p.state.crouched,
                    health: p.health, alive: p.alive, respawnAt: p.respawnAt
                },
                players: all.filter(o => o.id !== p.id)
            });
        }
    }
}
