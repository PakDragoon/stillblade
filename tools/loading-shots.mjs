// Review screenshots and a network log for the loading screen (client/src/loading.ts, loading-ui.ts), taken in headless
// Chrome over the DevTools protocol against a scratch game server and Vite (never the owner's ports 8080 / 5173).
// The network is throttled (Chrome's own emulation) so the progress is visible; real slow connections were not tried.
//
//   SB_SERVER_PORT=8098 npx tsx server/src/main.ts      (one terminal)
//   npx vite --port 5198 --strictPort                   (another)
//   node tools/loading-shots.mjs --out docs/review/loading
//
// Scenarios, one Chrome profile (empty at the start, so the first is cold and the next ones warm):
//   cold   the menu (its "Preparing game files" line), then Quick play: the join's loading screen at several moments
//   warm   a room join by link (?auto=1&room=) with everything in the browser cache
//   change a map change between matches (the room's map message, delivered to the page's own handler)
//   fail   the lightmap blocked: "Download failed" with Try again; unblocked, Try again finishes the join
//   stall  the rifle's first-person hands held back for 12 s at phone width: the "taking longer" note and Play now
// The network log counts every request for a file under maps/, models/ or audio/ per scenario: each must be fetched once.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', 'docs/review/loading'));
const CLIENT = arg('client', 'http://localhost:5198');
const SERVER = arg('server', 'ws://localhost:8098');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9243'));
/** Throttled link: bytes per second down, round-trip latency (ms). */
const DOWN = Number(arg('down', String(4_000_000 / 8)));
const LATENCY = Number(arg('latency', '60'));
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
        this.listeners = new Map();
        this.ws.on('message', data => {
            const msg = JSON.parse(data.toString());
            if (msg.id && this.waiting.has(msg.id)) {
                const { ok, fail } = this.waiting.get(msg.id);
                this.waiting.delete(msg.id);
                if (msg.error) fail(new Error(JSON.stringify(msg.error))); else ok(msg.result);
            } else if (msg.method) {
                if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
                    console.log(`  [page ${msg.params.type}]`, msg.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300));
                } else if (msg.method === 'Runtime.exceptionThrown') {
                    console.log('  [page exception]', msg.params.exceptionDetails.exception?.description?.slice(0, 300));
                }
                for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
            }
        });
        this.open = new Promise(r => this.ws.once('open', r));
    }
    on(method, fn) { (this.listeners.get(method) ?? this.listeners.set(method, []).get(method)).push(fn); }
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
        await sleep(150);
    }
    throw new Error(`timed out waiting for ${what}`);
}

const log = { throttle: { bytesPerSecond: DOWN, latencyMs: LATENCY }, shots: [], network: {} };

async function shoot(cdp, name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    const state = await cdp.eval(`(() => { const s = document.querySelector('#loading-screen.open'); const p = document.querySelector('#load-prep');
        return { pct: s?.querySelector('.pct')?.textContent ?? null, now: s?.querySelector('.now')?.textContent ?? null,
            note: s?.querySelector('.note')?.textContent || null, prep: p && p.style.display !== 'none' ? p.textContent : null }; })()`).catch(() => ({}));
    log.shots.push({ name, ...state });
    console.log('  saved', name, JSON.stringify(state));
}

const LOADING_OPEN = `!!document.querySelector('#loading-screen.open')`;
const IN_GAME = `!!(window.__sb && window.__sb.mapData) && !document.querySelector('#loading-screen.open')`;

/** Screenshots every `every` ms while the loading screen is up (at most `max`), then one of the game. */
async function shootLoading(cdp, prefix, every, max) {
    await waitFor(cdp, LOADING_OPEN, 30000, 'loading screen');
    let n = 0;
    while (n < max && await cdp.eval(LOADING_OPEN)) {
        await shoot(cdp, `${prefix}-${String(++n).padStart(2, '0')}`);
        await sleep(every);
    }
    await waitFor(cdp, IN_GAME, 180000, 'the game');
}

