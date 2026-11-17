import type { LoadoutInput } from '@shared/gun';
import type { InputCmd } from '@shared/types';
import { ACTIONS, bindings, defaultBindings, mouseInput, type ActionId, type BindingMap } from './bindings';
import { buttonsConsistent, releaseMissingButtons } from './mouse-buttons';

const BASE_SENSITIVITY = 0.0022; // radians per pixel of mouse movement at multiplier 1
const PITCH_LIMIT = (89 * Math.PI) / 180;
/** Digit key names for weapon slots beyond the rebindable ones (1 to 3), built once. */
const DIGITS = ['', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];
const SLOT_ACTIONS: readonly ActionId[] = ['slot1', 'slot2', 'slot3'];

/**
 * Keyboard and pointer-lock mouse, sampled once per simulation tick. Which key or button does what comes
 * from `bindings()`; the pressed inputs are kept as strings ("KeyW", "Mouse0") in one set, and each
 * action is looked up through its two bound inputs, so nothing is allocated per tick.
 */
export class Input {
    yaw = 0;
    pitch = 0;
    /** Mouse-look multiplier: the game lowers it while aiming down sights so the zoomed view is not twitchy. */
    lookScale = 1;
    private readonly keys = new Set<string>();
    private jumpQueued = false;
    private swapQueued = false;
    /** A press of "Drop bomb" not yet sent: one press drops once. */
    private dropQueued = false;
    /** Mouse wheel notches not yet sent: positive is down (next weapon). */
    private wheelSteps = 0;
    /** Settings: multiplier on the base sensitivity, and inverted vertical look. */
    sensitivity = 1;
    invertY = false;
    /** Multiplier on mouse look while aiming (on top of `lookScale`). */
    aimSensitivity = 1;
    /** While true (typing in chat, a menu open) game keys and the mouse do nothing. */
    suspended = false;
    /** Hold or toggle for crouch, quiet walk and aim; the toggled state lives here. */
    private crouchToggle = false;
    private walkToggle = false;
    private aimToggle = false;
    private crouchOn = false;
    private walkOn = false;
    private aimOn = false;
    /** The bindings in use, replaced (not edited) when they change. */
    private b: BindingMap = defaultBindings();
    private bound = new Set<string>();
    /**
     * Whether this browser's `MouseEvent.buttons` agrees with its presses and releases: 0 not known yet,
     * 1 yes (held buttons are reconciled with it on every mouse event), -1 no (never reconciled, so a
     * browser reporting 0 inside pointer lock cannot cancel aim on every move).
     */
    private buttonsTrust = 0;

    /** Attack (any bound button or key). */
    get fire(): boolean {
        return this.pressed('fire');
    }

