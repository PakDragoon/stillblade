import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { TICK_RATE } from '../../shared/constants';
import { DEFAULT_PORT, decodeClient, encodeServer } from '../../shared/protocol';
import type { MapData } from '../../shared/types';
import { Game } from './game';

const MAP = 'greybox';
// Not PORT: dev tooling sets that for the web client, and the two must not collide.
const port = Number(process.env.SB_SERVER_PORT) || DEFAULT_PORT;
const TICK_MS = 1000 / TICK_RATE;

const map = JSON.parse(
    readFileSync(new URL(`../../client/public/maps/${MAP}.json`, import.meta.url), 'utf8')
) as MapData;
const game = new Game(map);

const wss = new WebSocketServer({ port, maxPayload: 4096 });
wss.on('connection', ws => {
    const id = game.join({
        send: msg => { if (ws.readyState === ws.OPEN) ws.send(encodeServer(msg)); }
    });
    console.log(`player ${id} joined (${game.players.size} online)`);
    ws.on('message', data => {
        try {
            const msg = decodeClient(data.toString());
            if (msg.type === 'cmd' && msg.cmd) game.handleCmd(id, msg.cmd);
        } catch {
            // Malformed input from a client is ignored, never fatal.
        }
    });
    ws.on('close', () => {
        game.leave(id);
        console.log(`player ${id} left (${game.players.size} online)`);
    });
    ws.on('error', () => ws.close());
});

// Timers are coarse (about 15 ms on Windows), so run however many ticks are due each wake-up.
const started = performance.now();
let ticks = 0;
setInterval(() => {
    const elapsed = performance.now() - started;
    if (elapsed - ticks * TICK_MS > 250) ticks = Math.floor(elapsed / TICK_MS); // stalled: skip ahead
    while (ticks * TICK_MS <= elapsed) game.tick(ticks++ * TICK_MS);
}, 4);

console.log(`Stillblade server: map "${map.name}", ${TICK_RATE} Hz, ws://localhost:${port}`);
