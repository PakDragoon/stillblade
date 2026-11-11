import type { Team } from '@shared/protocol';
import type { Box, Vec3 } from '@shared/types';
import type { RemoteView } from './presenter-api';

/** What the audio engine needs to know about the listener each frame. */
export interface ListenerView {
    /** Eye position. */
    pos: Vec3;
    /** Radians about +Y; 0 faces -Z. */
    yaw: number;
    /** Radians, positive looks up. */
    pitch: number;
    team: Team;
    alive: boolean;
}

/**
 * All game sound. Positions are world space (Y up, metres). Position vectors passed in are only
 * valid during the call. Every method must be safe to call before `unlock()` (it just stays silent).
 */
export interface AudioEngine {
    /** Call from a user gesture (click or key press); browsers block audio until then. */
    unlock(): void;
    /**
     * Every rendered frame: moves the listener, and runs one looping breathing emitter for each
     * living ENEMY ghost in `remotes` (starting, moving and stopping them as ghosts come and go).
     * `remotes` is reused between frames: do not keep references to it.
     */
    frame(dt: number, listener: ListenerView, remotes: readonly RemoteView[]): void;
    /** A footstep. `loud` is 0..1 (1 running, about 0.3 walking, about 0.18 crouched). */
    step(pos: Vec3, loud: number, isLocal: boolean): void;
    /** A silenced gunshot at the shooter's position. */
    gunshot(pos: Vec3, isLocal: boolean): void;
    /** A bullet striking a surface at `pos`. */
    impact(pos: Vec3): void;
    /** A knife being drawn back: the warning a defender gets before a slash. */
    knifeWindup(pos: Vec3, isLocal: boolean): void;
    /** A knife swing landing; `hit` when it connected with a player. */
    knifeSlash(pos: Vec3, hit: boolean, isLocal: boolean): void;
    /** The local player was hurt (non-positional). */
    hurt(): void;
}

/** `boxes` is the map's solid geometry, for occlusion tests. */
export type CreateAudio = (boxes: readonly Box[]) => AudioEngine;
