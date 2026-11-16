import { describe, expect, it } from 'vitest';
import {
    BAN_MS, Bans, KICK_CALLER_COOLDOWN_MS, KICK_TARGET_PROTECT_MS, KICK_VOTE_MS, KickVote, MapVote
} from './votes';

const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe('vote to kick: thresholds', () => {
    it('needs more than half of the connected players, the target included', () => {
        expect([3, 4, 5, 6, 7, 8, 10].map(KickVote.needed)).toEqual([2, 3, 3, 4, 4, 5, 6]);
    });

    it('3 players: the caller and one more pass it; one no fails it at once', () => {
        const present = ids(3);
        const v = new KickVote();
        expect(v.start(1, 3, 0, present)).toBeNull();
        expect(v.step(1, present)).toBeNull();
        expect(v.cast(3, true, present)).toBe(false); // the target cannot vote
        v.cast(2, true, present);
        expect(v.step(2, present)).toMatchObject({ result: 'passed', target: 3, caller: 1 });
        expect(v.active).toBeNull();

        const w = new KickVote();
        w.start(1, 3, 0, present);
        w.cast(2, false, present);
        expect(w.step(1, present)).toMatchObject({ result: 'failed', target: 3 });
    });

    it('4 players: needs 3 yes, so the caller and both others', () => {
        const present = ids(4);
        const v = new KickVote();
        v.start(1, 4, 0, present);
        v.cast(2, true, present);
        expect(v.step(1, present)).toBeNull();
        v.cast(3, true, present);
        expect(v.step(2, present)?.result).toBe('passed');

        const w = new KickVote();
        w.start(1, 4, 0, present);
        w.cast(2, false, present); // one no already makes 3 of 4 impossible
        expect(w.step(1, present)?.result).toBe('failed');
    });

    it('5 players: needs 3 yes and survives one no', () => {
        const present = ids(5);
        const v = new KickVote();
        v.start(1, 5, 0, present);
        v.cast(2, false, present);
        expect(v.step(1, present)).toBeNull(); // 1 yes + 2 undecided can still reach 3
        v.cast(3, true, present);
        expect(v.step(2, present)).toBeNull();
        v.cast(4, true, present);
        expect(v.step(3, present)?.result).toBe('passed');
    });

    it('a changed answer replaces the old one; the vote ends after 30 s with whatever is unanswered counting against', () => {
        const present = ids(5);
        const v = new KickVote();
        v.start(1, 5, 1000, present);
        v.cast(2, true, present);
        v.cast(2, false, present);
        expect(v.tally(present)).toEqual({ yes: 1, no: 1, needed: 3 });
        expect(v.step(1000 + KICK_VOTE_MS - 1, present)).toBeNull();
        expect(v.step(1000 + KICK_VOTE_MS, present)?.result).toBe('failed');
    });

    it('leavers do not count: a voter who leaves loses their vote, the target leaving cancels, too few players cancels', () => {
        let present = ids(5);
        const v = new KickVote();
        v.start(1, 5, 0, present);
        v.cast(2, true, present);
        present = [1, 3, 4, 5]; // voter 2 left: 1 yes, needs 3 of 4
        expect(v.tally(present)).toEqual({ yes: 1, no: 0, needed: 3 });
        expect(v.step(1, present)).toBeNull();
        expect(v.step(2, [1, 3, 4])).toMatchObject({ result: 'cancelled', target: 5 }); // the target is gone
        const w = new KickVote();
        w.start(1, 3, 0, ids(3));
        expect(w.step(1, [1, 3])?.result).toBe('cancelled'); // under three players
    });

    it('refuses: under three players, yourself, someone absent, a second vote', () => {
        const v = new KickVote();
        expect(v.start(1, 2, 0, ids(2))).toMatch(/at least 3/);
        expect(v.start(1, 1, 0, ids(3))).toMatch(/yourself/);
        expect(v.start(1, 9, 0, ids(3))).toMatch(/not in the room/);
        expect(v.start(1, 2, 0, ids(3))).toBeNull();
        expect(v.start(3, 2, 0, ids(3))).toMatch(/already running/);
    });
});

