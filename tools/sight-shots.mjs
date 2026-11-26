// Review screenshots for package M part 1 (rifle sights), taken in headless Chrome over the DevTools protocol against
// a scratch game server and Vite (never the owner's ports 8080 / 5173). Headless Chrome renders with SwiftShader
// (software GL): looks only, frame times mean nothing.
//
//   SB_SERVER_PORT=8092 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5192 --strictPort                   (another)
//   node tools/sight-shots.mjs [--out docs/review/sights] [--map greybox]
//
// What it takes (all real game states, nothing handed to the presenter by hand):
//   - the home menu and its Loadout page (the saved choice set through localStorage `sb-loadout` first);
//   - per sight, in the practice range as a defender: the rifle from the hip, half aimed and fully aimed (the aim key Z
//     held through the game's own input), with the frame's draw-call count;
//   - the pause menu's Loadout screen after choosing another sight mid-life ("applies at your next spawn");
//   - third person: two scripted defenders joined over a plain WebSocket with `sight=1` and `sight=2` in a lobby room,
//     looked at from a ghost's page (their sight comes to that page in the roster).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const protocolVersion = require('../shared/protocol-version.json');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/sights'));
const MAP = arg('map', 'greybox');
const CLIENT = arg('client', 'http://localhost:5192');
const SERVER = arg('server', 'ws://localhost:8092');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9234'));
const W = 1366, H = 768;
const SIGHT_IDS = ['iron', 'reddot', 'scope2x'];

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

async function shoot(cdp, name, format = 'jpeg') {
    const r = await cdp.send('Page.captureScreenshot', format === 'png' ? { format } : { format, quality: 88 });
    writeFileSync(join(OUT, `${name}.${format === 'png' ? 'png' : 'jpg'}`), Buffer.from(r.data, 'base64'));
    console.log('  saved', name);
}

/** A page-side helper set: wait N frames, read draw calls, hold or release a key the way the game's Input sees it. */
const HOOKS = `(() => {
  const sb = window.__sb;
  window.__frames = n => new Promise(res => { let k = 0; const h = () => { if (++k >= n) { sb.app.off('frameend', h); res(); } }; sb.app.on('frameend', h); });
  window.__draws = () => sb.app.stats.drawCalls.total;
  // Draw calls without other players (the practice targets move in and out of view): hand the presenter no remotes.
  window.__hide = false;
  const frame = sb.presenter.frame, none = [];
  sb.presenter.frame = (dt, l, r, m) => frame(dt, l, window.__hide ? none : r, m);
  window.__drawsAlone = async () => { window.__hide = true; await __frames(4); const d = __draws(); window.__hide = false; await __frames(2); return d; };
  // Dispatched on the document and bubbling: the game's Input listens on window, the menus on document.
  window.__key = (code, down) => document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
  return true;
})()`;

const setLoadout = (cdp, sight) => cdp.eval(`localStorage.setItem('sb-loadout', JSON.stringify({ sight: '${sight}' })); localStorage.setItem('sb-howto', '1'); true`);

