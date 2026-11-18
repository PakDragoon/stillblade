// Review screenshots for armor (package P), taken in headless Chrome over the DevTools protocol against a scratch
// game server and Vite (never the owner's ports 8080 / 5173).
//
//   SB_SERVER_PORT=8092 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5192 --strictPort                   (another)
//   node tools/armor-shots.mjs --out docs/review/armor
//
// Real: the practice range as a defender, shooting the nearest target until a few hits land, so the top strip
// shows each hit's split between armor and health; the HUD with full armor. STAGED (marked in the file name):
// the HUD with a lowered and an empty armor, by handing the presenter a changed `armor` on its input.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/armor'));
const CLIENT = arg('client', 'http://localhost:5192');
const SERVER = arg('server', 'ws://localhost:8092');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9234'));
const W = 1366, H = 768;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpConnect() {
    for (let i = 0; i < 50; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = list.find(t => t.type === 'page');
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

async function shoot(cdp, file, clip) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  saved', file);
}

const HOOKS = `(() => {
  const sb = window.__sb;
  window.__frames = n => new Promise(res => { let k = 0; const h = () => { if (++k >= n) { sb.app.off('frameend', h); res(); } }; sb.app.on('frameend', h); });
  // Optional override of the presenter's local armor (STAGED shots only).
  window.__armor = -1;
  const frame = sb.presenter.frame;
  sb.presenter.frame = (dt, l, r, m) => { if (window.__armor >= 0) l.armor = window.__armor; frame(dt, l, r, m); };
  return true;
})()`;

/** Turns toward the nearest drawn remote player's torso. */
const AIM = `(() => {
  const sb = window.__sb;
  const rs = sb.app.root.find(n => n.name === 'remote' && n.enabled);
  if (!rs.length) return false;
  const me = sb.state.pos; let best = null, bd = Infinity;
  for (const r of rs) { const p = r.getPosition(); const d = (p.x - me[0]) ** 2 + (p.z - me[2]) ** 2; if (d < bd) { bd = d; best = p; } }
  const dx = best.x - me[0], dz = best.z - me[2], dy = best.y + 1.15 - (me[1] + 1.62);
  sb.input.yaw = Math.atan2(-dx, -dz); sb.input.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return Math.sqrt(bd);
})()`;

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-armor-shots-${process.pid}`);
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
        const url = `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Shot&practice=1&side=defenders&map=greybox&server=${encodeURIComponent(SERVER)}&res=1&tier=low`;
        await cdp.send('Page.navigate', { url });
        await waitFor(cdp, 'window.__sb && window.__sb.mapData && window.__sb.stats().alive', 90000, 'spawn');
        await cdp.eval(HOOKS);
        await cdp.eval('__frames(40)');
        const hud = { x: 0, y: H - 130, width: 420, height: 130 };
        // Real: full armor on the HUD.
        await shoot(cdp, join(OUT, 'hud_full_armor.jpg'), hud);

        // Real: single shots at the nearest target with pauses for the recoil, until the strip lists a few hits.
        let dist = 0;
        for (let i = 0; i < 14; i++) {
            dist = await cdp.eval(AIM);
            await cdp.eval('__frames(3)');
            await cdp.eval(`(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f' }));
              await __frames(2); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF', key: 'f' })); await __frames(30); return true; })()`);
            const strip = await cdp.eval(`document.getElementById('lobby-strip')?.textContent ?? ''`);
            if ((strip.match(/health\)/g) ?? []).length >= 4) break;
        }
        const strip = await cdp.eval(`document.getElementById('lobby-strip')?.textContent ?? ''`);
        console.log('  target at', Number(dist).toFixed(1), 'm; strip:', strip);
        await shoot(cdp, join(OUT, 'practice_hits_split.jpg'));
        await shoot(cdp, join(OUT, 'practice_strip_crop.jpg'), { x: 0, y: 0, width: W, height: 70 });

        // STAGED: armor lowered (the flash frame) and empty, through the presenter input only.
        await cdp.eval('window.__armor = 100; __frames(5)');
        await cdp.eval('window.__armor = 42; __frames(1)');
        await shoot(cdp, join(OUT, 'hud_armor_42_flash_STAGED.jpg'), hud);
        await cdp.eval('__frames(40)');
        await shoot(cdp, join(OUT, 'hud_armor_42_STAGED.jpg'), hud);
        await cdp.eval('window.__armor = 0; __frames(40)');
        await shoot(cdp, join(OUT, 'hud_armor_empty_STAGED.jpg'), hud);
        writeFileSync(join(OUT, 'strip.txt'), strip + '\n');
        cdp.ws.close();
    } finally {
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
