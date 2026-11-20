// Package W: reading match records (server/src/matchlog.ts lines). Pure functions shared by
// `tools/matchstats.ts` and `tools/data.ts`, tested in tools/matchsummary.test.ts.
import type { AbandonedRecord, MatchLogLine, MatchRecord, RoundRecord } from '../server/src/matchlog';

/** Parses JSON lines, skipping blank and broken ones (a line cut short by a crash). */
export function parseLines(text: string): MatchLogLine[] {
    const out: MatchLogLine[] = [];
    for (const l of text.split(/\r?\n/)) {
        if (!l.trim()) continue;
        try {
            const v = JSON.parse(l) as MatchLogLine;
            if (v && (v.type === 'round' || v.type === 'match' || v.type === 'abandoned')) out.push(v);
        } catch { /* skipped */ }
    }
    return out;
}

export interface MatchGroup {
    room: string;
    started: string;
    map: string;
    rounds: RoundRecord[];
    end: MatchRecord | AbandonedRecord | null;
}

/** The lines grouped by match (room and start time), oldest first. */
export function groupMatches(lines: readonly MatchLogLine[]): MatchGroup[] {
    const byKey = new Map<string, MatchGroup>();
    for (const l of lines) {
        const key = `${l.room} ${l.started}`;
        let g = byKey.get(key);
        if (!g) byKey.set(key, g = { room: l.room, started: l.started, map: l.map, rounds: [], end: null });
        if (l.type === 'round') g.rounds.push(l);
        else g.end = l;
    }
    return [...byKey.values()].sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : 0));
}

const REASON_WORDS: Record<string, string> = { eliminated: 'elimination', exploded: 'bomb exploded', defused: 'defused', time: 'time ran out' };
export const reasonWords = (r: string): string => REASON_WORDS[r] ?? r;

/** One line per match, for people: date, map, score, how each round ended, ghost and defender wins. */
export function describeMatch(g: MatchGroup): string {
    const ghostWins = g.rounds.filter(r => r.winner === 'ghosts').length;
    const score = g.end?.sideScore ?? g.rounds.at(-1)?.sideScore ?? [0, 0];
    const state = !g.end ? 'still going or cut off' : g.end.type === 'match' ? `won by side ${g.end.winnerSide + 1}` : `abandoned (${g.end.why})`;
    const endings = g.rounds.map(r => `${r.winner === 'ghosts' ? 'G' : 'D'}:${reasonWords(r.reason)}`).join(', ');
    const people = new Set<string>();
    for (const r of g.rounds) for (const p of r.players) if (!p.bot) people.add(p.name);
    return `${g.started.slice(0, 16).replace('T', ' ')}  ${g.map.padEnd(10)} ${g.room.padEnd(14)} ${score[0]}:${score[1]} ${state}; ` +
        `${g.rounds.length} rounds, ghosts won ${ghostWins}, defenders ${g.rounds.length - ghostWins}` +
        (people.size ? `; players ${[...people].join(', ')}` : '') + (endings ? `\n    rounds: ${endings}` : '');
}

export interface Tally { [key: string]: number }

export interface Stats {
    rounds: number;
    matches: number;
    abandoned: number;
    wins: { ghosts: number; defenders: number };
    /** Per map: rounds and wins by side. */
    maps: Record<string, { rounds: number; ghosts: number; defenders: number }>;
    /** "ghosts: bomb exploded" and so on. */
    ways: Tally;
    avgRoundSeconds: number;
    killsByWeapon: Tally;
    killsByZone: Tally;
    plants: number;
    defuses: number;
    /** Rounds in rooms with fill bots, and their ghost wins (bot balance can hide people's balance). */
    botRounds: number;
}

const bump = (t: Tally, k: string, n = 1): void => { t[k] = (t[k] ?? 0) + n; };

/** The balance numbers over every round in `lines`. */
export function matchStats(lines: readonly MatchLogLine[]): Stats {
    const s: Stats = {
        rounds: 0, matches: 0, abandoned: 0, wins: { ghosts: 0, defenders: 0 }, maps: {}, ways: {}, avgRoundSeconds: 0,
        killsByWeapon: {}, killsByZone: {}, plants: 0, defuses: 0, botRounds: 0
    };
    let seconds = 0;
    for (const l of lines) {
        if (l.type === 'match') { s.matches++; continue; }
        if (l.type === 'abandoned') { s.abandoned++; continue; }
        s.rounds++;
        s.wins[l.winner]++;
        const m = s.maps[l.map] ??= { rounds: 0, ghosts: 0, defenders: 0 };
        m.rounds++;
        m[l.winner]++;
        bump(s.ways, `${l.winner}: ${reasonWords(l.reason)}`);
        seconds += l.seconds;
        if (l.plant) s.plants++;
        if (l.defuse) s.defuses++;
        if (l.players.some(p => p.bot)) s.botRounds++;
        for (const k of l.kills) {
            bump(s.killsByWeapon, k.weapon);
            bump(s.killsByZone, k.zone ?? (k.kind === 'backstab' ? 'back (knife)' : 'front (knife)'));
        }
    }
    s.avgRoundSeconds = s.rounds ? seconds / s.rounds : 0;
    return s;
}

const pct = (n: number, of: number): string => (of ? `${((100 * n) / of).toFixed(0)}%` : '-');

function tallyLines(t: Tally, of: number): string[] {
    return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k.padEnd(28)} ${String(n).padStart(5)}  ${pct(n, of)}`);
}

/** The statistics as text for the terminal. */
export function formatStats(s: Stats): string {
    const kills = Object.values(s.killsByWeapon).reduce((a, b) => a + b, 0);
    const out = [
        `${s.rounds} rounds in ${s.matches} finished matches (${s.abandoned} abandoned); ${s.botRounds} rounds had bots in them`,
        `Win rate: ghosts ${pct(s.wins.ghosts, s.rounds)} (${s.wins.ghosts}), defenders ${pct(s.wins.defenders, s.rounds)} (${s.wins.defenders})`,
        `Average round: ${s.avgRoundSeconds.toFixed(1)} s of live play; plants in ${pct(s.plants, s.rounds)} of rounds, defuses ${s.defuses}`,
        '', 'Per map:',
        ...Object.entries(s.maps).map(([m, v]) => `  ${m.padEnd(28)} ${String(v.rounds).padStart(5)} rounds, ghosts win ${pct(v.ghosts, v.rounds)}`),
        '', 'How rounds are won:', ...tallyLines(s.ways, s.rounds),
        '', `Kills by weapon (${kills}):`, ...tallyLines(s.killsByWeapon, kills),
        '', 'Kills by body zone:', ...tallyLines(s.killsByZone, kills)
    ];
    return out.join('\n');
}
