import type { MapData } from '../../shared/types';
import { Game, type Connection } from './game';

export interface RoomLimits {
    maxRooms: number;
    maxPlayersPerRoom: number;
}

export type JoinResult =
    | { ok: true; roomId: string; game: Game; id: number; created: boolean }
    | { ok: false; reason: string };

/** Room codes are short lower-case slugs; anything else falls back to the public room. */
export function cleanRoomId(raw: string | null): string {
    return (raw ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'public';
}

/**
 * Every running match, keyed by room code. A room is created by its first player, on the map that
 * player asked for (or the default); later players join whatever map the room already has and are
 * told it in their welcome message. No socket code here, so it is tested directly (rooms.test.ts).
 */
export class Rooms {
    readonly rooms = new Map<string, Game>();

    constructor(
        readonly maps: ReadonlyMap<string, MapData>,
        readonly defaultMap: string,
        private readonly limits: RoomLimits = { maxRooms: 50, maxPlayersPerRoom: 10 }
    ) {
        if (!maps.has(defaultMap)) throw new Error(`default map ${defaultMap} is not loaded`);
    }

    /**
     * Adds a player to `roomId`, creating the room on `mapId` (or the default map) if it does not exist.
     * An unknown map id is refused even when the room exists, so a bad link fails loudly.
     */
    join(roomId: string, mapId: string | null, conn: Connection, name: string, now: number): JoinResult {
        if (mapId !== null && mapId !== '' && !this.maps.has(mapId)) return { ok: false, reason: 'Unknown map' };
        let game = this.rooms.get(roomId);
        let created = false;
        if (!game) {
            if (this.rooms.size >= this.limits.maxRooms) return { ok: false, reason: 'Server full' };
            game = new Game(this.maps.get(mapId || this.defaultMap)!, { lobby: true });
            // A new room starts at the current tick time so its clock is never behind the loop's.
            game.now = now;
            this.rooms.set(roomId, game);
            created = true;
        } else if (game.players.size >= this.limits.maxPlayersPerRoom) {
            return { ok: false, reason: 'Room full' };
        }
        const id = game.join(conn, name);
        return { ok: true, roomId, game, id, created };
    }

    /** Removes a player; an empty room is dropped. */
    leave(roomId: string, id: number): void {
        const game = this.rooms.get(roomId);
        if (!game) return;
        game.leave(id);
        if (game.players.size === 0) this.rooms.delete(roomId);
    }

    tick(now: number): void {
        for (const game of this.rooms.values()) game.tick(now);
    }

    playerCount(): number {
        let n = 0;
        for (const game of this.rooms.values()) n += game.players.size;
        return n;
    }
}
