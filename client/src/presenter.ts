import * as pc from 'playcanvas';
import {
    EYE_HEIGHT, EYE_HEIGHT_CROUCHED, HEAD_ZONE, HULL_HALF_WIDTH, HULL_HEIGHT, HULL_HEIGHT_CROUCHED
} from '@shared/constants';
import type { RosterEntry, Team } from '@shared/protocol';
import { ROUNDS_TO_WIN, type Phase, type RoundReason } from '@shared/rules';
import type { Vec3 } from '@shared/types';
import type { CreatePresenter, KillKind, LocalView, MatchView, RemoteView } from './presenter-api';
import { Character, CharLook, loadCharacterModel, makeSkinnedGhostMaterial, type CharacterModel } from './characters';
import { instantiateWeapon, loadWeaponModel, makeWeaponMaterial, type WeaponModel } from './weapons';

const DEG = 180 / Math.PI;
const HEAD_WIDTH = 0.4;
const CROUCH_RATE = 14;
const TRACER_COUNT = 16;
const TRACER_LIFE = 0.09;
const TRACER_THICKNESS = 0.02;
const IMPACT_COUNT = 32;
const IMPACT_LIFE = 4;
const RECOIL_TIME = 0.08;
const FLASH_TIME = 0.04;
const KILLFEED_MAX = 5;
const KILLFEED_LIFE = 5;
const KILLFEED_FADE = 0.5;
/** Box stand-in gun (origin mid-receiver), used until weapons.glb has loaded or if it fails. */
const GUN_POS = new pc.Vec3(0.15, -0.15, -0.46);
/**
 * Model gun (origin at the pistol grip, see weapons.ts): grip position in camera space, and a small
 * inward yaw / roll so it reads as held, the suppressor angling toward the crosshair.
 */
const GUN_MODEL_POS = new pc.Vec3(0.17, -0.32, -0.5);
const GUN_MODEL_YAW = 6;
const GUN_MODEL_ROLL = -6;
const GUN_MODEL_PITCH = 4;
/** Model knife: handle centre sits this far behind the knife pivot (the box knife's guard). */
const KNIFE_MODEL_BACK = 0.055;
/** Idle sway of the viewmodel: amplitude (m, degrees) and rate (rad/s). Time-based only. */
const SWAY_POS = 0.0022;
const SWAY_ROT = 0.45;
const SWAY_RATE = 1.3;
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

const KILL_SUFFIX: Record<KillKind, string> = {
    shot: '', headshot: ' (HS)', knife: ' (knife)', backstab: ' (backstab)'
};

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
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
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
#sb-health { font: 700 52px/1 system-ui, sans-serif; letter-spacing: .02em; }
#sb-health.low { color: #ff3b3b; }
#sb-info { opacity: .8; margin-top: 4px; }
#sb-info .ghosts { color: #9d8cff; } #sb-info .defenders { color: #ff9a3c; }
#sb-vis { margin: 0 0 6px; width: 150px; display: none; font: 600 11px/1 system-ui, sans-serif;
    letter-spacing: .14em; }
#sb-vis .row { display: flex; justify-content: space-between; margin-bottom: 3px; opacity: .85; }
#sb-vis .bar { height: 4px; background: rgba(255,255,255,.15); box-shadow: 0 0 2px #000; }
#sb-vis .fill { height: 100%; width: 0; background: #b9d4ff; }
#sb-vis.hidden .state { color: #8fe3a8; }
#sb-vis.exposed .state { color: #ff5a4a; } #sb-vis.exposed .fill { background: #ff5a4a; }
#sb-disc { top: 100px; left: 50%; transform: translateX(-50%); padding: 6px 14px; display: none;
    background: rgba(160,20,20,.85); font: 700 15px/1.2 system-ui, sans-serif; letter-spacing: .15em; }
