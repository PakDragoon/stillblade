import { describe, expect, it } from 'vitest';
import {
    DEFAULT_ROOM_OPTIONS, cleanRoomOptions, halftimeRound, parseRoomOptions, roomOptionsQuery
} from './room-options';

describe('room options from the join query', () => {
    it('defaults: private, ten players, first to six, unsuppressed, no bots', () => {
        expect(DEFAULT_ROOM_OPTIONS).toEqual({ suppressed: false, public: false, maxPlayers: 10, roundsToWin: 6, fillBots: false });
        expect(parseRoomOptions(new URLSearchParams(''))).toEqual(DEFAULT_ROOM_OPTIONS);
        expect(parseRoomOptions(new URLSearchParams('room=x&map=warehouse'))).toEqual(DEFAULT_ROOM_OPTIONS);
    });

    it('reads suppressed=1 (and true); anything else is off', () => {
        expect(parseRoomOptions(new URLSearchParams('suppressed=1')).suppressed).toBe(true);
        expect(parseRoomOptions(new URLSearchParams('room=a&suppressed=true')).suppressed).toBe(true);
        for (const v of ['0', 'false', '', 'yes', '2', 'on']) {
            expect(parseRoomOptions(new URLSearchParams(`suppressed=${v}`)).suppressed).toBe(false);
        }
    });

    it('reads every option, and any invalid value falls back to the default', () => {
        expect(parseRoomOptions(new URLSearchParams('public=1&max=4&rounds=3&bots=1&suppressed=1')))
            .toEqual({ suppressed: true, public: true, maxPlayers: 4, roundsToWin: 3, fillBots: true });
        for (const bad of ['0', '1', '11', '-3', '2.5', 'abc', '', '999999', '1e1']) {
            expect(parseRoomOptions(new URLSearchParams(`max=${bad}`)).maxPlayers, bad).toBe(10);
        }
        expect(parseRoomOptions(new URLSearchParams('max=2')).maxPlayers).toBe(2);
        expect(parseRoomOptions(new URLSearchParams('max=10')).maxPlayers).toBe(10);
        for (const bad of ['0', '1', '4', '5', '7', '10', 'x', '', '-6']) {
            expect(parseRoomOptions(new URLSearchParams(`rounds=${bad}`)).roundsToWin, bad).toBe(6);
        }
        for (const ok of [3, 6, 9]) expect(parseRoomOptions(new URLSearchParams(`rounds=${ok}`)).roundsToWin).toBe(ok);
        expect(parseRoomOptions(new URLSearchParams('public=maybe')).public).toBe(false);
    });

    it('cleans a JSON object field by field, keeping the base for anything invalid', () => {
        const base = { suppressed: true, public: true, maxPlayers: 5, roundsToWin: 9, fillBots: false };
        expect(cleanRoomOptions({}, base)).toEqual(base);
        expect(cleanRoomOptions({ maxPlayers: 7, roundsToWin: 4, public: 'nope', suppressed: false }, base))
            .toEqual({ suppressed: false, public: true, maxPlayers: 7, roundsToWin: 9, fillBots: false });
        expect(cleanRoomOptions({ maxPlayers: 99, fillBots: true }, base)).toMatchObject({ maxPlayers: 5, fillBots: true });
        expect(cleanRoomOptions({ maxPlayers: null, roundsToWin: {} as unknown }, base)).toEqual(base);
    });

    it('writes only what differs from the default, and reads back what it wrote', () => {
        const q = new URLSearchParams();
        roomOptionsQuery(DEFAULT_ROOM_OPTIONS, q);
        expect(q.toString()).toBe('');
        const all = { suppressed: true, public: true, maxPlayers: 3, roundsToWin: 9, fillBots: true };
        roomOptionsQuery(all, q);
        expect(parseRoomOptions(q)).toEqual(all);
    });

    it('swaps sides one round before a side can win', () => {
        expect([3, 6, 9].map(halftimeRound)).toEqual([2, 5, 8]);
    });
});
