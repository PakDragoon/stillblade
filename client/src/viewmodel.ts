import * as pc from 'playcanvas';
import { SIGHTS, SIGHT_IRON } from '@shared/weapons';

/**
 * First-person rigs: arms and hands holding one weapon, built by tools/blender/viewmodel.py into
 * client/public/models/viewmodel_{rifle,pistol,knife}.glb.
 *
 * Each rig is ONE skinned mesh (sleeves, gloves and the weapon with its moving parts), so it is one draw call. Bones:
 * the SWAT character's arm and finger chains, "weapon" (the weapon's own frame, origin at the grip) and under it the
 * moving parts: "mag", "bolt" (rifle) or "slide" (pistol), and "sup" (the suppressor). Empties "muzzle" (suppressor
 * front) and "muzzle_bare" (bare barrel front) hang from the weapon bone. The knife file has two meshes on the same
 * armature: "vm_knife" (a defender's sleeves) and "vm_ghost" (a ghost's), one shown at a time.
 *
 * Rig space: for a gun, the rig's origin is the grip at the gun's hip pose (presenter.ts places the rig root exactly
 * where it used to place the bare gun, so aiming, drawing, kick and sway still move the whole rig); for the knife it
 * is the camera. Clips are sampled by time, not played: `pose(clip, t)` writes every bone for time t, so the reload
 * follows the predicted reload progress exactly and the knife follows the predicted swing. Sampling is plain linear
 * interpolation over the exported keys (every bone is keyed on every frame at 30 fps), with no allocation.
 *
 * The suppressor is hidden by shrinking the "sup" bone after each sample (no second mesh, no extra draw call); the
 * reload clips hide the magazine the same way while it is off screen. The rifle's optional sights (package M) are
 * bones "sight_<SightId>" (one per SIGHTS entry but iron); every one but the mounted sight is shrunk the same way.
 */

const P_POS = 0, P_ROT = 1, P_SCALE = 2;
const HIDDEN = 0.001;

interface Channel {
    node: pc.GraphNode;
    prop: number;
    times: ArrayLike<number>;
    values: ArrayLike<number>;
    /** Last key index found, to start the next search from (clips are sampled mostly forward). */
    last: number;
}

export interface VmClip {
    readonly name: string;
    readonly duration: number;
    readonly channels: Channel[];
}

const tq = new pc.Quat();

