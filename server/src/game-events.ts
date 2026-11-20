/**
 * What `Game` tells an observer (package W): the match records (`matchlog.ts`) and the input recordings
 * (`recording.ts`) listen here. An observer is passive: it is called synchronously from inside the match,
 * must not change anything it is handed, must never send to a player, and must never throw or block (no
 * file I/O inside a call: buffer, and write later). `Game` itself stays free of file I/O.
 *
 * Every hook is optional. Players are passed live: copy what you keep.
 */
import type { DamageSplit } from '../../shared/armor';
import type { ClientMsg, DamageKind, NetCmd, SummaryMsg, Team } from '../../shared/protocol';
import type { Phase, RoundReason } from '../../shared/rules';
import type { Vec3 } from '../../shared/types';
import type { HitZone } from '../../shared/zones';
import type { Game, Player } from './game';

export interface GameObserver {
    /** `Game.tick(now)` has begun (`game.now` is already `now`); nothing has been simulated in it yet. */
    tickStart?(game: Game, now: number): void;
    /** `Game.tick` has finished: a safe point to hand buffered data to the writer. */
    tickEnd?(game: Game): void;
    /**
     * A command the server is about to simulate for `p` (it passed the order and credit checks, so it counts
     * as processed), exactly as received: before the server clamps any field. Bots' commands too.
     */
    cmd?(game: Game, p: Player, cmd: NetCmd): void;
    /** A JSON message from a player (never a command; chat and reports are passed too: observers must not keep their text). */
    message?(game: Game, p: Player, msg: ClientMsg): void;
    /** A player (person or bot) was added; called after they are in `game.players`. */
    join?(game: Game, p: Player): void;
    /** A player is leaving; called before they are removed from `game.players`. */
    leave?(game: Game, p: Player): void;
    /** `p` was just placed at a spawn (state, health, armor and loadout already reset). */
    spawn?(game: Game, p: Player): void;
    /** A warmup team switch (the round machinery's side swaps are `sidesSwapped`). */
    teamChange?(game: Game, p: Player): void;
    /** A landed hit, after the damage was applied (`split`: what it removed from health and armor; scratch, copy it). */
    hit?(game: Game, victim: Player, attacker: Player, split: DamageSplit, kind: DamageKind, weapon?: number, zone?: HitZone): void;
    /** The hit just reported by `hit` killed `victim`. */
    kill?(game: Game, victim: Player, attacker: Player, kind: DamageKind, weapon?: number, zone?: HitZone): void;
    /** A fresh match begins (score and statistics just reset); the first round's spawns follow in this call. */
    matchStart?(game: Game): void;
    /** A round's freeze has begun: everyone taking part is spawned and the carrier is chosen. */
    roundStart?(game: Game): void;
    /** The round phase changed (also warmup on a hold). */
    phase?(game: Game, phase: Phase): void;
    plant?(game: Game, p: Player, pos: Vec3): void;
    defuse?(game: Game, p: Player): void;
    /** A round was decided (score and `roundsPlayed` already updated). */
    roundEnd?(game: Game, winner: Team, reason: RoundReason): void;
    /** The match was decided; `summary` is the message every player gets. Called after `roundEnd`. */
    matchEnd?(game: Game, summary: SummaryMsg): void;
    /** A team emptied mid-match: the match is held in warmup for its players to come back. */
    matchHeld?(game: Game): void;
    /** A held match was given up (nobody came back in time); the room returns to its lobby. */
    matchAbandoned?(game: Game, why: 'hold expired' | 'room closed' | 'server stopped'): void;
    /** Halftime: the two sides swapped roles. */
    sidesSwapped?(game: Game): void;
}
