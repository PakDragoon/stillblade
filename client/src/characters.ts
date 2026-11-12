import * as pc from 'playcanvas';
import type { RemoteView } from './presenter-api';
import { instantiateWeapon, type WeaponModel } from './weapons';

/**
 * Animated remote-player characters.
 *
 * One shared GLB (client/public/models/character.glb, built by tools/blender/characters.py:
 * "SWAT" by Quaternius, CC0) is loaded once; every remote player gets its own instance of the
 * hierarchy + skin, pooled together with the presenter's Remote record. The model is a single
 * skinned mesh with one material (vertex colours), so a character is one draw call.
 *
 * Animation runs on PlayCanvas's `anim` component:
 *   - "Base" layer: idle / walk / run / crouch_idle / crouch_walk / death, switched with
 *     `layer.transition(name, 0.15)` only when the state changes (no per-frame allocation).
 *   - "Upper" layer: masked to the spine and arms, weight 0 at rest; plays the one-shot
 *     slash / hit clips over whatever the legs are doing, then fades out.
 * The state comes from RemoteView only: horizontal speed estimated from the frame-to-frame
 * change of `pos` (exponentially smoothed), `crouched`, and `alive`. Locomotion playback is
 * scaled by speed / (clip's own ground speed) so feet slide as little as possible.
 *
 * Looks:
 *   - Defender: one shared lit StandardMaterial using the vertex colours (orange suit).
 *   - Enemy ghost: one shared skinned shimmer ShaderMaterial; opacity per mesh instance (uVis).
 *   - Ally ghost: the same shader, steady violet, fixed opacity.
 *
 * Weapons (weapons.ts) hang from the "socket_gun" / "socket_knife" nodes on the right wrist bone:
 *   - Defenders carry the gun (same vertex-colour material as the body) and hold it with the "aim" pose on
 *     the upper layer at full weight; a remote shot plays "shoot" (a recoil that ends on the aim pose).
 *     After the animation is applied, the spine is bent by the aim pitch.
 *   - Ghosts carry the knife, drawn with the body's own material and per-instance parameters, so it is
 *     exactly as visible as the body (and disabled with it when the player is culled).
 * Each character is therefore at most two draw calls: the skinned body and one weapon.
 */

export const CharLook = { None: 0, Defender: 1, EnemyGhost: 2, AllyGhost: 3 } as const;
export type CharLook = typeof CharLook[keyof typeof CharLook];

// Ground speed (m/s) of each locomotion clip at playback speed 1, measured by characters.py.
const WALK_CLIP_SPEED = 1.358;
const RUN_CLIP_SPEED = 2.969;
const CROUCH_CLIP_SPEED = 1.358;
const MIN_PLAYBACK = 0.6;
const MAX_PLAYBACK = 1.8;

// State thresholds (m/s), with hysteresis. Run is 5.2, quiet walk 2.6, crouch 2.0.
const RUN_ENTER = 3.8;
const RUN_EXIT = 3.4;
const MOVE_ENTER = 0.45;
const MOVE_EXIT = 0.3;
/** Speed smoothing rate (1/s); positions arrive interpolated but can still step. */
const SPEED_RATE = 10;
/** A jump in position bigger than this in one frame is a teleport (spawn, swap): not speed. */
const TELEPORT_DIST = 3;
const FADE = 0.15;
/** A corpse lies this long after the death clip ends, then is hidden. */
const CORPSE_TIME = 2.5;

// Upper-body one-shots for enemy ghosts, inferred from server visibility spikes: a knife swing
// forces vis to 0.6, damage to 0.8. A rise past SPIKE_START opens a short window; its peak
// decides which clip plays. (Defenders carry no signal for either in RemoteView.)
const SPIKE_START = 0.5;
const SPIKE_WINDOW = 0.1;
const SPIKE_HURT = 0.7;
const UPPER_IN = 0.08;
const UPPER_OUT = 0.2;

const S_IDLE = 'idle';
const S_WALK = 'walk';
const S_RUN = 'run';
const S_CIDLE = 'crouch_idle';
const S_CWALK = 'crouch_walk';
const S_DEATH = 'death';
const U_SLASH = 'slash';
const U_HIT = 'hit';
/** Defenders: static two-handed gun hold, and a short recoil that ends exactly on it (characters.py). */
const U_AIM = 'aim';
const U_SHOOT = 'shoot';
const BASE_STATES = [S_IDLE, S_WALK, S_RUN, S_CIDLE, S_CWALK, S_DEATH];
const UPPER_STATES = [U_SLASH, U_HIT, U_AIM, U_SHOOT];
const UPPER_ROOT_BONE = 'Abdomen';

