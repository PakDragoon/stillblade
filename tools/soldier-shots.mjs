// Review screenshots for package O (realistic soldiers), taken in headless Chrome over the DevTools protocol against a
// scratch game server and Vite (never the owner's ports 8080 / 5173). Headless Chrome renders with SwiftShader
// (software GL): looks only, frame times mean nothing.
//
//   SB_SERVER_PORT=8098 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5198 --strictPort                   (another)
//   node tools/soldier-shots.mjs [--out docs/review/soldiers] [--only fp|tp]
//
// First person: the practice range as a defender (hip and aimed with each sight, frozen mid-reload, the knife frozen
// mid-swing) and as a ghost (the dark knife arms), real input dispatched on the page. Third person: practice-range
// targets (defenders seen from a ghost's page, fully visible ghosts from a defender's page) with a free camera; their
// poses (weapon in hand, aiming, crouched, reloading, dead) are STAGED by replacing that target's view fields in the
// frame the presenter receives, and swings are started with presenter.remoteSwing, because practice targets never
// fight. Low and High tiers, Test Map 1 and Warehouse.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/soldiers'));
const CLIENT = arg('client', 'http://localhost:5198');
const SERVER = arg('server', 'ws://localhost:8098');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9238'));
const ONLY = arg('only', '');
/** Field of view setting (degrees) for the first-person pictures; file names get `-fov<N>` when given. */
const FOV = arg('fov', '');
/** Skip the extra tiers and maps of the first-person set (40-43). */
const QUICK = process.argv.includes('--quick');
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
    if (FOV) name = `${name}-fov${FOV}`;
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

const setLoadout = (cdp, sight) => cdp.eval(`localStorage.setItem('sb-loadout', JSON.stringify({ sight: '${sight}' })); localStorage.setItem('sb-howto', '1');${FOV ? ` localStorage.setItem('sb-settings', JSON.stringify({ fov: ${Number(FOV)} }));` : ''} true`);

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


// ---- Third person (package O): practice-range targets, posed by overriding their view state ------------------------
const TP_HOOKS = `(() => {
  const sb = window.__sb;
  // Poses: the target's RemoteView fields replaced in the frame the presenter receives (staged, see the README).
  window.__pose = null;
  const frame = sb.presenter.frame;
  sb.presenter.frame = (dt, l, r, m) => {
    const p = window.__pose;
    if (p && !window.__hide) r = r.map(v => v.id === p.id ? Object.assign({}, v, p.v) : v);
    return frame(dt, l, r, m);
  };
  // No first-person weapon in third-person pictures.
  const vm = sb.app.scene.layers.getLayerByName('Viewmodel');
  const cam = sb.app.root.findByName('camera');
  cam.camera.layers = cam.camera.layers.filter(id => id !== vm.id);
  window.__shotCam = null;
  sb.app.on('update', () => { const c = window.__shotCam; if (c) { cam.setPosition(c[0], c[1], c[2]); cam.setEulerAngles(c[3], c[4], 0); } });
  return true;
})()`;

/** The practice target that moved least over a second (standing targets do not strafe). */
const PICK_TARGET = `(async () => {
  const sb = window.__sb;
  const a = new Map([...sb.net.interpolate()].map(r => [r.id, [...r.pos]]));
  await __frames(60);
  let best = null, bd = 1e9;
  for (const r of sb.net.interpolate()) {
    const p0 = a.get(r.id); if (!p0 || !r.alive) continue;
    const d = Math.hypot(r.pos[0] - p0[0], r.pos[2] - p0[2]) + 0.02 * Math.hypot(r.pos[0] - sb.state.pos[0], r.pos[2] - sb.state.pos[2]);
    if (d < bd) { bd = d; best = { id: r.id, pos: [...r.pos], yaw: r.yaw, team: r.team }; }
  }
  return best;
})()`;

function camAround(t, view, dist = 2.6, h = 1.25, aimH = 0.95) {
    const ang = { front: 0, side: Math.PI / 2, back: Math.PI, q: Math.PI / 5, above: 0.6 }[view];
    const fx = -Math.sin(t.yaw + ang), fz = -Math.cos(t.yaw + ang);
    const up = view === 'above' ? 2.6 : h;
    const d = view === 'above' ? 2.2 : dist;
    const px = t.pos[0] + fx * d, pz = t.pos[2] + fz * d, py = t.pos[1] + up;
    const tx = t.pos[0], tz = t.pos[2], ty = t.pos[1] + (view === 'above' ? 0.2 : aimH);
    const yawDeg = Math.atan2(-(tx - px), -(tz - pz)) * 180 / Math.PI;
    const pitchDeg = Math.atan2(ty - py, Math.hypot(tx - px, tz - pz)) * 180 / Math.PI;
    return [px, py, pz, pitchDeg, yawDeg];
}

async function tpPose(cdp, t, v, waitFrames = 40) {
    await cdp.eval(`window.__pose = { id: ${t.id}, v: ${JSON.stringify(v)} }; __frames(${waitFrames})`);
}

