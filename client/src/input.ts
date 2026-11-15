import type { LoadoutInput } from '@shared/gun';
import type { InputCmd } from '@shared/types';

const BASE_SENSITIVITY = 0.0022; // radians per pixel of mouse movement at multiplier 1
const PITCH_LIMIT = (89 * Math.PI) / 180;

/** Keyboard and pointer-lock mouse, sampled once per simulation tick. */
export class Input {
    yaw = 0;
    pitch = 0;
    /** Mouse-look multiplier: the game lowers it while aiming down sights so the zoomed view is not twitchy. */
    lookScale = 1;
    private readonly keys = new Set<string>();
    private jumpQueued = false;
    private swapQueued = false;
    /** Mouse wheel notches not yet sent: positive is down (next weapon). */
    private wheelSteps = 0;
    private mouseFire = false;
    /** Settings: multiplier on the base sensitivity, and inverted vertical look. */
    sensitivity = 1;
    invertY = false;
    /** While true (typing in chat, a menu open) game keys and the mouse do nothing. */
    suspended = false;
    private mouseAim = false;

    /** Left mouse while the pointer is captured; F also fires so it can be driven without pointer lock. */
    get fire(): boolean {
        return this.mouseFire || this.keys.has('KeyF');
    }

    constructor(private readonly canvas: HTMLCanvasElement) {
        window.addEventListener('keydown', e => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return; // typing in a menu or chat
            if (this.suspended) return;
            if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) this.jumpQueued = true; }
            if (e.code === 'Tab') e.preventDefault(); // scoreboard, not focus change
            if (e.code === 'KeyQ' && !e.repeat) this.swapQueued = true;
            this.keys.add(e.code);
        });
        window.addEventListener('keyup', e => this.keys.delete(e.code));
        window.addEventListener('blur', () => { this.keys.clear(); this.mouseFire = this.mouseAim = false; });
        document.addEventListener('mousedown', e => {
            if (!this.locked || this.suspended) return;
            if (e.button === 0) this.mouseFire = true;
            else if (e.button === 2) this.mouseAim = true;
        });
        document.addEventListener('mouseup', e => {
            if (e.button === 0) this.mouseFire = false;
            else if (e.button === 2) this.mouseAim = false;
        });
        document.addEventListener('contextmenu', e => { if (this.locked) e.preventDefault(); });
        document.addEventListener('wheel', e => {
            if (!this.locked || this.suspended || e.deltaY === 0) return;
            this.wheelSteps += e.deltaY > 0 ? 1 : -1;
        }, { passive: true });
        document.addEventListener('mousemove', e => {
            if (!this.locked || this.suspended) return;
            const k = BASE_SENSITIVITY * this.sensitivity * this.lookScale;
            this.yaw -= e.movementX * k;
            this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * k * (this.invertY ? -1 : 1)));
        });
    }

    /** Forgets every held key and button (a menu or the chat box took the keyboard). */
    releaseAll(): void {
        this.keys.clear();
        this.mouseFire = this.mouseAim = false;
        this.jumpQueued = false;
        this.swapQueued = false;
        this.wheelSteps = 0;
    }

    get locked(): boolean {
        return document.pointerLockElement === this.canvas;
    }

    lock(): void {
        // Rejects if the user presses Esc mid-request; nothing to do about it.
        Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
    }

    /** E: plant or defuse. */
    get use(): boolean {
        return this.keys.has('KeyE');
    }

    /** R: reload. */
    get reload(): boolean {
        return this.keys.has('KeyR');
    }

    /** Right mouse held while the pointer is captured; Z also aims so it can be driven without pointer lock. */
    get aim(): boolean {
        return this.mouseAim || this.keys.has('KeyZ');
    }

    /** Tab: scoreboard. */
    get scores(): boolean {
        return this.keys.has('Tab');
    }

    private axis(neg: string, pos: string): number {
        return (this.keys.has(pos) ? 1 : 0) - (this.keys.has(neg) ? 1 : 0);
    }

    /** Fills `cmd` for one tick. A queued jump is consumed so one press is one jump. */
    sample(cmd: InputCmd): void {
        cmd.forward = this.axis('KeyS', 'KeyW');
        cmd.right = this.axis('KeyA', 'KeyD');
        // Rounded to float32 because that is what goes on the wire: the server must simulate the
        // exact angle this client predicted with.
        cmd.yaw = Math.fround(this.yaw);
        cmd.jump = this.jumpQueued;
        cmd.walk = this.keys.has('ShiftLeft');
        cmd.crouch = this.keys.has('KeyC') || this.keys.has('ControlLeft');
        this.jumpQueued = false;
    }

    /**
     * Fills the weapon fields of `cmd` for one tick: keys 1 to 9 select a slot, the wheel steps from
     * `held` (the slot in hand as predicted) through `count` slots, Q asks for the previous weapon.
     * A queued wheel step or Q press is consumed, so one notch or press is one switch.
     */
    sampleWeapons(cmd: LoadoutInput, held: number, count: number): void {
        let slot = 0;
        for (let n = 1; n <= count && n <= 9; n++) if (this.keys.has(`Digit${n}`)) { slot = n; break; }
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