// Aim pitch (defenders): after the animation is applied, bones turn about the character's right axis so
// the gun and head follow RemoteView.pitch. Fractions of the pitch per bone, applied parent first: the
// spine takes under half, the rest is both upper arms turning about the shoulder line (the two shoulder
// joints lie on that line, so the hands stay together on the gun); the neck adds a little for the head.
// Gun: 0.2 + 0.25 + 0.55 = the full pitch; head: 0.2 + 0.25 + 0.3. Clamped.
const PITCH_BONES = ['Abdomen', 'Chest', 'Neck', 'UpperArm.R', 'UpperArm.L'];
const PITCH_SHARE = [0.2, 0.25, 0.3, 0.55, 0.55];
const PITCH_LIMIT = 1.1;
const DEG_PER_RAD = 180 / Math.PI;

// ---------------------------------------------------------------------------------------------
// Skinned ghost shimmer. ShaderMaterial in engine 2.24 defines SKIN and adds the
// vertex_boneWeights / vertex_boneIndices attributes for skinned mesh instances, and exposes
// the engine's chunks to #include: "skinVS" provides getSkinMatrix() reading texture_poseMap.

const GHOST_VS = /* glsl */ `
attribute vec3 vertex_position;
attribute vec3 vertex_normal;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
#ifdef SKIN
#include "skinVS"
#endif
varying vec3 vWorldPos;
varying vec3 vNormal;
void main(void) {
#ifdef SKIN
    mat4 m = matrix_model * getSkinMatrix(vertex_boneIndices, vertex_boneWeights);
#else
    mat4 m = matrix_model;
#endif
    vec4 wp = m * vec4(vertex_position, 1.0);
    vWorldPos = wp.xyz;
    vNormal = mat3(m) * vertex_normal;
    gl_Position = matrix_viewProjection * wp;
}
`;

