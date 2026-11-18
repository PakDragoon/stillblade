// Review screenshots for package R (the downloaded first-person animation pack on the AK), taken in headless Chrome over
// the DevTools protocol against a scratch game server and Vite (never the owner's ports 8080 / 5173). Headless Chrome
// renders with SwiftShader (software GL): looks only, frame times mean nothing. Frames are frozen with
// app.timeScale = 0 (the simulation steps inside the app's update, so it stops too) on the first rendered frame past
// the wanted point; SwiftShader frames are slow, so a frame can land up to a few hundredths of the clip late.
//
//   SB_SERVER_PORT=8094 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5194 --strictPort                   (another)
//   node tools/fp-anim-shots.mjs --out docs/review/viewmodel/after4/game-after --client http://localhost:5194 \
//       --server ws://localhost:8094
//
// The practice range as a defender (red dot, Low tier, Test Map 1): the hip hold, the tactical reload at four phases,
// the empty reload (fire the magazine dry, keep the trigger held) at the magazine change and the charging handle, the
// rifle's draw (switch to the pistol and back) and the defender's and the ghost's knife grips. Real input only.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/viewmodel/after4/game-after'));
const CLIENT = arg('client', 'http://localhost:5194');
const SERVER = arg('server', 'ws://localhost:8094');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9234'));
const W = 1366, H = 768;
// The rule's lengths in commands (shared/weapons.ts): rifle reload, empty reload, draw.
const RELOAD = 132, RELOAD_EMPTY = 162, DRAW = 24;

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

const log = [];
async function shoot(cdp, name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    writeFileSync(join(OUT, `${name}.jpg`), Buffer.from(r.data, 'base64'));
    const g = await cdp.eval('(() => { const s = window.__sb.stats(); return { gun: s.gun, draw: s.loadout.draw, slot: s.loadout.slot }; })()');
    log.push({ name, ...g });
    console.log('  saved', name, JSON.stringify(g));
}

const HOOKS = `(() => {
  const sb = window.__sb;
  window.__frames = n => new Promise(res => { let k = 0; const h = () => { if (++k >= n) { sb.app.off('frameend', h); res(); } }; sb.app.on('frameend', h); });
  window.__key = (code, down) => document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
  window.__tap = async (code, n = 3) => { __key(code, true); await __frames(n); __key(code, false); await __frames(2); };
  // Freeze the frame once fn() is true (checked after each frame); gives up after 20 s of real time (false).
  window.__freezeWhen = fn => new Promise(res => { const t0 = performance.now(); const h = () => { if (fn()) { sb.app.off('frameend', h); sb.app.timeScale = 0; res(true); } else if (performance.now() - t0 > 20000) { sb.app.off('frameend', h); res(false); } }; sb.app.on('frameend', h); });
  window.__thaw = async n => { sb.app.timeScale = 1; await __frames(n); };
  window.__texturesIn = () => { const ms = sb.app.root.find(n => n.render).flatMap(n => n.render.meshInstances.map(mi => mi.material)); return ms.some(m => m && m.diffuseMap && /albedo/.test(m.diffuseMap.name)); };
  return true;
})()`;

async function practice(cdp, { sight = 'reddot', side = 'defenders' }) {
    await cdp.eval(`localStorage.setItem('sb-loadout', JSON.stringify({ sight: '${sight}' })); localStorage.setItem('sb-howto', '1'); true`);
    const url = `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Shot&practice=1&side=${side}&map=greybox&server=${encodeURIComponent(SERVER)}&res=1&tier=low`;
    await cdp.send('Page.navigate', { url });
    await waitFor(cdp, 'window.__sb && window.__sb.mapData && window.__sb.stats().alive', 120000, 'spawn');
    await cdp.eval(HOOKS);
    await cdp.eval('document.body.classList.add("no-stats"); true');
    await waitFor(cdp, '__texturesIn()', 60000, 'weapon textures');
    // Look along the range a little down (the same view every run), and settle.
    await cdp.eval(`(async () => { const sb = window.__sb; sb.input.pitch = -0.03; await __frames(40); return true; })()`);
}

