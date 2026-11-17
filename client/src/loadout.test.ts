import { describe, expect, it } from 'vitest';
import { SIGHTS, SIGHT_IRON } from '@shared/weapons';
import { LOADOUT_KEY, LoadoutStore, parseLoadout, serializeLoadout } from './loadout';

class FakeStorage {
    data = new Map<string, string>();
    getItem(k: string): string | null { return this.data.get(k) ?? null; }
    setItem(k: string, v: string): void { this.data.set(k, v); }
}

describe('saved loadout (sb-loadout)', () => {
    it('reads a saved sight by id, and falls back to iron sights on anything else', () => {
        expect(parseLoadout('{"sight":"reddot"}').sight).toBe(SIGHTS.findIndex(s => s.id === 'reddot'));
        expect(parseLoadout('{"sight":"scope2x"}').sight).toBe(SIGHTS.findIndex(s => s.id === 'scope2x'));
        for (const raw of [null, '', 'nope', '{', '[]', '{"sight":2}', '{"sight":"x"}', '{}', 'null', '"reddot"']) {
            expect(parseLoadout(raw).sight).toBe(SIGHT_IRON);
        }
    });

    it('round-trips every sight', () => {
        for (let i = 0; i < SIGHTS.length; i++) expect(parseLoadout(serializeLoadout({ sight: i })).sight).toBe(i);
    });

    it('saves a change, tells listeners once, and ignores invalid or unchanged choices', () => {
        const st = new FakeStorage();
        const store = new LoadoutStore(st);
        expect(store.value.sight).toBe(SIGHT_IRON);
        const seen: number[] = [];
        store.watch(l => seen.push(l.sight));
        store.setSight(2);
        store.setSight(2);
        store.setSight(-1);
        store.setSight(SIGHTS.length);
        store.setSight(1.5);
        expect(seen).toEqual([2]);
        expect(st.getItem(LOADOUT_KEY)).toBe('{"sight":"scope2x"}');
        expect(new LoadoutStore(st).value.sight).toBe(2); // the next page load remembers it
    });

    it('works when storage throws', () => {
        const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
        const store = new LoadoutStore(bad);
        expect(store.value.sight).toBe(SIGHT_IRON);
        store.setSight(1);
        expect(store.value.sight).toBe(1);
        expect(new LoadoutStore(null).value.sight).toBe(SIGHT_IRON);
    });
});