#sb-hit { left: 50%; top: 50%; width: 0; height: 0; opacity: 0; transform: rotate(45deg); }
#sb-hit i { position: absolute; width: 2px; height: 7px; margin-left: -1px; left: 0; background: #fff; }
#sb-hit i:nth-child(1) { top: -13px; } #sb-hit i:nth-child(2) { top: 6px; }
#sb-hit i:nth-child(3), #sb-hit i:nth-child(4) { width: 7px; height: 2px; margin: -1px 0 0 0; top: 0; }
#sb-hit i:nth-child(3) { left: -13px; } #sb-hit i:nth-child(4) { left: 6px; }
#sb-hit.head i { background: #ff3030; }
#sb-hit.kill { transform: rotate(45deg) scale(1.6); }
#sb-feed { top: 10px; right: 12px; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
#sb-feed div { padding: 2px 8px; background: rgba(0,0,0,.45); }
#sb-feed div.me { background: rgba(255,255,255,.18); outline: 1px solid rgba(255,255,255,.5); }
#sb-dead { left: 50%; top: 58%; transform: translateX(-50%); display: none; white-space: nowrap;
    font: 600 26px/1 system-ui, sans-serif; letter-spacing: .08em; }
#sb-match { top: 8px; left: 50%; transform: translateX(-50%); text-align: center; white-space: nowrap;
    font: 600 13px/1.2 system-ui, sans-serif; letter-spacing: .12em; }
#sb-match .tag { display: none; color: #ff3b30; font-size: 10px; letter-spacing: .35em; }
#sb-match.planted .tag { display: block; }
#sb-match .timer { display: inline-block; font: 700 30px/1 system-ui, sans-serif; letter-spacing: .04em;
    font-variant-numeric: tabular-nums; }
#sb-match .timer.warm { font: 600 14px/1.8 system-ui, sans-serif; letter-spacing: .16em; opacity: .9; }
#sb-match .timer.bomb { color: #ff3b30; }
#sb-match .timer.pulse { animation: sb-pulse .5s ease-in-out infinite alternate; }
@keyframes sb-pulse { from { opacity: 1; transform: scale(1); } to { opacity: .4; transform: scale(1.1); } }
#sb-match .score { display: inline-block; margin-top: 4px; padding: 3px 10px; background: rgba(0,0,0,.4); }
#sb-match .score span { opacity: .7; }
#sb-match .score .ghosts { color: #9d8cff; } #sb-match .score .defenders { color: #ff9a3c; }
#sb-match .score span.mine { opacity: 1; font-weight: 800; text-decoration: underline; text-underline-offset: 3px; }
#sb-match .round { margin-top: 3px; font-size: 11px; letter-spacing: .25em; opacity: .7; }
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
#sb-scores { left: 50%; top: 50%; transform: translate(-50%, -50%); display: none; box-sizing: border-box; z-index: 2;
    width: min(520px, calc(100vw - 32px)); padding: 14px 18px 16px; background: rgba(10,12,16,.84);
    box-shadow: 0 6px 28px rgba(0,0,0,.6); font: 500 15px/1.2 system-ui, sans-serif; text-shadow: none; }
#sb-scores .title { text-align: center; font: 700 11px/1 system-ui, sans-serif; letter-spacing: .3em; opacity: .65; }
#sb-scores .hdr { display: flex; justify-content: space-between; margin-top: 12px; padding: 6px;
    border-bottom: 2px solid currentColor; font: 800 16px/1 system-ui, sans-serif; letter-spacing: .15em; }
#sb-scores .hdr.ghosts { color: #9d8cff; } #sb-scores .hdr.defenders { color: #ff9a3c; }
#sb-scores .hdr.mine span:first-child::after { content: '  (YOU)'; white-space: pre; font-size: 10px; letter-spacing: .2em; opacity: .7; }
#sb-scores .row { display: grid; grid-template-columns: 1fr 52px 52px; padding: 4px 6px; }
#sb-scores .row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#sb-scores .row span + span { text-align: right; font-variant-numeric: tabular-nums; }
#sb-scores .row.cols { opacity: .5; font-size: 10px; letter-spacing: .2em; padding-bottom: 2px; }
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
    height: number;
    seen: number;
    /** Copy of this frame's view, for matching remote shots to their shooter. */
    x: number;
    y: number;
    z: number;
    crouched: boolean;
    alive: boolean;
}

interface Tracer { e: pc.Entity; mi: pc.MeshInstance; t: number; }
interface Flash { e: pc.Entity; t: number; }
interface Impact { e: pc.Entity; t: number; }
interface FeedLine { el: HTMLDivElement; age: number; }

