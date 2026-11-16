import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RoomListEntry, RoomListResponse } from '../../shared/room-list';
import { originAllowed } from './reports';

export interface RoomsHttpDeps {
    /** The (cached) public room list. */
    list: () => RoomListEntry[];
    allowedOrigins: readonly string[];
}

/**
 * `GET /rooms` (and its `OPTIONS` preflight): the public rooms for the menu. Same origin check and CORS
 * rules as `POST /report`: headers only for an allowed origin, never a wildcard. The body holds room
 * codes, maps, counts, phases and options; no names, addresses or private rooms.
 * Returns true if the request was for this route.
 */
export function handleRoomsRequest(req: IncomingMessage, res: ServerResponse, deps: RoomsHttpDeps): boolean {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/rooms') return false;
    const origin = req.headers.origin;
    const allowed = originAllowed(origin, deps.allowedOrigins);
    if (origin && allowed) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
    }
    const done = (status: number, body = '', type = 'text/plain'): void => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
    };
    if (req.method === 'OPTIONS') {
        if (!allowed) { done(403); return true; }
        res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
        res.setHeader('access-control-max-age', '600');
        done(204);
        return true;
    }
    if (req.method !== 'GET') { done(405); return true; }
    if (!allowed) { done(403); return true; }
    const body: RoomListResponse = { rooms: deps.list() };
    done(200, JSON.stringify(body), 'application/json');
    return true;
}
