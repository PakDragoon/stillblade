import {
    BREATH_RANGE, EYE_HEIGHT, EYE_HEIGHT_CROUCHED, GUNSHOT_RANGE, GUNSHOT_RANGE_SUPPRESSED,
    HULL_HALF_WIDTH, HULL_HEIGHT, HULL_HEIGHT_CROUCHED, KNIFE_BACKSTAB_DAMAGE, KNIFE_CONE_COS,
    KNIFE_DAMAGE, KNIFE_RANGE, KNIFE_SOUND_RANGE, MAX_ARMOR, MAX_HEALTH,
    MAX_REWIND_MS, RELOAD_SOUND_RANGE, RESPAWN_MS, SHOT_RANGE, STEP_DISTANCE, STEP_LOUD_CROUCH, STEP_LOUD_RUN, STEP_LOUD_WALK,
    STEP_RANGE, TICK_DT, TICK_RATE, VIS_HURT_SPIKE, VIS_SWING_SPIKE
} from '../../shared/constants';
import {
    GUN_RELOAD, MELEE_SLASH, MELEE_SWING, aimFraction, cancelReloads, createLoadout, emptyReload, fillReserves, heldGun, resetLoadout,
    shotDirectionFor, stepLoadout
} from '../../shared/gun';
import { KNIFE_SLASH, KNIFE_SWING, createKnifeState, resetKnife, stepKnife } from '../../shared/knife';
import {
    BOMB_SIGHT_HEIGHT, BOMB_SOUND_LOUD, BOMB_SOUND_RANGE, CARRY_DROPPED, CARRY_PICKED, createCarry, resetCarry, restingPoint,
    stepCarry
} from '../../shared/bomb';
import { createPlayerState, horizontalSpeed, stepPlayer } from '../../shared/movement';
import {
    PING_MAX, PROTOCOL_VERSION, SNAPSHOT_RATE, type BombEvent, type BombMsg, type ClientMsg, type DamageKind, type KickVoteInfo, type KillMsg, type MapVoteMsg, type MatchStats,
    type NetCmd, type PlayerSnap, type RosterEntry, type RoundMsg, type ServerMsg, type ShotEvent, type SlashEvent, type SoundEvent,
    type SummaryMsg, type Team
} from '../../shared/protocol';
import {
    BOMB_MS, DEFUSE_TICKS, FREEZE_MS, GRACE_MS, IDLE_ROUNDS, MATCH_OVER_MS, OVER_MS, PLANT_TICKS, ROUND_MS,
    canAct, movementLocked, type Phase, type RoundReason
} from '../../shared/rules';
import { applyDamage, type DamageSplit } from '../../shared/armor';
import { cleanChat } from '../../shared/chat';
import { ASSIST_MS, emptyStats, pickMvp } from '../../shared/stats';
import { rayBox, rayWorld, viewDir } from '../../shared/raycast';
import { DEFAULT_ROOM_OPTIONS, botTeamSize, cleanRoomOptions, halftimeRound, type RoomOptions } from '../../shared/room-options';
import { NavGraph } from '../../shared/nav';
import type { MapData, PlayerState, Vec3 } from '../../shared/types';
import { ghostVisTarget, stepVis } from '../../shared/visibility';
import { DEFENDER_KNIFE, SIGHT_IRON, WEAPONS, cleanSight } from '../../shared/weapons';
import { hitZone, zoneDamage, type HitZone } from '../../shared/zones';
import { chooseName, cleanName, maskChat } from './namefilter';
import { Bans, KickVote, MAP_VOTE_LEAD_MS, MapVote } from './votes';
import { BOT_NAMES, BotBrain, BotRng, hashSeed, siteNodes, type BotRole, type BotWorld } from './bots';

export interface Connection {
    send(msg: ServerMsg): void;
    /** Ends the connection with a reason the player sees (a kick). Absent in tests. */
    close?(reason: string): void;
    /** The caller's address as the server counts it, for the rejoin ban. */
    ip?: string;
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

/** Smooths round-trip samples (about the last 3) and keeps the result a whole number of ms from 0 to PING_MAX. */
export function smoothPing(previous: number, sampleMs: number): number {
    const sample = Math.min(PING_MAX, Math.max(0, sampleMs));
    return Math.round(previous < 0 ? sample : previous + (sample - previous) * 0.35);
}

export class Player {
    state: PlayerState = createPlayerState([0, 0, 0]);
    yaw = 0;
    pitch = 0;
    health = MAX_HEALTH;
    /** Armor (shared/armor.ts): reset to MAX_ARMOR at every spawn; only this player is ever told it. */
    armor = MAX_ARMOR;
    alive = false;
    respawnAt = 0;
    lastSeq = -1;
    credits = MAX_CMD_CREDITS;
    /** The defender's weapons (shared/gun.ts, shared/weapons.ts); reset at every spawn. */
    readonly loadout = createLoadout();
    /**
     * The rifle sight this player last asked for (join query or `sight` message; bots never ask, so iron).
     * Mounted at the next spawn as `loadout.sight`, the active one; never changes a life in progress.
     */
    sightPending = SIGHT_IRON;
    /** Ghost knife timing, counted in commands processed for this player (shared/knife.ts). Defenders use `loadout.knife`. */
    readonly knife = createKnifeState();
    /** Ghosts: carrying the bomb and the repick wait (shared/bomb.ts), stepped per processed command; reset at every spawn. */
    readonly carry = createCarry();
    /** Feet position the last time this player stood on something: where a bomb dropped over a void lands. */
    readonly lastGround: Vec3 = [0, 0, 0];
    /** Defenders: the dropped bomb this player was last told about (null: told there is none in sight). */
    bombShown: Vec3 | null = null;
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
    /** Round trip to this player in ms, measured by the server's WebSocket pings and smoothed (transport only: no rule reads it); -1 before the first. */
    pingMs = -1;
    ready = false;
    /** The name the player asked for (cleaned, before the filter and numbering): what the rejoin restore and bans go by. */
    baseName = '';
    /** A computer player (server/src/bots.ts): never counts for votes, the creator role, room size or idleness. */
    bot = false;
    /** The bot's mind; it produces this player's command every tick. Null for people. */
    brain: BotBrain | null = null;
    /** Practice targets spawn here instead of at a team spawn. */
    spawnAt: { pos: Vec3; yaw: number } | null = null;
    /** A bot added by the room's fill option (only these are added and removed by `fillWithBots`). */
    filler = false;
    /**
     * Marked after IDLE_ROUNDS consecutive complete rounds without a single input change; not spawned
     * at the next round start; cleared by the next input change. Nobody is ever removed mid-round.
     */
    idle = false;
    /** Took part in the current round (was spawned for it). */
    inRound = false;
    /** Produced an input change since this round's freeze began. */
    changedThisRound = false;
    /** Consecutive finished rounds this player took part in without any input change. */
    quietRounds = 0;
    private readonly lastInput = [0, 0, 0, 0, 0];
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
        const b = (c.jump ? 1 : 0) | (c.walk ? 2 : 0) | (c.crouch ? 4 : 0) | (c.fire ? 8 : 0) | (c.use ? 16 : 0) | (c.reload ? 32 : 0) |
            (c.swap ? 64 : 0) | (c.aim ? 128 : 0);
        const l = this.lastInput;
        const changed = l[0] !== c.forward || l[1] !== c.right || l[2] !== c.yaw || l[3] !== c.pitch || l[4] !== c.slot ||
            this.lastButtons !== b;
        l[0] = c.forward; l[1] = c.right; l[2] = c.yaw; l[3] = c.pitch; l[4] = c.slot;
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
/** One navigation graph per map, built on first use. */
const navCache = new WeakMap<MapData, NavGraph | null>();
/** Practice targets: how many of each kind. */
const PRACTICE_STATIC = 3;
const PRACTICE_MOVING = 2;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The authoritative match. Knows nothing about sockets: the transport hands it commands and a
 * `Connection` to send through, which keeps it unit-testable and transport-agnostic.
 */
export class Game implements BotWorld {
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
    /** Where the bomb lies after being dropped (before it is planted), or null. */
    dropped: Vec3 | null = null;
    /** Id of the ghost carrying the bomb, 0 when nobody does (dropped, planted, warmup). */
    carrierId = 0;
    private winner: Team | undefined;
    private reason: RoundReason | undefined;
    private matchOver = false;
    private readonly rounds: boolean;
    /** Lobby mode (rooms): the match starts when everyone is ready or the creator starts it. */
    private readonly lobby: boolean;
    private startRequested = false;
    /** A match that fell back to warmup (a team emptied) is held until this server time, then reset. */
    private held = false;
    private graceUntil = 0;
    /** Players who left mid-match, by cleaned name: their stats come back if they return within GRACE_MS. null = ambiguous. */
    private readonly departed = new Map<string, { stats: MatchStats; group: 0 | 1; at: number; base: string } | null>();
    /** The final result, kept for players who join during the result screen. */
    private summary: SummaryMsg | null = null;

