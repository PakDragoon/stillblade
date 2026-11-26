import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TICK_DT } from '../../shared/constants';
import { createPlayerState, stepPlayer } from '../../shared/movement';
import { NAV_CROUCH, NAV_DROP, NAV_JUMP, NavGraph } from '../../shared/nav';
import type { InputCmd, Vec3 } from '../../shared/types';
import { loadMaps } from './maps';

/**
 * Trailer Park's special ways (crouch openings 8 and 9, hole 7, box 10 onto roof 6, planks 14 and 15),
 * walked with the shared movement code along the navigation graph the way a bot follows it: steer at
 * each node in turn, jump on a jump link, crouch along a crouch link. Points are engine coordinates
 * (x, height, z = -authoring y), taken from tools/blender/maps/trailerpark.py.
 */
const MAP = loadMaps(fileURLToPath(new URL('../../client/public/maps', import.meta.url))).get('trailerpark')!;
const NAV = new NavGraph(MAP.nav!);

const P = {
    north8: [9.17, 0, -7.4] as Vec3,       // outside crouch opening 8 (defender side)
    inside8: [9.17, 0, -4.2] as Vec3,      // in the north barrack, behind it
    south9: [9.24, 0, 16.0] as Vec3,       // outside crouch opening 9
    inside9: [9.24, 0, 12.8] as Vec3,      // in the south barrack
    roof6: [15.2, 2.0, 4.3] as Vec3,       // on roof 6 beside hole 7
    under7: [17.5, 0, 4.3] as Vec3,        // the passage floor under hole 7
    byBox10: [2.4, 0, 4.55] as Vec3,       // on the ground west of box 10
    roofWest: [7.5, 2.0, 4.3] as Vec3,     // on roof 6 above block 6
    belowP14: [23.5, 0, -1.4] as Vec3,     // the ground corridor north of plank 14
    belowP15: [23.5, 0, 9.9] as Vec3,      // the ground corridor south of plank 15
    walkway: [26.3, 1.2, 4.3] as Vec3,     // on walkway 13 between the planks
};

function route(from: Vec3, to: Vec3): number[] {
    const a = NAV.nearest(from), b = NAV.nearest(to, 3, 0.6, 2.5);
    expect(a, `no node near ${from}`).toBeGreaterThanOrEqual(0);
    expect(b, `no node near ${to}`).toBeGreaterThanOrEqual(0);
    const path: number[] = [];
    expect(NAV.findPath(a, b, path)).toBe(true);
    return [a, ...path];
}

function kinds(path: number[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < path.length; i++) out.push(NAV.linkKind(path[i - 1], path[i]));
    return out;
}

/** Follows a node path with stepPlayer. Returns the final feet position. */
function follow(path: number[], opts: { crouch: boolean }): Vec3 {
    const n0 = path[0];
    const s = createPlayerState([NAV.x[n0], NAV.y[n0] + 0.01, NAV.z[n0]]);
    const cmd: InputCmd = { forward: 0, right: 0, yaw: 0, jump: false, walk: false, crouch: false };
    for (let i = 1; i < path.length; i++) {
        const n = path[i], kind = NAV.linkKind(path[i - 1], n);
        const nextCrouch = i + 1 < path.length && NAV.linkKind(n, path[i + 1]) === NAV_CROUCH;
        for (let t = 0; t < 8 * 60; t++) {
            const dx = NAV.x[n] - s.pos[0], dz = NAV.z[n] - s.pos[2];
            const flat = Math.hypot(dx, dz);
            if (flat < 0.4 && Math.abs(NAV.y[n] - s.pos[1]) < 1.0) break;
            cmd.forward = -dz / Math.max(flat, 1e-6);
            cmd.right = dx / Math.max(flat, 1e-6);
            cmd.jump = kind === NAV_JUMP && flat < 1.3 && NAV.y[n] > s.pos[1] + 0.3 && s.onGround;
            cmd.crouch = opts.crouch && (kind === NAV_CROUCH || (nextCrouch && flat < 1.0));
            stepPlayer(s, cmd, TICK_DT, MAP.boxes);
        }
    }
    cmd.forward = cmd.right = 0; cmd.jump = cmd.crouch = false;
    for (let t = 0; t < 60; t++) stepPlayer(s, cmd, TICK_DT, MAP.boxes);
    return [s.pos[0], s.pos[1], s.pos[2]];
}

