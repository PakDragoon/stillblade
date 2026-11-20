/**
 * Package W: match records. A passive `GameObserver` (server/src/game-events.ts) that writes one JSON line
 * per round end, per match end and per abandoned match to `matches/<YYYY-MM>.jsonl` in the data folder.
 * Server only: nothing here is ever sent to a player.
 *
 * Kept: room code, map, room options, sides and score, how each round ended and how long it took, the plant
 * and the defuse (who, where, when), every kill (when, who, with what, where on the body, both positions,
 * distance), and per player the shown (already filtered) name, team, bot flag, damage dealt and taken and
 * whether they were alive at the end; at match end every player's statistics and the MVP.
 * Never kept: addresses, chat, report texts. Warmup, practice rooms and anything after a round was decided
 * (the "over" phase) are not recorded.
 */
import type { DamageSplit } from '../../shared/armor';
import type { DamageKind, MatchStats, SummaryMsg, Team } from '../../shared/protocol';
import type { RoundReason } from '../../shared/rules';
import type { Vec3 } from '../../shared/types';
import { WEAPONS } from '../../shared/weapons';
import type { HitZone } from '../../shared/zones';
import { monthOf } from './datastore';
import type { Game, Player } from './game';
import type { GameObserver } from './game-events';

export interface KillRecord {
    /** Seconds since the round went live. */
    at: number;
    killer: number;
    killerName: string;
    killerTeam: Team;
    victim: number;
    victimName: string;
    /** 'rifle', 'pistol', 'knife' (a defender's) or 'ghost knife'. */
    weapon: string;
    kind: DamageKind;
    zone?: HitZone;
    killerPos: Vec3;
    victimPos: Vec3;
    /** Metres between the two at the moment of the kill. */
    dist: number;
}

export interface ObjectiveRecord {
    by: number;
    name: string;
    /** Bomb site name ('' if the spot is in none). */
    site: string;
    pos: Vec3;
    /** Seconds since the round went live. */
    at: number;
}

export interface RoundPlayerRecord {
    id: number;
    name: string;
    team: Team;
    /** The fixed side (0 or 1) the player joined; `team` is the role it played this round. */
    side: 0 | 1;
    bot: boolean;
    damageDealt: number;
    damageTaken: number;
    alive: boolean;
    /** Left the room during the round. */
    left?: boolean;
}

/** Every line starts with these. */
export interface LineBase {
    /** When the line was written (ISO, UTC). */
    time: string;
    /** When its match began (ISO, UTC): the room and this name the match. */
    started: string;
    room: string;
    map: string;
    options: Record<string, unknown>;
}

export interface RoundRecord extends LineBase {
    type: 'round';
    round: number;
    /** Which side (0 or 1) played ghosts this round. */
    ghostSide: 0 | 1;
    winner: Team;
    reason: RoundReason;
    /** Seconds from the round going live to its end. */
    seconds: number;
    /** Score after this round, by role this round and by fixed side. */
    score: Record<Team, number>;
    sideScore: [number, number];
    plant: ObjectiveRecord | null;
    defuse: ObjectiveRecord | null;
    kills: KillRecord[];
    players: RoundPlayerRecord[];
}

export interface MatchPlayerRecord extends MatchStats {
    id: number;
    name: string;
    team: Team;
    side: 0 | 1;
    bot: boolean;
}

export interface MatchRecord extends LineBase {
    type: 'match';
    rounds: number;
    winner: Team;
    winnerSide: 0 | 1;
    /** Final score by the roles played in the last round, and by fixed side. */
    score: Record<Team, number>;
    sideScore: [number, number];
    /** Game seconds from the match start to its end. */
    seconds: number;
    mvp: number;
    mvpName: string;
    players: MatchPlayerRecord[];
    /** The input recording of this match (a file in recordings/), or null. */
    recording: string | null;
}

