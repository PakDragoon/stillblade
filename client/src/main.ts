import * as pc from 'playcanvas';
import {
    EYE_HEIGHT, EYE_HEIGHT_CROUCHED, KNIFE_WINDUP_TICKS, MAX_HEALTH,
    SHOT_RANGE, STEP_DISTANCE, STEP_LOUD_CROUCH, STEP_LOUD_RUN, STEP_LOUD_WALK, TICK_DT
} from '@shared/constants';
import {
    GUN_DRY, GUN_RELOAD, aimFraction, copyLoadout, createLoadout, heldGun, heldWeapon, justSwitched, recoilPitch,
    recoilScale, recoilYaw, resetLoadout, sameLoadout, shotDirectionFor, spreadAngle, stepLoadout
} from '@shared/gun';
import { WEAPONS, WEAPON_COUNT } from '@shared/weapons';
import {
    KNIFE_SLASH, KNIFE_SWING, copyKnifeState, createKnifeState, resetKnife, sameKnifeState, stepKnife
} from '@shared/knife';
import { copyPlayerState, createPlayerState, horizontalSpeed, stepPlayer } from '@shared/movement';
import {
    DEFAULT_PORT, type NetCmd, type RosterEntry, type RoundMsg, type SelfSnap, type ShotEvent, type SlashEvent,
    type SoundEvent
} from '@shared/protocol';
import { DEFAULT_MAP, isMapId, type MapListEntry } from '@shared/maps';
import { canAct, movementLocked } from '@shared/rules';
import { rayWorld } from '@shared/raycast';
import type { Box, MapData, Vec3 } from '@shared/types';
import { createAudio } from './audio';
import type { BombView, ListenerView } from './audio-api';
import { Input } from './input';
import { applyMapLook } from './maplook';
import { Net } from './net';
import { createPresenter } from './presenter';
import type { LocalView, MatchView, WeaponSlotView } from './presenter-api';

const RAD = Math.PI / 180;
/** Vertical field of view from the hip, in degrees; aiming down sights narrows it by the weapon's zoom. */
const BASE_FOV = 74;
const TAN_HALF_FOV = Math.tan((BASE_FOV / 2) * RAD);
/** Prediction errors larger than this are teleports (respawn), not drift: snap instead of smoothing. */
const SNAP_DISTANCE = 2;

/** A sent command plus what is needed to replay the gun exactly as it was predicted. Never sent. */
interface PendingCmd extends NetCmd {
    /** We were alive and simulated it. */
    live: boolean;
    /** The trigger could act (not frozen, hands not busy planting or defusing). */
    armed: boolean;
}