/** Freezes the first frame where the held gun's reload progress (of `ticks`) reaches `frac`, shoots, thaws one frame. */
async function reloadAt(cdp, ticks, frac, name) {
    const ok = await cdp.eval(`(async () => { const ok = await __freezeWhen(() => { const g = window.__sb.stats().gun; return g && g.reload > 0 && 1 - g.reload / ${ticks} >= ${frac}; }); if (ok) await __frames(1); return ok; })()`);
    if (!ok) { console.log('  MISSED', name, JSON.stringify(await cdp.eval('window.__sb.stats().gun'))); return; }
    await sleep(200);
    await shoot(cdp, name);
    await cdp.eval('__thaw(1)');
}

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-fpanim-${process.pid}`);
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

        console.log('rifle');
        await practice(cdp, {});
        await shoot(cdp, '01-hip');
        // Tactical reload: a few rounds, then R; the pack's phases at our clip's times (viewmodel.py PREVIEW_SHOTS).
        await cdp.eval(`(async () => { __key('KeyF', true); await __frames(10); __key('KeyF', false); await __frames(20); return true; })()`);
        console.log('  after firing', JSON.stringify(await cdp.eval('window.__sb.stats().gun')));
        await cdp.eval(`__tap('KeyR')`);
        console.log('  after R', JSON.stringify(await cdp.eval('window.__sb.stats().gun')));
        for (const [t, tag] of [[0.46, '1-hand-on-mag'], [0.80, '2-mag-out'], [1.10, '3-mag-low'], [1.45, '4-mag-in']]) {
            await reloadAt(cdp, RELOAD, t / 2.2, `02-reload-${tag}`);
        }
        await cdp.eval('__frames(80)');
        // Empty reload: hold the trigger until the magazine is dry and the reload starts by itself.
        await cdp.eval(`(async () => { __key('KeyF', true); await new Promise(res => { const h = () => { const g = window.__sb.stats().gun; if (g && g.reload > 0) { window.__sb.app.off('frameend', h); res(); } }; window.__sb.app.on('frameend', h); }); __key('KeyF', false); return true; })()`);
        for (const [t, tag] of [[0.82, '1-mag-out'], [1.55, '2-mag-in'], [1.90, '3-handle-reach'], [2.03, '4-handle-pulled']]) {
            await reloadAt(cdp, RELOAD_EMPTY, t / 2.7, `03-empty-${tag}`);
        }
        await cdp.eval('__frames(80)');
        // Draw: to the pistol and back to the rifle; frozen early and midway through the rifle's 0.4 s draw.
        await cdp.eval(`(async () => { await __tap('Digit2'); await __frames(40); __key('Digit1', true); await __frames(1); __key('Digit1', false); return true; })()`);
        for (const [left, tag] of [[0.75, '1'], [0.4, '2']]) {
            await cdp.eval(`(async () => { await __freezeWhen(() => { const s = window.__sb.stats(); return s.loadout.slot === 0 && s.loadout.draw > 0 && s.loadout.draw <= ${DRAW * left}; }); await __frames(1); return true; })()`);
            await sleep(200);
            await shoot(cdp, `04-draw-${tag}`);
            await cdp.eval('__thaw(1)');
        }
        await cdp.eval('__frames(40)');
        console.log('knife');
        await cdp.eval(`(async () => { await __tap('Digit3'); await __frames(40); return true; })()`);
        await shoot(cdp, '05-knife-defender');
        await practice(cdp, { side: 'ghosts' });
        await shoot(cdp, '06-knife-ghost');
        writeFileSync(join(OUT, 'frames.json'), JSON.stringify(log, null, 1));
        cdp.ws.close();
    } finally {
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exit(1); });