/** Counts requests per asset file from now until `stop()`. */
function netLog(cdp, scenario) {
    const counts = new Map();
    const ids = new Set();
    let on = true, wire = 0, fromCache = 0;
    cdp.on('Network.requestWillBeSent', p => {
        if (!on) return;
        const u = new URL(p.request.url);
        if (!/\/(maps|models|audio)\//.test(u.pathname)) return;
        ids.add(p.requestId);
        counts.set(u.pathname, (counts.get(u.pathname) ?? 0) + 1);
    });
    // Bytes over the wire per finished request: a revalidated (304) or disk-cached file costs only its headers.
    cdp.on('Network.loadingFinished', p => {
        if (!on || !ids.has(p.requestId)) return;
        wire += p.encodedDataLength;
        if (p.encodedDataLength < 2000) fromCache++;
    });
    return () => {
        on = false;
        const files = [...counts.entries()].sort();
        const dup = files.filter(([, c]) => c > 1);
        log.network[scenario] = {
            files: files.length, requests: files.reduce((s, [, c]) => s + c, 0), duplicates: dup,
            bytesOverWire: wire, answeredFromCache: fromCache, list: Object.fromEntries(files)
        };
        console.log(`  network ${scenario}: ${files.length} files, ${log.network[scenario].requests} requests, duplicates ${JSON.stringify(dup)}, ` +
            `${(wire / 1e6).toFixed(2)} MB over the wire, ${fromCache} answered from cache`);
    };
}

const throttle = (cdp, on) => cdp.send('Network.emulateNetworkConditions', on
    ? { offline: false, latency: LATENCY, downloadThroughput: DOWN, uploadThroughput: DOWN }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

const page = q => `${CLIENT}/?desktop=1&quiet=1&tier=low&server=${encodeURIComponent(SERVER)}${q}`;

async function run() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-loading-${process.pid}`);
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
        await cdp.send('Network.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

        // ---- cold: the menu, then Quick play -------------------------------------------------------------------
        console.log('cold first load');
        await throttle(cdp, true);
        let stop = netLog(cdp, 'cold (menu, then Quick play)');
        await cdp.send('Page.navigate', { url: page('&name=Cold') });
        await waitFor(cdp, `!!document.querySelector('#menu-screen.open')`, 30000, 'menu');
        await sleep(1200);
        await shoot(cdp, 'cold-00-menu');
        await sleep(2500);
        await shoot(cdp, 'cold-00-menu-later');
        await cdp.eval(`[...document.querySelectorAll('#menu-screen button')].find(b => b.textContent.includes('Quick play')).click(); true`);
        await shootLoading(cdp, 'cold-join', 900, 14);
        await shoot(cdp, 'cold-zz-in-game');
        stop();

        // ---- warm: a room join by link, everything cached ------------------------------------------------------
        console.log('warm room join');
        stop = netLog(cdp, 'warm (room link)');
        await cdp.send('Page.navigate', { url: page('&auto=1&room=shots-warm&name=Warm') });
        await shootLoading(cdp, 'warm-join', 250, 8);
        await shoot(cdp, 'warm-zz-in-game');
        stop();

        // ---- a map change between matches (the room's map message, to the page's own handler) ------------------
        console.log('map change');
        stop = netLog(cdp, 'map change to Test Map 1');
        await cdp.eval(`window.__sb.net.handlers.map({ type: 'map', map: 'greybox', mapName: 'Test Map 1' }); true`);
        await shootLoading(cdp, 'change', 500, 8);
        await shoot(cdp, 'change-zz-after');
        stop();
        await throttle(cdp, false);

        // ---- fail: the lightmap blocked, then Try again --------------------------------------------------------
        console.log('failed download and retry');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Network.setBlockedURLs', { urls: ['*warehouse_baked.webp*'] });
        stop = netLog(cdp, 'blocked lightmap, then Try again');
        await cdp.send('Page.navigate', { url: page('&auto=1&room=shots-fail&name=Fail&map=warehouse') });
        await waitFor(cdp, `(document.querySelector('#loading-screen .now')?.textContent ?? '').startsWith('Download failed')`, 60000, 'the failure');
        await sleep(400);
        await shoot(cdp, 'fail-1-download-failed');
        await cdp.send('Network.setBlockedURLs', { urls: [] });
        await cdp.eval(`[...document.querySelectorAll('#loading-screen button')].find(b => b.textContent === 'Try again').click(); true`);
        await sleep(300);
        await shoot(cdp, 'fail-2-retrying');
        await waitFor(cdp, IN_GAME, 120000, 'the game after Try again');
        await shoot(cdp, 'fail-3-in-game');
        stop();

        // ---- stall: the rifle's hands held back, phone width ---------------------------------------------------
        console.log('stalled download at phone width');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*viewmodel_rifle.glb*', requestStage: 'Request' }] });
        const held = [];
        cdp.on('Fetch.requestPaused', p => held.push(p.requestId));
        stop = netLog(cdp, 'held rifle hands (phone width)');
        await cdp.send('Page.navigate', { url: page('&auto=1&room=shots-stall&name=Stall&map=warehouse') });
        await waitFor(cdp, LOADING_OPEN, 30000, 'loading screen');
        await sleep(2500);
        await shoot(cdp, 'stall-1-phone-loading');
        await waitFor(cdp, `!!document.querySelector('#loading-screen .note') && document.querySelector('#loading-screen .note').style.display !== 'none'`, 40000, 'the stall note');
        await shoot(cdp, 'stall-2-taking-longer');
        for (const id of held) await cdp.send('Fetch.continueRequest', { requestId: id });
        await cdp.send('Fetch.disable');
        await waitFor(cdp, IN_GAME, 120000, 'the game after the stall');
        await shoot(cdp, 'stall-3-in-game');
        stop();
    } finally {
        writeFileSync(join(OUT, 'log.json'), JSON.stringify(log, null, 2));
        chrome.kill();
    }
}

run().then(() => process.exit(0), err => { console.error(err); writeFileSync(join(OUT, 'log.json'), JSON.stringify(log, null, 2)); process.exit(1); });
