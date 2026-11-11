import * as pc from 'playcanvas';
import {
    EYE_HEIGHT, EYE_HEIGHT_CROUCHED, FIRE_INTERVAL_TICKS, KNIFE_COOLDOWN_TICKS, KNIFE_WINDUP_TICKS, MAX_HEALTH,
    SHOT_RANGE, STEP_DISTANCE, STEP_LOUD_CROUCH, STEP_LOUD_RUN, STEP_LOUD_WALK, TICK_DT
} from '@shared/constants';
import { copyPlayerState, createPlayerState, horizontalSpeed, stepPlayer } from '@shared/movement';
import {
    DEFAULT_PORT, type NetCmd, type RosterEntry, type RoundMsg, type SelfSnap, type ShotEvent, type SlashEvent,
    type SoundEvent
} from '@shared/protocol';
import { canAct, movementLocked } from '@shared/rules';
import { rayWorld, viewDir } from '@shared/raycast';
import type { MapData, Vec3 } from '@shared/types';
import { createAudio } from './audio';
import type { BombView, ListenerView } from './audio-api';
import { Input } from './input';
import { applyBakedLighting } from './maplook';
import { Net } from './net';
import { createPresenter } from './presenter';
import type { LocalView, MatchView } from './presenter-api';

const MAP = 'greybox';
const RAD = Math.PI / 180;
/** Prediction errors larger than this are teleports (respawn), not drift: snap instead of smoothing. */
const SNAP_DISTANCE = 2;

const params = new URLSearchParams(location.search);
const serverBase = params.get('server') ?? `ws://${location.hostname}:${DEFAULT_PORT}`;
/** `?lag=150` adds 150 ms of artificial round-trip latency. */
const lagMs = Math.max(0, Number(params.get('lag')) || 0);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const overlay = document.getElementById('overlay')!;
const status = document.getElementById('status')!;
const menu = document.getElementById('menu') as HTMLFormElement;
const nameInput = document.getElementById('name') as HTMLInputElement;
const roomInput = document.getElementById('room') as HTMLInputElement;

