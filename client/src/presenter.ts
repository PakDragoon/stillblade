import * as pc from 'playcanvas';
import {
    EYE_HEIGHT, EYE_HEIGHT_CROUCHED, HEAD_ZONE, HULL_HALF_WIDTH, HULL_HEIGHT, HULL_HEIGHT_CROUCHED
} from '@shared/constants';
import type { RosterEntry, Team } from '@shared/protocol';
import { type Phase, type RoundReason } from '@shared/rules';
import type { Box, Vec3 } from '@shared/types';
import { corpseYaw } from './corpse';
import type { CreatePresenter, CrosshairConfig, KillKind, LocalView, MatchView, RemoteView } from './presenter-api';
import { Character, CharLook, loadCharacterModel, makeSkinnedGhostMaterial, type CharacterModel } from './characters';
import { TICK_RATE } from '@shared/constants';
import { bindings } from './bindings';
import { SIGHTS, SIGHT_IRON, SLOT_COUNT, SLOT_KNIFE, WEAPONS, adsZoomOf, isGunSlot, sightDef, slotLabel, type SightId, type WeaponId } from '@shared/weapons';
import type { HitZone } from '@shared/zones';
import {
    instantiateWeapon, loadWeaponModel, WEAPON_MESH, WeaponMaterials, type WeaponInstance, type WeaponModel
} from './weapons';
import { loadViewmodel, type VmClip, type VmRig } from './viewmodel';
import { Effects, faceAt, type Surface } from './effects';
import type { Tier } from './graphics';
import { DYN_COL_UNIFORM, DYN_LIGHTS, DYN_POS_UNIFORM, type LookTuning } from './maplook';
import { defaultLight, LIGHT_FLOATS, useProbeLighting, type MapLighting } from './lighting';
import { ViewFeel, type FeelInput, type RecoilFeel } from './vmfeel';

const DEG = 180 / Math.PI;
const HEAD_WIDTH = 0.4;
const CROUCH_RATE = 14;
const TRACER_LIFE = 0.09;
const TRACER_THICKNESS = 0.02;
/** High tier: dynamic light of a muzzle flash (radius m, colour x intensity). */
const FLASH_LIGHT_RADIUS = 6;
const FLASH_LIGHT: readonly number[] = [3.2, 2.3, 1.1];
/** The planted bomb's blinking light (High: a dynamic light; both tiers: a glow sprite). */
const BOMB_LIGHT_RADIUS = 3.2;
const BOMB_LIGHT: readonly number[] = [2.4, 0.15, 0.08];
/** The explosion's flash: radius (m), colour x intensity, and how long it fades (s). */
const BOOM_LIGHT_RADIUS = 12;
const BOOM_LIGHT: readonly number[] = [3, 1.8, 0.8];
const BOOM_TIME = 1.1;
/** High tier: blob shadow radius (m) and darkness under a standing player. */
const SHADOW_RADIUS = 0.55;
const SHADOW_ALPHA = 0.5;
const FLASH_TIME = 0.04;
/** Unsuppressed guns (room option off): a bigger star-shaped flash, shown a little longer. */
const LOUD_FLASH_TIME = 0.055;
const LOUD_FLASH_SIZE = 0.2;
const KILLFEED_MAX = 5;
const KILLFEED_LIFE = 5;
const KILLFEED_FADE = 0.5;
const MAX_PIPS = 5;
const DMG_MARKERS = 4;
const DMG_LIFE = 1.2;
/** Model knife: handle centre sits this far behind the knife pivot (the box knife's guard). */
const KNIFE_MODEL_BACK = 0.055;
/** Idle sway of the viewmodel: amplitude (m, degrees) and rate (rad/s). Time-based only. */
const SWAY_POS = 0.0022;
const SWAY_ROT = 0.45;
const SWAY_RATE = 1.3;
/**
 * The first-person weapon is drawn as if by a camera with this vertical field of view (degrees), whatever the
 * player's field of view setting: at a wide setting the world shrinks but the weapon and hands keep their size and
 * place on screen, as in other shooters. Done without a second camera: the viewmodel root is scaled across the view
 * (x and y, not depth) by tan(world fov / 2) / tan(VM_FOV / 2), which projects exactly like a VM_FOV camera, keeps
 * the screen centre (so aimed sights stay lined up) and keeps the muzzle where the tracers start. The arms' skinning
 * shader takes the scale into its normals (weapons.ts `fovLockNormals`).
 */
const VM_FOV = 74;
const VM_TAN = Math.tan((VM_FOV / 2) * Math.PI / 180);
/**
 * Share of the 2x scope's zoom the weapon itself gets when aimed: the world behind the lens is magnified 2x, the
 * scope's housing only 1 + (2 - 1) * this, so the housing takes less of the screen round the lens.
 */
const VM_SCOPE_ZOOM_SHARE = 0.35;
/** Share of the sway left when fully aimed down sights. */
const AIM_SWAY = 0.2;
/** Rate (1/s) at which a player's or the weapon's light follows the probes as they move. */
const LIGHT_EASE = 5;
/** A camera jump longer than this (m) in one frame (a respawn, a spectator switch) takes the new light at once. */
const LIGHT_SNAP = 3;

/** Eases light uniforms `dst` toward `src` by `t` (0..1), keeping the key direction a unit vector. */
function blendLight(dst: Float32Array, src: Float32Array, t: number): void {
    for (let i = 0; i < dst.length; i++) dst[i] += (src[i] - dst[i]) * t;
    const l = Math.hypot(dst[18], dst[19], dst[20]) || 1;
    dst[18] /= l; dst[19] /= l; dst[20] /= l;
}
/** Return rate (1/s) of the reload pose when a reload is cancelled. */
const RELOAD_RETURN = 12;
/** The spread ticks fade to this opacity when fully aimed (the dot stays). */
const XHAIR_AIM_OPACITY = 0.15;

/**
 * Aiming (package M part 2): weapons.glb carries, per gun and sight, the point where the eye sits when aiming with it
 * (`<gun>_aim_<sight>`: on the sight's optical axis, at its eye relief; tools/blender/weapons.py). Aimed, the gun is
 * placed so that point is the camera, so the sight's centre is the screen centre whatever the model. Until the model
 * has loaded, VM_LOOKS[..].aim stands in, lowered by these optical axis heights above the iron line (metres).
 */
const SIGHT_EYE_FALLBACK: Record<SightId, number> = { iron: 0, reddot: 0.02, scope2x: 0.03 };
/** The red dot's DOM reticle (only while the gun has no reticle of its own) starts at this aim progress. */
const SIGHT_OVERLAY_FROM = 0.55;
/**
 * The 2x scope's reticle (a chevron, DOM) fades in from this aim progress: by then the scope's eyepiece is centred.
 * The scope itself is the model, seen from close behind its eyepiece: the view is magnified by the aim zoom and the
 * scope's body and the gun stay in view around the lens (no blackout, no second render pass).
 */
const SCOPE_RETICLE_FROM = 0.8;

/**
 * First-person look of each defender weapon, by WeaponId (shared/weapons.ts). Positions are metres in
 * camera space, angles degrees (pitch, yaw, roll; positive pitch tips the muzzle up). Every model's origin is
 * its grip (weapons.ts), so a pose is where the hand holds it.
 */
interface VmLook {
    /** From the hip: low right, a small inward yaw / roll so it reads as held, the suppressor toward the crosshair. */
    hip: readonly number[];
    /** Aimed down sights: centred, the top of the gun just under the crosshair. */
    aim: readonly number[];
    /** Offset at the start of a switch (draw = 1): below and rotated away, eased back to zero. */
    draw: readonly number[];
    /** Reload pose offset (x, y, z, pitch, yaw, roll), blended in by reload progress. */
    reload: readonly number[];
    /** Fractions of the reload spent going into and coming out of the reload pose. */
    reloadIn: number;
    reloadOut: number;
    /**
     * Jolts during the reload, timed to the sounds in audio.ts: [ms from the start, half-width ms, size].
     * Size 1 lifts the gun 12 mm and tips it up 5 degrees; negative dips it. Only without the arms rig.
     */
    jolts: readonly (readonly [number, number, number])[];
    /**
     * Firing kick (package Q: springs in vmfeel.ts that settle like a gun coming back to rest, a little different on
     * every shot by the shot count), and how long the idle sway stays damped after a shot (s).
     */
    recoil: RecoilFeel;
    /** The same for the empty reload (`LocalView.reloadEmpty`, the weapon's `reloadEmptyTicks` long). */
    joltsEmpty: readonly (readonly [number, number, number])[];
    kickTime: number;
    /** Size of the muzzle flash and tracer relative to the rifle's. */
    fx: number;
}

const VM_LOOKS: Record<WeaponId, VmLook> = {
    rifle: {
        hip: [0.155, -0.168, -0.155, 2, 11, -1],
        aim: [-0.013, -0.226, -0.47, 0, 0, 0],
        draw: [0.03, -0.24, 0.06, -40, 12, 25],
        // Raised, the muzzle tipped up and to the right, rolled clockwise so the magazine well faces the support hand
        // (only without the arms rig: its reload clip moves the gun, viewmodel.py RELOAD_MAG).
        reload: [0.01, 0.05, -0.08, 40, -40, -30],
        reloadIn: 0.2, reloadOut: 0.2,
        // Package R (the pack's clips, audio-logic.ts RELOAD_CUES): the magazine seats at 1.55 s (tactical, no bolt);
        // in the empty reload at 1.63 s, and the charging handle lets the bolt slam home at about 2.07 s.
        jolts: [[1550, 110, 1]],
        joltsEmpty: [[1630, 110, 1], [2070, 88, 0.7]],
        recoil: { back: 0.03, lift: 0.007, pitch: 3.2, side: 0.7, roll: 1.1, camRoll: 0.35, camPitch: 0.1 }, kickTime: 0.08,
        fx: 1
    },
    pistol: {
        hip: [0.085, -0.105, -0.18, -2, 12, -1],
        aim: [-0.002, -0.084, -0.3, 0, 0, 0],
        draw: [0, -0.2, 0.05, -55, 0, 20],
        // Tilted onto its side and brought in, magazine well toward the support hand.
        reload: [-0.04, -0.04, 0.04, 16, 12, -38],
        reloadIn: 0.15, reloadOut: 0.13,
        // Magazine drops (0.18 s), new one slapped in (0.7 s), slide pulled (1.08 s) and released (1.17 s).
        jolts: [[180, 90, -0.7], [700, 80, 1], [1080, 60, -0.6], [1170, 60, 1.3]],
        // The pistol has no separate empty reload (its reloadEmptyTicks equals reloadTicks).
        joltsEmpty: [[180, 90, -0.7], [700, 80, 1], [1080, 60, -0.6], [1170, 60, 1.3]],
        recoil: { back: 0.026, lift: 0.013, pitch: 7.5, side: 1.1, roll: 1.8, camRoll: 0.5, camPitch: 0.18 }, kickTime: 0.11,
        fx: 0.75
    }
};

/** Jolt times as fractions of one reload. */
interface Jolts {
    at: number[];
    w: number[];
    size: number[];
}
/** VM_LOOKS per slot, with the jolt times turned into fractions of that weapon's own reloads (tactical, empty). */
interface SlotLook extends VmLook {
    joltsOf: Jolts;
    joltsEmptyOf: Jolts;
}
const toJolts = (js: VmLook['jolts'], ticks: number): Jolts => {
    const ms = (ticks / TICK_RATE) * 1000;
    return { at: js.map(j => j[0] / ms), w: js.map(j => j[1] / ms), size: js.map(j => j[2]) };
};
const SLOT_LOOKS: readonly SlotLook[] = WEAPONS.map(w => {
    const look = VM_LOOKS[w.id];
    return { ...look, joltsOf: toJolts(look.jolts, w.reloadTicks), joltsEmptyOf: toJolts(look.joltsEmpty, w.reloadEmptyTicks) };
});

/**
 * Clip names per gun slot, built once (no string building per frame). Package R: the rifle rig also has
 * `rifle_reload_empty` (played for an empty reload), `rifle_draw` (the switch, sampled by draw progress, in place of
 * the procedural rise) and `rifle_fire` (one fire interval long, sampled by the time since the last local shot);
 * a rig without them (the pistol, or an older file) keeps the old behaviour. `rifle_holster` is in the file but unused:
 * the rule has no holster time (a switch only draws the new weapon).
 */
const IDLE_CLIP: readonly string[] = WEAPONS.map(w => `${w.id}_idle`);
const RELOAD_CLIP: readonly string[] = WEAPONS.map(w => `${w.id}_reload`);
const RELOAD_EMPTY_CLIP: readonly string[] = WEAPONS.map(w => `${w.id}_reload_empty`);
const DRAW_CLIP: readonly string[] = WEAPONS.map(w => `${w.id}_draw`);
const FIRE_CLIP: readonly string[] = WEAPONS.map(w => `${w.id}_fire`);

/** Gun slot index clamped into the weapon table (the knife slot is handled before this is used). */
function slotOf(weapon: number): number {
    return weapon >= 0 && weapon < WEAPONS.length ? weapon | 0 : 0;
}

/**
 * The unsuppressed muzzle flash: one mesh (one draw call) of crossed spikes along -Z and a ring of rays
 * around the muzzle, unit size, drawn two-sided with the opaque flash material.
 */
function makeFlashMesh(device: pc.GraphicsDevice): pc.Mesh {
    const pos: number[] = [];
    const idx: number[] = [];
    const quad = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
        dx: number, dy: number, dz: number): void => {
        const o = pos.length / 3;
        pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
        idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    };
    // Forward cone: two crossed diamonds, widest a quarter of the way out.
    quad(0, 0, 0.05, 0.28, 0, -0.25, 0, 0, -1, -0.28, 0, -0.25);
    quad(0, 0, 0.05, 0, 0.28, -0.25, 0, 0, -1, 0, -0.28, -0.25);
    // Side rays in the muzzle plane.
    const RAYS = 6;
    for (let i = 0; i < RAYS; i++) {
        const a = (i / RAYS) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        const w = 0.07, len = i % 2 === 0 ? 0.55 : 0.38;
        quad(-s * w, c * w, -0.05, c * len * 0.4, s * len * 0.4, -0.12, c * len, s * len, -0.05, s * w, -c * w, -0.05);
    }
    const mesh = new pc.Mesh(device);
    mesh.setPositions(pos);
    mesh.setIndices(idx);
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    return mesh;
}

/** Kill feed suffix for how a kill was made (the gun or knife name is shown separately). */
function killSuffix(kind: KillKind, zone: HitZone | null): string {
    if (kind === 'backstab') return ' (backstab)';
    if (kind === 'shot' && zone === 'head') return ' (HS)';
    return '';
}

/** Death recap wording for where the killing shot landed. */
const ZONE_RECAP: Record<HitZone, string> = { head: ' (headshot)', torso: '', arms: ' (arm shot)', legs: ' (leg shot)' };

/** A smooth 0..1..0 bump of half-width `w` centred on `c`. */
function bump(x: number, c: number, w: number): number {
    const d = Math.abs(x - c) / w;
    if (d >= 1) return 0;
    const u = 1 - d;
    return u * u * (3 - 2 * u);
}

/** A remote shot's eye position must be this close to a defender's (m) to count as theirs. */
const SHOOTER_MATCH = 1.6;
const REMOTE_FLASH_COUNT = 4;
const REMOTE_FLASH_TIME = 0.05;
/** Below this an enemy ghost is not drawn at all (entity disabled: zero cost, truly invisible). */
const VIS_CULL = 0.01;
/** Fixed opacity for ghosts seen by their own teammates. */
const ALLY_GHOST_VIS = 0.45;
const SLASH_TIME = 0.12;
const RECOVER_TIME = 0.2;

/** Phase banners: visible time before the fade, and the fade itself (seconds). */
const BANNER_TIME = 3;
const GO_TIME = 1.5;
const BANNER_FADE = 0.5;
/** Bomb model: blink period (s) is BOMB_BLINK_MIN at zero, rising to BOMB_BLINK_MAX at >= BOMB_BLINK_FROM s left. */
const BOMB_BLINK_MIN = 0.15;
const BOMB_BLINK_MAX = 1.0;
const BOMB_BLINK_FROM = 20;
const BOMB_BLINK_DUTY = 0.35;


const TEAM_LABEL: Record<Team, string> = { ghosts: 'GHOSTS', defenders: 'DEFENDERS' };
const TEAM_PLURAL: Record<Team, string> = { ghosts: 'Ghosts', defenders: 'Defenders' };
const OBJECTIVE: Record<Team, string> = { ghosts: 'Plant the bomb', defenders: 'Defend the sites' };
const PLANTED_SUB: Record<Team, string> = { ghosts: 'Protect the bomb', defenders: 'Find and defuse it' };
const USE_VERB: Record<Team, string> = { ghosts: ' to plant', defenders: ' to defuse' };
const ACT_LABEL: Record<Team, string> = { ghosts: 'PLANTING', defenders: 'DEFUSING' };

