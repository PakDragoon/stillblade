import type * as pc from 'playcanvas';
import type { DamageKind, RosterEntry, Team } from '@shared/protocol';
import type { Phase, RoundReason } from '@shared/rules';
import type { Box, Vec3 } from '@shared/types';
import type { HitZone } from '@shared/zones';
import type { Tier } from './graphics';
import type { MapLighting } from './lighting';
import type { LoadReporter } from './loading';
import type { LookTuning } from './maplook';

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
    /** A defender in the middle of a reload (rifle 2.2 s, pistol 1.4 s); always false for ghosts. */
    reloading: boolean;
    /**
     * Slot of the weapon a defender holds: an index into WEAPONS (shared/weapons.ts) for a gun, or
     * SLOT_KNIFE (2) for the defender knife. 0 for ghosts.
     */
    weapon: number;
    /** A defender drawing a weapon it just switched to (0.25 to 0.4 s). */
    switching: boolean;
    /** A defender aiming down sights. */
    aiming: boolean;
}

/** One carried weapon's ammunition, for the HUD's slot indicator. The knife slot has none (both 0). */
export interface WeaponSlotView {
    mag: number;
    reserve: number;
}

export interface LocalView {
    id: number;
    team: Team;
    health: number;
    /** The local player's own armor, 0..MAX_ARMOR (shared/armor.ts): shown next to health, dimmed at 0, flashing when it drops. */
    armor: number;
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
    /**
     * True when holding the use key (E) would plant (ghosts) or defuse (defenders) right now. For ghosts
     * only the bomb carrier can plant, so this is never true for a ghost without the bomb.
     */
    canAct: boolean;
    /** A living ghost carrying the bomb (show "You have the bomb"). Always false for defenders. */
    carrier: boolean;
    /**
     * A living ghost standing where the carrier could plant (in a site, on the ground, live round) without
     * the bomb: show "Only the bomb carrier can plant" instead of the plant prompt.
     */
    siteNoBomb: boolean;
    /** Plant or defuse progress 0..1; 0 when not doing either. */
    action: number;
    /** True while the scoreboard key (Tab) is held. */
    showScores: boolean;
    /**
     * Slot in hand: a gun (index into WEAPONS, shared/weapons.ts, which has each gun's id, label, magazine
     * size and timings) or SLOT_KNIFE (the defender knife, DEFENDER_KNIFE; `slotLabel` names any slot).
     * Defenders only; changes the moment a switch starts. Ignore for ghosts.
     */
    weapon: number;
    /** Every carried slot (SLOT_COUNT of them: the guns, then the knife), including the one in hand. Reused between frames. */
    weapons: readonly WeaponSlotView[];
    /** Gun in hand (ignore for ghosts and with the knife: all 0): rounds in the magazine, magazine capacity, spare rounds. */
    mag: number;
    magSize: number;
    reserve: number;
    /**
     * Reload progress 0..1 while reloading (0 at the start, nearing 1 as rounds go in); exactly 0 when
     * not reloading. Predicted, so it can jump back to 0 if the reload is cancelled (death, round reset).
     */
    reload: number;
    /**
     * The reload in progress is an empty reload (the magazine was empty: the rule's longer `reloadEmptyTicks`, and the
     * first person plays the empty clip with the bolt pulled); false when not reloading or for a tactical reload.
     */
    reloadEmpty: boolean;
    /** Current spread cone half-angle in radians (where shots may land around the crosshair centre). */
    spread: number;
    /** The local view yaw in radians (0 faces -Z): damage direction markers turn with it. */
    yaw: number;
    /** The local view pitch in radians (positive looks up), without recoil: the weapon trails how fast it changes. */
    pitch: number;
    /**
     * The local player's predicted velocity (m/s, world; reused between frames) and whether it stands on the ground
     * and is crouched: the first-person weapon bobs with the real speed and step, lifts on a jump, dips on landing and
     * tilts when crouched (package Q). Presentation only. Zero, true and false while dead or spectating.
     */
    vel: Vec3;
    onGround: boolean;
    crouched: boolean;
    /** While dead and following a living teammate: that player's name. Null otherwise. */
    spectating: string | null;
    /** Id of the teammate being followed (their body is not drawn: the camera is inside it), or -1. */
    spectateId: number;
    /** Dead with no living teammate to follow: the fixed overview of the map is shown. */
    overview: boolean;
    /**
     * Switch in progress: 1 on the frame the weapon was selected, falling to 0 when it can fire;
     * exactly 0 when not switching. The weapon in `weapon` is the one being raised.
     */
    draw: number;
    /**
     * Aim down sights 0 (hip) to 1 (fully aimed), smooth between ticks. The game core already narrows the
     * camera's field of view by it (by the zoom of the gun and, for the rifle, of its sight); the presenter brings
     * the weapon to the eye line and may shrink the crosshair.
     */
    aim: number;
    /**
     * The rifle sight this life uses (index into SIGHTS, shared/weapons.ts: iron, 1x red dot, 2x scope); fixed from
     * spawn to death. Drawn on the first-person rifle; while aiming the rifle with a red dot or scope, the presenter
     * shows its reticle or scope ring over the view, fading in with `aim`, and hides the hip crosshair. Only the
     * rifle takes sights (`WeaponDef.takesSights`). Ignore for ghosts.
     */
    sight: number;
}