async function tpShots(cdp, t, prefix, views) {
    for (const view of views) {
        await cdp.eval(`window.__shotCam = ${JSON.stringify(camAround(t, view))}; __frames(3)`);
        await shoot(cdp, `${prefix}-${view}`);
    }
}

/** Freezes time `seconds` after `setup` ran (a reload, a swing, a death), shoots, thaws. */
async function frozenAfter(cdp, seconds, name) {
    await cdp.eval(`(async () => { const sb = window.__sb; const t0 = sb.app.stats.frame.time; let t = 0; await new Promise(res => { const h = (dt) => { t += dt; if (t >= ${seconds}) { sb.app.off('update', h); sb.app.timeScale = 0; res(); } }; sb.app.on('update', h); }); await __frames(2); return true; })()`);
    await sleep(150);
    await shoot(cdp, name);
    await cdp.eval('__thaw(2)');
}

async function thirdPerson(cdp, report, { tier, map }) {
    const tag = `${tier}-${map}`;
    // Defenders, seen from a ghost's page.
    console.log(`third person defenders ${tag}`);
    await practice(cdp, { side: 'ghosts', tier, map });
    await cdp.eval(TP_HOOKS);
    await waitFor(cdp, `window.__sb.app.root.find(n => n.render).some(n => n.render.meshInstances.some(mi => mi.material && mi.material.diffuseMap && /character_albedo/.test(mi.material.diffuseMap.name)))`, 60000, 'character textures');
    const all = await cdp.eval('__draws()');
    const alone = await cdp.eval('__drawsAlone()');
    const n = await cdp.eval('[...window.__sb.net.interpolate()].filter(r => r.alive).length');
    report.drawCalls[`third person ${tag} defenders`] = { frame: all, withoutPlayers: alone, players: n, perPlayer: (all - alone) / Math.max(1, n) };
    const t = await cdp.eval(PICK_TARGET);
    const base = { crouched: false, alive: true, reloading: false, switching: false, aiming: false, pitch: 0 };
    const views = tier === 'low' && map === 'greybox' ? ['front', 'side', 'back'] : ['front', 'q'];
    await tpPose(cdp, t, { ...base, weapon: 0 });
    await tpShots(cdp, t, `60-${tag}-defender-rifle`, views);
    if (tier === 'low' && map === 'greybox') {
        await tpPose(cdp, t, { ...base, weapon: 0, aiming: true }, 30);
        await tpShots(cdp, t, `61-${tag}-defender-rifle-aiming`, ['side', 'q']);
        await tpPose(cdp, t, { ...base, weapon: 1 });
        await tpShots(cdp, t, `62-${tag}-defender-pistol`, ['front', 'side', 'q']);
        await tpPose(cdp, t, { ...base, weapon: 2 });
        await tpShots(cdp, t, `63-${tag}-defender-knife`, ['front', 'q']);
        await tpPose(cdp, t, { ...base, weapon: 0, crouched: true });
        await tpShots(cdp, t, `64-${tag}-defender-crouched-rifle`, ['front', 'side']);
        await tpPose(cdp, t, { ...base, weapon: 1, crouched: true });
        await tpShots(cdp, t, `64-${tag}-defender-crouched-pistol`, ['side']);
        // Reloads: the clip starts on the rising edge of `reloading`.
        await tpPose(cdp, t, { ...base, weapon: 0 }, 20);
        await cdp.eval(`window.__shotCam = ${JSON.stringify(camAround(t, 'q', 2.2))}; window.__pose.v.reloading = true; true`);
        await frozenAfter(cdp, 0.8, `65-${tag}-defender-reload-rifle-magazine`);
        await cdp.eval('(async () => { window.__pose.v.reloading = false; await __frames(30); return true; })()');
        await tpPose(cdp, t, { ...base, weapon: 1 }, 20);
        await cdp.eval(`window.__pose.v.reloading = true; true`);
        await frozenAfter(cdp, 1.05, `65-${tag}-defender-reload-pistol-slide`);
        await cdp.eval('(async () => { window.__pose.v.reloading = false; await __frames(30); return true; })()');
        // The defender knife swing: the windup sound starts it, the slash event lands it.
        await tpPose(cdp, t, { ...base, weapon: 2 }, 20);
        await cdp.eval(`window.__sb.presenter.remoteSwing(${t.id}); true`);
        await frozenAfter(cdp, 0.26, `66-${tag}-defender-knife-swing`);
        // A corpse (the death clip, then lying).
        await tpPose(cdp, t, { ...base, weapon: 0, alive: false }, 2);
        await cdp.eval(`window.__shotCam = ${JSON.stringify(camAround(t, 'above'))}; true`);
        await frozenAfter(cdp, 1.6, `67-${tag}-defender-corpse`);
    }
    await cdp.eval('window.__pose = null; __frames(5)');

    // Ghosts, seen from a defender's page (practice targets are drawn fully visible).
    console.log(`third person ghosts ${tag}`);
    await practice(cdp, { side: 'defenders', tier, map });
    await cdp.eval(TP_HOOKS);
    const g = await cdp.eval(PICK_TARGET);
    await tpPose(cdp, g, { ...base, weapon: 0 });
    await tpShots(cdp, g, `70-${tag}-ghost`, views);
    if (tier === 'low' && map === 'greybox') {
        await tpPose(cdp, g, { ...base, weapon: 0, crouched: true });
        await tpShots(cdp, g, `71-${tag}-ghost-crouched`, ['side']);
        await tpPose(cdp, g, { ...base, weapon: 0 }, 10);
        await cdp.eval(`window.__shotCam = ${JSON.stringify(camAround(g, 'q', 2.2))}; window.__sb.presenter.remoteSwing(${g.id}); true`);
        await frozenAfter(cdp, 0.26, `72-${tag}-ghost-knife-swing`);
        await cdp.eval('__frames(40)');
        await tpPose(cdp, g, { ...base, alive: false }, 2);
        await cdp.eval(`window.__shotCam = ${JSON.stringify(camAround(g, 'above'))}; true`);
        await frozenAfter(cdp, 1.6, `73-${tag}-ghost-corpse`);
        // A ghost at a running shimmer (0.35), how it reads in play.
        await tpPose(cdp, g, { ...base, vis: 0.35 }, 20);
        await tpShots(cdp, g, `74-${tag}-ghost-shimmer-0.35`, ['front']);
    }
    await cdp.eval('window.__pose = null; __frames(5)');
}

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-soldiers-${process.pid}`);
    const chrome = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
        '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio', '--no-first-run',
        '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', 'about:blank'
    ], { stdio: 'ignore' });
    const report = { drawCalls: {}, notes: [] };
    try {
        const cdp = new Cdp(await cdpConnect());
        await cdp.open;
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.navigate', { url: `${CLIENT}/?desktop=1` });
        await waitFor(cdp, 'document.readyState === "complete"', 30000, 'page');

        if (!ONLY || ONLY === 'fp') {
            for (const [sight, ticks] of [['iron', 12], ['reddot', 12], ['scope2x', 16]]) {
                console.log(`rifle ${sight}`);
                await practice(cdp, { sight });
                const hip = await cdp.eval('__drawsAlone()');
                await shoot(cdp, `10-rifle-${sight}-hip`);
                const aimed = await aimShot(cdp, `11-rifle-${sight}-aimed`, ticks);
                report.drawCalls[`first person rifle ${sight}`] = { hipWithoutOtherPlayers: hip, aimedWithoutOtherPlayers: aimed };
                if (sight === 'iron') {
                    await reloadShots(cdp, '12-rifle-reload', 132, [[0.2, 'a-magazine-out'], [0.5, 'b-new-magazine'], [0.885, 'c-bolt-pulled']]);
                }
            }
            console.log('pistol and knife');
            await practice(cdp, { sight: 'iron' });
            await cdp.eval(`(async () => { await __tap('Digit2'); await __frames(40); return true; })()`);
            report.drawCalls['first person pistol'] = await cdp.eval('__drawsAlone()');
            await shoot(cdp, '20-pistol-hip');
            await aimShot(cdp, '21-pistol-aimed', 8);
            await reloadShots(cdp, '22-pistol-reload', 84, [[0.3, 'a-magazine-out'], [0.6, 'b-new-magazine'], [0.76, 'c-slide-back']]);
            await cdp.eval(`(async () => { await __tap('Digit3'); await __frames(40); return true; })()`);
            report.drawCalls['first person knife'] = await cdp.eval('__drawsAlone()');
            await shoot(cdp, '30-knife-idle');
            await cdp.eval(`(async () => { __key('KeyF', true); await __frames(2); __key('KeyF', false); await __freezeWhen(() => { const k = window.__sb.stats().loadout.knife; return k.windup === 0 && k.cooldown > 0 && k.cooldown <= 27; }); await __frames(2); return true; })()`).catch(() => {});
            await sleep(200);
            await shoot(cdp, '31-knife-swing');
            await cdp.eval('__thaw(30)');
            console.log('ghost knife');
            await practice(cdp, { side: 'ghosts' });
            await shoot(cdp, '32-ghost-knife-idle');
            await cdp.eval(`(async () => { __key('KeyF', true); await __frames(2); __key('KeyF', false); await __freezeWhen(() => { const k = window.__sb.knife; return k && k.windup === 0 && k.cooldown > 0 && k.cooldown <= 27; }); await __frames(2); return true; })()`).catch(() => {});
            await sleep(200);
            await shoot(cdp, '33-ghost-knife-swing');
            await cdp.eval('__thaw(30)');
            for (const [tier, map, sight] of QUICK ? [] : [['high', 'greybox', 'scope2x'], ['low', 'warehouse', 'iron'], ['high', 'warehouse', 'reddot']]) {
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
            for (const [tier, map] of [['low', 'greybox'], ['high', 'greybox'], ['low', 'warehouse'], ['high', 'warehouse']]) {
                await thirdPerson(cdp, report, { tier, map });
            }
        }
        writeFileSync(join(OUT, ONLY ? `report-${ONLY}.json` : 'report.json'), JSON.stringify(report, null, 1));
        console.log(JSON.stringify(report, null, 1));
        cdp.ws.close();
    } finally {
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
}

run().catch(err => { console.error(err); process.exit(1); });