function reasonText(reason: RoundReason | null, winner: Team): string {
    switch (reason) {
        case 'eliminated': return `${TEAM_PLURAL[winner === 'ghosts' ? 'defenders' : 'ghosts']} eliminated`;
        case 'time': return 'Time ran out';
        case 'exploded': return 'Bomb detonated';
        case 'defused': return 'Bomb defused';
        default: return '';
    }
}

/** Bomb blink / beep period for `timeLeft` seconds on the clock. */
function blinkPeriod(timeLeft: number): number {
    const u = Math.min(1, Math.max(0, timeLeft / BOMB_BLINK_FROM));
    return BOMB_BLINK_MIN + (BOMB_BLINK_MAX - BOMB_BLINK_MIN) * u * Math.sqrt(u);
}

function clock(secs: number): string {
    const s = secs % 60;
    return `${Math.floor(secs / 60)}:${s < 10 ? '0' : ''}${s}`;
}

// ---------------------------------------------------------------------------------------------
// Materials and primitive helpers

function makeMaterial(r: number, g: number, b: number, unlit: boolean, opacity = 1): pc.StandardMaterial {
    const m = new pc.StandardMaterial();
    if (unlit) {
        m.useLighting = false;
        m.useSkybox = false;
        m.diffuse = new pc.Color(0, 0, 0);
        m.emissive = new pc.Color(r, g, b);
    } else {
        m.diffuse = new pc.Color(r, g, b);
        m.gloss = 0.2;
    }
    if (opacity < 1) {
        m.opacity = opacity;
        m.blendType = pc.BLEND_NORMAL;
        m.depthWrite = false;
    }
    m.update();
    return m;
}

function box(parent: pc.Entity, material: pc.Material, sx: number, sy: number, sz: number,
    x = 0, y = 0, z = 0, layers?: number[]): pc.Entity {
    const e = new pc.Entity();
    e.addComponent('render', {
        type: 'box', material, castShadows: false, receiveShadows: false, ...(layers ? { layers } : {})
    });
    e.setLocalScale(sx, sy, sz);
    e.setLocalPosition(x, y, z);
    parent.addChild(e);
    return e;
}

// ---------------------------------------------------------------------------------------------
// Ghost shimmer shader (GLSL; the engine prepends version, precision and `gl_FragColor` defines).
// No scene-colour sampling: a fresnel/edge rim plus animated value noise fakes a heat-haze outline.

const GHOST_VS = /* glsl */ `
attribute vec3 vertex_position;
attribute vec3 vertex_normal;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform mat3 matrix_normal;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vLocal;
void main(void) {
    vec4 wp = matrix_model * vec4(vertex_position, 1.0);
    vWorldPos = wp.xyz;
    vNormal = matrix_normal * vertex_normal;
    vLocal = vertex_position;
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
varying vec3 vLocal;

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
    fres *= fres;
    // Boxes are flat-faced, so also brighten near their edges (unit box: |local| reaches 0.5).
    vec3 a = abs(vLocal) * 2.0;
    float mx = max(a.x, max(a.y, a.z));
    float mn = min(a.x, min(a.y, a.z));
    float mid = a.x + a.y + a.z - mx - mn;
    float rim = clamp(max(fres, smoothstep(0.8, 1.0, mid) * 0.85), 0.0, 1.0);
    vec3 p = vWorldPos * 5.0 + vec3(0.0, -uTime * 1.7, uTime * 0.6);
    float nz = vnoise(p) * 0.65 + vnoise(p * 2.3 + 7.1) * 0.35;
    float alpha = uVis * mix(0.55, 1.0, rim) * mix(0.75, 1.0, nz);
    // Dim interior and bright rim keep a moving ghost a haze outline; spikes (>= 0.6) flare up.
    float flare = smoothstep(0.4, 0.75, uVis);
    vec3 col = uTint * (0.3 + 0.9 * rim + 0.3 * nz) * (0.85 + 0.75 * flare);
    col = mix(col, uTint * 0.1, smoothstep(0.72, 0.95, fres) * (1.0 - flare));   // dark outer edge (characters.ts)
    gl_FragColor = vec4(gammaCorrectOutput(toneMap(pow(col, vec3(2.2)))), clamp(alpha, 0.0, 1.0));
}
`;

const ENEMY_TINT = new Float32Array([0.78, 0.88, 1.0]);
const ALLY_TINT = new Float32Array([0.66, 0.6, 1.0]);

