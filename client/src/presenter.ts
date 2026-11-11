import * as pc from 'playcanvas';
import { HEAD_ZONE, HULL_HALF_WIDTH, HULL_HEIGHT, HULL_HEIGHT_CROUCHED } from '@shared/constants';
import type { Team } from '@shared/protocol';
import type { Vec3 } from '@shared/types';
import type { CreatePresenter, LocalView, RemoteView } from './presenter-api';

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
const GUN_POS = new pc.Vec3(0.15, -0.15, -0.46);

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
    x = 0, y = 0, z = 0): pc.Entity {
    const e = new pc.Entity();
    e.addComponent('render', { type: 'box', material, castShadows: false, receiveShadows: false });
    e.setLocalScale(sx, sy, sz);
    e.setLocalPosition(x, y, z);
    parent.addChild(e);
    return e;
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
#sb-disc { top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px; display: none;
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
#sb-dead { left: 50%; top: 58%; transform: translateX(-50%); display: none;
    font: 600 26px/1 system-ui, sans-serif; letter-spacing: .08em; }
`;

function div(id: string, parent: HTMLElement = document.body, cls = 'sb-ui'): HTMLDivElement {
    const d = document.createElement('div');
    if (id) d.id = id;
    if (cls) d.className = cls;
    parent.appendChild(d);
    return d;
}

const playerName = (id: number): string => `Player ${id}`;

// ---------------------------------------------------------------------------------------------
// Pooled scene objects

interface Remote {
    id: number;
    team: Team | null;
    root: pc.Entity;
    body: pc.Entity;
    neck: pc.Entity;
    head: pc.Entity;
    visor: pc.Entity;
    height: number;
    seen: number;
}

interface Tracer { e: pc.Entity; mi: pc.MeshInstance; t: number; }
interface Impact { e: pc.Entity; t: number; }
interface FeedLine { el: HTMLDivElement; age: number; }

export const createPresenter: CreatePresenter = (app, camera) => {
    // Materials (shared; per-instance tracer opacity goes through a mesh-instance parameter).
    const teamMats: Record<Team, { body: pc.Material; head: pc.Material }> = {
        ghosts: { body: makeMaterial(0.42, 0.36, 0.85, false), head: makeMaterial(0.3, 0.75, 0.78, false) },
        defenders: { body: makeMaterial(0.95, 0.5, 0.15, false), head: makeMaterial(0.85, 0.32, 0.12, false) }
    };
    const visorMat = makeMaterial(0.95, 0.95, 0.85, true);
    const gunMat = makeMaterial(0.13, 0.14, 0.16, false);
    const gunAccentMat = makeMaterial(0.28, 0.3, 0.33, false);
    const flashMat = makeMaterial(1, 0.9, 0.55, true, 0.9);
    const tracerMat = makeMaterial(1, 0.95, 0.6, true, 0.9);
    const impactMat = makeMaterial(0.05, 0.05, 0.05, true);

    const tmpA = new pc.Vec3();
    const tmpB = new pc.Vec3();
    const UP = pc.Vec3.UP;
    const RIGHT = pc.Vec3.RIGHT;

    // --- Remote players --------------------------------------------------------------------
    const active: Remote[] = [];
    const free: Remote[] = [];
    let stamp = 0;

    const makeRemote = (): Remote => {
        const root = new pc.Entity('remote');
        const hw = HULL_HALF_WIDTH * 2;
        const body = box(root, teamMats.ghosts.body, hw, 1, hw);
        const neck = new pc.Entity('neck');
        root.addChild(neck);
        const head = box(neck, teamMats.ghosts.head, HEAD_WIDTH, HEAD_ZONE, HEAD_WIDTH, 0, HEAD_ZONE / 2, 0);
        const visor = box(neck, visorMat, 0.3, 0.07, 0.06, 0, HEAD_ZONE * 0.62, -HEAD_WIDTH / 2 - 0.025);
        app.root.addChild(root);
        return { id: -1, team: null, root, body, neck, head, visor, height: HULL_HEIGHT, seen: 0 };
    };

    const setTeam = (r: Remote, team: Team): void => {
        r.team = team;
        r.body.render!.material = teamMats[team].body;
        r.head.render!.material = teamMats[team].head;
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
                active.push(r);
            } else {
                r.height += (target - r.height) * k;
            }
            r.seen = stamp;
            if (r.team !== v.team) setTeam(r, v.team);
            r.root.enabled = v.alive;
            if (!v.alive) continue;
            r.root.setPosition(v.pos[0], v.pos[1], v.pos[2]);
            r.root.setEulerAngles(0, v.yaw * DEG, 0);
            r.neck.setLocalEulerAngles(v.pitch * DEG, 0, 0);
            layoutRemote(r);
        }
        // Release players absent this frame (compact in place, no allocation).
        let w = 0;
        for (let j = 0; j < active.length; j++) {
            const r = active[j];
            if (r.seen === stamp) active[w++] = r;
            else { r.root.enabled = false; r.id = -1; free.push(r); }
        }
        active.length = w;
    };

    // --- Viewmodel ---------------------------------------------------------------------------
    // All geometry sits at least ~0.2 m in front of the eye, well clear of the 0.05 m near plane.
    const gun = new pc.Entity('viewmodel');
    camera.addChild(gun);
    box(gun, gunMat, 0.05, 0.07, 0.26);                                 // receiver
    box(gun, gunAccentMat, 0.026, 0.026, 0.22, 0, 0.012, -0.24);        // barrel
    box(gun, gunMat, 0.036, 0.085, 0.05, 0, -0.065, -0.05);             // magazine
    const grip = box(gun, gunAccentMat, 0.04, 0.08, 0.045, 0, -0.06, 0.08);
    grip.setLocalEulerAngles(-15, 0, 0);
    const muzzle = new pc.Entity('muzzle');
    muzzle.setLocalPosition(0, 0.012, -0.36);
    gun.addChild(muzzle);
    const flash = box(muzzle, flashMat, 0.045, 0.045, 0.07, 0, 0, -0.03);
    flash.enabled = false;
    let recoilT = 0;
    let flashT = 0;
    let localAlive = false;

    const updateViewmodel = (dt: number): void => {
        gun.enabled = localAlive;
        recoilT = Math.max(0, recoilT - dt);
        flashT = Math.max(0, flashT - dt);
        flash.enabled = flashT > 0;
        const k = recoilT / RECOIL_TIME;
        const e = k * k;
        gun.setLocalPosition(GUN_POS.x, GUN_POS.y + 0.012 * e, GUN_POS.z + 0.035 * e);
        gun.setLocalEulerAngles(4 * e, 0, 0);
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

    const updateEffects = (dt: number): void => {
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

    // --- HUD -------------------------------------------------------------------------------------
    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
    const crosshair = document.getElementById('crosshair');
    const vignette = div('sb-vignette');
    const stats = div('sb-stats');
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
    let shownRespawn = -1;

    const updateHud = (dt: number, local: LocalView): void => {
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
            idEl.textContent = ` · ${playerName(local.id)} · `;
        }
        if (ping !== shownPing) { shownPing = ping; pingEl.textContent = `${ping} ms`; }
        if (local.connected !== shownConnected) {
            shownConnected = local.connected;
            discEl.style.display = local.connected ? 'none' : 'block';
        }
        if (local.alive !== shownAlive) {
            shownAlive = local.alive;
            deadEl.style.display = local.alive ? 'none' : 'block';
            if (crosshair) crosshair.style.visibility = local.alive ? '' : 'hidden';
            shownRespawn = -1;
        }
        if (!local.alive) {
            const n = Math.max(0, Math.ceil(local.respawnIn));
            if (n !== shownRespawn) { shownRespawn = n; deadEl.textContent = `Respawning in ${n}`; }
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

    return {
        frame(dt: number, local: LocalView, remotes: readonly RemoteView[]): void {
            localAlive = local.alive;
            localId = local.id;
            updateRemotes(dt, remotes);
            updateViewmodel(dt);
            updateEffects(dt);
            updateHud(dt, local);
        },

        shot(from: Vec3, to: Vec3, isLocal: boolean): void {
            if (isLocal && localAlive) {
                recoilT = RECOIL_TIME;
                flashT = FLASH_TIME;
                flash.setLocalEulerAngles(0, 0, Math.random() * 90);
                tmpA.copy(muzzle.getPosition());
            } else {
                tmpA.set(from[0], from[1], from[2]);
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

        killFeed(killerId: number, victimId: number, head: boolean): void {
            const reuse = feed.length >= KILLFEED_MAX ? feed.pop()! : null;
            const el = reuse ? reuse.el : document.createElement('div');
            el.textContent = `${playerName(killerId)} ▸ ${playerName(victimId)}${head ? ' (HS)' : ''}`;
            el.className = killerId === localId || victimId === localId ? 'me' : '';
            el.style.opacity = '';
            feedEl.insertBefore(el, feedEl.firstChild);
            feed.unshift({ el, age: 0 });
        }
    };
};