    // Scratch vectors: no allocation on the hot path.
    private readonly eye: Vec3 = [0, 0, 0];
    private readonly dir: Vec3 = [0, 0, 0];
    private readonly feet: Vec3 = [0, 0, 0];
    private readonly hmin: Vec3 = [0, 0, 0];
    private readonly hmax: Vec3 = [0, 0, 0];
    private readonly target: Vec3 = [0, 0, 0];
    /** What the hit being resolved removed (shared/armor.ts), reused. */
    private readonly split: DamageSplit = { health: 0, armor: 0 };

    /** The room's options (shared/room-options.ts): the creator's, changed only in warmup by `changeOptions`. Sent in `welcome`. */
    options: Readonly<RoomOptions>;
    /** The room code, set by `Rooms`; sent in `welcome` so Quick play can show where it landed. */
    code = '';
    /** Every installed map, for the map vote; without it a room can only stay on its map. */
    private readonly maps: ReadonlyMap<string, MapData> | undefined;
    private readonly kickVote = new KickVote();
    private lastKickSig = '';
    /** Players removed by vote or by the creator may not rejoin for BAN_MS; by address and by name. */
    readonly bans = new Bans();
    private readonly mapVote = new MapVote();
    private mapDecided = false;
    /** A private practice range (no rounds, targets, reserves kept full). */
    readonly practice: boolean;
    /** Bots added so far (names and seeds). */
    private botCount = 0;
    /** Plans shared by each team's bots, picked per round from a generator seeded by the room code. */
    private botRng: BotRng | null = null;
    private readonly teamSites: Record<Team, number> = { ghosts: 0, defenders: 0 };

