import * as pc from 'playcanvas';
import {
    EYE_HEIGHT, EYE_HEIGHT_CROUCHED, FIRE_INTERVAL_TICKS, MAX_HEALTH, SHOT_RANGE, TICK_DT
} from '@shared/constants';
import { copyPlayerState, createPlayerState, horizontalSpeed, stepPlayer } from '@shared/movement';
import { DEFAULT_PORT, type NetCmd, type SelfSnap, type ShotEvent } from '@shared/protocol';
import { rayWorld, viewDir } from '@shared/raycast';
import type { MapData, Vec3 } from '@shared/types';
import { Input } from './input';
import { Net } from './net';
import { createPresenter } from './presenter';
import type { LocalView } from './presenter-api';

const MAP = 'greybox';
const RAD = Math.PI / 180;
/** Prediction errors larger than this are teleports (respawn), not drift: snap instead of smoothing. */
const SNAP_DISTANCE = 2;

const params = new URLSearchParams(location.search);
const serverUrl = params.get('server') ?? `ws://${location.hostname}:${DEFAULT_PORT}`;
/** `?lag=150` adds 150 ms of artificial round-trip latency. */
const lagMs = Math.max(0, Number(params.get('lag')) || 0);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const overlay = document.getElementById('overlay')!;
const status = document.getElementById('status')!;

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
    app.root.addChild((mapAsset.resource as pc.ContainerResource).instantiateRenderEntity());

    const boxes = mapData.boxes;
    const input = new Input(canvas);
    const presenter = createPresenter(app, camera);

    // Predicted local player: `curr` is the latest simulated tick, `prev` the one before it.
    const curr = createPlayerState(mapData.spawns.ghosts[0].pos);
    const prev = createPlayerState(curr.pos);
    /** Commands sent but not yet acknowledged; replayed on top of every server correction. */
    const pending: NetCmd[] = [];
    /** Visual-only offset that hides prediction corrections by blending them out over a few frames. */
    const errorOffset: Vec3 = [0, 0, 0];
    let seq = 0;
    let nextFireSeq = 0;
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
        },
        shot(ev: ShotEvent): void {
            // Our own tracer was drawn the moment we fired; the server only tells us what it hit.
            if (ev.shooter !== net.id) presenter.shot(ev.from, ev.to, false);
            else if (ev.victim !== undefined) presenter.hitConfirm(ev.head === true, ev.killed === true);
            if (ev.victim === net.id) presenter.damaged(ev.damage ?? 0);
            if (ev.killed && ev.victim !== undefined) presenter.killFeed(ev.shooter, ev.victim, ev.head === true);
        }
    });

    overlay.addEventListener('click', () => input.lock());
    canvas.addEventListener('click', () => input.lock());
    document.addEventListener('pointerlockchange', () => overlay.classList.toggle('hidden', input.locked));
    status.textContent = 'Click to play';

    const local: LocalView = {
        id: 0, team: 'ghosts', health: MAX_HEALTH, alive: false, respawnIn: 0, connected: false, ping: 0, firing: false
    };
    let accumulator = 0;
    let eye = EYE_HEIGHT;
    let fps = 60;
    let hudTimer = 0;

    const tick = (): void => {
        copyPlayerState(prev, curr);
        const cmd: NetCmd = {
            seq: seq++, forward: 0, right: 0, yaw: 0, jump: false, walk: false, crouch: false,
            pitch: input.pitch, fire: input.fire, viewTime: net.renderTime()
        };
        input.sample(cmd);
        pending.push(cmd);
        if (pending.length > 120) pending.shift(); // server silent for 2 s: stop hoarding
        if (alive) {
            stepPlayer(curr, cmd, TICK_DT, boxes);
            // Same rule as the server, counted in our own commands, so the two never disagree.
            if (cmd.fire && cmd.seq >= nextFireSeq) {
                nextFireSeq = cmd.seq + FIRE_INTERVAL_TICKS;
                eyePos[0] = curr.pos[0];
                eyePos[1] = curr.pos[1] + (curr.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT);
                eyePos[2] = curr.pos[2];
                viewDir(cmd.yaw, cmd.pitch, aim);
                const dist = rayWorld(boxes, eyePos, aim, SHOT_RANGE);
                presenter.shot(eyePos, [eyePos[0] + aim[0] * dist, eyePos[1] + aim[1] * dist, eyePos[2] + aim[2] * dist], true);
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
        local.respawnIn = alive ? 0 : Math.max(0, (respawnAt - (net.renderTime() + 100)) / 1000);
        local.connected = net.connected;
        local.ping = net.ping;
        local.firing = alive && input.fire;
        presenter.frame(dt, local, net.interpolate());

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
            app, state: curr, input, net, mapData,
            stats: () => ({ fps, alive, health, pending: pending.length, error: Math.hypot(...errorOffset) })
        }
    });
}

app.start();
start().catch(err => {
    console.error(err);
    status.textContent = String(err instanceof Error ? err.message : err);
});
