import { describe, expect, it } from 'vitest';
import type { RosterEntry } from '@shared/protocol';
import { DEFAULT_ROOM_OPTIONS } from '@shared/room-options';
import { PageNav, canCallVoteKick, crowdText, describeOptions } from './menu-logic';

const player = (id: number, bot = false): RosterEntry => ({
    id, name: `P${id}`, team: 'ghosts', alive: true, ready: false, creator: false, idle: false, bot,
    kills: 0, deaths: 0, assists: 0, headshots: 0, backstabs: 0, damage: 0, plants: 0, defuses: 0
} as RosterEntry);

describe('menu pages', () => {
    it('Back returns one step through the pages that were opened', () => {
        const nav = new PageNav();
        nav.go('rooms'); nav.go('create');
        expect(nav.back()).toBe(true); expect(nav.page).toBe('rooms');
        expect(nav.back()).toBe(true); expect(nav.page).toBe('home');
        expect(nav.back()).toBe(false); expect(nav.page).toBe('home');
    });
    it('a page opened first falls back to its parent', () => {
        const nav = new PageNav('howto');
        expect(nav.back()).toBe(true); expect(nav.page).toBe('home');
        const c = new PageNav('create');
        c.back(); expect(c.page).toBe('rooms');
    });
    it('going to a page already in the trail unwinds instead of piling up', () => {
        const nav = new PageNav();
        nav.go('rooms'); nav.go('create'); nav.go('rooms');
        expect(nav.back()).toBe(true); expect(nav.page).toBe('home');
        expect(nav.back()).toBe(false);
    });
});

describe('vote-kick availability', () => {
    it('needs three people and no running vote; bots do not count', () => {
        expect(canCallVoteKick([player(1), player(2)], 1, false)).toBe(false);
        expect(canCallVoteKick([player(1), player(2), player(3)], 1, false)).toBe(true);
        expect(canCallVoteKick([player(1), player(2), player(3)], 1, true)).toBe(false);
        expect(canCallVoteKick([player(1), player(2), player(3, true), player(4, true)], 1, false)).toBe(false);
        expect(canCallVoteKick([player(2), player(3), player(4)], 1, false)).toBe(false); // we are not in the roster
    });
});

describe('option listing', () => {
    it('lists the options in the create form order', () => {
        const rows = describeOptions({ ...DEFAULT_ROOM_OPTIONS, public: true, roundsToWin: 3, fillBots: true, botLevel: 'hard' }, 'Warehouse');
        expect(rows.map(r => r[0])).toEqual(['Visibility', 'Map', 'Most players', 'Rounds to win', 'Suppressed weapons', 'Fill with bots', 'Bot skill']);
        expect(rows[0][1]).toBe('Public'); expect(rows[1][1]).toBe('Warehouse'); expect(rows[3][1]).toBe('3'); expect(rows[6][1]).toBe('Hard');
    });
    it('shows the bot skill as not in use while bots are off', () => {
        expect(describeOptions(DEFAULT_ROOM_OPTIONS, 'X')[6][1]).toBe('Not in use');
    });
    it('names the bots in a crowd', () => {
        expect(crowdText(3, 0, 10)).toBe('3 / 10');
        expect(crowdText(1, 1, 4)).toBe('1 / 4 (+1 bot)');
        expect(crowdText(1, 2, 4)).toBe('1 / 4 (+2 bots)');
    });
});
