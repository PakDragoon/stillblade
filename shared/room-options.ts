import { ROUNDS_TO_WIN } from './rules';

/**
 * Options the creator of a room chooses when creating it (and may change in warmup). Read from the
 * join query only when the room is created (later joiners' options are ignored), kept on the room's
 * `Game`, and sent to every player in `welcome` and in every `options` message. To add one: a field
 * here, its default, a line in `cleanRoomOptions`, a line in `roomOptionsQuery`, and a row in the
 * lobby panel and the create form.
 */
export interface RoomOptions {
    /**
     * Suppressed weapons: quiet gunshots (heard within GUNSHOT_RANGE_SUPPRESSED instead of
     * GUNSHOT_RANGE), a small muzzle flash and suppressors on the models. Off by default.
     */
    suppressed: boolean;
    /** Listed in the public room list and eligible for Quick play. */
    public: boolean;
    /** Most players the room accepts, ROOM_MIN_PLAYERS to ROOM_MAX_PLAYERS. */
    maxPlayers: number;
    /** Rounds a side needs to win the match (3, 6 or 9); sides swap after `roundsToWin - 1` rounds. */
    roundsToWin: number;
    /**
     * Keep both teams at half of `maxPlayers` (at least one each) with bots: a bot is added for every
     * missing player and leaves when a person takes its place (in warmup at once, otherwise at the
     * next round start). See `Game.fillWithBots` in server/src/game.ts.
     */
    fillBots: boolean;
    /** How well bots play: reaction time, aim error, how much they make of what they hear. */
    botLevel: BotLevel;
}

export type BotLevel = 'easy' | 'normal' | 'hard';
export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'normal', 'hard'];

export const ROOM_MIN_PLAYERS = 2;
export const ROOM_MAX_PLAYERS = 10;
export const ROUNDS_TO_WIN_CHOICES: readonly number[] = [3, 6, 9];

export const DEFAULT_ROOM_OPTIONS: Readonly<RoomOptions> = {
    suppressed: false, public: false, maxPlayers: ROOM_MAX_PLAYERS, roundsToWin: ROUNDS_TO_WIN, fillBots: false, botLevel: 'normal'
};

/** The round after which the sides swap, for a match to `roundsToWin`: one before a side can win (5 for 6). */
export function halftimeRound(roundsToWin: number): number {
    return roundsToWin - 1; // 6 gives HALFTIME_ROUND (5) in shared/rules.ts
}

/** Anything with a `get` like URLSearchParams (the WebSocket join query). */
export interface QueryLike {
    get(name: string): string | null;
}

/** A flag as the query writes it ("1" or "true") or as JSON does (a boolean). Anything else is `fallback`. */
function flag(v: unknown, fallback: boolean): boolean {
    if (v === true || v === '1' || v === 'true') return true;
    if (v === false || v === '0' || v === 'false') return false;
    return fallback;
}

function whole(v: unknown): number {
    return typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,3}$/.test(v) ? Number(v) : NaN;
}

/**
 * Every field checked on its own: a missing or invalid one takes its value from `base` (the default
 * when a room is created, the room's current options when the creator changes them).
 */
export function cleanRoomOptions(raw: { readonly [K in keyof RoomOptions]?: unknown }, base: Readonly<RoomOptions> = DEFAULT_ROOM_OPTIONS): RoomOptions {
    const max = whole(raw.maxPlayers);
    const rounds = whole(raw.roundsToWin);
    return {
        suppressed: flag(raw.suppressed, base.suppressed),
        public: flag(raw.public, base.public),
        maxPlayers: Number.isInteger(max) && max >= ROOM_MIN_PLAYERS && max <= ROOM_MAX_PLAYERS ? max : base.maxPlayers,
        roundsToWin: ROUNDS_TO_WIN_CHOICES.includes(rounds) ? rounds : base.roundsToWin,
        fillBots: flag(raw.fillBots, base.fillBots),
        botLevel: BOT_LEVELS.includes(raw.botLevel as BotLevel) ? raw.botLevel as BotLevel : base.botLevel
    };
}

/** Room options from the join query (`suppressed=1&public=1&max=6&rounds=3&bots=1&level=hard`); anything missing or invalid is the default. */
export function parseRoomOptions(query: QueryLike): RoomOptions {
    return cleanRoomOptions({
        suppressed: query.get('suppressed') ?? undefined, public: query.get('public') ?? undefined,
        maxPlayers: query.get('max') ?? undefined, roundsToWin: query.get('rounds') ?? undefined,
        fillBots: query.get('bots') ?? undefined, botLevel: query.get('level') ?? undefined
    });
}

/** The query parameters that ask for `o` (only the ones that differ from the default). */
export function roomOptionsQuery(o: RoomOptions, into: { set(name: string, value: string): void }): void {
    const d = DEFAULT_ROOM_OPTIONS;
    if (o.suppressed !== d.suppressed) into.set('suppressed', o.suppressed ? '1' : '0');
    if (o.public !== d.public) into.set('public', o.public ? '1' : '0');
    if (o.maxPlayers !== d.maxPlayers) into.set('max', String(o.maxPlayers));
    if (o.roundsToWin !== d.roundsToWin) into.set('rounds', String(o.roundsToWin));
    if (o.fillBots !== d.fillBots) into.set('bots', o.fillBots ? '1' : '0');
    if (o.botLevel !== d.botLevel) into.set('level', o.botLevel);
}

/** Bots per team when the room fills with them: half the room's size, at least one. */
export function botTeamSize(o: Readonly<RoomOptions>): number {
    return Math.max(1, Math.floor(o.maxPlayers / 2));
}
