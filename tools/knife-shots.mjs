// Review screenshots for package V part 1 (the knife from the owner's knife pack), taken in headless Chrome over the
// DevTools protocol against a scratch game server and Vite (never the owner's ports 8080 / 5173), as tools/m4-shots.mjs
// does. SwiftShader (software GL): looks only; frame times mean nothing; draw calls are real. Frames are frozen with
// app.timeScale = 0 on the predicted knife state (the windup about half done; the slash just landed).
//
//   SB_SERVER_PORT=8092 npx tsx server/src/main.ts
//   npx vite --port 5192 --strictPort
//   node tools/knife-shots.mjs --out docs/review/knife/after --client http://localhost:5192 --server ws://localhost:8092
//       [--tiers low,high]
//
// Per tier, Warehouse's yard: a defender with the rifle and the pistol (unchanged), drawing the knife (two moments), the
// knife at idle, and five swings with the attack held (the rig chains them 0, 1, 2, 1, 3), each at its windup and at
// its strike, and the idle in the dark basement; a ghost at idle and the same five swings; third person: a practice
// target holding the knife, a ghost (seen by the defender) and a defender (seen by the ghost), front, side and close,
// the first-person layer hidden.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/knife/after'));
const CLIENT = arg('client', 'http://localhost:5191');
const SERVER = arg('server', 'ws://localhost:8091');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9252'));
const TIERS = arg('tiers', 'low,high').split(',');
const W = 1366, H = 768;
const KNIFE_DRAW = 18;
/** --quick: only the defender's idle with the knife (a check after rebuilding the rig). */
const QUICK = process.argv.includes('--quick');
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
    const g = await cdp.eval('(() => { const s = window.__sb.stats(); return { slot: s.loadout.slot, draw: s.loadout.draw, knife: s.loadout.knife, ghostKnife: s.knife, draws: window.__sb.app.stats.drawCalls.total }; })()');
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
    await waitFor(cdp, '__rigIn()', 60000, 'arms rig');
    await cdp.eval('__frames(60)');
}


async function camAt(cdp, spot) {
    const p = await cdp.eval(`__nearestNode(${spot.pos.join(',')})`);
    await cdp.eval(`window.__cam = [${p[0]}, ${p[1] + 1.62}, ${p[2]}, ${spot.pitch}, ${spot.yaw}]; __frames(30)`);
    return p;
}

/** Five swings with the attack held: each frozen part way through its windup and just after its slash. */
async function swings(cdp, tier, who, ks) {
    const names = ['swing0', 'swing1', 'swing2', 'swing1-again', 'swing3'];
    // Game time at a tenth while swinging: software GL draws a frame every 0.1 s or more of game time, and a slash
    // crosses the view in about 0.07 s, so at full speed the frozen frame would fall after it.
    await cdp.eval(`window.__slow = 0.1; window.__sb.app.timeScale = __slow; __key('KeyF', true); true`);
    for (const n of names) {
        const w = await cdp.eval(`(async () => { const ok = await __freezeWhen(() => { const k = ${ks}; return k.windup >= 5 && k.windup <= 7; }); if (ok) await __frames(1); return ok; })()`);
        if (!w) { console.log('  MISSED windup', n); break; }
        await sleep(200);
        await shoot(cdp, `${tier}-${who}-${n}-windup`);
        await cdp.eval('window.__sb.app.timeScale = __slow; __frames(1)');
        const s = await cdp.eval(`(async () => { const ok = await __freezeWhen(() => { const k = ${ks}; return k.windup === 0 && k.cooldown <= 30 && k.cooldown >= 28; }); if (ok) await __frames(1); return ok; })()`);
        if (!s) { console.log('  MISSED strike', n); break; }
        await sleep(200);
        await shoot(cdp, `${tier}-${who}-${n}-strike`);
        await cdp.eval('window.__sb.app.timeScale = __slow; __frames(1)');
    }
    await cdp.eval(`(async () => { __key('KeyF', false); window.__sb.app.timeScale = 1; await __frames(60); return true; })()`);
}

