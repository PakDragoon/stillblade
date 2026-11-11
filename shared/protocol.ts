import type { Phase, RoundReason } from './rules';
import type { InputCmd, Vec3 } from './types';

export const PROTOCOL_VERSION = 3;
export const DEFAULT_PORT = 8080;
/** Snapshots per second sent to each client. */
export const SNAPSHOT_RATE = 30;

export type Team = 'ghosts' | 'defenders';

/** One client tick: movement intent plus everything the server needs to resolve a shot. */
export interface NetCmd extends InputCmd {
    /** Monotonic per client; the server acknowledges the last one it simulated. */
    seq: number;
    /** View pitch in radians, positive looks up. */
    pitch: number;
    fire: boolean;
    /** Use key held: plant (ghosts) or defuse (defenders). */
    use: boolean;
    /** Server time (ms) at which this client was drawing other players: the lag-compensation target. */
    viewTime: number;
}

export interface PlayerSnap {
    id: number;
    team: Team;
    pos: Vec3;
    yaw: number;
    pitch: number;
    crouched: boolean;
    alive: boolean;
    /** Opacity 0..1: 1 for defenders, velocity-driven for ghosts. */
    vis: number;
}

export interface SelfSnap {
    /** Sides swap at halftime, so the team can change during a match. */
    team: Team;
    /** Plant or defuse progress, 0..1; 0 when not doing either. */
    action: number;
    /** The local player's own visibility (see PlayerSnap.vis). */
    vis: number;
    pos: Vec3;
    vel: Vec3;
    onGround: boolean;
    crouched: boolean;
    health: number;
    alive: boolean;
    /** Server time (ms) of the next respawn; meaningful only while dead. */
    respawnAt: number;
}

export interface ShotEvent {
    type: 'shot';
    shooter: number;
    from: Vec3;
    to: Vec3;
    /** Present when a player was hit. */
    victim?: number;
    head?: boolean;
    damage?: number;
    killed?: boolean;
}

/** A knife swing landing (or missing) after its windup. */
export interface SlashEvent {
    type: 'slash';
    attacker: number;
    pos: Vec3;
    victim?: number;
    damage?: number;
    backstab?: boolean;
    killed?: boolean;
}

/** A sound the recipient is close enough to hear. Never sent to players out of range. */
export interface SoundEvent {
    type: 'sound';
    kind: 'step' | 'windup';
    id: number;
    pos: Vec3;
    /** 0..1 loudness at the source. */
    loud: number;
}

/** The state of the round. Sent whenever it changes and to every player who joins. */
export interface RoundMsg {
    type: 'round';
    phase: Phase;
    /** Server time (ms) when this phase ends; 0 for warmup. */
    endsAt: number;
    /** 1-based number of the current round. */
    round: number;
    score: Record<Team, number>;
    /** Where the bomb sits once planted. */
    bomb: Vec3 | null;
    /** Set during `over`. */
    winner?: Team;
    reason?: RoundReason;
    /** The round just won also decided the match. */
    matchOver?: boolean;
}

export interface RosterEntry {
    id: number;
    name: string;
    team: Team;
    kills: number;
    deaths: number;
    alive: boolean;
}

export type ServerMsg =
    | { type: 'welcome'; version: number; id: number; team: Team; map: string; time: number }
    | { type: 'snap'; time: number; ack: number; me: SelfSnap; players: PlayerSnap[] }
    | { type: 'spawn'; pos: Vec3; yaw: number }
    | ShotEvent
    | SlashEvent
    | SoundEvent
    | RoundMsg
    | { type: 'roster'; players: RosterEntry[] };

export type ClientMsg = { type: 'cmd'; cmd: NetCmd };

// JSON for now; these four functions are the only place the wire format lives, so a binary
// encoding can replace it later without touching game code.
export const encodeServer = (m: ServerMsg): string => JSON.stringify(m);
export const decodeServer = (data: string): ServerMsg => JSON.parse(data) as ServerMsg;
export const encodeClient = (m: ClientMsg): string => JSON.stringify(m);
export const decodeClient = (data: string): ClientMsg => JSON.parse(data) as ClientMsg;
