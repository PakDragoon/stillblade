import {
    AIR_ACCEL, AIR_WISH_SPEED, CROUCH_SPEED, FRICTION, GRAVITY, GROUND_ACCEL, HULL_HALF_WIDTH,
    HULL_HEIGHT, HULL_HEIGHT_CROUCHED, JUMP_SPEED, RUN_SPEED, STEP_HEIGHT, STOP_SPEED, WALK_SPEED
} from './constants';
import { Hull, overlapsAny } from './collision';
import type { Box, InputCmd, PlayerState, Vec3 } from './types';

const GROUND_PROBE = 0.02;

// Scratch hulls: the simulation allocates nothing per tick.
const hull = new Hull();
const stepped = new Hull();

export function createPlayerState(pos: Vec3): PlayerState {
    return { pos: [pos[0], pos[1], pos[2]], vel: [0, 0, 0], onGround: false, crouched: false };
}

export function copyPlayerState(dst: PlayerState, src: PlayerState): void {
    dst.pos[0] = src.pos[0]; dst.pos[1] = src.pos[1]; dst.pos[2] = src.pos[2];
    dst.vel[0] = src.vel[0]; dst.vel[1] = src.vel[1]; dst.vel[2] = src.vel[2];
    dst.onGround = src.onGround;
    dst.crouched = src.crouched;
}

export function horizontalSpeed(s: PlayerState): number {
    return Math.hypot(s.vel[0], s.vel[2]);
}

function accelerate(vel: Vec3, wx: number, wz: number, wishSpeed: number, accel: number, dt: number): void {
    const current = vel[0] * wx + vel[2] * wz;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const amount = Math.min(accel * dt * wishSpeed, add);
    vel[0] += wx * amount;
    vel[2] += wz * amount;
}

function applyFriction(vel: Vec3, dt: number): void {
    const speed = Math.hypot(vel[0], vel[2]);
    if (speed < 1e-4) { vel[0] = 0; vel[2] = 0; return; }
    const drop = Math.max(speed, STOP_SPEED) * FRICTION * dt;
    const scale = Math.max(speed - drop, 0) / speed;
    vel[0] *= scale;
    vel[2] *= scale;
}

/**
 * Advances one player by one fixed tick. Pure function of (state, input, dt, boxes):
 * the client predicts with it and the server is authoritative with it, so they must never diverge.
 */
export function stepPlayer(s: PlayerState, input: InputCmd, dt: number, boxes: readonly Box[]): void {
    // Crouch: going down is always allowed, standing up needs headroom.
    if (input.crouch) {
        s.crouched = true;
    } else if (s.crouched) {
        hull.set(s.pos, HULL_HALF_WIDTH, HULL_HEIGHT);
        if (!overlapsAny(boxes, hull.min, hull.max)) s.crouched = false;
    }
    const height = s.crouched ? HULL_HEIGHT_CROUCHED : HULL_HEIGHT;

    // Wish direction on the ground plane from view yaw.
    const sin = Math.sin(input.yaw), cos = Math.cos(input.yaw);
    let wx = -sin * input.forward + cos * input.right;
    let wz = -cos * input.forward - sin * input.right;
    const wlen = Math.hypot(wx, wz);
    if (wlen > 1e-6) { wx /= wlen; wz /= wlen; }
    const maxSpeed = s.crouched ? CROUCH_SPEED : input.walk ? WALK_SPEED : RUN_SPEED;
    const wishSpeed = wlen > 1e-6 ? maxSpeed * Math.min(wlen, 1) : 0;

    let jumped = false;
    if (s.onGround) {
        applyFriction(s.vel, dt);
        accelerate(s.vel, wx, wz, wishSpeed, GROUND_ACCEL, dt);
        s.vel[1] = 0;
        if (input.jump) { s.vel[1] = JUMP_SPEED; s.onGround = false; jumped = true; }
    } else {
        accelerate(s.vel, wx, wz, Math.min(wishSpeed, AIR_WISH_SPEED), AIR_ACCEL, dt);
    }
    if (!s.onGround) s.vel[1] -= GRAVITY * dt;

    const dx = s.vel[0] * dt, dz = s.vel[2] * dt;
    hull.set(s.pos, HULL_HALF_WIDTH, height);
    const startX = hull.min[0], startZ = hull.min[2];

    if (s.onGround) {
        // Try the move flat and also lifted by a step; keep whichever gets further.
        stepped.copy(hull);
        let blocked = hull.slideXZ(boxes, dx, dz);
        if (blocked) {
            const up = stepped.move(boxes, 1, STEP_HEIGHT);
            const blockedLifted = stepped.slideXZ(boxes, dx, dz);
            stepped.move(boxes, 1, -up);
            const flat = (hull.min[0] - startX) ** 2 + (hull.min[2] - startZ) ** 2;
            const lifted = (stepped.min[0] - startX) ** 2 + (stepped.min[2] - startZ) ** 2;
            if (lifted > flat + 1e-9) { hull.copy(stepped); blocked = blockedLifted; }
        }
        // Kill velocity into walls so reported speed is real speed (visibility depends on it).
        if (blocked & 1) s.vel[0] = 0;
        if (blocked & 2) s.vel[2] = 0;
        // Stay glued to stairs and ledges going down; walk off anything taller.
        const down = hull.move(boxes, 1, -STEP_HEIGHT);
        if (down === -STEP_HEIGHT) {
            hull.min[1] -= down; hull.max[1] -= down;
            s.onGround = false;
        }
    } else {
        const blocked = hull.slideXZ(boxes, dx, dz);
        if (blocked & 1) s.vel[0] = 0;
        if (blocked & 2) s.vel[2] = 0;
        const dy = s.vel[1] * dt;
        const moved = hull.move(boxes, 1, dy);
        if (moved !== dy) {
            if (dy < 0 && !jumped) s.onGround = true;
            s.vel[1] = 0;
        }
    }

    // Catch the case of landing exactly flush with the ground this tick.
    if (!s.onGround && s.vel[1] <= 0 && !jumped) {
        stepped.copy(hull);
        if (stepped.move(boxes, 1, -GROUND_PROBE) !== -GROUND_PROBE) { s.onGround = true; s.vel[1] = 0; }
    }

    s.pos[0] = hull.min[0] + HULL_HALF_WIDTH;
    s.pos[1] = hull.min[1];
    s.pos[2] = hull.min[2] + HULL_HALF_WIDTH;
}