export interface AbandonedRecord extends LineBase {
    type: 'abandoned';
    why: string;
    rounds: number;
    sideScore: [number, number];
    seconds: number;
    recording: string | null;
}

export type MatchLogLine = RoundRecord | MatchRecord | AbandonedRecord;

/** Where finished lines go (the data folder in the server; an array in tests). */
export type MatchLineSink = (month: string, line: MatchLogLine) => void;

const r2 = (v: number): number => Math.round(v * 100) / 100;
const pos2 = (p: Vec3): Vec3 => [r2(p[0]), r2(p[1]), r2(p[2])];

/** What killed: a gun's id, or the knife of the attacker's side. */
export function weaponName(attackerTeam: Team, kind: DamageKind, weapon?: number): string {
    if (kind === 'shot') return WEAPONS[weapon ?? -1]?.id ?? `slot ${weapon}`;
    return attackerTeam === 'ghosts' ? 'ghost knife' : 'knife';
}

/** The bomb site containing `pos` ('' when none does). */
export function siteAt(game: Game, pos: Vec3): string {
    for (const s of game.map.bombSites) {
        if (pos[0] >= s.min[0] && pos[0] <= s.max[0] && pos[1] >= s.min[1] - 0.01 && pos[1] <= s.max[1] && pos[2] >= s.min[2] && pos[2] <= s.max[2]) return s.name;
    }
    return '';
}

interface Taking { name: string; team: Team; side: 0 | 1; bot: boolean; dealt: number; taken: number; left: boolean }

export class MatchLog implements GameObserver {
    private inMatch = false;
    private matchStartedAt = 0;
    /** Wall-clock start of the match (ISO): with the room, what groups a match's lines. */
    private started = '';
    /** The round is being played (live or planted): kills and damage count. */
    private roundOn = false;
    private liveAt = 0;
    private kills: KillRecord[] = [];
    private plantRec: ObjectiveRecord | null = null;
    private defuseRec: ObjectiveRecord | null = null;
    private readonly taking = new Map<number, Taking>();

    /**
     * `sink` receives every finished line; `clock` is wall-clock ms (only for the `time` field and the month
     * file); `recording` names the match's recording file, if any.
     */
    constructor(
        private readonly sink: MatchLineSink,
        private readonly clock: () => number = () => Date.now(),
        private readonly recording: () => string | null = () => null
    ) {}

    private base(game: Game): LineBase {
        return { time: new Date(this.clock()).toISOString(), started: this.started, room: game.code, map: game.map.name, options: { ...game.options } };
    }

    private emit(line: MatchLogLine): void {
        this.sink(monthOf(this.clock()), line);
    }

    matchStart(game: Game): void {
        this.inMatch = true;
        this.matchStartedAt = game.now;
        this.started = new Date(this.clock()).toISOString();
        this.roundOn = false;
    }

    roundStart(game: Game): void {
        if (!this.inMatch) return;
        this.kills = [];
        this.plantRec = this.defuseRec = null;
        this.taking.clear();
        for (const p of game.players.values()) if (p.inRound) this.taking.set(p.id, this.takingOf(p));
        this.roundOn = false;
    }

    private takingOf(p: Player): Taking {
        return { name: p.name, team: p.team, side: p.group, bot: p.bot, dealt: 0, taken: 0, left: false };
    }

    phase(game: Game, phase: string): void {
        if (!this.inMatch) return;
        if (phase === 'live') { this.roundOn = true; this.liveAt = game.now; }
        else if (phase !== 'planted') this.roundOn = false;
    }

    leave(_game: Game, p: Player): void {
        const t = this.taking.get(p.id);
        if (t && this.roundOn) t.left = true;
    }

    hit(_game: Game, victim: Player, attacker: Player, split: DamageSplit): void {
        if (!this.roundOn) return;
        const removed = split.health + split.armor;
        const a = this.taking.get(attacker.id), v = this.taking.get(victim.id);
        if (a) a.dealt += removed;
        if (v) v.taken += removed;
    }

