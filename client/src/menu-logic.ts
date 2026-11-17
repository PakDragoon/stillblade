import type { RosterEntry } from '@shared/protocol';
import type { RoomOptions } from '@shared/room-options';

/** The pages of the pre-game menu. Each opens from another and Back / Esc returns one step. */
export type PageId = 'home' | 'rooms' | 'create' | 'practice' | 'loadout' | 'settings' | 'howto';

/** Where Back goes when there is no history to return to (a page opened first, such as the first-visit how-to). */
export const PAGE_PARENT: Record<PageId, PageId | null> = {
    home: null, rooms: 'home', create: 'rooms', practice: 'home', loadout: 'home', settings: 'home', howto: 'home'
};

/** Which page is showing and the way back. Pure state: the menu draws whatever `page` says. */
export class PageNav {
    private readonly trail: PageId[] = [];
    constructor(public page: PageId = 'home') {}

    /** Opens `next` (a no-op for the page already showing). */
    go(next: PageId): void {
        if (next === this.page) return;
        // Going to a page already in the trail (Back by button, "Rooms" from Create) unwinds to it instead of piling up.
        const at = this.trail.lastIndexOf(next);
        if (at >= 0) this.trail.length = at;
        else this.trail.push(this.page);
        this.page = next;
    }

    /** Shows `next` with nothing to go back to (leaving the first-visit how-to for the home page). */
    reset(next: PageId): void {
        this.trail.length = 0;
        this.page = next;
    }

    /** One step back. False when already on the home page (Esc there does nothing). */
    back(): boolean {
        const to = this.trail.pop() ?? PAGE_PARENT[this.page];
        if (to === null) return false;
        this.page = to;
        return true;
    }
}

/** Whether a vote to remove a player can be called now: three or more people in the room (bots never count) and no vote running. */
export function canCallVoteKick(roster: readonly RosterEntry[], localId: number, voteRunning: boolean): boolean {
    if (voteRunning || !roster.some(p => p.id === localId)) return false;
    return roster.filter(p => !p.bot).length >= 3;
}

/**
 * The room's options as label and value pairs in the order the create form shows them; the lobby panel lists
 * them the same way. `fillBots` off shows the bot skill as not in use.
 */
export function describeOptions(o: Readonly<RoomOptions>, mapName: string): [string, string][] {
    const skill = o.botLevel === 'easy' ? 'Easy' : o.botLevel === 'hard' ? 'Hard' : 'Normal';
    return [
        ['Visibility', o.public ? 'Public' : 'Private'],
        ['Map', mapName],
        ['Most players', String(o.maxPlayers)],
        ['Rounds to win', String(o.roundsToWin)],
        ['Suppressed weapons', o.suppressed ? 'On' : 'Off'],
        ['Fill with bots', o.fillBots ? 'On' : 'Off'],
        ['Bot skill', o.fillBots ? skill : 'Not in use']
    ];
}

/** "3 / 10" with the bots named when there are any: how a room list row shows its crowd. */
export function crowdText(players: number, bots: number, capacity: number): string {
    return bots > 0 ? `${players} / ${capacity} (+${bots} bot${bots === 1 ? '' : 's'})` : `${players} / ${capacity}`;
}