// Knife key poses: position (m, camera space) then Euler angles (degrees).
const KNIFE_REST = [0.16, -0.17, -0.36, 14, 8, -14];
const KNIFE_BACK = [0.2, -0.1, -0.32, 65, -12, -35];
const KNIFE_SLASH = [-0.08, -0.25, -0.48, -15, 45, 35];

export const createPresenter: CreatePresenter = (app, camera) => {
    // Materials (shared; per-instance opacity goes through mesh-instance parameters).
    const defenderMats = { body: makeMaterial(0.95, 0.5, 0.15, false), head: makeMaterial(0.85, 0.32, 0.12, false) };
    const ghostMat = makeGhostMaterial();
    const ghostSkinMat = makeSkinnedGhostMaterial(ENEMY_TINT);
    // The animated character loads in the background; until then (and for good if it fails)
    // remote players keep drawing as the box stand-ins below.
    let charModel: CharacterModel | null = null;
    loadCharacterModel(app, `${import.meta.env.BASE_URL}models/character.glb`, ghostSkinMat)
        .then(m => { charModel = m; })
        .catch((err: unknown) => {
            console.warn('[stillblade] Character model failed to load; drawing box players instead.', err);
        });
    // Weapons load independently: the viewmodel keeps its boxes and characters stay unarmed until then.
    let weaponModel: WeaponModel | null = null;
    loadWeaponModel(app, `${import.meta.env.BASE_URL}models/weapons.glb`)
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
    const tracerMat = makeMaterial(1, 0.95, 0.6, true, 0.9);
    const impactMat = makeMaterial(0.05, 0.05, 0.05, true);
    const bladeMat = makeMaterial(0.78, 0.8, 0.84, false);
    bladeMat.gloss = 0.7;
    bladeMat.metalness = 0.3;
    bladeMat.useMetalness = true;
    bladeMat.update();
    const knifeGuardMat = makeMaterial(0.35, 0.36, 0.38, false);
    const knifeHandleMat = makeMaterial(0.1, 0.09, 0.08, false);

    const tmpA = new pc.Vec3();
    const tmpB = new pc.Vec3();
    const UP = pc.Vec3.UP;
    const RIGHT = pc.Vec3.RIGHT;
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
            char: null, height: HULL_HEIGHT, seen: 0, x: 0, y: 0, z: 0, crouched: false, alive: false
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
        if (weaponModel) r.char.setWeapons(weaponModel);
        r.char.reset();
        if (r.look !== Look.None) applyCharLook(r);
    };

    const layoutRemote = (r: Remote): void => {
        const bodyH = r.height - HEAD_ZONE;
        r.body.setLocalScale(HULL_HALF_WIDTH * 2, bodyH, HULL_HALF_WIDTH * 2);
        r.body.setLocalPosition(0, bodyH / 2, 0);
        r.neck.setLocalPosition(0, bodyH, 0);
    };

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
            r.alive = v.alive;
            const look = v.team === 'defenders' ? Look.Defender
                : localTeam === 'ghosts' ? Look.AllyGhost : Look.EnemyGhost;
            if (r.look !== look) setLook(r, look);
            if (!r.char && charModel) attachCharacter(r, charModel);
            const ch = r.char;
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
            r.root.enabled = visible;
            if (!visible) continue;
            r.root.setPosition(v.pos[0], v.pos[1], v.pos[2]);
            r.root.setEulerAngles(0, v.yaw * DEG, 0);
            if (ch) continue;
            r.neck.setLocalEulerAngles(v.pitch * DEG, 0, 0);
            layoutRemote(r);
        }
        // Release players absent this frame (compact in place, no allocation).
        let w = 0;
        for (let j = 0; j < active.length; j++) {
            const r = active[j];
            if (r.seen === stamp) active[w++] = r;
            else { r.root.enabled = false; r.id = -1; r.alive = false; free.push(r); }
        }
        active.length = w;
    };

    // --- Viewmodels ------------------------------------------------------------------------------
    // All geometry sits at least ~0.2 m in front of the eye, well clear of the 0.05 m near plane.
    // The box versions are the fallback while weapons.glb loads (or if it fails); useWeaponModel swaps in
    // the meshes: gun = 1 draw call + the flash, knife = 1.
    const gun = new pc.Entity('viewmodel-gun');
    camera.addChild(gun);
    const gunBoxes = new pc.Entity('boxes');
    gun.addChild(gunBoxes);
    box(gunBoxes, gunMat, 0.05, 0.07, 0.26, 0, 0, 0, VM);                       // receiver
    box(gunBoxes, gunAccentMat, 0.026, 0.026, 0.22, 0, 0.012, -0.24, VM);       // barrel
    box(gunBoxes, gunMat, 0.036, 0.085, 0.05, 0, -0.065, -0.05, VM);            // magazine
    const grip = box(gunBoxes, gunAccentMat, 0.04, 0.08, 0.045, 0, -0.06, 0.08, VM);
    grip.setLocalEulerAngles(-15, 0, 0);
    const muzzle = new pc.Entity('muzzle');
    muzzle.setLocalPosition(0, 0.012, -0.36);
    gun.addChild(muzzle);
    const flash = box(muzzle, flashMat, 0.045, 0.045, 0.07, 0, 0, -0.03, VM);
    flash.enabled = false;
    let gunPos = GUN_POS;
    let gunPitch = 0, gunYaw = 0, gunRoll = 0;

    // Knife: origin at the guard, blade along -Z.
    const knife = new pc.Entity('viewmodel-knife');
    camera.addChild(knife);
    const knifeBoxes = new pc.Entity('boxes');
    knife.addChild(knifeBoxes);
    box(knifeBoxes, bladeMat, 0.007, 0.03, 0.16, 0, 0.003, -0.08, VM);          // blade
    box(knifeBoxes, bladeMat, 0.005, 0.016, 0.03, 0, 0.01, -0.172, VM);         // tip (narrower)
    box(knifeBoxes, knifeGuardMat, 0.02, 0.055, 0.012, 0, 0, 0, VM);            // guard
    box(knifeBoxes, knifeHandleMat, 0.022, 0.028, 0.09, 0, -0.002, 0.051, VM);  // handle
    knife.enabled = false;

    const useWeaponModel = (m: WeaponModel): void => {
        const vmMat = makeWeaponMaterial(0.4);
        const g = instantiateWeapon(m, 'gun', vmMat, VM);
        gun.addChild(g.entity);
        gunBoxes.enabled = false;
        // Tracers and the flash start at the end of the suppressor.
        muzzle.reparent(g.muzzle!);
        muzzle.setLocalPosition(0, 0, 0);
        muzzle.setLocalEulerAngles(0, 0, 0);
        flash.setLocalScale(0.05, 0.05, 0.085);
        flash.setLocalPosition(0, 0, -0.04);
        gunPos = GUN_MODEL_POS;
        gunPitch = GUN_MODEL_PITCH; gunYaw = GUN_MODEL_YAW; gunRoll = GUN_MODEL_ROLL;
        const k = instantiateWeapon(m, 'knife', vmMat, VM);
        knife.addChild(k.entity);
        k.entity.setLocalPosition(0, 0, KNIFE_MODEL_BACK);
        knifeBoxes.enabled = false;
        for (let i = 0; i < active.length; i++) active[i].char?.setWeapons(m);
        for (let i = 0; i < free.length; i++) free[i].char?.setWeapons(m);
    };

    let recoilT = 0;
    let flashT = 0;
    let localAlive = false;
    /** Seconds since the current knife swing started; < 0 when idle. */
    let swingT = -1;
    let windup = 0.2;
    let vmTeam: Team | null = null;

    const setKnifePose = (a: number[], b: number[], t: number): void => {
        const u = 1 - t;
        knife.setLocalPosition(a[0] * u + b[0] * t, a[1] * u + b[1] * t, a[2] * u + b[2] * t);
        knife.setLocalEulerAngles(a[3] * u + b[3] * t, a[4] * u + b[4] * t, a[5] * u + b[5] * t);
    };

    const updateViewmodel = (dt: number, team: Team): void => {
        if (team !== vmTeam) {
            vmTeam = team;
            recoilT = 0;
            flashT = 0;
            swingT = -1;
        }
        const defender = team === 'defenders';
        gun.enabled = localAlive && defender;
        knife.enabled = localAlive && !defender;
        if (defender) {
            recoilT = Math.max(0, recoilT - dt);
            flashT = Math.max(0, flashT - dt);
            flash.enabled = flashT > 0;
            const k = recoilT / RECOIL_TIME;
            const e = k * k;
            // Subtle time-based sway (the presenter has no player speed); damped while firing.
            const s = 1 - 0.7 * k;
            const sx = Math.sin(time * SWAY_RATE) * SWAY_POS * s;
            const sy = Math.sin(time * SWAY_RATE * 2) * SWAY_POS * 0.6 * s;
            gun.setLocalPosition(gunPos.x + sx, gunPos.y + sy + 0.012 * e, gunPos.z + 0.035 * e);
            gun.setLocalEulerAngles(gunPitch + 4 * e + sy * 120, gunYaw + Math.sin(time * SWAY_RATE * 0.7) * SWAY_ROT * s,
                gunRoll + sx * 160);
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

    // --- Tracers and impacts --------------------------------------------------------------------
    const tracers: Tracer[] = [];
    for (let i = 0; i < TRACER_COUNT; i++) {
        const e = box(app.root, tracerMat, TRACER_THICKNESS, TRACER_THICKNESS, 1);
        e.enabled = false;
        tracers.push({ e, mi: e.render!.meshInstances[0], t: 0 });
    }
    let nextTracer = 0;
    const impacts: Impact[] = [];
    for (let i = 0; i < IMPACT_COUNT; i++) {
        const e = box(app.root, impactMat, 0.05, 0.05, 0.05);
        e.enabled = false;
        impacts.push({ e, t: 0 });
    }
    let nextImpact = 0;
    // Muzzle flashes of remote defenders: world-space effects like the tracers (not part of a character).
    const remoteFlashes: Flash[] = [];
    for (let i = 0; i < REMOTE_FLASH_COUNT; i++) {
        const e = box(app.root, flashMat, 0.06, 0.06, 0.1);
        e.enabled = false;
        remoteFlashes.push({ e, t: 0 });
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

    const updateEffects = (dt: number): void => {
        for (let i = 0; i < REMOTE_FLASH_COUNT; i++) {
            const f = remoteFlashes[i];
            if (f.t <= 0) continue;
            f.t -= dt;
            if (f.t <= 0) f.e.enabled = false;
        }
        for (let i = 0; i < TRACER_COUNT; i++) {
            const tr = tracers[i];
            if (tr.t <= 0) continue;
            tr.t -= dt;
            if (tr.t <= 0) { tr.e.enabled = false; continue; }
            tr.mi.setParameter('material_opacity', 0.9 * (tr.t / TRACER_LIFE));
        }
        for (let i = 0; i < IMPACT_COUNT; i++) {
            const im = impacts[i];
            if (im.t <= 0) continue;
            im.t -= dt;
            if (im.t <= 0) im.e.enabled = false;
        }
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

    const updateBomb = (dt: number, match: MatchView): void => {
        const p = match.bombPos;
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
    };

    // --- HUD -------------------------------------------------------------------------------------
    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
    const crosshair = document.getElementById('crosshair');
    const vignette = div('sb-vignette');
    const stats = div('sb-stats');
    const visEl = div('sb-vis', stats, '');
    const visRow = div('', visEl, 'row');
    div('', visRow, '').textContent = 'VISIBILITY';
    const visStateEl = div('', visRow, 'state');
    const visFill = div('', div('', visEl, 'bar'), 'fill');
    const healthEl = div('sb-health', stats, '');
    const infoEl = div('sb-info', stats, '');
    const teamEl = infoEl.appendChild(document.createElement('span'));
    const idEl = infoEl.appendChild(document.createElement('span'));
    const pingEl = infoEl.appendChild(document.createElement('span'));
    const discEl = div('sb-disc');
    discEl.textContent = 'DISCONNECTED';
    const hitEl = div('sb-hit');
    for (let i = 0; i < 4; i++) hitEl.appendChild(document.createElement('i'));
    const feedEl = div('sb-feed');
    const deadEl = div('sb-dead');
    const feed: FeedLine[] = [];

    // Match bar (top centre).
    const matchEl = div('sb-match');
    div('', matchEl, 'tag').textContent = 'BOMB';
    const timerEl = div('', matchEl, 'timer');
    const timerSlot = new Slot(timerEl);
    const scoreRow = div('', div('', matchEl, ''), 'score');
    const scoreG = span(scoreRow, 'ghosts');
    span(scoreRow, '', ' — ').style.opacity = '.6';
    const scoreD = span(scoreRow, 'defenders');
    const roundSlot = new Slot(div('', matchEl, 'round'));

    // Phase banner (centre upper).
    const bannerEl = div('sb-banner');
    const bannerT = new Slot(div('', bannerEl, 't'));
    const bannerS = new Slot(div('', bannerEl, 's'));
    const bannerM = new Slot(div('', bannerEl, 'm'));
    const bannerB = new Slot(div('', bannerEl, 'b'));

    // Use prompt and plant/defuse progress (lower centre).
    const useEl = div('sb-use');
    useEl.appendChild(document.createTextNode('Hold'));
    useEl.appendChild(document.createElement('b')).textContent = 'E';
    const useVerb = new Slot(span(useEl));
    const actEl = div('sb-act');
    const actLabel = new Slot(div('', actEl, ''));
    const actFill = div('', div('', actEl, 'bar'), 'fill');

    // Scoreboard.
    const scoresEl = div('sb-scores');

    // Roster, copied (the caller may reuse its array).
    const roster: RosterEntry[] = [];
    const names = new Map<number, string>();
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
    let scoresG = -1, scoresD = -1, scoresRound = -1;
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

    const updateHud = (dt: number, local: LocalView, phase: Phase): void => {
        const hp = Math.max(0, Math.round(local.health));
        if (hp !== shownHealth) {
            shownHealth = hp;
            healthEl.textContent = String(hp);
            healthEl.classList.toggle('low', hp < 35);
        }
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
            if (crosshair) crosshair.style.visibility = local.alive ? '' : 'hidden';
            shownDeadKey = NaN;
        }
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
            timerSlot.set(warm ? 'WARMUP — waiting for players' : clock(secs));
        }
        if (planted !== shownPlanted) { shownPlanted = planted; matchEl.classList.toggle('planted', planted); }
        if (match.scoreGhosts !== shownScoreG) { shownScoreG = match.scoreGhosts; scoreG.textContent = `GHOSTS ${shownScoreG}`; }
        if (match.scoreDefenders !== shownScoreD) {
            shownScoreD = match.scoreDefenders;
            scoreD.textContent = `${shownScoreD} DEFENDERS`;
        }
        if (local.team !== shownMine) {
            shownMine = local.team;
            scoreG.className = local.team === 'ghosts' ? 'ghosts mine' : 'ghosts';
            scoreD.className = local.team === 'defenders' ? 'defenders mine' : 'defenders';
        }
        if (match.round !== shownRound) { shownRound = match.round; roundSlot.set(`ROUND ${shownRound}`); }
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

    const updateUse = (local: LocalView): void => {
        const acting = local.alive && local.action > 0;
        const prompt = local.alive && local.canAct && !acting;
        if (prompt !== shownUse) { shownUse = prompt; useEl.style.display = prompt ? 'block' : 'none'; }
        if (prompt) useVerb.set(USE_VERB[local.team]);
        if (acting !== shownAct) { shownAct = acting; actEl.style.display = acting ? 'block' : 'none'; }
        if (acting) {
            actLabel.set(ACT_LABEL[local.team]);
            const pct = Math.round(Math.min(1, local.action) * 100);
            if (pct !== shownActPct) { shownActPct = pct; actFill.style.width = `${pct}%`; }
        }
    };

    const renderScores = (local: LocalView, match: MatchView): void => {
        scoresEl.replaceChildren();
        div('', scoresEl, 'title').textContent = `ROUND ${match.round} · FIRST TO ${ROUNDS_TO_WIN}`;
        const teams: Team[] = local.team === 'ghosts' ? ['ghosts', 'defenders'] : ['defenders', 'ghosts'];
        for (const team of teams) {
            const hdr = div('', scoresEl, team === local.team ? `hdr ${team} mine` : `hdr ${team}`);
            span(hdr, '', TEAM_LABEL[team]);
            span(hdr, '', String(team === 'ghosts' ? match.scoreGhosts : match.scoreDefenders));
            const cols = div('', scoresEl, 'row cols');
            span(cols, '', 'NAME'); span(cols, '', 'K'); span(cols, '', 'D');
            const members = roster.filter(p => p.team === team)
                .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
            if (members.length === 0) div('', scoresEl, 'empty').textContent = 'No players';
            for (const p of members) {
                const row = div('', scoresEl, `row${p.alive ? '' : ' dead'}${p.id === local.id ? ' me' : ''}`);
                span(row, '', p.name || `Player ${p.id}`);
                span(row, '', String(p.kills));
                span(row, '', String(p.deaths));
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
            match.scoreGhosts === scoresG && match.scoreDefenders === scoresD && match.round === scoresRound) return;
        scoresRosterV = rosterVersion; scoresLocalId = local.id; scoresTeam = local.team;
        scoresG = match.scoreGhosts; scoresD = match.scoreDefenders; scoresRound = match.round;
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
            updateRemotes(dt, remotes);
            updateViewmodel(dt, local.team);
            updateEffects(dt);
            updateBomb(dt, match);
            updateHud(dt, local, match.phase);
            updateMatchBar(local, match);
            updateBanner(dt, local, match);
            updateUse(local);
            updateScores(local, match);
        },

        roster(players: readonly RosterEntry[]): void {
            roster.length = 0;
            names.clear();
            for (let i = 0; i < players.length; i++) {
                const p = players[i];
                roster.push({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, alive: p.alive });
                if (p.name) names.set(p.id, p.name);
            }
            rosterVersion++;
        },

        shot(from: Vec3, to: Vec3, isLocal: boolean): void {
            if (isLocal && localAlive && vmTeam === 'defenders') {
                recoilT = RECOIL_TIME;
                flashT = FLASH_TIME;
                flash.setLocalEulerAngles(0, 0, Math.random() * 90);
                tmpA.copy(muzzle.getPosition());
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
                        f.e.setRotation(rot);
                        f.e.setPosition(mp);
                        f.e.translateLocal(0, 0, -0.04);
                        f.e.rotateLocal(0, 0, Math.random() * 90);
                        f.e.enabled = true;
                        f.t = REMOTE_FLASH_TIME;
                    }
                }
            }
            tmpB.set(to[0], to[1], to[2]);

            const im = impacts[nextImpact];
            nextImpact = (nextImpact + 1) % IMPACT_COUNT;
            im.e.setPosition(tmpB);
            im.e.enabled = true;
            im.t = IMPACT_LIFE;

            const dx = tmpB.x - tmpA.x, dy = tmpB.y - tmpA.y, dz = tmpB.z - tmpA.z;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len < 0.05) return;
            const tr = tracers[nextTracer];
            nextTracer = (nextTracer + 1) % TRACER_COUNT;
            tr.e.enabled = true;
            tr.e.setPosition(tmpA.x + dx * 0.5, tmpA.y + dy * 0.5, tmpA.z + dz * 0.5);
            tr.e.lookAt(tmpB, Math.abs(dy) > 0.99 * len ? RIGHT : UP);
            tr.e.setLocalScale(TRACER_THICKNESS, TRACER_THICKNESS, len);
            tr.mi.setParameter('material_opacity', 0.9);
            tr.t = TRACER_LIFE;
        },

        knifeSwing(windupSeconds: number): void {
            windup = Math.max(0.01, windupSeconds);
            swingT = 0;
        },

        hitConfirm(head: boolean, killed: boolean): void {
            hitDur = killed ? 0.25 : 0.12;
            hitT = hitDur;
            hitEl.classList.toggle('head', head);
            hitEl.classList.toggle('kill', killed);
            hitEl.style.opacity = '1';
        },

        damaged(amount: number): void {
            vignetteLevel = Math.min(0.9, vignetteLevel + 0.25 + amount / 100);
            vignette.style.opacity = vignetteLevel.toFixed(3);
        },

        killFeed(killerId: number, victimId: number, kind: KillKind): void {
            const reuse = feed.length >= KILLFEED_MAX ? feed.pop()! : null;
            const el = reuse ? reuse.el : document.createElement('div');
            el.textContent = `${playerName(killerId)} ▸ ${playerName(victimId)}${KILL_SUFFIX[kind]}`;
            el.className = killerId === localId || victimId === localId ? 'me' : '';
            el.style.opacity = '';
            feedEl.insertBefore(el, feedEl.firstChild);
            feed.unshift({ el, age: 0 });
        }
    };
};