/** A scripted player over a plain WebSocket (no browser): joins `room`, answers nothing, sends no commands. */
function rawPlayer(room, name, sight) {
    const ws = new WebSocket(`${SERVER}/?version=${protocolVersion}&room=${room}&name=${name}&map=${MAP}&sight=${sight}`);
    const roster = [];
    ws.on('message', (data, binary) => { if (!binary) { const m = JSON.parse(data.toString()); if (m.type === 'roster') roster.splice(0, roster.length, ...m.players); } });
    return { ws, roster, opened: new Promise(r => ws.once('open', r)) };
}

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-sights-${process.pid}`);
    const chrome = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
        '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio', '--no-first-run',
        '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', 'about:blank'
    ], { stdio: 'ignore' });
    const report = { drawCalls: {}, notes: [] };
    const raws = [];
    try {
        const cdp = new Cdp(await cdpConnect());
        await cdp.open;
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

        // ---- the menu: home and the Loadout page, with the red dot saved
        console.log('menu');
        await cdp.send('Page.navigate', { url: `${CLIENT}/?desktop=1&server=${encodeURIComponent(SERVER)}` });
        await waitFor(cdp, 'document.readyState === "complete"', 30000, 'page');
        await setLoadout(cdp, 'reddot');
        await cdp.send('Page.navigate', { url: `${CLIENT}/?desktop=1&server=${encodeURIComponent(SERVER)}` });
        await waitFor(cdp, `!!document.querySelector('#menu-screen.open [data-page="home"].active')`, 60000, 'home menu');
        await sleep(400);
        await shoot(cdp, '01-home-menu', 'png');
        await cdp.eval(`[...document.querySelectorAll('#menu-screen button.menubtn')].find(b => b.textContent.startsWith('Loadout')).click(); true`);
        await waitFor(cdp, `!!document.querySelector('[data-page="loadout"].active #sight-choice')`, 5000, 'loadout page');
        await sleep(300);
        await shoot(cdp, '02-loadout-page-menu', 'png');
        // Picking the 2x scope there saves it (read back from storage).
        await cdp.eval(`document.querySelectorAll('#sight-choice button')[2].click(); true`);
        const saved = await cdp.eval(`localStorage.getItem('sb-loadout')`);
        report.notes.push(`menu: clicking the 2x scope saved sb-loadout = ${saved}`);
        await shoot(cdp, '03-loadout-page-scope-picked', 'png');

        // ---- in game, each sight: hip, half and full aim (practice range, defender)
        for (const sight of SIGHT_IDS) {
            console.log(`practice ${sight}`);
            await setLoadout(cdp, sight);
            const url = `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Shot&practice=1&side=defenders&map=${MAP}&server=${encodeURIComponent(SERVER)}&res=1&tier=low`;
            await cdp.send('Page.navigate', { url });
            await waitFor(cdp, 'window.__sb && window.__sb.mapData && window.__sb.stats().alive', 90000, 'spawn');
            await cdp.eval(HOOKS);
            await cdp.eval('document.body.classList.add("no-stats"); true');
            // Face the targets (their average position), a little down, and let everything settle.
            await cdp.eval(`(async () => {
              const sb = window.__sb;
              const rs = sb.app.root.find(n => n.name === 'remote' && n.enabled);
              if (rs.length) {
                let x = 0, z = 0; for (const r of rs) { const p = r.getPosition(); x += p.x; z += p.z; }
                x = x / rs.length - sb.state.pos[0]; z = z / rs.length - sb.state.pos[2];
                sb.input.yaw = Math.atan2(-x, -z); sb.input.pitch = -0.03;
              }
              await __frames(40); return true; })()`);
            const active = await cdp.eval('window.__sb.loadout.sight');
            report.notes.push(`${sight}: predicted loadout.sight after spawn = ${active}`);
            const hipDraws = await cdp.eval('(async () => { await __frames(3); return __draws(); })()');
            const hipAlone = await cdp.eval('__drawsAlone()');
            await shoot(cdp, `10-${sight}-hip`);
            // Hold Z (the aim key's second binding) until the aim reaches about half, then all the way.
            await cdp.eval(`(async () => {
              __key('KeyZ', true);
              const sb = window.__sb;
              await new Promise(res => { const h = () => { if (sb.stats().loadout.aim >= Math.ceil(${sight === 'scope2x' ? 16 : 12} * 0.6)) { sb.app.off('frameend', h); sb.app.timeScale = 0; res(); } }; sb.app.on('frameend', h); });
              await __frames(2); return true; })()`);
            await shoot(cdp, `11-${sight}-aiming-in`);
            await cdp.eval(`(async () => { window.__sb.app.timeScale = 1; await __frames(30); return true; })()`);
            const aimDraws = await cdp.eval('(async () => { await __frames(3); return __draws(); })()');
            const aimAlone = await cdp.eval('__drawsAlone()');
            const aim = await cdp.eval('window.__sb.stats().loadout.aim');
            const fov = await cdp.eval(`window.__sb.app.root.findByName('camera').camera.fov`);
            await shoot(cdp, `12-${sight}-aimed`);
            await cdp.eval(`__key('KeyZ', false); __frames(20)`);
            report.drawCalls[sight] = { hip: hipDraws, aimed: aimDraws, hipWithoutOtherPlayers: hipAlone, aimedWithoutOtherPlayers: aimAlone };
            report.notes.push(`${sight}: aim counter ${aim} when fully aimed, camera fov ${fov.toFixed(2)} degrees`);
        }

        // ---- pause menu: choose the red dot mid-life while the 2x scope is mounted
        console.log('pause menu loadout');
        await cdp.eval(`(async () => { __key('Escape', true); __key('Escape', false); await __frames(5); return true; })()`);
        await waitFor(cdp, `document.querySelector('#pause-screen').classList.contains('open')`, 5000, 'pause menu');
        await shoot(cdp, '20-pause-menu', 'png');
        await cdp.eval(`[...document.querySelectorAll('#pause-screen button')].find(b => b.textContent === 'Loadout').click(); true`);
        await waitFor(cdp, `document.querySelector('#loadout-screen').classList.contains('open')`, 5000, 'loadout screen');
        await cdp.eval(`document.querySelectorAll('#loadout-screen #sight-choice button')[1].click(); true`);
        await sleep(300);
        report.notes.push(`pause loadout note after picking the red dot with the scope mounted: "${await cdp.eval(`document.querySelector('#loadout-screen .loadout-note').textContent`)}"`);
        await shoot(cdp, '21-pause-loadout-applies-next-spawn', 'png');
        report.notes.push(`still mounted after the change (mid-life): ${await cdp.eval('window.__sb.loadout.sight')} (2 = 2x scope)`);

        // ---- third person: scripted defenders with a 2x scope and a red dot, seen by a ghost
        console.log('third person');
        const room = `sights-${process.pid}`;
        const a = rawPlayer(room, 'Filler', 0);          // first joiner: a ghost (keeps the teams even)
        await a.opened; await sleep(300);
        const b = rawPlayer(room, 'Scope', 2);           // second: a defender with the 2x scope
        await b.opened; await sleep(300);
        raws.push(a, b);
        await cdp.send('Page.navigate', { url: `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Watcher&room=${room}&map=${MAP}&server=${encodeURIComponent(SERVER)}&res=1&tier=low` });
        await waitFor(cdp, 'window.__sb && window.__sb.mapData && window.__sb.stats().alive', 90000, 'ghost spawn');
        const c = rawPlayer(room, 'RedDot', 1);          // a second defender with the red dot
        await c.opened; raws.push(c);
        await sleep(1500);
        await cdp.eval(HOOKS);
        await cdp.eval('document.body.classList.add("no-stats"); true');
        report.notes.push(`roster seen by the scripted players: ${JSON.stringify(a.roster.map(p => ({ name: p.name, team: p.team, sight: p.sight })))}`);
        await cdp.eval('__frames(20)');
        // Look at each defender from 1.4 m in front of it and 0.9 m to its right, down at its gun.
        const posInfo = await cdp.eval(`(async () => {
          const sb = window.__sb;
          const list = sb.net.interpolate ? [...sb.net.interpolate()].filter(r => r.team === 'defenders' && r.alive).map(r => ({ id: r.id, pos: [...r.pos], yaw: r.yaw })) : [];
          return list; })()`);
        const names = new Map(a.roster.map(p => [p.id, p.name]));
        const cam = await cdp.eval(`window.__sb.app.root.findByName('camera') !== null`);
        if (!cam) throw new Error('no camera');
        await cdp.eval(`(() => {
          const sb = window.__sb; const cam = sb.app.root.findByName('camera');
          window.__shotCam = null;
          sb.app.on('update', () => { const c = window.__shotCam; if (c) { cam.setPosition(c[0], c[1], c[2]); cam.setEulerAngles(c[3], c[4], 0); } });
          return true; })()`);
        for (const d of posInfo) {
            const name = names.get(d.id) ?? `id${d.id}`;
            const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw);   // the player's forward (yaw 0 faces -Z)
            const rx = Math.cos(d.yaw), rz = -Math.sin(d.yaw);    // and its right
            // Front-right at 1.6 m (the whole player), then its right side at 0.9 m (the gun and sight close up).
            for (const [tag, f, r, h, dist] of [['front', 1.4, 0.9, 1.45, 0], ['side', 0.25, 0.9, 1.42, 1]]) {
                const px = d.pos[0] + fx * f + rx * r, pz = d.pos[2] + fz * f + rz * r, py = d.pos[1] + h;
                const tx = d.pos[0] + fx * (0.25 * dist) + rx * 0.12, tz = d.pos[2] + fz * (0.25 * dist) + rz * 0.12, ty = d.pos[1] + 1.32;
                const yawDeg = Math.atan2(-(tx - px), -(tz - pz)) * 180 / Math.PI;
                const pitchDeg = Math.atan2(ty - py, Math.hypot(tx - px, tz - pz)) * 180 / Math.PI;
                await cdp.eval(`window.__shotCam = [${px}, ${py}, ${pz}, ${pitchDeg}, ${yawDeg}]; __frames(20)`);
                await shoot(cdp, `30-third-person-${name.toLowerCase()}-${tag}`);
            }
        }
        writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
        console.log(JSON.stringify(report, null, 1));
        cdp.ws.close();
    } finally {
        for (const r of raws) try { r.ws.close(); } catch { /* gone */ }
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exit(1); });
