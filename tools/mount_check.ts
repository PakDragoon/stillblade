// How high a ledge can a player jump onto? Runs the shared movement code (stepPlayer) with a ledge
// directly ahead and searches for the tallest one the player ends up standing on, from the ground
// and from on top of a 1.0 m box. Used to set roof, box and walkway heights.
//     npx tsx tools/mount_check.ts
import { stepPlayer, createPlayerState } from '../shared/movement';
import { TICK_DT } from '../shared/constants';
import type { Box } from '../shared/types';

const idle = { forward: 0, right: 0, yaw: 0, jump: false, walk: false, crouch: false };

function mounts(stand: number, ledge: number, runup: number): boolean {
    const boxes: Box[] = [{ min: [-50, -0.5, -50], max: [50, 0, 50] }];
    if (stand > 0) boxes.push({ min: [-1, 0, -1], max: [1, stand, 1] });     // box under the player
    boxes.push({ min: [-5, 0, -10], max: [5, ledge, -1] });                   // ledge face touching the box
    const p = createPlayerState([0, stand + 0.05, -1 + 0.31 + runup]);
    for (let i = 0; i < 60; i++) stepPlayer(p, idle, TICK_DT, boxes);
    for (let i = 0; i < 120; i++) stepPlayer(p, { ...idle, forward: 1, jump: true }, TICK_DT, boxes);
    for (let i = 0; i < 60; i++) stepPlayer(p, idle, TICK_DT, boxes);
    return p.onGround && Math.abs(p.pos[1] - ledge) < 0.01;
}

for (const stand of [0, 1.0]) {
    for (const runup of [0, 0.3, 0.6]) {
        let best = 0;
        for (let h = stand + 0.5; h <= stand + 1.6; h += 0.01) if (mounts(stand, +h.toFixed(2), runup)) best = +h.toFixed(2);
        console.log(`standing on ${stand.toFixed(1)} m, ${runup} m back from the ledge: highest ledge mounted ${best.toFixed(2)} m`);
    }
}

// How far can a running player jump across a gap? Runs at full speed off a ledge at height h0 (jumping at the very
// edge) toward a ledge whose top is `dh` higher, `gap` metres away, and checks whether the player ends up on it.
// Used to keep thin wall tops and other unintended tops out of jumping reach of the tops players can stand on.
function crosses(dh: number, gap: number, crouchJump: boolean): boolean {
    const h0 = 4.0;
    const boxes: Box[] = [
        { min: [-50, -0.5, -50], max: [50, 0, 50] },
        { min: [-1, 0, 0], max: [1, h0, 20] },                                  // the take-off ledge, edge at z = 0
        { min: [-1, 0, -gap - 6], max: [1, h0 + dh, -gap] },                   // the target ledge, near edge at z = -gap
    ];
    const p = createPlayerState([0, h0 + 0.05, 15]);
    for (let i = 0; i < 20; i++) stepPlayer(p, idle, TICK_DT, boxes);
    let jumped = false;
    for (let i = 0; i < 300; i++) {
        // jump at the last moment the hull is still over the ledge (its far edge 0.3 m past the centre)
        const jump = !jumped && p.onGround && p.pos[2] < 0.3 + 0.1;
        if (jump) jumped = true;
        stepPlayer(p, { ...idle, forward: 1, jump, crouch: crouchJump && jumped }, TICK_DT, boxes);
        if (jumped && p.onGround && i > 5) break;
    }
    return p.onGround && Math.abs(p.pos[1] - (h0 + dh)) < 0.01;
}

// The same table is in tools/blender/mapkit.py (GAP_JUMP), which uses it to find unintended reachable tops.
console.log('\nrunning gap jumps, edge to edge (the hull lands once it overlaps the far ledge, so a thin wall top counts):');
for (const dh of [-3.0, -2.0, -1.0, -0.5, -0.2, 0, 0.15, 0.4, 0.8, 1.0, 1.1]) {
    let best = 0;
    for (let g = 0.2; g <= 7.0; g += 0.05) if (crosses(dh, +g.toFixed(2), false) || crosses(dh, +g.toFixed(2), true)) best = +g.toFixed(2);
    console.log(`  target ${dh >= 0 ? '+' : ''}${dh.toFixed(2)} m: widest gap crossed ${best.toFixed(2)} m`);
}