const near = (p: Vec3, q: Vec3, r = 1.0): boolean => Math.hypot(p[0] - q[0], p[2] - q[2]) < r && Math.abs(p[1] - q[1]) < 0.3;

describe('Trailer Park: crouch openings', () => {
    for (const [name, out, inside] of [['8', P.north8, P.inside8], ['9', P.south9, P.inside9]] as const) {
        it(`crouch opening ${name}: the route through is a crouch link, passable crouched and not standing`, () => {
            const path = route(out, inside);
            expect(kinds(path)).toContain(NAV_CROUCH);
            expect(near(follow(path, { crouch: true }), inside)).toBe(true);
            expect(near(follow(path, { crouch: false }), inside)).toBe(false);
            // and back out the same way
            const back = route(inside, out);
            expect(kinds(back)).toContain(NAV_CROUCH);
            expect(near(follow(back, { crouch: true }), out)).toBe(true);
        });
    }

    it('a crouched player under a crouch lintel cannot stand up, and stands once clear of it', () => {
        const s = createPlayerState([9.17, 0.01, -5.88]);        // under the lintel of opening 8
        const cmd: InputCmd = { forward: 0, right: 0, yaw: 0, jump: false, walk: false, crouch: true };
        for (let t = 0; t < 30; t++) stepPlayer(s, cmd, TICK_DT, MAP.boxes);
        expect(s.crouched).toBe(true);
        cmd.crouch = false;
        for (let t = 0; t < 30; t++) stepPlayer(s, cmd, TICK_DT, MAP.boxes);
        expect(s.crouched).toBe(true);                         // no headroom: still crouched
        cmd.forward = -1;                                      // forward is -z: north, out of the opening
        for (let t = 0; t < 90; t++) stepPlayer(s, cmd, TICK_DT, MAP.boxes);
        expect(s.crouched).toBe(false);
    });

    it('a standing player fits under roof 6 (1.85 m) and cannot jump there', () => {
        const s = createPlayerState([17.5, 0.01, 2.3]);
        const cmd: InputCmd = { forward: 0, right: 0, yaw: 0, jump: true, walk: false, crouch: false };
        let top = 0;
        for (let t = 0; t < 60; t++) { stepPlayer(s, cmd, TICK_DT, MAP.boxes); top = Math.max(top, s.pos[1]); }
        expect(s.crouched).toBe(false);
        expect(top).toBeLessThan(0.06);
    });
});

describe('Trailer Park: hole 7, box 10 and the planks', () => {
    it('drops through hole 7 from roof 6 into the passage; the hole is one way', () => {
        const path = route(P.roof6, P.under7);
        const ks = kinds(path);
        expect(ks).toContain(NAV_DROP);
        expect(near(follow(path, { crouch: true }), P.under7)).toBe(true);
        // no link climbs back up through the hole
        const i = ks.indexOf(NAV_DROP);
        const [a, b] = [path[i], path[i + 1]];
        const [e0, e1] = NAV.edgesOf(b);
        for (let e = e0; e < e1; e++) expect(NAV.to[e]).not.toBe(a);
        const up = route(P.under7, P.roof6);
        for (const n of up) expect(Math.hypot(NAV.x[n] - 17.5, NAV.z[n] - 4.3) > 1.2 || NAV.y[n] < 0.5).toBe(true);
    });

    it('climbs onto roof 6 from the ground by box 10 (two jumps)', () => {
        const path = route(P.byBox10, P.roofWest);
        expect(kinds(path).filter(k => k === NAV_JUMP).length).toBeGreaterThanOrEqual(2);
        expect(near(follow(path, { crouch: true }), P.roofWest)).toBe(true);
    });

    for (const [name, below] of [['14', P.belowP14], ['15', P.belowP15]] as const) {
        it(`walks up plank ${name} onto walkway 13 and back down`, () => {
            const path = route(below, P.walkway);
            expect(kinds(path)).not.toContain(NAV_JUMP);
            expect(near(follow(path, { crouch: true }), P.walkway)).toBe(true);
            const down = route(P.walkway, below);
            expect(near(follow(down, { crouch: true }), below)).toBe(true);
        });
    }
});