export interface CrosshairConfig {
    style: 'dot' | 'cross' | 'ring';
    /** CSS colour. */
    color: string;
    /** Dot diameter in CSS px (a cross is four times, a ring three times as big). */
    size: number;
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
    /**
     * World position (on the floor) of a dropped bomb the local player knows about, or null: ghosts always
     * know where it lies; defenders only while it is in their line of sight. Never set together with a
     * planted `bombPos`. Drawn with the same model as the planted bomb, unlit.
     */
    droppedBomb: Vec3 | null;
    /**
     * Player id of the ghost carrying the bomb, for the scoreboard mark and the match bar; 0 when nobody
     * carries it or the local player is a defender (defenders are never told).
     */
    carrierId: number;
    /** Who won the round; only during `over`. */
    winner: Team | null;
    reason: RoundReason | null;
    /** The round just won also decided the match. */
    matchOver: boolean;
    /** Rounds a side needs to win this room's match (3, 6 or 9: the room option); the title of the scoreboard names it. */
    roundsToWin: number;
}

/** How a hit or kill was made (shared/protocol.ts); shots also come with the body zone they hit. */
export type KillKind = DamageKind;

/**
 * Everything visual and on-screen that is not the map or the camera transform.
 * The game core calls these; the presenter never touches game state or the network.
 */
