import type { RoomOptions } from './room-options';

/** One public room as `GET /rooms` lists it. Never carries player names, addresses or anything about a private room. */
export interface RoomListEntry {
    code: string;
    map: string;
    mapName: string;
    players: number;
    capacity: number;
    /** `lobby`: warmup, nobody has started; `match`: a match is on (or held) and `score` is its score. */
    phase: 'lobby' | 'match';
    score: { ghosts: number; defenders: number } | null;
    options: RoomOptions;
}

export interface RoomListResponse {
    rooms: RoomListEntry[];
}