    kill(game: Game, victim: Player, attacker: Player, kind: DamageKind, weapon?: number, zone?: HitZone): void {
        if (!this.roundOn) return;
        const a = attacker.state.pos, v = victim.state.pos;
        const k: KillRecord = {
            at: r2((game.now - this.liveAt) / 1000), killer: attacker.id, killerName: attacker.name, killerTeam: attacker.team,
            victim: victim.id, victimName: victim.name, weapon: weaponName(attacker.team, kind, weapon), kind,
            killerPos: pos2(a), victimPos: pos2(v), dist: r2(Math.hypot(a[0] - v[0], a[1] - v[1], a[2] - v[2]))
        };
        if (zone !== undefined) k.zone = zone;
        this.kills.push(k);
    }

    plant(game: Game, p: Player, pos: Vec3): void {
        if (!this.roundOn) return;
        this.plantRec = { by: p.id, name: p.name, site: siteAt(game, pos), pos: pos2(pos), at: r2((game.now - this.liveAt) / 1000) };
    }

    defuse(game: Game, p: Player): void {
        if (!this.roundOn) return;
        const pos = p.state.pos;
        this.defuseRec = { by: p.id, name: p.name, site: siteAt(game, pos), pos: pos2(pos), at: r2((game.now - this.liveAt) / 1000) };
    }

    roundEnd(game: Game, winner: Team, reason: RoundReason): void {
        if (!this.inMatch) return;
        const ghostSide = game.ghostGroup;
        const players: RoundPlayerRecord[] = [];
        for (const [id, t] of this.taking) {
            const p = game.players.get(id);
            const rec: RoundPlayerRecord = {
                id, name: t.name, team: t.team, side: t.side, bot: t.bot, damageDealt: t.dealt, damageTaken: t.taken,
                alive: !!p && p.alive
            };
            if (t.left || !p) rec.left = true;
            players.push(rec);
        }
        this.emit({
            type: 'round', ...this.base(game), round: game.roundsPlayed, ghostSide, winner, reason,
            seconds: r2((game.now - this.liveAt) / 1000),
            score: { ghosts: game.score[ghostSide], defenders: game.score[1 - ghostSide] },
            sideScore: [game.score[0], game.score[1]],
            plant: this.plantRec, defuse: this.defuseRec, kills: this.kills, players
        });
        this.kills = [];
        this.roundOn = false;
    }

    matchEnd(game: Game, summary: SummaryMsg): void {
        if (!this.inMatch) return;
        this.inMatch = false;
        const players: MatchPlayerRecord[] = summary.players.map(e => {
            const p = game.players.get(e.id);
            return {
                id: e.id, name: e.name, team: e.team, side: p?.group ?? 0, bot: e.bot,
                kills: e.kills, deaths: e.deaths, assists: e.assists, headshots: e.headshots, backstabs: e.backstabs,
                damage: e.damage, plants: e.plants, defuses: e.defuses
            };
        });
        const mvp = summary.players.find(e => e.id === summary.mvp);
        const winnerSide = (summary.winner === 'ghosts' ? game.ghostGroup : 1 - game.ghostGroup) as 0 | 1;
        this.emit({
            type: 'match', ...this.base(game), rounds: game.roundsPlayed, winner: summary.winner, winnerSide,
            score: { ...summary.score }, sideScore: [game.score[0], game.score[1]],
            seconds: r2((game.now - this.matchStartedAt) / 1000), mvp: summary.mvp, mvpName: mvp?.name ?? '',
            players, recording: this.recording()
        });
    }

    matchAbandoned(game: Game, why: string): void {
        if (!this.inMatch) return;
        this.inMatch = false;
        this.roundOn = false;
        this.emit({
            type: 'abandoned', ...this.base(game), why, rounds: game.roundsPlayed, sideScore: [game.score[0], game.score[1]],
            seconds: r2((game.now - this.matchStartedAt) / 1000), recording: this.recording()
        });
    }
}
