import {
    BODY_DAMAGE, BREATH_RANGE, EYE_HEIGHT, EYE_HEIGHT_CROUCHED, HEAD_DAMAGE, HEAD_ZONE,
    HULL_HALF_WIDTH, HULL_HEIGHT, HULL_HEIGHT_CROUCHED, KNIFE_BACKSTAB_DAMAGE, KNIFE_CONE_COS,
    KNIFE_DAMAGE, KNIFE_RANGE, KNIFE_SOUND_RANGE, MAX_HEALTH,
    MAX_REWIND_MS, RELOAD_SOUND_RANGE, RESPAWN_MS, SHOT_RANGE, STEP_DISTANCE, STEP_LOUD_CROUCH, STEP_LOUD_RUN, STEP_LOUD_WALK,
    STEP_RANGE, TICK_DT, TICK_RATE, VIS_HURT_SPIKE, VIS_SWING_SPIKE
} from '../../shared/constants';
import { GUN_RELOAD, createGunState, resetGun, shotDirection, spreadAngle, spreadSeed, stepGun } from '../../shared/gun';
import { KNIFE_SLASH, KNIFE_SWING, createKnifeState, resetKnife, stepKnife } from '../../shared/knife';
import { createPlayerState, horizontalSpeed, stepPlayer } from '../../shared/movement';
import {
    PROTOCOL_VERSION, SNAPSHOT_RATE, type ClientMsg, type DamageKind, type MatchStats, type NetCmd, type PlayerSnap,
    type RosterEntry, type RoundMsg, type ServerMsg, type ShotEvent, type SlashEvent, type SoundEvent, type SummaryMsg,
    type Team
} from '../../shared/protocol';
import {
    BOMB_MS, DEFUSE_TICKS, FREEZE_MS, HALFTIME_ROUND, IDLE_MS, MATCH_OVER_MS, OVER_MS, PLANT_TICKS, ROUNDS_TO_WIN, ROUND_MS,
    canAct, movementLocked, type Phase, type RoundReason
} from '../../shared/rules';
import { cleanChat } from '../../shared/chat';
import { ASSIST_MS, emptyStats, pickMvp } from '../../shared/stats';
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
/** Chat: this many lines may be sent at once, refilled one per CHAT_REFILL_MS. */
const CHAT_BURST = 4;
const CHAT_REFILL_MS = 1500;
/** Teams may differ by at most this many players after a warmup team switch. */
const MAX_TEAM_GAP = 1;

export class Player {
    state: PlayerState = createPlayerState([0, 0, 0]);
    yaw = 0;
    pitch = 0;
    health = MAX_HEALTH;
    alive = false;
    respawnAt = 0;
    lastSeq = -1;
    credits = MAX_CMD_CREDITS;
    /** The defender gun (shared/gun.ts); reset at every spawn. */
    readonly gun = createGunState();
    /** Ghost knife timing, counted in commands processed for this player (shared/knife.ts). */
    readonly knife = createKnifeState();
    /** 0..1 opacity: always 1 for defenders. */
    vis: number;
    /** Ground distance covered since the last footstep. */
    stepAccum = 0;
    /** Consecutive commands spent planting or defusing. */
    actionTicks = 0;
    /** Match statistics (shared/stats.ts); reset when a new match starts. */
    stats: MatchStats = emptyStats();
    /** Server time this player joined: the longest-connected player inherits the creator role. */
    joinedAt = 0;
    ready = false;
    /** Moved to spectate-only after IDLE_MS without an input change; cleared by the next input change. */
    idle = false;
    /** Server time of the last input change (movement, view, buttons), for idle handling. */
    lastInputAt = 0;
    private readonly lastInput = [0, 0, 0, 0];
    private lastButtons = 0;
    /** Chat rate limit: allowance left and when it was last topped up. */
    chatTokens = CHAT_BURST;
    chatTokensAt = 0;
    /** Who damaged this player recently (attacker id to server time), for assists. */
    readonly hurtBy = new Map<number, number>();

    // Ring buffer of where this player was on recent ticks, for lag compensation.
    private readonly histTime = new Float64Array(HISTORY).fill(-Infinity);
    private readonly histPos = new Float64Array(HISTORY * 3);
    private readonly histCrouched = new Uint8Array(HISTORY);
    private histHead = 0;

