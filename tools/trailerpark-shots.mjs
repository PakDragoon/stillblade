// Review screenshots of Trailer Park from the real client, in headless Chrome over the DevTools protocol, against a
// scratch game server and Vite (never the owner's ports 8080 / 5173):
//
//   SB_SERVER_PORT=8090 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5190 --strictPort                   (another)
//   node tools/trailerpark-shots.mjs [--out docs/review/maps/trailerpark] [--tier low]
//
// The client joins a practice room on the map; the camera is then placed at each view (a nav node snapped under it,
// raised to standing or crouched eye height). Headless Chrome renders with SwiftShader (software GL): frame times mean
// nothing; draw calls are read from PlayCanvas (`app.stats`) with the practice targets hidden.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/maps/trailerpark'));
const TIER = arg('tier', 'low');
const CLIENT = arg('client', 'http://localhost:5190');
const SERVER = arg('server', 'ws://localhost:8090');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9235'));
const ONLY = arg('only', '');
const W = 1280, H = 720;
const EYE = 1.62, EYE_CROUCHED = 1.02;

// Engine coordinates (x, height, z = -authoring y); yaw degrees (0 faces -Z = north, 90 faces west, -90 east,
// 180 south), pitch degrees. `y` is the floor height the nav node is looked for at.
const VIEWS = [
    { name: '01_ghost_spawn', pos: [-24.6, 0, 32.2], yaw: -25, pitch: 0, note: 'ghost spawn (bottom left), looking north' },
    { name: '02_defender_spawn', pos: [22.2, 0, -32.5], yaw: 125, pitch: -2, note: 'defender spawn (top), looking south' },
    { name: '03_site_a_in_barrack', pos: [7.0, 0, -1.2], yaw: -95, pitch: -12, note: 'Site A inside the north barrack, from the west end' },
    { name: '04_site_b_pit', pos: [-18.6, -1.2, -11.6], yaw: -5, pitch: -6, note: 'Site B in the pit, from its south stair, looking north' },
    { name: '05_site_b_from_rim', pos: [-15.6, 0, -13.6], yaw: 60, pitch: -22, note: 'Site B from the ground east of the pit' },
    { name: '06_box10_to_roof6', pos: [4.4, 1.0, 4.55], yaw: -90, pitch: -8, note: 'standing on box 10, looking at roof 6' },
    { name: '07_hole7_down', pos: [15.1, 2.0, 4.3], yaw: -90, pitch: -55, note: 'on roof 6, looking down through hole 7' },
    { name: '08_under_hole7', pos: [17.5, 0, 2.6], yaw: 180, pitch: 18, note: 'in the passage under roof 6, looking up at hole 7' },
    { name: '09_crouch8_crouched', pos: [9.17, 0, -7.1], yaw: 180, pitch: -4, crouch: true, note: 'crouched in front of crouch opening 8 (north wall)' },
    { name: '10_crouch9_crouched', pos: [9.24, 0, 15.8], yaw: 0, pitch: -4, crouch: true, note: 'crouched in front of crouch opening 9 (south wall)' },
    { name: '11_walkway_from_plank14', pos: [23.4, 0.6, 1.0], yaw: 170, pitch: -6, note: 'on plank 14, looking south along walkway 13' },
    { name: '12_plank15_from_ground', pos: [23.6, 0, 12.5], yaw: 0, pitch: 4, note: 'the ground corridor south of plank 15, looking north at it' },
    { name: '13_house', pos: [3.0, 0, 31.0], yaw: -5, pitch: 2, note: 'house 17 from the south, its two south doors' },
    { name: '14_house_inside', pos: [-8.5, 0, 25.4], yaw: -80, pitch: -4, note: 'inside house 17, looking east' },
    { name: '15_box18_yard_gap', pos: [-6.8, 0, 17.6], yaw: 0, pitch: -4, note: 'the A-yard wall gap beside box 18' },
    { name: '16_apv', pos: [-5.5, 0, 9.5], yaw: -40, pitch: -2, note: 'the APV in the A yard' }
];

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
  window.__shot = { cam: null, hide: true };
  const none = [];
  sb.app.on('update', () => {
    const c = window.__shot.cam;
    if (c) { cam.setPosition(c[0], c[1], c[2]); cam.setEulerAngles(c[3], c[4], 0); }
  });
  const frame = sb.presenter.frame;
  sb.presenter.frame = (dt, l, r, m) => frame(dt, l, window.__shot.hide ? none : r, m);
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
    const profile = join(tmpdir(), `sb-tp-shots-${process.pid}`);
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
        const url = `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Shot&practice=1&side=ghosts&map=trailerpark&server=${encodeURIComponent(SERVER)}&res=1&tier=${TIER}`;
        await cdp.send('Page.navigate', { url });
        await waitFor(cdp, 'window.__sb && window.__sb.mapData && window.__sb.mapData.name === "trailerpark" && window.__sb.stats().alive', 120000, 'spawn on trailerpark');
        await cdp.eval(HOOKS);
        await cdp.eval('document.body.classList.add("no-stats"); __frames(40)');
        for (const v of VIEWS) {
            if (ONLY && !ONLY.split(',').includes(v.name)) continue;
            const p = await cdp.eval(`__nearestNode(${v.pos.join(',')})`);
            const eye = v.crouch ? EYE_CROUCHED : EYE;
            await cdp.eval(`window.__shot.cam = [${v.pos[0]}, ${p[1] + eye}, ${v.pos[2]}, ${v.pitch}, ${v.yaw}]; __frames(14)`);
            const draws = await cdp.eval('__draws()');
            const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
            writeFileSync(join(OUT, `${v.name}.jpg`), Buffer.from(r.data, 'base64'));
            report.views.push({ name: v.name, note: v.note, camera: [v.pos[0], +(p[1] + eye).toFixed(2), v.pos[2], v.yaw, v.pitch], drawCalls: draws });
            console.log(`${v.name.padEnd(26)} draw calls ${draws}  floor ${p[1].toFixed(2)}  ${v.note}`);
        }
        report.pageErrors = cdp.errors;
        writeFileSync(join(OUT, 'shots.json'), JSON.stringify(report, null, 1));
        cdp.ws.close();
    } finally {
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exit(1); });