async function defender(cdp, tier) {
    console.log(`${tier}: defender`);
    await open(cdp, { tier });
    await camAt(cdp, SPOTS[0]);
    report.draws[`${tier}-rifle`] = await cdp.eval('window.__sb.app.stats.drawCalls.total');
    await shoot(cdp, `${tier}-rifle-hip`);
    await cdp.eval(`(async () => { await __tap('Digit2'); await __frames(40); return true; })()`);
    await shoot(cdp, `${tier}-pistol-hip`);
    await cdp.eval(`(async () => { __key('Digit3', true); await __frames(1); __key('Digit3', false); return true; })()`);
    for (const [left, tag] of [[0.66, '1'], [0.33, '2']]) {
        await cdp.eval(`(async () => { await __freezeWhen(() => { const s = window.__sb.stats(); return s.loadout.slot === 2 && s.loadout.draw > 0 && s.loadout.draw <= ${KNIFE_DRAW * left}; }); await __frames(1); return true; })()`);
        await sleep(200);
        await shoot(cdp, `${tier}-defender-draw-${tag}`);
        await cdp.eval('__thaw(1)');
    }
    await cdp.eval('__frames(60)');
    report.draws[`${tier}-knife`] = await cdp.eval('window.__sb.app.stats.drawCalls.total');
    await shoot(cdp, `${tier}-defender-idle`);
    if (QUICK) {
        await swings(cdp, tier, 'defender', 'window.__sb.stats().loadout.knife');
        console.log('  viewmodel meshes drawn:', await cdp.eval(`(() => { const sb = window.__sb; const vm = sb.app.scene.layers.getLayerByName('Viewmodel'); return sb.app.root.find(n => n.render && n.enabled && n.render.enabled && n.render.layers.includes(vm.id)).filter(n => { let e = n; while (e) { if (!e.enabled) return false; e = e.parent; } return true; }).map(n => n.name + ':' + n.render.meshInstances.length); })()`));
        return;
    }
    await swings(cdp, tier, 'defender', 'window.__sb.stats().loadout.knife');
    await camAt(cdp, SPOTS[1]);
    await shoot(cdp, `${tier}-defender-idle-dark`);
    await thirdPerson(cdp, tier, 'ghosts', 'ghost');
}

async function ghost(cdp, tier) {
    console.log(`${tier}: ghost`);
    await open(cdp, { tier, side: 'ghosts' });
    await camAt(cdp, SPOTS[0]);
    await shoot(cdp, `${tier}-ghost-idle`);
    await swings(cdp, tier, 'ghost', 'window.__sb.stats().knife');
    await thirdPerson(cdp, tier, 'defenders', 'defender');
}

/** A practice target of `team` staged in the yard holding the knife: front, side and close, the first-person layer hidden. */
async function thirdPerson(cdp, tier, team, who) {
    await cdp.eval('__vm(false); true');
    const t = await cdp.eval(`(() => { const sb = window.__sb; let best = null; for (const r of sb.net.interpolate()) if (r.alive && r.team === '${team}' && (!best || r.id < best.id)) best = { id: r.id }; return best; })()`);
    if (!t) { console.log('  no target of', team); await cdp.eval('__vm(true); true'); return; }
    const spot = SPOTS[0];
    const p = await cdp.eval(`__nearestNode(${spot.pos.join(',')})`);
    const pose = { pos: p, yaw: 0, pitch: 0, crouched: false, alive: true, reloading: false, switching: false, aiming: false, weapon: 2, vis: 1 };
    await cdp.eval(`window.__pose = { id: ${t.id}, v: ${JSON.stringify(pose)} }; __frames(30)`);
    for (const [view, ang, d] of [['front', 0, 1.9], ['side', Math.PI / 2, 1.9], ['close', Math.PI / 3, 1.0]]) {
        const fx = -Math.sin(ang), fz = -Math.cos(ang);
        const px = p[0] + fx * d, pz = p[2] + fz * d, py = p[1] + 1.3;
        const yaw = Math.atan2(-(p[0] - px), -(p[2] - pz)) * 180 / Math.PI;
        const pitch = Math.atan2(p[1] + 1.05 - py, d) * 180 / Math.PI;
        await cdp.eval(`window.__cam = [${px}, ${py}, ${pz}, ${pitch}, ${yaw}]; __frames(30)`);
        report.draws[`${tier}-third-person-${who}-${view}`] = await cdp.eval('window.__sb.app.stats.drawCalls.total');
        await shoot(cdp, `${tier}-third-person-${who}-${view}`);
    }
    await cdp.eval(`window.__pose = { id: ${t.id}, v: { alive: false, pos: [0, -50, 0] } }; __frames(30)`);
    report.draws[`${tier}-third-person-${who}-without-player`] = await cdp.eval('window.__sb.app.stats.drawCalls.total');
    await cdp.eval('window.__pose = null; window.__cam = null; __vm(true); true');
}

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-knife-${process.pid}`);
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
            await defender(cdp, tier);
            if (!QUICK) await ghost(cdp, tier);
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
