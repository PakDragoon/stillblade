// Review screenshots of a map from the real client, in headless Chrome over the DevTools protocol, against a
// scratch game server and Vite (never the owner's ports 8080 / 5173):
//
//   SB_SERVER_PORT=8090 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5190 --strictPort                   (another)
//   node tools/map-shots.mjs --map drycreek --out docs/review/maps/drycreek [--views <json>] [--tier low] [--only a,b]
//                            [--side ghosts|defenders] [--suffix _high]
//
// The client joins a practice room on the map; the camera is then placed at each view (a nav node snapped under it,
// raised to standing or crouched eye height). Headless Chrome renders with SwiftShader (software GL): frame times mean
// nothing; draw calls are read from PlayCanvas (`app.stats`) with the practice targets hidden.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const MAP = arg('map', 'drycreek');
const OUT = resolve(arg('out', `docs/review/maps/${MAP}`));
const TIER = arg('tier', 'low');
const CLIENT = arg('client', 'http://localhost:5190');
const SERVER = arg('server', 'ws://localhost:8090');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9235'));
const ONLY = arg('only', '');
const W = +arg('w', '1280'), H = +arg('h', '720');
const SIDE = arg('side', 'ghosts');
const SUFFIX = arg('suffix', '');
const EYE = 1.62, EYE_CROUCHED = 1.02;