const GHOST_FS = /* glsl */ `
uniform vec3 view_position;
uniform float uVis;
uniform float uTime;
uniform vec3 uTint;
varying vec3 vWorldPos;
varying vec3 vNormal;

float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
                   mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
                   mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
void main(void) {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(view_position - vWorldPos);
    float fres = 1.0 - clamp(abs(dot(n, v)), 0.0, 1.0);
    float rim = fres * fres;
    vec3 p = vWorldPos * 5.0 + vec3(0.0, -uTime * 1.7, uTime * 0.6);
    float nz = vnoise(p) * 0.65 + vnoise(p * 2.3 + 7.1) * 0.35;
    float alpha = uVis * mix(0.45, 1.0, rim) * mix(0.7, 1.0, nz);
    // Dim interior and bright rim keep a moving ghost a haze outline; spikes (>= 0.6) flare up.
    float flare = smoothstep(0.4, 0.75, uVis);
    vec3 col = uTint * (0.3 + 0.9 * rim + 0.3 * nz) * (0.85 + 0.75 * flare);
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

export function makeSkinnedGhostMaterial(tint: Float32Array): pc.ShaderMaterial {
    const m = new pc.ShaderMaterial({
        uniqueName: 'sbGhostShimmerSkinned',
        vertexGLSL: GHOST_VS,
        fragmentGLSL: GHOST_FS,
        attributes: { vertex_position: pc.SEMANTIC_POSITION, vertex_normal: pc.SEMANTIC_NORMAL }
    });
    m.blendType = pc.BLEND_NORMAL;
    m.depthWrite = false;
    m.depthTest = true;
    m.cull = pc.CULLFACE_BACK;
    m.setParameter('uVis', 1);
    m.setParameter('uTime', 0);
    m.setParameter('uTint', tint);
    m.update();
    return m;
}

function makeDefenderMaterial(): pc.StandardMaterial {
    const m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(1, 1, 1);
    m.diffuseVertexColor = true;
    m.diffuseVertexColorChannel = 'rgb';
    m.gloss = 0.25;
    m.update();
    return m;
}

// ---------------------------------------------------------------------------------------------

export interface CharacterModel {
    asset: pc.Asset;
    tracks: Map<string, pc.AnimTrack>;
    defenderMat: pc.StandardMaterial;
    ghostMat: pc.ShaderMaterial;
}

/** Loads the shared character GLB. Rejects if it fails to load or lacks a required clip. */
export function loadCharacterModel(app: pc.Application, url: string, ghostMat: pc.ShaderMaterial,
    filename = 'character.glb'): Promise<CharacterModel> {
    return new Promise((resolve, reject) => {
        const asset = new pc.Asset('character', 'container', { url, filename });
        asset.once('load', () => {
            const res = asset.resource as pc.ContainerResource | undefined;
            if (!res) { reject(new Error('character model loaded without a resource')); return; }
            const tracks = new Map<string, pc.AnimTrack>();
            for (const a of res.animations) {
                const t = a.resource as pc.AnimTrack | undefined;
                if (t) tracks.set(t.name.replace(/^.*\|/, ''), t);
            }
            for (const s of BASE_STATES.concat(UPPER_STATES)) {
                if (!tracks.has(s)) { reject(new Error(`character model has no "${s}" clip`)); return; }
            }
            resolve({ asset, tracks, defenderMat: makeDefenderMaterial(), ghostMat });
        });
        asset.once('error', (err: unknown) => {
            app.assets.remove(asset);
            reject(new Error(`Failed to load ${url}: ${String(err)}`));
        });
        app.assets.add(asset);
        app.assets.load(asset);
    });
}

function upperMask(root: pc.Entity): Record<string, { children: boolean }> | null {
    const bone = root.findByName(UPPER_ROOT_BONE);
    if (!bone) return null;
    const names: string[] = [];
    for (let n: pc.GraphNode | null = bone; n && n !== root; n = n.parent) names.unshift(n.name);
    // The binder accepts paths that start with either the anim entity's name or the track's own
    // root name; register every suffix so whichever convention the tracks use matches.
    const mask: Record<string, { children: boolean }> = {};
    for (let i = 0; i < names.length; i++) {
        const tail = names.slice(i).join('/');
        mask[`${root.name}/${tail}`] = { children: true };
        mask[tail] = { children: true };
    }
    return mask;
}

export class Character {
    readonly entity: pc.Entity;
    readonly meshInstances: pc.MeshInstance[] = [];
    private readonly anim: pc.AnimComponent;
    private readonly base: pc.AnimComponentLayer;
    private readonly upper: pc.AnimComponentLayer | null;
    private readonly model: CharacterModel;
    private look: CharLook = CharLook.None;
    private state = '';
    private speed = 0;
    private px = 0;
    private pz = 0;
    private havePos = false;
    private alive = true;
    /** Seconds since death started; < 0 while alive. */
    private deadT = -1;
    private upperT = -1;
    private upperDur = 0;
    private prevVis = 0;
    private spikeT = -1;
    private spikePeak = 0;
    /** Holding the gun pose on the upper layer (defender look). */
    private armed = false;
    private tint: Float32Array | null = null;
    private fixedVis = 1;
    private gun: pc.Entity | null = null;
    private gunMuzzle: pc.GraphNode | null = null;
    private knife: pc.Entity | null = null;
    private knifeMi: pc.MeshInstance | null = null;
    private readonly pitchBones: pc.GraphNode[] = [];
    private readonly qa = new pc.Quat();
    private readonly qb = new pc.Quat();

    constructor(model: CharacterModel, parent: pc.Entity) {
        this.model = model;
        const res = model.asset.resource as pc.ContainerResource;
        const e = res.instantiateRenderEntity({ castShadows: false, receiveShadows: false });
        e.name = 'character';
        parent.addChild(e);
        this.entity = e;
        for (const r of e.findComponents('render') as pc.RenderComponent[]) {
            r.castShadows = false;
            r.receiveShadows = false;
            for (const mi of r.meshInstances) this.meshInstances.push(mi);
        }
        e.addComponent('anim', { activate: true, speed: 1 });
        this.anim = e.anim!;
        const baseStates: object[] = [{ name: 'START', speed: 1 }];
        for (const s of BASE_STATES) baseStates.push({ name: s, speed: 1, loop: s !== S_DEATH });
        const upperStates: object[] = [{ name: 'START', speed: 1 }];
        for (const s of UPPER_STATES) upperStates.push({ name: s, speed: 1, loop: false });
        this.anim.loadStateGraph(new pc.AnimStateGraph({
            layers: [
                { name: 'Base', states: baseStates, transitions: [{ from: 'START', to: S_IDLE }] },
                { name: 'Upper', states: upperStates, transitions: [], weight: 0 }
            ],
            parameters: {}
        }));
        this.base = this.anim.findLayer('Base')!;
        for (const s of BASE_STATES) this.base.assignAnimation(s, model.tracks.get(s)!);
        const mask = upperMask(e);
        const upper = this.anim.findLayer('Upper');
        if (upper && mask) {
            upper.mask = mask;
            for (const s of UPPER_STATES) upper.assignAnimation(s, model.tracks.get(s)!);
            upper.weight = 0;
            this.upper = upper;
        } else {
            this.upper = null;
        }
        for (const name of PITCH_BONES) {
            const b = e.findByName(name);
            if (b) this.pitchBones.push(b);
        }
        this.state = S_IDLE;
    }

    /** Puts the gun and knife into the hand sockets (once; the model may load after the character). */
    setWeapons(w: WeaponModel): void {
        if (this.gun || this.knife) return;
        const gs = this.entity.findByName('socket_gun');
        const ks = this.entity.findByName('socket_knife');
        if (gs) {
            const g = instantiateWeapon(w, 'gun', this.model.defenderMat);
            gs.addChild(g.entity);
            this.gun = g.entity;
            this.gunMuzzle = g.muzzle;
        }
        if (ks) {
            const k = instantiateWeapon(w, 'knife', this.model.ghostMat);
            ks.addChild(k.entity);
            this.knife = k.entity;
            this.knifeMi = k.meshInstance;
        }
        this.applyWeaponLook();
    }

    setLook(look: CharLook, tint: Float32Array | null, fixedVis: number): void {
        this.look = look;
        this.tint = tint;
        this.fixedVis = fixedVis;
        const ghost = look !== CharLook.Defender;
        const mat = ghost ? this.model.ghostMat : this.model.defenderMat;
        for (const mi of this.meshInstances) {
            mi.material = mat;
            if (ghost && tint) {
                mi.setParameter('uTint', tint);
                mi.setParameter('uVis', fixedVis);
            }
        }
        this.applyWeaponLook();
        this.setArmed(look === CharLook.Defender);
    }

    private applyWeaponLook(): void {
        const ghost = this.look === CharLook.EnemyGhost || this.look === CharLook.AllyGhost;
        if (this.gun) this.gun.enabled = this.look === CharLook.Defender;
        if (this.knife && this.knifeMi) {
            this.knife.enabled = ghost;
            // Same material and parameters as the body: the knife is never more visible than its owner.
            if (ghost && this.tint) {
                this.knifeMi.setParameter('uTint', this.tint);
                this.knifeMi.setParameter('uVis', this.fixedVis);
            }
        }
    }

    private setArmed(on: boolean): void {
        if (on === this.armed) return;
        this.armed = on;
        this.holdPose();
    }

    /** Upper layer at rest: the gun hold for defenders, nothing for ghosts. */
    private holdPose(): void {
        if (!this.upper) return;
        this.upperT = -1;
        if (this.armed && this.alive) {
            this.upper.play(U_AIM);
            this.upper.weight = 1;
        } else {
            this.upper.weight = 0;
        }
    }

    /** A remote shot by this player: recoil on the upper body. False if it cannot be shown. */
    shoot(): boolean {
        if (!this.armed || !this.alive || !this.upper) return false;
        this.upper.play(U_SHOOT);
        return true;
    }

    /** World position of the gun's muzzle, or null without a gun in hand. Valid until the next change. */
    muzzle(): pc.Vec3 | null {
        return this.armed && this.gun && this.gunMuzzle ? this.gunMuzzle.getPosition() : null;
    }

    /** World rotation of the gun (its -Z is the barrel), or null. */
    gunRotation(): pc.Quat | null {
        return this.armed && this.gun ? this.gun.getRotation() : null;
    }

    /** Bend the spine by the aim pitch. Must run after the animation has been applied this frame. */
    private applyPitch(pitch: number): void {
        const p = pitch > PITCH_LIMIT ? PITCH_LIMIT : pitch < -PITCH_LIMIT ? -PITCH_LIMIT : pitch;
        if (p > -1e-3 && p < 1e-3) return;
        const right = this.entity.parent ? this.entity.parent.right : this.entity.right;
        for (let i = 0; i < this.pitchBones.length; i++) {
            const b = this.pitchBones[i];
            // Positive angle about +right tips -Z (forward) up: positive pitch looks up.
            this.qa.setFromAxisAngle(right, p * PITCH_SHARE[i] * DEG_PER_RAD);
            this.qb.copy(b.getRotation());
            this.qa.mul(this.qb);
            b.setRotation(this.qa);
        }
    }

    /** Called when the pooled record is (re)assigned to a player: forget motion history. */
    reset(): void {
        this.havePos = false;
        this.speed = 0;
        this.deadT = -1;
        this.alive = true;
        this.upperT = -1;
        this.spikeT = -1;
        this.prevVis = 0;
        this.holdPose();
        this.go(S_IDLE, 0);
    }

    setVis(vis: number): void {
        for (let i = 0; i < this.meshInstances.length; i++) this.meshInstances[i].setParameter('uVis', vis);
        if (this.knifeMi) this.knifeMi.setParameter('uVis', vis);
    }

    private go(state: string, fade: number): void {
        if (state === this.state) return;
        this.state = state;
        this.base.transition(state, fade);
    }

    private playUpper(state: string): void {
        if (!this.upper) return;
        this.upper.play(state);
        this.upper.blendToWeight(1, UPPER_IN);
        this.upperDur = this.model.tracks.get(state)!.duration;
        this.upperT = 0;
    }

    /**
     * Advance the character for this frame. Returns false when it should not be drawn at all
     * (a dead player whose corpse time is over, or one first seen already dead).
     */
    update(dt: number, v: RemoteView): boolean {
        // Speed from the position delta (horizontal only).
        const x = v.pos[0], z = v.pos[2];
        if (this.havePos && dt > 0) {
            const dx = x - this.px, dz = z - this.pz;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d > TELEPORT_DIST) this.speed = 0;
            else this.speed += (d / dt - this.speed) * (1 - Math.exp(-SPEED_RATE * dt));
        } else if (!this.havePos) {
            // First frame for this player: if already dead, never show a corpse popping in.
            this.alive = v.alive;
            this.deadT = v.alive ? -1 : CORPSE_TIME + 10;
        }
        this.px = x; this.pz = z; this.havePos = true;

        if (!v.alive) {
            if (this.alive) {
                this.alive = false;
                this.deadT = 0;
                if (this.upper) { this.upper.weight = 0; this.upperT = -1; }
                this.anim.speed = 1;
                this.go(S_DEATH, 0.1);
            } else {
                this.deadT += dt;
            }
            return this.deadT < this.model.tracks.get(S_DEATH)!.duration + CORPSE_TIME;
        }
        if (!this.alive) {
            // Respawned: snap straight to idle (never blend out of a corpse).
            this.alive = true;
            this.deadT = -1;
            this.go(S_IDLE, 0);
            this.holdPose();
        }

        const s = this.speed;
        let next: string;
        if (v.crouched) {
            const moving = this.state === S_CWALK || this.state === S_WALK || this.state === S_RUN
                ? s > MOVE_EXIT : s > MOVE_ENTER;
            next = moving ? S_CWALK : S_CIDLE;
        } else if (this.state === S_RUN ? s > RUN_EXIT : s > RUN_ENTER) {
            next = S_RUN;
        } else {
            const moving = this.state === S_WALK || this.state === S_CWALK || this.state === S_RUN
                ? s > MOVE_EXIT : s > MOVE_ENTER;
            next = moving ? S_WALK : S_IDLE;
        }
        this.go(next, FADE);
        const clip = next === S_RUN ? RUN_CLIP_SPEED : next === S_WALK ? WALK_CLIP_SPEED
            : next === S_CWALK ? CROUCH_CLIP_SPEED : 0;
        this.anim.speed = clip > 0 ? Math.min(MAX_PLAYBACK, Math.max(MIN_PLAYBACK, s / clip)) : 1;

        // Upper-body one-shots (enemy ghosts only; see SPIKE_* above).
        if (this.look === CharLook.EnemyGhost) {
            const vis = v.vis;
            if (this.spikeT < 0 && vis >= SPIKE_START && this.prevVis < SPIKE_START) {
                this.spikeT = 0;
                this.spikePeak = vis;
            } else if (this.spikeT >= 0) {
                this.spikeT += dt;
                if (vis > this.spikePeak) this.spikePeak = vis;
                if (this.spikeT >= SPIKE_WINDOW) {
                    this.spikeT = -1;
                    this.playUpper(this.spikePeak >= SPIKE_HURT ? U_HIT : U_SLASH);
                }
            }
            this.prevVis = vis;
        }
        if (this.upperT >= 0 && this.upper) {
            this.upperT += dt * this.anim.speed;
            if (this.upperT >= this.upperDur - UPPER_OUT) {
                this.upper.blendToWeight(0, UPPER_OUT);
                this.upperT = -1;
            }
        }
        if (this.armed) this.applyPitch(v.pitch);
        return true;
    }
}
