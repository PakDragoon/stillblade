import { RUN_SPEED, JUMP_SPEED } from '@shared/constants';

/**
 * How the first-person weapon moves with the player (package Q): walk and run bob from the real horizontal speed and
 * a step phase, look inertia (the weapon trails mouse turns and settles back), a lift on jumping and a dip on landing,
 * a tilt and lower when crouched, a lean into strafing, and the recoil of each shot as springs that settle like a gun
 * coming back to rest, with a little variation per shot taken from the shot count (no `Math.random`).
 *
 * Presentation only: it reads what the game core already shows (velocity, ground, crouch, view angles, aim) and moves
 * nothing but the drawn weapon and, for a few hundredths of a second after a shot, the camera's roll. All of it is
 * reduced while aiming down sights. No allocation per update.
 */

/** Metres per step at the bob: one vertical dip per step, one side-to-side swing per two (a run is about 3 steps/s). */
const STEP_LEN = 1.8;
/** Bob sizes at full run speed: side (m), dip (m), roll (degrees), yaw (degrees). */
const BOB_X = 0.009;
const BOB_Y = 0.007;
const BOB_ROLL = 1.4;
const BOB_YAW = 0.7;
/** Look inertia: how far the weapon trails per rad/s of turning (degrees and metres), and the most it trails. */
const LAG_ROT = 1.6;
const LAG_POS = 0.0035;
const LAG_MAX_ROT = 4;
const LAG_MAX_POS = 0.012;
/** Strafe lean (degrees of roll at full run sideways). */
const STRAFE_ROLL = 2.5;
/** Crouched: roll (degrees, counter-clockwise), lowered (m), drawn in (m). */
const CROUCH_ROLL = 5;
const CROUCH_DROP = 0.012;
const CROUCH_IN = 0.008;
/** Jump lift (m, degrees muzzle up) at a full jump, and landing dip (m, degrees down) after a full jump's fall. */
const JUMP_LIFT = 0.014;
const JUMP_TIP = 1.5;
const LAND_DIP = 0.024;
const LAND_TIP = 2.5;
/** What is left of the motion when fully aimed. */
const AIM_KEEP = 0.15;
/** Recoil left on the drawn weapon when fully aimed (the camera's own recoil shows the rest). */
const AIM_RECOIL = 0.55;

const clamp = (v: number, m: number): number => (v > m ? m : v < -m ? -m : v);

/** A damped spring toward 0: x'' = -k x - c x'. */
class Spring {
    x = 0;
    v = 0;
    private readonly k: number;
    private readonly c: number;
    /** `omega` rad/s natural frequency, `zeta` damping ratio (below 1 overshoots a little and settles). */
    constructor(omega: number, zeta: number) {
        this.k = omega * omega;
        this.c = 2 * zeta * omega;
    }
    /** Steps toward `target` (semi-implicit Euler, sub-stepped so a long frame stays stable). */
    step(dt: number, target = 0): void {
        const n = Math.max(1, Math.ceil(dt / (1 / 240)));
        const h = dt / n;
        for (let i = 0; i < n; i++) {
            this.v += (-this.k * (this.x - target) - this.c * this.v) * h;
            this.x += this.v * h;
        }
    }
    reset(): void { this.x = 0; this.v = 0; }
}

