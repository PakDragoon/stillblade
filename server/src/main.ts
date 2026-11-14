import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { TICK_RATE } from '../../shared/constants';
import { DEFAULT_PORT, decodeClient, encodeServer } from '../../shared/protocol';
import { defaultMapId, loadMaps } from './maps';
import { Rooms, cleanRoomId } from './rooms';

// Not PORT: dev tooling sets that for the web client, and the two must not collide.
const port = Number(process.env.SB_SERVER_PORT) || DEFAULT_PORT;
const mapsDir = process.env.SB_MAPS_DIR ?? fileURLToPath(new URL('../../client/public/maps', import.meta.url));
/** Page origins allowed to connect, e.g. "https://example.github.io". Empty means any (development). */
const allowedOrigins = (process.env.SB_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
/** Behind a reverse proxy the socket's address is the proxy's; the real one is in X-Forwarded-For. */
const trustProxy = process.env.SB_TRUST_PROXY === '1';

const TICK_MS = 1000 / TICK_RATE;
const MAX_ROOMS = 50;
const MAX_PLAYERS_PER_ROOM = 10;
const MAX_CONNECTIONS_PER_IP = 6;
/** A client sends one command per tick; this allows for bursts after a network hiccup. */
const MSG_BURST = TICK_RATE * 2;
/** Dropped messages tolerated before the connection is closed as abusive. */
const MAX_DROPPED = TICK_RATE * 20;
const HEARTBEAT_MS = 15_000;

/** Every map in the maps folder; a room is created on one of them (`?map=`, else the default). */
const maps = loadMaps(mapsDir);
/** Each room is an independent match. Rooms are created on first join and dropped when empty. */
const rooms = new Rooms(maps, defaultMapId(maps, process.env.SB_DEFAULT_MAP), {
    maxRooms: MAX_ROOMS, maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM
});
const perIp = new Map<string, number>();
const alive = new WeakSet<WebSocket>();
let ticks = 0;

// Plain HTTP on the same port for uptime checks and load balancers.
const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, rooms: rooms.rooms.size, players: rooms.playerCount() }));
        return;
    }
    res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http, maxPayload: 256 });
wss.on('connection', (ws, req) => {
    const origin = (req.headers.origin ?? '').replace(/\/$/, '');
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) { ws.close(1008, 'Origin not allowed'); return; }

    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    const ip = forwarded || req.socket.remoteAddress || 'unknown';
    const open = perIp.get(ip) ?? 0;
    if (open >= MAX_CONNECTIONS_PER_IP) { ws.close(1013, 'Too many connections'); return; }

    // ws://host:port/?room=CODE&name=NICK&map=ID (the map only matters to whoever creates the room)
    const query = new URL(req.url ?? '/', 'ws://localhost').searchParams;
    const roomId = cleanRoomId(query.get('room'));
    const joined = rooms.join(roomId, query.get('map'), {
        send: msg => { if (ws.readyState === ws.OPEN) ws.send(encodeServer(msg)); }
    }, query.get('name') ?? '', ticks * TICK_MS);
    if (!joined.ok) { ws.close(joined.reason === 'Unknown map' ? 1008 : 1013, joined.reason); return; }

    perIp.set(ip, open + 1);
    alive.add(ws);
    const room = joined.game;
    const id = joined.id;
    console.log(`[${roomId}] player ${id} joined ${room.map.name} (${room.players.size} in room, ${rooms.rooms.size} rooms)`);

    // Token bucket: refills at the tick rate, so an honest client never runs dry.
    let tokens = MSG_BURST;
    let refilledAt = performance.now();
    let dropped = 0;
    ws.on('message', (data, isBinary) => {
        const now = performance.now();
        tokens = Math.min(MSG_BURST, tokens + ((now - refilledAt) / 1000) * TICK_RATE * 1.25);
        refilledAt = now;
        if (tokens < 1) {
            if (++dropped > MAX_DROPPED) ws.close(1008, 'Rate limit');
            return;
        }
        tokens--;
        if (!isBinary || !Buffer.isBuffer(data)) return;
        try {
            room.handleCmd(id, decodeClient(data).cmd);
        } catch {
            // Malformed input from a client is ignored, never fatal.
        }
    });
    ws.on('pong', () => alive.add(ws));
    ws.on('close', () => {
        rooms.leave(roomId, id);
        const left = (perIp.get(ip) ?? 1) - 1;
        if (left > 0) perIp.set(ip, left); else perIp.delete(ip);
        console.log(`[${roomId}] player ${id} left (${room.players.size} in room, ${rooms.rooms.size} rooms)`);
    });
    ws.on('error', () => ws.terminate());
});

// Drop connections that have gone silent (closed laptop, lost network) so their player leaves the match.
const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (!alive.has(ws)) { ws.terminate(); continue; }
        alive.delete(ws);
        ws.ping();
    }
}, HEARTBEAT_MS);

// Timers are coarse (about 15 ms on Windows), so run however many ticks are due each wake-up.
const started = performance.now();
const loop = setInterval(() => {
    const elapsed = performance.now() - started;
    if (elapsed - ticks * TICK_MS > 250) ticks = Math.floor(elapsed / TICK_MS); // stalled: skip ahead
    while (ticks * TICK_MS <= elapsed) {
        const now = ticks++ * TICK_MS;
        rooms.tick(now);
    }
}, 4);

function shutdown(): void {
    console.log('Shutting down');
    clearInterval(loop);
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(1001, 'Server restarting');
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

http.listen(port, () => {
    console.log(
        `Stillblade server: maps ${[...maps.keys()].join(', ')} (default ${rooms.defaultMap}), ${TICK_RATE} Hz, port ${port}, ` +
        `origins ${allowedOrigins.length ? allowedOrigins.join(' ') : 'any'}`
    );
});
