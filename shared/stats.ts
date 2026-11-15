import type { MatchStats } from './protocol';

/** A kill counts as an assist for the others who damaged the victim within this long before it. */
export const ASSIST_MS = 4000;

export const emptyStats = (): MatchStats => ({
    kills: 0, deaths: 0, assists: 0, headshots: 0, backstabs: 0, damage: 0, plants: 0, defuses: 0
});

/**
 * Most-valuable-player score: 2 per kill, 1 per assist, 0.5 per headshot or backstab (skill bonus),
 * 1 per 100 damage, 3 per plant or defuse (the objectives decide rounds), minus 0.5 per death.
 * Highest wins; ties go to fewer deaths, then to the lower player id.
 */
export function mvpScore(s: MatchStats): number {
    return s.kills * 2 + s.assists + (s.headshots + s.backstabs) * 0.5 + s.damage / 100 + (s.plants + s.defuses) * 3 - s.deaths * 0.5;
}

export function pickMvp(players: readonly (MatchStats & { id: number })[]): number {
    let best: (MatchStats & { id: number }) | undefined;
    let bestScore = -Infinity;
    for (const p of players) {
        const sc = mvpScore(p);
        if (!best || sc > bestScore || (sc === bestScore && (p.deaths < best.deaths || (p.deaths === best.deaths && p.id < best.id)))) {
            best = p;
            bestScore = sc;
        }
    }
    return best?.id ?? 0;
}
