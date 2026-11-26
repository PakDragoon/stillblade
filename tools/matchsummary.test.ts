import { describe, expect, it } from 'vitest';
import { describeMatch, groupMatches, matchStats, parseLines } from './matchsummary';
import { formatReport } from './reportformat';

const base = { room: 'r1', started: '2026-11-20T10:00:00.000Z', map: 'warehouse', options: {} };
const round = (n: number, winner: 'ghosts' | 'defenders', reason: string, kills: object[], bot = false) => JSON.stringify({
    type: 'round', time: `2026-11-20T10:0${n}:00.000Z`, ...base, round: n, ghostSide: 0, winner, reason, seconds: 60 + n,
    score: { ghosts: 0, defenders: 0 }, sideScore: [n, 0], plant: reason === 'exploded' ? { by: 1 } : null, defuse: null, kills,
    players: [{ id: 1, name: 'Ann', team: 'ghosts', side: 0, bot: false }, { id: 2, name: 'BOT X', team: 'defenders', side: 1, bot }]
});

describe('package W: reading match records', () => {
    const text = [
        round(1, 'ghosts', 'exploded', [{ weapon: 'ghost knife', kind: 'backstab' }]),
        round(2, 'defenders', 'eliminated', [{ weapon: 'rifle', kind: 'shot', zone: 'head' }, { weapon: 'rifle', kind: 'shot', zone: 'torso' }], true),
        '{"type":"round", broken',
        '',
        JSON.stringify({ type: 'match', time: '2026-11-20T10:05:00.000Z', ...base, rounds: 2, winner: 'ghosts', winnerSide: 0, score: { ghosts: 1, defenders: 1 }, sideScore: [2, 1], seconds: 300, mvp: 1, mvpName: 'Ann', players: [], recording: 'x' }),
        JSON.stringify({ type: 'abandoned', time: '2026-11-21T10:00:00.000Z', ...base, started: '2026-11-21T09:00:00.000Z', why: 'room closed', rounds: 0, sideScore: [0, 0], seconds: 5, recording: null })
    ].join('\n');

    it('skips broken lines and groups rounds into matches', () => {
        const lines = parseLines(text);
        expect(lines).toHaveLength(4);
        const groups = groupMatches(lines);
        expect(groups).toHaveLength(2);
        expect(groups[0].rounds).toHaveLength(2);
        expect(describeMatch(groups[0])).toContain('2:1 won by side 1');
        expect(describeMatch(groups[0])).toContain('G:bomb exploded, D:elimination');
        expect(describeMatch(groups[1])).toContain('abandoned (room closed)');
    });

    it('counts win rates, ways of winning, round length and kills by weapon and zone', () => {
        const s = matchStats(parseLines(text));
        expect(s.rounds).toBe(2);
        expect(s.matches).toBe(1);
        expect(s.abandoned).toBe(1);
        expect(s.wins).toEqual({ ghosts: 1, defenders: 1 });
        expect(s.maps.warehouse).toEqual({ rounds: 2, ghosts: 1, defenders: 1 });
        expect(s.ways).toEqual({ 'ghosts: bomb exploded': 1, 'defenders: elimination': 1 });
        expect(s.avgRoundSeconds).toBeCloseTo(61.5);
        expect(s.killsByWeapon).toEqual({ 'ghost knife': 1, rifle: 2 });
        expect(s.killsByZone).toEqual({ 'back (knife)': 1, head: 1, torso: 1 });
        expect(s.plants).toBe(1);
        expect(s.botRounds).toBe(1);
        expect(s.compositions.warehouse).toEqual({
            human: { rounds: 1, ghosts: 1, defenders: 0, plants: 1, defuses: 0 },
            mixed: { rounds: 1, ghosts: 0, defenders: 1, plants: 0, defuses: 0 }
        });
    });

    it('prints a feedback line readably', () => {
        const out = formatReport(JSON.stringify({
            time: '2026-11-20T10:00:00.000Z', kind: 'error', text: 'boom', stack: 'at a\nat b', ctx: { fps: 60, gpu: 'Intel UHD 620', ua: 'Chrome' },
            server: { via: 'ws', room: 'r', map: 'warehouse', name: 'Ann', protocol: 17 }
        }));
        expect(out).toContain('ERROR REPORT');
        expect(out).toContain('Ann');
        expect(out).toContain('boom');
        expect(out).toContain('Intel UHD 620');
        expect(formatReport('not json')).toContain('unreadable');
    });
});
