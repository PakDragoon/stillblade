/**
 * Held mouse buttons reconciled with `MouseEvent.buttons` (the stuck-aim fix, package M).
 *
 * `Input` records a mouse button on `mousedown` and forgets it on `mouseup`. If the browser never
 * delivers that `mouseup` (pointer lock lost or gained mid-press, a native menu grabbing the release,
 * a focus change between press and release) the button stays held: aim down sights stays on in hold
 * mode, and in toggle mode the next press is swallowed. Every mouse event carries `buttons`, the set
 * of buttons that are down right now, so each one can release whatever we still hold but the mouse
 * no longer does.
 *
 * Careful: `buttons` does not use the order of `button`. `button` 0 left, 1 middle, 2 right, 3 back,
 * 4 forward; `buttons` bits 1 left, 2 right, 4 middle, 8 back, 16 forward.
 */

/** The input names `Input` and the bindings use for `button` 0 to 4. Built once, so lookups allocate nothing. */
export const MOUSE_CODES: readonly string[] = ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4'];

/** The `MouseEvent.buttons` bit of each `MouseEvent.button` index. */
export const BUTTON_BITS: readonly number[] = [1, 4, 2, 8, 16];

/** The `buttons` bit of a `button` index, or 0 for an index outside 0 to 4. */
export function buttonBit(button: number): number {
    return button >= 0 && button <= 4 && (button | 0) === button ? BUTTON_BITS[button] : 0;
}

/**
 * Removes from `held` every mouse input (`Mouse0` to `Mouse4`) whose bit is not set in `buttons`.
 * Keyboard codes are left alone. Returns how many were released. Allocates nothing.
 */
export function releaseMissingButtons(held: Set<string>, buttons: number): number {
    let released = 0;
    for (let i = 0; i < 5; i++) {
        if ((buttons & BUTTON_BITS[i]) !== 0) continue;
        if (held.delete(MOUSE_CODES[i])) released++;
    }
    return released;
}

/**
 * Whether this browser's `buttons` can be trusted, judged from one event: on a `mousedown` the
 * pressed button's bit must be set, on a `mouseup` the released button's bit must be clear. A browser
 * that reports `buttons` as always 0 (some old engines did, inside pointer lock) would otherwise
 * release aim on every mouse move. Returns null when the event says nothing (a button outside 0 to 4).
 */
export function buttonsConsistent(type: 'mousedown' | 'mouseup', button: number, buttons: number): boolean | null {
    const bit = buttonBit(button);
    if (bit === 0) return null;
    return type === 'mousedown' ? (buttons & bit) !== 0 : (buttons & bit) === 0;
}
