import type { InputCmd, Vec3 } from './types';

export const PROTOCOL_VERSION = 1;
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
}

export interface SelfSnap {
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

export type ServerMsg =
    | { type: 'welcome'; version: number; id: number; team: Team; map: string; time: number }
    | { type: 'snap'; time: number; ack: number; me: SelfSnap; players: PlayerSnap[] }
    | { type: 'spawn'; pos: Vec3; yaw: number }
    | ShotEvent;

export type ClientMsg = { type: 'cmd'; cmd: NetCmd };

// JSON for now; these four functions are the only place the wire format lives, so a binary
// encoding can replace it later without touching game code.
export const encodeServer = (m: ServerMsg): string => JSON.stringify(m);
export const decodeServer = (data: string): ServerMsg => JSON.parse(data) as ServerMsg;
export const encodeClient = (m: ClientMsg): string => JSON.stringify(m);
export const decodeClient = (data: string): ClientMsg => JSON.parse(data) as ClientMsg;
