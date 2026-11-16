/** Simulation runs at a fixed rate on client and server so prediction can be replayed exactly. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

// Player hull (axis-aligned box).
export const HULL_HALF_WIDTH = 0.3;
export const HULL_HEIGHT = 1.8;
export const HULL_HEIGHT_CROUCHED = 1.2;
export const EYE_HEIGHT = 1.62;
export const EYE_HEIGHT_CROUCHED = 1.02;

// Speeds in m/s.
export const RUN_SPEED = 5.2;
export const WALK_SPEED = 2.6;
export const CROUCH_SPEED = 2.0;
/** Cap on the speed air-strafing can add in the wish direction. */
export const AIR_WISH_SPEED = 0.8;

export const GROUND_ACCEL = 10;
export const AIR_ACCEL = 10;
export const FRICTION = 7;
/** Below this speed friction acts as if moving this fast, so stops are crisp. */
export const STOP_SPEED = 1.6;

export const GRAVITY = 20;
/** Apex is about 1.17 m at 60 Hz: mounts a 1 m crate with margin, not a 1.2 m platform. */
export const JUMP_SPEED = 7.0;
/** Tallest ledge walked up without jumping. */
export const STEP_HEIGHT = 0.35;

// Combat. Per-weapon numbers (damage, fire rate, magazine, reload, recoil, spread, aim) are in
// the table in shared/weapons.ts; the rules that use them are in shared/gun.ts.
export const MAX_HEALTH = 100;
/** Top slice of the hull that counts as the head. */
export const HEAD_ZONE = 0.28;
export const SHOT_RANGE = 120;
export const RESPAWN_MS = 3000;
/** Pulling the trigger on an empty weapon with no reserve clicks at most this often (commands). */
export const DRY_FIRE_TICKS = 15;
/** Reload sounds carry this far (heard like a walking footstep, a bit further). */
export const RELOAD_SOUND_RANGE = 10;

// Ghost visibility: 0 is invisible, 1 is opaque. Ghosts are unseen when still and shimmer when moving.
export const GHOST_MAX_VIS = 0.35;
/** Speed below which a ghost counts as still. */
export const VIS_STILL_SPEED = 0.3;
/** Seconds for visibility to rise (fast) and fall (slow): stopping does not hide a ghost instantly. */
export const VIS_RISE_TIME = 0.08;
export const VIS_FALL_TIME = 0.3;
/** Visibility a ghost is forced up to when it starts a knife swing or takes damage. */
export const VIS_SWING_SPIKE = 0.6;
export const VIS_HURT_SPIKE = 0.8;

// Knife (ghosts; the defender knife in shared/weapons.ts uses the same timing, reach and cone). Timings are in the attacker's own commands, like the fire rate.
export const KNIFE_WINDUP_TICKS = 12;
export const KNIFE_COOLDOWN_TICKS = 42;
export const KNIFE_RANGE = 2.0;
/** Half-angle of the swing cone, as a cosine (about 40 degrees). */
export const KNIFE_CONE_COS = 0.766;
export const KNIFE_DAMAGE = 55;
export const KNIFE_BACKSTAB_DAMAGE = 100;

// Sound. Defenders find ghosts by ear, so these ranges are gameplay, not decoration.
/** Ground distance between footsteps. */
export const STEP_DISTANCE = 2.0;
/** How far a full-volume (running) footstep carries; quieter steps carry proportionally less. */
export const STEP_RANGE = 18;
export const STEP_LOUD_RUN = 1;
export const STEP_LOUD_WALK = 0.3;
export const STEP_LOUD_CROUCH = 0.18;
/** A ghost's breathing is audible, and its position known to the client, inside this radius. */
export const BREATH_RANGE = 8;
export const KNIFE_SOUND_RANGE = 14;
/**
 * How far a gunshot is heard (m). Beyond it a shot reaches only players who can see the shooter,
 * drawn without sound. Starting numbers, untuned.
 */
export const GUNSHOT_RANGE = 60;
export const GUNSHOT_RANGE_SUPPRESSED = 20;

// Netcode.
/** Clients draw other players this far in the past so there are always two snapshots to blend. */
export const INTERP_DELAY_MS = 100;
/** Furthest back the server will rewind players when resolving a shot. */
export const MAX_REWIND_MS = 300;
