import type { RoomListEntry } from '../../shared/room-list';
import type { Game } from './game';

/** Every public room, oldest first (the order `Rooms` created them in). Private rooms are never listed. */
export function listPublicRooms(rooms: ReadonlyMap<string, Game>): RoomListEntry[] {
    const out: RoomListEntry[] = [];
    for (const [code, game] of rooms) {
        if (!game.options.public || game.humanCount() === 0) continue;
        const inMatch = game.matchInProgress();
        out.push({
            code,
            map: game.map.name,
            mapName: game.map.displayName ?? game.map.name,
            players: game.humanCount(),
            bots: game.players.size - game.humanCount(),
            capacity: game.options.maxPlayers,
            phase: inMatch ? 'match' : 'lobby',
            score: inMatch ? { ghosts: game.score[game.ghostGroup], defenders: game.score[1 - game.ghostGroup] } : null,
            options: { ...game.options }
        });
    }
    return out;
}

/** The list for `GET /rooms`, rebuilt at most once per `ttlMs` however often it is asked for. */
export class RoomListCache {
    private built: RoomListEntry[] = [];
    private builtAt = -Infinity;

    constructor(private readonly ttlMs = 1000, private readonly clock: () => number = () => Date.now()) {}

    get(rooms: ReadonlyMap<string, Game>): RoomListEntry[] {
        const now = this.clock();
        if (now - this.builtAt >= this.ttlMs || now < this.builtAt) {
            this.built = listPublicRooms(rooms);
            this.builtAt = now;
        }
        return this.built;
    }
}

/**
 * Quick play: the public room with the most players that still has space and that `canJoin` accepts;
 * among equals the oldest. Null when there is none (the caller then creates one).
 */
export function fullestPublicRoom(rooms: ReadonlyMap<string, Game>, canJoin: (game: Game) => boolean): string | null {
    let best: string | null = null;
    let bestPlayers = 0;
    for (const [code, game] of rooms) { // insertion order = oldest first, so a strict comparison keeps the oldest on a tie
        const n = game.humanCount(); // bots make way for people
        if (!game.options.public || n === 0 || n >= game.options.maxPlayers || !canJoin(game)) continue;
        if (n > bestPlayers) { best = code; bestPlayers = n; }
    }
    return best;
}