// Views come from a JSON file: [{ name, pos: [x, floor y, z] (engine), yaw, pitch, crouch?, ortho?, note }].
// Engine coordinates are (x, height, z = -authoring y); yaw in degrees (0 faces -Z = north, 90 west, -90 east,
// 180 south). `pos[1]` is the floor height the nav node under the camera is looked for at; the eye goes at standing
// (or crouched) height above that node. With `ortho` (half height in metres) the camera is placed exactly at `pos`
// and switched to an orthographic projection (an overhead view: pitch -90). With `ghost` ({ from: [x, y, z], to: [x, z] },
// engine coordinates) one remote ghost is drawn running back and forth along that line at a run's opacity (0.35, the
// shimmer), in the presenter only: run with `--side defenders`, whose practice targets are ghosts.
const VIEWS = JSON.parse(readFileSync(resolve(arg('views', join(OUT, 'views.json'))), 'utf8'));

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
        this.errors = [];
        this.ws.on('message', data => {
            const msg = JSON.parse(data.toString());
            if (msg.id && this.waiting.has(msg.id)) {
                const { ok, fail } = this.waiting.get(msg.id);
                this.waiting.delete(msg.id);
                if (msg.error) fail(new Error(JSON.stringify(msg.error))); else ok(msg.result);
            } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
                const t = msg.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300);
                this.errors.push(t);
                console.log('  [page error]', t);
            } else if (msg.method === 'Runtime.exceptionThrown') {
                const t = msg.params.exceptionDetails.exception?.description?.slice(0, 300);
                this.errors.push(t);
                console.log('  [page exception]', t);
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

const HOOKS = `(() => {
  const sb = window.__sb;
  const cam = sb.app.root.findByName('camera');
  window.__shot = { cam: null, hide: true, ortho: 0, ghost: null };
  const persp = { fov: cam.camera.fov, far: cam.camera.farClip };
  const none = [];
  sb.app.on('update', () => {
    const c = window.__shot.cam;
    if (c) { cam.setPosition(c[0], c[1], c[2]); cam.setEulerAngles(c[3], c[4], 0); }
    const o = window.__shot.ortho;
    cam.camera.projection = o ? 1 : 0;
    if (o) { cam.camera.orthoHeight = o; cam.camera.farClip = 400; } else { cam.camera.farClip = persp.far; }
  });
  const frame = sb.presenter.frame;
  const one = [];
  sb.presenter.frame = (dt, l, r, m) => {
    const g = window.__shot.ghost;
    const gh = g && r.find(x => x.team === 'ghosts');
    if (gh) {
      g.t += dt;
      const len = Math.hypot(g.to[0] - g.from[0], g.to[1] - g.from[2]);
      let s = (g.t * 5.2) % (2 * len), dir = 1;
      if (s > len) { s = 2 * len - s; dir = -1; }
      const dx = (g.to[0] - g.from[0]) / len, dz = (g.to[1] - g.from[2]) / len;
      gh.pos = [g.from[0] + dx * s, g.from[1], g.from[2] + dz * s];
      gh.yaw = Math.atan2(-dx * dir, -dz * dir);
      gh.vis = 0.35; gh.crouched = false; gh.alive = true;
      one.length = 0; one.push(gh);
      frame(dt, l, one, m);
      return;
    }
    frame(dt, l, window.__shot.hide ? none : r, m);
  };
  window.__nearestNode = (x, y, z) => {
    const n = sb.mapData.nav.nodes; let best = 0, bd = Infinity;
    for (let i = 0; i < n.length; i += 3) {
      const d = (n[i] - x) ** 2 + 30 * (n[i + 1] - y) ** 2 + (n[i + 2] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return [n[best], n[best + 1], n[best + 2]];
  };
  window.__frames = n => new Promise(res => { let k = 0; const h = () => { if (++k >= n) { sb.app.off('frameend', h); res(); } }; sb.app.on('frameend', h); });
  window.__draws = () => sb.app.stats.drawCalls.total;
  return true;
})()`;

async function waitFor(cdp, expr, ms, what) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if (await cdp.eval(expr)) return; } catch { /* page still loading */ }
        await sleep(300);
    }
    throw new Error(`timed out waiting for ${what}`);
}

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-map-shots-${process.pid}`);
    const chrome = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
        '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio', '--no-first-run',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'
    ], { stdio: 'ignore' });
    const report = { tier: TIER, views: [] };
    try {
        const cdp = new Cdp(await cdpConnect());
        await cdp.open;
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        const url = `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Shot&practice=1&side=${SIDE}&map=${MAP}&server=${encodeURIComponent(SERVER)}&res=1&tier=${TIER}`;
        await cdp.send('Page.navigate', { url });
        await waitFor(cdp, `window.__sb && window.__sb.mapData && window.__sb.mapData.name === "${MAP}" && window.__sb.stats().alive`, 120000, `spawn on ${MAP}`);
        await cdp.eval(HOOKS);
        await cdp.eval('document.body.classList.add("no-stats"); __frames(40)');
        for (const v of VIEWS) {
            if (ONLY && !ONLY.split(',').includes(v.name)) continue;
            const p = v.ortho ? [v.pos[0], v.pos[1], v.pos[2]] : await cdp.eval(`__nearestNode(${v.pos.join(',')})`);
            const eye = v.ortho ? 0 : v.crouch ? EYE_CROUCHED : EYE;
            // an overhead view hides the page's HUD (everything but the canvas)
            await cdp.eval(`(() => { const c = window.__sb.app.graphicsDevice.canvas; document.body.style.visibility = ${v.ortho ? "'hidden'" : "''"}; c.style.visibility = 'visible'; })()`);
            const ghost = v.ghost ? `{ from: ${JSON.stringify(v.ghost.from)}, to: ${JSON.stringify(v.ghost.to)}, t: 0 }` : 'null';
            await cdp.eval(`window.__shot.ghost = ${ghost}; window.__shot.ortho = ${v.ortho ?? 0}; window.__shot.cam = [${v.pos[0]}, ${p[1] + eye}, ${v.pos[2]}, ${v.pitch}, ${v.yaw}]; __frames(${v.ghost ? 40 : 14})`);
            const draws = await cdp.eval('__draws()');
            const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
            writeFileSync(join(OUT, `${v.name}${SUFFIX}.jpg`), Buffer.from(r.data, 'base64'));
            report.views.push({ name: v.name, note: v.note, camera: [v.pos[0], +(p[1] + eye).toFixed(2), v.pos[2], v.yaw, v.pitch], drawCalls: draws });
            console.log(`${v.name.padEnd(26)} draw calls ${draws}  floor ${p[1].toFixed(2)}  ${v.note}`);
        }
        report.pageErrors = cdp.errors;
        writeFileSync(join(OUT, `shots${SUFFIX}.json`), JSON.stringify(report, null, 1));
        cdp.ws.close();
    } finally {
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exit(1); });
