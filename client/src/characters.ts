import * as pc from 'playcanvas';
import { TICK_RATE } from '@shared/constants';
import { SLOT_COUNT, SLOT_KNIFE, WEAPONS } from '@shared/weapons';
import type { RemoteView } from './presenter-api';
import { instantiateWeapon, WEAPON_MESH, type WeaponInstance, type WeaponModel } from './weapons';

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
 *   - "Upper" layer: masked to the spine and arms. Defenders hold their weapon on it at full weight (rifle "aim",
 *     one-handed "pistol", "knife_hold"); ghosts leave it at weight 0 and fade in only for a swing or a flinch.
 *     Reloads and knife swings are time-synced one-shots: the layer's clip time is set every frame from real seconds
 *     (`activeStateCurrentTime`), so they keep the rule's timing whatever speed the legs play at.
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
 *   - Defenders carry every gun in the table (shared/weapons.ts; same vertex-colour material as the body),
 *     all in socket_gun with only the one in hand (RemoteView.weapon) enabled, held with the rifle's two-handed
 *     "aim" pose or the pistol's one-handed "pistol" pose; a remote shot plays "shoot" / "pistol_shoot" (a recoil
 *     that ends on the hold). RemoteView.reloading plays "reload_rifle" (2.2 s) or "reload_pistol" (1.4 s) from
 *     its start, cut back to the hold if the reload ends early. With the knife (slot SLOT_KNIFE) they hold it in
 *     socket_knife ("knife_hold") and swing with "knife_swing": started by the windup sound (`swing`) and brought
 *     to its strike by the server's slash event (`slash`), so the blade lands when the hit does.
 *     Guns are drawn bare or suppressed by the room option (`setSuppressed`, weapons.ts): one mesh either way.
 *     After the animation is applied, the spine is bent by the aim pitch; the same bones also dip the weapon
 *     briefly while switching, bring the head down to the gun while aiming, and lean the back forward while
 *     crouched (the hold clips are upright; the arms and head turn back so the weapon stays level).
 *   - Ghosts carry the knife, drawn with the body's own material and per-instance parameters, so it is
 *     exactly as visible as the body (and disabled with it when the player is culled). Their swing is the same
 *     "knife_swing", driven by the same two events (not guessed from visibility); a flinch ("hit") is still
 *     inferred from the visibility spike a hit causes, the only signal there is for it.
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

// Flinch for enemy ghosts, inferred from server visibility spikes: damage forces vis to 0.8 (a knife swing to 0.6,
// which is ignored: swings come from their own events). A rise past SPIKE_START opens a short window; a peak at or
// above SPIKE_HURT plays "hit".
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
const U_HIT = 'hit';
/** Defenders: static two-handed rifle hold, and a short recoil that ends exactly on it (characters.py). */
const U_AIM = 'aim';
const U_SHOOT = 'shoot';
/** One-handed pistol hold and its recoil; reloads per gun; the knife hold and the knife swing (characters.py). */
const U_PISTOL = 'pistol';
const U_PISTOL_SHOOT = 'pistol_shoot';
const U_KNIFE = 'knife_hold';
const U_SWING = 'knife_swing';
/** Clip seconds of the swing's windup (characters.py): the slash event brings the swing to this point. */
const SWING_WINDUP = 0.2;
const BASE_STATES = [S_IDLE, S_WALK, S_RUN, S_CIDLE, S_CWALK, S_DEATH];
/** Per gun in the weapon table (shared/weapons.ts): hold, recoil and reload clips. */
const GUN_HOLD: readonly string[] = WEAPONS.map(w => w.id === 'pistol' ? U_PISTOL : U_AIM);
const GUN_SHOOT: readonly string[] = WEAPONS.map(w => w.id === 'pistol' ? U_PISTOL_SHOOT : U_SHOOT);
const GUN_RELOAD: readonly string[] = WEAPONS.map(w => `reload_${w.id}`);
const GUN_RELOAD_SECONDS: readonly number[] = WEAPONS.map(w => w.reloadTicks / TICK_RATE);
const UPPER_STATES = [U_HIT, U_AIM, U_SHOOT, U_PISTOL, U_PISTOL_SHOOT, U_KNIFE, U_SWING, ...GUN_RELOAD];
/** Fade into and out of the synced one-shots and between holds (s). */
const HOLD_FADE = 0.12;
const UPPER_ROOT_BONE = 'Abdomen';

