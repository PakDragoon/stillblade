// Review screenshots for the defender's first-person sleeve (package R follow-up), taken in headless Chrome over the
// DevTools protocol against a scratch game server and Vite (never the owner's ports 8080 / 5173). SwiftShader
// (software GL): the look only. Built on tools/polish-shots.mjs (package Q): the same Warehouse spots, a lit one (the
// yard, in sunlight) and a dark one (the basement car park), the camera moved there inside presenter.frame so the
// weapon is lit by that spot's light probes; Low and High tiers.
//
//   SB_SERVER_PORT=8094 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5194 --strictPort                   (another)
//   node tools/sleeve-shots.mjs --out docs/review/viewmodel/after6/game-new [--tiers low,high]
//
// Per tier and spot: the rifle at the hip, the empty reload frozen at the charging-handle pull (the left forearm
// across the view), and the pistol at the hip; at the lit spot also the rifle aimed and the defender's knife.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/viewmodel/after6/game-new'));
const CLIENT = arg('client', 'http://localhost:5194');
const SERVER = arg('server', 'ws://localhost:8094');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9234'));
const TIERS = arg('tiers', 'low,high').split(',');
const MAP = arg('map', 'warehouse');
/** Extra address parameters (for example `&aa=0` to compare without anti-aliasing). */
const QUERY = arg('query', '');
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
  // Wall-clock time between frames over 60 frames (mean and median, ms), after 20 frames to settle.
  window.__timing = async () => {
    await __frames(20);
    const ts = []; const h = () => ts.push(performance.now()); sb.app.on('frameend', h); await __frames(61); sb.app.off('frameend', h);
    const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]); d.sort((x, y) => x - y);
    const mean = d.reduce((x, y) => x + y, 0) / d.length;
    return { meanMs: Math.round(mean * 10) / 10, medianMs: Math.round(d[d.length >> 1] * 10) / 10 };
  };
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
    const url = `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Shot&practice=1&side=${side}&map=${MAP}&server=${encodeURIComponent(SERVER)}&res=1&tier=${tier}${QUERY}`;
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
    const profile = join(tmpdir(), `sb-sleeve-${process.pid}`);
    const chrome = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
        '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio', '--no-first-run',
        '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', 'about:blank'
    ], { stdio: 'ignore' });
    try {
        const cdp = new Cdp(await cdpConnect());
        await cdp.open;
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.navigate', { url: `${CLIENT}/?desktop=1` });
        await waitFor(cdp, 'document.readyState === "complete"', 30000, 'page');
        for (const tier of TIERS) {
            await open(cdp, { tier, side: 'defenders' });
            for (const spot of SPOTS) {
                const tag = `${tier}-${spot.name}`;
                console.log(tag);
                await camAt(cdp, spot);
                await shoot(cdp, `${tag}-1-hip`);
                if (spot.name === 'lit') {
                    await cdp.eval(`(async () => { __key('KeyZ', true); await __freezeWhen(() => window.__sb.stats().loadout.aim >= 12); await __frames(1); return true; })()`);
                    await sleep(200);
                    await shoot(cdp, `${tag}-1-aimed`);
                    await cdp.eval(`(async () => { await __thaw(2); __key('KeyZ', false); await __frames(30); return true; })()`);
                }
                // Empty reload: hold the trigger until the magazine runs dry and the reload starts, then freeze at the
                // charging-handle pull (2.03 s of 2.7 s).
                await cdp.eval(`(async () => { __key('KeyF', true); await new Promise(res => { const h = () => { const g = window.__sb.stats().gun; if (g && g.reload > 0 && g.mag === 0) { window.__sb.app.off('frameend', h); res(); } }; window.__sb.app.on('frameend', h); }); __key('KeyF', false); return true; })()`);
                await cdp.eval(`(async () => { await __freezeWhen(() => { const g = window.__sb.stats().gun; return g && g.reload > 0 && 1 - g.reload / 162 >= 2.03 / 2.7; }); await __frames(1); return true; })()`);
                await sleep(200);
                await shoot(cdp, `${tag}-2-handle-pull`);
                await cdp.eval(`(async () => { await __thaw(2); await __frames(80); return true; })()`);
                await cdp.eval(`(async () => { __key('Digit2', true); await __frames(3); __key('Digit2', false); await __frames(40); return true; })()`);
                await shoot(cdp, `${tag}-3-pistol`);
                if (spot.name === 'lit') {
                    await cdp.eval(`(async () => { __key('Digit3', true); await __frames(3); __key('Digit3', false); await __frames(40); return true; })()`);
                    await shoot(cdp, `${tag}-4-knife`);
                }
                await cdp.eval(`(async () => { __key('Digit1', true); await __frames(3); __key('Digit1', false); await __frames(40); return true; })()`);
            }
        }
        cdp.ws.close();
    } finally {
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exit(1); });
