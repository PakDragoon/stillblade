// Review screenshots and draw-call counts for the graphics tiers (package G), taken in headless Chrome over the
// DevTools protocol against a scratch game server and Vite (never the owner's ports 8080 / 5173).
//
//   SB_SERVER_PORT=8091 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5191 --strictPort                   (another)
//   node tools/graphics-shots.mjs --out docs/review/graphics/after --tiers low,high [--maps greybox,warehouse]
//
// Headless Chrome renders with SwiftShader (software GL), so frame times mean nothing; it reports draw calls
// (PlayCanvas `app.stats`), the world and per-player share of them, and saves one JPEG per view.
// `--tiers none` leaves the tier out of the address (the game before package G had none).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/graphics/after'));
const TIERS = arg('tiers', 'low,high').split(',');
const MAPS = arg('maps', 'greybox,warehouse').split(',');
const CLIENT = arg('client', 'http://localhost:5191');
const SERVER = arg('server', 'ws://localhost:8091');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9233'));
/** Optional JavaScript run in the page after it is set up (debugging, e.g. a CameraFrame debug view). */
const EXTRA = arg('eval', '');
const SIDES = arg('sides', 'ghosts,defenders').split(',');
const W = 1280, H = 720;

// Engine coordinates (x, y up, z); yaw degrees (0 faces -Z, positive turns toward -X), pitch degrees.
// The position is snapped to the nearest navigation node (walkable floor) and raised to eye height.
const VIEWS = {
    greybox: [
        { name: 'mid', pos: [0, 0, 13], yaw: 0, pitch: -3 },
        { name: 'site_a', pos: [-10, 0, -2], yaw: 0, pitch: -6 },
        { name: 'stairs', pos: [3, 0, -19], yaw: 143, pitch: -10 },
        { name: 'site_b_close', pos: [8, 0, -7.5], yaw: 30, pitch: -14 }
    ],
    warehouse: [
        { name: 'yard', pos: [9, 0, 19], yaw: 0, pitch: 2 },
        { name: 'site_b', pos: [-12, 0, -3.5], yaw: 30, pitch: -10 },
        { name: 'stairs_s2', pos: [-7, 0, 11], yaw: 0, pitch: -28 },
        { name: 'site_a', pos: [7.2, -4, -4.5], yaw: -110, pitch: -6 }
    ]
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpConnect() {
    for (let i = 0; i < 50; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
            const list = await r.json();
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
            } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
                console.log('  [page error]', msg.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300));
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

/** Installed once per page: a camera override applied after the game's own update, and a draw-call reader. */
const HOOKS = `(() => {
  const sb = window.__sb;
  const cam = sb.app.root.findByName('camera');
  window.__shot = { cam: null, vis: -1, hide: false };
  const none = [];
  sb.app.on('update', () => {
    const c = window.__shot.cam;
    if (c) { cam.setPosition(c[0], c[1], c[2]); cam.setEulerAngles(c[3], c[4], 0); }
  });
  // Force a ghost visibility on every remote ghost (shimmer review), on the presenter's input only.
  const frame = sb.presenter.frame;
  sb.presenter.frame = (dt, l, r, m) => {
    if (window.__shot.vis >= 0) for (const x of r) if (x.team === 'ghosts') x.vis = window.__shot.vis;
    frame(dt, l, window.__shot.hide ? none : r, m);
  };
  window.__nearestNode = (x, y, z) => {
    const n = sb.mapData.nav.nodes; let best = 0, bd = Infinity;
    for (let i = 0; i < n.length; i += 3) {
      const d = (n[i] - x) ** 2 + 3 * (n[i + 1] - y) ** 2 + (n[i + 2] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return [n[best], n[best + 1], n[best + 2]];
  };
  window.__frames = n => new Promise(res => { let k = 0; const h = () => { if (++k >= n) { sb.app.off('frameend', h); res(); } }; sb.app.on('frameend', h); });
  window.__draws = () => { const d = sb.app.stats.drawCalls; return { total: d.total, forward: d.forward, misc: d.misc, immediate: d.immediate }; };
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

async function shoot(cdp, file) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
}

/** Draw calls with everything, without the remote players, and without the viewmodel layer's guns. */
async function measure(cdp) {
    return cdp.eval(`(async () => {
      const sb = window.__sb;
      await __frames(3);
      const all = __draws();
      const remotes = sb.app.root.find(n => n.name === 'remote' && n.enabled);
      window.__shot.hide = true;
      await __frames(3);
      const noPlayers = __draws();
      window.__shot.hide = false;
      await __frames(3);
      const tier = sb.graphics ? sb.graphics.tier : 'none';
      return { all, noPlayers, players: remotes.length, tier };
    })()`);
}

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-shots-${process.pid}`);
    const chrome = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
        '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio', '--no-first-run',
        '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', 'about:blank'
    ], { stdio: 'ignore' });
    const report = [];
    try {
        const cdp = new Cdp(await cdpConnect());
        await cdp.open;
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        for (const map of MAPS) {
            for (const tier of TIERS) {
                for (const side of SIDES) {
                    const tierQ = tier === 'none' ? '' : `&tier=${tier}`;
                    const url = `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Shot&practice=1&side=${side}&map=${map}&server=${encodeURIComponent(SERVER)}&res=1${tierQ}`;
                    console.log(`${map} ${tier} ${side}`);
                    await cdp.send('Page.navigate', { url });
                    await waitFor(cdp, 'window.__sb && window.__sb.mapData && window.__sb.stats().alive', 90000, 'spawn');
                    await cdp.eval(HOOKS);
                    await cdp.eval('document.body.classList.add("no-stats"); true');
                    if (EXTRA) await cdp.eval(EXTRA);
                    await cdp.eval('__frames(40)');
                    const tag = `${map}_${tier}`;
                    if (side === 'ghosts') {
                        // Practice targets are defenders standing in view of our spawn: lit characters and their shadows.
                        await cdp.eval('__frames(30)');
                        report.push({ map, tier, view: 'players_defenders', ...(await measure(cdp)) });
                        await shoot(cdp, join(OUT, `${tag}_players_defenders.jpg`));
                        for (const v of VIEWS[map]) {
                            const p = await cdp.eval(`__nearestNode(${v.pos.join(',')})`);
                            await cdp.eval(`window.__shot.cam = [${p[0]}, ${p[1] + 1.62}, ${p[2]}, ${v.pitch}, ${v.yaw}]; __frames(12)`);
                            report.push({ map, tier, view: v.name, ...(await measure(cdp)) });
                            await shoot(cdp, join(OUT, `${tag}_${v.name}.jpg`));
                            if (v.name === 'site_a' && tier !== 'none') {
                                // STAGED: the presenter is handed one frame of "round over, bomb exploded" at site A's
                                // centre (no real plant), then time is frozen 0.3 s into the explosion.
                                await cdp.eval(`(async () => {
                                  const sb = window.__sb, s = sb.mapData.bombSites[0];
                                  const pos = [(s.min[0] + s.max[0]) / 2, s.min[1], (s.min[2] + s.max[2]) / 2];
                                  const frame = sb.presenter.frame; let once = true;
                                  sb.presenter.frame = (dt, l, r, m) => {
                                    if (once) { once = false; frame(dt, l, r, { ...m, phase: 'over', reason: 'exploded', bombPos: pos, round: 999 }); }
                                    else frame(dt, l, r, m);
                                  };
                                  let t = 0; await new Promise(res => { const h = dt => { t += dt; if (t >= 0.3) { sb.app.off('update', h); sb.app.timeScale = 0; res(); } }; sb.app.on('update', h); });
                                  await __frames(2); sb.presenter.frame = frame; return true; })()`);
                                report.push({ map, tier, view: 'explosion_staged', ...(await measure(cdp)) });
                                await shoot(cdp, join(OUT, `${tag}_explosion_staged.jpg`));
                                await cdp.eval('window.__sb.app.timeScale = 1; true');
                            }
                        }
                    } else {
                        // Defender: practice targets are ghosts; drawn at a running ghost's visibility for the shimmer.
                        // Turn toward the targets (their average position) first: the spawn may face a wall.
                        await cdp.eval(`(async () => {
                          const sb = window.__sb;
                          const rs = sb.app.root.find(n => n.name === 'remote' && n.enabled);
                          if (rs.length) {
                            let x = 0, z = 0; for (const r of rs) { const p = r.getPosition(); x += p.x; z += p.z; }
                            x = x / rs.length - sb.state.pos[0]; z = z / rs.length - sb.state.pos[2];
                            sb.input.yaw = Math.atan2(-x, -z); sb.input.pitch = -0.04;
                          }
                          await __frames(10); return true; })()`);
                        await cdp.eval('window.__shot.vis = 0.35; __frames(30)');
                        report.push({ map, tier, view: 'ghosts_running_035', ...(await measure(cdp)) });
                        await shoot(cdp, join(OUT, `${tag}_ghosts_running.jpg`));
                        // A short burst into the floor a few metres ahead, frozen on the frame of the fourth shot: flash,
                        // tracer, dust and holes from the shots before it.
                        await cdp.eval(`(async () => {
                          const sb = window.__sb; sb.input.pitch = -0.3; sb.input.yaw += 0.35;
                          sb.app.maxDeltaTime = 0.02;   // software GL frames are slow: keep the flash alive on the frozen frame
                          await __frames(4);
                          let n = 0; const shot = sb.presenter.shot;
                          const done = new Promise(res => { sb.presenter.shot = (...a) => { shot(...a); if (++n === 4) { sb.app.timeScale = 0; res(); } }; });
                          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f' }));
                          await done;
                          window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF', key: 'f' }));
                          sb.presenter.shot = shot;
                          await __frames(2);
                          return true; })()`);
                        report.push({ map, tier, view: 'firing', ...(await measure(cdp)) });
                        await shoot(cdp, join(OUT, `${tag}_firing.jpg`));
                        await cdp.eval('window.__sb.app.timeScale = 1; window.__sb.app.maxDeltaTime = 0.1; true');
                    }
                }
            }
        }
        writeFileSync(join(OUT, 'drawcalls.json'), JSON.stringify(report, null, 1));
        for (const r of report) {
            console.log(`${r.map.padEnd(10)} ${String(r.tier).padEnd(5)} ${r.view.padEnd(20)} total ${r.all.total}  without players ${r.noPlayers.total}  players ${r.players}  (tier ${r.tier})`);
        }
        cdp.ws.close();
    } finally {
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exit(1); });