export interface Presenter {
    /** Every rendered frame. `remotes` is reused between frames: do not keep references to it. */
    frame(dt: number, local: LocalView, remotes: readonly RemoteView[], match: MatchView): void;
    /**
     * The list of players changed (joins, leaves, kills, team swap, a spawn that mounted another sight). Used for the
     * scoreboard and for names, and `RosterEntry.sight` is the sight drawn on that player's rifle in third person.
     */
    roster(players: readonly RosterEntry[]): void;
    /**
     * A gun was fired from `from` to its end point `to` (world space) by the weapon in slot `weapon`
     * (index into WEAPONS). Vectors are only valid during the call.
     */
    shot(from: Vec3, to: Vec3, isLocal: boolean, weapon: number): void;
    /**
     * The room's suppressed-weapons option (welcome): true draws suppressors on both guns (first and third
     * person) and today's small muzzle flash; false draws bare muzzles and a large, bright flash. Called once
     * after joining, before any shot; may be called again.
     */
    setSuppressed(on: boolean): void;
    /** The local player (a ghost, or a defender holding the knife) started a knife swing; it lands `windupSeconds` later. */
    knifeSwing(windupSeconds: number): void;
    /**
     * Another player (by id) started a knife swing (the windup sound the server sends within earshot): a defender
     * holding the knife, or a ghost, starts its third-person swing. Players the presenter is not drawing are ignored.
     */
    remoteSwing(id: number): void;
    /**
     * Another player's knife swing landed (the server's slash event, hit or miss): its third-person swing strikes
     * now, whether or not its windup was seen. Ignored for players not drawn.
     */
    remoteSlash(id: number): void;
    /**
     * The map's solid boxes, the array the game simulates against (refilled in place when the room changes map).
     * Called once after creation. Used only for looks: a dead player's body is laid down where it does not go into
     * a wall.
     */
    setWorld(boxes: readonly Box[]): void;
    /**
     * The local player's attack hit someone. `zone` is where a shot landed (head, torso, arms or legs); null
     * for a knife hit. The marker looks different for a headshot, a limb (arms or legs) and a kill.
     */
    hitConfirm(zone: HitZone | null, killed: boolean): void;
    /**
     * The local player took damage. `bearing` is the world direction toward the attacker in radians
     * (yaw convention: 0 faces -Z), or NaN if unknown; it is drawn around the crosshair, turning with the view.
     */
    damaged(amount: number, bearing: number): void;
    /**
     * The local player was killed: shown as a recap line under the death message. `distance` in metres;
     * `zone` where the killing shot landed (null for the knife); `weapon` the gun's or knife's name if known.
     */
    died(killerName: string, kind: KillKind, zone: HitZone | null, distance: number, weapon?: string): void;
    /** Player crosshair choice (settings). */
    setCrosshair(c: CrosshairConfig): void;
    /**
     * A short line about the bomb for a ghost ("Ana has the bomb", "Bomb dropped", "Picked up by Ana"),
     * shown under the crosshair area for a few seconds. A newer one replaces it.
     */
    bombNotice(text: string): void;
    /**
     * Vote-kick on the scoreboard: when `kick` is set, every row of another human player gets a small "Vote out"
     * button that calls `kick(playerId)`; null (a vote cannot be called now) hides them. The buttons can be clicked
     * only while the mouse pointer is free.
     */
    setVoteKick(kick: ((playerId: number) => void) | null): void;
    /**
     * Every human player's round trip to the server in ms (`[player id, ms]`, measured by the server, sent every few
     * seconds): shown as the scoreboard's Ping column. Bots and players not listed show a dash.
     */
    setPings(pings: readonly [number, number][]): void;
    /** A kill anywhere in the room. `zone` as in `died`. */
    killFeed(killerId: number, victimId: number, kind: KillKind, zone: HitZone | null, weapon?: string): void;
    /**
     * The graphics tier (client/src/graphics.ts), set before the first frame and again whenever the setting changes.
     * Low: pooled particles and decals with tight caps, no realtime lights. High adds dynamic lights (muzzle flashes,
     * the bomb, the explosion) on the world and on players, soft blob shadows under players and floor clutter.
     */
    setTier(tier: Tier): void;
    /**
     * A map's look was applied (each map load, including a map change): the fog effects should match, and every
     * decal and particle of the previous map goes. The boxes given to `setWorld` already hold the new map.
     */
    setMapLook(tuning: LookTuning): void;
    /**
     * The map's lighting for players and weapons (client/src/lighting.ts: probes built from the map's own baked light,
     * and an environment generated from its sky), after each map load; null before one exists or if building it
     * failed (players and weapons then keep a fixed outdoor light). The presenter lights the first-person weapon from
     * the camera's position and each character from its own, and gives metal the environment to reflect.
     */
    setLighting(lighting: MapLighting | null): void;
    /**
     * Another player's footstep sound arrived (`pos` its feet, `loud` 0..1). Dust is drawn only under a player the
     * presenter is drawing right now (never for a ghost it was not sent), and for an enemy ghost only as faintly as
     * its shimmer.
     */
    footstep(id: number, pos: Vec3, loud: number): void;
    /**
     * A knife hit landed on player `victimId` (the server's slash event with a victim, which only reaches players who
     * know about that victim). Drawn on the victim if the presenter is drawing it; ignored otherwise (and for us).
     */
    knifeHit(victimId: number): void;
}

/**
 * `loads` (optional) hears the progress of every file the presenter downloads (weapons, characters, first-person hands)
 * for the loading screen (`loading.ts`); without it they load exactly as before.
 */
export type CreatePresenter = (app: pc.Application, camera: pc.Entity, loads?: LoadReporter) => Presenter;
