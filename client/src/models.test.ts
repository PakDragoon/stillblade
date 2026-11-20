import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNIFE_COOLDOWN_TICKS, KNIFE_WINDUP_TICKS, TICK_RATE } from '@shared/constants';
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
            // The rifle (package T) carries the M4 pack's own arm joints; the pistol keeps the soldier's.
            const wrists = w.id === 'rifle' ? ['RightHand', 'LeftHand'] : ['Wrist.R', 'Wrist.L'];
            for (const n of ['weapon', 'mag', 'sup', 'muzzle', 'muzzle_bare', ...wrists]) expect(names.has(n), n).toBe(true);
            expect(g.meshes.length).toBe(1); // one skinned mesh: one draw call
        });
    }

    it('rifle (packages R and T): the pack clips at the rule lengths (empty reload, draw, one fire interval)', () => {
        const rifle = WEAPONS[0];
        const c = clips(readGlb('viewmodel_rifle.glb'));
        // Package T: the bolt held back on the catch while the magazine is empty, and the shot that empties it.
        expect(c.has('rifle_idle_empty')).toBe(true);
        expect(c.get('rifle_fire_empty')).toBeCloseTo(rifle.fireInterval / TICK_RATE, 2);
        // No holster clip: a switch has no holster time in the rules.
        expect(c.has('rifle_holster')).toBe(false);
        // The client samples the reload clips by progress and the draw by draw progress, so their lengths must be the
        // rules' (an empty reload is longer than a tactical one).
        expect(c.get('rifle_reload_empty')).toBeCloseTo(rifle.reloadEmptyTicks / TICK_RATE, 2);
        expect(c.get('rifle_reload')).toBeCloseTo(rifle.reloadTicks / TICK_RATE, 2);
        expect(c.get('rifle_draw')).toBeCloseTo(rifle.drawTicks / TICK_RATE, 2);
        expect(c.get('rifle_fire')).toBeCloseTo(rifle.fireInterval / TICK_RATE, 2);
        expect(rifle.reloadEmptyTicks).toBeGreaterThan(rifle.reloadTicks);
    });

    it('rifle (package T): the M4 pack arms, its moving parts, and its clips play the pack as authored', () => {
        const g = readGlb('viewmodel_rifle.glb');
        const names = nodeNames(g);
        for (const n of ['round', 'bolt', 'catch', 'trigger', 'rearsight', 'RightForeArm', 'LeftForeArm', 'RightHandIndex1',
            'LeftHandThumb1']) expect(names.has(n), n).toBe(true);
        // As authored: no aimed-arms clips (the pack has none; aiming moves the whole rig onto the sight line).
        expect(clips(g).has('rifle_aim_iron')).toBe(false);
    });

    it('the pistol has an aimed-arms clip and the forearm twist bones', () => {
        for (const w of WEAPONS.filter(x => x.id !== 'rifle')) {
            const g = readGlb(`viewmodel_${w.id}.glb`);
            const c = clips(g);
            const sights = w.takesSights ? SIGHTS.map(s => s.id) : [SIGHTS[SIGHT_IRON].id];
            for (const s of sights) expect(c.has(`${w.id}_aim_${s}`), `${w.id}_aim_${s}`).toBe(true);
            const names = nodeNames(g);
            for (const n of ['ForeTwist1.L', 'ForeTwist2.L', 'ForeTwist1.R', 'ForeTwist2.R']) expect(names.has(n)).toBe(true);
        }
    });

    it('knife (package V): the knife pack clips at the rule lengths, its joints, two looks on one armature', () => {
        const g = readGlb('viewmodel_knife.glb');
        const c = clips(g);
        const windup = DEFENDER_KNIFE.windupTicks / TICK_RATE, cooldown = DEFENDER_KNIFE.cooldownTicks / TICK_RATE;
        expect(windup).toBeCloseTo(KNIFE_WINDUP_TICKS / TICK_RATE, 6);
        expect(cooldown).toBeCloseTo(KNIFE_COOLDOWN_TICKS / TICK_RATE, 6);
        // The pack's idle loop (2.67 s) and its quick draw at the defender knife's draw time (presenter.ts samples it by
        // draw progress, and plays it at the pack's own speed as the recovery after a swing).
        expect(c.get('knife_idle')).toBeCloseTo(160 / 60, 1);
        expect(c.get('knife_draw')).toBeCloseTo(DEFENDER_KNIFE.drawTicks / TICK_RATE, 2);
        // Four swings: each strikes at the windup (the client maps 0.2 s of clip onto the rule's windup) and is over
        // before the next swing may start, so a held attack chains them.
        for (let i = 0; i < 4; i++) {
            const d = c.get(`knife_swing_${i}`)!;
            expect(d, `knife_swing_${i}`).toBeGreaterThan(windup + 0.2);
            expect(d, `knife_swing_${i}`).toBeLessThanOrEqual(cooldown);
        }
        expect(c.has('knife_swing')).toBe(false); // the old single swing is gone
        // Not exported: no holster time, inspect, sprint or heavy stab in the rules.
        for (const n of ['knife_holster', 'knife_inspect', 'knife_sprint', 'knife_strike']) expect(c.has(n), n).toBe(false);
        const names = nodeNames(g);
        for (const n of ['weapon', 'hand_r', 'hand_l', 'lowerarm_r', 'lowerarm_twist_01_r', 'index_03_r', 'thumb_03_l',
            'upperarm_r']) expect(names.has(n), n).toBe(true);
        for (const n of ['head', 'pelvis', 'spine_05']) expect(names.has(n), n).toBe(false); // no skin above the arms
        expect((g as unknown as { skins: unknown[] }).skins.length).toBe(1);
        expect(g.meshes.map(m => m.name).sort()).toEqual(['vm_ghost', 'vm_knife']);
        // The ghost look reuses the defender mesh's vertex data and differs only in its colours.
        type P = { attributes: Record<string, number>; indices: number };
        const [k, gh] = ['vm_knife', 'vm_ghost'].map(n => (g.meshes.find(m => m.name === n) as unknown as { primitives: P[] }).primitives[0]);
        expect(gh.indices).toBe(k.indices);
        for (const a of Object.keys(k.attributes)) {
            if (a === 'COLOR_0') expect(gh.attributes[a]).not.toBe(k.attributes[a]);
            else expect(gh.attributes[a], a).toBe(k.attributes[a]);
        }
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

describe('realistic weapons (package M part 2)', () => {
    const models = join(__dirname, '..', 'public', 'models');
    type Prim = { attributes: Record<string, number> };
    const primitives = (g: Gltf): Prim[] => g.meshes.flatMap(m => (m as { primitives?: Prim[] }).primitives ?? []);

    it('weapons.glb has an aim point for every rifle sight and the pistol, and UVs and colours on every mesh', () => {
        const g = readGlb('weapons.glb');
        const names = nodeNames(g);
        for (const s of SIGHTS) expect(names.has(`gun_aim_${s.id}`), s.id).toBe(true);
        expect(names.has('pistol_aim_iron')).toBe(true);
        for (const p of primitives(g)) {
            expect(p.attributes.TEXCOORD_0).toBeDefined();
            expect(p.attributes.COLOR_0).toBeDefined();
        }
    });

    it('every rig has its moving parts, aim points (guns), UVs and colours', () => {
        const parts: Record<string, string[]> = {
            rifle: ['bolt', 'mag', 'round', 'catch', 'trigger', 'rearsight', 'sup', ...SIGHTS.map(s => `aim_${s.id}`)],
            pistol: ['slide', 'mag', 'sup', 'aim_iron'],
            knife: []
        };
        for (const [rig, want] of Object.entries(parts)) {
            const g = readGlb(`viewmodel_${rig}.glb`);
            const names = nodeNames(g);
            for (const n of want) expect(names.has(n), `${rig} ${n}`).toBe(true);
            for (const p of primitives(g)) {
                expect(p.attributes.TEXCOORD_0, rig).toBeDefined();
                expect(p.attributes.COLOR_0, rig).toBeDefined();
            }
        }
    });

    it('the knife rig names its two meshes exactly (the client shows one by node name)', () => {
        const g = readGlb('viewmodel_knife.glb');
        const meshNodes = g.nodes.filter(n => (n as { mesh?: number }).mesh !== undefined).map(n => n.name).sort();
        expect(meshNodes).toEqual(['vm_ghost', 'vm_knife']);
        // No other node may share those names (an armature called vm_knife hid the defender's mesh from setVariant).
        expect(g.nodes.filter(n => n.name === 'vm_knife').length).toBe(1);
    });

    it('ships both atlas sizes per gun and for the characters, and the Low tier download stays within 4.5 MB', () => {
        // Everything a Low player downloads for models: the weapons, the three rigs, the Low characters and the 1024
        // atlases (package O added the characters' file and atlas: 3.55 MB before it, about 4.27 MB after; MB = 10^6 bytes).
        let low = 0;
        for (const f of ['weapons.glb', 'viewmodel_rifle.glb', 'viewmodel_pistol.glb', 'viewmodel_knife.glb', 'character_low.glb']) {
            low += statSync(join(models, f)).size;
        }
        for (const atlas of ['rifle', 'pistol', 'knife', 'character']) {
            for (const kind of ['albedo', 'normal']) {
                for (const size of [1024, 2048]) {
                    const b = readFileSync(join(models, 'textures', `${atlas}_${kind}_${size}.webp`));
                    expect(b.subarray(8, 12).toString('ascii'), `${atlas} ${kind} ${size}`).toBe('WEBP');
                    if (size === 1024) low += b.length;
                }
            }
        }
        expect(low).toBeLessThan(4.5 * 1024 * 1024);
    });
});

describe('third-person characters (package O)', () => {
    type Prim = { attributes: Record<string, number>; indices?: number };
    interface Skinned extends Gltf { skins?: { joints: number[] }[]; meshes: { name?: string; primitives: Prim[] }[] }
    const triangles = (g: Skinned, mesh: string): number => {
        const m = g.meshes.find(x => x.name === mesh)!;
        return m.primitives.reduce((n, p) => n + ((g.accessors[p.indices!] as { count: number }).count / 3), 0);
    };
    // Triangles per look and tier: High about 10-15k, Low about 6-8k (ROADMAP.md, package O).
    const budget: Record<string, [number, number]> = { high: [9000, 15000], low: [4500, 8000] };

    for (const tier of ['high', 'low']) {
        it(`character_${tier}.glb: every clip characters.ts plays, reloads as long as the rules`, () => {
            const c = clips(readGlb(`character_${tier}.glb`));
            for (const n of ['idle', 'walk', 'run', 'crouch_idle', 'crouch_walk', 'death', 'hit', 'aim', 'shoot', 'pistol',
                'pistol_shoot', 'knife_hold', 'knife_swing']) {
                expect(c.has(n), n).toBe(true);
            }
            // The client plays reloads at clip length / rule length, so they only need to be close; check they are.
            for (const w of WEAPONS) expect(Math.abs(c.get(`reload_${w.id}`)! - w.reloadTicks / TICK_RATE)).toBeLessThan(0.05);
        });

        it(`character_${tier}.glb: two looks on one skeleton of at most 70 bones, the bones and sockets the client uses`, () => {
            const g = readGlb(`character_${tier}.glb`) as Skinned;
            expect(g.meshes.map(m => m.name).sort()).toEqual(['char_defender', 'char_ghost']);
            for (const m of g.meshes) expect(m.primitives.length, m.name).toBe(1); // one material: one draw call
            expect(g.skins!.length).toBe(1);
            expect(g.skins![0].joints.length).toBeLessThanOrEqual(70);
            const names = nodeNames(g);
            // characters.ts: the upper-body mask root, the bones it bends, the hand sockets.
            for (const n of ['Abdomen', 'Chest', 'Neck', 'UpperArm.R', 'UpperArm.L', 'Wrist.R', 'Index3.R', 'socket_gun',
                'socket_pistol', 'socket_knife']) expect(names.has(n), n).toBe(true);
            for (const look of ['char_defender', 'char_ghost']) {
                const t = triangles(g, look);
                expect(t, `${look} ${tier}`).toBeGreaterThan(budget[tier][0]);
                expect(t, `${look} ${tier}`).toBeLessThan(budget[tier][1]);
            }
            const prim = g.meshes[0].primitives[0];
            expect(prim.attributes.TEXCOORD_0).toBeDefined();
            expect(prim.attributes.COLOR_0).toBeDefined();
        });
    }
});
