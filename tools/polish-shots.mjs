// Review screenshots and numbers for package Q (visual and feel polish), taken in headless Chrome over the DevTools
// protocol against a scratch game server and Vite (never the owner's ports 8080 / 5173). Headless Chrome renders with
// SwiftShader (software GL): the pictures show the look, the frame times are the software renderer's and say nothing
// about a real GPU; draw calls are real.
//
//   SB_SERVER_PORT=8097 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5197 --strictPort                   (another)
//   node tools/polish-shots.mjs --out docs/review/polish/after [--tiers low,high]
//
// Warehouse, a lit spot (the yard, in sunlight) and a dark one (the basement car park at site A). The camera is
// moved there by wrapping presenter.frame, so the presenter sees the moved camera in the same frame (its light probes
// and the weapon's lighting follow the camera). First person: the practice range as a defender with the red dot,
// at the hip and aimed (time frozen when fully aimed). Third person: a practice target (a defender, seen from a
// ghost's page) STAGED at the spot by replacing its position and pose in the frame the presenter receives, viewed by
// a free camera with the first-person layer hidden.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/polish/after'));
const CLIENT = arg('client', 'http://localhost:5197');
const SERVER = arg('server', 'ws://localhost:8097');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9241'));
const TIERS = arg('tiers', 'low,high').split(',');
const MAP = arg('map', 'warehouse');
const W = 1366, H = 768;

// Engine coordinates; yaw degrees (0 faces -Z, positive turns toward -X), pitch degrees. Snapped to the nearest
// navigation node, eye 1.62 m above it.
const SPOTS = {
    warehouse: [
        { name: 'lit', pos: [9, 0, 19], yaw: 10, pitch: -4 },
        { name: 'dark', pos: [7.2, -4, -4.5], yaw: -110, pitch: -4 }
    ],
    greybox: [
        { name: 'lit', pos: [0, 0, 13], yaw: 0, pitch: -4 },
        { name: 'dark', pos: [8, 0, -7.5], yaw: 30, pitch: -6 }
    ]
}[MAP];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpConnect() {
    for (let i = 0; i < 50; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
            const page = (await r.json()).find(t => t.type === 'page');
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* not up yet */ }
        await sleep(200);
    }
    throw new Error('Chrome did not start');
}

class Cdp {
    constructor(url) {
        this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
        this.id = 0;
        this.waiting = new Map();
        this.ws.on('message', data => {
            const msg = JSON.parse(data.toString());
            if (msg.id && this.waiting.has(msg.id)) {
                const { ok, fail } = this.waiting.get(msg.id);
                this.waiting.delete(msg.id);
                if (msg.error) fail(new Error(JSON.stringify(msg.error))); else ok(msg.result);
            } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
                console.log(`  [page ${msg.params.type}]`, msg.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 400));
            } else if (msg.method === 'Runtime.exceptionThrown') {
                console.log('  [page exception]', msg.params.exceptionDetails.exception?.description?.slice(0, 400));
            }
        });
        this.open = new Promise(r => this.ws.once('open', r));
    }
    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((ok, fail) => this.waiting.set(id, { ok, fail }));
    }
    async eval(expr) {
        const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
        return r.result.value;
    }
}

async function waitFor(cdp, expr, ms, what) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if (await cdp.eval(expr)) return; } catch { /* page still loading */ }
        await sleep(300);
    }
    throw new Error(`timed out waiting for ${what}`);
}

async function shoot(cdp, name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    writeFileSync(join(OUT, `${name}.jpg`), Buffer.from(r.data, 'base64'));
    console.log('  saved', name);
}

