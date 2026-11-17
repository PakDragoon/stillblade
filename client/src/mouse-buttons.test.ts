import { describe, expect, it } from 'vitest';
import { mouseInput } from './bindings';
import { BUTTON_BITS, MOUSE_CODES, buttonBit, buttonsConsistent, releaseMissingButtons } from './mouse-buttons';

describe('mouse button reconcile (stuck aim)', () => {
    it('maps button indices to the buttons bits, which use a different order', () => {
        // button: 0 left, 1 middle, 2 right, 3 back, 4 forward. buttons: 1 left, 2 right, 4 middle, 8 back, 16 forward.
        expect(buttonBit(0)).toBe(1);
        expect(buttonBit(1)).toBe(4);
        expect(buttonBit(2)).toBe(2);
        expect(buttonBit(3)).toBe(8);
        expect(buttonBit(4)).toBe(16);
        expect(buttonBit(5)).toBe(0);
        expect(buttonBit(-1)).toBe(0);
        expect(buttonBit(1.5)).toBe(0);
        expect(new Set(BUTTON_BITS).size).toBe(5);
    });

    it('names mouse inputs exactly as the bindings do', () => {
        for (let i = 0; i < 5; i++) expect(MOUSE_CODES[i]).toBe(`Mouse${i}`);
        for (let i = 0; i < 5; i++) expect(mouseInput(i)).toBe(MOUSE_CODES[i]);
        expect(mouseInput(5)).toBeNull();
    });

    it('releases a held right button whose mouseup was lost', () => {
        const held = new Set(['Mouse2', 'KeyW']);
        expect(releaseMissingButtons(held, 0)).toBe(1);
        expect([...held]).toEqual(['KeyW']);
    });

    it('keeps buttons that are still down, by the right bit', () => {
        const held = new Set(['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4']);
        // Right (2) and middle (4) still down: left and both side buttons go.
        expect(releaseMissingButtons(held, 2 | 4)).toBe(3);
        expect([...held].sort()).toEqual(['Mouse1', 'Mouse2']);
        // Only the right button down: middle goes, right stays (the bit order trap: right is 2, not 4).
        expect(releaseMissingButtons(held, 2)).toBe(1);
        expect([...held]).toEqual(['Mouse2']);
        expect(releaseMissingButtons(held, 2)).toBe(0);
    });

    it('never touches keyboard codes', () => {
        const held = new Set(['KeyZ', 'ShiftLeft', 'Digit1']);
        expect(releaseMissingButtons(held, 0)).toBe(0);
        expect(held.size).toBe(3);
    });

    it('judges whether a browser reports buttons honestly', () => {
        expect(buttonsConsistent('mousedown', 2, 2)).toBe(true);
        expect(buttonsConsistent('mousedown', 2, 0)).toBe(false); // a browser that always says 0
        expect(buttonsConsistent('mousedown', 1, 4)).toBe(true);
        expect(buttonsConsistent('mousedown', 1, 2)).toBe(false);
        expect(buttonsConsistent('mouseup', 2, 0)).toBe(true);
        expect(buttonsConsistent('mouseup', 2, 2)).toBe(false);
        expect(buttonsConsistent('mouseup', 0, 2)).toBe(true); // left released, right still down
        expect(buttonsConsistent('mousedown', 7, 0)).toBeNull();
    });
});
