import { rayWorld } from '@shared/raycast';
import type { Box, Vec3 } from '@shared/types';

/**
 * Where a body lies. The character's death clip (tools/blender/clips.py, recentred) falls backward: the head
 * ends about 1.3 m behind the feet position, the feet about 0.6 m in front, the arms out to the sides behind the
 * hips. Played facing the wrong way next to a wall, half the body goes through it, so the presenter turns the body
 * toward open floor: the facing at death if the fall is clear, else the nearest direction (45 degree steps) that is,
 * else the one with the most room. Looks only: nothing in the game depends on it.
 */

/** Directions tried, relative to the facing at death, in order of preference. */
const TRY = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, 3 * Math.PI / 4, -3 * Math.PI / 4, Math.PI];
/** Rays from the body's centre: [bearing from "backward" (radians), length needed (m)]: head, both arms, feet. */
const RAYS: readonly (readonly [number, number])[] = [[0, 1.35], [Math.PI / 3, 0.95], [-Math.PI / 3, 0.95], [Math.PI, 0.6]];
/** Height of the rays above the feet: a body lying on the floor, over kerbs and steps. */
const RAY_HEIGHT = 0.35;

const from: Vec3 = [0, 0, 0];
const dir: Vec3 = [0, 0, 0];

/** Yaw (radians, 0 faces -Z) to lay the body of a player who died at `pos` (feet) facing `yaw`. No allocation. */
export function corpseYaw(boxes: readonly Box[], pos: Vec3, yaw: number): number {
    if (boxes.length === 0) return yaw;
    from[0] = pos[0]; from[1] = pos[1] + RAY_HEIGHT; from[2] = pos[2];
    let best = yaw, bestScore = -1;
    for (let i = 0; i < TRY.length; i++) {
        const c = yaw + TRY[i];
        let score = Infinity;
        for (let j = 0; j < RAYS.length && score > bestScore; j++) {
            // Backward from facing yaw c is (sin c, 0, cos c); each ray turns by its bearing.
            const a = c + RAYS[j][0], need = RAYS[j][1];
            dir[0] = Math.sin(a); dir[1] = 0; dir[2] = Math.cos(a);
            score = Math.min(score, rayWorld(boxes, from, dir, need) / need);
        }
        if (score >= 1) return c;
        if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
}
