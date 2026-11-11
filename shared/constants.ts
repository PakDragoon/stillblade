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

// Combat (placeholder rifle for everyone until ghost mechanics arrive in Milestone 3).
export const MAX_HEALTH = 100;
export const BODY_DAMAGE = 34;
export const HEAD_DAMAGE = 100;
/** Top slice of the hull that counts as the head. */
export const HEAD_ZONE = 0.28;
export const FIRE_INTERVAL_MS = 100;
/** Fire rate is counted in the shooter's own commands so client and server always agree on it. */
export const FIRE_INTERVAL_TICKS = Math.round((FIRE_INTERVAL_MS / 1000) * TICK_RATE);
export const SHOT_RANGE = 120;
export const RESPAWN_MS = 3000;

// Netcode.
/** Clients draw other players this far in the past so there are always two snapshots to blend. */
export const INTERP_DELAY_MS = 100;
/** Furthest back the server will rewind players when resolving a shot. */
export const MAX_REWIND_MS = 300;