/** -1..1 from an integer (a small integer hash): the same shot count always gives the same variation. */
export function shotVariation(n: number, salt: number): number {
    let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** One frame's input. */
export interface FeelInput {
    /** Velocity m/s (world). */
    vx: number; vy: number; vz: number;
    onGround: boolean;
    crouched: boolean;
    /** View angles (radians; yaw 0 faces -Z, positive turns toward -X). */
    yaw: number;
    pitch: number;
    /** Aim down sights 0..1. */
    aim: number;
}

/** Recoil feel of a weapon: peak push back (m), lift (m), muzzle up (degrees), side and roll variation (degrees). */
export interface RecoilFeel {
    back: number;
    lift: number;
    pitch: number;
    side: number;
    roll: number;
    /** Camera roll and pitch flick per shot (degrees), gone within about 0.15 s. */
    camRoll: number;
    camPitch: number;
}

/** Kicks a spring so its first swing peaks at about `peak`. */
function impulse(s: Spring, omega: number, peak: number): void { s.v += (peak * omega) / PEAK; }

/** Peak of an impulse response for these springs, measured: the impulse is scaled so the peak is the asked size. */
const PEAK = 0.55;

export class ViewFeel {
    /** Outputs, camera space: position offset (m) and rotation offset (degrees: pitch, yaw, roll). */
    readonly pos = new Float32Array(3);
    readonly rot = new Float32Array(3);
    /** Camera shake (degrees: pitch, roll), to add to the camera after the game set it. */
    readonly cam = new Float32Array(2);
    /** Step phase (radians) and the bob's present size 0..1. */
    phase = 0;
    bobW = 0;
    private crouchW = 0;
    private strafe = 0;
    private prevYaw = NaN;
    private prevPitch = NaN;
    private wasGround = true;
    private airVy = 0;
    private readonly lagYaw = new Spring(14, 0.75);
    private readonly lagPitch = new Spring(14, 0.75);
    private readonly lagX = new Spring(14, 0.75);
    private readonly lagY = new Spring(14, 0.75);
    private readonly jumpY = new Spring(11, 0.45);
    private readonly jumpPitch = new Spring(11, 0.45);
    // Recoil: back, lift, pitch, side, roll; then the camera's pitch and roll.
    private readonly rBack = new Spring(19, 0.55);
    private readonly rLift = new Spring(19, 0.55);
    private readonly rPitch = new Spring(17, 0.5);
    private readonly rSide = new Spring(15, 0.5);
    private readonly rRoll = new Spring(15, 0.5);
    private readonly cPitch = new Spring(34, 0.6);
    private readonly cRoll = new Spring(30, 0.5);

    /** Forget everything (a respawn, a team change): no carried-over swing or recoil. */
    reset(): void {
        for (const s of [this.lagYaw, this.lagPitch, this.lagX, this.lagY, this.jumpY, this.jumpPitch, this.rBack,
            this.rLift, this.rPitch, this.rSide, this.rRoll, this.cPitch, this.cRoll]) s.reset();
        this.prevYaw = this.prevPitch = NaN;
        this.wasGround = true;
        this.bobW = this.crouchW = this.strafe = 0;
        this.pos.fill(0); this.rot.fill(0); this.cam.fill(0);
    }

    /** A shot: kicks the springs. `count` numbers the shots (any running count), giving each its own variation. */
    shoot(f: RecoilFeel, count: number, aim: number): void {
        const k = 1 - (1 - AIM_RECOIL) * Math.min(1, Math.max(0, aim));
        const a = shotVariation(count, 1), b = shotVariation(count, 2), c = shotVariation(count, 3);
        impulse(this.rBack, 19, f.back * k * (0.85 + 0.15 * c));
        impulse(this.rLift, 19, f.lift * k * (0.8 + 0.2 * b));
        impulse(this.rPitch, 17, f.pitch * k * (0.8 + 0.2 * a));
        impulse(this.rSide, 15, f.side * k * a);
        impulse(this.rRoll, 15, f.roll * k * b);
        impulse(this.cPitch, 34, f.camPitch * (0.8 + 0.2 * c));
        impulse(this.cRoll, 30, f.camRoll * (b >= 0 ? 1 : -1) * (0.7 + 0.3 * Math.abs(a)));
    }

    update(dt: number, s: FeelInput): void {
        if (dt <= 0) return;
        const aim = Math.min(1, Math.max(0, s.aim));
        const keep = 1 - (1 - AIM_KEEP) * aim;
        const speed = Math.hypot(s.vx, s.vz);
        // Bob: phase from distance walked on the ground, size from speed (eased in and out).
        const ground = s.onGround;
        if (ground) this.phase = (this.phase + (speed * dt / STEP_LEN) * Math.PI) % (Math.PI * 2);
        const bobTarget = ground ? Math.min(1, speed / RUN_SPEED) : 0;
        this.bobW += (bobTarget - this.bobW) * (1 - Math.exp(-8 * dt));
        const bw = this.bobW * keep;
        const sn = Math.sin(this.phase);
        const bx = sn * BOB_X * bw;
        const by = -Math.abs(sn) * BOB_Y * bw + BOB_Y * 0.5 * bw;
        const broll = sn * BOB_ROLL * bw;
        const byaw = Math.cos(this.phase) * BOB_YAW * bw;
        // Lean into strafing: velocity along the view's right ((cos yaw, 0, -sin yaw)).
        const lateral = s.vx * Math.cos(s.yaw) - s.vz * Math.sin(s.yaw);
        this.strafe += (lateral / RUN_SPEED - this.strafe) * (1 - Math.exp(-6 * dt));
        // Crouch tilt.
        this.crouchW += ((s.crouched ? 1 : 0) - this.crouchW) * (1 - Math.exp(-10 * dt));
        const cw = this.crouchW * keep;
        // Look inertia: the weapon trails the turn rate and springs back.
        let dyaw = Number.isNaN(this.prevYaw) ? 0 : s.yaw - this.prevYaw;
        if (dyaw > Math.PI) dyaw -= Math.PI * 2; else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
        const dpitch = Number.isNaN(this.prevPitch) ? 0 : s.pitch - this.prevPitch;
        this.prevYaw = s.yaw;
        this.prevPitch = s.pitch;
        const wy = dyaw / dt, wp = dpitch / dt;
        this.lagYaw.step(dt, clamp(-wy * LAG_ROT, LAG_MAX_ROT) * keep);
        this.lagPitch.step(dt, clamp(-wp * LAG_ROT, LAG_MAX_ROT) * keep);
        // Turning left (yaw rising) leaves the weapon to the right; looking up leaves it low.
        this.lagX.step(dt, clamp(wy * LAG_POS, LAG_MAX_POS) * keep);
        this.lagY.step(dt, clamp(-wp * LAG_POS, LAG_MAX_POS) * keep);
        // Jump and landing.
        if (this.wasGround && !ground && s.vy > 0.5) {
            const up = Math.min(1, s.vy / JUMP_SPEED);
            this.jumpY.v += (JUMP_LIFT * up * 11) / PEAK;
            this.jumpPitch.v += (JUMP_TIP * up * 11) / PEAK;
        }
        if (!this.wasGround && ground) {
            const fall = Math.min(1.6, Math.max(0, -this.airVy) / JUMP_SPEED);
            this.jumpY.v -= (LAND_DIP * fall * 11) / PEAK;
            this.jumpPitch.v -= (LAND_TIP * fall * 11) / PEAK;
        }
        if (!ground) this.airVy = s.vy;
        this.wasGround = ground;
        this.jumpY.step(dt);
        this.jumpPitch.step(dt);
        // Recoil settling.
        this.rBack.step(dt); this.rLift.step(dt); this.rPitch.step(dt); this.rSide.step(dt); this.rRoll.step(dt);
        this.cPitch.step(dt); this.cRoll.step(dt);

        const jk = keep * 0.6 + 0.4 * (1 - aim); // landing still shows a little when aimed
        this.pos[0] = bx + this.lagX.x - CROUCH_IN * cw;
        this.pos[1] = by + this.lagY.x + this.jumpY.x * jk - CROUCH_DROP * cw + this.rLift.x;
        this.pos[2] = this.rBack.x;
        this.rot[0] = this.lagPitch.x + this.jumpPitch.x * jk + this.rPitch.x;
        this.rot[1] = byaw + this.lagYaw.x + this.rSide.x;
        this.rot[2] = broll - this.strafe * STRAFE_ROLL * keep + CROUCH_ROLL * cw + this.rRoll.x;
        this.cam[0] = this.cPitch.x;
        this.cam[1] = this.cRoll.x;
    }
}
