// Review screenshots for package T (the M4 everywhere), taken in headless Chrome over the DevTools protocol against a
// scratch game server and Vite (never the owner's ports 8080 / 5173). Headless Chrome renders with SwiftShader
// (software GL): looks only; frame times mean nothing; draw calls are real. Frames are frozen with app.timeScale = 0.
//
//   SB_SERVER_PORT=8091 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5191 --strictPort                   (another)
//   node tools/m4-shots.mjs --out docs/review/m4/after --client http://localhost:5191 --server ws://localhost:8091
//       [--tiers low,high] [--short]   (--short: the views a "before" run needs: no reload phases beyond four)
//
// Warehouse, a lit spot (the yard) and a dark one (the basement car park), the camera moved there inside
// presenter.frame (polish-shots.mjs's method). Per tier: hip and aimed with the red dot at both spots, aimed with the
// iron sights and the 2x scope at the lit spot. Low only, at the lit spot: the tactical reload (four moments), the
// empty reload (magazine out, magazine in, the bolt catch), the bolt locked back on an empty magazine, the draw, a
// shot, the pistol and the knife (defender and ghost). Third person per tier: a practice target (a defender with the
// rifle) staged at the lit spot, front and side, the first-person layer hidden. Real input only.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/m4/after'));
const CLIENT = arg('client', 'http://localhost:5191');
const SERVER = arg('server', 'ws://localhost:8091');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9251'));
const TIERS = arg('tiers', 'low,high').split(',');
const SHORT = process.argv.includes('--short');
const W = 1366, H = 768;
const RELOAD = 132, RELOAD_EMPTY = 162, DRAW = 24;
const SPOTS = [
    { name: 'lit', pos: [9, 0, 19], yaw: 10, pitch: -4 },
    { name: 'dark', pos: [7.2, -4, -4.5], yaw: -110, pitch: -4 }
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
        this.ws.on('message', data => {
            const msg = JSON.parse(data.toString());
            if (msg.id && this.waiting.has(msg.id)) {
                const { ok, fail } = this.waiting.get(msg.id);
                this.waiting.delete(msg.id);
                if (msg.error) fail(new Error(JSON.stringify(msg.error))); else ok(msg.result);
            } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
                console.log(`  [page ${msg.params.type}]`, msg.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300));
            } else if (msg.method === 'Runtime.exceptionThrown') {
                console.log('  [page exception]', msg.params.exceptionDetails.exception?.description?.slice(0, 300));
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

const report = { note: 'SwiftShader (software GL): looks only. Draw calls are real.', shots: [], draws: {} };
async function shoot(cdp, name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
    writeFileSync(join(OUT, `${name}.jpg`), Buffer.from(r.data, 'base64'));
    const g = await cdp.eval('(() => { const s = window.__sb.stats(); return { gun: s.gun, draw: s.loadout.draw, slot: s.loadout.slot, draws: window.__sb.app.stats.drawCalls.total }; })()');
    report.shots.push({ name, ...g });
    console.log('  saved', name, JSON.stringify(g));
}

const HOOKS = `(() => {
  const sb = window.__sb;
  const cam = sb.app.root.findByName('camera');
  window.__frames = n => new Promise(res => { let k = 0; const h = () => { if (++k >= n) { sb.app.off('frameend', h); res(); } }; sb.app.on('frameend', h); });
  window.__key = (code, down) => document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
  window.__tap = async (code, n = 3) => { __key(code, true); await __frames(n); __key(code, false); await __frames(2); };
  window.__freezeWhen = fn => new Promise(res => { const t0 = performance.now(); const h = () => { if (fn()) { sb.app.off('frameend', h); sb.app.timeScale = 0; res(true); } else if (performance.now() - t0 > 30000) { sb.app.off('frameend', h); res(false); } }; sb.app.on('frameend', h); });
  window.__thaw = async n => { sb.app.timeScale = 1; await __frames(n); };
  window.__nearestNode = (x, y, z) => {
    const n = sb.mapData.nav.nodes; let best = 0, bd = Infinity;
    for (let i = 0; i < n.length; i += 3) {
      const d = (n[i] - x) ** 2 + 3 * (n[i + 1] - y) ** 2 + (n[i + 2] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return [n[best], n[best + 1], n[best + 2]];
  };
  window.__cam = null; window.__pose = null;
  const frame = sb.presenter.frame;
  sb.presenter.frame = (dt, l, r, m) => {
    const c = window.__cam;
    if (c) { cam.setPosition(c[0], c[1], c[2]); cam.setEulerAngles(c[3], c[4], 0); }
    const p = window.__pose;
    if (p) r = r.map(v => v.id === p.id ? Object.assign({}, v, p.v) : v);
    return frame(dt, l, r, m);
  };
  const vm = sb.app.scene.layers.getLayerByName('Viewmodel');
  window.__vm = on => { const ls = cam.camera.layers.filter(id => id !== vm.id); cam.camera.layers = on ? ls.concat(vm.id) : ls; };
  window.__texturesIn = () => { const ms = sb.app.root.find(n => n.render).flatMap(n => n.render.meshInstances.map(mi => mi.material)); return ms.some(m => m && m.diffuseMap && /albedo/.test(m.diffuseMap.name)); };
  window.__rigIn = () => !!sb.app.root.findByName('viewmodel-rig');
  return true;
})()`;

async function open(cdp, { tier, side = 'defenders', sight = 'reddot' }) {
    await cdp.eval(`localStorage.setItem('sb-loadout', JSON.stringify({ sight: '${sight}' })); localStorage.setItem('sb-howto', '1'); true`);
    const url = `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Shot&practice=1&side=${side}&map=warehouse&server=${encodeURIComponent(SERVER)}&res=1&tier=${tier}`;
    await cdp.send('Page.navigate', { url });
    await waitFor(cdp, 'window.__sb && window.__sb.mapData && window.__sb.stats().alive', 120000, 'spawn');
    await cdp.eval(HOOKS);
    await cdp.eval('document.body.classList.add("no-stats"); true');
    await waitFor(cdp, '__texturesIn()', 60000, 'textures');
    if (side === 'defenders') await waitFor(cdp, '__rigIn()', 60000, 'arms rig');
    await cdp.eval('__frames(60)');
}

async function camAt(cdp, spot) {
    const p = await cdp.eval(`__nearestNode(${spot.pos.join(',')})`);
    await cdp.eval(`window.__cam = [${p[0]}, ${p[1] + 1.62}, ${p[2]}, ${spot.pitch}, ${spot.yaw}]; __frames(30)`);
    return p;
}

async function aimed(cdp, name, full = 12) {
    await cdp.eval(`(async () => { __key('KeyZ', true); await __freezeWhen(() => window.__sb.stats().loadout.aim >= ${full}); await __frames(1); return true; })()`);
    await sleep(200);
    await shoot(cdp, name);
    await cdp.eval(`(async () => { await __thaw(2); __key('KeyZ', false); await __frames(30); return true; })()`);
}

async function reloadAt(cdp, ticks, frac, name) {
    const ok = await cdp.eval(`(async () => { const ok = await __freezeWhen(() => { const g = window.__sb.stats().gun; return g && g.reload > 0 && 1 - g.reload / ${ticks} >= ${frac}; }); if (ok) await __frames(1); return ok; })()`);
    if (!ok) { console.log('  MISSED', name, JSON.stringify(await cdp.eval('window.__sb.stats().gun'))); return; }
    await sleep(200);
    await shoot(cdp, name);
    await cdp.eval('__thaw(1)');
}

/** Freezes on the frame of the next local shot, plus one frame. */
async function onShot(cdp, name, until = 'true') {
    await cdp.eval(`(async () => { const sb = window.__sb; const shot = sb.presenter.shot;
      const done = new Promise(res => { sb.presenter.shot = (...a) => { shot(...a); if (a[2] && (${until})) { sb.app.timeScale = 0; res(); } }; });
      __key('KeyF', true); await done; __key('KeyF', false); sb.presenter.shot = shot; await __frames(1); return true; })()`);
    await sleep(200);
    await shoot(cdp, name);
    await cdp.eval('__thaw(1)');
}

async function firstPerson(cdp, tier) {
    console.log(`${tier}: first person, red dot`);
    await open(cdp, { tier });
    for (const spot of SPOTS) {
        await camAt(cdp, spot);
        report.draws[`${tier}-${spot.name}-hip`] = await cdp.eval('window.__sb.app.stats.drawCalls.total');
        await shoot(cdp, `${tier}-${spot.name}-hip`);
        await aimed(cdp, `${tier}-${spot.name}-aimed-reddot`);
    }
    if (tier === 'low') await rifleMotion(cdp);
    for (const sight of ['iron', 'scope2x']) {
        console.log(`${tier}: ${sight}`);
        await open(cdp, { tier, sight });
        await camAt(cdp, SPOTS[0]);
        if (sight === 'iron') await shoot(cdp, `${tier}-lit-hip-iron`);
        await aimed(cdp, `${tier}-lit-aimed-${sight}`, sight === 'scope2x' ? 16 : 12);
    }
}

async function rifleMotion(cdp) {
    console.log('low: rifle motion');
    await camAt(cdp, SPOTS[0]);
    await onShot(cdp, 'low-fire');
    await cdp.eval('__frames(30)');
    await cdp.eval(`__tap('KeyR')`);
    const tac = SHORT ? [[0.8, '2-mag-out'], [1.45, '4-mag-in']] : [[0.45, '1-start'], [0.8, '2-mag-out'], [1.15, '3-mag-low'], [1.45, '4-mag-in']];
    for (const [t, tag] of tac) await reloadAt(cdp, RELOAD, t / 2.2, `low-reload-${tag}`);
    await cdp.eval('__frames(90)');
    // Fire the magazine dry and let go on the frame it empties: the bolt stays back.
    await cdp.eval(`(async () => { const sb = window.__sb; __key('KeyF', true);
      await __freezeWhen(() => { const g = sb.stats().gun; return g && g.mag === 0; }); __key('KeyF', false); await __thaw(25); sb.app.timeScale = 0; await __frames(1); return true; })()`);
    await sleep(200);
    await shoot(cdp, 'low-bolt-locked');
    await cdp.eval('__thaw(1)');
    // Pull the trigger on empty: the empty reload starts.
    await cdp.eval(`__tap('KeyF')`);
    const emp = SHORT ? [[0.85, '1-mag-out'], [2.03, '3-bolt-catch']] : [[0.85, '1-mag-out'], [1.55, '2-mag-in'], [2.03, '3-bolt-catch']];
    for (const [t, tag] of emp) await reloadAt(cdp, RELOAD_EMPTY, t / 2.7, `low-empty-${tag}`);
    await cdp.eval('__frames(90)');
    await cdp.eval(`(async () => { await __tap('Digit2'); await __frames(40); __key('Digit1', true); await __frames(1); __key('Digit1', false); return true; })()`);
    for (const [left, tag] of [[0.75, '1'], [0.4, '2']]) {
        await cdp.eval(`(async () => { await __freezeWhen(() => { const s = window.__sb.stats(); return s.loadout.slot === 0 && s.loadout.draw > 0 && s.loadout.draw <= ${DRAW * left}; }); await __frames(1); return true; })()`);
        await sleep(200);
        await shoot(cdp, `low-draw-${tag}`);
        await cdp.eval('__thaw(1)');
    }
    await cdp.eval('__frames(40)');
    console.log('low: pistol and knife');
    await cdp.eval(`(async () => { await __tap('Digit2'); await __frames(40); return true; })()`);
    await shoot(cdp, 'low-pistol-hip');
    await cdp.eval(`(async () => { __key('KeyF', true); await __frames(2); __key('KeyF', false); await __frames(20); return true; })()`);
    await cdp.eval(`__tap('KeyR')`);
    await reloadAt(cdp, 84, 0.42 / 1.4, 'low-pistol-reload');
    await cdp.eval('__frames(90)');
    await cdp.eval(`(async () => { await __tap('Digit3'); await __frames(40); return true; })()`);
    await shoot(cdp, 'low-knife-defender');
    await cdp.eval(`(async () => { await __tap('Digit1'); await __frames(40); return true; })()`);
}

async function thirdPerson(cdp, tier) {
    console.log(`${tier}: third person`);
    await open(cdp, { tier, side: 'ghosts' });
    if (tier === 'low') { await camAt(cdp, SPOTS[0]); await shoot(cdp, 'low-knife-ghost'); }
    await cdp.eval('__vm(false); true');
    const t = await cdp.eval(`(() => { const sb = window.__sb; let best = null; for (const r of sb.net.interpolate()) if (r.alive && r.team === 'defenders' && (!best || r.id < best.id)) best = { id: r.id }; return best; })()`);
    if (!t) { console.log('  no defender target'); return; }
    const spot = SPOTS[0];
    const p = await cdp.eval(`__nearestNode(${spot.pos.join(',')})`);
    const pose = { pos: p, yaw: 0, pitch: 0, crouched: false, alive: true, reloading: false, switching: false, aiming: false, weapon: 0, vis: 1 };
    await cdp.eval(`window.__pose = { id: ${t.id}, v: ${JSON.stringify(pose)} }; __frames(30)`);
    for (const [view, ang] of [['front', 0], ['side', Math.PI / 2], ['left', -Math.PI / 2]]) {
        const d = 1.9, fx = -Math.sin(ang), fz = -Math.cos(ang);
        const px = p[0] + fx * d, pz = p[2] + fz * d, py = p[1] + 1.3;
        const yaw = Math.atan2(-(p[0] - px), -(p[2] - pz)) * 180 / Math.PI;
        const pitch = Math.atan2(p[1] + 1.15 - py, d) * 180 / Math.PI;
        await cdp.eval(`window.__cam = [${px}, ${py}, ${pz}, ${pitch}, ${yaw}]; __frames(30)`);
        report.draws[`${tier}-third-person-${view}`] = await cdp.eval('window.__sb.app.stats.drawCalls.total');
        await shoot(cdp, `${tier}-third-person-${view}`);
    }
    // Draw calls with and without the staged player (the difference is what one armed player costs).
    await cdp.eval(`window.__pose = { id: ${t.id}, v: { alive: false, pos: [0, -50, 0] } }; __frames(30)`);
    report.draws[`${tier}-third-person-front-without-player`] = await cdp.eval('window.__sb.app.stats.drawCalls.total');
    await cdp.eval('window.__pose = null; window.__cam = null; __vm(true); true');
}

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-m4-${process.pid}`);
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
            await firstPerson(cdp, tier);
            await thirdPerson(cdp, tier);
        }
        writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
        cdp.ws.close();
    } finally {
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exit(1); });
