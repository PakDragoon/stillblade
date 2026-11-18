// Side-by-side review images for package Q: each picture in <before> next to the same picture in <after>, and for the
// first-person views a 3x nearest-neighbour crop of the weapon's edges (anti-aliasing: jagged before, smooth after).
// Composed on a canvas in headless Chrome (no image library needed). Not a pixel gate: lighting, reflections and AA
// change every pixel of the weapon on purpose, so the review is by eye (verify-pixels: "not byte-gateable").
//
//   node tools/compare-shots.mjs --before docs/review/polish/before --after docs/review/polish/after --out docs/review/polish/compare
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const BEFORE = resolve(arg('before', 'docs/review/polish/before'));
const AFTER = resolve(arg('after', 'docs/review/polish/after'));
const OUT = resolve(arg('out', 'docs/review/polish/compare'));
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = Number(arg('cdp', '9243'));
/** Crop of the weapon's top edge and the sight in the 1366 x 768 first-person pictures (x, y, w, h). */
const CROP = [760, 360, 300, 170];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    mkdirSync(OUT, { recursive: true });
    const profile = join(tmpdir(), `sb-compare-${process.pid}`);
    const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    try {
        let url = null;
        for (let i = 0; i < 50 && !url; i++) {
            try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ }
            if (!url) await sleep(200);
        }
        const ws = new WebSocket(url, { maxPayload: 512 * 1024 * 1024 });
        await new Promise(r => ws.once('open', r));
        let id = 0; const waiting = new Map();
        ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
        const evaluate = expr => new Promise((ok, fail) => {
            const n = ++id;
            waiting.set(n, m => (m.result?.exceptionDetails ? fail(new Error(m.result.exceptionDetails.exception?.description)) : ok(m.result?.result?.value)));
            ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
        });
        const names = readdirSync(AFTER).filter(f => f.endsWith('.jpg')).sort();
        for (const name of names) {
            let before;
            try { before = readFileSync(join(BEFORE, name)).toString('base64'); } catch { continue; }
            const after = readFileSync(join(AFTER, name)).toString('base64');
            const firstPerson = !name.includes('third-person');
            const out = await evaluate(`(async () => {
              const load = b => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/jpeg;base64,' + b; });
              const [a, b] = await Promise.all([load(${JSON.stringify(before)}), load(${JSON.stringify(after)})]);
              const half = 0.5, w = a.width * half, h = a.height * half, pad = 28;
              const crop = ${JSON.stringify(CROP)}, z = 3;
              const ch = ${firstPerson} ? crop[3] * z : 0;
              const c = document.createElement('canvas');
              c.width = w * 2 + 8; c.height = pad + h + (ch ? pad + ch : 0);
              const g = c.getContext('2d');
              g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
              g.fillStyle = '#eee'; g.font = '600 16px system-ui, sans-serif';
              g.fillText('BEFORE  ${name}', 8, 19); g.fillText('AFTER', w + 16, 19);
              g.drawImage(a, 0, pad, w, h); g.drawImage(b, w + 8, pad, w, h);
              if (ch) {
                g.fillText('weapon edges, 3x (nearest neighbour)', 8, pad + h + 19);
                g.imageSmoothingEnabled = false;
                const cw = Math.min(crop[2] * z, w);
                g.drawImage(a, crop[0], crop[1], cw / z, crop[3], 0, pad * 2 + h, cw, ch);
                g.drawImage(b, crop[0], crop[1], cw / z, crop[3], w + 8, pad * 2 + h, cw, ch);
              }
              return c.toDataURL('image/jpeg', 0.9).split(',')[1];
            })()`);
            writeFileSync(join(OUT, name), Buffer.from(out, 'base64'));
            console.log('  saved', name);
        }
        ws.close();
    } finally {
        chrome.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
    }
}
main().catch(e => { console.error(e); process.exit(1); });