// Aim pitch (defenders): after the animation is applied, bones turn about the character's right axis so
// the gun and head follow RemoteView.pitch. Fractions of the pitch per bone, applied parent first: the
// spine takes under half, the rest is both upper arms turning about the shoulder line (the two shoulder
// joints lie on that line, so the hands stay together on the gun); the neck adds a little for the head.
// Gun: 0.2 + 0.25 + 0.55 = the full pitch; head: 0.2 + 0.25 + 0.3. Clamped.
const PITCH_BONES = ['Abdomen', 'Chest', 'Neck', 'UpperArm.R', 'UpperArm.L'];
const PITCH_SHARE = [0.2, 0.25, 0.3, 0.55, 0.55];
const PITCH_LIMIT = 1.1;
// Crouched with a weapon held: the hold clips keep the back upright, so lean it forward here (negative tips
// forward) and turn the head and both upper arms back by the same amount, so the weapon and the eyes stay level.
// Abdomen + Chest = -0.44, cancelled by +0.44 on the arms; the neck leaves the head 0.08 down. tools/blender/review.py
// applies the same numbers to its crouch frames.
const CROUCH_LEAN = [-0.32, -0.12, 0.36, 0.44, 0.44];
const CROUCH_BLEND = 0.15;
// Switching (RemoteView.switching, 0.25 to 0.4 s): a shorter, shallower dip, quick in and out.
const SWITCH_DIP = [-0.03, -0.06, -0.05, -0.3, -0.3];
const SWITCH_BLEND = 0.08;
// Aiming down sights: arms up a touch, head tipped down toward the sights. Small: the hold is already aimed.
const AIM_RAISE = [0, 0.02, -0.14, 0.05, 0.05];
const AIM_BLEND = 0.12;
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
#include "gammaPS"
#include "tonemappingPS"
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
    // Package G, tuned against the baked maps: the outermost edge turns dark, so the haze reads against sunlit
    // concrete as well as in the dark basement (a pale-only rim vanished on bright floors). Same opacity as before.
    col = mix(col, uTint * 0.1, smoothstep(0.72, 0.95, fres) * (1.0 - flare));
    // Written as a colour on screen in both tiers: through the camera's tone map and gamma like everything else.
    gl_FragColor = vec4(gammaCorrectOutput(toneMap(pow(col, vec3(2.2)))), clamp(alpha, 0.0, 1.0));
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

/** Moves a 0..1 weight `step` toward 1 while `on`, toward 0 otherwise. */
function blendTo(w: number, on: boolean, step: number): number {
    return on ? Math.min(1, w + step) : Math.max(0, w - step);
}

