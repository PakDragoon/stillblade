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

/** A planted, ticking bomb. */
export interface BombView {
    pos: Vec3;
    /** Seconds until it explodes. */
    timeLeft: number;
}

/**
 * roundStart: the freeze ended and the round is live. planted / defused / exploded: bomb events.
 * win / lose: the local player's team won or lost the round.
 */
export type CueKind = 'roundStart' | 'planted' | 'defused' | 'exploded' | 'win' | 'lose';

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
     * While `bomb` is set, the bomb beeps from its position, faster as `timeLeft` runs down.
     */
    frame(dt: number, listener: ListenerView, remotes: readonly RemoteView[], bomb: BombView | null): void;
    /** A non-positional announcement for the local player. */
    cue(kind: CueKind): void;
    /** A footstep. `loud` is 0..1 (1 running, about 0.3 walking, about 0.18 crouched). */
    step(pos: Vec3, loud: number, isLocal: boolean): void;
    /**
     * A gunshot at the shooter's position from the gun in slot `weapon` (index into WEAPONS, shared/weapons.ts:
     * each gun has its own sound). `suppressed` (the room option): the quiet suppressed shot, fading to silence
     * at GUNSHOT_RANGE_SUPPRESSED; otherwise a loud, longer report fading out at GUNSHOT_RANGE (shared/constants.ts).
     */
    gunshot(pos: Vec3, isLocal: boolean, weapon: number, suppressed: boolean): void;
    /**
     * A defender started a reload at `pos` of the weapon in slot `weapon`: one call covers the whole
     * sequence, scheduled from the moment of the call and fitted to that weapon's reload time (rifle
     * about 2.2 s: magazine out, magazine in, bolt; pistol about 1.4 s: magazine out, magazine in, slide).
     */
    reload(pos: Vec3, isLocal: boolean, weapon: number): void;
    /**
     * The local player switched to the weapon in slot `weapon`: a gun, or SLOT_KNIFE for the knife (non-positional;
     * it is drawn over 0.25 to 0.4 s).
     */
    weaponSwitch(weapon: number): void;
    /** The local player pulled the trigger on an empty gun with no spare rounds (non-positional click). */
    dryFire(): void;
    /** A bullet striking a surface at `pos`. */
    impact(pos: Vec3): void;
    /** A knife being drawn back: the warning a defender gets before a slash. */
    knifeWindup(pos: Vec3, isLocal: boolean): void;
    /** A knife swing landing; `hit` when it connected with a player. */
    knifeSlash(pos: Vec3, hit: boolean, isLocal: boolean): void;
    /**
     * The bomb was dropped onto the floor (`drop`: a short thud) or picked up (`pickup`: a quiet rattle) at
     * `pos`. Heard within BOMB_SOUND_RANGE (shared/bomb.ts), about 8 m, fading to silence there.
     */
    bomb(kind: 'drop' | 'pickup', pos: Vec3, isLocal: boolean): void;
    /** The local player was hurt (non-positional). */
    hurt(): void;
    /** The local player's attack landed: a short tick, distinct for a headshot and a kill (non-positional). */
    hitMarker(kind: 'body' | 'head' | 'kill'): void;
    /** Player volume settings, each 0..1: everything scales with `master`; footsteps (heard or own) with `footsteps`, other sounds with `effects`. */
    setVolumes(v: { master: number; effects: number; footsteps: number }): void;
}

/** `boxes` is the map's solid geometry, for occlusion tests. */
export type CreateAudio = (boxes: readonly Box[]) => AudioEngine;
