import type { InputCmd } from '@shared/types';

const SENSITIVITY = 0.0022; // radians per pixel of mouse movement
const PITCH_LIMIT = (89 * Math.PI) / 180;

/** Keyboard and pointer-lock mouse, sampled once per simulation tick. */
export class Input {
    yaw = 0;
    pitch = 0;
    private readonly keys = new Set<string>();
    private jumpQueued = false;

    constructor(private readonly canvas: HTMLCanvasElement) {
        window.addEventListener('keydown', e => {
            if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) this.jumpQueued = true; }
            this.keys.add(e.code);
        });
        window.addEventListener('keyup', e => this.keys.delete(e.code));
        window.addEventListener('blur', () => this.keys.clear());
        document.addEventListener('mousemove', e => {
            if (!this.locked) return;
            this.yaw -= e.movementX * SENSITIVITY;
            this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * SENSITIVITY));
        });
    }

    get locked(): boolean {
        return document.pointerLockElement === this.canvas;
    }

    lock(): void {
        // Rejects if the user presses Esc mid-request; nothing to do about it.
        Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
    }

    private axis(neg: string, pos: string): number {
        return (this.keys.has(pos) ? 1 : 0) - (this.keys.has(neg) ? 1 : 0);
    }

    /** Fills `cmd` for one tick. A queued jump is consumed so one press is one jump. */
    sample(cmd: InputCmd): void {
        cmd.forward = this.axis('KeyS', 'KeyW');
        cmd.right = this.axis('KeyA', 'KeyD');
        cmd.yaw = this.yaw;
        cmd.jump = this.jumpQueued;
        cmd.walk = this.keys.has('ShiftLeft');
        cmd.crouch = this.keys.has('KeyC') || this.keys.has('ControlLeft');
        this.jumpQueued = false;
    }
}