const HOOKS = `(() => {
  const sb = window.__sb;
  const cam = sb.app.root.findByName('camera');
  window.__frames = n => new Promise(res => { let k = 0; const h = () => { if (++k >= n) { sb.app.off('frameend', h); res(); } }; sb.app.on('frameend', h); });
  window.__key = (code, down) => document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
  window.__freezeWhen = fn => new Promise(res => { const h = () => { if (fn()) { sb.app.off('frameend', h); sb.app.timeScale = 0; res(); } }; sb.app.on('frameend', h); });
  window.__thaw = async n => { sb.app.timeScale = 1; await __frames(n); };
  window.__nearestNode = (x, y, z) => {
    const n = sb.mapData.nav.nodes; let best = 0, bd = Infinity;
    for (let i = 0; i < n.length; i += 3) {
      const d = (n[i] - x) ** 2 + 3 * (n[i + 1] - y) ** 2 + (n[i + 2] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return [n[best], n[best + 1], n[best + 2]];
  };
  // Camera and pose overrides, applied inside presenter.frame (the presenter sees them in the same frame).
  window.__cam = null; window.__pose = null; window.__hide = false;
  const none = [];
  const frame = sb.presenter.frame;
  sb.presenter.frame = (dt, l, r, m) => {
    const c = window.__cam;
    if (c) { cam.setPosition(c[0], c[1], c[2]); cam.setEulerAngles(c[3], c[4], 0); }
    const p = window.__pose;
    if (p) r = r.map(v => v.id === p.id ? Object.assign({}, v, p.v) : v);
    return frame(dt, l, window.__hide ? none : r, m);
  };
  const vm = sb.app.scene.layers.getLayerByName('Viewmodel');
  window.__vm = on => { const ls = cam.camera.layers.filter(id => id !== vm.id); cam.camera.layers = on ? ls.concat(vm.id) : ls; };
  window.__draws = () => sb.app.stats.drawCalls.total;
  // Frame time as the game's own HUD counts it (smoothed fps), and the engine's last frame and render times.
  window.__timing = async () => { await __frames(30); const s = sb.stats(); const f = sb.app.stats.frame; return { fps: Math.round(s.fps * 10) / 10, frameMs: Math.round(f.ms * 10) / 10, renderMs: Math.round(f.renderTime * 10) / 10 }; };
  // The light the probes give at the camera (lighting.ts uniforms, rounded): ambient from up, the sides, down; sun.
  window.__light = () => {
    const l = sb.lighting; if (!l) return null;
    const p = cam.getPosition(), o = new Float32Array(30);
    if (!l.sample(p.x, p.y, p.z, o)) return 'no probe';
    const lum = i => Math.round((0.2126 * o[i] + 0.7152 * o[i + 1] + 0.0722 * o[i + 2]) * 1000) / 1000;
    return { up: lum(6), side: Math.round((lum(0) + lum(3) + lum(12) + lum(15)) * 250) / 1000, down: lum(9), key: lum(21), rim: lum(24), reflect: lum(27), envLum: Math.round(l.envLum * 1000) / 1000, probes: l.probes.computed };
  };
  window.__texturesIn = () => { const ms = sb.app.root.find(n => n.render).flatMap(n => n.render.meshInstances.map(mi => mi.material)); return ms.some(m => m && m.diffuseMap && /albedo/.test(m.diffuseMap.name)); };
  return true;
})()`;

async function open(cdp, { tier, side }) {
    await cdp.eval(`localStorage.setItem('sb-loadout', JSON.stringify({ sight: 'reddot' })); localStorage.setItem('sb-howto', '1'); true`);
    const url = `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Shot&practice=1&side=${side}&map=${MAP}&server=${encodeURIComponent(SERVER)}&res=1&tier=${tier}`;
    await cdp.send('Page.navigate', { url });
    await waitFor(cdp, 'window.__sb && window.__sb.mapData && window.__sb.stats().alive', 120000, 'spawn');
    await cdp.eval(HOOKS);
    await cdp.eval('document.body.classList.add("no-stats"); true');
    await waitFor(cdp, '__texturesIn()', 60000, 'textures');
    await cdp.eval('__frames(60)');
}

async function camAt(cdp, spot) {
    const p = await cdp.eval(`__nearestNode(${spot.pos.join(',')})`);
    await cdp.eval(`window.__cam = [${p[0]}, ${p[1] + 1.62}, ${p[2]}, ${spot.pitch}, ${spot.yaw}]; __frames(20)`);
    return p;
}

