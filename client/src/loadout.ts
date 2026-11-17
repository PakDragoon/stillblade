import { SIGHTS, SIGHT_IRON } from '@shared/weapons';

/**
 * The player's loadout choices (package M: the rifle sight), saved in localStorage under `sb-loadout` as
 * `{"sight":"reddot"}`. The sight is stored by its id rather than its index, so reordering `SIGHTS` never swaps
 * someone's choice. The game sends the choice to the server (join query `sight`, then a `sight` message on every
 * change); the server mounts it at the player's next spawn.
 */

export const LOADOUT_KEY = 'sb-loadout';

export interface Loadout {
    /** Index into SIGHTS (shared/weapons.ts). */
    sight: number;
}

interface StorageLike {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
}

/** Reads a saved loadout; anything missing, unknown or unreadable falls back to iron sights. */
export function parseLoadout(raw: string | null): Loadout {
    let sight = SIGHT_IRON;
    try {
        const v = raw ? (JSON.parse(raw) as unknown) : null;
        if (v && typeof v === 'object' && 'sight' in v) {
            const i = SIGHTS.findIndex(s => s.id === (v as { sight: unknown }).sight);
            if (i >= 0) sight = i;
        }
    } catch { /* corrupt: the default */ }
    return { sight };
}

export function serializeLoadout(l: Loadout): string {
    return JSON.stringify({ sight: SIGHTS[l.sight]?.id ?? SIGHTS[SIGHT_IRON].id });
}

/** The one shared loadout choice: read once, saved on every change, listeners told. */
export class LoadoutStore {
    private v: Loadout;
    private readonly listeners: ((l: Loadout) => void)[] = [];

    constructor(private readonly storage: StorageLike | null) {
        let raw: string | null = null;
        try { raw = storage?.getItem(LOADOUT_KEY) ?? null; } catch { /* storage blocked */ }
        this.v = parseLoadout(raw);
    }

    get value(): Readonly<Loadout> {
        return this.v;
    }

    /** Chooses a rifle sight (an index into SIGHTS; anything else is ignored). */
    setSight(sight: number): void {
        if (!Number.isInteger(sight) || sight < 0 || sight >= SIGHTS.length || sight === this.v.sight) return;
        this.v = { ...this.v, sight };
        try { this.storage?.setItem(LOADOUT_KEY, serializeLoadout(this.v)); } catch { /* not remembered */ }
        for (const f of this.listeners) f(this.v);
    }

    /** Calls `f` on every change (not now). */
    watch(f: (l: Loadout) => void): void {
        this.listeners.push(f);
    }
}

let shared: LoadoutStore | null = null;

/** The page's loadout store (localStorage when the browser allows it). */
export function loadout(): LoadoutStore {
    if (!shared) {
        let storage: StorageLike | null = null;
        try { storage = window.localStorage; } catch { /* blocked: choices last for this page only */ }
        shared = new LoadoutStore(storage);
    }
    return shared;
}
