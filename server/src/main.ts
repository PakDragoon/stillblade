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
const MAX_ROOMS = 50;
const MAX_PLAYERS_PER_ROOM = 10;

const map = JSON.parse(
    readFileSync(new URL(`../../client/public/maps/${MAP}.json`, import.meta.url), 'utf8')
) as MapData;

/** Each room is an independent match. Rooms are created on first join and dropped when empty. */
const rooms = new Map<string, Game>();

const wss = new WebSocketServer({ port, maxPayload: 4096 });
wss.on('connection', (ws, req) => {
    // ws://host:port/?room=CODE&name=NICK
    const query = new URL(req.url ?? '/', 'ws://localhost').searchParams;
    const roomId = (query.get('room') ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'public';
    let game = rooms.get(roomId);
    if (!game) {
        if (rooms.size >= MAX_ROOMS) { ws.close(1013, 'Server full'); return; }
        game = new Game(map);
        // A new room starts at the current tick time so its clock is never behind the loop's.
        game.now = ticks * TICK_MS;
        rooms.set(roomId, game);
    }
    if (game.players.size >= MAX_PLAYERS_PER_ROOM) { ws.close(1013, 'Room full'); return; }

    const room = game;
    const id = room.join({
        send: msg => { if (ws.readyState === ws.OPEN) ws.send(encodeServer(msg)); }
    }, query.get('name') ?? '');
    console.log(`[${roomId}] player ${id} joined (${room.players.size} in room, ${rooms.size} rooms)`);
    ws.on('message', data => {
        try {
            const msg = decodeClient(data.toString());
            if (msg.type === 'cmd' && msg.cmd) room.handleCmd(id, msg.cmd);
        } catch {
            // Malformed input from a client is ignored, never fatal.
        }
    });
    ws.on('close', () => {
        room.leave(id);
        if (room.players.size === 0) rooms.delete(roomId);
        console.log(`[${roomId}] player ${id} left (${room.players.size} in room, ${rooms.size} rooms)`);
    });
    ws.on('error', () => ws.close());
});

// Timers are coarse (about 15 ms on Windows), so run however many ticks are due each wake-up.
const started = performance.now();
let ticks = 0;
setInterval(() => {
    const elapsed = performance.now() - started;
    if (elapsed - ticks * TICK_MS > 250) ticks = Math.floor(elapsed / TICK_MS); // stalled: skip ahead
    while (ticks * TICK_MS <= elapsed) {
        const now = ticks++ * TICK_MS;
        for (const game of rooms.values()) game.tick(now);
    }
}, 4);

console.log(`Stillblade server: map "${map.name}", ${TICK_RATE} Hz, ws://localhost:${port}`);