/** The practice target nearest the player (it is staged elsewhere, so which one does not matter). */
const PICK = `(() => { const sb = window.__sb; let best = null; for (const r of sb.net.interpolate()) if (r.alive && (!best || r.id < best.id)) best = { id: r.id, team: r.team }; return best; })()`;

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-polish-${process.pid}`);
    const chrome = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
        '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio', '--no-first-run',
        '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', 'about:blank'
    ], { stdio: 'ignore' });
    const report = { note: 'SwiftShader (software GL): frame times are the CPU renderer\'s, not a GPU\'s. Draw calls are real.', views: {} };
    try {
        const cdp = new Cdp(await cdpConnect());
        await cdp.open;
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.navigate', { url: `${CLIENT}/?desktop=1` });
        await waitFor(cdp, 'document.readyState === "complete"', 30000, 'page');
        for (const tier of TIERS) {
            console.log(`${tier}: first person`);
            await open(cdp, { tier, side: 'defenders' });
            for (const spot of SPOTS) {
                await camAt(cdp, spot);
                const tag = `${tier}-${spot.name}`;
                report.views[`${tag}-hip`] = { draws: await cdp.eval('__draws()'), ...(await cdp.eval('__timing()')) };
                report.views[`${tag}-hip`].light = await cdp.eval('__light()');
                await shoot(cdp, `${tag}-hip`);
                await cdp.eval(`(async () => { __key('KeyZ', true); await __freezeWhen(() => window.__sb.stats().loadout.aim >= 12); await __frames(1); return true; })()`);
                await sleep(200);
                report.views[`${tag}-aimed`] = { draws: await cdp.eval('__draws()') };
                await shoot(cdp, `${tag}-aimed`);
                await cdp.eval(`(async () => { await __thaw(2); __key('KeyZ', false); await __frames(30); return true; })()`);
            }
            console.log(`${tier}: third person`);
            await open(cdp, { tier, side: 'ghosts' });
            await cdp.eval('__vm(false); true');
            const t = await cdp.eval(PICK);
            for (const spot of SPOTS) {
                const p = await cdp.eval(`__nearestNode(${spot.pos.join(',')})`);
                // The target stands 2.6 m in front of the spot's view, facing it, rifle in hand; the camera at the spot.
                const yaw = spot.yaw * Math.PI / 180;
                const tx = p[0] - Math.sin(yaw) * 2.6, tz = p[2] - Math.cos(yaw) * 2.6;
                const q = await cdp.eval(`__nearestNode(${tx}, ${p[1]}, ${tz})`);
                const pose = { pos: q, yaw: Math.atan2(p[0] - q[0], p[2] - q[2]) + Math.PI, pitch: 0, crouched: false, alive: true, reloading: false, switching: false, aiming: false, weapon: 0, vis: 1 };
                const dx = q[0] - p[0], dz = q[2] - p[2];
                const camYaw = Math.atan2(-dx, -dz) * 180 / Math.PI;
                const camPitch = Math.atan2(q[1] + 1.0 - (p[1] + 1.55), Math.hypot(dx, dz)) * 180 / Math.PI;
                await cdp.eval(`window.__pose = { id: ${t.id}, v: ${JSON.stringify(pose)} }; window.__cam = [${p[0]}, ${p[1] + 1.55}, ${p[2]}, ${camPitch}, ${camYaw}]; __frames(40)`);
                const tag = `${tier}-${spot.name}`;
                report.views[`${tag}-third-person`] = { draws: await cdp.eval('__draws()'), ...(await cdp.eval('__timing()')) };
                await shoot(cdp, `${tag}-third-person`);
            }
            await cdp.eval('window.__pose = null; window.__cam = null; __vm(true); true');
        }
        writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
        console.log(JSON.stringify(report, null, 1));
        cdp.ws.close();
    } finally {
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exit(1); });
