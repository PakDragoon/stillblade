import * as pc from 'playcanvas';
import {
    EYE_HEIGHT, EYE_HEIGHT_CROUCHED, KNIFE_WINDUP_TICKS, MAX_HEALTH,
    SHOT_RANGE, STEP_DISTANCE, STEP_LOUD_CROUCH, STEP_LOUD_RUN, STEP_LOUD_WALK, TICK_DT
} from '@shared/constants';
import {
    GUN_DRY, GUN_RELOAD, MELEE_SLASH, MELEE_SWING, aimFraction, copyLoadout, createLoadout, heldGun, heldWeapon,
    fillReserves, justSwitched, recoilPitch, recoilScale, recoilYaw, resetLoadout, sameLoadout, shotDirectionFor, spreadAngle, stepLoadout
} from '@shared/gun';
import { DEFENDER_KNIFE, GUN_COUNT, SLOT_COUNT, SLOT_KNIFE, WEAPONS, slotLabel } from '@shared/weapons';
import { DEFAULT_ROOM_OPTIONS, parseRoomOptions, roomOptionsQuery } from '@shared/room-options';
import type { RoomListEntry, RoomListResponse } from '@shared/room-list';
import {
    KNIFE_SLASH, KNIFE_SWING, copyKnifeState, createKnifeState, resetKnife, sameKnifeState, stepKnife
} from '@shared/knife';
import { copyPlayerState, createPlayerState, horizontalSpeed, stepPlayer } from '@shared/movement';
import {
    CARRY_DROPPED, CARRY_NONE, CARRY_PICKED, copyCarry, createCarry, resetCarry, restingPoint, sameCarry, stepCarry
} from '@shared/bomb';
import {
    DEFAULT_PORT, type BombMsg, type NetCmd, type RosterEntry, type RoundMsg, type SelfSnap, type ShotEvent, type SlashEvent,
    type SoundEvent
} from '@shared/protocol';
import { DEFAULT_MAP, isMapId, type MapListEntry } from '@shared/maps';
import { QUALITY_RES, SettingsStore } from './settings';
import { Radar } from './radar';
import { Ui, type JoinChoice } from './ui';
import { DEFUSE_TICKS, PLANT_TICKS, canAct, insideSite, movementLocked, type Phase } from '@shared/rules';
import { rayWorld } from '@shared/raycast';
import type { Box, MapData, Vec3 } from '@shared/types';
import { createAudio } from './audio';
import type { BombView, ListenerView } from './audio-api';
import { bindings, inputMatches, mouseInput } from './bindings';
import { Input } from './input';
import { applyMapLook } from './maplook';
import { Net } from './net';
import { isTouchOnly, showPhoneNotice } from './phone';
import { reporter } from './report';
import { createPresenter } from './presenter';
import type { LocalView, MatchView, RemoteView, WeaponSlotView } from './presenter-api';

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
    /** Holding the use key planted or defused on this command (the server decides the same: `canAct`). */
    acting: boolean;
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
// Errors, lost graphics contexts and feedback notes are reported from here on (client/src/report.ts).
reporter.configure(serverBase, canvas);
reporter.install();

