import type { InputCmd } from '@shared/types';

const BASE_SENSITIVITY = 0.0022; // radians per pixel of mouse movement at multiplier 1
const PITCH_LIMIT = (89 * Math.PI) / 180;

/** Keyboard and pointer-lock mouse, sampled once per simulation tick. */
export class Input {
    yaw = 0;
    pitch = 0;
    private readonly keys = new Set<string>();
    private jumpQueued = false;
    private mouseFire = false;
    /** Settings: multiplier on the base sensitivity, and inverted vertical look. */
    sensitivity = 1;
    invertY = false;
    /** While true (typing in chat, a menu open) game keys and the mouse do nothing. */
    suspended = false;

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
            this.keys.add(e.code);
        });
        window.addEventListener('keyup', e => this.keys.delete(e.code));
        window.addEventListener('blur', () => { this.keys.clear(); this.mouseFire = false; });
        document.addEventListener('mousedown', e => { if (e.button === 0 && this.locked && !this.suspended) this.mouseFire = true; });
        document.addEventListener('mouseup', e => { if (e.button === 0) this.mouseFire = false; });
        document.addEventListener('mousemove', e => {
            if (!this.locked || this.suspended) return;
            const k = BASE_SENSITIVITY * this.sensitivity;
            this.yaw -= e.movementX * k;
            this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * k * (this.invertY ? -1 : 1)));
        });
    }

    /** Forgets every held key and button (a menu or the chat box took the keyboard). */
    releaseAll(): void {
        this.keys.clear();
        this.mouseFire = false;
        this.jumpQueued = false;
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
}