function smooth(x: number): number {
    return x * x * (3 - 2 * x);
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
    /** One instance per gun (only the held one enabled), each with its muzzle for the current look. */
    private readonly guns: pc.Entity[] = [];
    private readonly gunInstances: WeaponInstance[] = [];
    /** Slot in hand (a gun, or SLOT_KNIFE). */
    private slot = 0;
    /** The ghost's knife (ghost material) and the defender's (defender material), both in socket_knife. */
    private knife: pc.Entity | null = null;
    private knifeMi: pc.MeshInstance | null = null;
    private defenderKnife: pc.Entity | null = null;
    private suppressed = false;
    private readonly pitchBones: pc.GraphNode[] = [];
    private readonly pitchShare: number[] = [];
    private readonly crouchLean: number[] = [];
    private readonly switchDip: number[] = [];
    private readonly aimRaise: number[] = [];
    /** Weights 0..1 of the crouch lean, the switch dip and the aim raise. */
    private crouchW = 0;
    private switchW = 0;
    private aimW = 0;
    /**
     * Time-synced one-shot on the upper layer (a reload or a knife swing): its clip, seconds since it started, clip
     * seconds per real second, and its length in clip seconds. `syncClip` is null when none plays.
     */
    private syncClip: string | null = null;
    private syncT = 0;
    private syncRate = 1;
    private syncDur = 0;
    private wasReloading = false;
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
        for (let i = 0; i < PITCH_BONES.length; i++) {
            const b = e.findByName(PITCH_BONES[i]);
            if (!b) continue;
            this.pitchBones.push(b);
            this.pitchShare.push(PITCH_SHARE[i]);
            this.crouchLean.push(CROUCH_LEAN[i]);
            this.switchDip.push(SWITCH_DIP[i]);
            this.aimRaise.push(AIM_RAISE[i]);
        }
        this.state = S_IDLE;
    }

    /** Puts the guns and knife into the hand sockets (once; the model may load after the character). */
    setWeapons(w: WeaponModel): void {
        if (this.guns.length > 0 || this.knife) return;
        const gs = this.entity.findByName('socket_gun');
        const ks = this.entity.findByName('socket_knife');
        if (gs) {
            // Every gun's origin is its grip, so all share the socket; still one draw call, as only one is enabled.
            for (let i = 0; i < WEAPONS.length; i++) {
                const g = instantiateWeapon(w, WEAPON_MESH[WEAPONS[i].id], this.model.defenderMat);
                g.setSuppressed(this.suppressed);
                gs.addChild(g.entity);
                this.guns.push(g.entity);
                this.gunInstances.push(g);
            }
        }
        if (ks) {
            const k = instantiateWeapon(w, 'knife', this.model.ghostMat);
            ks.addChild(k.entity);
            this.knife = k.entity;
            this.knifeMi = k.meshInstance;
            const dk = instantiateWeapon(w, 'knife', this.model.defenderMat);
            ks.addChild(dk.entity);
            this.defenderKnife = dk.entity;
        }
        this.applyWeaponLook();
    }

    /** The room's suppressed-weapons option: suppressors on both guns, or bare muzzles. */
    setSuppressed(on: boolean): void {
        this.suppressed = on;
        for (const g of this.gunInstances) g.setSuppressed(on);
    }

    /** This player started a knife swing (its windup sound): a defender holding the knife, or a ghost. */
    swing(): void {
        if (!this.canSwing()) return;
        this.startSync(U_SWING, 1, 0);
    }

    /** This player's swing landed (the slash event): strike now, from the end of the windup at the latest. */
    slash(): void {
        if (!this.canSwing()) return;
        if (this.syncClip === U_SWING) {
            if (this.syncT < SWING_WINDUP) this.syncT = SWING_WINDUP;
        } else {
            this.startSync(U_SWING, 1, SWING_WINDUP);
        }
    }

    private canSwing(): boolean {
        if (!this.alive || !this.upper) return false;
        return this.armed ? this.slot === SLOT_KNIFE : this.look === CharLook.EnemyGhost || this.look === CharLook.AllyGhost;
    }

    /** Starts a time-synced one-shot at `from` real seconds in, `rate` clip seconds per second. */
    private startSync(clip: string, rate: number, from: number): void {
        if (!this.upper) return;
        this.upperT = -1;
        this.syncClip = clip;
        this.syncRate = rate;
        this.syncT = from;
        this.syncDur = this.model.tracks.get(clip)!.duration;
        this.upper.transition(clip, this.armed ? HOLD_FADE : 0);
        this.upper.activeStateCurrentTime = from * rate;
        if (!this.armed) this.upper.blendToWeight(1, UPPER_IN);
        else this.upper.weight = 1;
    }

    /** Ends the synced one-shot: back to the weapon hold (defenders) or fade the layer out (ghosts). */
    private endSync(): void {
        this.syncClip = null;
        if (!this.upper) return;
        if (this.armed && this.alive) this.upper.transition(this.holdClip(), HOLD_FADE);
        else this.upper.blendToWeight(0, UPPER_OUT);
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
        for (let i = 0; i < this.guns.length; i++) this.guns[i].enabled = this.look === CharLook.Defender && i === this.slot;
        if (this.defenderKnife) this.defenderKnife.enabled = this.look === CharLook.Defender && this.slot === SLOT_KNIFE;
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

    /** The hold clip for the slot in hand. */
    private holdClip(): string {
        return this.slot === SLOT_KNIFE ? U_KNIFE : GUN_HOLD[this.slot] ?? U_AIM;
    }

    /** Upper layer at rest: the weapon hold for defenders (gun or knife), nothing for ghosts. */
    private holdPose(): void {
        if (!this.upper) return;
        this.upperT = -1;
        this.syncClip = null;
        if (this.armed && this.alive) {
            this.upper.play(this.holdClip());
            this.upper.weight = 1;
        } else {
            this.upper.weight = 0;
        }
    }

    /** A remote shot by this player: recoil on the upper body. False if it cannot be shown. */
    shoot(): boolean {
        if (!this.armed || !this.alive || !this.upper || this.slot === SLOT_KNIFE) return false;
        if (this.syncClip) return true; // mid-reload: the flash and tracer still show, the reload keeps playing
        this.upper.play(GUN_SHOOT[this.slot] ?? U_SHOOT);
        return true;
    }

    /** World position of the held gun's muzzle, or null without a gun in hand. Valid until the next change. */
    muzzle(): pc.Vec3 | null {
        const m = this.armed ? this.gunInstances[this.slot]?.muzzle ?? null : null;
        return m ? m.getPosition() : null;
    }

    /** World rotation of the held gun (its -Z is the barrel), or null. */
    gunRotation(): pc.Quat | null {
        const g = this.armed ? this.guns[this.slot] : undefined;
        return g ? g.getRotation() : null;
    }

    /**
     * Bend the spine by the aim pitch, plus the crouch lean, switch dip and aim raise at weights `cw`, `sw`,
     * `aw`. Must run after the animation has been applied this frame.
     */
    private applyPitch(pitch: number, cw: number, sw: number, aw: number): void {
        const p = pitch > PITCH_LIMIT ? PITCH_LIMIT : pitch < -PITCH_LIMIT ? -PITCH_LIMIT : pitch;
        if (p > -1e-3 && p < 1e-3 && cw <= 0 && sw <= 0 && aw <= 0) return;
        const right = this.entity.parent ? this.entity.parent.right : this.entity.right;
        for (let i = 0; i < this.pitchBones.length; i++) {
            const b = this.pitchBones[i];
            const a = p * this.pitchShare[i] + cw * this.crouchLean[i] + sw * this.switchDip[i] + aw * this.aimRaise[i];
            // Positive angle about +right tips -Z (forward) up: positive pitch looks up.
            this.qa.setFromAxisAngle(right, a * DEG_PER_RAD);
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
        this.crouchW = 0;
        this.switchW = 0;
        this.aimW = 0;
        this.wasReloading = false;
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
                this.syncClip = null;
                this.wasReloading = false;
                this.crouchW = 0;
                this.switchW = 0;
                this.aimW = 0;
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
                    if (this.spikePeak >= SPIKE_HURT && !this.syncClip) this.playUpper(U_HIT);
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
        if (this.armed) {
            const slot = v.weapon >= 0 && v.weapon < SLOT_COUNT ? v.weapon : 0;
            if (slot !== this.slot) {
                this.slot = slot;
                this.applyWeaponLook();
                this.syncClip = null;
                if (this.upper) this.upper.transition(this.holdClip(), HOLD_FADE);
            }
            // Reload: from its first frame, timed to the rule; back to the hold if it ends early.
            const reloading = v.reloading && slot !== SLOT_KNIFE;
            if (reloading && !this.wasReloading) {
                const clip = GUN_RELOAD[slot];
                this.startSync(clip, this.model.tracks.get(clip)!.duration / GUN_RELOAD_SECONDS[slot], 0);
            } else if (!reloading && this.wasReloading && this.syncClip === GUN_RELOAD[slot]) {
                this.endSync();
            }
            this.wasReloading = reloading;
            this.switchW = blendTo(this.switchW, v.switching, dt / SWITCH_BLEND);
            this.aimW = blendTo(this.aimW, v.aiming && !v.reloading, dt / AIM_BLEND);
            this.crouchW = blendTo(this.crouchW, v.crouched, dt / CROUCH_BLEND);
        }
        if (this.syncClip && this.upper) {
            this.syncT += dt;
            const t = this.syncT * this.syncRate;
            if (t >= this.syncDur) this.endSync();
            else this.upper.activeStateCurrentTime = t;
        }
        if (this.armed) {
            // Smoothstep so each starts and ends gently.
            this.applyPitch(v.pitch, smooth(this.crouchW), smooth(this.switchW), smooth(this.aimW));
        }
        return true;
    }
}
