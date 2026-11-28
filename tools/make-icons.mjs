// Renders every browser and home-screen icon from the one source, client/public/favicon.svg, plus the review
// pictures in docs/review/favicon/. Uses the installed Chrome headless over the DevTools protocol (as the other
// screenshot tools do): no extra dependency, no server, no network.
//
//   node tools/make-icons.mjs [--chrome <path to chrome>]
//
// Writes client/public/{favicon-16.png, favicon-32.png, favicon.ico (16, 32, 48), apple-touch-icon.png (180, square,
// no alpha channel), icon-192.png, icon-512.png}. The PNG bytes can differ between Chrome versions.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const WebSocket = createRequire(import.meta.url)('ws');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PUBLIC = fileURLToPath(new URL('../client/public/', import.meta.url));
const REVIEW = fileURLToPath(new URL('../docs/review/favicon/', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SVG = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8');
// iOS rounds the corners itself and shows transparency as black, so its icon is the same drawing on a square tile.
const SQUARE_SVG = SVG.replace(/(<rect id="tile"[^>]*?) rx="[^"]*"/, '$1');
if (SQUARE_SVG === SVG) throw new Error('favicon.svg: no <rect id="tile" ... rx="..."> to square off');

const dataUrl = (type, bytes) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

// ---- Chrome

async function startChrome() {
    if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; pass --chrome <path>`);
    const profile = join(tmpdir(), `sb-make-icons-${process.pid}`);
    // Port 0: Chrome picks a free one and writes it into its profile folder.
    const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--force-color-profile=srgb', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    let socketUrl;
    for (let i = 0; i < 100 && !socketUrl; i++) {
        await sleep(100);
        try {
            const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
            const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            socketUrl = targets.find(t => t.type === 'page')?.webSocketDebuggerUrl;
        } catch { /* not up yet */ }
    }
    const close = async () => {
        proc.kill();
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    };
    if (!socketUrl) { await close(); throw new Error('Chrome did not start'); }
    const ws = new WebSocket(socketUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
    let id = 0;
    const waiting = new Map();
    ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        const w = waiting.get(msg.id);
        if (!w) return;
        waiting.delete(msg.id);
        if (msg.error) w.fail(new Error(JSON.stringify(msg.error))); else w.ok(msg.result);
    });
    const send = (method, params = {}) => new Promise((ok, fail) => {
        waiting.set(++id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page error');
        return r.result.value;
    };
    return { send, evaluate, close: async () => { ws.close(); await close(); } };
}

/** The SVG drawn at exactly `size` pixels: `{ png }` (with alpha) or, with `raw`, `{ rgba }` pixels. */
async function render(chrome, svg, size, raw = false) {
    const out = await chrome.evaluate(`(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(dataUrl('image/svg+xml', svg))};
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, ${size}, ${size});
        if (!${raw}) return c.toDataURL('image/png').split(',')[1];
        const px = g.getImageData(0, 0, ${size}, ${size}).data;
        let s = '';
        for (let i = 0; i < px.length; i += 8192) s += String.fromCharCode(...px.subarray(i, i + 8192));
        return btoa(s);
    })()`);
    return Buffer.from(out, 'base64');
}

// ---- file formats

/** A PNG without an alpha channel (8-bit RGB), from RGBA pixels that are all opaque. */
function opaquePng(rgba, size) {
    const rows = Buffer.alloc(size * (size * 3 + 1)); // each row starts with filter type 0
    for (let y = 0, o = 0; y < size; y++) {
        o++;
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            if (rgba[i + 3] !== 255) throw new Error(`pixel ${x},${y} of the square icon is not opaque`);
            rows[o++] = rgba[i]; rows[o++] = rgba[i + 1]; rows[o++] = rgba[i + 2];
        }
    }
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const out = Buffer.alloc(body.length + 8);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(crc32(body), body.length + 4);
        return out;
    };
    const head = Buffer.alloc(13);
    head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4);
    head[8] = 8; head[9] = 2; // bit depth, colour type RGB
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', head), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** An .ico holding PNG images: a 6-byte header, one 16-byte entry per image, then the images. */
function ico(images) {
    const head = Buffer.alloc(6 + 16 * images.length);
    head.writeUInt16LE(1, 2); // type: icon
    head.writeUInt16LE(images.length, 4);
    let offset = head.length;
    images.forEach(({ size, png }, i) => {
        const e = 6 + 16 * i;
        head[e] = size; head[e + 1] = size;
        head.writeUInt16LE(1, e + 4); // planes
        head.writeUInt16LE(32, e + 6); // bits per pixel
        head.writeUInt32LE(png.length, e + 8);
        head.writeUInt32LE(offset, e + 12);
        offset += png.length;
    });
    return Buffer.concat([head, ...images.map(x => x.png)]);
}

// ---- review pictures

async function shoot(chrome, html, width, height, scale, file) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    const { frameTree } = await chrome.send('Page.getFrameTree');
    await chrome.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    await chrome.evaluate(`(async () => {
        await Promise.all([...document.images].map(i => i.decode()));
        await document.fonts.ready;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
    const r = await chrome.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(REVIEW, file), Buffer.from(r.data, 'base64'));
}

