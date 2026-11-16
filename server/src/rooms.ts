import { DEFAULT_ROOM_OPTIONS, type RoomOptions } from '../../shared/room-options';
import type { Team } from '../../shared/protocol';
import type { MapData } from '../../shared/types';
import { Game, type Connection } from './game';
import { cleanName } from './namefilter';
import { fullestPublicRoom } from './roomlist';

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
     * Adds a player to `roomId`, creating the room on `mapId` (or the default map) with `options` if it
     * does not exist; a room that exists keeps its own map and options. An unknown map id is refused
     * even when the room exists, so a bad link fails loudly.
     */
    join(roomId: string, mapId: string | null, conn: Connection, name: string, now: number,
        options: RoomOptions = DEFAULT_ROOM_OPTIONS, practice?: Team): JoinResult {
        if (mapId !== null && mapId !== '' && !this.maps.has(mapId)) return { ok: false, reason: 'Unknown map' };
        let game = this.rooms.get(roomId);
        let created = false;
        if (!game) {
            if (this.rooms.size >= this.limits.maxRooms) return { ok: false, reason: 'Server full' };
            game = practice
                ? new Game(this.maps.get(mapId || this.defaultMap)!, { lobby: true, practice: true, options: { ...options, public: false } })
                : new Game(this.maps.get(mapId || this.defaultMap)!, { lobby: true, options, maps: this.maps });
            game.code = roomId;
            // A new room starts at the current tick time so its clock is never behind the loop's.
            game.now = now;
            this.rooms.set(roomId, game);
            created = true;
        } else if (game.bans.isBanned(conn.ip, cleanName(name), game.now)) {
            return { ok: false, reason: 'Removed from this room' };
        } else if (game.practice) {
            return { ok: false, reason: 'Room full' }; // a practice range is for one person
        } else if (game.humanCount() >= Math.min(this.limits.maxPlayersPerRoom, game.options.maxPlayers)) {
            return { ok: false, reason: 'Room full' };
        }
        const id = game.join(conn, name, practice ? { team: practice } : {});
        return { ok: true, roomId, game, id, created };
    }

    /**
     * Quick play: the code of the fullest public room with space (the oldest among equals) that has not
     * removed this address or name, or null when the caller should create a public room of their own.
     */
    quickRoom(conn: Connection, name: string): string | null {
        const clean = cleanName(name);
        return fullestPublicRoom(this.rooms, g => !g.bans.isBanned(conn.ip, clean, g.now) && g.humanCount() < this.limits.maxPlayersPerRoom);
    }

    /** A fresh room code for a Quick play room (or, with `prefix`, a practice range) that nobody is in yet. */
    newQuickCode(prefix = 'quick'): string {
        for (;;) {
            const code = `${prefix}-${Math.random().toString(36).slice(2, 6)}`;
            if (!this.rooms.has(code)) return code;
        }
    }

    /** Removes a player; an empty room is dropped. */
    leave(roomId: string, id: number): void {
        const game = this.rooms.get(roomId);
        if (!game) return;
        game.leave(id);
        if (game.humanCount() === 0) this.rooms.delete(roomId); // bots never keep a room open
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
