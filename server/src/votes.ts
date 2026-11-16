/**
 * Votes and bans for one room: the vote to kick, the ban list and the map vote. Pure logic with the
 * time passed in (server time in ms), no sockets and no `Game`: tested in votes.test.ts. `Game`
 * calls these from short hooks and does the sending.
 */

export const KICK_MIN_PLAYERS = 3;
export const KICK_VOTE_MS = 30_000;
export const KICK_CALLER_COOLDOWN_MS = 120_000;
export const KICK_TARGET_PROTECT_MS = 120_000;
export const BAN_MS = 600_000;
/** The map vote closes this long before the next match starts, so every client can download the new map first. */
export const MAP_VOTE_LEAD_MS = 8000;

export interface KickOutcome {
    result: 'passed' | 'failed' | 'cancelled';
    target: number;
    caller: number;
}

export interface KickTally {
    yes: number;
    no: number;
    /** Yes votes that pass it: more than half of the connected players. */
    needed: number;
}

/** One vote at a time per room. `present` is always the ids of the connected (human) players. */
export class KickVote {
    active: { target: number; caller: number; endsAt: number; readonly votes: Map<number, boolean> } | null = null;
    private readonly callerFreeAt = new Map<number, number>();
    private readonly targetSafeUntil = new Map<number, number>();

    /** More than half of `connected`, the target included: 2 of 3, 3 of 4, 3 of 5. */
    static needed(connected: number): number {
        return Math.floor(connected / 2) + 1;
    }

    /** Starts a vote and counts the caller as yes; returns why it was refused, or null. */
    start(caller: number, target: number, now: number, present: readonly number[]): string | null {
        if (this.active) return 'A vote is already running.';
        if (present.length < KICK_MIN_PLAYERS) return `A vote to remove someone needs at least ${KICK_MIN_PLAYERS} players in the room.`;
        if (caller === target) return 'You cannot vote against yourself.';
        if (!present.includes(caller) || !present.includes(target)) return 'That player is not in the room.';
        const wait = (this.callerFreeAt.get(caller) ?? 0) - now;
        if (wait > 0) return `Wait ${Math.ceil(wait / 1000)} s before you start another vote.`;
        if ((this.targetSafeUntil.get(target) ?? 0) > now) return 'A vote against that player just failed. Try again later.';
        this.callerFreeAt.set(caller, now + KICK_CALLER_COOLDOWN_MS);
        this.active = { target, caller, endsAt: now + KICK_VOTE_MS, votes: new Map([[caller, true]]) };
        return null;
    }

    /** A vote from a connected player other than the target; the last answer counts. Returns false if it was refused. */
    cast(voter: number, yes: boolean, present: readonly number[]): boolean {
        const a = this.active;
        if (!a || voter === a.target || !present.includes(voter)) return false;
        a.votes.set(voter, yes);
        return true;
    }

    tally(present: readonly number[]): KickTally {
        const a = this.active;
        let yes = 0, no = 0;
        if (a) for (const [id, v] of a.votes) if (present.includes(id)) { if (v) yes++; else no++; }
        return { yes, no, needed: KickVote.needed(present.length) };
    }

    /** Decides the vote if it can be decided now (also as people leave); clears it when it is. */
    step(now: number, present: readonly number[]): KickOutcome | null {
        const a = this.active;
        if (!a) return null;
        const done = (result: KickOutcome['result']): KickOutcome => {
            this.active = null;
            if (result === 'failed') this.targetSafeUntil.set(a.target, now + KICK_TARGET_PROTECT_MS);
            return { result, target: a.target, caller: a.caller };
        };
        if (!present.includes(a.target) || present.length < KICK_MIN_PLAYERS) return done('cancelled');
        const { yes, no, needed } = this.tally(present);
        if (yes >= needed) return done('passed');
        // Voters who have not answered yet and could still say yes: the target cannot vote.
        const undecided = present.length - 1 - yes - no;
        if (yes + undecided < needed || now >= a.endsAt) return done('failed');
        return null;
    }
}

/** Who may not come back to this room, by address and by cleaned name. Lives and dies with the room. */
export class Bans {
    private readonly ips = new Map<string, number>();
    private readonly names = new Map<string, number>();

    private static key(name: string): string {
        return name.trim().toLowerCase();
    }

    add(ip: string | undefined, name: string, now: number, ms = BAN_MS): void {
        if (ip) this.ips.set(ip, now + ms);
        const k = Bans.key(name);
        if (k) this.names.set(k, now + ms);
    }

    isBanned(ip: string | undefined, name: string, now: number): boolean {
        const byIp = ip ? this.ips.get(ip) : undefined;
        const byName = this.names.get(Bans.key(name));
        if (byIp !== undefined && byIp <= now) this.ips.delete(ip!);
        if (byName !== undefined && byName <= now) this.names.delete(Bans.key(name));
        return (byIp !== undefined && byIp > now) || (byName !== undefined && byName > now);
    }
}

/** Result-card map picks: one per player, by id. */
export class MapVote {
    private readonly picks = new Map<number, string>();

    clear(): void {
        this.picks.clear();
    }

    pick(player: number, map: string): void {
        this.picks.set(player, map);
    }

    mine(player: number): string | null {
        return this.picks.get(player) ?? null;
    }

    /** Votes per installed map from players who are still connected. */
    counts(ids: readonly string[], present: readonly number[]): Map<string, number> {
        const n = new Map(ids.map(id => [id, 0]));
        for (const [player, map] of this.picks) if (present.includes(player) && n.has(map)) n.set(map, n.get(map)! + 1);
        return n;
    }

    /**
     * The most-voted map. The current map wins a tie it takes part in and when there are no votes; a tie
     * between other maps goes to the first of them in `ids` (installed order).
     */
    winner(current: string, ids: readonly string[], present: readonly number[]): string {
        const n = this.counts(ids, present);
        let best = 0;
        for (const c of n.values()) best = Math.max(best, c);
        if (best === 0 || n.get(current) === best) return current;
        return ids.find(id => n.get(id) === best) ?? current;
    }
}
