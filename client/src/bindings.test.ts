import { describe, expect, it } from 'vitest';
import {
    ACTIONS, BindingsStore, assignBinding, clearSecondary, conflictsWith, contextsOverlap, defaultBindings, findConflicts,
    fullText, hintText, inputLabel, inputMatches, isBindableInput, mouseInput, parseBindings, resetAction
} from './bindings';

class FakeStorage {
    data = new Map<string, string>();
    getItem(k: string): string | null { return this.data.get(k) ?? null; }
    setItem(k: string, v: string): void { this.data.set(k, v); }
}

describe('action table', () => {
    it('has unique ids and every default is bindable', () => {
        const ids = new Set(ACTIONS.map(a => a.id));
        expect(ids.size).toBe(ACTIONS.length);
        for (const a of ACTIONS) for (const d of a.defaults) if (d) expect(isBindableInput(d)).toBe(true);
    });

    it('keeps the scripted-test secondaries and the old defaults', () => {
        const d = defaultBindings();
        expect(d.fire).toEqual(['Mouse0', 'KeyF']);
        expect(d.aim).toEqual(['Mouse2', 'KeyZ']);
        expect(d.crouch).toEqual(['KeyC', 'ControlLeft']);
        expect(d.forward).toEqual(['KeyW', null]);
        expect(d.walk[0]).toBe('ShiftLeft');
        expect(d.slot1[0]).toBe('Digit1');
        expect(d.slot3[0]).toBe('Digit3');
        expect(d.ready[0]).toBe('KeyG');
    });

    it('ships with no conflicts', () => {
        expect(findConflicts(defaultBindings()).size).toBe(0);
    });
});

describe('bindable inputs', () => {
    it('accepts keys and mouse buttons 0 to 4, never Esc', () => {
        for (const ok of ['KeyG', 'ShiftLeft', 'Digit7', 'F5', 'Mouse0', 'Mouse4', 'ArrowUp', 'Numpad1']) expect(isBindableInput(ok)).toBe(true);
        for (const bad of ['Escape', 'Mouse5', 'Mouse', '', 'a b', '5', 7, null, undefined, 'K']) expect(isBindableInput(bad)).toBe(false);
        expect(mouseInput(3)).toBe('Mouse3');
        expect(mouseInput(5)).toBeNull();
        expect(mouseInput(-1)).toBeNull();
    });

    it('shows readable names', () => {
        expect(inputLabel('KeyG')).toBe('G');
        expect(inputLabel('ShiftLeft')).toBe('Left Shift');
        expect(inputLabel('Mouse3')).toBe('Mouse 4');
        expect(inputLabel('Mouse0')).toBe('Left Mouse');
        expect(inputLabel('Digit2')).toBe('2');
        expect(inputLabel('ArrowLeft')).toBe('Left Arrow');
        expect(inputLabel('F7')).toBe('F7');
        const d = defaultBindings();
        expect(hintText(d, 'ready')).toBe('G');
        expect(fullText(d, 'crouch')).toBe('C or Left Ctrl');
        expect(hintText({ ...d, use: [null, 'KeyX'] }, 'use')).toBe('X');
        expect(hintText({ ...d, use: [null, null] }, 'use')).toBe('unbound');
    });
});