    constructor(private readonly canvas: HTMLCanvasElement) {
        bindings().watch(m => this.setBindings(m));
        window.addEventListener('keydown', e => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return; // typing in a menu or chat
            if (this.suspended) return;
            if (this.bound.has(e.code) || e.code === 'Tab') e.preventDefault(); // no page scroll, no focus change
            if (e.repeat) return;
            this.press(e.code);
        });
        window.addEventListener('keyup', e => this.keys.delete(e.code));
        window.addEventListener('blur', () => this.keys.clear());
        document.addEventListener('mousedown', e => {
            this.judgeButtons('mousedown', e);
            this.reconcileButtons(e.buttons); // before the press: a button whose release was lost goes first
            if (!this.locked || this.suspended) return;
            const code = mouseInput(e.button);
            if (code === null) return;
            if (e.button !== 0 && e.button !== 2) e.preventDefault(); // middle-click scroll, side buttons going back
            this.press(code);
        });
        document.addEventListener('mouseup', e => {
            this.judgeButtons('mouseup', e);
            const code = mouseInput(e.button);
            if (code !== null) {
                if (this.locked && e.button !== 0 && e.button !== 2) e.preventDefault();
                this.keys.delete(code);
            }
            this.reconcileButtons(e.buttons);
        });
        // Gaining or losing pointer lock: a press made while the mouse was free was never recorded, and a
        // release made around the change may never arrive. Whatever is held now is stale.
        document.addEventListener('pointerlockchange', () => releaseMissingButtons(this.keys, 0));
        document.addEventListener('auxclick', e => { if (this.locked) e.preventDefault(); });
        document.addEventListener('contextmenu', e => { if (this.locked) e.preventDefault(); });
        document.addEventListener('wheel', e => {
            if (!this.locked || this.suspended || e.deltaY === 0) return;
            this.wheelSteps += e.deltaY > 0 ? 1 : -1;
        }, { passive: true });
        document.addEventListener('mousemove', e => {
            this.reconcileButtons(e.buttons);
            if (!this.locked || this.suspended) return;
            const k = BASE_SENSITIVITY * this.sensitivity * this.lookScale * (this.aim ? this.aimSensitivity : 1);
            this.yaw -= e.movementX * k;
            this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * k * (this.invertY ? -1 : 1)));
        });
    }

    /** Learns from a press or release whether `buttons` can be trusted (see `buttonsTrust`). */
    private judgeButtons(type: 'mousedown' | 'mouseup', e: MouseEvent): void {
        if (this.buttonsTrust < 0) return;
        const ok = buttonsConsistent(type, e.button, e.buttons);
        if (ok !== null) this.buttonsTrust = ok ? 1 : -1;
    }

    /** Releases held mouse inputs the mouse no longer holds (the stuck-aim fix). Allocates nothing. */
    private reconcileButtons(buttons: number): void {
        if (this.buttonsTrust > 0) releaseMissingButtons(this.keys, buttons);
    }

    /** Resolves a new set of bindings; the next tick uses it. */
    setBindings(map: BindingMap): void {
        this.b = map;
        this.bound = new Set<string>();
        for (const a of ACTIONS) for (const x of map[a.id]) if (x !== null) this.bound.add(x);
        this.releaseAll();
    }

    /** Hold or toggle per action, and the aiming sensitivity. A change forgets toggled states. */
    setModes(crouchToggle: boolean, walkToggle: boolean, aimToggle: boolean, aimSensitivity: number): void {
        if (crouchToggle !== this.crouchToggle || walkToggle !== this.walkToggle || aimToggle !== this.aimToggle) this.clearToggles();
        this.crouchToggle = crouchToggle;
        this.walkToggle = walkToggle;
        this.aimToggle = aimToggle;
        this.aimSensitivity = aimSensitivity;
    }

    /** Switches every toggled action off (round start, death, a menu opening). */
    clearToggles(): void {
        this.crouchOn = this.walkOn = this.aimOn = false;
    }

    /** One press of an input (not a repeat): records it and fires the edge actions. */
    private press(code: string): void {
        if (this.keys.has(code)) return;
        this.keys.add(code);
        const b = this.b;
        if (b.jump[0] === code || b.jump[1] === code) this.jumpQueued = true;
        if (b.prevWeapon[0] === code || b.prevWeapon[1] === code) this.swapQueued = true;
        if (b.dropBomb[0] === code || b.dropBomb[1] === code) this.dropQueued = true;
        if (b.crouch[0] === code || b.crouch[1] === code) this.crouchOn = !this.crouchOn;
        if (b.walk[0] === code || b.walk[1] === code) this.walkOn = !this.walkOn;
        if (b.aim[0] === code || b.aim[1] === code) this.aimOn = !this.aimOn;
    }

    private pressed(id: ActionId): boolean {
        const pair = this.b[id];
        const p = pair[0], s = pair[1];
        return (p !== null && this.keys.has(p)) || (s !== null && this.keys.has(s));
    }

    /** Forgets every held key and button (a menu or the chat box took the keyboard). */
    releaseAll(): void {
        this.keys.clear();
        this.jumpQueued = false;
        this.swapQueued = false;
        this.dropQueued = false;
        this.wheelSteps = 0;
        this.clearToggles();
    }

    get locked(): boolean {
        return document.pointerLockElement === this.canvas;
    }

    lock(): void {
        // Rejects if the user presses Esc mid-request; nothing to do about it.
        Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
    }

    /** Plant or defuse. */
    get use(): boolean {
        return this.pressed('use');
    }

    /**
     * Drop the bomb: true for one tick per press of the key, then false until it is pressed again. In
     * warmup the key is "Ready" (its own context) and the server ignores a drop with no bomb.
     */
    takeDrop(): boolean {
        const d = this.dropQueued;
        this.dropQueued = false;
        return d;
    }

    /** Reload. */
    get reload(): boolean {
        return this.pressed('reload');
    }

    /** Aim down sights: held, or toggled by a press. */
    get aim(): boolean {
        return this.aimToggle ? this.aimOn : this.pressed('aim');
    }

    /** Scoreboard. */
    get scores(): boolean {
        return this.pressed('scores');
    }

    private axis(neg: ActionId, pos: ActionId): number {
        return (this.pressed(pos) ? 1 : 0) - (this.pressed(neg) ? 1 : 0);
    }

    /** Fills `cmd` for one tick. A queued jump is consumed so one press is one jump. */
    sample(cmd: InputCmd): void {
        cmd.forward = this.axis('back', 'forward');
        cmd.right = this.axis('left', 'right');
        // Rounded to float32 because that is what goes on the wire: the server must simulate the
        // exact angle this client predicted with.
        cmd.yaw = Math.fround(this.yaw);
        cmd.jump = this.jumpQueued;
        cmd.walk = this.walkToggle ? this.walkOn : this.pressed('walk');
        cmd.crouch = this.crouchToggle ? this.crouchOn : this.pressed('crouch');
        this.jumpQueued = false;
    }

    /**
     * Fills the weapon fields of `cmd` for one tick: the slot keys select a slot (1 to 3 rebindable,
     * 4 to 9 fixed), the wheel steps from `held` (the slot in hand as predicted) through `count` slots, the
     * previous-weapon key asks for the previous weapon. A queued wheel step or press is consumed, so one
     * notch or press is one switch.
     */
    sampleWeapons(cmd: LoadoutInput, held: number, count: number): void {
        let slot = 0;
        for (let n = 1; n <= count && n <= 9; n++) {
            if (n <= SLOT_ACTIONS.length ? this.pressed(SLOT_ACTIONS[n - 1]) : this.keys.has(DIGITS[n])) { slot = n; break; }
        }
        if (slot === 0 && this.wheelSteps !== 0 && count > 1) {
            slot = ((((held + this.wheelSteps) % count) + count) % count) + 1;
        }
        cmd.slot = slot;
        cmd.swap = slot === 0 && this.swapQueued;
        cmd.aim = this.aim;
        this.wheelSteps = 0;
        this.swapQueued = false;
    }
}
