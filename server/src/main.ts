import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { TICK_RATE } from '../../shared/constants';
import { DEFAULT_PORT, decodeClient, encodeServer, type Team } from '../../shared/protocol';
import { parseRoomOptions } from '../../shared/room-options';
import { defaultMapId, loadMaps } from './maps';
import { handleReportRequest } from './report-http';
import { handleRoomsRequest } from './rooms-http';
import { RoomListCache } from './roomlist';
import { ConnectionReportLimit, Reports, originAllowed, routeClientMessage } from './reports';
import { Rooms, cleanRoomId } from './rooms';

// Not PORT: dev tooling sets that for the web client, and the two must not collide.
const port = Number(process.env.SB_SERVER_PORT) || DEFAULT_PORT;
const mapsDir = process.env.SB_MAPS_DIR ?? fileURLToPath(new URL('../../client/public/maps', import.meta.url));
/** Page origins allowed to connect, e.g. "https://example.github.io". Empty means any (development). */
const allowedOrigins = (process.env.SB_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
/** Behind a reverse proxy the socket's address is the proxy's; the real one is in X-Forwarded-For. */
const trustProxy = process.env.SB_TRUST_PROXY === '1';

/** Where feedback notes and error reports are appended, one JSON line each (also printed). Empty writes only to the console. */
const feedbackFile = process.env.SB_FEEDBACK_FILE ?? 'feedback.log';
const reports = new Reports(feedbackFile);

/** The caller's address as the server counts it: X-Forwarded-For only behind a trusted proxy. */
function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }): string {
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return forwarded || req.socket.remoteAddress || 'unknown';
}

const TICK_MS = 1000 / TICK_RATE;
const MAX_ROOMS = 50;
/** Close code for a player removed by a vote or by the creator (the client shows the reason, and does not reconnect). */
const KICKED_CLOSE_CODE = 4001;
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
const roomList = new RoomListCache();
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
    if (handleReportRequest(req, res, { reports, allowedOrigins, clientIp })) return;
    if (handleRoomsRequest(req, res, { list: () => roomList.get(rooms.rooms), allowedOrigins })) return;
    res.writeHead(404).end();
});

// 4096 bytes: a 500 character note in a non-Latin script, or an error with a stack, is larger than a chat line.
const wss = new WebSocketServer({ server: http, maxPayload: 4096 });
wss.on('connection', (ws, req) => {
    if (!originAllowed(req.headers.origin, allowedOrigins)) { ws.close(1008, 'Origin not allowed'); return; }

    const ip = clientIp(req);
    const open = perIp.get(ip) ?? 0;
    if (open >= MAX_CONNECTIONS_PER_IP) { ws.close(1013, 'Too many connections'); return; }

    // ws://host:port/?room=CODE&name=NICK&map=ID&suppressed=1&public=1&max=6&rounds=3&bots=1&level=hard (map and options only matter to
    // whoever creates the room); quick=1 without a room picks the fullest public room, or makes a public one.
    const query = new URL(req.url ?? '/', 'ws://localhost').searchParams;
    const conn = {
        ip,
        send: (msg: Parameters<typeof encodeServer>[0]) => { if (ws.readyState === ws.OPEN) ws.send(encodeServer(msg)); },
        close: (reason: string) => ws.close(KICKED_CLOSE_CODE, reason.slice(0, 120))
    };
    const name = query.get('name') ?? '';
    const options = parseRoomOptions(query);
    let roomId = cleanRoomId(query.get('room'));
    // practice=1&side=ghosts|defenders: a private practice range of one's own (a fresh room every time).
    const practice: Team | undefined = query.get('practice') === '1' ? (query.get('side') === 'ghosts' ? 'ghosts' : 'defenders') : undefined;
    if (practice) roomId = rooms.newQuickCode('practice');
    else if (query.get('quick') === '1' && !query.get('room')) {
        const found = rooms.quickRoom(conn, name);
        roomId = found ?? rooms.newQuickCode();
        if (!found) options.public = true;
    }
    const joined = rooms.join(roomId, query.get('map'), conn, name, ticks * TICK_MS, options, practice);
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
    const reportLimit = new ConnectionReportLimit();
    ws.on('message', (data, isBinary) => {
        const now = performance.now();
        tokens = Math.min(MSG_BURST, tokens + ((now - refilledAt) / 1000) * TICK_RATE * 1.25);
        refilledAt = now;
        if (tokens < 1) {
            if (++dropped > MAX_DROPPED) ws.close(1008, 'Rate limit');
            return;
        }
        tokens--;
        try {
            // Reports are answered here and never reach the game.
            routeClientMessage(decodeClient(isBinary ? (data as Buffer) : data.toString()), room, id, report => {
                const p = room.players.get(id);
                void reports.submit(report, { via: 'ws', room: roomId, map: room.map.name, team: p?.team, playerId: id, name: p?.name }, reportLimit);
            });
        } catch {
            // Malformed input from a client is ignored, never fatal.
        }
    });
    ws.on('pong', () => alive.add(ws));
    ws.on('close', (code, reason) => {
        rooms.leave(roomId, id);
        const left = (perIp.get(ip) ?? 1) - 1;
        if (left > 0) perIp.set(ip, left); else perIp.delete(ip);
        console.log(`[${roomId}] player ${id} left, close ${code} ${reason.toString()} (${room.players.size} in room, ${rooms.rooms.size} rooms)`);
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
        `origins ${allowedOrigins.length ? allowedOrigins.join(' ') : 'any'}, feedback ${feedbackFile || 'console only'}`
    );
});
