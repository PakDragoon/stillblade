// Review screenshots for package M part 2 (realistic weapons), taken in headless Chrome over the DevTools protocol
// against a scratch game server and Vite (never the owner's ports 8080 / 5173). Headless Chrome renders with
// SwiftShader (software GL): looks only, frame times mean nothing.
//
//   SB_SERVER_PORT=8094 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5194 --strictPort                   (another)
//   node tools/weapon-shots.mjs [--out docs/review/realistic-weapons]
//
// Every picture is a real game state driven through the game's own input (keys dispatched on the page): nothing is
// handed to the presenter. The practice range as a defender for first person (hip, aimed with each sight, frozen
// mid-reload, the knife frozen mid-swing; Low and High tiers; Test Map 1 and Warehouse), and scripted players
// (tools/bot.ts, standing still) seen from a ghost's page for third person.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/realistic-weapons'));
const CLIENT = arg('client', 'http://localhost:5194');
const SERVER = arg('server', 'ws://localhost:8094');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9236'));
const ONLY = arg('only', '');
const W = 1366, H = 768;

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

async function shoot(cdp, name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    writeFileSync(join(OUT, `${name}.jpg`), Buffer.from(r.data, 'base64'));
    console.log('  saved', name);
}

const HOOKS = `(() => {
  const sb = window.__sb;
  window.__frames = n => new Promise(res => { let k = 0; const h = () => { if (++k >= n) { sb.app.off('frameend', h); res(); } }; sb.app.on('frameend', h); });
  window.__draws = () => sb.app.stats.drawCalls.total;
  window.__hide = false;
  const frame = sb.presenter.frame, none = [];
  sb.presenter.frame = (dt, l, r, m) => frame(dt, l, window.__hide ? none : r, m);
  window.__drawsAlone = async () => { window.__hide = true; await __frames(4); const d = __draws(); window.__hide = false; await __frames(2); return d; };
  window.__key = (code, down) => document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
  window.__tap = async (code, n = 3) => { __key(code, true); await __frames(n); __key(code, false); await __frames(2); };
  // Freeze the frame once fn() is true (checked after each frame).
  window.__freezeWhen = fn => new Promise(res => { const h = () => { if (fn()) { sb.app.off('frameend', h); sb.app.timeScale = 0; res(); } }; sb.app.on('frameend', h); });
  window.__thaw = async n => { sb.app.timeScale = 1; await __frames(n); };
  // Weapon textures loaded (the materials get their albedo when the atlas arrives).
  window.__texturesIn = () => { const ms = sb.app.root.find(n => n.render).flatMap(n => n.render.meshInstances.map(mi => mi.material)); return ms.some(m => m && m.diffuseMap && /albedo/.test(m.diffuseMap.name)); };
  return true;
})()`;

const setLoadout = (cdp, sight) => cdp.eval(`localStorage.setItem('sb-loadout', JSON.stringify({ sight: '${sight}' })); localStorage.setItem('sb-howto', '1'); true`);

async function practice(cdp, { sight = 'iron', tier = 'low', map = 'greybox', side = 'defenders' }) {
    await setLoadout(cdp, sight);
    const url = `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Shot&practice=1&side=${side}&map=${map}&server=${encodeURIComponent(SERVER)}&res=1&tier=${tier}`;
    await cdp.send('Page.navigate', { url });
    await waitFor(cdp, 'window.__sb && window.__sb.mapData && window.__sb.stats().alive', 120000, 'spawn');
    await cdp.eval(HOOKS);
    await cdp.eval('document.body.classList.add("no-stats"); true');
    await waitFor(cdp, '__texturesIn()', 60000, 'weapon textures');
    // Face the practice targets, a little down, and settle.
    await cdp.eval(`(async () => {
      const sb = window.__sb;
      const rs = sb.app.root.find(n => n.name === 'remote' && n.enabled);
      if (rs.length) {
        let x = 0, z = 0; for (const r of rs) { const p = r.getPosition(); x += p.x; z += p.z; }
        x = x / rs.length - sb.state.pos[0]; z = z / rs.length - sb.state.pos[2];
        sb.input.yaw = Math.atan2(-x, -z); sb.input.pitch = -0.03;
      }
      await __frames(40); return true; })()`);
}

async function aimShot(cdp, name, ticks) {
    await cdp.eval(`(async () => { __key('KeyZ', true); await __freezeWhen(() => window.__sb.stats().loadout.aim >= ${ticks}); await __frames(1); return true; })()`);
    await sleep(200);
    await shoot(cdp, name);
    const aimAlone = await cdp.eval('(async () => { await __thaw(2); return __drawsAlone(); })()');
    await cdp.eval(`(async () => { __key('KeyZ', false); await __frames(25); return true; })()`);
    return aimAlone;
}