/** How a refused or lost connection is explained to the player. */
function explainFailure(reason: string): { title: string; message: string } {
    const r = reason.toLowerCase();
    if (r.includes('removed')) return { title: 'Removed from this room', message: 'You were removed from this room. You cannot rejoin it for 10 minutes; you can join or make another room.' };
    if (r.includes('room full')) return { title: 'Room full', message: 'This room is full. Ask for another room code, or use Quick play.' };
    if (r.includes('unknown map')) return { title: 'Map not found', message: 'This server does not have the map in that link. Create a room and pick one of the listed maps.' };
    if (r.includes('server full')) return { title: 'Server busy', message: 'The server is at its room limit. Try again in a few minutes.' };
    if (r.includes('too many')) return { title: 'Too many connections', message: 'Close your other Stillblade tabs, then try again.' };
    if (r.includes('origin')) return { title: 'Not allowed', message: 'This server does not accept connections from this web page.' };
    return { title: 'Cannot reach the server', message: 'The game server did not answer. Check your connection; if it keeps failing, the server may be down.' };
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

/** A map in the scene: its gameplay data, and the way to take every part of it out again (a map change). */
interface LoadedMap {
    data: MapData;
    unload(): void;
}

/** Loads a map's collision/gameplay data and its baked visuals, and adds it to the scene. Can run again after `unload`. */
async function loadMap(id: string): Promise<LoadedMap> {
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
    let disposeLook: (() => void) | null = null;
    const unload = (): void => {
        disposeLook?.();
        mapEntity.destroy();
        app.assets.remove(mapAsset);
        mapAsset.unload();
    };
    // Baked maps draw unlit (albedo x baked light): no realtime lighting cost on the world at all.
    if (mapData.look) {
        try { disposeLook = await applyMapLook(app, mapEntity, camera, mapData, `${ASSETS}maps/`); } catch (err) { unload(); throw err; }
    }
    return { data: mapData, unload };
}

/** The public room list for the menu (`GET /rooms` on the game server, same address as the socket). */
async function fetchRooms(): Promise<RoomListEntry[]> {
    const r = await fetch(`${serverBase.replace(/^ws(s?):/, 'http$1:')}/rooms`);
    if (!r.ok) throw new Error(`room list: ${r.status}`);
    const d = await r.json() as RoomListResponse;
    return Array.isArray(d.rooms) ? d.rooms : [];
}

async function start(): Promise<void> {
    const mapList = await fetchMapList();
    const settings = new SettingsStore();
    const input = new Input(canvas);
    const presenter = createPresenter(app, camera);
    // Audio needs the map's boxes for occlusion; the array is filled once the room's map is known.
    const boxes: Box[] = [];
    const audio = createAudio(boxes);
    presenter.setWorld(boxes);
    const radar = new Radar(document.body);
    /** `?auto=1` skips the menu and the lobby panel; `?quiet=1` also stops the pause menu opening (for scripted checks). */
    const auto = params.has('auto');
    let net!: Net;
    let retryNow: (() => void) | null = null;
    /** Names by player id, for the death recap, spectating and kill feed. */
    const rosterNames = new Map<number, string>();

    const ui = new Ui(settings, {
        join: () => { /* resolved through showMenu */ },
        ready: ready => net?.sendMsg({ type: 'ready', ready }),
        start: () => net?.sendMsg({ type: 'start' }),
        switchTeam: () => net?.sendMsg({ type: 'team' }),
        chat: (text, team) => net?.sendMsg({ type: 'chat', team, text }),
        leave: () => { try { sessionStorage.removeItem('sb-rejoin'); } catch { /* fine */ } net?.close(); location.assign(location.pathname); },
        retry: () => retryNow?.(),
        backToMenu: () => { try { sessionStorage.removeItem('sb-rejoin'); } catch { /* fine */ } location.assign(location.pathname); },
        lock: () => { audio.unlock(); input.lock(); },
        unlock: () => document.exitPointerLock(),
        isLocked: () => input.locked,
        typing: on => { input.suspended = on; if (on) input.releaseAll(); },
        options: patch => net?.sendMsg({ type: 'options', options: patch }),
        voteKick: target => net?.sendMsg({ type: 'votekick', target }),
        castVote: yes => net?.sendMsg({ type: 'votecast', yes }),
        removePlayer: target => net?.sendMsg({ type: 'removeplayer', target }),
        mapVote: map => net?.sendMsg({ type: 'mapvote', map })
    });
    ui.quiet = auto || params.has('quiet');
    document.addEventListener('pointerlockchange', () => ui.onLockChange(input.locked));
    canvas.addEventListener('click', () => { audio.unlock(); if (!ui.cursorNeeded) input.lock(); });
    window.addEventListener('keydown', () => audio.unlock(), { once: true });

    // Who we are joining as: the page URL (auto), a reconnect after a drop, or the menu.
    let saved = '';
    try { saved = localStorage.getItem('sb-name') ?? ''; } catch { /* no remembered name */ }
    let choice: JoinChoice;
    let rejoin: JoinChoice | null = null;
    try { rejoin = JSON.parse(sessionStorage.getItem('sb-rejoin') ?? 'null') as JoinChoice | null; } catch { /* none */ }
    // ?auto=1 also takes the creation options from the page address (public=1&max=4&rounds=3&suppressed=1) and quick=1.
    if (auto) {
        choice = { name: params.get('name') ?? saved, room: params.get('room') ?? '', map: params.get('map') ?? '', options: parseRoomOptions(params), quick: params.get('quick') === '1' };
        if (params.get('practice') === '1') choice.practice = params.get('side') === 'ghosts' ? 'ghosts' : 'defenders';
    }
    else if (rejoin && typeof rejoin.room === 'string') choice = rejoin;
    else {
        const wanted = params.get('map') ?? '';
        choice = await ui.showMenu(mapList, {
            name: params.get('name') ?? saved, room: params.get('room') ?? '',
            map: mapList.some(m => m.id === wanted) ? wanted : DEFAULT_MAP
        }, fetchRooms);
        // An invite link's map is only a request for a new room; a joiner takes the room's own.
        if (params.get('room') && choice.room === params.get('room')!.trim()) choice.map = wanted;
    }
    audio.unlock();
    const query = new URLSearchParams();
    if (choice.room) query.set('room', choice.room);
    if (choice.name) query.set('name', choice.name);
    if (choice.map) query.set('map', choice.map);
    // Options only matter when this join creates the room; an existing room keeps its own. Quick play (no room code)
    // asks the server for the fullest public room with space.
    if (choice.quick && !choice.room) query.set('quick', '1');
    // The practice range: the server makes a private room of our own on the chosen map (a reconnect makes a new one).
    if (choice.practice) { query.set('practice', '1'); query.set('side', choice.practice); query.delete('room'); }
    roomOptionsQuery(choice.options ?? DEFAULT_ROOM_OPTIONS, query);
    const serverUrl = `${serverBase}/?${query}`;

    // The room decides the map: connect, learn it from the welcome, load it, then start simulating.
    // A refused join shows why, with a button to try again.
    let welcome: Awaited<Net['welcome']>;
    for (;;) {
        ui.showLoading('Connecting', 'Looking for the game server');
        net = new Net(serverUrl, lagMs);
        reporter.setSocket(msg => { if (!net.isOpen) return false; net.sendMsg(msg); return true; });
        try {
            welcome = await net.welcome;
            break;
        } catch (err) {
            const f = explainFailure(err instanceof Error ? err.message : String(err));
            ui.showError(f.title, f.message);
            await new Promise<void>(resolve => { retryNow = resolve; });
        }
    }
    try { sessionStorage.removeItem('sb-rejoin-tried'); } catch { /* fine */ }
    ui.showLoading(welcome.mapName, 'Downloading the map');
    /** The room's map as it is now: it changes between matches (the map vote). */
    let loaded: LoadedMap;
    let mapData: MapData;
    let mapId = welcome.map;
    const roomCode = welcome.room || choice.room || 'public';
    try {
        loaded = await loadMap(welcome.map);
        mapData = loaded.data;
    } catch (err) {
        console.error(err);
        ui.showError('Could not load the map', `${welcome.mapName} failed to download. Check your connection and try again.`, false);
        return;
    }
    boxes.push(...mapData.boxes);
    radar.setMap(mapData);
    // A dropped connection gets one automatic reconnect to the same room, then asks.
    net.onClose = (code, reason) => {
        console.warn(`connection closed: ${code} ${reason}`);
        if (code === 4001) { // removed by a vote or by the room's creator: no reconnecting
            try { sessionStorage.removeItem('sb-rejoin'); } catch { /* fine */ }
            ui.showError('Removed from the room', reason || 'You were removed from this room. You cannot rejoin it for 10 minutes.', false);
            return;
        }
        let tried = false;
        try { tried = sessionStorage.getItem('sb-rejoin-tried') === '1'; } catch { /* treat as untried */ }
        if (tried) {
            ui.showError('Connection lost', 'The connection to the server ended and reconnecting did not work.');
            retryNow = () => { location.reload(); };
            return;
        }
        ui.showLoading('Connection lost', 'Reconnecting to the same room');
        try {
            sessionStorage.setItem('sb-rejoin-tried', '1');
            sessionStorage.setItem('sb-rejoin', JSON.stringify({ ...choice, room: roomCode, quick: false, map: mapId }));
        } catch { /* nothing to resume from */ }
        setTimeout(() => location.reload(), 800);
    };
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
    /** Predicted defender weapons (both guns, the knife, switch, aim, trigger), reconciled and replayed with movement. */
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
    /**
     * The bomb, predicted like the weapons (shared/bomb.ts): whether we carry it and the repick wait,
     * stepped for every command we simulate and replayed from each snapshot. `droppedPred` is where we
     * believe a dropped bomb lies right now (our own predicted drop or pickup applied); `serverDropped`
     * is the last position the server told us.
     */
    const carry = createCarry();
    const carryBefore = createCarry();
    let droppedPred: Vec3 | null = null;
    let serverDropped: Vec3 | null = null;
    const droppedBuf: Vec3 = [0, 0, 0];
    const lastGround: Vec3 = [0, 0, 0];
    /** Who carries the bomb (ghosts are told; 0 for nobody, always 0 for defenders). */
    let carrierId = 0;
    /**
     * Commands spent planting or defusing, exactly as the server counts them, so we predict the command a
     * plant or defuse completes and stop rooting ourselves from then on (`phaseOverride` stands in for the
     * round message still on its way).
     */
    let actionTicks = 0;
    let actionBefore = 0;
    let phaseOverride: Phase | null = null;
    /** Snapshots whose replayed bomb carry or plant count differed from the prediction (should stay 0). */
    let bombMismatches = 0;
    let stepAccum = 0;
    /** The local reload was shown last frame (to cut its sound off when it stops early). */
    let reloadingShown = false;
    let vis = 0;
    let action = 0;
    /** Server time (ms) the current phase ends; 0 in warmup. */
    let phaseEndsAt = 0;
    const match: MatchView = {
        phase: 'warmup', timeLeft: 0, round: 1, scoreGhosts: 0, scoreDefenders: 0, bombPos: null, droppedBomb: null, carrierId: 0,
        winner: null, reason: null, matchOver: false, roundsToWin: welcome.options.roundsToWin
    };
    const bombView: BombView = { pos: [0, 0, 0], timeLeft: 0 };
    let alive = false;
    let health = MAX_HEALTH;
    let respawnAt = 0;

    const eyePos: Vec3 = [0, 0, 0];
    const aim: Vec3 = [0, 0, 0];
    const shotEnd: Vec3 = [0, 0, 0];
    /** The room's suppressed-weapons option, from the welcome; the creator may change it in warmup. */
    let suppressed = welcome.options.suppressed;
    /** A practice range: the server keeps reserves full, so prediction does too (shared/gun.ts fillReserves). */
    const practice = welcome.practice;
    presenter.setSuppressed(suppressed);
    /** The scoreboard's vote-out buttons exist only while a vote can be called (three or more people, none running). */
    const callVoteKick = (id: number): void => net.sendMsg({ type: 'votekick', target: id });
    const syncVoteKick = (): void => presenter.setVoteKick(ui.canVoteKick ? callVoteKick : null);

    /**
     * The plant or defuse counter and the bomb carry for one simulated command, in the server's order
     * (`Game.handleCmd`: the carry step, then the plant or defuse count). Used by prediction and replay.
     */
    const stepObjective = (c: PendingCmd, ghost: boolean): number => {
        let r = CARRY_NONE;
        if (ghost) {
            if (curr.onGround) { lastGround[0] = curr.pos[0]; lastGround[1] = curr.pos[1]; lastGround[2] = curr.pos[2]; }
            r = stepCarry(carry, c.drop, c.acting, curr, droppedPred);
            if (r === CARRY_DROPPED) droppedPred = restingPoint(curr, boxes, lastGround, droppedBuf);
            else if (r === CARRY_PICKED) droppedPred = null;
        }
        if (!c.acting) actionTicks = 0;
        else if (++actionTicks >= (ghost ? PLANT_TICKS : DEFUSE_TICKS)) {
            actionTicks = 0;
            // Planted (nobody carries it any more) or defused (the round is over): no more rooting.
            if (ghost) carry.carrier = false;
            phaseOverride = ghost ? 'planted' : 'over';
        }
        return r;
    };

    // Map bounds for the overhead spectator camera; measured again whenever the map changes.
    let mapCx = 0, mapCz = 0, mapW = 1, mapD = 1;
    const measureMap = (): void => {
        mapCx = (mapData.bounds.min[0] + mapData.bounds.max[0]) / 2;
        mapCz = (mapData.bounds.min[2] + mapData.bounds.max[2]) / 2;
        mapW = mapData.bounds.max[0] - mapData.bounds.min[0];
        mapD = mapData.bounds.max[2] - mapData.bounds.min[2];
    };
    measureMap();

    /**
     * The room moved to another map between matches. Net holds every later message until this resolves, and
     * nobody is alive in between, so no command is predicted against the old map after this runs: `alive` is
     * dropped first, and the collision boxes the prediction and the audio read are replaced only once the new
     * map is in. Falls back to rejoining the room (which welcomes us onto the new map) if the download fails.
     */
    const swapMap = async (id: string, name: string): Promise<void> => {
        alive = false;
        pending.length = 0;
        ui.setMapStatus(`Downloading ${name}…`);
        try {
            const next = await loadMap(id);
            const old = loaded;
            loaded = next;
            mapData = next.data;
            mapId = id;
            boxes.length = 0;
            boxes.push(...mapData.boxes);
            radar.setMap(mapData);
            measureMap();
            old.unload();
            reporter.mapName = name;
            ui.setMap(id, name);
            ui.setMapStatus(`${name} is ready.`);
        } catch (err) {
            console.error(err);
            try { sessionStorage.setItem('sb-rejoin', JSON.stringify({ ...choice, room: roomCode, quick: false, map: id })); } catch { /* nothing to resume from */ }
            location.reload();
        }
    };

    net.start({
        snapshot(me: SelfSnap, ack: number): void {
            health = me.health;
            alive = me.alive;
            respawnAt = me.respawnAt;
            vis = me.vis;
            action = me.actionTicks / (me.team === 'ghosts' ? PLANT_TICKS : DEFUSE_TICKS);
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
            copyCarry(carryBefore, carry);
            copyCarry(carry, me.carry);
            actionBefore = actionTicks;
            actionTicks = me.actionTicks;
            droppedPred = serverDropped;
            phaseOverride = null;
            const defender = me.team === 'defenders';
            for (let i = 0; i < pending.length; i++) {
                const c = pending[i];
                stepPlayer(curr, c, TICK_DT, boxes);
                if (!c.live) continue;
                if (defender) {
                    stepLoadout(loadout, c, c.armed);
                    if (practice) fillReserves(loadout); // as the server does in a practice range
                }
                else stepKnife(knife, c.fire, c.armed);
                stepObjective(c, !defender);
            }
            if (defender && !sameLoadout(loadout, loadoutBefore)) gunMismatches++;
            if (!sameCarry(carry, carryBefore) || actionTicks !== actionBefore) bombMismatches++;
            // Knife timing: the ghost's own, or the defender knife inside the loadout (also counted above).
            if (defender ? !sameKnifeState(loadout.knife, loadoutBefore.knife) : !sameKnifeState(knife, knifeBefore)) knifeMismatches++;

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
            input.clearToggles(); // a new life starts standing and not aiming
            alive = true;
            health = MAX_HEALTH;
            resetKnife(knife);
            resetLoadout(loadout);
            // The server resets the carry at every spawn and hands the bomb out just after (snapshot and `bomb`).
            resetCarry(carry);
            actionTicks = 0;
            phaseOverride = null;
            lastGround[0] = pos[0]; lastGround[1] = pos[1]; lastGround[2] = pos[2];
            kickPitchPrev = kickYawPrev = kickPitch = kickYaw = 0;
            aimPrev = aimCurr = 0;
            stepAccum = 0;
        },
        shot(ev: ShotEvent): void {
            // Our own tracer was drawn the moment we fired; the server only tells us what it hit.
            // A shot out of earshot but in sight arrives `silent`: seen, not heard.
            if (ev.shooter !== net.id) {
                presenter.shot(ev.from, ev.to, false, ev.weapon ?? 0);
                if (!ev.silent) {
                    audio.gunshot(ev.from, false, ev.weapon ?? 0, suppressed);
                    audio.impact(ev.to);
                }
            }
        },
        slash(ev: SlashEvent): void {
            const hit = ev.victim !== undefined;
            // Our own swing already made its whoosh when it was predicted; only a confirmed hit adds to it.
            if (ev.attacker !== net.id) {
                audio.knifeSlash(ev.pos, hit, false);
                presenter.remoteSlash(ev.attacker);
            } else if (hit) audio.knifeSlash(ev.pos, true, true);
        },
        kill(ev): void {
            presenter.killFeed(ev.killer, ev.victim, ev.kind, ev.zone ?? null,
                ev.weapon !== undefined ? WEAPONS[ev.weapon]?.label : ev.kind === 'shot' ? undefined : DEFENDER_KNIFE.label);
        },
        sound(ev: SoundEvent): void {
            if (ev.kind === 'step') audio.step(ev.pos, ev.loud, false);
            else if (ev.kind === 'reload') audio.reload(ev.pos, false, ev.weapon ?? 0, ev.id);
            else if (ev.kind === 'bombDrop') audio.bomb('drop', ev.pos, false);
            else if (ev.kind === 'bombPickup') audio.bomb('pickup', ev.pos, false);
            else {
                audio.knifeWindup(ev.pos, false);
                presenter.remoteSwing(ev.id);
            }
        },
        round(msg: RoundMsg): void {
            const was = match.phase;
            match.phase = msg.phase;
            match.round = msg.round;
            match.scoreGhosts = msg.score.ghosts;
            match.scoreDefenders = msg.score.defenders;
            match.bombPos = msg.bomb;
            phaseOverride = null; // the server's own word on the phase has arrived
            match.winner = msg.winner ?? null;
            match.reason = msg.reason ?? null;
            match.matchOver = msg.matchOver === true;
            phaseEndsAt = msg.endsAt;
            ui.setPhase(msg.phase);
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
            rosterNames.clear();
            for (const p of players) rosterNames.set(p.id, p.name);
            ui.setRoster(players, net.id);
            syncVoteKick();
        },
        summary(msg): void { ui.showSummary(msg, net.id); },
        chat(msg): void { ui.chat(msg, alive, match.phase === 'freeze' || match.phase === 'live' || match.phase === 'planted'); },
        notice(text): void { ui.note(text); },
        damage(msg): void {
            presenter.damaged(msg.amount, msg.dir);
            audio.hurt();
            if (msg.killed) {
                presenter.died(rosterNames.get(msg.by ?? -1) ?? 'Someone', msg.kind, msg.zone ?? null, msg.dist ?? 0,
                    msg.weapon !== undefined ? WEAPONS[msg.weapon]?.label : msg.kind === 'shot' ? undefined : DEFENDER_KNIFE.label);
            }
        },
        hitConfirm(msg): void {
            presenter.hitConfirm(msg.zone ?? null, msg.kill);
            if (practice) ui.practiceHit(msg.damage, msg.kind, msg.zone ?? null, msg.kill);
            audio.hitMarker(msg.kill ? 'kill' : msg.zone === 'head' ? 'head' : 'body');
        },
        bomb(msg: BombMsg): void {
            serverDropped = msg.dropped ? [msg.dropped[0], msg.dropped[1], msg.dropped[2]] : null;
            // Ghosts are told who carries it; a defender never gets `carrier`.
            carrierId = msg.carrier ?? 0;
            // Handing out the bomb at the round start, and clearing it (warmup, plant), happen outside any
            // command, like a spawn: take them as they come (the next snapshot agrees).
            if (msg.carrier !== undefined && (msg.event === undefined || msg.event === 'assign')) carry.carrier = msg.carrier === net.id;
            // A drop or pickup we already predicted ourselves is reconciled by the next snapshot; anything
            // else (a teammate's drop or pickup, a reset) applies now.
            if (!carry.carrier) droppedPred = serverDropped;
            if (msg.event && msg.by !== undefined) {
                const me = msg.by === net.id;
                const who = rosterNames.get(msg.by) ?? `Player ${msg.by}`;
                const text = msg.event === 'assign' ? (me ? 'You have the bomb' : `${who} has the bomb`)
                    : msg.event === 'pickup' ? (me ? 'You picked up the bomb' : `${who} picked up the bomb`)
                    : msg.event === 'drop' ? (me ? 'You dropped the bomb' : `${who} dropped the bomb`)
                    : me ? 'You lost the bomb' : `Bomb dropped: ${who} lost it`;
                if (msg.event !== 'assign' || msg.by !== 0) presenter.bombNotice(text);
            }
        },
        options(o): void {
            suppressed = o.suppressed;
            match.roundsToWin = o.roundsToWin;
            presenter.setSuppressed(o.suppressed);
            ui.setOptions(o);
        },
        kickVote(msg): void { ui.setKickVote(msg.vote, net.serverTime()); syncVoteKick(); },
        mapVote(msg): void { ui.setMapVote(msg); },
        map(msg): Promise<void> { return swapMap(msg.map, msg.mapName); }
    });
    reporter.mapName = welcome.mapName;
    ui.enterGame(roomCode, welcome.map, welcome.mapName, welcome.options, welcome.practice);

    const local: LocalView = {
        id: 0, team: 'ghosts', health: MAX_HEALTH, alive: false, respawnIn: 0, connected: false, ping: 0, firing: false, vis: 0,
        canAct: false, carrier: false, siteNoBomb: false, action: 0, showScores: false, weapon: 0, weapons: [] as WeaponSlotView[],
        mag: WEAPONS[0].magSize, magSize: WEAPONS[0].magSize, reserve: 0, reload: 0, spread: 0, draw: 0, aim: 0,
        yaw: 0, spectating: null, spectateId: -1, overview: false
    };
    const slotViews = local.weapons as WeaponSlotView[];
    for (let i = 0; i < SLOT_COUNT; i++) slotViews.push({ mag: 0, reserve: 0 });
    const listener: ListenerView = { pos: [0, 0, 0], yaw: 0, pitch: 0, team: 'ghosts', alive: false };
    let accumulator = 0;
    let eye = EYE_HEIGHT;
    let fps = 60;
    let hudTimer = 0;
    /** Spectating: the teammate being followed (by id), and a queued left/right press. */
    let specId = -1;
    let specStep = 0;
    const radarSubject: { pos: Vec3; yaw: number; team: 'ghosts' | 'defenders' } = { pos: [0, 0, 0], yaw: 0, team: 'ghosts' };
    const specInput = (code: string): void => {
        if (inputMatches(bindings().value, 'specPrev', code)) specStep = -1;
        else if (inputMatches(bindings().value, 'specNext', code)) specStep = 1;
    };
    window.addEventListener('keydown', e => { if (!input.suspended && !e.repeat) specInput(e.code); });
    document.addEventListener('mousedown', e => { const c = mouseInput(e.button); if (c && !input.suspended && input.locked) specInput(c); });
    /** Picks the living teammate to follow; returns null when there is none (map overview). Teammates only, never enemies. */
    const pickSpectated = (remotes: readonly RemoteView[]): RemoteView | null => {
        let first: RemoteView | null = null, cur: RemoteView | null = null, next: RemoteView | null = null, prev: RemoteView | null = null;
        for (const r of remotes) {
            if (r.team !== net.team || !r.alive) continue;
            if (!first || r.id < first.id) first = r;
            if (r.id === specId) cur = r;
        }
        if (!first) return null;
        if (specStep !== 0 && cur) {
            for (const r of remotes) {
                if (r.team !== net.team || !r.alive || r.id === cur.id) continue;
                if (r.id > cur.id && (!next || r.id < next.id)) next = r;
                if (r.id < cur.id && (!prev || r.id > prev.id)) prev = r;
            }
            let last: RemoteView | null = null;
            for (const r of remotes) if (r.team === net.team && r.alive && (!last || r.id > last.id)) last = r;
            cur = specStep > 0 ? next ?? first : prev ?? last;
        }
        specStep = 0;
        cur ??= first;
        specId = cur!.id;
        return cur;
    };

    // Adaptive resolution: integrated GPUs are fill-rate bound, so when frames run long the cheapest
    // fix is fewer pixels. Steps down quickly, and back up only after a long smooth stretch.
    /** The graphics setting caps the adaptive step; `?res=` overrides everything. */
    let resCap = 1;
    let resScale = fixedRes > 0 ? Math.max(0.4, fixedRes) : 1;
    let slowTime = 0, smoothTime = 0, sinceStepUp = Infinity, stepUpWait = 12;
    const setRes = (scale: number): void => {
        resScale = Math.round(scale * 100) / 100;
        app.graphicsDevice.maxPixelRatio = resScale;
        app.resizeCanvas();
    };
    if (resScale < 1) setRes(resScale);
    reporter.setLive(() => ({ fps, renderScale: resScale, ping: net.ping }));
    settings.watch(st => {
        input.sensitivity = st.sensitivity;
        input.invertY = st.invertY;
        input.setModes(st.crouchToggle, st.walkToggle, st.aimToggle, st.aimSensitivity);
        camera.camera!.fov = st.fov;
        audio.setVolumes({ master: st.master, effects: st.effects, footsteps: st.footsteps });
        presenter.setCrosshair({ style: st.crosshairStyle, color: st.crosshairColor, size: st.crosshairSize });
        ui.applySettingsToPage(st);
        resCap = QUALITY_RES[st.quality];
        if (fixedRes === 0 && resScale > resCap) setRes(resCap);
        else if (fixedRes === 0 && st.quality === 'high' && resScale < 1) { /* adaptive step-up takes it back */ }
    });
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
        } else if (smoothTime > stepUpWait && resScale < resCap) {
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
            slot: 0, swap: false, aim: false, drop: false,
            viewTime: net.renderTime(), live: alive, armed: false, acting: false
        };
        input.sample(cmd);
        input.sampleWeapons(cmd, loadout.slot, SLOT_COUNT);
        cmd.drop = input.takeDrop();
        // Rooted during the freeze and while planting or defusing: the server applies the same rule,
        // and zeroing the command here keeps replays of it consistent. Only the carrier can plant, and a
        // plant or defuse we predict has completed stops the rooting before the round message arrives.
        const phase = phaseOverride ?? match.phase;
        const acting = alive && cmd.use && canAct(net.team, phase, curr, mapData, match.bombPos, carry.carrier);
        if (alive && movementLocked(cmd.use, net.team, phase, curr, mapData, match.bombPos, carry.carrier)) {
            cmd.forward = 0;
            cmd.right = 0;
            cmd.jump = false;
        }
        cmd.armed = !acting && phase !== 'freeze';
        cmd.acting = acting;
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
                if (practice) fillReserves(loadout); // as the server does in a practice range
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
                    audio.gunshot(eyePos, true, loadout.slot, suppressed);
                    audio.impact(shotEnd);
                } else if (r === GUN_RELOAD) audio.reload(curr.pos, true, loadout.slot, net.id);
                else if (r === GUN_DRY) audio.dryFire();
                // The defender knife: the same windup and landing as the ghosts' (only the damage differs).
                else if (r === MELEE_SWING) {
                    presenter.knifeSwing(DEFENDER_KNIFE.windupTicks * TICK_DT);
                    audio.knifeWindup(curr.pos, true);
                } else if (r === MELEE_SLASH) audio.knifeSlash(curr.pos, false, true);
            } else {
                // The same knife step the server runs for this command (shared/knife.ts).
                const k = stepKnife(knife, cmd.fire, cmd.armed);
                if (k === KNIFE_SLASH) audio.knifeSlash(curr.pos, false, true);
                else if (k === KNIFE_SWING) {
                    presenter.knifeSwing(KNIFE_WINDUP_TICKS * TICK_DT);
                    audio.knifeWindup(curr.pos, true);
                }
            }
            // The bomb and the plant or defuse count, as the server will step them for this command.
            const b = stepObjective(cmd, net.team === 'ghosts');
            if (b === CARRY_DROPPED) audio.bomb('drop', curr.pos, true);
            else if (b === CARRY_PICKED) audio.bomb('pickup', curr.pos, true);
        }
        // The camera shows the recoil the next shot will carry, so the crosshair is honest. Taken
        // after any reconciliation, so it always follows the corrected gun state.
        const held = heldWeapon(loadout), heldState = heldGun(loadout), scale = recoilScale(loadout);
        const kicking = alive && net.team === 'defenders' && held !== null && heldState !== null;
        kickPitch = kicking ? recoilPitch(held, heldState.burst) * scale : 0;
        kickYaw = kicking ? recoilYaw(held, heldState.burst) * scale : 0;
        aimCurr = kicking ? aimFraction(loadout) : 0;
        net.send(cmd);
    };

    app.on('update', (dt: number) => {
        // A panel, the pause menu or the chat box owns the keyboard and mouse: no weapon keys, buttons or wheel reach the game.
        if (ui.cursorNeeded !== input.suspended) { input.suspended = ui.cursorNeeded; if (input.suspended) input.releaseAll(); }
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
        const zoom = held ? 1 + (held.adsZoom - 1) * aimNow : 1;
        const fov = zoom === 1 ? BASE_FOV : (2 * Math.atan(TAN_HALF_FOV / zoom)) / RAD;
        if (camera.camera!.fov !== fov) camera.camera!.fov = fov;
        input.lookScale = 1 / zoom;

        local.id = net.id;
        local.team = net.team;
        local.health = health;
        local.alive = alive;
        local.respawnIn = alive || match.phase !== 'warmup' ? 0 : Math.max(0, (respawnAt - net.serverTime()) / 1000);
        const ghostHere = net.team === 'ghosts';
        if (!ghostHere) carrierId = 0; // a side swap: defenders are never told who carries it
        const shownCarry = alive && ghostHere && carry.carrier;
        const phaseNow = phaseOverride ?? match.phase;
        local.canAct = alive && canAct(net.team, phaseNow, curr, mapData, match.bombPos, carry.carrier);
        local.carrier = shownCarry;
        local.siteNoBomb = alive && ghostHere && !carry.carrier && phaseNow === 'live' && curr.onGround && insideSite(curr.pos, mapData);
        // Ghosts see our own predicted drop or pickup at once; defenders only what the server showed them.
        match.droppedBomb = ghostHere ? droppedPred : serverDropped;
        // Our own pickup shows straight away; the server's word follows in a moment.
        match.carrierId = !ghostHere ? 0 : shownCarry ? net.id : carrierId === net.id && !carry.carrier ? 0 : carrierId;
        local.action = action;
        local.showScores = input.scores;
        match.timeLeft = phaseEndsAt > 0 ? Math.max(0, (phaseEndsAt - net.serverTime()) / 1000) : 0;
        local.connected = net.connected;
        local.ping = net.ping;
        local.firing = alive && input.fire;
        local.vis = vis;
        const gun = heldGun(loadout);
        local.weapon = loadout.slot;
        for (let i = 0; i < GUN_COUNT; i++) {
            slotViews[i].mag = loadout.guns[i].mag;
            slotViews[i].reserve = loadout.guns[i].reserve;
        }
        // The knife slot (SLOT_KNIFE) keeps mag and reserve at 0: it has no ammunition.
        local.mag = gun ? gun.mag : 0;
        local.magSize = held ? held.magSize : 0;
        local.reserve = gun ? gun.reserve : 0;
        local.reload = gun && held && gun.reload > 0 ? 1 - gun.reload / held.reloadTicks : 0;
        // A reload that stops early (switch, death, round reset) cuts its sound off; one that completes does not.
        const reloadingNow = alive && local.reload > 0;
        if (reloadingShown && !reloadingNow) audio.cancelReload(net.id);
        reloadingShown = reloadingNow;
        local.spread = held ? spreadAngle(curr, held, aimFraction(loadout)) : 0;
        local.draw = loadout.draw / (held ? held.drawTicks : DEFENDER_KNIFE.drawTicks);
        local.aim = aimNow;
        const remotes = net.interpolate();
        // Dead in a round: follow a living teammate in first person, or look at the whole map.
        let followed: RemoteView | null = null;
        const spectating = !alive && match.phase !== 'warmup' && net.connected;
        if (spectating) {
            followed = pickSpectated(remotes);
            if (followed) {
                camera.setPosition(followed.pos[0], followed.pos[1] + (followed.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT), followed.pos[2]);
                camera.setEulerAngles(followed.pitch / RAD, followed.yaw / RAD, 0);
            } else {
                const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
                const height = Math.max(mapD, mapW / aspect) / (2 * Math.tan((settings.value.fov / 2) * RAD)) * 1.08 + mapData.bounds.max[1];
                camera.setPosition(mapCx, height, mapCz);
                camera.setEulerAngles(-90, 0, 0);
            }
        } else specId = -1;
        local.spectating = followed ? (rosterNames.get(followed.id) ?? `Player ${followed.id}`) : null;
        local.spectateId = followed ? followed.id : -1;
        local.overview = spectating && !followed;
        local.yaw = followed ? followed.yaw : input.yaw;
        presenter.frame(dt, local, remotes, match);
        const eyeNow = camera.getPosition();
        listener.pos[0] = eyeNow.x; listener.pos[1] = eyeNow.y; listener.pos[2] = eyeNow.z;
        listener.yaw = local.yaw;
        listener.pitch = followed ? followed.pitch : input.pitch;
        const subject = followed ? followed.pos : curr.pos;
        radarSubject.pos[0] = subject[0]; radarSubject.pos[1] = subject[1]; radarSubject.pos[2] = subject[2];
        radarSubject.yaw = local.yaw;
        radarSubject.team = net.team;
        radar.update(dt, radarSubject, remotes, match.phase === 'planted' ? match.bombPos : null, match.droppedBomb);
        ui.tick(net.serverTime());
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
            app, state: curr, input, net, mapList, audio, presenter, match, ui,
            loadout, knife,
            stats: () => ({
                fps, resScale, alive, health, vis, pending: pending.length, error: Math.hypot(...errorOffset),
                loadout: structuredClone(loadout), gun: heldGun(loadout) ? { ...heldGun(loadout)! } : null,
                held: slotLabel(loadout.slot), knifeSlot: SLOT_KNIFE, gunMismatches,
                knife: { ...knife }, knifeMismatches,
                carry: { ...carry }, carrierId, dropped: droppedPred ? [...droppedPred] : null,
                serverDropped: serverDropped ? [...serverDropped] : null, actionTicks, bombMismatches
            })
        }
    });
    // The room's map changes between matches, so `__sb.mapData` follows it.
    Object.defineProperty((window as unknown as { __sb: object }).__sb, 'mapData', { get: () => mapData, configurable: true });
}

/** A touch device with no mouse is told so before the map, the models or the socket are touched (`?desktop=1` skips it). */
const phone = isTouchOnly(window.matchMedia?.bind(window)) && !params.has('desktop') ? showPhoneNotice(location.href) : Promise.resolve();
phone.then(() => {
    app.start();
    return start();
}).catch(err => {
    console.error(err);
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#ff8a7a;font:16px system-ui;padding:24px;text-align:center';
    box.textContent = `Stillblade could not start: ${err instanceof Error ? err.message : String(err)}`;
    document.body.appendChild(box);
});
