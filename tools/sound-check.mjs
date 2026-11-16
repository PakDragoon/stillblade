// Measures sound levels and takes the sound test page screenshot in headless Chrome (package H). Nobody listens: each
// case is rendered through the real engine into an OfflineAudioContext and the peak / RMS of the output are printed.
//
//   npx vite --port 5192 --strictPort            (never the owner's 5173; the sound test page needs no game server)
//   node tools/sound-check.mjs [--client http://localhost:5192] [--shot docs/review/sounds/soundtest.png] [--json out.json]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const CLIENT = arg('client', 'http://localhost:5192');
const SHOT = arg('shot', '');
const JSON_OUT = arg('json', '');
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9293'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'sb-sound-'));
const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required', '--window-size=1000,1500', 'about:blank'
], { stdio: 'ignore' });

async function connect() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = list.find(t => t.type === 'page');
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* not up yet */ }
        await sleep(250);
    }
    throw new Error('Chrome did not start');
}

let id = 0;
const waiting = new Map();
let ws;
const send = (method, params = {}) => new Promise((ok, fail) => {
    const i = ++id;
    waiting.set(i, { ok, fail });
    ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
};

try {
    ws = new WebSocket(await connect(), { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise(r => ws.on('open', r));
    ws.on('message', d => {
        const m = JSON.parse(d.toString());
        if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); if (m.error) w.fail(new Error(JSON.stringify(m.error))); else w.ok(m.result); }
        else if (m.method === 'Runtime.exceptionThrown') console.log('[page exception]', m.params.exceptionDetails.exception?.description?.slice(0, 300));
        else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log('[page error]', m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300));
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `${CLIENT}/?soundtest=1` });
    for (let i = 0; i < 100; i++) { if (await evaluate('!!window.__soundtest')) break; await sleep(200); }

    // Cases: [label, spec]. Each is measured with the synthesised sound and (when files are shipped) the recorded one.
    const cases = [
        ['step run 1 m', { event: 'step', dist: 1, loud: 1 }], ['step run 5 m', { event: 'step', dist: 5, loud: 1 }],
        ['step run 10 m', { event: 'step', dist: 10, loud: 1 }], ['step run 15 m', { event: 'step', dist: 15, loud: 1 }],
        ['step run 17.5 m', { event: 'step', dist: 17.5, loud: 1 }],
        ['step walk 2 m', { event: 'step', dist: 2, loud: 0.3 }], ['step walk 5 m', { event: 'step', dist: 5, loud: 0.3 }],
        ['step crouch 1.5 m', { event: 'step', dist: 1.5, loud: 0.18 }], ['step crouch 3 m', { event: 'step', dist: 3, loud: 0.18 }],
        ['step run 5 m metal', { event: 'step', dist: 5, loud: 1, surface: 'metal' }],
        ['step run 5 m wood', { event: 'step', dist: 5, loud: 1, surface: 'wood' }],
        ['step run 5 m behind wall', { event: 'step', dist: 5, loud: 1, wall: true }],
        ['rifle loud 5 m', { event: 'shot', dist: 5, weapon: 0 }], ['rifle loud 20 m', { event: 'shot', dist: 20, weapon: 0 }],
        ['rifle loud 50 m', { event: 'shot', dist: 50, weapon: 0 }], ['rifle loud 59 m', { event: 'shot', dist: 59, weapon: 0 }],
        ['rifle suppressed 5 m', { event: 'shot', dist: 5, weapon: 0, suppressed: true }], ['rifle suppressed 15 m', { event: 'shot', dist: 15, weapon: 0, suppressed: true }],
        ['pistol loud 5 m', { event: 'shot', dist: 5, weapon: 1 }], ['pistol suppressed 5 m', { event: 'shot', dist: 5, weapon: 1, suppressed: true }],
        ['reload rifle 3 m', { event: 'reload', dist: 3, weapon: 0 }], ['reload rifle 9 m', { event: 'reload', dist: 9, weapon: 0 }],
        ['knife windup 5 m', { event: 'knifeWindup', dist: 5 }], ['knife windup 13 m', { event: 'knifeWindup', dist: 13 }],
        ['impact 5 m', { event: 'impact', dist: 5 }], ['impact 20 m', { event: 'impact', dist: 20 }],
        ['bomb beep 10 m', { event: 'beep', dist: 10 }], ['bomb beep 30 m', { event: 'beep', dist: 30 }],
    ];
    const variants = [['synth', { recorded: false }], ['recorded', { recorded: true }], ['rec, no gun layer', { recorded: true, gunLayer: false }]];
    const results = [];
    const f = x => (Number.isFinite(x) ? x.toFixed(1) : '-inf').padStart(6);
    console.log('case'.padEnd(28) + variants.map(([n]) => n.padStart(22)).join(''));
    console.log(''.padEnd(28) + variants.map(() => '        peak     rms  ').join(''));
    for (const [label, spec] of cases) {
        let line = label.padEnd(28);
        const row = { label };
        for (const [vn, vs] of variants) {
            if (vn.includes('gun layer') && spec.event !== 'shot') { line += ''.padStart(22); continue; }
            const r = await evaluate(`window.__soundtest.measure(${JSON.stringify({ ...spec, ...vs })})`);
            row[vn] = r;
            line += `${f(r.peakDb)} ${f(r.rmsDb)}`.padStart(22);
        }
        console.log(line);
        results.push(row);
    }
    console.log(`\nsamples loaded by the page's own engine: ${JSON.stringify(await evaluate('window.__soundtest.engine.sampleStatus()'))}`);
    if (JSON_OUT) { mkdirSync(dirname(resolve(JSON_OUT)), { recursive: true }); writeFileSync(resolve(JSON_OUT), JSON.stringify(results, null, 1)); }

    if (SHOT) {
        // A real unlock gesture would start the page's own engine loading; wait for that, then shoot.
        await evaluate('window.__soundtest.engine.unlock()');
        await evaluate('window.__soundtest.engine.whenLoaded()');
        await sleep(600);
        await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1500, deviceScaleFactor: 1, mobile: false });
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        mkdirSync(dirname(resolve(SHOT)), { recursive: true });
        writeFileSync(resolve(SHOT), Buffer.from(shot.data, 'base64'));
        console.log(`screenshot: ${resolve(SHOT)}`);
    }
} finally {
    try { ws?.close(); } catch { /* done */ }
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
}