const STYLE = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; font: 12px 'Segoe UI', system-ui, sans-serif; overflow: hidden; }
    .row { display: flex; align-items: flex-end; gap: 36px; padding: 24px 32px 14px; height: 242px; box-sizing: border-box; }
    figure { margin: 0; display: grid; justify-items: center; gap: 10px; }
    img { display: block; }
    .zoom { image-rendering: pixelated; }
    .light { background: #ffffff; color: #3c4043; } .dark { background: #202124; color: #bdc1c6; }
    .strip { display: flex; align-items: flex-end; gap: 2px; padding: 8px 10px 0; height: 42px; box-sizing: border-box; }
    .tab { display: flex; align-items: center; gap: 8px; width: 200px; height: 34px; padding: 0 10px; box-sizing: border-box;
        border-radius: 9px 9px 0 0; }
    .tab span { flex: 1; white-space: nowrap; overflow: hidden; }
    .tab i { width: 16px; height: 16px; border-radius: 50%; background: currentColor; opacity: .35; }
    .tab b { font-weight: 400; font-size: 15px; opacity: .7; }
    .bar { height: 38px; padding: 5px 12px; box-sizing: border-box; }
    .bar div { height: 28px; line-height: 28px; border-radius: 14px; padding: 0 14px; }
    .light .strip { background: #dee1e6; } .light .active, .light .bar { background: #ffffff; } .light .bar div { background: #f1f3f4; }
    .dark .strip { background: #202124; } .dark .active, .dark .bar { background: #35363a; } .dark .bar div { background: #202124; }
    .gap { height: 10px; background: #80868b; }
</style>`;

function previewHtml(files) {
    const figure = (src, size, label, cls = '') =>
        `<figure><img class="${cls}" src="${src}" width="${size}" height="${size}"><figcaption>${label}</figcaption></figure>`;
    const row = theme => `<div class="row ${theme}">`
        + figure(files.png16, 16, '16') + figure(files.png16, 128, '16, enlarged 8x', 'zoom')
        + figure(files.png32, 32, '32') + figure(files.svg, 64, '64') + figure(files.svg, 180, '180')
        + figure(files.apple, 180, 'apple-touch-icon 180') + '</div>';
    return STYLE + row('light') + row('dark');
}

function tabsHtml(icon) {
    const strip = theme => `<div class="${theme}"><div class="strip">`
        + `<div class="tab active"><img src="${icon}" width="16" height="16"><span>Stillblade</span><b>×</b></div>`
        + '<div class="tab"><i></i><span>Another tab</span><b>×</b></div>'
        + `<div class="tab"><img src="${icon}" width="16" height="16"><span>Stillblade</span><b>×</b></div>`
        + '</div><div class="bar"><div>stillblade.orcavalley.com</div></div></div>';
    return STYLE + strip('light') + '<div class="gap"></div>' + strip('dark');
}

// ----

const chrome = await startChrome();
try {
    await chrome.send('Page.enable');
    const png = {};
    for (const size of [16, 32, 48, 192, 512]) png[size] = await render(chrome, SVG, size);
    const apple = opaquePng(await render(chrome, SQUARE_SVG, 180, true), 180);
    const files = {
        'favicon-16.png': png[16],
        'favicon-32.png': png[32],
        'favicon.ico': ico([16, 32, 48].map(size => ({ size, png: png[size] }))),
        'apple-touch-icon.png': apple,
        'icon-192.png': png[192],
        'icon-512.png': png[512]
    };
    for (const [name, bytes] of Object.entries(files)) {
        writeFileSync(join(PUBLIC, name), bytes);
        console.log(`client/public/${name}  ${bytes.length} bytes`);
    }
    mkdirSync(REVIEW, { recursive: true });
    const urls = {
        svg: dataUrl('image/svg+xml', SVG), png16: dataUrl('image/png', png[16]),
        png32: dataUrl('image/png', png[32]), apple: dataUrl('image/png', apple)
    };
    await shoot(chrome, previewHtml(urls), 900, 484, 1, 'preview.png');
    await shoot(chrome, tabsHtml(urls.png16), 640, 170, 1, 'tab-mock.png');
    await shoot(chrome, tabsHtml(urls.svg), 640, 170, 2, 'tab-mock-2x.png');
    console.log('docs/review/favicon/{preview.png, tab-mock.png, tab-mock-2x.png}');
} finally {
    await chrome.close();
}