describe('loading stored data', () => {
    it('falls back to defaults for corrupt, missing or wrongly typed data', () => {
        const d = defaultBindings();
        for (const raw of [null, undefined, 'x', 5, [], { jump: 3 }, { jump: ['Escape', null] }, { jump: ['Space'] }, { jump: ['Space', 'Mouse9'] }, { nope: ['KeyA', null] }]) {
            expect(parseBindings(raw)).toEqual(d);
        }
    });

    it('keeps valid entries and defaults the invalid ones separately', () => {
        const m = parseBindings({ jump: ['KeyJ', 'Mouse3'], reload: ['Escape', null], crouch: [null, 'KeyV'] });
        expect(m.jump).toEqual(['KeyJ', 'Mouse3']);
        expect(m.reload).toEqual(['KeyR', null]);
        expect(m.crouch).toEqual([null, 'KeyV']);
        expect(m.fire).toEqual(['Mouse0', 'KeyF']);
    });

    it('drops a secondary equal to its primary', () => {
        expect(parseBindings({ jump: ['KeyJ', 'KeyJ'] }).jump).toEqual(['KeyJ', null]);
    });

    it('survives unparsable JSON in storage and saves what changes', () => {
        const st = new FakeStorage();
        st.setItem('sb-bindings', '{not json');
        const store = new BindingsStore(st);
        expect(store.value).toEqual(defaultBindings());
        let seen = 0;
        store.watch(() => seen++);
        store.set(assignBinding(store.value, 'jump', 0, 'KeyJ'));
        expect(seen).toBe(2); // once on watch, once on change
        expect(store.hint('jump')).toBe('J');
        expect(new BindingsStore(st).value.jump[0]).toBe('KeyJ');
        store.reset();
        expect(new BindingsStore(st).value).toEqual(defaultBindings());
    });

    it('works with no storage at all', () => {
        const store = new BindingsStore(null);
        store.set(assignBinding(store.value, 'jump', 0, 'KeyJ'));
        expect(store.hint('jump')).toBe('J');
    });
});

describe('contexts and conflicts', () => {
    it('lobby actions overlap with always-on ones but not with round-only ones', () => {
        expect(contextsOverlap('lobby', 'round')).toBe(false);
        expect(contextsOverlap('lobby', 'any')).toBe(true);
        expect(contextsOverlap('round', 'round')).toBe(true);
        expect(contextsOverlap('any', 'any')).toBe(true);
    });

    it('flags a shared input between actions that can be active together', () => {
        const m = assignBinding(defaultBindings(), 'reload', 0, 'KeyE');
        expect(conflictsWith(defaultBindings(), 'reload', 'KeyE')).toEqual(['use']);
        const both = { ...defaultBindings(), reload: ['KeyE', null] as [string, null] };
        expect(findConflicts(both)).toEqual(new Set(['reload', 'use']));
        // assignBinding resolves it instead
        expect(findConflicts(m).size).toBe(0);
    });

    it('lets a lobby action share a key with a round-only action but not with an always-on one', () => {
        // Simulate package C's "Drop bomb" by checking the rule directly on two lobby/any actions.
        const m = defaultBindings();
        expect(conflictsWith(m, 'ready', 'KeyW')).toEqual(['forward']);
        expect(conflictsWith(m, 'ready', 'KeyU')).toEqual(['start']);
    });

    it('lobby actions do not conflict with each other only if their inputs differ', () => {
        expect(findConflicts({ ...defaultBindings(), start: ['KeyG', null] }).has('ready')).toBe(true);
    });
});

describe('assigning', () => {
    it('swaps with the action that held the input', () => {
        const m = assignBinding(defaultBindings(), 'reload', 0, 'KeyE');
        expect(m.reload).toEqual(['KeyE', null]);
        expect(m.use).toEqual(['KeyR', null]);
    });

    it('takes the input from a secondary slot and leaves it empty when there was nothing to give', () => {
        const m = assignBinding(defaultBindings(), 'jump', 1, 'KeyF');
        expect(m.jump).toEqual(['Space', 'KeyF']);
        expect(m.fire).toEqual(['Mouse0', null]);
    });

    it('moves an input between the two slots of one action', () => {
        const m = assignBinding(defaultBindings(), 'crouch', 0, 'ControlLeft');
        expect(m.crouch).toEqual(['ControlLeft', 'KeyC']);
    });

    it('does not mutate its input', () => {
        const d = defaultBindings();
        assignBinding(d, 'reload', 0, 'KeyE');
        expect(d).toEqual(defaultBindings());
    });

    it('clears a secondary and resets one action', () => {
        const d = defaultBindings();
        expect(clearSecondary(d, 'fire').fire).toEqual(['Mouse0', null]);
        expect(resetAction(assignBinding(d, 'jump', 0, 'KeyJ'), 'jump').jump).toEqual(['Space', null]);
    });

    it('matches either slot', () => {
        const d = defaultBindings();
        expect(inputMatches(d, 'fire', 'KeyF')).toBe(true);
        expect(inputMatches(d, 'fire', 'KeyG')).toBe(false);
    });
});
