import * as pc from 'playcanvas';
import { EYE_HEIGHT, EYE_HEIGHT_CROUCHED, TICK_DT } from '@shared/constants';
import { copyPlayerState, createPlayerState, horizontalSpeed, stepPlayer } from '@shared/movement';
import type { InputCmd, MapData, Spawn } from '@shared/types';
import { Input } from './input';

const MAP = 'greybox';
const RAD = Math.PI / 180;

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
    const cmd: InputCmd = { forward: 0, right: 0, yaw: 0, jump: false, walk: false, crouch: false };

    let spawnIndex = 0;
    const curr = createPlayerState([0, 0, 0]);
    const prev = createPlayerState([0, 0, 0]);
    const respawn = (): void => {
        const spawns: Spawn[] = mapData.spawns.ghosts;
        const spawn = spawns[spawnIndex++ % spawns.length];
        copyPlayerState(curr, createPlayerState(spawn.pos));
        copyPlayerState(prev, curr);
        input.yaw = spawn.yaw * RAD;
        input.pitch = 0;
    };
    respawn();

    overlay.addEventListener('click', () => input.lock());
    canvas.addEventListener('click', () => input.lock());
    document.addEventListener('pointerlockchange', () => overlay.classList.toggle('hidden', input.locked));
    status.textContent = 'Click to play';

    let accumulator = 0;
    let eye = EYE_HEIGHT;
    let fps = 60;
    let hudTimer = 0;

    app.on('update', (dt: number) => {
        // Fixed-rate simulation, rendered with interpolation so motion is smooth at any frame rate.
        accumulator += Math.min(dt, 0.25);
        while (accumulator >= TICK_DT) {
            copyPlayerState(prev, curr);
            input.sample(cmd);
            stepPlayer(curr, cmd, TICK_DT, boxes);
            if (curr.pos[1] < mapData.bounds.min[1] - 10) respawn();
            accumulator -= TICK_DT;
        }
        const a = accumulator / TICK_DT;
        const eyeTarget = curr.crouched ? EYE_HEIGHT_CROUCHED : EYE_HEIGHT;
        eye += (eyeTarget - eye) * (1 - Math.exp(-14 * dt));
        camera.setPosition(
            prev.pos[0] + (curr.pos[0] - prev.pos[0]) * a,
            prev.pos[1] + (curr.pos[1] - prev.pos[1]) * a + eye,
            prev.pos[2] + (curr.pos[2] - prev.pos[2]) * a
        );
        camera.setEulerAngles(input.pitch / RAD, input.yaw / RAD, 0);

        if (dt > 0) fps += (1 / dt - fps) * 0.05;
        hudTimer += dt;
        if (hudTimer >= 0.1) {
            hudTimer = 0;
            const p = curr.pos;
            hud.textContent =
                `${fps.toFixed(0)} fps\n` +
                `speed ${horizontalSpeed(curr).toFixed(2)} m/s${curr.onGround ? '' : ' (air)'}${curr.crouched ? ' (crouch)' : ''}\n` +
                `pos ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${p[2].toFixed(1)}`;
        }
    });

    // Read-only handle for automated checks and console debugging.
    Object.assign(window, { __sb: { app, state: curr, input, mapData, stats: () => ({ fps }) } });
}

app.start();
start().catch(err => {
    console.error(err);
    status.textContent = String(err instanceof Error ? err.message : err);
});
