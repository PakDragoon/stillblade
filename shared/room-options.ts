/**
 * Options the creator of a room chooses when creating it. Read from the join query only when the
 * room is created (later joiners' options are ignored), kept on the room's `Game`, and sent to every
 * player in `welcome`. Package D extends this object (public or private, player count, rounds to
 * win, bots); add a field here, a line in `parseRoomOptions`, and its row in the lobby panel.
 */
export interface RoomOptions {
    /**
     * Suppressed weapons: quiet gunshots (heard within GUNSHOT_RANGE_SUPPRESSED instead of
     * GUNSHOT_RANGE), a small muzzle flash and suppressors on the models. Off by default.
     */
    suppressed: boolean;
}

export const DEFAULT_ROOM_OPTIONS: Readonly<RoomOptions> = { suppressed: false };

/** Anything with a `get` like URLSearchParams (the WebSocket join query). */
export interface QueryLike {
    get(name: string): string | null;
}

/** Room options from the join query (`suppressed=1`); anything missing or unrecognised is the default. */
export function parseRoomOptions(query: QueryLike): RoomOptions {
    const s = query.get('suppressed');
    return { suppressed: s === '1' || s === 'true' };
}

/** The query parameters that ask for `o` (only the ones that differ from the default). */
export function roomOptionsQuery(o: RoomOptions, into: { set(name: string, value: string): void }): void {
    if (o.suppressed) into.set('suppressed', '1');
}