/** Shows the name and room form and resolves when the player presses Play. `?auto=1` skips it. */
function askToJoin(onGesture: () => void): Promise<{ name: string; room: string }> {
    let saved = '';
    try { saved = localStorage.getItem('sb-name') ?? ''; } catch { /* storage unavailable: no remembered name */ }
    nameInput.value = params.get('name') ?? saved;
    roomInput.value = params.get('room') ?? '';
    const read = () => ({ name: nameInput.value.trim(), room: roomInput.value.trim() });
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

// Greybox lighting only; real maps will be lightmapped with no realtime lights.
app.scene.ambientLight = new pc.Color(0.5, 0.52, 0.58);
const sun = new pc.Entity('sun');
sun.addComponent('light', { type: 'directional', color: new pc.Color(1, 0.97, 0.9), intensity: 1.1, castShadows: false });
sun.setEulerAngles(50, 35, 0);
app.root.addChild(sun);

const camera = new pc.Entity('camera');
camera.addComponent('camera', {
    fov: 74, nearClip: 0.05, farClip: 200, clearColor: new pc.Color(0.53, 0.62, 0.72)
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

async function start(): Promise<void> {
    const [mapData, mapAsset] = await Promise.all([
        fetch(`/maps/${MAP}.json`).then(r => {
            if (!r.ok) throw new Error(`Failed to load map data: ${r.status}`);
            return r.json() as Promise<MapData>;
        }),
        loadContainer(`/maps/${MAP}.glb`)
    ]);
    const mapEntity = (mapAsset.resource as pc.ContainerResource).instantiateRenderEntity();
    app.root.addChild(mapEntity);
    // Baked maps draw unlit from one atlas: no realtime lighting cost on the world at all.
    if (mapData.baked) await applyBakedLighting(app, mapEntity, `/maps/${mapData.baked}`);

    const boxes = mapData.boxes;
    const input = new Input(canvas);
    const presenter = createPresenter(app, camera);
    const audio = createAudio(boxes);

    const camSpawn = mapData.spawns.ghosts[0];
    camera.setPosition(camSpawn.pos[0], camSpawn.pos[1] + EYE_HEIGHT, camSpawn.pos[2]);
    const { name, room } = await askToJoin(() => { audio.unlock(); input.lock(); });
    const query = new URLSearchParams();
    if (room) query.set('room', room);
    if (name) query.set('name', name);
    const serverUrl = `${serverBase}/?${query}`;

    // Predicted local player: `curr` is the latest simulated tick, `prev` the one before it.
    const curr = createPlayerState(mapData.spawns.ghosts[0].pos);
    const prev = createPlayerState(curr.pos);
    /** Commands sent but not yet acknowledged; replayed on top of every server correction. */
    const pending: NetCmd[] = [];
    /** Visual-only offset that hides prediction corrections by blending them out over a few frames. */
    const errorOffset: Vec3 = [0, 0, 0];
    let seq = 0;
    let nextFireSeq = 0;
    /** Command at which a knife swing in progress lands; -1 when none. Mirrors the server. */
    let slashAtSeq = -1;
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

    const net = new Net(serverUrl, lagMs, {
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
            for (let i = 0; i < pending.length; i++) stepPlayer(curr, pending[i], TICK_DT, boxes);

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
            slashAtSeq = -1;
            stepAccum = 0;
        },
        shot(ev: ShotEvent): void {
            // Our own tracer was drawn the moment we fired; the server only tells us what it hit.
            if (ev.shooter !== net.id) {
                presenter.shot(ev.from, ev.to, false);
                audio.gunshot(ev.from, false);
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
        canAct: false, action: 0, showScores: false
    };
    const listener: ListenerView = { pos: [0, 0, 0], yaw: 0, pitch: 0, team: 'ghosts', alive: false };
    let accumulator = 0;
    let eye = EYE_HEIGHT;
    let fps = 60;
    let hudTimer = 0;

    const tick = (): void => {
        copyPlayerState(prev, curr);
        const cmd: NetCmd = {
            seq: seq++, forward: 0, right: 0, yaw: 0, jump: false, walk: false, crouch: false,
            pitch: input.pitch, fire: input.fire, use: input.use, viewTime: net.renderTime()
        };
        input.sample(cmd);
        // Rooted during the freeze and while planting or defusing: the server applies the same rule,
        // and zeroing the command here keeps replays of it consistent.
        const acting = alive && cmd.use && canAct(net.team, match.phase, curr, mapData, match.bombPos);
        if (alive && movementLocked(cmd.use, net.team, match.phase, curr, mapData, match.bombPos)) {
            cmd.forward = 0;
            cmd.right = 0;
            cmd.jump = false;
        }
        pending.push(cmd);
        if (pending.length > 120) pending.shift(); // server silent for 2 s: stop hoarding
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
            if (acting || match.phase === 'freeze') {
                // Hands are busy, or the round has not started: no attacking.
            } else if (net.team === 'ghosts') {
                if (slashAtSeq >= 0) {
                    if (cmd.seq >= slashAtSeq) { slashAtSeq = -1; audio.knifeSlash(curr.pos, false, true); }
                } else if (cmd.fire && cmd.seq >= nextFireSeq) {
                    nextFireSeq = cmd.seq + KNIFE_COOLDOWN_TICKS;
                    slashAtSeq = cmd.seq + KNIFE_WINDUP_TICKS;
                    presenter.knifeSwing(KNIFE_WINDUP_TICKS * TICK_DT);
                    audio.knifeWindup(curr.pos, true);
                }
            } else if (cmd.fire && cmd.seq >= nextFireSeq) {
                nextFireSeq = cmd.seq + FIRE_INTERVAL_TICKS;
                eyePos[0] = curr.pos[0];
                eyePos[1] = curr.pos[1] + (curr.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT);
                eyePos[2] = curr.pos[2];
                viewDir(cmd.yaw, cmd.pitch, aim);
                const dist = rayWorld(boxes, eyePos, aim, SHOT_RANGE);
                const end: Vec3 = [eyePos[0] + aim[0] * dist, eyePos[1] + aim[1] * dist, eyePos[2] + aim[2] * dist];
                presenter.shot(eyePos, end, true);
                audio.gunshot(eyePos, true);
                audio.impact(end);
            }
        }
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
        camera.setEulerAngles(input.pitch / RAD, input.yaw / RAD, 0);

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
        hudTimer += dt;
        if (hudTimer >= 0.1) {
            hudTimer = 0;
            const p = curr.pos;
            hud.textContent =
                `${fps.toFixed(0)} fps${lagMs ? `  (+${lagMs} ms test lag)` : ''}\n` +
                `speed ${horizontalSpeed(curr).toFixed(2)} m/s${curr.onGround ? '' : ' (air)'}${curr.crouched ? ' (crouch)' : ''}\n` +
                `pos ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${p[2].toFixed(1)}`;
        }
    });

    // Handle for automated checks and console debugging.
    Object.assign(window, {
        __sb: {
            app, state: curr, input, net, mapData, audio, presenter, match,
            stats: () => ({ fps, alive, health, vis, pending: pending.length, error: Math.hypot(...errorOffset) })
        }
    });
}

app.start();
start().catch(err => {
    console.error(err);
    status.textContent = String(err instanceof Error ? err.message : err);
});