    /**
     * `rounds: false` keeps the match in warmup (free roam with respawns), for tests of the core mechanics.
     * `map` changes between matches through `swapMap` (the map vote), never during one.
     */
    constructor(public map: MapData, opts: {
        rounds?: boolean; lobby?: boolean; options?: Partial<RoomOptions>; maps?: ReadonlyMap<string, MapData>; practice?: boolean
    } = {}) {
        this.practice = opts.practice ?? false;
        this.rounds = this.practice ? false : (opts.rounds ?? true);
        this.lobby = opts.lobby ?? false;
        this.options = cleanRoomOptions({ ...opts.options }, DEFAULT_ROOM_OPTIONS);
        this.maps = opts.maps;
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
            if (p.bot) continue;
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
                ready: p.ready, creator: p.id === creator, idle: p.idle, bot: p.bot, sight: p.loadout.sight
            });
        }
        return players;
    }

    /** A fresh round-trip sample for a player (from the server's own ping and the pong that answered it). Never a client's claim. */
    setPing(id: number, sampleMs: number): void {
        const p = this.players.get(id);
        if (!p || p.bot || !Number.isFinite(sampleMs)) return;
        p.pingMs = smoothPing(p.pingMs, sampleMs);
    }

    /** Tells everyone each human player's ping (called every few seconds by the transport). */
    sendPings(): void {
        const pings: [number, number][] = [];
        for (const p of this.players.values()) if (!p.bot && p.pingMs >= 0) pings.push([p.id, p.pingMs]);
        if (pings.length > 0) this.broadcast({ type: 'pings', pings });
    }

    private sendRoster(): void {
        this.rosterDirty = false;
        this.broadcast({ type: 'roster', players: this.rosterEntries() });
    }

    /** A spawn mounted a different sight than the roster shows: re-sent at the end of the tick (once, however many). */
    private rosterDirty = false;

    private teamCounts(): Record<Team, number> {
        const n = { ghosts: 0, defenders: 0 };
        for (const p of this.players.values()) n[p.team]++;
        return n;
    }

    /**
     * Adds a player. `as.team` puts them on a side (bots, and the practice range's chosen side); otherwise
     * a person joins the smaller team. `as.brain` makes the player a bot run by the server.
     */
    join(conn: Connection, name = '', as: { team?: Team; brain?: BotBrain; spawnAt?: { pos: Vec3; yaw: number }; sight?: number } = {}): number {
        let ghosts = 0;
        for (const p of this.players.values()) if (p.team === 'ghosts') ghosts++;
        let team: Team = as.team ?? (ghosts <= this.players.size - ghosts ? 'ghosts' : 'defenders');
        let group = team === 'ghosts' ? this.ghostGroup : ((1 - this.ghostGroup) as 0 | 1);
        const id = this.nextId++;
        const clean = as.brain ? '' : cleanName(name);
        // Blocked and reserved names become "Player", a name already in the room gets " (2)"; nothing asked for is "Player <id>".
        // Bots are named by the server ("BOT <name>") and skip the filter.
        const shown = as.brain ? name : chooseName(clean, [...this.players.values()].map(o => o.name), name) || `Player ${id}`;
        // Returning within the grace period under the same (unique) name: previous side and statistics back.
        this.purgeDeparted();
        // Departed players are remembered by the name that was shown, so a numbered "Sam (2)" is restored when
        // the same request ("Sam") is numbered the same way again (see `leave` for the ambiguous case).
        const back = clean && !as.team ? this.departed.get(shown) ?? undefined : undefined;
        if (back) {
            group = back.group;
            team = this.teamOf(group);
        }
        const player = new Player(id, group, team, shown, conn);
        player.baseName = clean;
        if (as.brain) { player.bot = true; player.brain = as.brain; player.ready = true; }
        if (as.spawnAt) player.spawnAt = as.spawnAt;
        // The join query's sight counts from the first spawn, which may come just below (warmup).
        if (!as.brain && as.sight !== undefined) player.sightPending = cleanSight(as.sight);
        if (back) { player.stats = { ...back.stats }; this.departed.delete(shown); }
        player.joinedAt = player.chatTokensAt = this.now;
        this.players.set(id, player);
        conn.send({
            type: 'welcome', version: PROTOCOL_VERSION, id, team, map: this.map.name,
            mapName: this.map.displayName ?? this.map.name, time: this.now, options: { ...this.options }, room: this.code,
            ...(this.practice ? { practice: true } : {})
        });
        conn.send(this.roundMsg());
        if (this.summary && this.phase === 'over') { // joined during the result screen
            conn.send(this.summary);
            conn.send(this.mapVoteMsg(player));
        }
        if (this.kickVote.active) conn.send({ type: 'kickvote', vote: this.kickInfo(player) });
        // Mid-round arrivals wait for the next round rather than appearing behind someone.
        if (this.phase === 'warmup') this.spawn(player);
        if (team === 'ghosts') conn.send(this.ghostBombMsg());
        this.sendRoster();
        if (!as.brain) {
            if (this.practice) this.setUpPractice(player);
            else this.fillWithBots(this.phase === 'warmup');
        }
        return id;
    }

    /** Connected people (not bots): what room size, quick play and an empty room are judged by. */
    humanCount(): number {
        let n = 0;
        for (const p of this.players.values()) if (!p.bot) n++;
        return n;
    }

    // -----------------------------------------------------------------------------------------
    // Bots (server/src/bots.ts). A bot is a player whose connection feeds its brain and whose brain
    // sends one command per tick through `handleCmd`, so every rule applies to it.
    // -----------------------------------------------------------------------------------------

    /** The map's navigation graph; null when the map has none (then no bots can be added). */
    get nav(): NavGraph | null {
        let g = navCache.get(this.map);
        if (g === undefined) {
            g = this.map.nav && this.map.nav.nodes.length > 0 ? new NavGraph(this.map.nav) : null;
            navCache.set(this.map, g);
        }
        return g;
    }

    /** BotWorld: nothing solid between two points (map geometry only). */
    clearLine(a: Vec3, b: Vec3): boolean {
        return this.lineClear(a[0], a[1], a[2], b[0], b[1], b[2]);
    }

    /** BotWorld: the site index each team's bots favour this round. */
    teamSite(team: Team): number {
        return this.teamSites[team];
    }

    private rngForBots(): BotRng {
        return this.botRng ??= new BotRng(hashSeed(this.code || 'room', hashSeed(this.map.name)));
    }

    /** Adds one bot to a team. Returns its id, or 0 when the map has no navigation graph. */
    addBot(team: Team, role: BotRole = 'player', place?: { pos: Vec3; yaw: number }, filler = false): number {
        if (!this.nav) return 0;
        const k = this.botCount++;
        const taken = new Set<string>();
        for (const p of this.players.values()) taken.add(p.name);
        let name = `BOT ${BOT_NAMES[k % BOT_NAMES.length]}`;
        for (let n = 2; taken.has(name); n++) name = `BOT ${BOT_NAMES[k % BOT_NAMES.length]} ${n}`;
        const brain = new BotBrain(role, this.options.botLevel, hashSeed(this.code || 'room', k + 1), place?.yaw ?? 0);
        const id = this.join(brain.conn, name, { team, brain, spawnAt: place });
        const p = this.players.get(id);
        if (p) p.filler = filler;
        return id;
    }

    /** Runs every bot's mind once: one command each, through `handleCmd` like a person's. */
    private stepBots(): void {
        for (const p of this.players.values()) {
            if (p.brain) this.handleCmd(p.id, p.brain.think(p, this));
        }
    }

    /**
     * Keeps each team at `botTeamSize` with bots while the room's `fillBots` option is on (and removes them
     * all when it is off). Bots are added at any time (a bot added mid-round waits for the next round
     * like a person would); they are removed only when `removeNow` (warmup, or a round start), so a person
     * who joins mid-round takes a bot's place at the next round start.
     */
    fillWithBots(removeNow: boolean): void {
        if (this.practice || !this.nav) return;
        const size = botTeamSize(this.options);
        const humans = { ghosts: 0, defenders: 0 };
        const bots: Record<Team, Player[]> = { ghosts: [], defenders: [] };
        for (const p of this.players.values()) {
            if (p.filler) bots[p.team].push(p);
            else humans[p.team]++; // people, and bots added by hand (tests, tools), count as players
        }
        const total = humans.ghosts + humans.defenders;
        if (this.humanCount() === 0) return; // an empty room is about to close
        const want: Record<Team, number> = {
            ghosts: this.options.fillBots ? Math.max(0, size - humans.ghosts) : 0,
            defenders: this.options.fillBots ? Math.max(0, size - humans.defenders) : 0
        };
        // Never more than the room's size in all.
        while (total + want.ghosts + want.defenders > this.options.maxPlayers && want.ghosts + want.defenders > 0) {
            if (want.ghosts >= want.defenders) want.ghosts--; else want.defenders--;
        }
        for (const team of ['ghosts', 'defenders'] as const) {
            const list = bots[team];
            if (removeNow) {
                // The newest bots leave first.
                while (list.length > want[team]) this.leave(list.pop()!.id);
            }
            for (let n = list.length; n < want[team]; n++) this.addBot(team, 'player', undefined, true);
        }
    }

    /** The practice range: targets on the other side, placed where the person can see them from their spawn. */
    private setUpPractice(person: Player): void {
        for (const p of [...this.players.values()]) if (p.bot) this.leave(p.id);
        const targets: Team = person.team === 'ghosts' ? 'defenders' : 'ghosts';
        const posts = this.practicePosts(person.team);
        for (let i = 0; i < posts.length; i++) {
            this.addBot(targets, i < PRACTICE_STATIC ? 'target-static' : 'target-moving', posts[i]);
        }
    }

    /**
     * Up to five places 6 to 28 m from the person's spawn, in its view (eye to chest clear), spread apart,
     * each facing the spawn. Falls back to places in reach without a clear view on a map that has too few.
     */
    private practicePosts(team: Team): { pos: Vec3; yaw: number }[] {
        const nav = this.nav;
        if (!nav) return [];
        const from = this.map.spawns[team][0].pos;
        const eye: Vec3 = [from[0], from[1] + EYE_HEIGHT, from[2]];
        const chest: Vec3 = [0, 0, 0];
        const candidates: { n: number; d: number; seen: boolean }[] = [];
        for (let n = 0; n < nav.count; n++) {
            const d = nav.flatDist(n, from[0], from[2]);
            if (d < 6 || d > 28 || Math.abs(nav.y[n] - from[1]) > 3) continue;
            chest[0] = nav.x[n]; chest[1] = nav.y[n] + 1.2; chest[2] = nav.z[n];
            candidates.push({ n, d, seen: this.clearLine(eye, chest) });
        }
        candidates.sort((a, b) => Number(b.seen) - Number(a.seen) || a.d - b.d || a.n - b.n);
        const chosen: number[] = [];
        for (const minGap of [4, 2.5, 1.2]) {
            for (const c of candidates) {
                if (chosen.length >= PRACTICE_STATIC + PRACTICE_MOVING) break;
                if (chosen.includes(c.n)) continue;
                if (chosen.every(o => Math.hypot(nav.x[o] - nav.x[c.n], nav.z[o] - nav.z[c.n]) >= minGap)) chosen.push(c.n);
            }
        }
        return chosen.map(n => ({
            pos: [nav.x[n], nav.y[n], nav.z[n]] as Vec3,
            yaw: Math.atan2(-(from[0] - nav.x[n]), -(from[2] - nav.z[n]))
        }));
    }

    leave(id: number): void {
        // The creator role passes to the longest-connected player by itself (see `creatorId`).
        const p = this.players.get(id);
        if (p && p.id === this.carrierId) this.dropBomb(p, 'lost'); // the bomb stays where they stood
        if (p && this.matchInProgress()) {
            this.purgeDeparted();
            // Two leavers who asked for one name ("Eve" and "Eve (2)") cannot be told apart: restore neither.
            let twin = false;
            for (const [key, d] of this.departed) if (key === p.name || (d && d.base === p.baseName)) { this.departed.set(key, null); twin = true; }
            this.departed.set(p.name, twin ? null : { stats: { ...p.stats }, group: p.group, at: this.now, base: p.baseName });
        }
        if (this.players.delete(id)) {
            this.sendRoster();
            if (p && !p.bot) this.fillWithBots(this.phase === 'warmup');
        }
    }

    /** A match is on, or held waiting for players: the room is not in its lobby. */
    matchInProgress(): boolean {
        return this.held || this.roundsPlayed > 0 || this.phase === 'freeze' || this.phase === 'live' || this.phase === 'planted';
    }

    private purgeDeparted(): void {
        for (const [name, d] of this.departed) if (d && this.now - d.at > GRACE_MS) this.departed.delete(name);
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
            case 'options': this.changeOptions(p, msg.options); break;
            case 'votekick': this.startKickVote(p, msg.target); break;
            case 'votecast': if (this.kickVote.cast(p.id, msg.yes, this.presentIds())) this.stepKickVote(); break;
            case 'removeplayer': this.removePlayer(p, msg.target); break;
            case 'mapvote': this.castMapVote(p, msg.map); break;
            // Stored only: it takes effect at the next spawn, so sending it often changes nothing and sends nothing.
            case 'sight': if (!p.bot) p.sightPending = cleanSight(msg.sight); break;
        }
    }

    private notice(p: Player, text: string): void {
        p.conn.send({ type: 'notice', text });
    }

    private everyoneReady(): boolean {
        if (this.humanCount() === 0) return false;
        for (const p of this.players.values()) if (!p.ready && !p.bot) return false;
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
        if (p.bot) return;
        if (this.phase !== 'warmup') { this.notice(p, 'Teams can only be changed in warmup.'); return; }
        // With bots filling the teams, only people count: a bot makes way on the other side.
        const n = this.options.fillBots && this.nav ? this.humanTeamCounts() : this.teamCounts();
        const to: Team = p.team === 'ghosts' ? 'defenders' : 'ghosts';
        if (!this.practice && Math.abs((n[to] + 1) - (n[p.team] - 1)) > MAX_TEAM_GAP) { this.notice(p, 'That would make the teams uneven.'); return; }
        p.group = (1 - p.group) as 0 | 1;
        p.team = this.teamOf(p.group);
        this.spawn(p);
        this.sendRoster();
        if (this.practice) this.setUpPractice(p); // the targets change sides with the person
        else this.fillWithBots(true);
    }

    private humanTeamCounts(): Record<Team, number> {
        const n = { ghosts: 0, defenders: 0 };
        for (const p of this.players.values()) if (!p.bot) n[p.team]++;
        return n;
    }

    /**
     * All-chat or team chat. Dead players' lines (while a round is on) reach only dead players, so
     * the dead cannot call out positions; team chat never leaves the team.
     */
    private chat(p: Player, teamOnly: boolean, raw: string): void {
        const text = maskChat(cleanChat(raw));
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
        if (this.phase === 'freeze' || this.phase === 'live' || this.phase === 'planted') p.changedThisRound = true;
        if (p.idle) {
            p.idle = false;
            p.quietRounds = 0;
            this.notice(p, 'You are back: you play again from the next round.');
            this.sendRoster();
        }
    }

    /**
     * Called when a round ends: someone who took part and never touched an input for IDLE_ROUNDS rounds
     * in a row is marked idle and is not spawned at the next round start. Standing still all round is
     * not idleness for a player who looks or presses anything, and nobody is removed mid-round.
     */
    private countQuietRounds(): void {
        for (const p of this.players.values()) {
            if (!p.inRound || p.bot) continue;
            p.quietRounds = p.changedThisRound ? 0 : p.quietRounds + 1;
            if (p.quietRounds >= IDLE_ROUNDS && !p.idle) {
                p.idle = true;
                this.notice(p, `No input for ${IDLE_ROUNDS} rounds: you sit out until you move or press a key. You return at the next round start after that.`);
            }
        }
    }

    /** Bearing (yaw convention) from `from` toward `to`, on the ground plane. */
    private bearing(from: Vec3, to: Vec3): number {
        return Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
    }

    /**
     * Stats for one landed hit, and the hit messages to both sides. `zone` only for shots. `split` is what
     * the hit removed (health, armor); the damage statistic counts both.
     */
    private recordHit(victim: Player, attacker: Player, amount: number, split: DamageSplit, kind: DamageKind, weapon?: number, zone?: HitZone): void {
        if (!this.held) { // warmup play while a match is held must not change its statistics
            attacker.stats.damage += split.health + split.armor;
            if (zone === 'head') attacker.stats.headshots++;
            else if (kind === 'backstab') attacker.stats.backstabs++;
        }
        victim.hurtBy.set(attacker.id, this.now);
        const killed = victim.health <= 0;
        // The victim learns the direction of the hit and how much it hurt: nothing else. A kill adds
        // who and how far (a knife kill is within reach, so already inside breathing range).
        const dmg: ServerMsg = { type: 'dmg', dir: this.bearing(victim.state.pos, attacker.state.pos), amount: split.health, kind };
        // The victim's own armor: only the victim is told how much of the hit it took.
        if (split.armor > 0) dmg.armor = split.armor;
        if (weapon !== undefined) dmg.weapon = weapon;
        if (zone !== undefined) dmg.zone = zone;
        if (killed) {
            dmg.killed = true;
            dmg.by = attacker.id;
            dmg.dist = Math.round(dist(victim.state.pos, attacker.state.pos) * 10) / 10;
        }
        victim.conn.send(dmg);
        const confirm: ServerMsg = { type: 'hitconfirm', kind, kill: killed, damage: amount };
        if (zone !== undefined) confirm.zone = zone;
        // Only the practice range's targets say how a hit split between armor and health: in a match the
        // attacker is told nothing about an enemy's armor.
        if (this.practice) confirm.armor = split.armor;
        attacker.conn.send(confirm);
    }

    private recordKill(victim: Player, attacker: Player): void {
        if (this.held) return;
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
        const spawn = p.spawnAt ?? spawns[this.spawnCursor[p.team]++ % spawns.length];
        p.state = createPlayerState(spawn.pos);
        p.yaw = (spawn.yaw * Math.PI) / 180;
        p.pitch = 0;
        p.health = MAX_HEALTH;
        p.armor = MAX_ARMOR;
        p.alive = true;
        resetKnife(p.knife);
        // The chosen sight becomes active here and only here; others see it through the roster.
        if (p.loadout.sight !== p.sightPending) this.rosterDirty = true;
        resetLoadout(p.loadout, p.sightPending);
        resetCarry(p.carry);
        if (p.id === this.carrierId) this.carrierId = 0;
        p.lastGround[0] = spawn.pos[0]; p.lastGround[1] = spawn.pos[1]; p.lastGround[2] = spawn.pos[2];
        p.stepAccum = 0;
        p.actionTicks = 0;
        p.respawnAt = 0;
        p.vis = p.team === 'ghosts' ? 0 : 1;
        p.conn.send({ type: 'spawn', pos: spawn.pos, yaw: p.yaw, sight: p.loadout.sight });
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
        cmd.swap = cmd.swap === true;
        cmd.aim = cmd.aim === true;
        cmd.drop = cmd.drop === true;
        cmd.slot = Number.isInteger(cmd.slot) ? cmd.slot : 0; // out-of-range slots are ignored by stepLoadout

        // Rooted during the freeze and while planting or defusing. The client applies the same rule.
        const carrier = p.carry.carrier;
        const acting = cmd.use && canAct(p.team, this.phase, p.state, this.map, this.bomb, carrier);
        if (movementLocked(cmd.use, p.team, this.phase, p.state, this.map, this.bomb, carrier)) {
            cmd.forward = 0;
            cmd.right = 0;
            cmd.jump = false;
        }

        const px = p.state.pos[0], pz = p.state.pos[2];
        stepPlayer(p.state, cmd, TICK_DT, this.map.boxes);
        p.yaw = cmd.yaw;
        p.pitch = cmd.pitch;

        if (p.state.onGround) {
            p.lastGround[0] = p.state.pos[0]; p.lastGround[1] = p.state.pos[1]; p.lastGround[2] = p.state.pos[2];
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
            const r = stepLoadout(p.loadout, cmd, armed);
            if (this.practice) fillReserves(p.loadout); // after the step, so it always shows full; the client does the same (welcome.practice)
            if (r >= 0) this.fire(p, cmd, r);
            else if (r === GUN_RELOAD) {
                this.emitSound(p, 'reload', 1, RELOAD_SOUND_RANGE, p.loadout.slot, emptyReload(p.loadout.guns[p.loadout.slot]));
            }
            // The defender knife: the same windup warning and the same landing as a ghost's swing.
            else if (r === MELEE_SWING) this.emitSound(p, 'windup', 1, KNIFE_SOUND_RANGE);
            else if (r === MELEE_SLASH) this.slash(p, cmd);
        } else {
            const k = stepKnife(p.knife, cmd.fire, armed);
            if (k === KNIFE_SLASH) this.slash(p, cmd);
            else if (k === KNIFE_SWING) {
                p.vis = Math.max(p.vis, VIS_SWING_SPIKE);
                this.emitSound(p, 'windup', 1, KNIFE_SOUND_RANGE);
            }
            // The bomb: a deliberate drop (refused while planting) or a pickup by walking over it. The
            // client runs the same step for this command (shared/bomb.ts).
            const c = stepCarry(p.carry, cmd.drop, acting, p.state, this.dropped);
            if (c === CARRY_DROPPED) this.dropBomb(p, 'drop');
            else if (c === CARRY_PICKED) this.pickUp(p);
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
    private emitSound(source: Player, kind: SoundEvent['kind'], loud: number, range: number, weapon?: number, empty = false): void {
        let event: SoundEvent | undefined;
        for (const p of this.players.values()) {
            if (p === source || dist(p.state.pos, source.state.pos) > range) continue;
            if (!event) {
                event = { type: 'sound', kind, id: source.id, pos: [...source.state.pos] as Vec3, loud };
                if (weapon !== undefined) event.weapon = weapon;
                if (empty) event.empty = true;
            }
            p.conn.send(event);
        }
    }

    // -----------------------------------------------------------------------------------------
    // The bomb carrier (shared/bomb.ts). Ghosts are told everything; defenders only see a dropped
    // bomb that is in their line of sight and are never told who carries it.
    // -----------------------------------------------------------------------------------------

    private ghostBombMsg(event?: BombEvent, by?: number): BombMsg {
        const msg: BombMsg = { type: 'bomb', dropped: this.dropped, carrier: this.carrierId };
        if (event) { msg.event = event; msg.by = by; }
        return msg;
    }

    private sendBombToGhosts(event?: BombEvent, by?: number): void {
        let msg: BombMsg | undefined;
        for (const p of this.players.values()) if (p.team === 'ghosts') p.conn.send(msg ??= this.ghostBombMsg(event, by));
    }

    /**
     * Tells each defender about the dropped bomb when it comes into its line of sight (eye to just above
     * the bomb, the same line test `knowsAbout` uses) and that it is gone when it leaves sight, is picked
     * up or is reset. Run on every snapshot and whenever the bomb moves.
     */
    private updateBombSight(): void {
        const b = this.dropped;
        for (const p of this.players.values()) {
            if (p.team !== 'defenders') continue;
            const sees = b !== null && this.lineClear(p.state.pos[0], p.eyeY, p.state.pos[2], b[0], b[1] + BOMB_SIGHT_HEIGHT, b[2]);
            const shown = sees ? b : null;
            if (shown === p.bombShown) continue;
            p.bombShown = shown;
            p.conn.send({ type: 'bomb', dropped: shown });
        }
    }

    /** A drop or pickup is a quiet sound. Defenders hear it in range like a footstep, but never learn whose it is. */
    private emitBombSound(kind: 'bombDrop' | 'bombPickup', pos: Vec3, source: Player): void {
        let ghostEv: SoundEvent | undefined, defenderEv: SoundEvent | undefined;
        for (const p of this.players.values()) {
            if (p === source || dist(p.state.pos, pos) > BOMB_SOUND_RANGE) continue;
            if (p.team === 'ghosts') p.conn.send(ghostEv ??= { type: 'sound', kind, id: source.id, pos: [...pos] as Vec3, loud: BOMB_SOUND_LOUD });
            else p.conn.send(defenderEv ??= { type: 'sound', kind, id: 0, pos: [...pos] as Vec3, loud: BOMB_SOUND_LOUD });
        }
    }

    /**
     * The carrier lets go of the bomb: on purpose (`drop`), or by dying or leaving (`lost`). It comes to
     * rest on the floor under them (shared/bomb.ts `restingPoint`).
     */
    private dropBomb(p: Player, event: 'drop' | 'lost'): void {
        p.carry.carrier = false;
        if (this.carrierId === p.id) this.carrierId = 0;
        this.dropped = restingPoint(p.state, this.map.boxes, p.lastGround, [0, 0, 0]);
        this.emitBombSound('bombDrop', this.dropped, p);
        this.sendBombToGhosts(event, p.id);
        this.updateBombSight();
    }

    private pickUp(p: Player): void {
        const at = this.dropped!;
        this.dropped = null;
        this.carrierId = p.id;
        this.emitBombSound('bombPickup', at, p);
        this.sendBombToGhosts('pickup', p.id);
        this.updateBombSight();
    }

    /** No bomb in play: nobody carries it and none lies on the floor (round start, warmup, plant). */
    private clearBomb(): void {
        for (const p of this.players.values()) p.carry.carrier = false;
        this.carrierId = 0;
        this.dropped = null;
    }

    /**
     * Chooses the round's carrier among the living, non-idle ghosts without randomness: ordered by when
     * they joined (then id), the round number picks one, so it rotates through the team round by round.
     */
    private assignCarrier(): void {
        const ghosts: Player[] = [];
        for (const p of this.players.values()) if (p.team === 'ghosts' && p.alive && !p.idle) ghosts.push(p);
        if (ghosts.length === 0) return;
        ghosts.sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id);
        const c = ghosts[this.roundsPlayed % ghosts.length];
        c.carry.carrier = true;
        this.carrierId = c.id;
    }

    private damage(victim: Player, amount: number, attacker: Player, kind: DamageKind, weapon?: number, zone?: HitZone): boolean {
        // The one armor rule (shared/armor.ts): bots and practice targets are players and take it too.
        const split = applyDamage(victim, amount, kind, zone, this.split);
        if (victim.team === 'ghosts') victim.vis = Math.max(victim.vis, VIS_HURT_SPIKE);
        this.recordHit(victim, attacker, amount, split, kind, weapon, zone);
        if (victim.health > 0) return false;
        victim.alive = false;
        // Only warmup has respawns; in a round the dead wait for the next one.
        victim.respawnAt = this.phase === 'warmup' ? this.now + RESPAWN_MS : 0;
        resetKnife(victim.knife);
        cancelReloads(victim.loadout); // death cancels a reload
        victim.actionTicks = 0;
        if (victim.id === this.carrierId) this.dropBomb(victim, 'lost'); // at their feet, on the floor
        this.recordKill(victim, attacker);
        // The kill feed: who and how, never where, so everyone may have it.
        const kill: KillMsg = { type: 'kill', killer: attacker.id, victim: victim.id, kind };
        if (weapon !== undefined) kill.weapon = weapon;
        if (zone !== undefined) kill.zone = zone;
        this.broadcast(kill);
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

    /** `shot` is the recoil pattern index from `stepLoadout`. */
    private fire(shooter: Player, cmd: NetCmd, shot: number): void {
        const { eye, dir, feet, hmin, hmax, target } = this;
        this.aimFrom(shooter, cmd);
        // The view plus recoil plus spread, exactly as the client predicted it.
        shotDirectionFor(shooter.loadout, shooter.state, cmd.yaw, cmd.pitch, shot, shooter.id, dir);
        // Test against where the shooter saw everyone, within a bounded window.
        const viewTime = clamp(cmd.viewTime, this.now - MAX_REWIND_MS, this.now);
        const worldRange = rayWorld(this.map.boxes, eye, dir, SHOT_RANGE);
        let range = worldRange;
        // Where the same ray ends against the map alone, for players who must not learn about the hit.
        // Taken now: `eye` is scratch that the hit's consequences (a bomb drop's sight test) reuse.
        const worldTo: Vec3 = [eye[0] + dir[0] * worldRange, eye[1] + dir[1] * worldRange, eye[2] + dir[2] * worldRange];
        let victim: Player | undefined;
        let zone: HitZone = 'torso';
        for (const other of this.players.values()) {
            if (other === shooter || !other.alive || other.team === shooter.team) continue;
            this.rewoundHull(other, viewTime);
            const t = rayBox(eye, dir, hmin, hmax);
            if (t < range) {
                range = t;
                victim = other;
                // Where on the (rewound) body it landed: shared/zones.ts.
                for (let k = 0; k < 3; k++) target[k] = eye[k] + dir[k] * t;
                zone = hitZone(target, feet, hmax[1] - hmin[1], dir);
            }
        }

        const slot = shooter.loadout.slot;
        const event: ShotEvent = {
            type: 'shot', shooter: shooter.id, weapon: slot,
            from: [eye[0], eye[1], eye[2]],
            to: [eye[0] + dir[0] * range, eye[1] + dir[1] * range, eye[2] + dir[2] * range]
        };
        if (victim) {
            const amount = zoneDamage(WEAPONS[slot], zone);
            event.victim = victim.id;
            event.zone = zone;
            event.damage = amount;
            if (this.damage(victim, amount, shooter, 'shot', slot, zone)) event.killed = true;
        }
        this.sendShot(shooter, victim, event, worldTo);
    }

    /**
     * A gunshot is a sound: heard within GUNSHOT_RANGE (GUNSHOT_RANGE_SUPPRESSED in a suppressed
     * room), like footsteps within theirs. Further away it is only seen, by players whose eye has a
     * clear line to the shooter's eye, and sent flagged silent. Nobody else receives it. Only
     * defenders shoot, and defenders are always known to everyone.
     *
     * The hit itself (`victim`, `zone`, `damage`, `killed`, and `to` on the victim's body) goes only to
     * the shooter, the victim, and players who know where the victim is (`knowsAbout`). Everyone else
     * gets the shot with `to` where it would have ended against the map alone (`worldTo`, the same ray
     * stopped by the map only), so the tracer passes through an unseen ghost. `knowsAbout` is evaluated after the hit
     * has been applied, with the hit's visibility spike, and a victim killed by it counted as still
     * alive: that is the test the next snapshot applies to a ghost standing there, so the shot event
     * tells nobody more, and nobody less, than the snapshot sent 1/30 s later would. The kill feed
     * reaches everyone through the `kill` message.
     */
    private sendShot(shooter: Player, victim: Player | undefined, event: ShotEvent, worldTo: Vec3): void {
        const range = this.options.suppressed ? GUNSHOT_RANGE_SUPPRESSED : GUNSHOT_RANGE;
        const from = event.from;
        let silent: ShotEvent | undefined, bare: ShotEvent | undefined, bareSilent: ShotEvent | undefined;
        for (const p of this.players.values()) {
            const involved = p === shooter || p === victim;
            const heard = involved || dist(p.state.pos, shooter.state.pos) <= range;
            if (!heard && !this.lineClear(p.state.pos[0], p.eyeY, p.state.pos[2], from[0], from[1], from[2])) continue;
            if (!victim || involved || this.knowsAbout(p, victim, true)) {
                p.conn.send(heard ? event : (silent ??= { ...event, silent: true }));
                continue;
            }
            bare ??= { type: 'shot', shooter: event.shooter, weapon: event.weapon, from: event.from, to: worldTo };
            p.conn.send(heard ? bare : (bareSilent ??= { ...bare, silent: true }));
        }
    }


    /**
     * Resolves a knife swing, a ghost's or a defender's: the nearest enemy inside the reach and cone,
     * not behind a wall, against the same lag-compensated positions shots use. Defenders' knives hit
     * for less (DEFENDER_KNIFE); zones do not apply to the knife.
     */
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
            const defender = attacker.team === 'defenders';
            const amount = backstab
                ? (defender ? DEFENDER_KNIFE.backstabDamage : KNIFE_BACKSTAB_DAMAGE)
                : (defender ? DEFENDER_KNIFE.damage : KNIFE_DAMAGE);
            event.victim = victim.id;
            event.damage = amount;
            event.backstab = backstab;
            if (this.damage(victim, amount, attacker, backstab ? 'backstab' : 'knife')) event.killed = true;
        }
        // Heard within knife range. Who was hit is told only to the two players involved and to those
        // who already know where the victim is: a defender's slash must not point out a ghost to the
        // other defenders nearby (a ghost's victim is a defender, whom everyone knows about anyway).
        let bare: SlashEvent | undefined;
        for (const p of this.players.values()) {
            if (p !== attacker && p !== victim && dist(p.state.pos, attacker.state.pos) > KNIFE_SOUND_RANGE) continue;
            if (!victim || p === attacker || p === victim || this.knowsAbout(p, victim)) p.conn.send(event);
            else p.conn.send(bare ??= { type: 'slash', attacker: event.attacker, pos: event.pos });
        }
    }

    /** Advances server time by one tick. `now` is ms since the match started. */
    tick(now: number): void {
        this.now = now;
        this.tickCount++;
        this.stepBots();
        for (const p of this.players.values()) {
            if (p.credits < MAX_CMD_CREDITS) p.credits++;
            if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt) this.spawn(p);
            if (p.team === 'ghosts') {
                p.vis = p.alive ? stepVis(p.vis, ghostVisTarget(horizontalSpeed(p.state)), TICK_DT) : 0;
                if (p.spawnAt && p.alive) p.vis = 1; // practice targets are shown in full, still or not
            }
            p.record(now);
        }
        if (this.rounds) this.updateRound();
        this.stepKickVote();
        if (this.rosterDirty) this.sendRoster();
        if (this.tickCount % SNAPSHOT_EVERY === 0) this.sendSnapshots();
    }

    private setPhase(phase: Phase, duration: number): void {
        this.phase = phase;
        this.phaseEndsAt = duration > 0 ? this.now + duration : 0;
        this.broadcast(this.roundMsg());
    }

    private startRound(): void {
        if (this.roundsPlayed === 0 && !this.held) this.resetMatch(); // a fresh match: nothing carries over from warmup
        this.held = false; // a held match resumes here with its score, sides and statistics
        this.startRequested = false;
        this.bomb = null;
        this.winner = this.reason = undefined;
        this.summary = null;
        this.spawnCursor.ghosts = this.spawnCursor.defenders = 0;
        this.fillWithBots(true); // people who joined during the last round take bots' places now
        const nav = this.nav;
        if (nav) {
            const sites = Math.max(1, siteNodes(this.map, nav).length);
            const rng = this.rngForBots();
            this.teamSites.ghosts = rng.int(sites);
            this.teamSites.defenders = rng.int(sites);
        }
        for (const p of this.players.values()) {
            p.ready = false;
            p.hurtBy.clear();
            p.changedThisRound = false;
            p.inRound = !p.idle;
            if (!p.idle) this.spawn(p);
        }
        this.clearBomb();
        this.assignCarrier();
        this.setPhase('freeze', FREEZE_MS);
        // A fresh carrier and no dropped bomb: ghosts are told who has it, defenders that nothing is in sight.
        for (const p of this.players.values()) {
            p.bombShown = null;
            p.conn.send(p.team === 'ghosts' ? this.ghostBombMsg('assign', this.carrierId) : { type: 'bomb', dropped: null });
        }
        this.sendRoster();
    }

    /**
     * Back to warmup because a team is empty. A match in progress is held for GRACE_MS (score, rounds,
     * sides, statistics) and resumes by itself once both teams have a player again.
     */
    private toWarmup(hold: boolean): void {
        this.bomb = null;
        this.clearBomb(); // warmup has no bomb
        for (const p of this.players.values()) {
            p.bombShown = null;
            p.conn.send(p.team === 'ghosts' ? this.ghostBombMsg() : { type: 'bomb', dropped: null });
        }
        this.startRequested = false;
        if (hold) { this.held = true; this.graceUntil = this.now + GRACE_MS; }
        else this.resetMatch();
        for (const p of this.players.values()) {
            p.ready = false;
            p.inRound = false;
            if (!p.alive && !p.idle) this.spawn(p);
        }
        this.setPhase('warmup', 0);
        this.sendRoster();
    }

    private plant(p: Player): void {
        p.actionTicks = 0;
        this.bomb = [...p.state.pos] as Vec3;
        p.stats.plants++;
        this.clearBomb(); // planted: nobody carries it any more
        this.setPhase('planted', BOMB_MS);
        this.sendBombToGhosts();
    }

    private endRound(winner: Team, reason: RoundReason): void {
        this.winner = winner;
        this.reason = reason;
        this.roundsPlayed++;
        const group = winner === 'ghosts' ? this.ghostGroup : 1 - this.ghostGroup;
        this.matchOver = ++this.score[group] >= this.options.roundsToWin;
        this.countQuietRounds();
        this.setPhase('over', this.matchOver ? MATCH_OVER_MS : OVER_MS);
        this.sendRoster();
        if (this.matchOver) {
            this.summary = {
                type: 'summary', winner, nextAt: this.phaseEndsAt, mvp: 0, players: this.rosterEntries(),
                score: { ghosts: this.score[this.ghostGroup], defenders: this.score[1 - this.ghostGroup] }
            };
            this.summary.mvp = pickMvp(this.summary.players);
            this.broadcast(this.summary);
            this.openMapVote();
        }
    }

    /** Zeroes the score and every player's statistics. */
    private resetMatch(): void {
        this.score[0] = this.score[1] = 0;
        this.roundsPlayed = 0;
        this.matchOver = false;
        this.summary = null;
        this.setGhostGroup(0);
        this.held = false;
        this.departed.clear();
        for (const p of this.players.values()) { p.stats = emptyStats(); p.hurtBy.clear(); p.quietRounds = 0; }
    }

    /** Flips which side plays ghosts and tells every player its new role. */
    private setGhostGroup(group: 0 | 1): void {
        this.ghostGroup = group;
        for (const p of this.players.values()) p.team = this.teamOf(p.group);
    }

    /** The round state machine: decides when rounds start, who has won, and when sides swap. */
    private updateRound(): void {
        // A carrier who is gone, dead or sitting out lets go of the bomb where they stood.
        if (this.carrierId !== 0) {
            const c = this.players.get(this.carrierId);
            if (!c) this.carrierId = 0;
            else if (!c.alive || c.idle || c.team !== 'ghosts') this.dropBomb(c, 'lost');
        }
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
                if (this.held && this.now >= this.graceUntil) this.resetMatch(); // too long: a fresh lobby
                if (playable && (this.held || !this.lobby || this.startRequested || this.everyoneReady())) this.startRound();
                break;
            case 'freeze':
                if (!playable) this.toWarmup(true);
                else if (expired) this.setPhase('live', ROUND_MS);
                break;
            case 'live':
                if (!playable) this.toWarmup(true);
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
                if (this.matchOver && !this.mapDecided && this.now >= this.phaseEndsAt - MAP_VOTE_LEAD_MS) this.closeMapVote();
                if (!expired) break;
                const finished = this.matchOver;
                if (finished) this.resetMatch(); // rematch: same room and map, groups kept
                else if (this.roundsPlayed === halftimeRound(this.options.roundsToWin)) {
                    this.setGhostGroup((1 - this.ghostGroup) as 0 | 1);
                }
                if (playable) this.startRound();
                else this.toWarmup(!finished);
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
    private knowsAbout(viewer: Player, other: Player, assumeAlive = false): boolean {
        if (other.team === viewer.team || other.team === 'defenders') return true;
        if (!other.alive && !assumeAlive) return false;
        const a = viewer.state.pos, b = other.state.pos;
        if (dist(a, b) <= BREATH_RANGE) return true; // close enough to hear breathing
        if (other.vis < VIS_SEND_THRESHOLD) return false;
        return this.lineClear(a[0], viewer.eyeY, a[2], b[0], b[1] + other.height - 0.1, b[2]) ||
            this.lineClear(a[0], viewer.eyeY, a[2], b[0], b[1] + other.height * 0.5, b[2]);
    }

    /** What others see of a player's weapon: which one, and whether it is busy or aimed. */
    private weaponView(p: Player): Pick<PlayerSnap, 'weapon' | 'reloading' | 'switching' | 'aiming'> {
        const armed = p.alive && p.team === 'defenders';
        return {
            weapon: armed ? p.loadout.slot : 0,
            reloading: armed && (heldGun(p.loadout)?.reload ?? 0) > 0,
            switching: armed && p.loadout.draw > 0,
            aiming: armed && aimFraction(p.loadout) > 0.5
        };
    }

    private sendSnapshots(): void {
        const snaps = new Map<Player, PlayerSnap>();
        for (const p of this.players.values()) {
            snaps.set(p, {
                id: p.id, team: p.team, pos: p.state.pos, yaw: p.yaw, pitch: p.pitch,
                crouched: p.state.crouched, alive: p.alive, vis: p.vis,
                ...this.weaponView(p)
            });
        }
        if (this.dropped) this.updateBombSight(); // defenders gain and lose sight of a dropped bomb as anyone moves
        for (const p of this.players.values()) {
            const players: PlayerSnap[] = [];
            for (const [other, snap] of snaps) if (other !== p && this.knowsAbout(p, other)) players.push(snap);
            p.conn.send({
                type: 'snap', time: this.now, ack: p.lastSeq,
                me: {
                    team: p.team,
                    actionTicks: p.actionTicks,
                    pos: p.state.pos, vel: p.state.vel, onGround: p.state.onGround, crouched: p.state.crouched,
                    health: p.health, armor: p.armor, alive: p.alive, respawnAt: p.respawnAt, vis: p.vis, loadout: p.loadout, knife: p.knife,
                    carry: p.carry
                },
                players
            });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Community: room options, vote to kick, map vote. The rules live in votes.ts, namefilter.ts and
    // shared/room-options.ts; this is the glue that sends and acts. Nothing here is predicted.
    // -----------------------------------------------------------------------------------------

    /** Connected human players: the only ones who count for votes. */
    private presentIds(): number[] {
        const ids: number[] = [];
        for (const p of this.players.values()) if (!p.bot) ids.push(p.id);
        return ids;
    }

    /** The creator changes the room's options, in warmup only. Invalid fields keep their current value. */
    private changeOptions(p: Player, raw: Partial<Record<keyof RoomOptions, unknown>>): void {
        if (p.id !== this.creatorId) { this.notice(p, 'Only the room creator can change the options.'); return; }
        if (this.phase !== 'warmup' || this.matchInProgress()) { this.notice(p, 'Options can only be changed before the match starts.'); return; }
        const next = cleanRoomOptions(raw, this.options);
        const people = this.humanCount();
        if (next.maxPlayers < people) { this.notice(p, `There are already ${people} players in the room.`); return; }
        if ((Object.keys(next) as (keyof RoomOptions)[]).every(k => next[k] === this.options[k])) return;
        const level = next.botLevel !== this.options.botLevel;
        this.options = next;
        this.broadcast({ type: 'options', options: { ...next } });
        if (level) for (const b of [...this.players.values()]) if (b.filler) this.leave(b.id); // new bots at the new level
        this.fillWithBots(true);
    }

    private kickInfo(viewer: Player): KickVoteInfo | null {
        const a = this.kickVote.active;
        if (!a) return null;
        const { yes, no, needed } = this.kickVote.tally(this.presentIds());
        return {
            target: a.target, targetName: this.players.get(a.target)?.name ?? '', caller: a.caller,
            callerName: this.players.get(a.caller)?.name ?? '', yes, no, needed, endsAt: a.endsAt,
            mine: viewer.id === a.target ? null : (a.votes.get(viewer.id) ?? null)
        };
    }

    private sendKickVote(): void {
        for (const p of this.players.values()) p.conn.send({ type: 'kickvote', vote: this.kickInfo(p) });
    }

    private startKickVote(p: Player, target: number): void {
        const refusal = this.kickVote.start(p.id, target, this.now, this.presentIds());
        if (refusal) { this.notice(p, refusal); return; }
        this.lastKickSig = '';
        this.stepKickVote();
    }

    /** Decides the running vote if it can be decided, and tells everyone when its count changed. Every tick and after every answer. */
    private stepKickVote(): void {
        const a = this.kickVote.active;
        if (!a) return;
        const outcome = this.kickVote.step(this.now, this.presentIds());
        if (outcome) {
            const target = this.players.get(outcome.target);
            this.lastKickSig = '';
            this.sendKickVote(); // vote is now null: closes the banner
            if (outcome.result === 'passed' && target) {
                for (const p of this.players.values()) this.notice(p, `${target.name} was removed from the room by a vote.`);
                this.removeFromRoom(target, 'You were removed from this room by a vote. You cannot rejoin it for 10 minutes.');
            } else if (outcome.result === 'failed' && target) {
                for (const p of this.players.values()) this.notice(p, `The vote to remove ${target.name} failed.`);
            }
            return;
        }
        const { yes, no, needed } = this.kickVote.tally(this.presentIds());
        const sig = `${a.target}:${yes}:${no}:${needed}`;
        if (sig === this.lastKickSig) return;
        this.lastKickSig = sig;
        this.sendKickVote();
    }

    /** In a room of two, the creator removes the other player straight away (warmup only). */
    private removePlayer(p: Player, target: number): void {
        const t = this.players.get(target);
        if (p.id !== this.creatorId) { this.notice(p, 'Only the room creator can remove a player.'); return; }
        if (this.humanCount() !== 2 || this.phase !== 'warmup' || this.matchInProgress()) {
            this.notice(p, 'You can remove a player directly only in warmup, in a room of two. With more players, call a vote.'); return;
        }
        if (!t || t === p || t.bot) return;
        this.removeFromRoom(t, 'The room creator removed you from this room. You cannot rejoin it for 10 minutes.');
    }

    /** Bans the player's address and name, tells them why, closes their connection and drops them from the room. */
    private removeFromRoom(p: Player, reason: string): void {
        this.bans.add(p.conn.ip, p.baseName, this.now);
        this.notice(p, reason);
        p.conn.close?.(reason);
        this.leave(p.id);
    }

    private mapChoices(): { id: string; name: string }[] {
        const out: { id: string; name: string }[] = [];
        const installed: ReadonlyMap<string, MapData> = this.maps ?? new Map([[this.map.name, this.map]]);
        for (const [id, m] of installed) out.push({ id, name: m.displayName ?? m.name });
        if (!out.some(m => m.id === this.map.name)) out.unshift({ id: this.map.name, name: this.map.displayName ?? this.map.name });
        return out;
    }

    private mapVoteMsg(viewer: Player): MapVoteMsg {
        const choices = this.mapChoices();
        const counts = this.mapVote.counts(choices.map(c => c.id), this.presentIds());
        const msg: MapVoteMsg = {
            type: 'mapvote', current: this.map.name, mine: this.mapVote.mine(viewer.id), closesAt: this.phaseEndsAt - MAP_VOTE_LEAD_MS,
            maps: choices.map(c => ({ ...c, votes: counts.get(c.id) ?? 0 }))
        };
        if (this.mapDecided) msg.next = this.map.name; // the map is swapped before this goes out, so `current` is the next map
        return msg;
    }

    private sendMapVote(): void {
        for (const p of this.players.values()) p.conn.send(this.mapVoteMsg(p));
    }

    /** The result card appears: everyone may now pick the next map. */
    private openMapVote(): void {
        this.mapVote.clear();
        this.mapDecided = false;
        this.sendMapVote();
    }

    private castMapVote(p: Player, map: string): void {
        if (!this.summary || this.phase !== 'over' || this.mapDecided) return;
        if (!this.mapChoices().some(c => c.id === map)) return;
        this.mapVote.pick(p.id, map);
        this.sendMapVote();
    }

    /** MAP_VOTE_LEAD_MS before the next match: the most-voted map wins (ties and no votes keep the current one). */
    private closeMapVote(): void {
        this.mapDecided = true;
        const choices = this.mapChoices();
        const winner = this.mapVote.winner(this.map.name, choices.map(c => c.id), this.presentIds());
        if (winner !== this.map.name) this.swapMap(winner);
        this.sendMapVote(); // carries `next`; after a swap `current` is already the new map
    }

    /**
     * Moves the room to another installed map between matches. Nothing in `Game` caches map data (spawns,
     * boxes and sites are read from `this.map` at use), so swapping the reference is enough; what must be
     * reset is the state tied to the old map: the planted bomb, spawn rotation and everyone's position.
     * Players are marked dead until the next round start spawns them on the new map (commands from a dead
     * player are ignored, so nothing is simulated against the new boxes with an old position).
     */
    private swapMap(id: string): void {
        const next = this.maps?.get(id);
        if (!next) return;
        this.map = next;
        this.bomb = null;
        this.clearBomb(); // a bomb dropped on the old map does not follow the room to the new one
        this.spawnCursor.ghosts = this.spawnCursor.defenders = 0;
        for (const p of this.players.values()) { p.alive = false; p.respawnAt = 0; p.actionTicks = 0; }
        this.broadcast({ type: 'map', map: next.name, mapName: next.displayName ?? next.name });
        this.sendRoster();
    }
}