const params = new URLSearchParams(location.search);
// Where the game server is: ?server= for testing, VITE_SERVER_URL in production builds, otherwise
// the same host as the page (local development). A secure page may only open secure sockets.
const serverBase = (
    params.get('server') ?? import.meta.env.VITE_SERVER_URL ??
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${DEFAULT_PORT}`
).replace(/\/+$/, '');
/** Relative, so the built client works from any sub-path (for example GitHub Pages). */
const ASSETS = import.meta.env.BASE_URL;
/** `?res=0.7` pins the render resolution; otherwise it adapts to hold the frame rate. */
const fixedRes = Math.min(1, Math.max(0, Number(params.get('res')) || 0));
/** `?lag=150` adds 150 ms of artificial round-trip latency. */
const lagMs = Math.max(0, Number(params.get('lag')) || 0);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const overlay = document.getElementById('overlay')!;
const status = document.getElementById('status')!;
const menu = document.getElementById('menu') as HTMLFormElement;
const nameInput = document.getElementById('name') as HTMLInputElement;
const roomInput = document.getElementById('room') as HTMLInputElement;
const mapSelect = document.getElementById('map') as HTMLSelectElement;

interface JoinChoice { name: string; room: string; map: string }

/**
 * Shows the name, room and map form and resolves when the player presses Play. `?auto=1` skips it.
 * The map is a request: it is used if the room is new, otherwise the room's own map wins.
 */
function askToJoin(maps: MapListEntry[], onGesture: () => void): Promise<JoinChoice> {
    let saved = '';
    try { saved = localStorage.getItem('sb-name') ?? ''; } catch { /* storage unavailable: no remembered name */ }
    nameInput.value = params.get('name') ?? saved;
    roomInput.value = params.get('room') ?? '';
    for (const m of maps) mapSelect.add(new Option(m.name, m.id));
    const wanted = params.get('map') ?? '';
    mapSelect.value = maps.some(m => m.id === wanted) ? wanted : maps.some(m => m.id === DEFAULT_MAP) ? DEFAULT_MAP : maps[0]?.id ?? '';
    const read = (): JoinChoice => ({
        name: nameInput.value.trim(), room: roomInput.value.trim(),
        // An id from the URL that is not in the list still goes to the server, which says no clearly.
        map: params.has('auto') && wanted ? wanted : mapSelect.value
    });
    if (params.has('auto')) return Promise.resolve(read());
    menu.hidden = false;
    status.textContent = '';
    return new Promise(resolve => {
        menu.addEventListener('submit', e => {
            e.preventDefault();
            e.stopPropagation();
            const choice = read();
            try { localStorage.setItem('sb-name', choice.name); } catch { /* not remembered */ }
            menu.hidden = true;
            onGesture();
            resolve(choice);
        }, { once: true });
    });
}

const app = new pc.Application(canvas, {
    graphicsDeviceOptions: { antialias: false, alpha: false, powerPreference: 'high-performance' }
});
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
// Integrated GPUs are fill-rate bound: never render above CSS resolution.
app.graphicsDevice.maxPixelRatio = 1;
window.addEventListener('resize', () => app.resizeCanvas());

// The world is drawn unlit from its baked lightmap; these realtime lights only light the players and
// the first-person weapon, matched to the bake (tools/blender/mapbuilder.py): the sun at 47.9 deg elevation
// toward engine (0.554, 0.742, 0.377) (the light shines along its -Y: pitch 90 - 47.9, yaw 55.8), warm,
// and an ambient close to the baked sky fill on vertical surfaces.
const SUN_ELEVATION_DEG = 47.9;
const SUN_YAW_DEG = 55.8;
app.scene.ambientLight = new pc.Color(0.4, 0.42, 0.47);
const sun = new pc.Entity('sun');
sun.addComponent('light', { type: 'directional', color: new pc.Color(1, 0.93, 0.78), intensity: 0.95, castShadows: false });
sun.setEulerAngles(90 - SUN_ELEVATION_DEG, SUN_YAW_DEG, 0);
app.root.addChild(sun);

const camera = new pc.Entity('camera');
camera.addComponent('camera', {
    fov: BASE_FOV, nearClip: 0.05, farClip: 200, clearColor: new pc.Color(0.53, 0.62, 0.72)
});
app.root.addChild(camera);

function loadContainer(url: string): Promise<pc.Asset> {
    return new Promise((resolve, reject) => {
        const asset = new pc.Asset(url, 'container', { url });
        asset.once('load', () => resolve(asset));
        asset.once('error', (err: unknown) => reject(new Error(`Failed to load ${url}: ${err}`)));
        app.assets.add(asset);
        app.assets.load(asset);
    });
}

/** The maps this build ships (client/public/maps/index.json, written by the map builder). */
async function fetchMapList(): Promise<MapListEntry[]> {
    try {
        const r = await fetch(`${ASSETS}maps/index.json`);
        if (r.ok) {
            const d = await r.json() as { maps?: MapListEntry[] };
            if (Array.isArray(d.maps) && d.maps.length > 0) return d.maps;
        }
    } catch { /* fall through to the default */ }
    return [{ id: DEFAULT_MAP, name: DEFAULT_MAP }];
}

/** Loads a map's collision/gameplay data and its baked visuals, and adds it to the scene. */
async function loadMap(id: string): Promise<MapData> {
    if (!isMapId(id)) throw new Error(`Bad map id ${JSON.stringify(id)}`);
    const [mapData, mapAsset] = await Promise.all([
        fetch(`${ASSETS}maps/${id}.json`).then(r => {
            if (!r.ok) throw new Error(`Failed to load map data: ${r.status}`);
            return r.json() as Promise<MapData>;
        }),
        loadContainer(`${ASSETS}maps/${id}.glb`)
    ]);
    const mapEntity = (mapAsset.resource as pc.ContainerResource).instantiateRenderEntity();
    app.root.addChild(mapEntity);
    // Baked maps draw unlit (albedo x baked light): no realtime lighting cost on the world at all.
    if (mapData.look) await applyMapLook(app, mapEntity, camera, mapData, `${ASSETS}maps/`);
    return mapData;
}

async function start(): Promise<void> {
    const mapList = await fetchMapList();
    const input = new Input(canvas);
    const presenter = createPresenter(app, camera);
    // Audio needs the map's boxes for occlusion; the array is filled once the room's map is known.
    const boxes: Box[] = [];
    const audio = createAudio(boxes);

    const { name, room, map } = await askToJoin(mapList, () => { audio.unlock(); input.lock(); });
    const query = new URLSearchParams();
    if (room) query.set('room', room);
    if (name) query.set('name', name);
    if (map) query.set('map', map);
    const serverUrl = `${serverBase}/?${query}`;

    // The room decides the map: connect, learn it from the welcome, load it, then start simulating.
    status.textContent = 'Connecting…';
    const net = new Net(serverUrl, lagMs);
    const welcome = await net.welcome.catch((err: unknown) => {
        throw new Error(`Could not join: ${err instanceof Error ? err.message : String(err)}`);
    });
    status.textContent = `Loading ${welcome.mapName}…`;
    const mapData = await loadMap(welcome.map);
    boxes.push(...mapData.boxes);
    const camSpawn = mapData.spawns.ghosts[0];
    camera.setPosition(camSpawn.pos[0], camSpawn.pos[1] + EYE_HEIGHT, camSpawn.pos[2]);

    // Predicted local player: `curr` is the latest simulated tick, `prev` the one before it.
    const curr = createPlayerState(mapData.spawns.ghosts[0].pos);
    const prev = createPlayerState(curr.pos);
    /** Commands sent but not yet acknowledged; replayed on top of every server correction. */
    const pending: PendingCmd[] = [];
    /** Visual-only offset that hides prediction corrections by blending them out over a few frames. */
    const errorOffset: Vec3 = [0, 0, 0];
    let seq = 0;
    /** Predicted defender weapons (both guns, switch, aim, trigger), reconciled and replayed with movement. */
    const loadout = createLoadout();
    const loadoutBefore = createLoadout();
    /** Snapshots whose replayed weapon state (any field of the loadout) differed from the prediction (should stay 0). */
    let gunMismatches = 0;
    /** Recoil camera kick (radians) at the previous and current tick, interpolated like position. */
    let kickPitchPrev = 0, kickYawPrev = 0, kickPitch = 0, kickYaw = 0;
    /** Aim-down-sights progress 0..1 at the previous and current tick, interpolated for the field of view. */
    let aimPrev = 0, aimCurr = 0;
    /** Predicted knife timing (ghosts), stepped like the server does (shared/knife.ts). */
    const knife = createKnifeState();
    const knifeBefore = createKnifeState();
    /** Snapshots whose replayed knife timing differed from what we had predicted (should stay 0). */
    let knifeMismatches = 0;
    let stepAccum = 0;
    let vis = 0;
    let action = 0;
    /** Server time (ms) the current phase ends; 0 in warmup. */
    let phaseEndsAt = 0;
    const match: MatchView = {
        phase: 'warmup', timeLeft: 0, round: 1, scoreGhosts: 0, scoreDefenders: 0, bombPos: null,
        winner: null, reason: null, matchOver: false
    };
    const bombView: BombView = { pos: [0, 0, 0], timeLeft: 0 };
    let alive = false;
    let health = MAX_HEALTH;
    let respawnAt = 0;

    const eyePos: Vec3 = [0, 0, 0];
    const aim: Vec3 = [0, 0, 0];
    const shotEnd: Vec3 = [0, 0, 0];

    net.start({
        snapshot(me: SelfSnap, ack: number): void {
            health = me.health;
            alive = me.alive;
            respawnAt = me.respawnAt;
            vis = me.vis;
            action = me.action;
            let drop = 0;
            while (drop < pending.length && pending[drop].seq <= ack) drop++;
            if (drop > 0) pending.splice(0, drop);
            if (!me.alive) return;

            // Reconcile: adopt the server's state, then re-run everything it has not seen yet.
            const bx = curr.pos[0], by = curr.pos[1], bz = curr.pos[2];
            curr.pos[0] = me.pos[0]; curr.pos[1] = me.pos[1]; curr.pos[2] = me.pos[2];
            curr.vel[0] = me.vel[0]; curr.vel[1] = me.vel[1]; curr.vel[2] = me.vel[2];
            curr.onGround = me.onGround;
            curr.crouched = me.crouched;
            copyLoadout(loadoutBefore, loadout);
            copyLoadout(loadout, me.loadout);
            copyKnifeState(knifeBefore, knife);
            copyKnifeState(knife, me.knife);
            const defender = me.team === 'defenders';
            for (let i = 0; i < pending.length; i++) {
                const c = pending[i];
                stepPlayer(curr, c, TICK_DT, boxes);
                if (!c.live) continue;
                if (defender) stepLoadout(loadout, c, c.armed);
                else stepKnife(knife, c.fire, c.armed);
            }
            if (defender && !sameLoadout(loadout, loadoutBefore)) gunMismatches++;
            if (!defender && !sameKnifeState(knife, knifeBefore)) knifeMismatches++;

            const ex = bx - curr.pos[0], ey = by - curr.pos[1], ez = bz - curr.pos[2];
            if (ex === 0 && ey === 0 && ez === 0) return;
            // Shift the interpolation base with the correction and absorb the jump into the
            // visual offset, so the camera does not move this frame and then eases over.
            prev.pos[0] -= ex; prev.pos[1] -= ey; prev.pos[2] -= ez;
            if (ex * ex + ey * ey + ez * ez < SNAP_DISTANCE * SNAP_DISTANCE) {
                errorOffset[0] += ex; errorOffset[1] += ey; errorOffset[2] += ez;
            }
        },
        spawn(pos: Vec3, yaw: number): void {
            copyPlayerState(curr, createPlayerState(pos));
            copyPlayerState(prev, curr);
            errorOffset[0] = errorOffset[1] = errorOffset[2] = 0;
            input.yaw = yaw;
            input.pitch = 0;
            alive = true;
            health = MAX_HEALTH;
            resetKnife(knife);
            resetLoadout(loadout);
            kickPitchPrev = kickYawPrev = kickPitch = kickYaw = 0;
            aimPrev = aimCurr = 0;
            stepAccum = 0;
        },
        shot(ev: ShotEvent): void {
            // Our own tracer was drawn the moment we fired; the server only tells us what it hit.
            if (ev.shooter !== net.id) {
                presenter.shot(ev.from, ev.to, false, ev.weapon ?? 0);
                audio.gunshot(ev.from, false, ev.weapon ?? 0);
                audio.impact(ev.to);
            } else if (ev.victim !== undefined) presenter.hitConfirm(ev.head === true, ev.killed === true);
            if (ev.victim === net.id) { presenter.damaged(ev.damage ?? 0); audio.hurt(); }
            if (ev.killed && ev.victim !== undefined) presenter.killFeed(ev.shooter, ev.victim, ev.head ? 'headshot' : 'shot');
        },
        slash(ev: SlashEvent): void {
            const hit = ev.victim !== undefined;
            // Our own swing already made its whoosh when it was predicted; only a confirmed hit adds to it.
            if (ev.attacker !== net.id) audio.knifeSlash(ev.pos, hit, false);
            else if (hit) { presenter.hitConfirm(ev.backstab === true, ev.killed === true); audio.knifeSlash(ev.pos, true, true); }
            if (ev.victim === net.id) { presenter.damaged(ev.damage ?? 0); audio.hurt(); }
            if (ev.killed && ev.victim !== undefined) presenter.killFeed(ev.attacker, ev.victim, ev.backstab ? 'backstab' : 'knife');
        },
        sound(ev: SoundEvent): void {
            if (ev.kind === 'step') audio.step(ev.pos, ev.loud, false);
            else if (ev.kind === 'reload') audio.reload(ev.pos, false, ev.weapon ?? 0);
            else audio.knifeWindup(ev.pos, false);
        },
        round(msg: RoundMsg): void {
            const was = match.phase;
            match.phase = msg.phase;
            match.round = msg.round;
            match.scoreGhosts = msg.score.ghosts;
            match.scoreDefenders = msg.score.defenders;
            match.bombPos = msg.bomb;
            match.winner = msg.winner ?? null;
            match.reason = msg.reason ?? null;
            match.matchOver = msg.matchOver === true;
            phaseEndsAt = msg.endsAt;
            if (msg.phase === was) return;
            if (msg.phase === 'live' && was === 'freeze') audio.cue('roundStart');
            else if (msg.phase === 'planted') audio.cue('planted');
            else if (msg.phase === 'over') {
                if (msg.reason === 'exploded') audio.cue('exploded');
                else if (msg.reason === 'defused') audio.cue('defused');
                // Let the bomb sound land before the verdict.
                const won = msg.winner === net.team;
                setTimeout(() => audio.cue(won ? 'win' : 'lose'), msg.reason === 'exploded' ? 1100 : 500);
            }
        },
        roster(players: RosterEntry[]): void {
            presenter.roster(players);
        }
    });

    // Browsers keep audio muted until the player interacts with the page.
    overlay.addEventListener('click', () => { audio.unlock(); input.lock(); });
    overlay.classList.toggle('hidden', input.locked);
    canvas.addEventListener('click', () => { audio.unlock(); input.lock(); });
    window.addEventListener('keydown', () => audio.unlock(), { once: true });
    document.addEventListener('pointerlockchange', () => overlay.classList.toggle('hidden', input.locked));
    status.textContent = 'Click to resume';

    const local: LocalView = {
        id: 0, team: 'ghosts', health: MAX_HEALTH, alive: false, respawnIn: 0, connected: false, ping: 0, firing: false, vis: 0,
        canAct: false, action: 0, showScores: false, weapon: 0, weapons: [] as WeaponSlotView[],
        mag: WEAPONS[0].magSize, magSize: WEAPONS[0].magSize, reserve: 0, reload: 0, spread: 0, draw: 0, aim: 0
    };
    const slotViews = local.weapons as WeaponSlotView[];
    for (let i = 0; i < WEAPON_COUNT; i++) slotViews.push({ mag: 0, reserve: 0 });
    const listener: ListenerView = { pos: [0, 0, 0], yaw: 0, pitch: 0, team: 'ghosts', alive: false };
    let accumulator = 0;
    let eye = EYE_HEIGHT;
    let fps = 60;
    let hudTimer = 0;

    // Adaptive resolution: integrated GPUs are fill-rate bound, so when frames run long the cheapest
    // fix is fewer pixels. Steps down quickly, and back up only after a long smooth stretch.
    let resScale = fixedRes > 0 ? Math.max(0.4, fixedRes) : 1;
    let slowTime = 0, smoothTime = 0, sinceStepUp = Infinity, stepUpWait = 12;
    const setRes = (scale: number): void => {
        resScale = Math.round(scale * 100) / 100;
        app.graphicsDevice.maxPixelRatio = resScale;
        app.resizeCanvas();
    };
    if (resScale < 1) setRes(resScale);
    const adaptResolution = (dt: number): void => {
        if (fixedRes > 0 || dt > 0.2) return; // pinned, or a stall (tab switch) rather than a slow GPU
        sinceStepUp += dt;
        slowTime = dt > 1 / 50 ? slowTime + dt : Math.max(0, slowTime - dt);
        smoothTime = dt < 1 / 57 ? smoothTime + dt : 0;
        if (slowTime > 1 && resScale > 0.5) {
            // Dropping straight after a step up means that step was too ambitious: wait longer next time.
            if (sinceStepUp < 5) stepUpWait = Math.min(stepUpWait * 2, 120);
            setRes(resScale - 0.1);
            slowTime = smoothTime = 0;
        } else if (smoothTime > stepUpWait && resScale < 1) {
            setRes(resScale + 0.1);
            smoothTime = 0;
            sinceStepUp = 0;
        }
    };

    const tick = (): void => {
        copyPlayerState(prev, curr);
        const cmd: PendingCmd = {
            seq: seq++, forward: 0, right: 0, yaw: 0, jump: false, walk: false, crouch: false,
            pitch: Math.fround(input.pitch), fire: input.fire, use: input.use, reload: input.reload,
            slot: 0, swap: false, aim: false,
            viewTime: net.renderTime(), live: alive, armed: false
        };
        input.sample(cmd);
        input.sampleWeapons(cmd, loadout.slot, WEAPON_COUNT);
        // Rooted during the freeze and while planting or defusing: the server applies the same rule,
        // and zeroing the command here keeps replays of it consistent.
        const acting = alive && cmd.use && canAct(net.team, match.phase, curr, mapData, match.bombPos);
        if (alive && movementLocked(cmd.use, net.team, match.phase, curr, mapData, match.bombPos)) {
            cmd.forward = 0;
            cmd.right = 0;
            cmd.jump = false;
        }
        cmd.armed = !acting && match.phase !== 'freeze';
        pending.push(cmd);
        if (pending.length > 120) pending.shift(); // server silent for 2 s: stop hoarding
        kickPitchPrev = kickPitch;
        kickYawPrev = kickYaw;
        aimPrev = aimCurr;
        if (alive) {
            const px = curr.pos[0], pz = curr.pos[2];
            stepPlayer(curr, cmd, TICK_DT, boxes);
            if (curr.onGround) {
                stepAccum += Math.hypot(curr.pos[0] - px, curr.pos[2] - pz);
                if (stepAccum >= STEP_DISTANCE) {
                    stepAccum -= STEP_DISTANCE;
                    audio.step(curr.pos, curr.crouched ? STEP_LOUD_CROUCH : cmd.walk ? STEP_LOUD_WALK : STEP_LOUD_RUN, true);
                }
            }
            // Attack timing follows the same rules as the server, counted in our own commands,
            // so the two never disagree about when a shot or swing happens.
            if (net.team === 'defenders') {
                // The same weapon step the server runs for this command (shared/gun.ts).
                const r = stepLoadout(loadout, cmd, cmd.armed);
                if (justSwitched(loadout)) audio.weaponSwitch(loadout.slot);
                if (r >= 0) {
                    eyePos[0] = curr.pos[0];
                    eyePos[1] = curr.pos[1] + (curr.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT);
                    eyePos[2] = curr.pos[2];
                    shotDirectionFor(loadout, curr, cmd.yaw, cmd.pitch, r, net.id, aim);
                    const dist = rayWorld(boxes, eyePos, aim, SHOT_RANGE);
                    shotEnd[0] = eyePos[0] + aim[0] * dist;
                    shotEnd[1] = eyePos[1] + aim[1] * dist;
                    shotEnd[2] = eyePos[2] + aim[2] * dist;
                    presenter.shot(eyePos, shotEnd, true, loadout.slot);
                    audio.gunshot(eyePos, true, loadout.slot);
                    audio.impact(shotEnd);
                } else if (r === GUN_RELOAD) audio.reload(curr.pos, true, loadout.slot);
                else if (r === GUN_DRY) audio.dryFire();
            } else {
                // The same knife step the server runs for this command (shared/knife.ts).
                const k = stepKnife(knife, cmd.fire, cmd.armed);
                if (k === KNIFE_SLASH) audio.knifeSlash(curr.pos, false, true);
                else if (k === KNIFE_SWING) {
                    presenter.knifeSwing(KNIFE_WINDUP_TICKS * TICK_DT);
                    audio.knifeWindup(curr.pos, true);
                }
            }
        }
        // The camera shows the recoil the next shot will carry, so the crosshair is honest. Taken
        // after any reconciliation, so it always follows the corrected gun state.
        const kicking = alive && net.team === 'defenders';
        const held = heldWeapon(loadout), scale = recoilScale(loadout);
        kickPitch = kicking ? recoilPitch(held, heldGun(loadout).burst) * scale : 0;
        kickYaw = kicking ? recoilYaw(held, heldGun(loadout).burst) * scale : 0;
        aimCurr = kicking ? aimFraction(loadout) : 0;
        net.send(cmd);
    };

    app.on('update', (dt: number) => {
        // Fixed-rate simulation, rendered with interpolation so motion is smooth at any frame rate.
        accumulator += Math.min(dt, 0.25);
        while (accumulator >= TICK_DT) {
            tick();
            accumulator -= TICK_DT;
        }
        const a = accumulator / TICK_DT;
        const decay = Math.exp(-12 * dt);
        errorOffset[0] *= decay; errorOffset[1] *= decay; errorOffset[2] *= decay;
        const eyeTarget = curr.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT;
        eye += (eyeTarget - eye) * (1 - Math.exp(-14 * dt));
        camera.setPosition(
            prev.pos[0] + (curr.pos[0] - prev.pos[0]) * a + errorOffset[0],
            prev.pos[1] + (curr.pos[1] - prev.pos[1]) * a + errorOffset[1] + eye,
            prev.pos[2] + (curr.pos[2] - prev.pos[2]) * a + errorOffset[2]
        );
        // Recoil is an offset on top of the view, never written into the view angles: commands carry
        // the player's own aim and the server adds the same pattern, so prediction is unaffected.
        const kp = kickPitchPrev + (kickPitch - kickPitchPrev) * a;
        const ky = kickYawPrev + (kickYaw - kickYawPrev) * a;
        camera.setEulerAngles(Math.max(-90, Math.min(90, (input.pitch + kp) / RAD)), (input.yaw + ky) / RAD, 0);
        // Aiming down sights narrows the view by the held weapon's zoom, and slows mouse look to match.
        const held = heldWeapon(loadout);
        const aimNow = aimPrev + (aimCurr - aimPrev) * a;
        const zoom = 1 + (held.adsZoom - 1) * aimNow;
        const fov = zoom === 1 ? BASE_FOV : (2 * Math.atan(TAN_HALF_FOV / zoom)) / RAD;
        if (camera.camera!.fov !== fov) camera.camera!.fov = fov;
        input.lookScale = 1 / zoom;

        local.id = net.id;
        local.team = net.team;
        local.health = health;
        local.alive = alive;
        local.respawnIn = alive || match.phase !== 'warmup' ? 0 : Math.max(0, (respawnAt - net.serverTime()) / 1000);
        local.canAct = alive && canAct(net.team, match.phase, curr, mapData, match.bombPos);
        local.action = action;
        local.showScores = input.scores;
        match.timeLeft = phaseEndsAt > 0 ? Math.max(0, (phaseEndsAt - net.serverTime()) / 1000) : 0;
        local.connected = net.connected;
        local.ping = net.ping;
        local.firing = alive && input.fire;
        local.vis = vis;
        const gun = heldGun(loadout);
        local.weapon = loadout.slot;
        for (let i = 0; i < WEAPON_COUNT; i++) {
            slotViews[i].mag = loadout.guns[i].mag;
            slotViews[i].reserve = loadout.guns[i].reserve;
        }
        local.mag = gun.mag;
        local.magSize = held.magSize;
        local.reserve = gun.reserve;
        local.reload = gun.reload > 0 ? 1 - gun.reload / held.reloadTicks : 0;
        local.spread = spreadAngle(curr, held, aimFraction(loadout));
        local.draw = loadout.draw / held.drawTicks;
        local.aim = aimNow;
        const remotes = net.interpolate();
        presenter.frame(dt, local, remotes, match);
        const eyeNow = camera.getPosition();
        listener.pos[0] = eyeNow.x; listener.pos[1] = eyeNow.y; listener.pos[2] = eyeNow.z;
        listener.yaw = input.yaw;
        listener.pitch = input.pitch;
        listener.team = net.team;
        listener.alive = alive;
        let bomb: BombView | null = null;
        if (match.phase === 'planted' && match.bombPos) {
            bombView.pos[0] = match.bombPos[0]; bombView.pos[1] = match.bombPos[1]; bombView.pos[2] = match.bombPos[2];
            bombView.timeLeft = match.timeLeft;
            bomb = bombView;
        }
        audio.frame(dt, listener, remotes, bomb);

        if (dt > 0) fps += (1 / dt - fps) * 0.05;
        adaptResolution(dt);
        hudTimer += dt;
        if (hudTimer >= 0.1) {
            hudTimer = 0;
            const p = curr.pos;
            hud.textContent =
                `${fps.toFixed(0)} fps${resScale < 1 ? `  res ${Math.round(resScale * 100)}%` : ''}${lagMs ? `  (+${lagMs} ms test lag)` : ''}\n` +
                `speed ${horizontalSpeed(curr).toFixed(2)} m/s${curr.onGround ? '' : ' (air)'}${curr.crouched ? ' (crouch)' : ''}\n` +
                `pos ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${p[2].toFixed(1)}`;
        }
    });

    // Handle for automated checks and console debugging.
    Object.assign(window, {
        __sb: {
            app, state: curr, input, net, mapData, mapList, audio, presenter, match,
            loadout, knife,
            stats: () => ({
                fps, resScale, alive, health, vis, pending: pending.length, error: Math.hypot(...errorOffset),
                loadout: structuredClone(loadout), gun: { ...heldGun(loadout) }, gunMismatches,
                knife: { ...knife }, knifeMismatches
            })
        }
    });
}

app.start();
start().catch(err => {
    console.error(err);
    status.textContent = String(err instanceof Error ? err.message : err);
});
