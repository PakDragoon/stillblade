// Compare the deployed client manifest, server health and an actual WebSocket handshake.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';

const [httpBase, origin, clientManifest = 'dist/client/version.json'] = process.argv.slice(2);
if (!httpBase || !origin) throw new Error('Usage: node tools/release-smoke.mjs <server-http-url> <client-origin> [client-version-url-or-path]');

const client = /^https?:\/\//.test(clientManifest)
    ? await getJson(clientManifest)
    : JSON.parse(await readFile(clientManifest, 'utf8'));
const healthUrl = new URL('/health', httpBase);
const health = await getJson(healthUrl);
assert.equal(health.ok, true, 'Server is not healthy');
assert.equal(health.persistence, 'ok', 'Server is unable to persist match data');
assert.ok(Number.isInteger(client.protocol), 'Client protocol stamp is missing');
assert.equal(health.protocol, client.protocol, 'Client and server protocol stamps differ');
assert.match(client.commit ?? '', /^[a-f0-9]{7,40}$/, 'Client revision is missing');
assert.match(health.commit ?? '', /^[a-f0-9]{7,40}$/, 'Server revision is missing');
assert.ok(client.commit.startsWith(health.commit) || health.commit.startsWith(client.commit),
    'Client and server revisions differ');

const wsUrl = new URL('/', healthUrl);
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
wsUrl.searchParams.set('practice', '1');
wsUrl.searchParams.set('name', 'Release check');
wsUrl.searchParams.set('version', String(client.protocol));
const welcome = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { origin, handshakeTimeout: 5000 });
    const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Timed out waiting for game welcome'));
    }, 5000);
    const finish = () => clearTimeout(timer);
    ws.once('error', err => { finish(); reject(err); });
    ws.once('close', (code, reason) => {
        finish();
        reject(new Error(`Server closed before welcome (${code}: ${reason})`));
    });
    ws.on('message', (bytes, binary) => {
        if (binary) return;
        try {
            const message = JSON.parse(bytes.toString());
            if (message.type !== 'welcome') return;
            finish();
            resolve(message);
            ws.close();
        } catch (err) {
            finish();
            reject(err);
            ws.close();
        }
    });
});
assert.equal(welcome.version, client.protocol, 'Welcome protocol differs from client stamp');
assert.equal(welcome.practice, true, 'Expected an isolated practice session');
console.log(`Release smoke passed: ${health.commit}, protocol ${welcome.version}, persistence ${health.persistence}.`);

async function getJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
}