function makeGhostMaterial(): pc.ShaderMaterial {
    const m = new pc.ShaderMaterial({
        uniqueName: 'sbGhostShimmer',
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
    m.setParameter('uTint', ENEMY_TINT);
    m.update();
    return m;
}

// ---------------------------------------------------------------------------------------------
// HUD (DOM)

const HUD_CSS = `
.sb-ui { position: fixed; pointer-events: none; text-shadow: 0 1px 2px #000; }
#sb-vignette { inset: 0; opacity: 0;
    background: radial-gradient(ellipse at center, rgba(200,0,0,0) 45%, rgba(200,0,0,.85) 100%); }
#sb-stats { left: 18px; bottom: 14px; }
#sb-vitals { display: flex; align-items: flex-end; gap: 22px; }
#sb-health { font: 700 52px/1 system-ui, sans-serif; letter-spacing: .02em; }
#sb-health.low { color: #ff3b3b; }
#sb-armor { display: flex; align-items: center; gap: 7px; font: 700 52px/1 system-ui, sans-serif; letter-spacing: .02em;
    color: #b9d4ff; transition: color .3s, text-shadow .3s, opacity .3s; }
#sb-armor svg { width: 28px; height: 32px; filter: drop-shadow(0 1px 2px #000); }
#sb-armor svg path { fill: currentColor; }
#sb-armor.hit { color: #fff; text-shadow: 0 0 14px #7fb2ff, 0 1px 2px #000; transition: none; }
#sb-armor.empty { opacity: .28; }
#sb-info { opacity: .8; margin-top: 4px; }
#sb-info .ghosts { color: #9d8cff; } #sb-info .defenders { color: #ff9a3c; }
#sb-vis { margin: 0 0 6px; width: 150px; display: none; font: 600 11px/1 system-ui, sans-serif;
    letter-spacing: .14em; }
#sb-vis .row { display: flex; justify-content: space-between; margin-bottom: 3px; opacity: .85; }
#sb-vis .bar { height: 4px; background: rgba(255,255,255,.15); box-shadow: 0 0 2px #000; }
#sb-vis .fill { height: 100%; width: 0; background: #b9d4ff; }
#sb-vis.hidden .state { color: #8fe3a8; }
#sb-vis.exposed .state { color: #ff5a4a; } #sb-vis.exposed .fill { background: #ff5a4a; }
#sb-ammo { right: 22px; bottom: 14px; display: none; text-align: right; white-space: nowrap; }
#sb-ammo .alt { margin-bottom: 7px; font: 600 12px/1.35 system-ui, sans-serif;
    font-variant-numeric: tabular-nums; }
#sb-ammo .alt div { opacity: .45; }
#sb-ammo .alt div.on { opacity: 1; font-weight: 800; color: #fff; }
#sb-ammo .alt div.on::before { content: '▸ '; }
#sb-ammo.melee .mag, #sb-ammo.melee .res, #sb-ammo.melee .rl, #sb-ammo.melee .bar { display: none; }
#sb-ammo .wpn { margin-bottom: 3px; font: 800 12px/1 system-ui, sans-serif; letter-spacing: .3em; opacity: .85; }
#sb-ammo .mag { font: 700 52px/1 system-ui, sans-serif; letter-spacing: .02em; font-variant-numeric: tabular-nums; }
#sb-ammo .res { margin-left: 6px; font: 600 20px/1 system-ui, sans-serif; opacity: .7; font-variant-numeric: tabular-nums; }
#sb-ammo.low .mag { color: #ffb43b; }
#sb-ammo.empty .mag { color: #ff3b3b; }
#sb-ammo.reloading .mag { opacity: .45; }
#sb-ammo .rl { display: none; margin-top: 4px; font: 800 11px/1 system-ui, sans-serif; letter-spacing: .3em; }
#sb-ammo.hint .rl, #sb-ammo.reloading .rl, #sb-ammo.out .rl { display: block; }
#sb-ammo.hint .rl { opacity: .8; } #sb-ammo.out .rl { color: #ff3b3b; }
#sb-ammo .bar { display: none; width: 150px; height: 4px; margin: 5px 0 0 auto; background: rgba(255,255,255,.18);
    box-shadow: 0 0 2px #000; }
#sb-ammo.reloading .bar { display: block; }
#sb-ammo .fill { height: 100%; width: 0; background: #ffd36b; }
#sb-xhair { left: 50%; top: 50%; width: 0; height: 0; display: none; --g: 4px; mix-blend-mode: difference;
    text-shadow: none; }
#sb-xhair i { position: absolute; background: #e8eaed; }
#sb-xhair i:nth-child(1), #sb-xhair i:nth-child(2) { width: 2px; height: 6px; left: -1px; }
#sb-xhair i:nth-child(3), #sb-xhair i:nth-child(4) { width: 6px; height: 2px; top: -1px; }
#sb-xhair i:nth-child(1) { bottom: var(--g); } #sb-xhair i:nth-child(2) { top: var(--g); }
#sb-xhair i:nth-child(3) { right: var(--g); } #sb-xhair i:nth-child(4) { left: var(--g); }
#sb-disc { top: 100px; left: 50%; transform: translateX(-50%); padding: 6px 14px; display: none;
    background: rgba(160,20,20,.85); font: 700 15px/1.2 system-ui, sans-serif; letter-spacing: .15em; }
#sb-hit { left: 50%; top: 50%; width: 0; height: 0; opacity: 0; transform: rotate(45deg); }
#sb-hit i { position: absolute; width: 2px; height: 7px; margin-left: -1px; left: 0; background: #fff; }
#sb-hit i:nth-child(1) { top: -13px; } #sb-hit i:nth-child(2) { top: 6px; }
#sb-hit i:nth-child(3), #sb-hit i:nth-child(4) { width: 7px; height: 2px; margin: -1px 0 0 0; top: 0; }
#sb-hit i:nth-child(3) { left: -13px; } #sb-hit i:nth-child(4) { left: 6px; }
#sb-hit.head i { background: #ff3030; }
#sb-hit.limb i { background: #9cc8ff; height: 5px; }
#sb-hit.limb i:nth-child(3), #sb-hit.limb i:nth-child(4) { width: 5px; height: 2px; }
#sb-hit.kill { transform: rotate(45deg) scale(1.6); }
#sb-feed { top: 10px; right: 12px; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
#sb-feed div { padding: 2px 8px; background: rgba(0,0,0,.45); }
#sb-feed div.me { background: rgba(255,255,255,.18); outline: 1px solid rgba(255,255,255,.5); }
#sb-dead { left: 50%; top: 58%; transform: translateX(-50%); display: none; white-space: nowrap;
    font: 600 26px/1 system-ui, sans-serif; letter-spacing: .08em; }
#sb-match { top: 8px; left: 50%; transform: translateX(-50%); display: flex; align-items: stretch; gap: 2px;
    white-space: nowrap; font: 600 13px/1.2 'Bahnschrift', 'Segoe UI Variable Display', system-ui, sans-serif; }
#sb-match .team { display: flex; flex-direction: column; justify-content: center; gap: 5px; min-width: 150px;
    padding: 6px 14px; background: rgba(9,12,16,.66); border-top: 2px solid currentColor; }
#sb-match .team.ghosts { color: #9d8cff; align-items: flex-end; } #sb-match .team.defenders { color: #ff9a3c; align-items: flex-start; }
#sb-match .team .nm { font-size: 11px; letter-spacing: .12em; opacity: .75; }
#sb-match .team.mine .nm::after { content: ' (you)'; opacity: .8; }
#sb-match .team .sc { font: 700 34px/.9 'Bahnschrift', system-ui, sans-serif; color: #f2f4f1; font-variant-numeric: tabular-nums; }
#sb-match .pips { display: flex; gap: 4px; height: 10px; }
#sb-match .pips i { width: 10px; height: 10px; border-radius: 50%; background: currentColor; display: none; }
#sb-match .pips i.on { display: block; } #sb-match .pips i.dead { display: block; background: none; box-shadow: inset 0 0 0 2px currentColor; opacity: .4; }
#sb-match .mid { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 124px;
    padding: 4px 12px 5px; background: rgba(9,12,16,.78); border-top: 2px solid rgba(255,255,255,.5); }
#sb-match .tag { display: none; color: #ff3b30; font: 800 11px/1 'Bahnschrift', system-ui, sans-serif; letter-spacing: .3em; }
#sb-match.planted .tag { display: block; } #sb-match.planted .mid { border-top-color: #ff3b30; background: rgba(40,6,6,.8); }
#sb-match .timer { font: 700 42px/1 'Bahnschrift', system-ui, sans-serif; letter-spacing: .02em; font-variant-numeric: tabular-nums; }
#sb-match .timer.warm { font: 600 14px/2.6 'Bahnschrift', system-ui, sans-serif; letter-spacing: .14em; opacity: .9; }
#sb-match .timer.bomb { color: #ff3b30; font-size: 48px; }
#sb-match .timer.pulse { animation: sb-pulse .5s ease-in-out infinite alternate; }
@keyframes sb-pulse { from { opacity: 1; transform: scale(1); } to { opacity: .45; transform: scale(1.08); } }
#sb-match .round { font-size: 11px; letter-spacing: .2em; opacity: .65; }
#sb-low { inset: 0; display: none; animation: sb-low 1.1s ease-in-out infinite alternate;
    background: radial-gradient(ellipse at center, rgba(120,0,0,0) 55%, rgba(150,0,0,.55) 100%); }
body.sb-lowhp #sb-low { display: block; }
@keyframes sb-low { from { opacity: .35; } to { opacity: 1; } }
#sb-dmg { left: 50%; top: 50%; width: 0; height: 0; }
#sb-dmg i { position: absolute; left: -46px; top: -150px; width: 92px; height: 300px; opacity: 0; transform-origin: 46px 150px;
    background: radial-gradient(ellipse 40px 12px at 46px 8px, rgba(255,40,30,.95), rgba(255,40,30,0) 100%); }
#sb-recap { left: 50%; top: calc(58% + 36px); transform: translateX(-50%); display: none; white-space: nowrap;
    font: 500 17px/1.2 'Bahnschrift', system-ui, sans-serif; letter-spacing: .04em; opacity: .9; }
#sb-spec { left: 50%; bottom: 70px; transform: translateX(-50%); display: none; text-align: center; white-space: nowrap;
    padding: 8px 18px; background: rgba(9,12,16,.7); border-bottom: 2px solid #8fb4ff; font: 600 18px/1.3 'Bahnschrift', system-ui, sans-serif; }
#sb-spec small { display: block; font-size: 12px; opacity: .65; letter-spacing: .06em; }
#crosshair { width: var(--s, 4px); height: var(--s, 4px); margin: calc(var(--s, 4px) / -2) 0 0 calc(var(--s, 4px) / -2);
    background: var(--c, #e8eaed); mix-blend-mode: normal; box-shadow: 0 0 0 1px rgba(0,0,0,.55); }
#crosshair.x-cross { width: calc(var(--s, 4px) * 4); height: calc(var(--s, 4px) * 4); border-radius: 0; box-shadow: none;
    margin: calc(var(--s, 4px) * -2) 0 0 calc(var(--s, 4px) * -2);
    background: linear-gradient(var(--c), var(--c)) center / 100% 2px no-repeat, linear-gradient(var(--c), var(--c)) center / 2px 100% no-repeat;
    filter: drop-shadow(0 0 1px #000); }
#crosshair.x-ring { width: calc(var(--s, 4px) * 3); height: calc(var(--s, 4px) * 3); background: none;
    margin: calc(var(--s, 4px) * -1.5) 0 0 calc(var(--s, 4px) * -1.5); border: 2px solid var(--c); box-shadow: 0 0 0 1px rgba(0,0,0,.55); box-sizing: border-box; }
#sb-reddot { left: 50%; top: 50%; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px; border-radius: 50%; display: none;
    opacity: 0; background: #ff3324; box-shadow: 0 0 3px 1px rgba(255,51,36,.85), 0 0 9px 3px rgba(255,51,36,.25); text-shadow: none; }
#sb-scope { left: 50%; top: 50%; width: 0; height: 0; display: none; opacity: 0; text-shadow: none; }
#sb-scope i { position: absolute; display: block; }
#sb-scope i.chev { left: 0; top: -1px; width: 10px; height: 10px; transform: rotate(45deg); transform-origin: 0 0;
    border-top: 2px solid #ff7a1f; border-left: 2px solid #ff7a1f; filter: drop-shadow(0 0 2px rgba(255,110,20,.8)); }
#sb-scope i.post { left: -1px; top: 6px; width: 2px; height: 3vmin; background: rgba(10,10,10,.85); }
#sb-scope i.bar { top: calc(6px + 1vmin); height: 1px; width: 2vmin; background: rgba(10,10,10,.8); }
#sb-scope i.bar.l { left: -2vmin; } #sb-scope i.bar.r { left: 0; }
#sb-xhair { mix-blend-mode: normal; } #sb-xhair i { background: var(--c, #e8eaed); box-shadow: 0 0 0 1px rgba(0,0,0,.5); }
#sb-banner { left: 50%; top: 22%; transform: translateX(-50%); text-align: center; display: none; white-space: nowrap; }
#sb-banner div:empty { display: none; }
#sb-banner .t { font: 800 56px/1 system-ui, sans-serif; letter-spacing: .1em; }
#sb-banner .s { font: 600 20px/1.3 system-ui, sans-serif; letter-spacing: .08em; margin-top: 10px; opacity: .92; }
#sb-banner .m { font: 800 18px/1 system-ui, sans-serif; letter-spacing: .35em; margin-top: 18px; color: #ffd36b; }
#sb-banner .b { font: 800 40px/1 system-ui, sans-serif; letter-spacing: .06em; margin-top: 10px;
    font-variant-numeric: tabular-nums; }
#sb-banner.final .b { font-size: 64px; }
#sb-banner.win .t { color: #5dff8f; } #sb-banner.lose .t { color: #ff4a3d; }
#sb-banner.go .t { color: #8fe3a8; font-size: 72px; } #sb-banner.alert .t { color: #ff3b30; }
#sb-use { left: 50%; top: 68%; transform: translateX(-50%); display: none; white-space: nowrap;
    font: 600 17px/1 system-ui, sans-serif; letter-spacing: .05em; }
#sb-use b { display: inline-block; padding: 3px 8px; margin: 0 5px; border: 1px solid rgba(255,255,255,.85);
    border-radius: 3px; background: rgba(0,0,0,.4); font-weight: 800; }
#sb-act { left: 50%; top: 68%; width: 240px; margin-left: -120px; display: none; text-align: center;
    font: 800 12px/1 system-ui, sans-serif; letter-spacing: .3em; }
#sb-act .bar { height: 7px; margin-top: 6px; background: rgba(255,255,255,.18); box-shadow: 0 0 3px #000; }
#sb-act .fill { height: 100%; width: 0; background: #ffd36b; }
#sb-carrier { margin: 0 0 8px; display: none; width: max-content; padding: 4px 9px 4px 7px; background: rgba(255,211,107,.14);
    border-left: 3px solid #ffd36b; color: #ffd36b; font: 700 12px/1 'Bahnschrift', system-ui, sans-serif; letter-spacing: .14em; }
#sb-nobomb { left: 50%; top: 68%; transform: translateX(-50%); display: none; white-space: nowrap;
    font: 600 15px/1 system-ui, sans-serif; letter-spacing: .05em; opacity: .85; }
#sb-bombnote { left: 50%; top: 96px; transform: translateX(-50%); display: none; white-space: nowrap; padding: 5px 14px;
    background: rgba(9,12,16,.6); color: #ffd36b; font: 600 15px/1.2 'Bahnschrift', system-ui, sans-serif; letter-spacing: .05em; }
#sb-match .bombmark { display: none; font: 700 10px/1 'Bahnschrift', system-ui, sans-serif; letter-spacing: .14em; color: #ffd36b; }
#sb-match .bombmark.down { color: #ff5a4a; animation: sb-pulse .6s ease-in-out infinite alternate; }
#sb-scores .row.carrier span:first-child::after { content: '  BOMB'; white-space: pre; color: #ffd36b; font-size: 10px;
    letter-spacing: .16em; font-weight: 700; }
#sb-scores { left: 50%; top: 50%; transform: translate(-50%, -50%); display: none; box-sizing: border-box; z-index: 2;
    width: min(560px, calc(100vw - 32px)); padding: 14px 18px 16px; background: rgba(10,12,16,.84);
    box-shadow: 0 6px 28px rgba(0,0,0,.6); font: 500 15px/1.2 system-ui, sans-serif; text-shadow: none; }
#sb-scores .title { text-align: center; font: 700 11px/1 system-ui, sans-serif; letter-spacing: .3em; opacity: .65; }
#sb-scores .hdr { display: flex; justify-content: space-between; margin-top: 12px; padding: 6px;
    border-bottom: 2px solid currentColor; font: 800 16px/1 system-ui, sans-serif; letter-spacing: .15em; }
#sb-scores .hdr.ghosts { color: #9d8cff; } #sb-scores .hdr.defenders { color: #ff9a3c; }
#sb-scores .hdr.mine span:first-child::after { content: '  (YOU)'; white-space: pre; font-size: 10px; letter-spacing: .2em; opacity: .7; }
#sb-scores .row { display: grid; grid-template-columns: 1fr 40px 40px 40px 52px 74px; column-gap: 2px; align-items: center; padding: 4px 6px; }
#sb-scores .row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#sb-scores .row span + span { text-align: right; font-variant-numeric: tabular-nums; }
#sb-scores .row.cols { opacity: .5; font-size: 10px; letter-spacing: .2em; padding-bottom: 2px; }
#sb-scores .row { position: relative; }
#sb-scores .row button.kick { justify-self: end; margin-left: 4px; pointer-events: auto; font: 700 11px system-ui, sans-serif; padding: 3px 7px; background: rgba(10,12,16,.9); color: #ff9a8f; border: 1px solid rgba(255,90,74,.5); cursor: pointer; }
#sb-scores .row.dead { opacity: .38; }
#sb-scores .row.me { background: rgba(255,255,255,.14); outline: 1px solid rgba(255,255,255,.4); font-weight: 700; }
#sb-scores .empty { padding: 4px 6px; opacity: .4; font-style: italic; }
`;

function div(id: string, parent: HTMLElement = document.body, cls = 'sb-ui'): HTMLDivElement {
    const d = document.createElement('div');
    if (id) d.id = id;
    if (cls) d.className = cls;
    parent.appendChild(d);
    return d;
}

function span(parent: HTMLElement, cls = '', text = ''): HTMLSpanElement {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    if (text) s.textContent = text;
    parent.appendChild(s);
    return s;
}

/** A text node that is only written when its value changes. */
class Slot {
    v: string | null = null;
    el: HTMLElement;
    constructor(el: HTMLElement) { this.el = el; }
    set(s: string): void {
        if (s === this.v) return;
        this.v = s;
        this.el.textContent = s;
    }
}

// ---------------------------------------------------------------------------------------------
// Pooled scene objects

/** How a remote player is drawn. Plain constants (not an enum) to stay erasable-syntax friendly. */
const Look = { None: 0, Defender: 1, EnemyGhost: 2, AllyGhost: 3 } as const;
type Look = typeof Look[keyof typeof Look];

interface Remote {
    id: number;
    team: Team | null;
    look: Look;
    root: pc.Entity;
    body: pc.Entity;
    neck: pc.Entity;
    head: pc.Entity;
    visor: pc.Entity;
    bodyMi: pc.MeshInstance;
    headMi: pc.MeshInstance;
    /** Animated character, once the model has loaded; null while the boxes stand in. */
    char: Character | null;
    /** This player's light uniforms (lighting.ts), set on its character's and weapons' mesh instances. */
    light: Float32Array;
    /** False until `light` has been set from the probes once (it then eases instead of jumping). */
    lightInit: boolean;
    height: number;
    seen: number;
    /** Copy of this frame's view, for matching remote shots to their shooter. */
    x: number;
    y: number;
    z: number;
    crouched: boolean;
    alive: boolean;
    /** Yaw (radians) the body lies along while dead: chosen once at death so it does not fall into a wall. */
    corpseYaw: number;
    /** Drawn this frame, and how strongly (1 for defenders, the shimmer's opacity for an enemy ghost). */
    drawn: boolean;
    vis: number;
}

interface Flash { e: pc.Entity; loud: pc.Entity; t: number; }
interface FeedLine { el: HTMLDivElement; age: number; }

// Knife key poses: position (m, camera space) then Euler angles (degrees).
const KNIFE_REST = [0.16, -0.17, -0.36, 14, 8, -14];
const KNIFE_BACK = [0.2, -0.1, -0.32, 65, -12, -35];
const KNIFE_SLASH = [-0.08, -0.25, -0.48, -15, 45, 35];
/** Defender drawing the knife (draw = 1): offset from rest, eased to zero like the guns' draw. */
const KNIFE_DRAW = [0.02, -0.22, 0.06, -50, 10, 20];
/** The knife rig (camera-space arms) drawing: the whole rig dips and tips down (m, degrees) at draw = 1. */
const KNIFE_RIG_DRAW = [0, -0.2, 0.05, -25];
/** Seconds of windup at the start of the rigs' knife swing clip (viewmodel.py); the rest plays in real time. */
const RIG_KNIFE_WINDUP = 0.2;
/** Viewmodel rig file per gun (tools/blender/viewmodel.py). */
const RIG_FILE: Record<WeaponId, string> = { rifle: 'viewmodel_rifle.glb', pistol: 'viewmodel_pistol.glb' };



export const createPresenter: CreatePresenter = (app, camera, loads) => {
    // Materials (shared; per-instance opacity goes through mesh-instance parameters).
    const defenderMats = { body: makeMaterial(0.95, 0.5, 0.15, false), head: makeMaterial(0.85, 0.32, 0.12, false) };
    const ghostMat = makeGhostMaterial();
    const ghostSkinMat = makeSkinnedGhostMaterial(ENEMY_TINT);
    // Weapons load independently: the viewmodel keeps its boxes and characters stay unarmed until then. Their
    // textured materials (weapons.ts) exist from the start; the atlases load with the first setTier.
    const weaponMats = new WeaponMaterials(app, import.meta.env.BASE_URL, loads ?? null);
    /** A file's track for the loading screen (null without one). */
    const track = (step: 'weapons' | 'characters' | 'hands', url: string, label: string) => loads?.file(step, url, label) ?? null;
    // Lighting from the map's probes (lighting.ts): the first-person weapon's light is the weapon materials' own
    // (`weaponMats.light`), each character's is on its mesh instances. Null until a map's lighting arrives.
    let lighting: MapLighting | null = null;
    const lightScratch = new Float32Array(LIGHT_FLOATS);
    const camLast = new pc.Vec3(0, -1e6, 0);
    // How the first-person weapon moves with the player and kicks (vmfeel.ts).
    const feel = new ViewFeel();
    const feelIn: FeelInput = { vx: 0, vy: 0, vz: 0, onGround: true, crouched: false, yaw: 0, pitch: 0, aim: 0 };
    let feelAlive = false;
    let localShots = 0;
    let vmAim = 0;
    // The animated characters (package O) load with the first setTier, one file per tier (character_low.glb about
    // 6.6k triangles a look, character_high.glb about 13k); until then (and for good if it fails) remote players
    // keep drawing as the box stand-ins below. A later tier change loads the other file and swaps every character.
    let charModel: CharacterModel | null = null;
    let charTier: Tier | null = null;
    const loadCharacters = (t: Tier): void => {
        if (t === charTier) return;
        charTier = t;
        const file = `character_${t}.glb`;
        const url = `${import.meta.env.BASE_URL}models/${file}`;
        loadCharacterModel(app, url, ghostSkinMat, weaponMats.character(), file, track('characters', url, 'models'))
            .then(m => {
                if (charTier !== t) return; // a later tier change won
                const old = charModel;
                charModel = m;
                if (!old) return;
                // Drop every character made from the old file; updateRemotes attaches new ones on its next pass.
                for (const list of [active, free]) {
                    for (const r of list) {
                        if (!r.char) continue;
                        r.char.entity.destroy();
                        r.char = null;
                        r.body.enabled = true;
                        r.neck.enabled = true;
                    }
                }
                app.assets.remove(old.asset);
                old.asset.unload();
            })
            .catch((err: unknown) => {
                console.warn(`[stillblade] ${file} failed to load; drawing box players instead.`, err);
            });
    };
    let weaponModel: WeaponModel | null = null;
    loadWeaponModel(app, `${import.meta.env.BASE_URL}models/weapons.glb`, 'weapons.glb',
        track('weapons', `${import.meta.env.BASE_URL}models/weapons.glb`, 'models'))
        .then(m => {
            weaponModel = m;
            useWeaponModel(m);
        })
        .catch((err: unknown) => {
            console.warn('[stillblade] Weapon model failed to load; keeping the box viewmodels.', err);
        });
    const visorMat = makeMaterial(0.95, 0.95, 0.85, true);
    const gunMat = makeMaterial(0.13, 0.14, 0.16, false);
    const gunAccentMat = makeMaterial(0.28, 0.3, 0.33, false);
    // Opaque: the viewmodel layer only renders its opaque sub-layer (see below).
    const flashMat = makeMaterial(1, 0.9, 0.55, true);
    // The unsuppressed flash: brighter, two-sided, star-shaped (makeFlashMesh), still one opaque draw call.
    const loudFlashMat = makeMaterial(1, 0.82, 0.42, true);
    loudFlashMat.cull = pc.CULLFACE_NONE;
    loudFlashMat.update();
    const loudFlashMesh = makeFlashMesh(app.graphicsDevice);
    /** An entity drawing the star flash, disabled. */
    const loudFlash = (parent: pc.Entity, layers?: number[]): pc.Entity => {
        const e = new pc.Entity('flash-loud');
        e.addComponent('render', {
            meshInstances: [new pc.MeshInstance(loudFlashMesh, loudFlashMat)], castShadows: false, receiveShadows: false,
            ...(layers ? { layers } : {})
        });
        e.enabled = false;
        parent.addChild(e);
        return e;
    };
    /** The room's suppressed-weapons option (setSuppressed); false until told. */
    let suppressedLook = false;
    const bladeMat = makeMaterial(0.78, 0.8, 0.84, false);
    bladeMat.gloss = 0.7;
    bladeMat.metalness = 0.3;
    bladeMat.useMetalness = true;
    bladeMat.update();
    const knifeGuardMat = makeMaterial(0.35, 0.36, 0.38, false);
    const knifeHandleMat = makeMaterial(0.1, 0.09, 0.08, false);
    // The stand-ins' lit materials take the first-person weapon's light (lighting.ts), like the weapon materials.
    for (const m of [defenderMats.body, defenderMats.head, gunMat, gunAccentMat, bladeMat, knifeGuardMat, knifeHandleMat]) {
        useProbeLighting(app.graphicsDevice, m, weaponMats.light);
    }

    const tmpA = new pc.Vec3();
    const tmpB = new pc.Vec3();
    let time = 0;

    // --- Viewmodel layer ---------------------------------------------------------------------
    // Drawn by the same camera after all world layers (opaque + transparent), clearing depth
    // first, so the viewmodel never clips into walls while its own parts still depth-test
    // against each other. Only the opaque sub-layer is added: a transparent one would be a
    // second render step and clear depth again.
    const layers = app.scene.layers;
    const worldLayer = layers.getLayerById(pc.LAYERID_WORLD)!;
    const vmLayer = new pc.Layer({ name: 'Viewmodel', clearDepthBuffer: true });
    layers.insertOpaque(vmLayer, layers.getTransparentIndex(worldLayer) + 1);
    const cam = camera.camera!;
    cam.layers = cam.layers.concat(vmLayer.id);
    // Let existing directional lights light the viewmodel too (lights only affect listed layers).
    for (const c of app.root.findComponents('light') as pc.LightComponent[]) {
        if (c.type === 'directional' && c.layers.indexOf(vmLayer.id) < 0) c.layers = c.layers.concat(vmLayer.id);
    }
    const VM = [vmLayer.id];

    // --- Remote players --------------------------------------------------------------------
    const active: Remote[] = [];
    const free: Remote[] = [];
    let stamp = 0;
    let localTeam: Team | null = null;

    const makeRemote = (): Remote => {
        const root = new pc.Entity('remote');
        const hw = HULL_HALF_WIDTH * 2;
        const body = box(root, defenderMats.body, hw, 1, hw);
        const neck = new pc.Entity('neck');
        root.addChild(neck);
        const head = box(neck, defenderMats.head, HEAD_WIDTH, HEAD_ZONE, HEAD_WIDTH, 0, HEAD_ZONE / 2, 0);
        const visor = box(neck, visorMat, 0.3, 0.07, 0.06, 0, HEAD_ZONE * 0.62, -HEAD_WIDTH / 2 - 0.025);
        app.root.addChild(root);
        return {
            id: -1, team: null, look: Look.None, root, body, neck, head, visor,
            bodyMi: body.render!.meshInstances[0], headMi: head.render!.meshInstances[0],
            char: null, light: defaultLight(new Float32Array(LIGHT_FLOATS)), lightInit: false, height: HULL_HEIGHT, seen: 0, x: 0, y: 0, z: 0, crouched: false, alive: false, corpseYaw: 0,
            drawn: false, vis: 0
        };
    };

    const setLook = (r: Remote, look: Look): void => {
        r.look = look;
        const ghost = look !== Look.Defender;
        r.body.render!.material = ghost ? ghostMat : defenderMats.body;
        r.head.render!.material = ghost ? ghostMat : defenderMats.head;
        // The visor is opaque and would give a ghost away: ghosts have none.
        r.visor.enabled = !ghost;
        if (ghost) {
            const tint = look === Look.AllyGhost ? ALLY_TINT : ENEMY_TINT;
            r.bodyMi.setParameter('uTint', tint);
            r.headMi.setParameter('uTint', tint);
            if (look === Look.AllyGhost) {
                r.bodyMi.setParameter('uVis', ALLY_GHOST_VIS);
                r.headMi.setParameter('uVis', ALLY_GHOST_VIS);
            }
        }
        if (r.char) applyCharLook(r);
    };

    const applyCharLook = (r: Remote): void => {
        const look = r.look === Look.Defender ? CharLook.Defender
            : r.look === Look.AllyGhost ? CharLook.AllyGhost : CharLook.EnemyGhost;
        r.char!.setLook(look, look === CharLook.AllyGhost ? ALLY_TINT : ENEMY_TINT, ALLY_GHOST_VIS);
    };

    /** Swaps a Remote from boxes to the animated character (once the model is loaded). */
    const attachCharacter = (r: Remote, model: CharacterModel): void => {
        r.char = new Character(model, r.root);
        r.body.enabled = false;
        r.neck.enabled = false;
        if (weaponModel) r.char.setWeapons(weaponModel, weaponMats);
        r.char.setSuppressed(suppressedLook);
        r.char.reset();
        if (r.look !== Look.None) applyCharLook(r);
        bindRemoteLight(r);
    };
    /** Points every lit mesh instance of this player (character, guns, knife) at its own light uniforms. */
    const bindRemoteLight = (r: Remote): void => {
        for (const n of r.root.find((g: pc.GraphNode) => g instanceof pc.Entity && !!g.render)) {
            for (const mi of (n as pc.Entity).render!.meshInstances) mi.setParameter('sbLight[0]', r.light);
        }
    };

    const layoutRemote = (r: Remote): void => {
        const bodyH = r.height - HEAD_ZONE;
        r.body.setLocalScale(HULL_HALF_WIDTH * 2, bodyH, HULL_HALF_WIDTH * 2);
        r.body.setLocalPosition(0, bodyH / 2, 0);
        r.neck.setLocalPosition(0, bodyH, 0);
    };

    // --- Bodies clear of walls (corpse.ts) ------------------------------------------------------
    let world: readonly Box[] = [];
    const fallYaw = (pos: Vec3, yaw: number): number => corpseYaw(world, pos, yaw);

    let followId = -1;
    const updateRemotes = (dt: number, remotes: readonly RemoteView[]): void => {
        stamp++;
        const k = 1 - Math.exp(-CROUCH_RATE * dt);
        for (let i = 0; i < remotes.length; i++) {
            const v = remotes[i];
            let r: Remote | null = null;
            for (let j = 0; j < active.length; j++) {
                if (active[j].id === v.id) { r = active[j]; break; }
            }
            const target = v.crouched ? HULL_HEIGHT_CROUCHED : HULL_HEIGHT;
            if (!r) {
                r = free.pop() ?? makeRemote();
                r.id = v.id;
                r.height = target;
                r.char?.reset();
                active.push(r);
            } else {
                r.height += (target - r.height) * k;
            }
            r.seen = stamp;
            r.team = v.team;
            r.x = v.pos[0]; r.y = v.pos[1]; r.z = v.pos[2];
            r.crouched = v.crouched;
            if (r.alive && !v.alive) r.corpseYaw = fallYaw(v.pos, v.yaw);
            else if (v.alive) r.corpseYaw = v.yaw;
            r.alive = v.alive;
            const look = v.team === 'defenders' ? Look.Defender
                : localTeam === 'ghosts' ? Look.AllyGhost : Look.EnemyGhost;
            if (r.look !== look) setLook(r, look);
            if (!r.char && charModel) attachCharacter(r, charModel);
            const ch = r.char;
            // The sight on their rifle: the one their current life uses (roster), iron until told.
            if (ch) ch.setSight(rosterSight.get(v.id) ?? SIGHT_IRON);
            // The character also shows a brief death; boxes simply vanish when dead.
            let visible = ch ? ch.update(dt, v) : v.alive;
            if (look === Look.EnemyGhost) {
                const vis = v.vis > 1 ? 1 : v.vis;
                visible = visible && vis >= VIS_CULL;
                if (visible) {
                    if (ch) ch.setVis(vis);
                    else {
                        r.bodyMi.setParameter('uVis', vis);
                        r.headMi.setParameter('uVis', vis);
                    }
                }
            }
            if (v.id === followId) visible = false; // spectating from inside this player's head
            r.root.enabled = visible;
            r.drawn = visible;
            r.vis = look === Look.EnemyGhost ? Math.min(1, v.vis) : look === Look.AllyGhost ? ALLY_GHOST_VIS : 1;
            if (!visible) continue;
            // High: a soft shadow under the living, as dark as the player is visible (none under a still ghost).
            if (tier === 'high' && v.alive) effects.blobShadow(v.pos[0], v.pos[1], v.pos[2], SHADOW_RADIUS, SHADOW_ALPHA * r.vis);
            r.root.setPosition(v.pos[0], v.pos[1], v.pos[2]);
            r.root.setEulerAngles(0, (v.alive ? v.yaw : r.corpseYaw) * DEG, 0);
            // Lit by where it stands (chest height; low when lying dead), easing as it moves between probes.
            if (lighting && ch && lighting.sample(v.pos[0], v.pos[1] + (v.alive ? (v.crouched ? 0.8 : 1.15) : 0.35), v.pos[2], lightScratch)) {
                blendLight(r.light, lightScratch, r.lightInit ? 1 - Math.exp(-LIGHT_EASE * dt) : 1);
                r.lightInit = true;
            }
            if (ch) continue;
            r.neck.setLocalEulerAngles(v.pitch * DEG, 0, 0);
            layoutRemote(r);
        }
        // Release players absent this frame (compact in place, no allocation).
        let w = 0;
        for (let j = 0; j < active.length; j++) {
            const r = active[j];
            if (r.seen === stamp) active[w++] = r;
            else { r.root.enabled = false; r.id = -1; r.alive = false; r.drawn = false; free.push(r); }
        }
        active.length = w;
    };

    // --- Viewmodels ------------------------------------------------------------------------------
    // All geometry sits at least ~0.2 m in front of the eye, well clear of the 0.05 m near plane.
    // The box versions are the fallback while weapons.glb loads (or if it fails); useWeaponModel swaps in
    // the meshes. `gun` is posed every frame; under it, one child per weapon slot, only the one in hand
    // enabled: 1 draw call + the flash. Knife = 1.
    // Every first-person weapon hangs from this root, scaled for the viewmodel field of view (VM_FOV).
    const vmRoot = new pc.Entity('viewmodel-root');
    camera.addChild(vmRoot);
    /** Scales the viewmodel root so the weapon is drawn as if at VM_FOV, magnified by `zoom` (aiming). */
    const lockVmFov = (zoom: number): void => {
        const k = Math.tan((cam.fov / 2) * Math.PI / 180) / (VM_TAN / zoom);
        vmRoot.setLocalScale(k, k, 1);
    };
    const gun = new pc.Entity('viewmodel-gun');
    vmRoot.addChild(gun);
    interface VmGun {
        root: pc.Entity; boxes: pc.Entity; muzzle: pc.Entity;
        /** Today's small box flash (suppressed) and the star flash (unsuppressed); one is used per room. */
        flash: pc.Entity; loud: pc.Entity;
        /** The pistol box stand-in's suppressor (shown only when suppressed). */
        boxSup: pc.Entity | null;
        model: WeaponInstance | null;
        /** Arms holding this gun (viewmodel_<id>.glb), once loaded: replaces the box and the bare model. */
        rig: VmRig | null;
    }
    /** A slot's viewmodel with its box stand-in; box positions are relative to the grip, like the models. */
    const makeVmGun = (slot: number): VmGun => {
        const root = new pc.Entity(`viewmodel-${WEAPONS[slot].id}`);
        root.enabled = false;
        gun.addChild(root);
        const boxes = new pc.Entity('boxes');
        root.addChild(boxes);
        const muzzle = new pc.Entity('muzzle');
        let boxSup: pc.Entity | null = null;
        if (WEAPONS[slot].id === 'pistol') {
            box(boxes, gunMat, 0.03, 0.032, 0.17, 0, 0.045, -0.06, VM);              // slide
            boxSup = box(boxes, gunAccentMat, 0.026, 0.026, 0.11, 0, 0.05, -0.2, VM); // suppressor
            box(boxes, gunAccentMat, 0.028, 0.075, 0.035, 0, -0.005, 0, VM).setLocalEulerAngles(-15, 0, 0); // grip
            muzzle.setLocalPosition(0, 0.05, -0.26);
        } else {
            // Origin mid-receiver, shifted so the grip sits at the root's origin.
            boxes.setLocalPosition(-0.02, 0.17, 0.04);
            box(boxes, gunMat, 0.05, 0.07, 0.26, 0, 0, 0, VM);                       // receiver
            box(boxes, gunAccentMat, 0.026, 0.026, 0.22, 0, 0.012, -0.24, VM);       // barrel
            box(boxes, gunMat, 0.036, 0.085, 0.05, 0, -0.065, -0.05, VM);            // magazine
            box(boxes, gunAccentMat, 0.04, 0.08, 0.045, 0, -0.06, 0.08, VM).setLocalEulerAngles(-15, 0, 0);
            muzzle.setLocalPosition(0, 0.012, -0.36);
        }
        boxes.addChild(muzzle);
        const fx = SLOT_LOOKS[slot].fx;
        const flash = box(muzzle, flashMat, 0.045 * fx, 0.045 * fx, 0.07 * fx, 0, 0, -0.03 * fx, VM);
        flash.enabled = false;
        const loud = loudFlash(muzzle, VM);
        loud.setLocalScale(LOUD_FLASH_SIZE * fx, LOUD_FLASH_SIZE * fx, LOUD_FLASH_SIZE * 1.6 * fx);
        if (boxSup) boxSup.enabled = suppressedLook;
        return { root, boxes, muzzle, flash, loud, boxSup, model: null, rig: null };
    };
    const vmGuns: VmGun[] = [];
    for (let i = 0; i < WEAPONS.length; i++) vmGuns.push(makeVmGun(i));

    // Knife: origin at the guard, blade along -Z.
    const knife = new pc.Entity('viewmodel-knife');
    vmRoot.addChild(knife);
    const knifeBoxes = new pc.Entity('boxes');
    knife.addChild(knifeBoxes);
    box(knifeBoxes, bladeMat, 0.007, 0.03, 0.16, 0, 0.003, -0.08, VM);          // blade
    box(knifeBoxes, bladeMat, 0.005, 0.016, 0.03, 0, 0.01, -0.172, VM);         // tip (narrower)
    box(knifeBoxes, knifeGuardMat, 0.02, 0.055, 0.012, 0, 0, 0, VM);            // guard
    box(knifeBoxes, knifeHandleMat, 0.022, 0.028, 0.09, 0, -0.002, 0.051, VM);  // handle
    knife.enabled = false;

    /** Per gun slot, per sight (SIGHTS index): the aim point (eye position) in the gun's frame, from weapons.glb. */
    const aimPoints: (pc.Vec3 | null)[][] = WEAPONS.map(() => []);
    /** The aimed pose built from an aim point (position, then no rotation); reused every frame. */
    const aimPose = [0, 0, 0, 0, 0, 0];
    const useWeaponModel = (m: WeaponModel): void => {
        for (let i = 0; i < vmGuns.length; i++) {
            const v = vmGuns[i];
            const mesh = WEAPON_MESH[WEAPONS[i].id];
            aimPoints[i] = m.aims.get(mesh) ?? [];
            const g = instantiateWeapon(m, mesh, weaponMats.of(mesh), VM);
            g.setSuppressed(suppressedLook);
            g.setSight(vmSight);
            v.model = g;
            v.root.addChild(g.entity);
            if (v.rig) { g.entity.enabled = false; continue; } // the arms rig arrived first and carries the gun
            // Tracers and the flash start at the muzzle of the variant in use (the suppressor's end, or the bare barrel).
            v.muzzle.reparent(g.muzzle!);
            v.muzzle.setLocalPosition(0, 0, 0);
            v.muzzle.setLocalEulerAngles(0, 0, 0);
            const fx = SLOT_LOOKS[i].fx;
            v.flash.setLocalScale(0.05 * fx, 0.05 * fx, 0.085 * fx);
            v.flash.setLocalPosition(0, 0, -0.04 * fx);
            v.boxes.enabled = false;
        }
        const k = instantiateWeapon(m, 'knife', weaponMats.of('knife'), VM);
        knife.addChild(k.entity);
        if (knifeRig) k.entity.enabled = false;
        k.entity.setLocalPosition(0, 0, KNIFE_MODEL_BACK);
        knifeBoxes.enabled = false;
        for (let i = 0; i < active.length; i++) { active[i].char?.setWeapons(m, weaponMats); bindRemoteLight(active[i]); }
        for (let i = 0; i < free.length; i++) { free[i].char?.setWeapons(m, weaponMats); bindRemoteLight(free[i]); }
    };

    // Arms rigs (tools/blender/viewmodel.py): one skinned mesh each, the same single draw call as the bare gun, drawn
    // with that gun's weapon material (the arms use a flat swatch of its atlas). They load on their own; until then
    // (or if one fails) the bare model or the boxes stand in.
    /** Muzzle entity (flash, tracer start) onto the rig's muzzle for the current look. */
    const rigMuzzle = (v: VmGun): void => {
        const m = v.rig?.activeMuzzle();
        if (!m) return;
        v.muzzle.reparent(m);
        v.muzzle.setLocalPosition(0, 0, 0);
        v.muzzle.setLocalEulerAngles(0, 0, 0);
    };
    /** Per gun slot, per sight (SIGHTS index): the rig's aimed-arms clip, or null (an older file without one). */
    const aimClips: (VmClip | null)[][] = WEAPONS.map(() => []);
    for (let i = 0; i < vmGuns.length; i++) {
        const id = WEAPONS[i].id, file = RIG_FILE[id];
        const url = `${import.meta.env.BASE_URL}models/${file}`;
        loadViewmodel(app, url, file, VM, weaponMats.of(WEAPON_MESH[id]),
            [`${id}_idle`, `${id}_reload`], track('hands', url, id))
            .then(rig => {
                const v = vmGuns[i];
                v.rig = rig;
                aimClips[i] = SIGHTS.map(sd => rig.clips.get(`${id}_aim_${sd.id}`) ?? null);
                v.root.addChild(rig.root);
                rig.setSuppressed(suppressedLook);
                rig.setSight(vmSight);
                rigMuzzle(v);
                const fx = SLOT_LOOKS[i].fx;
                v.flash.setLocalScale(0.05 * fx, 0.05 * fx, 0.085 * fx);
                v.flash.setLocalPosition(0, 0, -0.04 * fx);
                v.boxes.enabled = false;
                if (v.model) v.model.entity.enabled = false;
            })
            .catch((err: unknown) => console.warn(`[stillblade] ${file} failed to load; the gun is drawn without hands.`, err));
    }
    // The knife rig hangs from the camera directly (its clips carry the whole swing).
    const knifeRigRoot = new pc.Entity('viewmodel-knife-rig');
    vmRoot.addChild(knifeRigRoot);
    knifeRigRoot.enabled = false;
    let knifeRig: VmRig | null = null;
    loadViewmodel(app, `${import.meta.env.BASE_URL}models/viewmodel_knife.glb`, 'viewmodel_knife.glb', VM, weaponMats.of('knife'),
        ['knife_idle', 'knife_swing'], track('hands', `${import.meta.env.BASE_URL}models/viewmodel_knife.glb`, 'knife'))
        .then(rig => {
            knifeRig = rig;
            knifeRigRoot.addChild(rig.root);
            knife.enabled = false;
        })
        .catch((err: unknown) => console.warn('[stillblade] viewmodel_knife.glb failed to load; the knife is drawn without hands.', err));

    /** Suppressors on or off for every gun drawn (first person, every character) and the flash in use. */
    const applySuppressed = (): void => {
        for (const v of vmGuns) {
            if (v.boxSup) v.boxSup.enabled = suppressedLook;
            if (v.rig) {
                v.rig.setSuppressed(suppressedLook);
                rigMuzzle(v);
                v.model?.setSuppressed(suppressedLook);
                v.flash.enabled = v.loud.enabled = false;
                continue;
            }
            if (!v.model) continue;
            v.model.setSuppressed(suppressedLook);
            v.muzzle.reparent(v.model.muzzle!);
            v.muzzle.setLocalPosition(0, 0, 0);
            v.muzzle.setLocalEulerAngles(0, 0, 0);
            v.flash.enabled = v.loud.enabled = false;
        }
        for (let i = 0; i < active.length; i++) active[i].char?.setSuppressed(suppressedLook);
        for (let i = 0; i < free.length; i++) free[i].char?.setSuppressed(suppressedLook);
        for (const f of remoteFlashes) { f.e.enabled = f.loud.enabled = false; f.t = 0; }
    };

    let recoilT = 0;
    let flashT = 0;
    /** Seconds since the last local shot (the rig's fire clip, package R); large when none. */
    let vmFireT = 1e3;
    let localAlive = false;
    /** Seconds since the current knife swing started; < 0 when idle. */
    let swingT = -1;
    let windup = 0.2;
    let vmTeam: Team | null = null;
    /** Weight 0..1 of the gun's reload pose (eased back down when a reload is cancelled). */
    let reloadW = 0;
    /** Slot drawn in first person (-1 before the first defender frame), and the slot whose kick is playing. */
    let vmSlot = -1;
    let kickSlot = 0;
    /** A defender has the knife drawn (slot SLOT_KNIFE): the knife viewmodel instead of a gun. */
    let vmKnifeHeld = false;
    /** The rifle sight drawn in first person (LocalView.sight). */
    let vmSight = SIGHT_IRON;
    const applyVmSight = (): void => {
        for (const v of vmGuns) { v.rig?.setSight(vmSight); v.model?.setSight(vmSight); }
    };

    /** Draw offset weight 0..1 for the defender knife (0 for ghosts and once drawn). */
    let knifeDraw = 0;
    const setKnifePose = (a: number[], b: number[], t: number): void => {
        const u = 1 - t, d = knifeDraw, k = KNIFE_DRAW;
        knife.setLocalPosition(a[0] * u + b[0] * t + k[0] * d, a[1] * u + b[1] * t + k[1] * d, a[2] * u + b[2] * t + k[2] * d);
        knife.setLocalEulerAngles(a[3] * u + b[3] * t + k[3] * d, a[4] * u + b[4] * t + k[4] * d, a[5] * u + b[5] * t + k[5] * d);
    };

    const updateViewmodel = (dt: number, local: LocalView): void => {
        const team = local.team;
        const firstPerson = local.alive && !local.spectating && !local.overview;
        if (team !== vmTeam || firstPerson !== feelAlive) {
            feel.reset(); // a respawn or a team change: no carried-over swing or kick
            feelAlive = firstPerson;
        }
        if (team !== vmTeam) {
            vmTeam = team;
            recoilT = 0;
            flashT = 0;
            swingT = -1;
            reloadW = 0;
        }
        vmAim = local.aim > 0 ? Math.min(1, local.aim) : 0;
        if (firstPerson) {
            feelIn.vx = local.vel[0]; feelIn.vy = local.vel[1]; feelIn.vz = local.vel[2];
            feelIn.onGround = local.onGround;
            feelIn.crouched = local.crouched;
            feelIn.yaw = local.yaw;
            feelIn.pitch = local.pitch;
            feelIn.aim = team === 'defenders' && local.weapon !== SLOT_KNIFE ? vmAim : 0;
            feel.update(dt, feelIn);
            // A brief roll and flick of the view on each shot, gone within about 0.15 s. The camera's recoil offset,
            // which the crosshair follows, is the game core's and unchanged.
            if (feel.cam[0] !== 0 || feel.cam[1] !== 0) camera.rotateLocal(feel.cam[0], 0, feel.cam[1]);
        }
        const defender = team === 'defenders';
        const knifeHeld = defender && local.weapon === SLOT_KNIFE;
        if (knifeHeld !== vmKnifeHeld) {
            vmKnifeHeld = knifeHeld;
            swingT = -1; // a switch cancels a swing in progress (the rule cancels its windup too)
        }
        if (defender && local.sight !== vmSight) { vmSight = local.sight; applyVmSight(); }
        gun.enabled = localAlive && defender && !knifeHeld;
        knife.enabled = localAlive && (!defender || knifeHeld);
        if (defender && !knifeHeld) {
            // The weapon in hand changes the moment a switch starts: the old one simply disappears.
            const slot = slotOf(local.weapon);
            if (slot !== vmSlot) {
                if (vmSlot >= 0) {
                    vmGuns[vmSlot].root.enabled = false;
                    vmGuns[vmSlot].flash.enabled = vmGuns[vmSlot].loud.enabled = false;
                }
                vmSlot = slot;
                vmGuns[slot].root.enabled = true;
                reloadW = 0;
                flashT = 0;
            }
            const look = SLOT_LOOKS[slot];
            const kick = SLOT_LOOKS[kickSlot];
            const fp = feel.pos, fr = feel.rot;
            recoilT = Math.max(0, recoilT - dt);
            flashT = Math.max(0, flashT - dt);
            vmGuns[slot].flash.enabled = flashT > 0 && suppressedLook;
            vmGuns[slot].loud.enabled = flashT > 0 && !suppressedLook;
            const k = recoilT / kick.kickTime;
            // Reload: state-driven from the progress alone. Dip and cant in, hold, come back up; a
            // cancelled reload (progress back to 0) eases home.
            const p = local.reload > 0 ? Math.min(1, local.reload) : 0;
            let target = 0;
            if (p > 0) {
                const x = p < look.reloadIn ? p / look.reloadIn : p > 1 - look.reloadOut ? (1 - p) / look.reloadOut : 1;
                target = x * x * (3 - 2 * x);
            }
            reloadW = target >= reloadW ? target : reloadW + (target - reloadW) * (1 - Math.exp(-RELOAD_RETURN * dt));
            const w = reloadW;
            // Small jolts as the magazine goes in and the bolt or slide closes (zero when not reloading).
            let jolt = 0;
            const rig = vmGuns[slot].rig;
            if (p > 0 && !rig) {
                const j = local.reloadEmpty ? look.joltsEmptyOf : look.joltsOf;
                for (let i = 0; i < j.at.length; i++) jolt += j.size[i] * bump(p, j.at[i], j.w[i]);
            }
            // With arms, the reload clip moves the gun and hands inside the rig: no procedural reload pose on top.
            const rw = rig ? 0 : w;
            // Aim: blend from the hip pose to the sight line; the reload pose takes over from it.
            const a0 = local.aim > 0 ? Math.min(1, local.aim) : 0;
            const a = a0 * a0 * (3 - 2 * a0) * (1 - w);
            // Switch progress (1 at its start, 0 drawn). A rig with a draw clip plays it instead of the procedural rise.
            const d0 = local.draw > 0 ? Math.min(1, local.draw) : 0;
            vmFireT += dt;
            let drawByClip = false;
            if (rig) {
                // Clip selection (package R): reload (empty or tactical) by its progress, else the draw by its
                // progress, else the shot just fired, else the idle hold.
                let clip: VmClip | undefined;
                let ct = 0;
                if (p > 0) {
                    clip = (local.reloadEmpty ? rig.clips.get(RELOAD_EMPTY_CLIP[slot]) : undefined) ?? rig.clips.get(RELOAD_CLIP[slot]);
                    ct = clip ? p * clip.duration : 0;
                } else if (d0 > 0 && (clip = rig.clips.get(DRAW_CLIP[slot])) !== undefined) {
                    ct = (1 - d0) * clip.duration;
                    drawByClip = true;
                } else if ((clip = rig.clips.get(FIRE_CLIP[slot])) !== undefined && vmFireT < clip.duration) {
                    ct = vmFireT;
                } else clip = rig.clips.get(IDLE_CLIP[slot]);
                rig.pose(clip, ct);
                // The aimed arms (shoulders kept in place relative to the eye) over the hold, by the aim.
                if (p <= 0 && a > 0) rig.blend(aimClips[slot][WEAPONS[slot].takesSights ? vmSight : SIGHT_IRON] ?? undefined, 0, a);
            }
            const ha = 1 - a;
            // The weapon's own magnification follows the aim (part of it for the 2x scope).
            const zoom = adsZoomOf(slot, vmSight);
            lockVmFov(1 + (zoom - 1) * a * (WEAPONS[slot].takesSights && sightDef(vmSight).id === 'scope2x' ? VM_SCOPE_ZOOM_SHARE : 1));
            const hip = look.hip, rl = look.reload, dr = look.draw;
            // Aimed: the sight's aim point (weapons.glb) on the camera; before the model loads, the old fixed pose.
            const sightIdx = WEAPONS[slot].takesSights ? vmSight : SIGHT_IRON;
            const ap = aimPoints[slot][sightIdx] ?? null;
            let aim = look.aim, sightDrop = 0;
            if (ap) {
                aimPose[0] = -ap.x; aimPose[1] = -ap.y; aimPose[2] = -ap.z;
                aim = aimPose;
            } else if (WEAPONS[slot].takesSights) {
                sightDrop = SIGHT_EYE_FALLBACK[sightDef(vmSight).id];
            }
            // Switch: rises from below, rotated, easing into place as draw falls from 1 to 0 (unless a draw clip does it).
            const d = drawByClip ? 0 : d0 * d0;
            // Subtle time-based sway (the presenter has no player speed); damped while firing and aiming.
            const s = (1 - 0.7 * k) * (1 - (1 - AIM_SWAY) * a);
            const sx = Math.sin(time * SWAY_RATE) * SWAY_POS * s;
            const sy = Math.sin(time * SWAY_RATE * 2) * SWAY_POS * 0.6 * s;
            // On top: the movement and recoil feel (bob, look inertia, jump and landing, crouch tilt, kick springs).
            gun.setLocalPosition(
                hip[0] * ha + aim[0] * a + sx + rl[0] * rw + dr[0] * d + fp[0],
                hip[1] * ha + (aim[1] - sightDrop) * a + sy + rl[1] * rw + 0.012 * jolt + dr[1] * d + fp[1],
                hip[2] * ha + aim[2] * a + rl[2] * rw + dr[2] * d + fp[2]);
            gun.setLocalEulerAngles(
                hip[3] * ha + aim[3] * a + sy * 120 + rl[3] * rw + 5 * jolt + dr[3] * d + fr[0],
                hip[4] * ha + aim[4] * a + Math.sin(time * SWAY_RATE * 0.7) * SWAY_ROT * s + rl[4] * rw + dr[4] * d + fr[1],
                hip[5] * ha + aim[5] * a + sx * 160 + rl[5] * rw + dr[5] * d + fr[2]);
            knifeRigRoot.enabled = false;
            return;
        }
        lockVmFov(1);
        // A defender drawing the knife: it rises from below, like the guns.
        const kd0 = knifeHeld && local.draw > 0 ? Math.min(1, local.draw) : 0;
        knifeDraw = kd0 * kd0;
        if (knifeRig) {
            // Arms rig: the clip carries the swing; its windup is stretched to the rule's, the rest plays in real time.
            knife.enabled = false;
            knifeRigRoot.enabled = localAlive && (!defender || knifeHeld);
            knifeRig.setVariant(defender ? 'vm_knife' : 'vm_ghost');
            const kd = knifeDraw, rd = KNIFE_RIG_DRAW;
            const fp = feel.pos, fr = feel.rot;
            knifeRigRoot.setLocalPosition(rd[0] * kd + Math.sin(time * SWAY_RATE) * SWAY_POS + fp[0],
                rd[1] * kd + Math.sin(time * SWAY_RATE * 2) * SWAY_POS * 0.6 + fp[1], rd[2] * kd + fp[2]);
            knifeRigRoot.setLocalEulerAngles(rd[3] * kd + fr[0], fr[1], fr[2]);
            const swing = knifeRig.clips.get('knife_swing')!;
            let ct = -1;
            if (swingT >= 0) {
                swingT += dt;
                ct = swingT < windup ? (swingT / windup) * RIG_KNIFE_WINDUP : RIG_KNIFE_WINDUP + (swingT - windup);
                if (ct >= swing.duration) { swingT = -1; ct = -1; }
            }
            if (ct >= 0) knifeRig.pose(swing, ct);
            else knifeRig.pose(knifeRig.clips.get('knife_idle'), 0);
            return;
        }
        if (swingT < 0) {
            setKnifePose(KNIFE_REST, KNIFE_REST, 0);
            // Same idle sway as the gun, only while not swinging.
            knife.translateLocal(Math.sin(time * SWAY_RATE) * SWAY_POS, Math.sin(time * SWAY_RATE * 2) * SWAY_POS * 0.6, 0);
            return;
        }
        swingT += dt;
        let t = swingT;
        if (t < windup) {
            const x = t / windup;
            setKnifePose(KNIFE_REST, KNIFE_BACK, 1 - (1 - x) * (1 - x));         // ease out
        } else if ((t -= windup) < SLASH_TIME) {
            const x = t / SLASH_TIME;
            setKnifePose(KNIFE_BACK, KNIFE_SLASH, x * x);                         // ease in: fast
        } else if ((t -= SLASH_TIME) < RECOVER_TIME) {
            const x = t / RECOVER_TIME;
            setKnifePose(KNIFE_SLASH, KNIFE_REST, x * x * (3 - 2 * x));
        } else {
            swingT = -1;
            setKnifePose(KNIFE_REST, KNIFE_REST, 0);
        }
    };

    // --- Effects: tracers, impacts, dust, decals, glows, shadows (client/src/effects.ts) ----------
    const effects = new Effects(app);
    let tier: Tier = 'low';
    /** High tier: one realtime light for players and the first-person weapon, following the strongest effect light. */
    const fxLight = new pc.Entity('fx-light');
    fxLight.addComponent('light', {
        type: 'omni', color: new pc.Color(1, 0.7, 0.35), intensity: 0, range: FLASH_LIGHT_RADIUS,
        castShadows: false, layers: [pc.LAYERID_WORLD, vmLayer.id]
    });
    fxLight.enabled = false;
    app.root.addChild(fxLight);
    const fxColor = new pc.Color();
    /** The world shader's dynamic lights (High): position + radius, and colour x intensity, written each frame. */
    const dynPos = new Float32Array(DYN_LIGHTS * 4);
    const dynCol = new Float32Array(DYN_LIGHTS * 3);
    const dynPosId = app.graphicsDevice.scope.resolve(DYN_POS_UNIFORM);
    const dynColId = app.graphicsDevice.scope.resolve(DYN_COL_UNIFORM);
    let dynCount = 0;
    /** Adds a light for this frame (High); the first ones added win when there are more than DYN_LIGHTS. */
    const dynLight = (x: number, y: number, z: number, radius: number, c: readonly number[], k: number): void => {
        if (dynCount >= DYN_LIGHTS || k <= 0) return;
        const o = dynCount * 4, q = dynCount * 3;
        dynPos[o] = x; dynPos[o + 1] = y; dynPos[o + 2] = z; dynPos[o + 3] = radius;
        dynCol[q] = c[0] * k; dynCol[q + 1] = c[1] * k; dynCol[q + 2] = c[2] * k;
        if (dynCount === 0) {
            // The players' and weapon's light follows the first (most important) one.
            const l = fxLight.light!;
            fxLight.setPosition(x, y, z);
            l.range = radius;
            const peak = Math.max(c[0], c[1], c[2]);
            l.intensity = Math.min(4, peak * k * 0.7);
            fxColor.set(c[0] / peak, c[1] / peak, c[2] / peak);
            l.color = fxColor;
        }
        dynCount++;
    };
    /** Explosion flash time left (s) and where. */
    let boomT = 0;
    let boomX = 0, boomY = 0, boomZ = 0;
    const faceHit = { axis: 1, sign: 1, surface: 'concrete' as Surface };

    // Muzzle flashes of remote defenders: world-space effects like the tracers (not part of a character).
    const remoteFlashes: Flash[] = [];
    for (let i = 0; i < REMOTE_FLASH_COUNT; i++) {
        const e = box(app.root, flashMat, 0.06, 0.06, 0.1);
        e.enabled = false;
        remoteFlashes.push({ e, loud: loudFlash(app.root), t: 0 });
    }
    let nextFlash = 0;

    /** The living defender whose eye is nearest `from` (within SHOOTER_MATCH), or null. */
    const findShooter = (from: Vec3): Remote | null => {
        let best: Remote | null = null;
        let bestD = SHOOTER_MATCH * SHOOTER_MATCH;
        for (let i = 0; i < active.length; i++) {
            const r = active[i];
            if (r.team !== 'defenders' || !r.alive) continue;
            const dx = r.x - from[0];
            const dy = r.y + (r.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT) - from[1];
            const dz = r.z - from[2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) { bestD = d; best = r; }
        }
        return best;
    };

    /** A player drawn right now whose body contains (or nearly contains) the point, or null. */
    const drawnNear = (x: number, y: number, z: number): Remote | null => {
        for (let i = 0; i < active.length; i++) {
            const r = active[i];
            if (!r.drawn) continue;
            const dx = x - r.x, dz = z - r.z;
            if (dx * dx + dz * dz < 0.6 * 0.6 && y > r.y - 0.1 && y < r.y + r.height + 0.2) return r;
        }
        return null;
    };

    const updateEffects = (dt: number): void => {
        for (let i = 0; i < REMOTE_FLASH_COUNT; i++) {
            const f = remoteFlashes[i];
            if (f.t <= 0) continue;
            f.t -= dt;
            if (f.t <= 0) f.e.enabled = f.loud.enabled = false;
        }
        // Dynamic lights for this frame (High): the explosion, our own muzzle, the bomb, other players' muzzles.
        dynCount = 0;
        if (tier === 'high') {
            if (boomT > 0) dynLight(boomX, boomY + 1.2, boomZ, BOOM_LIGHT_RADIUS, BOOM_LIGHT, boomT / BOOM_TIME);
            if (flashT > 0 && vmSlot >= 0 && gun.enabled) {
                const mp = vmGuns[vmSlot].muzzle.getPosition();
                dynLight(mp.x, mp.y, mp.z, FLASH_LIGHT_RADIUS * (suppressedLook ? 0.6 : 1), FLASH_LIGHT, suppressedLook ? 0.5 : 1);
            }
            if (bomb.enabled && bombLit) dynLight(bombX, bombY + 0.25, bombZ, BOMB_LIGHT_RADIUS, BOMB_LIGHT, 1);
            for (let i = 0; i < REMOTE_FLASH_COUNT; i++) {
                const f = remoteFlashes[i];
                if (f.t <= 0) continue;
                const mp = (f.e.enabled ? f.e : f.loud).getPosition();
                dynLight(mp.x, mp.y, mp.z, FLASH_LIGHT_RADIUS * (suppressedLook ? 0.6 : 1), FLASH_LIGHT, suppressedLook ? 0.5 : 1);
            }
            for (let i = dynCount; i < DYN_LIGHTS; i++) { dynCol[i * 3] = dynCol[i * 3 + 1] = dynCol[i * 3 + 2] = 0; dynPos[i * 4 + 3] = 1; }
            dynPosId.setValue(dynPos);
            dynColId.setValue(dynCol);
            if (dynCount === 0) fxLight.light!.intensity = 0;
        }
        if (boomT > 0) boomT = Math.max(0, boomT - dt);
        effects.update(dt, camera);
    };

    // --- Bomb ------------------------------------------------------------------------------------
    // Built once; origin on the floor. World layer, so both teams see it.
    const bombCaseMat = makeMaterial(0.07, 0.075, 0.08, false);
    const bombStrapMat = makeMaterial(0.32, 0.27, 0.12, false);
    const bombLightOn = makeMaterial(1, 0.08, 0.04, true);
    const bombLightOff = makeMaterial(0.22, 0.03, 0.02, true);
    const bomb = new pc.Entity('bomb');
    box(bomb, bombCaseMat, 0.35, 0.12, 0.22, 0, 0.06, 0);
    box(bomb, bombStrapMat, 0.04, 0.125, 0.225, -0.1, 0.06, 0);
    box(bomb, bombStrapMat, 0.04, 0.125, 0.225, 0.1, 0.06, 0);
    box(bomb, bombCaseMat, 0.12, 0.02, 0.08, 0.02, 0.13, 0.03);              // keypad block
    const bombLight = box(bomb, bombLightOff, 0.045, 0.03, 0.045, -0.04, 0.135, -0.05);
    bomb.enabled = false;
    app.root.addChild(bomb);
    let bombLit = false;
    let blinkPhase = 0;
    let bombX = NaN, bombY = NaN, bombZ = NaN;

    // A dropped bomb uses the same model, unlit (only the planted bomb blinks).
    const updateBomb = (dt: number, match: MatchView): void => {
        const p = match.bombPos ?? match.droppedBomb;
        if (!p) {
            if (bomb.enabled) bomb.enabled = false;
            return;
        }
        if (!bomb.enabled) { bomb.enabled = true; blinkPhase = 0; }
        if (p[0] !== bombX || p[1] !== bombY || p[2] !== bombZ) {
            bombX = p[0]; bombY = p[1]; bombZ = p[2];
            bomb.setPosition(bombX, bombY, bombZ);
        }
        let lit = false;
        if (match.phase === 'planted') {
            blinkPhase = (blinkPhase + dt / blinkPeriod(match.timeLeft)) % 1;
            lit = blinkPhase < BOMB_BLINK_DUTY;
        }
        if (lit !== bombLit) {
            bombLit = lit;
            bombLight.render!.material = lit ? bombLightOn : bombLightOff;
        }
        // Both tiers: a small red glow on the blinking light, so a planted bomb reads in a dark corner.
        if (lit) effects.glow(bombX - 0.04, bombY + 0.16, bombZ - 0.05, tier === 'high' ? 0.22 : 0.16, 1, 0.12, 0.06, 0.9);
    };
    /** The round ended with the bomb going off (`over`, reason `exploded`): once per round. */
    let boomRound = -1;
    const updateExplosion = (match: MatchView): void => {
        if (match.phase !== 'over' || match.reason !== 'exploded' || !match.bombPos || boomRound === match.round) return;
        boomRound = match.round;
        boomX = match.bombPos[0]; boomY = match.bombPos[1]; boomZ = match.bombPos[2];
        boomT = BOOM_TIME;
        effects.explosion(boomX, boomY, boomZ);
    };

    // --- HUD -------------------------------------------------------------------------------------
    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
    const crosshair = document.getElementById('crosshair');
    // Rifle sight overlays (package M): DOM over the canvas, so no draw call. Made first: the rest of the HUD sits above.
    const scopeEl = div('sb-scope');
    // An ACOG-style chevron with a drop post and two stadia bars; the scope's housing around it is the model.
    for (const c of ['post', 'bar l', 'bar r', 'chev']) scopeEl.appendChild(document.createElement('i')).className = c;
    const redDotEl = div('sb-reddot');
    const OVERLAY_OPACITY: string[] = [];
    for (let i = 0; i <= 20; i++) OVERLAY_OPACITY.push((i / 20).toFixed(2));
    let shownOverlay = '', shownOverlayOp = -1, shownXhairHidden = false;
    const vignette = div('sb-vignette');
    const stats = div('sb-stats');
    // "You have the bomb", above the visibility meter (ghost carriers only).
    const carrierEl = div('sb-carrier', stats, '');
    carrierEl.textContent = 'YOU HAVE THE BOMB';
    let shownCarrier = false;
    const visEl = div('sb-vis', stats, '');
    const visRow = div('', visEl, 'row');
    div('', visRow, '').textContent = 'VISIBILITY';
    const visStateEl = div('', visRow, 'state');
    const visFill = div('', div('', visEl, 'bar'), 'fill');
    // Health, then armor beside it in the same type with a small shield (package P).
    const vitalsEl = div('sb-vitals', stats, '');
    const healthEl = div('sb-health', vitalsEl, '');
    const armorEl = div('sb-armor', vitalsEl, '');
    armorEl.title = 'Armor';
    armorEl.innerHTML = '<svg viewBox="0 0 24 28" aria-hidden="true"><path d="M12 1 2 5v8c0 6.6 4.3 11.9 10 14 5.7-2.1 10-7.4 10-14V5L12 1z"/></svg>';
    const armorNum = armorEl.appendChild(document.createElement('span'));
    let shownArmor = -1;
    /** Seconds left of the armor's flash after it dropped. */
    let armorFlashT = 0;
    const infoEl = div('sb-info', stats, '');
    const teamEl = infoEl.appendChild(document.createElement('span'));
    const idEl = infoEl.appendChild(document.createElement('span'));
    const pingEl = infoEl.appendChild(document.createElement('span'));
    pingEl.className = 'ping';
    // Ammo counter (bottom right, defenders only): the other slots small and dim ("2 Pistol 12/36"), the
    // weapon in hand's name, its magazine big and reserve small, then a state line.
    const ammoEl = div('sb-ammo');
    const altEl = div('', ammoEl, 'alt');
    const altRows: HTMLDivElement[] = [];
    const altMag: number[] = [];
    const altRes: number[] = [];
    // Every slot, the one in hand highlighted ("1 Rifle 30/90", "2 Pistol 12/36", "3 Knife").
    for (let i = 0; i < SLOT_COUNT; i++) {
        const row = div('', altEl, '');
        if (i === SLOT_KNIFE) row.textContent = `${i + 1} ${slotLabel(i)}`;
        altRows.push(row);
        altMag.push(-1);
        altRes.push(-1);
    }
    const wpnSlot = new Slot(div('', ammoEl, 'wpn'));
    const WPN_LABEL: string[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) WPN_LABEL.push(`${i + 1} ${slotLabel(i).toUpperCase()}`);
    const magEl = span(ammoEl, 'mag');
    const resEl = span(ammoEl, 'res');
    const reloadLabel = new Slot(div('', ammoEl, 'rl'));
    const reloadFill = div('', div('', ammoEl, 'bar'), 'fill');
    // Spread ticks around the crosshair dot (defenders only).
    const xhairEl = div('sb-xhair');
    for (let i = 0; i < 4; i++) xhairEl.appendChild(document.createElement('i'));
    /** CSS px per unit of tan(angle) at the screen centre; recomputed on resize and when the FOV changes (aiming). */
    let pxPerTan = 0;
    let viewH = 0;
    let measuredFov = 0;
    const measureXhair = (): void => {
        viewH = app.graphicsDevice.canvas.clientHeight || window.innerHeight;
        measuredFov = 0;
    };
    const XHAIR_OPACITY: string[] = [];
    for (let i = 0; i <= 20; i++) XHAIR_OPACITY.push((1 - (1 - XHAIR_AIM_OPACITY) * (i / 20)).toFixed(2));
    window.addEventListener('resize', measureXhair);
    const discEl = div('sb-disc');
    discEl.textContent = 'DISCONNECTED';
    const hitEl = div('sb-hit');
    for (let i = 0; i < 4; i++) hitEl.appendChild(document.createElement('i'));
    const feedEl = div('sb-feed');
    const deadEl = div('sb-dead');
    const recapEl = div('sb-recap');
    const specEl = div('sb-spec');
    const specName = new Slot(span(specEl));
    const specHint = document.createElement('small');
    specEl.appendChild(specHint);
    const lowEl = div('sb-low');
    const dmgEl = div('sb-dmg');
    interface DmgMarker { el: HTMLElement; bearing: number; t: number }
    const dmgMarkers: DmgMarker[] = [];
    for (let i = 0; i < DMG_MARKERS; i++) dmgMarkers.push({ el: dmgEl.appendChild(document.createElement('i')), bearing: 0, t: 0 });
    let nextDmg = 0;
    let shownRecap = false, shownSpec = '', lastYaw = 0;
    void lowEl;
    const feed: FeedLine[] = [];

    // Match bar (top centre): ghosts | timer | defenders, each side with its score and living players.
    const matchEl = div('sb-match');
    const makeTeam = (team: Team): { box: HTMLElement; score: HTMLElement; pips: HTMLElement[] } => {
        const box = div('', matchEl, `team ${team}`);
        div('', box, 'nm').textContent = TEAM_LABEL[team];
        const score = div('', box, 'sc');
        const pipsEl = div('', box, 'pips');
        const pips: HTMLElement[] = [];
        for (let i = 0; i < MAX_PIPS; i++) pips.push(pipsEl.appendChild(document.createElement('i')));
        return { box, score, pips };
    };
    const tG = makeTeam('ghosts');
    // Under the ghosts' pips, for ghosts only: who has the bomb, or that it is lying on the floor.
    const bombMarkEl = div('', tG.box, 'bombmark');
    const bombMark = new Slot(bombMarkEl);
    let shownBombMark = '';
    const mid = div('', matchEl, 'mid');
    matchEl.insertBefore(mid, tG.box.nextSibling);
    div('', mid, 'tag').textContent = 'BOMB PLANTED';
    const timerEl = div('', mid, 'timer');
    const timerSlot = new Slot(timerEl);
    const roundSlot = new Slot(div('', mid, 'round'));
    const tD = makeTeam('defenders');
    const scoreG = tG.score, scoreD = tD.score;

    // Phase banner (centre upper).
    const bannerEl = div('sb-banner');
    const bannerT = new Slot(div('', bannerEl, 't'));
    const bannerS = new Slot(div('', bannerEl, 's'));
    const bannerM = new Slot(div('', bannerEl, 'm'));
    const bannerB = new Slot(div('', bannerEl, 'b'));

    // Use prompt and plant/defuse progress (lower centre).
    const useEl = div('sb-use');
    useEl.appendChild(document.createTextNode('Hold'));
    const useKey = new Slot(useEl.appendChild(document.createElement('b')));
    const useVerb = new Slot(span(useEl));
    const actEl = div('sb-act');
    const actLabel = new Slot(div('', actEl, ''));
    const actFill = div('', div('', actEl, 'bar'), 'fill');
    // A ghost without the bomb standing in a site.
    const noBombEl = div('sb-nobomb');
    noBombEl.textContent = 'Only the bomb carrier can plant';
    let shownNoBomb = false;
    // Short bomb notices for ghosts (who has it, dropped, picked up).
    const bombNoteEl = div('sb-bombnote');
    const bombNote = new Slot(bombNoteEl);
    let bombNoteLeft = 0;

    // Scoreboard.
    const scoresEl = div('sb-scores');

    // Roster, copied (the caller may reuse its array).
    const roster: RosterEntry[] = [];
    const names = new Map<number, string>();
    /** Each player's active rifle sight (RosterEntry.sight), for drawing it on their gun. */
    const rosterSight = new Map<number, number>();
    let rosterVersion = 0;
    const playerName = (id: number): string => names.get(id) ?? `Player ${id}`;

    let shownName = '';
    let shownScoreG = -1;
    let shownScoreD = -1;
    let shownMine: Team | null = null;
    let shownRound = -1;
    let shownTimerKey = NaN;
    let shownTimerMode = -1;
    let shownPlanted: boolean | null = null;
    /** Living and total players per team, from the roster; `pipsKey` changes whenever they do. */
    const aliveCount: Record<Team, number> = { ghosts: 0, defenders: 0 };
    const totalCount: Record<Team, number> = { ghosts: 0, defenders: 0 };
    let pipsKey = 0, shownPipsKey = -1;
    let prevPhase: Phase | null = null;
    /** Seconds left before the banner starts fading; Infinity while held for the whole phase. */
    let bannerLeft = 0;
    let bannerKey = NaN;
    let shownBannerOpacity = '';
    let shownBannerCls = '';
    let shownUse = false;
    let shownAct = false;
    let shownActPct = -1;
    let shownScores = false;
    let scoresRosterV = -1, scoresLocalId = -1, scoresTeam: Team | null = null;
    let scoresG = -1, scoresD = -1, scoresRound = -1, scoresCarrier = -1, scoresWin = -1;
    let voteKick: ((playerId: number) => void) | null = null;
    const pingOf = new Map<number, number>();
    let shownDeadKey = NaN;
    let shownDeadEl = false;

    let vignetteLevel = 0;
    let hitT = 0;
    let hitDur = 0.12;
    let localId = -1;
    let shownHealth = -1;
    let shownTeam: Team | null = null;
    let shownId = -1;
    let shownPing = -1;
    let shownConnected: boolean | null = null;
    let shownAlive: boolean | null = null;
    let shownVisPct = -1;
    let shownVisState = -1;
    let shownArmed = false;
    let shownMag = -1;
    let shownReserve = -1;
    /** Ammo state key: (0 normal, 1 low, 2 empty) + 3 * (0 nothing, 1 reloading, 2 reload hint, 3 out of ammo). */
    let shownAmmoKey = -1;
    let shownReloadPct = -1;
    let shownGap = -1;
    let shownFov = 0;
    let shownSlot = -1;
    let shownXhairOp = -1;
    let shownTicks = false;
    measureXhair();

    const updateHud = (dt: number, local: LocalView, phase: Phase): void => {
        const hp = Math.max(0, Math.round(local.health));
        if (hp !== shownHealth) {
            shownHealth = hp;
            healthEl.textContent = String(hp);
            healthEl.classList.toggle('low', hp < 35);
        }
        const ap = Math.max(0, Math.round(local.armor));
        if (ap !== shownArmor) {
            // A drop flashes it briefly; a refill at the spawn does not.
            if (shownArmor >= 0 && ap < shownArmor && local.alive) {
                armorFlashT = 0.18;
                armorEl.classList.add('hit');
            }
            shownArmor = ap;
            armorNum.textContent = String(ap);
            armorEl.classList.toggle('empty', ap === 0); // dimmed when the armor is gone
        }
        if (armorFlashT > 0) {
            armorFlashT -= dt;
            if (armorFlashT <= 0) armorEl.classList.remove('hit'); // fades back over the 0.3 s transition
        }
        const lowHp = local.alive && hp < 35;
        if (document.body.classList.contains('sb-lowhp') !== lowHp) document.body.classList.toggle('sb-lowhp', lowHp);
        const ping = Math.round(local.ping);
        if (local.team !== shownTeam || local.id !== shownId) {
            shownTeam = local.team;
            shownId = local.id;
            teamEl.className = local.team;
            teamEl.textContent = local.team.toUpperCase();
            visEl.style.display = local.team === 'ghosts' ? 'block' : 'none';
        }
        const name = playerName(local.id);
        if (name !== shownName) { shownName = name; idEl.textContent = ` · ${name} · `; }
        if (local.team === 'ghosts') {
            const vis = Math.min(1, Math.max(0, local.vis));
            // Square root so a running ghost (0.35) already fills ~60% of the bar.
            const pct = Math.round(Math.sqrt(vis) * 100);
            if (pct !== shownVisPct) { shownVisPct = pct; visFill.style.width = `${pct}%`; }
            const state = vis < 0.02 ? 0 : vis >= 0.5 ? 2 : 1;
            if (state !== shownVisState) {
                shownVisState = state;
                visStateEl.textContent = state === 0 ? 'HIDDEN' : state === 2 ? 'EXPOSED' : 'SEEN';
                visEl.className = state === 0 ? 'hidden' : state === 2 ? 'exposed' : '';
            }
        }
        if (ping !== shownPing) { shownPing = ping; pingEl.textContent = `${ping} ms`; }
        if (local.connected !== shownConnected) {
            shownConnected = local.connected;
            discEl.style.display = local.connected ? 'none' : 'block';
        }
        // The death message would sit under the scoreboard: hide it while that is open.
        const deadShown = !local.alive && !local.showScores;
        if (deadShown !== shownDeadEl) { shownDeadEl = deadShown; deadEl.style.display = deadShown ? 'block' : 'none'; }
        if (local.alive !== shownAlive) {
            shownAlive = local.alive;
            if (crosshair) crosshair.style.visibility = local.alive && !shownXhairHidden ? '' : 'hidden';
            shownDeadKey = NaN;
            if (local.alive && shownRecap) { shownRecap = false; recapEl.style.display = 'none'; }
        }
        if (local.alive !== true) {
            const spec = local.spectating ?? (local.overview ? '\u0000overview' : '');
            if (spec !== shownSpec) {
                shownSpec = spec;
                specEl.style.display = spec ? 'block' : 'none';
                if (local.spectating) { specName.set(`Spectating ${local.spectating}`); specHint.textContent = 'Left and right arrows switch teammate'; }
                else if (spec) { specName.set('No teammate left to follow'); specHint.textContent = 'Map overview'; }
            }
        } else if (shownSpec) { shownSpec = ''; specEl.style.display = 'none'; }
        lastYaw = local.yaw;
        if (!local.alive) {
            // Respawns only exist in warmup; in a round the dead wait for the next one.
            const key = phase === 'warmup' ? Math.max(0, Math.ceil(local.respawnIn)) : -1;
            if (key !== shownDeadKey) {
                shownDeadKey = key;
                deadEl.textContent = key < 0 ? 'You are dead — waiting for next round' : `Respawning in ${key}`;
            }
        }
        if (vignetteLevel > 0) {
            vignetteLevel = Math.max(0, vignetteLevel - dt / 0.4);
            vignette.style.opacity = vignetteLevel.toFixed(3);
        }
        for (let i = 0; i < DMG_MARKERS; i++) {
            const m = dmgMarkers[i];
            if (m.t <= 0) continue;
            m.t -= dt;
            if (m.t <= 0) { m.el.style.opacity = '0'; continue; }
            m.el.style.opacity = Math.min(1, m.t / (DMG_LIFE * 0.6)).toFixed(2);
            m.el.style.transform = `rotate(${(-(m.bearing - lastYaw) * DEG).toFixed(1)}deg)`;
        }
        if (hitT > 0) {
            hitT = Math.max(0, hitT - dt);
            hitEl.style.opacity = hitT > 0 ? Math.min(1, (hitT / hitDur) * 2).toFixed(2) : '0';
        }
        for (let i = feed.length - 1; i >= 0; i--) {
            const line = feed[i];
            line.age += dt;
            if (line.age >= KILLFEED_LIFE + KILLFEED_FADE) {
                line.el.remove();
                feed.splice(i, 1);
            } else if (line.age > KILLFEED_LIFE) {
                line.el.style.opacity = (1 - (line.age - KILLFEED_LIFE) / KILLFEED_FADE).toFixed(2);
            }
        }
    };

    const AMMO_CLS = ['', 'low', 'empty'];
    const AMMO_STATE_CLS = ['', ' reloading', ' hint', ' out'];
    const AMMO_LABEL = ['', 'RELOADING', 'R  RELOAD', 'NO AMMO'];

    const updateAmmo = (local: LocalView): void => {
        if (cam.fov !== shownFov) { shownFov = cam.fov; measureXhair(); }
        const armed = local.alive && local.team === 'defenders';
        const melee = local.weapon === SLOT_KNIFE;
        if (armed !== shownArmed) {
            shownArmed = armed;
            ammoEl.style.display = armed ? 'block' : 'none';
        }
        // Spread ticks only for a gun: the knife has no spread.
        const ticks = armed && !melee;
        if (ticks !== shownTicks) { shownTicks = ticks; xhairEl.style.display = ticks ? 'block' : 'none'; }
        if (!armed) return;
        const slot = melee ? SLOT_KNIFE : slotOf(local.weapon);
        if (slot !== shownSlot) {
            shownSlot = slot;
            wpnSlot.set(WPN_LABEL[slot]);
            for (let i = 0; i < altRows.length; i++) altRows[i].className = i === slot ? 'on' : '';
        }
        for (let i = 0; i < WEAPONS.length; i++) {
            const w = local.weapons[i];
            if (!w || (w.mag === altMag[i] && w.reserve === altRes[i])) continue;
            altMag[i] = w.mag;
            altRes[i] = w.reserve;
            altRows[i].textContent = `${i + 1} ${WEAPONS[i].label} ${w.mag}/${w.reserve}`;
        }
        if (melee) {
            // No magazine, reserve, reload line or bar: just the name.
            if (shownAmmoKey !== -2) { shownAmmoKey = -2; ammoEl.className = 'sb-ui melee'; }
            return;
        }
        const mag = local.mag, reserve = local.reserve;
        if (mag !== shownMag) { shownMag = mag; magEl.textContent = String(mag); }
        if (reserve !== shownReserve) { shownReserve = reserve; resEl.textContent = `/ ${reserve}`; }
        const reloading = local.reload > 0;
        const level = mag <= 0 ? 2 : mag <= local.magSize / 4 ? 1 : 0;
        const state = reloading ? 1 : level > 0 && reserve > 0 ? 2 : mag <= 0 ? 3 : 0;
        const key = level + 3 * state + 16 * bindings().version;
        if (key !== shownAmmoKey) {
            shownAmmoKey = key;
            ammoEl.className = `sb-ui ${AMMO_CLS[level]}${AMMO_STATE_CLS[state]}`;
            reloadLabel.set(state === 2 ? `${bindings().hint('reload')}  RELOAD` : AMMO_LABEL[state]);
            shownReloadPct = -1;
        }
        if (reloading) {
            const pct = Math.round(Math.min(1, local.reload) * 100);
            if (pct !== shownReloadPct) { shownReloadPct = pct; reloadFill.style.width = `${pct}%`; }
        }
        // Spread ticks: the cone's half-angle projected to CSS pixels, outside the 4 px dot. Aiming narrows
        // the FOV, so re-project when it changes; the ticks also fade while aimed.
        if (cam.fov !== measuredFov) {
            measuredFov = cam.fov;
            pxPerTan = (viewH / 2) / Math.tan((measuredFov / 2) * Math.PI / 180);
            shownGap = -1;
        }
        const op = Math.round(Math.min(1, Math.max(0, local.aim)) * 20);
        if (op !== shownXhairOp) { shownXhairOp = op; xhairEl.style.opacity = XHAIR_OPACITY[op]; }
        updateSightOverlay(local);
        const gap = 3 + Math.round(Math.tan(Math.max(0, local.spread)) * pxPerTan);
        if (gap !== shownGap) { shownGap = gap; xhairEl.style.setProperty('--g', `${gap}px`); }
    };

    /**
     * The mounted rifle sight's overlay while aiming the rifle, fading in with aim progress: the 2x scope's chevron,
     * and the red dot's DOM reticle only while the gun has none of its own (the models' red dot carries a glowing
     * reticle on its glass, weapons.py). The hip crosshair and spread ticks hide once the sight is half in.
     */
    const updateSightOverlay = (local: LocalView): void => {
        const rifle = local.alive && local.team === 'defenders' && isGunSlot(local.weapon) && WEAPONS[local.weapon].takesSights;
        const kind = rifle && local.sight !== SIGHT_IRON ? sightDef(local.sight).id : '';
        const from = kind === 'scope2x' ? SCOPE_RETICLE_FROM : SIGHT_OVERLAY_FROM;
        const f = kind ? (Math.min(1, Math.max(0, local.aim)) - from) / (1 - from) : 0;
        const op = f > 0 ? Math.round(f * 20) : 0;
        const meshDot = kind === 'reddot' && !!(vmGuns[slotOf(local.weapon)].rig || vmGuns[slotOf(local.weapon)].model);
        const show = op > 0 && !meshDot ? kind : '';
        if (show !== shownOverlay) {
            shownOverlay = show;
            redDotEl.style.display = show === 'reddot' ? 'block' : 'none';
            scopeEl.style.display = show === 'scope2x' ? 'block' : 'none';
            shownOverlayOp = -1;
        }
        if (show && op !== shownOverlayOp) {
            shownOverlayOp = op;
            (show === 'reddot' ? redDotEl : scopeEl).style.opacity = OVERLAY_OPACITY[op];
        }
        const hide = op >= 10 || (kind !== '' && local.aim >= 0.75);
        if (hide !== shownXhairHidden) {
            shownXhairHidden = hide;
            if (crosshair) crosshair.style.visibility = local.alive && !hide ? '' : 'hidden';
            xhairEl.style.visibility = hide ? 'hidden' : '';
        }
    };

    const updateMatchBar = (local: LocalView, match: MatchView): void => {
        const warm = match.phase === 'warmup';
        const planted = match.phase === 'planted';
        const mode = warm ? 0 : planted ? (match.timeLeft <= 10 ? 3 : 2) : 1;
        if (mode !== shownTimerMode) {
            shownTimerMode = mode;
            timerEl.className = mode === 0 ? 'timer warm' : mode === 1 ? 'timer' : mode === 2 ? 'timer bomb' : 'timer bomb pulse';
        }
        const secs = warm ? -1 : Math.max(0, Math.ceil(match.timeLeft));
        if (secs !== shownTimerKey) {
            shownTimerKey = secs;
            timerSlot.set(warm ? 'WARMUP' : clock(secs));
        }
        if (planted !== shownPlanted) { shownPlanted = planted; matchEl.classList.toggle('planted', planted); }
        if (match.scoreGhosts !== shownScoreG) { shownScoreG = match.scoreGhosts; scoreG.textContent = String(shownScoreG); }
        if (match.scoreDefenders !== shownScoreD) { shownScoreD = match.scoreDefenders; scoreD.textContent = String(shownScoreD); }
        if (local.team !== shownMine) {
            shownMine = local.team;
            tG.box.className = local.team === 'ghosts' ? 'team ghosts mine' : 'team ghosts';
            tD.box.className = local.team === 'defenders' ? 'team defenders mine' : 'team defenders';
        }
        if (pipsKey !== shownPipsKey) {
            shownPipsKey = pipsKey;
            for (let i = 0; i < MAX_PIPS; i++) {
                tG.pips[i].className = i < aliveCount.ghosts ? 'on' : i < totalCount.ghosts ? 'dead' : '';
                tD.pips[i].className = i < aliveCount.defenders ? 'on' : i < totalCount.defenders ? 'dead' : '';
            }
        }
        if (match.round !== shownRound) { shownRound = match.round; roundSlot.set(`ROUND ${shownRound}`); }
        // The bomb's state, for ghosts (a defender's carrierId is always 0 and it only knows a dropped bomb in sight).
        const ghost = local.team === 'ghosts';
        const live = match.phase === 'freeze' || match.phase === 'live';
        const mark = !ghost || !live ? '' : match.droppedBomb ? '\u0001' : match.carrierId > 0 ? playerName(match.carrierId) : '';
        if (mark !== shownBombMark) {
            shownBombMark = mark;
            bombMarkEl.style.display = mark ? 'block' : 'none';
            bombMarkEl.className = mark === '\u0001' ? 'bombmark down' : 'bombmark';
            if (mark) bombMark.set(mark === '\u0001' ? 'BOMB DROPPED' : `BOMB · ${mark.toUpperCase()}`);
        }
    };

    const showBanner = (cls: string, seconds: number): void => {
        bannerLeft = seconds + BANNER_FADE;
        bannerKey = NaN;
        if (cls !== shownBannerCls) { shownBannerCls = cls; bannerEl.className = `sb-ui ${cls}`; }
        bannerEl.style.display = 'block';
        shownBannerOpacity = '';
    };

    const hideBanner = (): void => {
        bannerLeft = 0;
        bannerEl.style.display = 'none';
    };

    const updateBanner = (dt: number, local: LocalView, match: MatchView): void => {
        const phase = match.phase;
        if (phase !== prevPhase) {
            const from = prevPhase;
            prevPhase = phase;
            if (phase === 'freeze') {
                showBanner('', Infinity);                       // held for the whole freeze, with a countdown
            } else if (phase === 'live' && from === 'freeze') {
                showBanner('go', GO_TIME);
                bannerT.set('GO'); bannerS.set(''); bannerM.set(''); bannerB.set('');
            } else if (phase === 'planted') {
                showBanner('alert', BANNER_TIME);
                bannerT.set('BOMB PLANTED'); bannerS.set(PLANTED_SUB[local.team]); bannerM.set(''); bannerB.set('');
            } else if (phase === 'over') {
                showBanner('', BANNER_TIME);
                bannerT.set('ROUND OVER'); bannerS.set(''); bannerM.set(''); bannerB.set('');
            } else {
                hideBanner();
            }
        }
        if (bannerLeft <= 0) return;

        if (phase === 'freeze') {
            const n = Math.max(0, Math.ceil(match.timeLeft));
            const key = match.round * 1000 + n * 2 + (local.team === 'ghosts' ? 1 : 0);
            if (key !== bannerKey) {
                bannerKey = key;
                bannerT.set(`ROUND ${match.round}`);
                bannerS.set(OBJECTIVE[local.team]);
                bannerM.set('');
                bannerB.set(n > 0 ? String(n) : '');
            }
        } else if (phase === 'over' && match.winner) {
            const R = match.reason === 'eliminated' ? 1 : match.reason === 'time' ? 2
                : match.reason === 'exploded' ? 3 : match.reason === 'defused' ? 4 : 0;
            const key = (match.winner === 'ghosts' ? 1 : 0) + (local.team === 'ghosts' ? 2 : 0) +
                (match.matchOver ? 4 : 0) + R * 8 + match.scoreGhosts * 64 + match.scoreDefenders * 4096;
            if (key !== bannerKey) {
                bannerKey = key;
                const cls = (match.winner === local.team ? 'win' : 'lose') + (match.matchOver ? ' final' : '');
                if (cls !== shownBannerCls) { shownBannerCls = cls; bannerEl.className = `sb-ui ${cls}`; }
                bannerT.set(`${TEAM_LABEL[match.winner]} WIN`);
                bannerS.set(reasonText(match.reason, match.winner));
                bannerM.set(match.matchOver ? 'MATCH OVER' : '');
                bannerB.set(match.matchOver ? `${match.scoreGhosts} — ${match.scoreDefenders}` : '');
                // The match result stays up for the whole post-match pause.
                if (match.matchOver) bannerLeft = Infinity;
            }
        }

        if (bannerLeft !== Infinity) bannerLeft -= dt;
        if (bannerLeft <= 0) { hideBanner(); return; }
        const op = bannerLeft >= BANNER_FADE ? '1' : (bannerLeft / BANNER_FADE).toFixed(2);
        if (op !== shownBannerOpacity) { shownBannerOpacity = op; bannerEl.style.opacity = op; }
    };

    const updateUse = (dt: number, local: LocalView): void => {
        const carrier = local.alive && local.carrier;
        if (carrier !== shownCarrier) { shownCarrier = carrier; carrierEl.style.display = carrier ? 'block' : 'none'; }
        const noBomb = local.alive && local.siteNoBomb;
        if (noBomb !== shownNoBomb) { shownNoBomb = noBomb; noBombEl.style.display = noBomb ? 'block' : 'none'; }
        if (bombNoteLeft > 0) {
            bombNoteLeft -= dt;
            if (bombNoteLeft <= 0) bombNoteEl.style.display = 'none';
            else if (bombNoteLeft < 0.5) bombNoteEl.style.opacity = (bombNoteLeft / 0.5).toFixed(2);
        }
        const acting = local.alive && local.action > 0;
        const prompt = local.alive && local.canAct && !acting;
        if (prompt !== shownUse) { shownUse = prompt; useEl.style.display = prompt ? 'block' : 'none'; }
        if (prompt) { useVerb.set(USE_VERB[local.team]); useKey.set(bindings().hint('use')); }
        if (acting !== shownAct) { shownAct = acting; actEl.style.display = acting ? 'block' : 'none'; }
        if (acting) {
            actLabel.set(ACT_LABEL[local.team]);
            const pct = Math.round(Math.min(1, local.action) * 100);
            if (pct !== shownActPct) { shownActPct = pct; actFill.style.width = `${pct}%`; }
        }
    };

    const renderScores = (local: LocalView, match: MatchView): void => {
        scoresEl.replaceChildren();
        div('', scoresEl, 'title').textContent = `ROUND ${match.round} · FIRST TO ${match.roundsToWin}`;
        const teams: Team[] = local.team === 'ghosts' ? ['ghosts', 'defenders'] : ['defenders', 'ghosts'];
        for (const team of teams) {
            const hdr = div('', scoresEl, team === local.team ? `hdr ${team} mine` : `hdr ${team}`);
            span(hdr, '', TEAM_LABEL[team]);
            span(hdr, '', String(team === 'ghosts' ? match.scoreGhosts : match.scoreDefenders));
            const cols = div('', scoresEl, 'row cols');
            span(cols, '', 'NAME'); span(cols, '', 'K'); span(cols, '', 'D'); span(cols, '', 'A'); span(cols, '', 'PING'); span(cols, '', '');
            const members = roster.filter(p => p.team === team)
                .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
            if (members.length === 0) div('', scoresEl, 'empty').textContent = 'No players';
            for (const p of members) {
                const carrier = p.id === match.carrierId && team === 'ghosts';
                const row = div('', scoresEl, `row${p.alive ? '' : ' dead'}${p.id === local.id ? ' me' : ''}${carrier ? ' carrier' : ''}`);
                span(row, '', p.name || `Player ${p.id}`);
                span(row, '', String(p.kills));
                span(row, '', String(p.deaths));
                span(row, '', String(p.assists));
                span(row, 'ping', p.bot ? 'BOT' : pingOf.has(p.id) ? String(pingOf.get(p.id)) : '-');
                if (!voteKick || p.bot || p.id === local.id) span(row, '', '');
                else {
                    const id = p.id, kick = voteKick;
                    const b = document.createElement('button');
                    b.type = 'button'; b.className = 'kick'; b.textContent = 'Vote out'; b.title = 'Start a vote to remove this player from the room';
                    b.addEventListener('click', () => kick(id));
                    row.appendChild(b);
                }
            }
        }
    };

    const updateScores = (local: LocalView, match: MatchView): void => {
        if (local.showScores !== shownScores) {
            shownScores = local.showScores;
            scoresEl.style.display = shownScores ? 'block' : 'none';
        }
        if (!shownScores) return;
        if (rosterVersion === scoresRosterV && local.id === scoresLocalId && local.team === scoresTeam &&
            match.scoreGhosts === scoresG && match.scoreDefenders === scoresD && match.round === scoresRound &&
            match.carrierId === scoresCarrier && match.roundsToWin === scoresWin) return;
        scoresRosterV = rosterVersion; scoresLocalId = local.id; scoresTeam = local.team;
        scoresG = match.scoreGhosts; scoresD = match.scoreDefenders; scoresRound = match.round; scoresCarrier = match.carrierId; scoresWin = match.roundsToWin;
        renderScores(local, match);
    };

    return {
        frame(dt: number, local: LocalView, remotes: readonly RemoteView[], match: MatchView): void {
            localAlive = local.alive;
            localId = local.id;
            localTeam = local.team;
            time = (time + dt) % 1000;
            ghostMat.setParameter('uTime', time);
            ghostSkinMat.setParameter('uTime', time);
            followId = local.spectateId;
            // The first-person weapon's light: the probes at the eye, eased as the player moves (taken at once after the
            // camera jumps: a respawn, a spectator switch).
            if (lighting) {
                const cp = camera.getPosition();
                const snap = cp.distance(camLast) > LIGHT_SNAP;
                camLast.copy(cp);
                if (lighting.sample(cp.x, cp.y, cp.z, lightScratch)) {
                    blendLight(weaponMats.light, lightScratch, snap ? 1 : 1 - Math.exp(-LIGHT_EASE * dt));
                }
            }
            updateRemotes(dt, remotes);
            updateViewmodel(dt, local);
            updateBomb(dt, match);
            updateExplosion(match);
            updateHud(dt, local, match.phase);
            updateAmmo(local);
            updateMatchBar(local, match);
            updateBanner(dt, local, match);
            updateUse(dt, local);
            updateScores(local, match);
            // Last: effects queued by the updates above (shadows, glows) are drawn this frame.
            updateEffects(dt);
        },

        setPings(pings: readonly [number, number][]): void {
            pingOf.clear();
            for (let i = 0; i < pings.length; i++) pingOf.set(pings[i][0], pings[i][1]);
            rosterVersion++; // redraw the scoreboard if it is open
        },

        setVoteKick(kick: ((playerId: number) => void) | null): void {
            voteKick = kick;
            rosterVersion++; // redraw the scoreboard rows
        },

        roster(players: readonly RosterEntry[]): void {
            roster.length = 0;
            names.clear();
            rosterSight.clear();
            for (let i = 0; i < players.length; i++) {
                const p = players[i];
                roster.push({ ...p });
                if (p.name) names.set(p.id, p.name);
                rosterSight.set(p.id, p.sight ?? SIGHT_IRON);
            }
            rosterVersion++;
            aliveCount.ghosts = aliveCount.defenders = totalCount.ghosts = totalCount.defenders = 0;
            for (const p of roster) {
                if (p.idle && !p.alive) continue; // spectate-only players are not in the round
                totalCount[p.team]++;
                if (p.alive) aliveCount[p.team]++;
            }
            pipsKey = aliveCount.ghosts + 16 * aliveCount.defenders + 256 * totalCount.ghosts + 4096 * totalCount.defenders;
        },

        shot(from: Vec3, to: Vec3, isLocal: boolean, weapon: number): void {
            const slot = slotOf(weapon);
            const fx = SLOT_LOOKS[slot].fx;
            if (isLocal && localAlive && vmTeam === 'defenders' && vmSlot >= 0) {
                // The kick is the firing weapon's; the flash and tracer come from the gun in hand (the same
                // one, except a shot predicted on the very frame of a switch).
                kickSlot = slot;
                recoilT = SLOT_LOOKS[slot].kickTime;
                feel.shoot(SLOT_LOOKS[slot].recoil, ++localShots, vmAim);
                vmFireT = 0;
                flashT = suppressedLook ? FLASH_TIME : LOUD_FLASH_TIME;
                const v = vmGuns[vmSlot];
                (suppressedLook ? v.flash : v.loud).setLocalEulerAngles(0, 0, Math.random() * 90);
                tmpA.copy(v.muzzle.getPosition());
            } else {
                tmpA.set(from[0], from[1], from[2]);
                // Remote shot: recoil and a flash on the shooter's gun, and the tracer from its muzzle.
                const ch = isLocal ? null : findShooter(from)?.char;
                if (ch && ch.shoot()) {
                    const mp = ch.muzzle();
                    const rot = ch.gunRotation();
                    if (mp && rot) {
                        tmpA.copy(mp);
                        const f = remoteFlashes[nextFlash];
                        nextFlash = (nextFlash + 1) % REMOTE_FLASH_COUNT;
                        const e = suppressedLook ? f.e : f.loud;
                        (suppressedLook ? f.loud : f.e).enabled = false;
                        e.setRotation(rot);
                        e.setPosition(mp);
                        if (suppressedLook) {
                            e.setLocalScale(0.06 * fx, 0.06 * fx, 0.1 * fx);
                            e.translateLocal(0, 0, -0.04 * fx);
                        } else {
                            // Bigger than first person: it is seen from metres away.
                            e.setLocalScale(LOUD_FLASH_SIZE * 1.3 * fx, LOUD_FLASH_SIZE * 1.3 * fx, LOUD_FLASH_SIZE * 2 * fx);
                        }
                        e.rotateLocal(0, 0, Math.random() * 90);
                        e.enabled = true;
                        f.t = suppressedLook ? REMOTE_FLASH_TIME : LOUD_FLASH_TIME;
                    }
                }
            }
            tmpB.set(to[0], to[1], to[2]);
            const dx = tmpB.x - tmpA.x, dy = tmpB.y - tmpA.y, dz = tmpB.z - tmpA.z;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const il = len > 1e-4 ? 1 / len : 0;
            // Where it ended: a map face (dust or sparks by surface, and a hole), else a player we are drawing (a
            // puff), else nothing (the end of the range). Only what this event already told us is shown.
            if (faceAt(world, to, faceHit)) {
                effects.impact(to[0], to[1], to[2], faceHit.axis, faceHit.sign, faceHit.surface, dx * il, dy * il, dz * il);
            } else {
                const r = drawnNear(to[0], to[1], to[2]);
                if (r) effects.bodyHit(to[0], to[1], to[2], dx * il, dy * il, dz * il, r.team === 'ghosts');
            }
            if (isLocal && localAlive && vmSlot >= 0) {
                const mp = vmGuns[vmSlot].muzzle.getPosition();
                effects.muzzleSmoke(mp.x, mp.y, mp.z, dx * il, dy * il, dz * il);
            }
            if (len < 0.05) return;
            effects.tracer(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z, TRACER_THICKNESS * fx, TRACER_LIFE);
        },

        setSuppressed(on: boolean): void {
            if (on === suppressedLook) return;
            suppressedLook = on;
            applySuppressed();
        },

        knifeSwing(windupSeconds: number): void {
            windup = Math.max(0.01, windupSeconds);
            swingT = 0;
        },

        remoteSwing(id: number): void {
            for (let i = 0; i < active.length; i++) {
                const r = active[i];
                if (r.id === id) { r.char?.swing(); return; }
            }
        },

        remoteSlash(id: number): void {
            for (let i = 0; i < active.length; i++) {
                const r = active[i];
                if (r.id === id) { r.char?.slash(); return; }
            }
        },

        setWorld(boxes: readonly Box[]): void {
            world = boxes;
        },

        hitConfirm(zone: HitZone | null, killed: boolean): void {
            hitDur = killed ? 0.25 : 0.12;
            hitT = hitDur;
            hitEl.classList.toggle('head', zone === 'head');
            hitEl.classList.toggle('limb', zone === 'arms' || zone === 'legs');
            hitEl.classList.toggle('kill', killed);
            hitEl.style.opacity = '1';
        },

        damaged(amount: number, bearing: number): void {
            vignetteLevel = Math.min(0.9, vignetteLevel + 0.25 + amount / 100);
            vignette.style.opacity = vignetteLevel.toFixed(3);
            if (Number.isNaN(bearing)) return;
            const m = dmgMarkers[nextDmg];
            nextDmg = (nextDmg + 1) % DMG_MARKERS;
            m.bearing = bearing;
            m.t = DMG_LIFE;
            m.el.style.opacity = '1';
            m.el.style.transform = `rotate(${(-(bearing - lastYaw) * DEG).toFixed(1)}deg)`;
        },

        died(killerName: string, kind: KillKind, zone: HitZone | null, distance: number, weapon?: string): void {
            const gun = weapon ? `the ${weapon.toLowerCase()}` : 'a gun';
            const how = kind === 'shot' ? `${gun}${zone ? ZONE_RECAP[zone] : ''}` : kind === 'backstab' ? 'a backstab' : 'the knife';
            recapEl.textContent = `${killerName} killed you with ${how} from ${distance.toFixed(0)} m`;
            recapEl.style.display = 'block';
            shownRecap = true;
        },

        setCrosshair(c: CrosshairConfig): void {
            if (!crosshair) return;
            crosshair.className = c.style === 'dot' ? '' : `x-${c.style}`;
            crosshair.style.setProperty('--c', c.color);
            crosshair.style.setProperty('--s', `${c.size}px`);
            xhairEl.style.setProperty('--c', c.color);
        },

        bombNotice(text: string): void {
            bombNote.set(text);
            bombNoteLeft = 3.5;
            bombNoteEl.style.opacity = '1';
            bombNoteEl.style.display = 'block';
        },

        killFeed(killerId: number, victimId: number, kind: KillKind, zone: HitZone | null, weapon?: string): void {
            const reuse = feed.length >= KILLFEED_MAX ? feed.pop()! : null;
            const el = reuse ? reuse.el : document.createElement('div');
            el.textContent = `${playerName(killerId)}${weapon ? ` [${weapon}]` : ''} ▸ ${playerName(victimId)}${killSuffix(kind, zone)}`;
            el.className = killerId === localId || victimId === localId ? 'me' : '';
            el.style.opacity = '';
            feedEl.insertBefore(el, feedEl.firstChild);
            feed.unshift({ el, age: 0 });
        },

        setTier(t: Tier): void {
            tier = t;
            effects.setTier(t);
            weaponMats.setTier(t);
            loadCharacters(t);
            fxLight.enabled = t === 'high';
            if (t !== 'high') boomT = Math.min(boomT, BOOM_TIME);
        },

        setMapLook(tuning: LookTuning): void {
            effects.setFog(tuning);
            effects.reset(world);
        },

        setLighting(l: MapLighting | null): void {
            lighting = l;
            weaponMats.setEnvironment(l ? { atlas: l.envAtlas, sphere: l.sphere } : null);
            camLast.set(0, -1e6, 0); // the next sample is taken at once
            for (const list of [active, free]) {
                for (const r of list) { r.lightInit = false; if (!l) defaultLight(r.light); }
            }
            if (!l) defaultLight(weaponMats.light);
        },

        footstep(id: number, pos: Vec3, loud: number): void {
            for (let i = 0; i < active.length; i++) {
                const r = active[i];
                if (r.id !== id) continue;
                // Only under a player drawn right now, and no fainter-than-the-shimmer ghost gets more than its shimmer.
                if (r.drawn && r.alive) effects.footstep(pos[0], pos[1], pos[2], Math.min(1, loud), r.vis);
                return;
            }
        },

        knifeHit(victimId: number): void {
            for (let i = 0; i < active.length; i++) {
                const r = active[i];
                if (r.id !== victimId) continue;
                if (r.drawn) effects.knifeHit(r.x, r.y, r.z, r.team === 'ghosts');
                return;
            }
        }
    };
};