/** Fires a few rounds, presses R and freezes the reload at each fraction in `at`, shooting each. */
async function reloadShots(cdp, prefix, reloadTicks, at) {
    await cdp.eval(`(async () => { __key('KeyF', true); await __frames(30); __key('KeyF', false); await __frames(20); return true; })()`);
    await cdp.eval(`__tap('KeyR')`);
    for (const [frac, tag] of at) {
        await cdp.eval(`(async () => { await __freezeWhen(() => { const g = window.__sb.stats().gun; return g && g.reload > 0 && 1 - g.reload / ${reloadTicks} >= ${frac}; }); await __frames(1); return true; })()`);
        await sleep(200);
        await shoot(cdp, `${prefix}-${tag}`);
        await cdp.eval('__thaw(1)');
    }
    await cdp.eval('__frames(160)');
}

/** A scripted player (tools/bot.ts) in `room`, standing still. */
function bot(room, name, flags, sight = 0) {
    const url = `${SERVER}/?name=${name}&room=${room}&map=greybox&sight=${sight}`;
    return spawn(process.execPath, ['--import', 'tsx', 'tools/bot.ts', '--still', ...flags], {
        env: { ...process.env, SB_SERVER_URL: url }, stdio: 'ignore'
    });
}
function rawPlayer(room, name, extra = '') {
    // The first player in a room creates it (and its options: `&suppressed=1`).
    const ws = new WebSocket(`${SERVER}/?room=${room}&name=${name}&map=greybox${extra}`);
    return { ws, opened: new Promise(r => ws.once('open', r)) };
}

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-weapons-${process.pid}`);
    const chrome = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
        '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio', '--no-first-run',
        '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', 'about:blank'
    ], { stdio: 'ignore' });
    const report = { drawCalls: {}, notes: [] };
    const kids = [], raws = [];
    try {
        const cdp = new Cdp(await cdpConnect());
        await cdp.open;
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.navigate', { url: `${CLIENT}/?desktop=1` });
        await waitFor(cdp, 'document.readyState === "complete"', 30000, 'page');

        if (!ONLY || ONLY === 'fp') {
            // ---- rifle: each sight, hip and aimed (Low, Test Map 1)
            for (const [sight, ticks] of [['iron', 12], ['reddot', 12], ['scope2x', 16]]) {
                console.log(`rifle ${sight}`);
                await practice(cdp, { sight });
                const hip = await cdp.eval('__drawsAlone()');
                await shoot(cdp, `10-rifle-${sight}-hip`);
                const aimed = await aimShot(cdp, `11-rifle-${sight}-aimed`, ticks);
                report.drawCalls[`rifle ${sight}`] = { hipWithoutOtherPlayers: hip, aimedWithoutOtherPlayers: aimed };
                if (sight === 'iron') {
                    await reloadShots(cdp, '12-rifle-reload', 132, [[0.2, 'a-magazine-out'], [0.5, 'b-new-magazine'], [0.885, 'c-bolt-pulled']]);
                }
                if (sight === 'scope2x') await aimShot(cdp, '11-rifle-scope2x-aiming-in', 8);
            }
            // ---- pistol and knife (Low)
            console.log('pistol and knife');
            await practice(cdp, { sight: 'iron' });
            await cdp.eval(`(async () => { await __tap('Digit2'); await __frames(40); return true; })()`);
            report.drawCalls.pistolHip = await cdp.eval('__drawsAlone()');
            await shoot(cdp, '20-pistol-hip');
            await aimShot(cdp, '21-pistol-aimed', 8);
            await reloadShots(cdp, '22-pistol-reload', 84, [[0.3, 'a-magazine-out'], [0.6, 'b-new-magazine'], [0.76, 'c-slide-back']]);
            await cdp.eval(`(async () => { await __tap('Digit3'); await __frames(40); return true; })()`);
            report.drawCalls.knifeIdle = await cdp.eval('__drawsAlone()');
            await shoot(cdp, '30-knife-idle');
            await cdp.eval(`(async () => { __key('KeyF', true); await __frames(2); __key('KeyF', false); await __freezeWhen(() => { const k = window.__sb.stats().loadout.knife; return k.windup === 0 && k.cooldown > 0 && k.cooldown <= 27; }); await __frames(2); return true; })()`).catch(() => {});
            await sleep(200);
            await shoot(cdp, '31-knife-swing');
            await cdp.eval('__thaw(30)');
            // ---- a ghost's knife (the same rig, the dark suit)
            console.log('ghost knife');
            await practice(cdp, { side: 'ghosts' });
            await shoot(cdp, '32-ghost-knife-idle');
            // ---- High tier and Warehouse lighting
            for (const [tier, map, sight] of [['high', 'greybox', 'reddot'], ['low', 'warehouse', 'iron'], ['high', 'warehouse', 'scope2x']]) {
                console.log(`${tier} ${map} ${sight}`);
                await practice(cdp, { sight, tier, map });
                await shoot(cdp, `40-${tier}-${map}-${sight}-hip`);
                await aimShot(cdp, `41-${tier}-${map}-${sight}-aimed`, sight === 'scope2x' ? 16 : 12);
                if (tier === 'high' && map === 'greybox') {
                    await cdp.eval(`(async () => { await __tap('Digit2'); await __frames(40); return true; })()`);
                    await shoot(cdp, `42-high-greybox-pistol-hip`);
                    await cdp.eval(`(async () => { await __tap('Digit3'); await __frames(40); return true; })()`);
                    await shoot(cdp, `43-high-greybox-knife-idle`);
                }
            }
        }

        if (!ONLY || ONLY === 'tp') {
            // ---- third person: scripted defenders seen by a ghost (rooms hold 6, teams alternate by join order)
            const rooms = [
                [['reddot', [], 1], ['scope', [], 2], ['pistol', ['--pistol'], 0]],
                [['knife', ['--knife'], 0], ['suppressed-reddot', [], 1]]
            ];
            for (let ri = 0; ri < rooms.length; ri++) {
                console.log(`third person room ${ri}`);
                const room = `weapons-${process.pid}-${ri}`;
                const ids = {};
                const spec = rooms[ri];
                const fill = rawPlayer(room, 'Filler', ri === 1 ? '&suppressed=1' : ''); await fill.opened; raws.push(fill); await sleep(300);
                kids.push(bot(room, spec[0][0], spec[0][1], spec[0][2])); await sleep(1500);
                await cdp.send('Page.navigate', { url: `${CLIENT}/?auto=1&quiet=1&desktop=1&name=Watcher&room=${room}&map=greybox&server=${encodeURIComponent(SERVER)}&res=1&tier=low` });
                await waitFor(cdp, 'window.__sb && window.__sb.mapData && window.__sb.stats().alive', 90000, 'ghost spawn');
                for (let k = 1; k < spec.length; k++) {
                    kids.push(bot(room, spec[k][0], spec[k][1], spec[k][2])); await sleep(1200);
                    const f = rawPlayer(room, `Filler${k}`); await f.opened; raws.push(f); await sleep(400);
                }
                await sleep(2500);
                await cdp.eval(HOOKS);
                await cdp.eval('document.body.classList.add("no-stats"); true');
                await waitFor(cdp, '__texturesIn()', 60000, 'weapon textures');
                await cdp.eval('__frames(30)');
                const list = await cdp.eval(`(() => { const sb = window.__sb; return [...sb.net.interpolate()].filter(r => r.team === 'defenders' && r.alive).map(r => ({ id: r.id, pos: [...r.pos], yaw: r.yaw, weapon: r.weapon })); })()`);
                // Defenders join in the order of `spec`, so their ids come in that order too.
                list.sort((x, y) => x.id - y.id);
                report.notes.push(`third person room ${ri}: ${JSON.stringify(list.map((d, i) => ({ id: d.id, as: spec[i]?.[0], weapon: d.weapon })))}`);
                await cdp.eval(`(() => {
                  const sb = window.__sb; const cam = sb.app.root.findByName('camera');
                  window.__shotCam = null;
                  sb.app.on('update', () => { const c = window.__shotCam; if (c) { cam.setPosition(c[0], c[1], c[2]); cam.setEulerAngles(c[3], c[4], 0); } });
                  return true; })()`);
                for (let i = 0; i < list.length; i++) {
                    const d = list[i];
                    const name = spec[i]?.[0] ?? `id${d.id}`;
                    const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw);
                    const rx = Math.cos(d.yaw), rz = -Math.sin(d.yaw);
                    for (const [tag, f, r, h, dist] of [['front', 1.4, 0.9, 1.45, 0], ['side', 0.25, 0.9, 1.42, 1]]) {
                        const px = d.pos[0] + fx * f + rx * r, pz = d.pos[2] + fz * f + rz * r, py = d.pos[1] + h;
                        const tx = d.pos[0] + fx * (0.25 * dist) + rx * 0.12, tz = d.pos[2] + fz * (0.25 * dist) + rz * 0.12, ty = d.pos[1] + 1.32;
                        const yawDeg = Math.atan2(-(tx - px), -(tz - pz)) * 180 / Math.PI;
                        const pitchDeg = Math.atan2(ty - py, Math.hypot(tx - px, tz - pz)) * 180 / Math.PI;
                        await cdp.eval(`window.__shotCam = [${px}, ${py}, ${pz}, ${pitchDeg}, ${yawDeg}]; __frames(20)`);
                        await shoot(cdp, `50-third-person-${name}-${tag}`);
                    }
                }
                for (const r of raws.splice(0)) try { r.ws.close(); } catch { /* gone */ }
                for (const k of kids.splice(0)) try { k.kill(); } catch { /* gone */ }
                await sleep(800);
            }
        }
        writeFileSync(join(OUT, ONLY ? `report-${ONLY}.json` : 'report.json'), JSON.stringify(report, null, 1));
        console.log(JSON.stringify(report, null, 1));
        cdp.ws.close();
    } finally {
        for (const r of raws) try { r.ws.close(); } catch { /* gone */ }
        for (const k of kids) try { k.kill(); } catch { /* gone */ }
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exit(1); });
