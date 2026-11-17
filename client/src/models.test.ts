import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '@shared/constants';
import { DEFENDER_KNIFE, SIGHTS, SIGHT_IRON, WEAPONS } from '@shared/weapons';

/**
 * The shipped model files (built by tools/blender/*.py) carry what the client asks for by name, and their timed
 * clips match the rules: a reload clip that drifted from the rule's length would put the magazine in at the wrong
 * moment against the sound.
 */

interface Gltf {
    nodes: { name?: string; children?: number[] }[];
    meshes: { name?: string }[];
    animations?: { name: string; channels: { sampler: number; target: { node: number; path: string } }[]; samplers: { input: number }[] }[];
    accessors: { max?: number[] }[];
}

function readGlb(file: string): Gltf {
    const b = readFileSync(join(__dirname, '..', 'public', 'models', file));
    const len = b.readUInt32LE(12);
    return JSON.parse(b.subarray(20, 20 + len).toString('utf8')) as Gltf;
}

/** Clip lengths in seconds (the latest key of any channel). */
function clips(g: Gltf): Map<string, number> {
    const out = new Map<string, number>();
    for (const a of g.animations ?? []) {
        let end = 0;
        for (const c of a.channels) end = Math.max(end, g.accessors[a.samplers[c.sampler].input].max?.[0] ?? 0);
        out.set(a.name, end);
    }
    return out;
}

const nodeNames = (g: Gltf): Set<string> => new Set(g.nodes.map(n => n.name ?? ''));

describe('first-person viewmodels', () => {
    for (const w of WEAPONS) {
        it(`${w.id}: idle and a reload as long as the rule's, with the moving parts and both muzzles`, () => {
            const g = readGlb(`viewmodel_${w.id}.glb`);
            const c = clips(g);
            expect(c.has(`${w.id}_idle`)).toBe(true);
            expect(c.get(`${w.id}_reload`)).toBeCloseTo(w.reloadTicks / TICK_RATE, 1);
            const names = nodeNames(g);
            for (const n of ['weapon', 'mag', 'sup', 'muzzle', 'muzzle_bare', 'Wrist.R', 'Wrist.L']) expect(names.has(n)).toBe(true);
            expect(g.meshes.length).toBe(1); // one skinned mesh: one draw call
        });
    }

    it('knife: idle and swing, the defender and ghost meshes on one armature', () => {
        const g = readGlb('viewmodel_knife.glb');
        const c = clips(g);
        expect(c.has('knife_idle')).toBe(true);
        // Windup 0.2 s (the rule's), slash 0.12 s, recovery 0.2 s.
        expect(DEFENDER_KNIFE.windupTicks / TICK_RATE).toBeCloseTo(0.2, 3);
        expect(c.get('knife_swing')).toBeGreaterThan(0.5);
        expect(g.meshes.map(m => m.name).sort()).toEqual(['vm_ghost', 'vm_knife']);
    });
});

describe('rifle sights (package M)', () => {
    const others = SIGHTS.filter((_, i) => i !== SIGHT_IRON);

    it('weapons.glb has a gun_sight_<id> mesh node under the gun for every sight but iron', () => {
        const g = readGlb('weapons.glb');
        const gun = g.nodes.find(n => n.name === 'gun')!;
        const children = new Set((gun.children ?? []).map(i => g.nodes[i].name));
        for (const s of others) expect(children.has(`gun_sight_${s.id}`), s.id).toBe(true);
        expect(children.has('gun_sight_iron')).toBe(false); // the iron sights are the gun's own
    });

    it('the rifle rig has a sight_<id> bone for every sight but iron, keyed by both clips (so it follows the reload)', () => {
        const g = readGlb('viewmodel_rifle.glb');
        for (const s of others) {
            const node = g.nodes.findIndex(n => n.name === `sight_${s.id}`);
            expect(node, s.id).toBeGreaterThanOrEqual(0);
            for (const clip of ['rifle_idle', 'rifle_reload']) {
                const a = g.animations!.find(x => x.name === clip)!;
                expect(a.channels.some(c => c.target.node === node && c.target.path === 'translation'), `${clip} ${s.id}`).toBe(true);
            }
        }
        expect(g.meshes.length).toBe(1); // still one skinned mesh: one draw call
    });
});

describe('third-person character', () => {
    it('has every clip characters.ts plays, reloads as long as the rules', () => {
        const c = clips(readGlb('character.glb'));
        for (const n of ['idle', 'walk', 'run', 'crouch_idle', 'crouch_walk', 'death', 'hit', 'aim', 'shoot', 'pistol',
            'pistol_shoot', 'knife_hold', 'knife_swing']) {
            expect(c.has(n), n).toBe(true);
        }
        // The client plays reloads at clip length / rule length, so they only need to be close; check they are.
        for (const w of WEAPONS) expect(Math.abs(c.get(`reload_${w.id}`)! - w.reloadTicks / TICK_RATE)).toBeLessThan(0.05);
    });
});
