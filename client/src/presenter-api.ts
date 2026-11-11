import type * as pc from 'playcanvas';
import type { RosterEntry, Team } from '@shared/protocol';
import type { Phase, RoundReason } from '@shared/rules';
import type { Vec3 } from '@shared/types';

/** Another player, already interpolated for this frame. `pos` is the feet position. */
export interface RemoteView {
    id: number;
    team: Team;
    pos: Vec3;
    /** Radians about +Y; 0 faces -Z. */
    yaw: number;
    /** Radians, positive looks up. */
    pitch: number;
    crouched: boolean;
    alive: boolean;
    /**
     * Opacity 0..1 decided by the server: always 1 for defenders; for ghosts 0 when still, up to
     * about 0.35 at a run, with brief spikes (to 0.6-0.8) when swinging a knife or taking damage.
     */
    vis: number;
}

export interface LocalView {
    id: number;
    team: Team;
    health: number;
    alive: boolean;
    /** Seconds until respawn; 0 while alive. */
    respawnIn: number;
    connected: boolean;
    /** Round-trip time estimate in ms. */
    ping: number;
    /** True while the attack button is held. */
    firing: boolean;
    /** The local player's own visibility, same scale as RemoteView.vis. Only meaningful for ghosts. */
    vis: number;
    /** True when holding the use key (E) would plant (ghosts) or defuse (defenders) right now. */
    canAct: boolean;
    /** Plant or defuse progress 0..1; 0 when not doing either. */
    action: number;
    /** True while the scoreboard key (Tab) is held. */
    showScores: boolean;
}

/** The state of the match for this frame. */
export interface MatchView {
    /** See shared/rules.ts for what each phase means. */
    phase: Phase;
    /** Seconds left in the current phase (the bomb countdown during `planted`); 0 in warmup. */
    timeLeft: number;
    /** 1-based round number. */
    round: number;
    scoreGhosts: number;
    scoreDefenders: number;
    /** World position of the planted bomb (on the floor), or null. Stays set through `over` if it was planted. */
    bombPos: Vec3 | null;
    /** Who won the round; only during `over`. */
    winner: Team | null;
    reason: RoundReason | null;
    /** The round just won also decided the match. */
    matchOver: boolean;
}

export type KillKind = 'shot' | 'headshot' | 'knife' | 'backstab';

/**
 * Everything visual and on-screen that is not the map or the camera transform.
 * The game core calls these; the presenter never touches game state or the network.
 */
export interface Presenter {
    /** Every rendered frame. `remotes` is reused between frames: do not keep references to it. */
    frame(dt: number, local: LocalView, remotes: readonly RemoteView[], match: MatchView): void;
    /** The list of players changed (joins, leaves, kills, team swap). Used for the scoreboard and for names. */
    roster(players: readonly RosterEntry[]): void;
    /** A gun was fired from `from` to its end point `to` (world space). Vectors are only valid during the call. */
    shot(from: Vec3, to: Vec3, isLocal: boolean): void;
    /** The local player (a ghost) started a knife swing; it lands `windupSeconds` later. */
    knifeSwing(windupSeconds: number): void;
    /** The local player's attack hit someone. */
    hitConfirm(head: boolean, killed: boolean): void;
    /** The local player took damage. */
    damaged(amount: number): void;
    killFeed(killerId: number, victimId: number, kind: KillKind): void;
}

export type CreatePresenter = (app: pc.Application, camera: pc.Entity) => Presenter;