    /**
     * `group` is the fixed side a player joined (0 or 1); `team` is the role that side is playing,
     * which flips at halftime.
     */
    constructor(
        readonly id: number, public group: 0 | 1, public team: Team, readonly name: string, readonly conn: Connection
    ) {
        this.vis = team === 'ghosts' ? 0 : 1;
    }

    get height(): number {
        return this.state.crouched ? HULL_HEIGHT_CROUCHED : HULL_HEIGHT;
    }

    get eyeY(): number {
        return this.state.pos[1] + (this.state.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT);
    }

    /** Whether this command changes any input compared with the previous one (seq and view time excluded). */
    inputChanged(c: NetCmd): boolean {
        const b = (c.jump ? 1 : 0) | (c.walk ? 2 : 0) | (c.crouch ? 4 : 0) | (c.fire ? 8 : 0) | (c.use ? 16 : 0) | (c.reload ? 32 : 0);
        const l = this.lastInput;
        const changed = l[0] !== c.forward || l[1] !== c.right || l[2] !== c.yaw || l[3] !== c.pitch || this.lastButtons !== b;
        l[0] = c.forward; l[1] = c.right; l[2] = c.yaw; l[3] = c.pitch;
        this.lastButtons = b;
        return changed;
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

    phase: Phase = 'warmup';
    /** Server time the current phase ends; 0 in warmup. */
    phaseEndsAt = 0;
    /** Rounds won by each group (side), indexed by Player.group. */
    readonly score: [number, number] = [0, 0];
    /** Which group is currently playing ghosts. */
    ghostGroup: 0 | 1 = 0;
    roundsPlayed = 0;
    bomb: Vec3 | null = null;
    private winner: Team | undefined;
    private reason: RoundReason | undefined;
    private matchOver = false;
    private readonly rounds: boolean;
    /** Lobby mode (rooms): the match starts when everyone is ready or the creator starts it. */
    private readonly lobby: boolean;
    private startRequested = false;
    /** The final result, kept for players who join during the result screen. */
    private summary: SummaryMsg | null = null;

    // Scratch vectors: no allocation on the hot path.
    private readonly eye: Vec3 = [0, 0, 0];
    private readonly dir: Vec3 = [0, 0, 0];
    private readonly feet: Vec3 = [0, 0, 0];
    private readonly hmin: Vec3 = [0, 0, 0];
    private readonly hmax: Vec3 = [0, 0, 0];
    private readonly target: Vec3 = [0, 0, 0];

    /** `rounds: false` keeps the match in warmup (free roam with respawns), for tests of the core mechanics. */
    constructor(readonly map: MapData, opts: { rounds?: boolean; lobby?: boolean } = {}) {
        this.rounds = opts.rounds ?? true;
        this.lobby = opts.lobby ?? false;
    }

    private teamOf(group: 0 | 1): Team {
        return group === this.ghostGroup ? 'ghosts' : 'defenders';
    }

    private broadcast(msg: ServerMsg): void {
        for (const p of this.players.values()) p.conn.send(msg);
    }

    private roundMsg(): RoundMsg {
        const msg: RoundMsg = {
            type: 'round', phase: this.phase, endsAt: this.phaseEndsAt, round: this.roundsPlayed + (this.phase === 'over' ? 0 : 1),
            score: { ghosts: this.score[this.ghostGroup], defenders: this.score[1 - this.ghostGroup] },
            bomb: this.bomb
        };
        if (this.phase === 'over') {
            msg.winner = this.winner;
            msg.reason = this.reason;
            if (this.matchOver) msg.matchOver = true;
        }
        return msg;
    }

    /** The room creator: the longest-connected player. */
    get creatorId(): number {
        let best: Player | undefined;
        for (const p of this.players.values()) {
            if (!best || p.joinedAt < best.joinedAt || (p.joinedAt === best.joinedAt && p.id < best.id)) best = p;
        }
        return best?.id ?? 0;
    }

    private rosterEntries(): RosterEntry[] {
        const creator = this.creatorId;
        const players: RosterEntry[] = [];
        for (const p of this.players.values()) {
            players.push({
                id: p.id, name: p.name, team: p.team, alive: p.alive, ...p.stats,
                ready: p.ready, creator: p.id === creator, idle: p.idle
            });
        }
        return players;
    }

    private sendRoster(): void {
        this.broadcast({ type: 'roster', players: this.rosterEntries() });
    }

    private teamCounts(): Record<Team, number> {
        const n = { ghosts: 0, defenders: 0 };
        for (const p of this.players.values()) n[p.team]++;
        return n;
    }

    join(conn: Connection, name = ''): number {
        let ghosts = 0;
        for (const p of this.players.values()) if (p.team === 'ghosts') ghosts++;
        const team: Team = ghosts <= this.players.size - ghosts ? 'ghosts' : 'defenders';
        const group = team === 'ghosts' ? this.ghostGroup : ((1 - this.ghostGroup) as 0 | 1);
        const id = this.nextId++;
        const clean = name.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
        const player = new Player(id, group, team, clean || `Player ${id}`, conn);
        player.joinedAt = player.lastInputAt = player.chatTokensAt = this.now;
        this.players.set(id, player);
        conn.send({
            type: 'welcome', version: PROTOCOL_VERSION, id, team, map: this.map.name,
            mapName: this.map.displayName ?? this.map.name, time: this.now
        });
        conn.send(this.roundMsg());
        if (this.summary && this.phase === 'over') conn.send(this.summary); // joined during the result screen
        // Mid-round arrivals wait for the next round rather than appearing behind someone.
        if (this.phase === 'warmup') this.spawn(player);
        this.sendRoster();
        return id;
    }

    leave(id: number): void {
        // The creator role passes to the longest-connected player by itself (see `creatorId`).
        if (this.players.delete(id)) this.sendRoster();
    }

    // -----------------------------------------------------------------------------------------
    // Match flow: lobby, chat, statistics, idle handling. JSON messages only; nothing here is
    // predicted by the client and nothing here may reveal where an enemy is (see `knowsAbout`).
    // -----------------------------------------------------------------------------------------

    /** A JSON message from a client (everything but the binary movement command). */
    handleMessage(id: number, msg: ClientMsg): void {
        const p = this.players.get(id);
        if (!p) return;
        switch (msg.type) {
            case 'cmd': this.handleCmd(id, msg.cmd); break;
            case 'ready':
                if (this.phase !== 'warmup' || p.ready === msg.ready) break;
                p.ready = msg.ready;
                this.sendRoster();
                break;
            case 'start': this.requestStart(p); break;
            case 'team': this.switchTeam(p); break;
            case 'chat': this.chat(p, msg.team, msg.text); break;
        }
    }

    private notice(p: Player, text: string): void {
        p.conn.send({ type: 'notice', text });
    }

    private everyoneReady(): boolean {
        if (this.players.size === 0) return false;
        for (const p of this.players.values()) if (!p.ready) return false;
        return true;
    }

    /** The creator starts the match early, once each team has a player. */
    private requestStart(p: Player): void {
        if (this.phase !== 'warmup') return;
        if (p.id !== this.creatorId) { this.notice(p, 'Only the room creator can start the match.'); return; }
        const n = this.teamCounts();
        if (n.ghosts === 0 || n.defenders === 0) { this.notice(p, 'Each team needs at least one player.'); return; }
        this.startRequested = true;
    }

    /** Warmup only, and only if the teams then differ by at most MAX_TEAM_GAP players. */
    private switchTeam(p: Player): void {
        if (this.phase !== 'warmup') { this.notice(p, 'Teams can only be changed in warmup.'); return; }
        const n = this.teamCounts();
        const to: Team = p.team === 'ghosts' ? 'defenders' : 'ghosts';
        if (Math.abs((n[to] + 1) - (n[p.team] - 1)) > MAX_TEAM_GAP) { this.notice(p, 'That would make the teams uneven.'); return; }
        p.group = (1 - p.group) as 0 | 1;
        p.team = this.teamOf(p.group);
        this.spawn(p);
        this.sendRoster();
    }

    /**
     * All-chat or team chat. Dead players' lines (while a round is on) reach only dead players, so
     * the dead cannot call out positions; team chat never leaves the team.
     */
    private chat(p: Player, teamOnly: boolean, raw: string): void {
        const text = cleanChat(raw);
        if (!text) return;
        p.chatTokens = Math.min(CHAT_BURST, p.chatTokens + (this.now - p.chatTokensAt) / CHAT_REFILL_MS);
        p.chatTokensAt = this.now;
        if (p.chatTokens < 1) { this.notice(p, 'You are sending messages too fast.'); return; }
        p.chatTokens--;
        const roundOn = this.phase === 'freeze' || this.phase === 'live' || this.phase === 'planted';
        const dead = roundOn && !p.alive;
        const msg: ServerMsg = { type: 'chat', from: p.id, name: p.name, team: teamOnly, dead, text };
        for (const r of this.players.values()) {
            if (teamOnly && r.team !== p.team) continue;
            if (dead && r.alive) continue;
            r.conn.send(msg);
        }
    }

    /** Any change of input (not the command number or clock) counts as being present. */
    private trackInput(p: Player, cmd: NetCmd): void {
        if (!p.inputChanged(cmd)) return;
        p.lastInputAt = this.now;
        if (p.idle) {
            p.idle = false;
            this.notice(p, 'Welcome back: you play again from the next round.');
            this.sendRoster();
        }
    }

    private checkIdle(p: Player): void {
        const roundLive = this.phase === 'live' || this.phase === 'planted';
        if (!roundLive) { p.lastInputAt = this.now; return; }
        if (!p.alive || p.idle || this.now - p.lastInputAt < IDLE_MS) return;
        p.idle = true;
        p.alive = false;
        p.health = 0;
        p.respawnAt = 0;
        resetKnife(p.knife);
        p.gun.reload = 0;
        p.actionTicks = 0;
        this.notice(p, 'No input for 90 s: you are spectating. Any input returns you next round.');
        this.sendRoster();
    }

    /** Bearing (yaw convention) from `from` toward `to`, on the ground plane. */
    private bearing(from: Vec3, to: Vec3): number {
        return Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
    }

    /** Stats for one landed hit, and the hit messages to both sides. */
    private recordHit(victim: Player, attacker: Player, dealt: number, kind: DamageKind): void {
        attacker.stats.damage += dealt;
        if (kind === 'headshot') attacker.stats.headshots++;
        else if (kind === 'backstab') attacker.stats.backstabs++;
        victim.hurtBy.set(attacker.id, this.now);
        const killed = victim.health <= 0;
        // The victim learns the direction of the hit and how much it hurt: nothing else. A kill adds
        // who and how far (a knife kill is within reach, so already inside breathing range).
        const dmg: ServerMsg = { type: 'dmg', dir: this.bearing(victim.state.pos, attacker.state.pos), amount: dealt, kind };
        if (killed) {
            dmg.killed = true;
            dmg.by = attacker.id;
            dmg.dist = Math.round(dist(victim.state.pos, attacker.state.pos) * 10) / 10;
        }
        victim.conn.send(dmg);
        attacker.conn.send({ type: 'hitconfirm', kind: killed ? 'kill' : kind === 'headshot' ? 'head' : 'body' });
    }

    private recordKill(victim: Player, attacker: Player, kind: DamageKind): void {
        void kind;
        victim.stats.deaths++;
        attacker.stats.kills++;
        for (const [id, at] of victim.hurtBy) {
            if (id !== attacker.id && this.now - at <= ASSIST_MS) {
                const helper = this.players.get(id);
                if (helper) helper.stats.assists++;
            }
        }
        victim.hurtBy.clear();
    }

    private spawn(p: Player): void {
        const spawns = this.map.spawns[p.team];
        const spawn = spawns[this.spawnCursor[p.team]++ % spawns.length];
        p.state = createPlayerState(spawn.pos);
        p.yaw = (spawn.yaw * Math.PI) / 180;
        p.pitch = 0;
        p.health = MAX_HEALTH;
        p.alive = true;
        resetKnife(p.knife);
        resetGun(p.gun);
        p.stepAccum = 0;
        p.actionTicks = 0;
        p.respawnAt = 0;
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
        this.trackInput(p, cmd);
        if (!p.alive) return;

        cmd.forward = clamp(cmd.forward, -1, 1);
        cmd.right = clamp(cmd.right, -1, 1);
        cmd.pitch = clamp(cmd.pitch, -PITCH_LIMIT, PITCH_LIMIT);
        cmd.jump = cmd.jump === true;
        cmd.walk = cmd.walk === true;
        cmd.crouch = cmd.crouch === true;
        cmd.use = cmd.use === true;
        cmd.fire = cmd.fire === true;
        cmd.reload = cmd.reload === true;

        // Rooted during the freeze and while planting or defusing. The client applies the same rule.
        const acting = cmd.use && canAct(p.team, this.phase, p.state, this.map, this.bomb);
        if (movementLocked(cmd.use, p.team, this.phase, p.state, this.map, this.bomb)) {
            cmd.forward = 0;
            cmd.right = 0;
            cmd.jump = false;
        }

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

        // Weapon timers run on every processed command; the trigger acts only outside the freeze
        // and with free hands. The client runs the same steps with the same inputs.
        const armed = !acting && this.phase !== 'freeze';
        if (p.team === 'defenders') {
            const r = stepGun(p.gun, cmd.fire, cmd.reload, armed);
            if (r >= 0) this.fire(p, cmd, r);
            else if (r === GUN_RELOAD) this.emitSound(p, 'reload', 1, RELOAD_SOUND_RANGE);
        } else {
            const k = stepKnife(p.knife, cmd.fire, armed);
            if (k === KNIFE_SLASH) this.slash(p, cmd);
            else if (k === KNIFE_SWING) {
                p.vis = Math.max(p.vis, VIS_SWING_SPIKE);
                this.emitSound(p, 'windup', 1, KNIFE_SOUND_RANGE);
            }
        }

        if (acting) {
            p.actionTicks++;
            if (p.team === 'ghosts') {
                p.vis = Math.max(p.vis, VIS_SWING_SPIKE); // planting gives a ghost away
                if (p.actionTicks >= PLANT_TICKS) this.plant(p);
            } else if (p.actionTicks >= DEFUSE_TICKS) {
                p.actionTicks = 0;
                p.stats.defuses++;
                this.endRound('defenders', 'defused');
            }
            return;
        }
        p.actionTicks = 0;
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

    private damage(victim: Player, amount: number, attacker: Player, kind: DamageKind): boolean {
        const dealt = Math.min(amount, victim.health);
        victim.health = Math.max(0, victim.health - amount);
        if (victim.team === 'ghosts') victim.vis = Math.max(victim.vis, VIS_HURT_SPIKE);
        this.recordHit(victim, attacker, dealt, kind);
        if (victim.health > 0) return false;
        victim.alive = false;
        // Only warmup has respawns; in a round the dead wait for the next one.
        victim.respawnAt = this.phase === 'warmup' ? this.now + RESPAWN_MS : 0;
        resetKnife(victim.knife);
        victim.gun.reload = 0; // death cancels a reload
        victim.actionTicks = 0;
        this.recordKill(victim, attacker, kind);
        this.sendRoster();
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

    /** `shot` is the recoil pattern index from `stepGun`. */
    private fire(shooter: Player, cmd: NetCmd, shot: number): void {
        const { eye, dir, hmin, hmax } = this;
        this.aimFrom(shooter, cmd);
        // The view plus recoil plus spread, exactly as the client predicted it.
        shotDirection(cmd.yaw, cmd.pitch, shot, spreadAngle(shooter.state), spreadSeed(shooter.gun), shooter.id, dir);
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
            if (this.damage(victim, amount, shooter, head ? 'headshot' : 'shot')) event.killed = true;
        }
        this.broadcast(event);
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
            if (this.damage(victim, amount, attacker, backstab ? 'backstab' : 'knife')) event.killed = true;
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
            this.checkIdle(p);
            p.record(now);
        }
        if (this.rounds) this.updateRound();
        if (this.tickCount % SNAPSHOT_EVERY === 0) this.sendSnapshots();
    }

    private setPhase(phase: Phase, duration: number): void {
        this.phase = phase;
        this.phaseEndsAt = duration > 0 ? this.now + duration : 0;
        this.broadcast(this.roundMsg());
    }

    private startRound(): void {
        if (this.roundsPlayed === 0) this.resetMatch(); // a fresh match: nothing carries over from warmup
        this.startRequested = false;
        this.bomb = null;
        this.winner = this.reason = undefined;
        this.summary = null;
        this.spawnCursor.ghosts = this.spawnCursor.defenders = 0;
        for (const p of this.players.values()) {
            p.ready = false;
            p.hurtBy.clear();
            if (!p.idle) this.spawn(p);
        }
        this.setPhase('freeze', FREEZE_MS);
        this.sendRoster();
    }

    private toWarmup(): void {
        this.bomb = null;
        this.startRequested = false;
        this.resetMatch(); // a match cannot go on without both teams
        for (const p of this.players.values()) {
            p.ready = false;
            if (!p.alive && !p.idle) this.spawn(p);
        }
        this.setPhase('warmup', 0);
        this.sendRoster();
    }

    private plant(p: Player): void {
        p.actionTicks = 0;
        this.bomb = [...p.state.pos] as Vec3;
        p.stats.plants++;
        this.setPhase('planted', BOMB_MS);
    }

    private endRound(winner: Team, reason: RoundReason): void {
        this.winner = winner;
        this.reason = reason;
        this.roundsPlayed++;
        const group = winner === 'ghosts' ? this.ghostGroup : 1 - this.ghostGroup;
        this.matchOver = ++this.score[group] >= ROUNDS_TO_WIN;
        this.setPhase('over', this.matchOver ? MATCH_OVER_MS : OVER_MS);
        this.sendRoster();
        if (this.matchOver) {
            this.summary = {
                type: 'summary', winner, nextAt: this.phaseEndsAt, mvp: 0, players: this.rosterEntries(),
                score: { ghosts: this.score[this.ghostGroup], defenders: this.score[1 - this.ghostGroup] }
            };
            this.summary.mvp = pickMvp(this.summary.players);
            this.broadcast(this.summary);
        }
    }

    /** Zeroes the score and every player's statistics. */
    private resetMatch(): void {
        this.score[0] = this.score[1] = 0;
        this.roundsPlayed = 0;
        this.matchOver = false;
        this.summary = null;
        this.setGhostGroup(0);
        for (const p of this.players.values()) { p.stats = emptyStats(); p.hurtBy.clear(); }
    }

    /** Flips which side plays ghosts and tells every player its new role. */
    private setGhostGroup(group: 0 | 1): void {
        this.ghostGroup = group;
        for (const p of this.players.values()) p.team = this.teamOf(p.group);
    }

    /** The round state machine: decides when rounds start, who has won, and when sides swap. */
    private updateRound(): void {
        let ghosts = 0, defenders = 0, ghostsAlive = 0, defendersAlive = 0;
        for (const p of this.players.values()) {
            if (p.idle) continue; // spectate-only players do not hold a team up
            if (p.team === 'ghosts') { ghosts++; if (p.alive) ghostsAlive++; }
            else { defenders++; if (p.alive) defendersAlive++; }
        }
        const playable = ghosts > 0 && defenders > 0;
        const expired = this.now >= this.phaseEndsAt;
        switch (this.phase) {
            case 'warmup':
                if (playable && (!this.lobby || this.startRequested || this.everyoneReady())) this.startRound();
                break;
            case 'freeze':
                if (!playable) this.toWarmup();
                else if (expired) this.setPhase('live', ROUND_MS);
                break;
            case 'live':
                if (!playable) this.toWarmup();
                else if (defendersAlive === 0) this.endRound('ghosts', 'eliminated');
                else if (ghostsAlive === 0) this.endRound('defenders', 'eliminated');
                else if (expired) this.endRound('defenders', 'time');
                break;
            case 'planted':
                // Killing the ghosts no longer wins it: the bomb still has to be defused.
                if (defendersAlive === 0) this.endRound('ghosts', 'eliminated');
                else if (expired) this.endRound('ghosts', 'exploded');
                break;
            case 'over':
                if (!expired) break;
                if (this.matchOver) this.resetMatch(); // rematch: same room and map, groups kept
                else if (this.roundsPlayed === HALFTIME_ROUND) {
                    this.setGhostGroup((1 - this.ghostGroup) as 0 | 1);
                }
                if (playable) this.startRound();
                else this.toWarmup();
                break;
        }
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
                crouched: p.state.crouched, alive: p.alive, vis: p.vis, reloading: p.alive && p.gun.reload > 0
            });
        }
        for (const p of this.players.values()) {
            const players: PlayerSnap[] = [];
            for (const [other, snap] of snaps) if (other !== p && this.knowsAbout(p, other)) players.push(snap);
            p.conn.send({
                type: 'snap', time: this.now, ack: p.lastSeq,
                me: {
                    team: p.team,
                    action: p.actionTicks / (p.team === 'ghosts' ? PLANT_TICKS : DEFUSE_TICKS),
                    pos: p.state.pos, vel: p.state.vel, onGround: p.state.onGround, crouched: p.state.crouched,
                    health: p.health, alive: p.alive, respawnAt: p.respawnAt, vis: p.vis, gun: p.gun, knife: p.knife
                },
                players
            });
        }
    }
}
