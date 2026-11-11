import type * as pc from 'playcanvas';
import type { Team } from '@shared/protocol';
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
    /** True while the fire button is held and the weapon is cycling (for viewmodel recoil). */
    firing: boolean;
}

/**
 * Everything visual and on-screen that is not the map or the camera transform.
 * The game core calls these; the presenter never touches game state or the network.
 */
export interface Presenter {
    /** Every rendered frame. `remotes` is reused between frames: do not keep references to it. */
    frame(dt: number, local: LocalView, remotes: readonly RemoteView[]): void;
    /** A shot was fired from `from` to its end point `to` (world space). */
    shot(from: Vec3, to: Vec3, isLocal: boolean): void;
    /** The local player's shot hit someone. */
    hitConfirm(head: boolean, killed: boolean): void;
    /** The local player took damage. */
    damaged(amount: number): void;
    killFeed(killerId: number, victimId: number, head: boolean): void;
}

export type CreatePresenter = (app: pc.Application, camera: pc.Entity) => Presenter;