describe('vote to kick: cooldowns', () => {
    it('the caller waits 2 minutes, passed or failed', () => {
        const present = ids(4);
        const v = new KickVote();
        v.start(1, 4, 0, present);
        v.cast(2, true, present); v.cast(3, true, present);
        expect(v.step(1, present)?.result).toBe('passed');
        expect(v.start(1, 3, 1000, present)).toMatch(/Wait 119 s/);
        expect(v.start(1, 3, KICK_CALLER_COOLDOWN_MS - 1, present)).toMatch(/Wait/);
        expect(v.start(1, 3, KICK_CALLER_COOLDOWN_MS, present)).toBeNull();
        expect(v.start(2, 3, 0, present)).toMatch(/already running/);
    });

    it('a player cannot be targeted for 2 minutes after a failed vote, but others can start votes', () => {
        const present = ids(5);
        const v = new KickVote();
        v.start(1, 5, 0, present);
        v.cast(2, false, present); v.cast(3, false, present);
        expect(v.step(10_000, present)?.result).toBe('failed');
        expect(v.start(2, 5, 10_000, present)).toMatch(/just failed/);
        expect(v.start(2, 4, 10_000, present)).toBeNull(); // someone else is fair game, and a new caller is free
        const w = new KickVote();
        w.start(1, 5, 0, present);
        w.cast(2, false, present); w.cast(3, false, present);
        w.step(0, present);
        expect(w.start(4, 5, KICK_TARGET_PROTECT_MS, present)).toBeNull(); // protection over
    });
});

describe('bans', () => {
    it('keep a player out by address and by name for 10 minutes, then lapse', () => {
        const b = new Bans();
        b.add('1.2.3.4', 'Sam', 1000);
        expect(b.isBanned('1.2.3.4', 'Other', 1001)).toBe(true); // same address, another name
        expect(b.isBanned('9.9.9.9', 'sam', 1001)).toBe(true); // same name, another address, any case
        expect(b.isBanned('9.9.9.9', 'Other', 1001)).toBe(false);
        expect(b.isBanned('1.2.3.4', 'Sam', 1000 + BAN_MS - 1)).toBe(true);
        expect(b.isBanned('1.2.3.4', 'Sam', 1000 + BAN_MS)).toBe(false);
        expect(b.isBanned('9.9.9.9', 'sam', 1000 + BAN_MS)).toBe(false);
    });

    it('cope with a missing address or name', () => {
        const b = new Bans();
        b.add(undefined, '', 0);
        expect(b.isBanned(undefined, '', 1)).toBe(false);
        b.add(undefined, 'Sam', 0);
        expect(b.isBanned(undefined, 'Sam', 1)).toBe(true);
    });
});

describe('map vote', () => {
    const maps = ['greybox', 'warehouse', 'third'];

    it('the most-voted map wins', () => {
        const m = new MapVote();
        m.pick(1, 'warehouse'); m.pick(2, 'warehouse'); m.pick(3, 'greybox');
        expect(m.winner('greybox', maps, ids(3))).toBe('warehouse');
        expect(m.counts(maps, ids(3)).get('warehouse')).toBe(2);
    });

    it('no votes, and ties that include the current map, stay on the current map', () => {
        const m = new MapVote();
        expect(m.winner('warehouse', maps, ids(3))).toBe('warehouse');
        m.pick(1, 'greybox'); m.pick(2, 'warehouse');
        expect(m.winner('warehouse', maps, ids(2))).toBe('warehouse');
        expect(m.winner('greybox', maps, ids(2))).toBe('greybox');
    });

    it('a tie between two other maps goes to the first installed', () => {
        const m = new MapVote();
        m.pick(1, 'third'); m.pick(2, 'warehouse');
        expect(m.winner('greybox', maps, ids(2))).toBe('warehouse');
    });

    it('a player can change their pick; leavers and unknown maps do not count', () => {
        const m = new MapVote();
        m.pick(1, 'warehouse'); m.pick(1, 'third'); m.pick(2, 'nonsense'); m.pick(3, 'warehouse');
        expect(m.mine(1)).toBe('third');
        expect(m.winner('greybox', maps, ids(3))).toBe('warehouse'); // 1 for third, 1 for warehouse: first installed
        expect(m.winner('greybox', maps, [1, 2])).toBe('third'); // player 3 left
        m.clear();
        expect(m.mine(1)).toBeNull();
    });
});
