import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CROUCH_COST, NAV_BOTH, NAV_CROUCH, NAV_DROP, NAV_JUMP, NAV_STEP, NAV_WALK, NavGraph, navKind } from './nav';

/** Three nodes in a row 1 m apart (x 0, 1, 2) plus a fourth off to the side. */
const NODES = [0, 0, 0, 1, 0, 0, 2, 0, 0, 1, 0, 1];

describe('navigation link kinds', () => {
    it('reads every kind written before crouch links existed exactly as before', () => {
        for (let k = 0; k < 8; k++) expect(navKind(k)).toBe(k & 3);
    });

    it('reads a crouch link, one way and both ways', () => {
        expect(navKind(NAV_CROUCH)).toBe(NAV_CROUCH);
        expect(navKind(NAV_CROUCH + NAV_BOTH)).toBe(NAV_CROUCH);
        const nav = new NavGraph({ cell: 1, nodes: NODES, edges: [0, 1, NAV_CROUCH + NAV_BOTH, 1, 2, NAV_CROUCH] });
        expect(nav.linkKind(0, 1)).toBe(NAV_CROUCH);
        expect(nav.linkKind(1, 0)).toBe(NAV_CROUCH);
        expect(nav.linkKind(1, 2)).toBe(NAV_CROUCH);
        expect(nav.linkKind(2, 1)).toBe(NAV_WALK); // not linked that way
        const path: number[] = [];
        expect(nav.findPath(2, 0, path)).toBe(false);
        expect(nav.findPath(0, 2, path)).toBe(true);
        expect(path).toEqual([1, 2]);
    });

    it('keeps the other kinds and their both-ways bit', () => {
        const nav = new NavGraph({
            cell: 1, nodes: NODES,
            edges: [0, 1, NAV_STEP + NAV_BOTH, 1, 2, NAV_JUMP, 2, 3, NAV_DROP, 3, 0, NAV_WALK + NAV_BOTH]
        });
        expect(nav.linkKind(0, 1)).toBe(NAV_STEP);
        expect(nav.linkKind(1, 0)).toBe(NAV_STEP);
        expect(nav.linkKind(1, 2)).toBe(NAV_JUMP);
        expect(nav.linkKind(2, 3)).toBe(NAV_DROP);
        expect(nav.linkKind(0, 3)).toBe(NAV_WALK);
    });

    it('costs a crouched link as the slower walk it is, so a bot crouches only when it saves time', () => {
        // 0 -> 2 straight is 2 m crouched (5.2 m of running); round by node 3 it is 2.83 m of running.
        const crouched = new NavGraph({
            cell: 1, nodes: NODES,
            edges: [0, 1, NAV_CROUCH + NAV_BOTH, 1, 2, NAV_CROUCH + NAV_BOTH, 0, 3, NAV_WALK + NAV_BOTH, 3, 2, NAV_WALK + NAV_BOTH]
        });
        const [e0, e1] = crouched.edgesOf(0);
        let crouchCost = 0;
        for (let e = e0; e < e1; e++) if (crouched.to[e] === 1) crouchCost = crouched.cost[e];
        expect(crouchCost).toBeCloseTo(1 * CROUCH_COST, 5);
        const path: number[] = [];
        expect(crouched.findPath(0, 2, path)).toBe(true);
        expect(path).toEqual([3, 2]);
        // With walking links instead, the straight way wins.
        const walked = new NavGraph({
            cell: 1, nodes: NODES,
            edges: [0, 1, NAV_WALK + NAV_BOTH, 1, 2, NAV_WALK + NAV_BOTH, 0, 3, NAV_WALK + NAV_BOTH, 3, 2, NAV_WALK + NAV_BOTH]
        });
        expect(walked.findPath(0, 2, path)).toBe(true);
        expect(path).toEqual([1, 2]);
    });

    it('Test Map 1 and Warehouse hold no crouch links (their files are unchanged)', () => {
        for (const id of ['greybox', 'warehouse']) {
            const map = JSON.parse(readFileSync(new URL(`../client/public/maps/${id}.json`, import.meta.url), 'utf8'));
            const edges: number[] = map.nav.edges;
            for (let i = 2; i < edges.length; i += 3) expect(edges[i]).toBeLessThan(NAV_CROUCH);
        }
    });
});