function sampleChannel(c: Channel, t: number): void {
    const times = c.times, n = times.length;
    let i = c.last < n - 1 ? c.last : 0;
    if (times[i] > t) i = 0;
    while (i < n - 2 && times[i + 1] <= t) i++;
    c.last = i;
    let w = 0;
    if (n > 1 && t > times[i]) {
        const span = times[i + 1] - times[i];
        w = span > 0 ? Math.min(1, (t - times[i]) / span) : 1;
    }
    const v = c.values;
    if (c.prop === P_ROT) {
        const a = i * 4, b = Math.min(i + 1, n - 1) * 4;
        let bx = v[b], by = v[b + 1], bz = v[b + 2], bw = v[b + 3];
        // Shortest way round (the importer already aligns signs; this is a guard).
        if (v[a] * bx + v[a + 1] * by + v[a + 2] * bz + v[a + 3] * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
        const u = 1 - w;
        tq.set(v[a] * u + bx * w, v[a + 1] * u + by * w, v[a + 2] * u + bz * w, v[a + 3] * u + bw * w).normalize();
        c.node.setLocalRotation(tq);
        return;
    }
    const a = i * 3, b = Math.min(i + 1, n - 1) * 3, u = 1 - w;
    const x = v[a] * u + v[b] * w, y = v[a + 1] * u + v[b + 1] * w, z = v[a + 2] * u + v[b + 2] * w;
    if (c.prop === P_POS) c.node.setLocalPosition(x, y, z);
    else c.node.setLocalScale(x, y, z);
}

export class VmRig {
    readonly root: pc.Entity;
    readonly meshInstances: pc.MeshInstance[] = [];
    readonly clips = new Map<string, VmClip>();
    /** Suppressor front and bare barrel front (guns; null for the knife). */
    readonly muzzle: pc.GraphNode | null;
    readonly muzzleBare: pc.GraphNode | null;
    private readonly sup: pc.GraphNode | null;
    /** Per sight (SIGHTS index): its bone, or null (iron sights, or a rig without that sight). */
    private readonly sightBones: (pc.GraphNode | null)[];
    private sight = SIGHT_IRON;
    private readonly variants = new Map<string, pc.Entity>();
    private suppressed = true;
    private variant = '';
    private lastClip: VmClip | null = null;
    private lastTime = -1;

    constructor(res: pc.ContainerResource, layers: number[], material: pc.Material) {
        const e = res.instantiateRenderEntity({ castShadows: false, receiveShadows: false });
        e.name = 'viewmodel-rig';
        this.root = e;
        for (const r of e.findComponents('render') as pc.RenderComponent[]) {
            r.castShadows = false;
            r.receiveShadows = false;
            r.layers = layers;
            for (const mi of r.meshInstances) {
                mi.material = material;
                // Always in front of the camera; skinned bounds would also shrink with the hidden parts.
                mi.cull = false;
                this.meshInstances.push(mi);
            }
            this.variants.set(r.entity.name, r.entity);
        }
        this.sup = e.findByName('sup');
        this.sightBones = SIGHTS.map((d, i) => (i === SIGHT_IRON ? null : e.findByName(`sight_${d.id}`)));
        this.muzzle = e.findByName('muzzle');
        this.muzzleBare = e.findByName('muzzle_bare');
        for (const a of res.animations) {
            const track = a.resource as pc.AnimTrack | undefined;
            if (!track) continue;
            const name = track.name.replace(/^.*\|/, '');
            const channels: Channel[] = [];
            for (const curve of track.curves) {
                const path = curve.paths[0];
                const nodeName = path.entityPath[path.entityPath.length - 1];
                const node = e.findByName(nodeName);
                const prop = path.propertyPath[0] === 'localPosition' ? P_POS
                    : path.propertyPath[0] === 'localRotation' ? P_ROT
                        : path.propertyPath[0] === 'localScale' ? P_SCALE : -1;
                if (!node || prop < 0) continue;
                channels.push({
                    node, prop, times: track.inputs[curve.input].data, values: track.outputs[curve.output].data, last: 0
                });
            }
            this.clips.set(name, { name, duration: track.duration, channels });
        }
    }

    /** Shows only the mesh named `name` (the knife rig's "vm_knife" or "vm_ghost"); no-op if there is no such mesh. */
    setVariant(name: string): void {
        if (name === this.variant || !this.variants.has(name)) return;
        this.variant = name;
        this.variants.forEach((ent, n) => { ent.enabled = n === name; });
    }

    /** The suppressor on or off (room option); the muzzle in use follows. */
    setSuppressed(on: boolean): void {
        if (on === this.suppressed) return;
        this.suppressed = on;
        this.lastTime = -1;
    }

    /** The sight mounted (index into SIGHTS); the others are shrunk away at the next pose. */
    setSight(sight: number): void {
        if (sight === this.sight) return;
        this.sight = sight;
        this.lastTime = -1;
    }

    /** Muzzle point of the look in use. */
    activeMuzzle(): pc.GraphNode | null {
        return this.suppressed ? this.muzzle : this.muzzleBare;
    }

    /** Poses every bone at `time` seconds of `clip` (clamped to the clip). Cheap when nothing changed. */
    pose(clip: VmClip | undefined, time: number): void {
        if (!clip) return;
        const t = time < 0 ? 0 : time > clip.duration ? clip.duration : time;
        if (clip === this.lastClip && t === this.lastTime) return;
        this.lastClip = clip;
        this.lastTime = t;
        const ch = clip.channels;
        for (let i = 0; i < ch.length; i++) sampleChannel(ch[i], t);
        if (this.sup && !this.suppressed) this.sup.setLocalScale(HIDDEN, HIDDEN, HIDDEN);
        const sb = this.sightBones;
        for (let i = 0; i < sb.length; i++) if (sb[i] && i !== this.sight) sb[i]!.setLocalScale(HIDDEN, HIDDEN, HIDDEN);
    }
}

/** Loads one viewmodel GLB. Rejects if it fails to load or lacks the weapon bone or its clips. */
export function loadViewmodel(app: pc.Application, url: string, filename: string, layers: number[],
    material: pc.Material, clips: readonly string[]): Promise<VmRig> {
    return new Promise((resolve, reject) => {
        const asset = new pc.Asset(filename, 'container', { url, filename });
        asset.once('load', () => {
            const res = asset.resource as pc.ContainerResource | undefined;
            if (!res) { reject(new Error(`${filename} loaded without a resource`)); return; }
            const rig = new VmRig(res, layers, material);
            for (const c of clips) {
                if (!rig.clips.has(c)) { reject(new Error(`${filename} has no "${c}" clip`)); return; }
            }
            if (!rig.root.findByName('weapon')) { reject(new Error(`${filename} has no weapon bone`)); return; }
            resolve(rig);
        });
        asset.once('error', (err: unknown) => {
            app.assets.remove(asset);
            reject(new Error(`Failed to load ${url}: ${String(err)}`));
        });
        app.assets.add(asset);
        app.assets.load(asset);
    });
}
