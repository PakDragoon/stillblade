/**
 * Spatial audio for Stillblade. Everything is synthesised with Web Audio from three pre-generated
 * noise buffers plus oscillators, filters and gain envelopes: there are no sound files.
 *
 * Defenders find ghosts by ear, so the priorities are: clear direction (HRTF on the cues that matter),
 * honest distance (every sound fades to exactly silence at its gameplay range), and walls you can hear
 * (occlusion muffles and quietens anything behind geometry).
 *
 * Graph:
 *   positional one-shot:  layers -> input(Gain) -> occlusion(LowPass) -> occlusion(Gain) -> Panner -> master
 *   local one-shot:       layers -> input(Gain) -> master
 *   breathing loop:       pink noise -> formant(Peaking) -> band(BandPass) -> amp(Gain)
 *                           -> occlusion(LowPass) -> occlusion(Gain) -> fade(Gain) -> Panner(HRTF) -> master
 *   master(Gain 0.8) -> DynamicsCompressor (gentle limiter) -> destination
 */
import { BREATH_RANGE, EYE_HEIGHT, GHOST_MAX_VIS, KNIFE_SOUND_RANGE, STEP_RANGE } from '@shared/constants';
import { rayWorld } from '@shared/raycast';
import type { Box, Vec3 } from '@shared/types';
import type { AudioEngine, BombView, CreateAudio, CueKind, ListenerView } from './audio-api';
import type { RemoteView } from './presenter-api';

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

const MASTER_GAIN = 0.8;
/** Simultaneous one-shot voices; breathing loops are not counted. */
const MAX_VOICES = 24;
const GUN_RANGE = 45;
const IMPACT_RANGE = 25;
/** Fade for breathing loops starting/stopping, seconds. */
const LOOP_FADE = 0.15;
/** Occlusion: cutoff and gain (about -8 dB) applied to a source behind a wall. */
const OCC_CUTOFF = 1000;
const OPEN_CUTOFF = 20000;
const OCC_GAIN = 0.4;
/** Breathing loops re-test occlusion this often (staggered per emitter). */
const OCC_INTERVAL = 0.1;
/** Time constant for smoothing loop occlusion changes, so walls do not pop. */
const OCC_SMOOTH = 0.06;
/** A ray hit must be at least this far short of the source to count as a wall (surfaces the source sits on do not). */
const OCC_MARGIN = 0.15;
/** Breathing comes from the head: feet + this. */
const HEAD_STAND = 1.5;
const HEAD_CROUCH = 0.95;
/** Small lead so scheduled envelopes never start in the past. */
const LEAD = 0.005;
/** Bomb beep: audible range, height of the emitter above the bomb's floor position, level. */
const BOMB_RANGE = 35;
const BOMB_LIFT = 0.15;
const BEEP_GAIN = 0.7;
/** Beep interval: BEEP_MAX seconds with >= BEEP_SLOW_FROM s left, shrinking to BEEP_MIN at zero. */
const BEEP_MAX = 1.0;
const BEEP_MIN = 0.15;
const BEEP_SLOW_FROM = 20;
/** Voice-stealing weight: the bomb and announcements outrank ordinary sounds of the same loudness. */
const BEEP_PRIORITY = 2;
const CUE_PRIORITY = 4;

interface ShotCfg {
    /** Distance at which the sound reaches silence (Panner maxDistance, linear model). */
    range: number;
    /** Full volume inside this distance. */
    ref: number;
    hrtf: boolean;
    /** Raise the occlusion test point above `pos` (footsteps are at the feet; sound reaches over the floor). */
    occLift: number;
}

// ---------------------------------------------------------------------------------------------
// Noise buffers, generated once per context
// ---------------------------------------------------------------------------------------------

interface NoiseBank {
    /** Flat spectrum: crisp scuffs, cracks, the windup shimmer. */
    white: AudioBuffer;
    /** -3 dB/oct: natural "air" for breath and whooshes. */
    pink: AudioBuffer;
    /** -6 dB/oct: dull body for thuds. */
    brown: AudioBuffer;
}

function makeNoiseBank(ctx: BaseAudioContext): NoiseBank {
    const len = Math.floor(ctx.sampleRate * 3);
    const white = ctx.createBuffer(1, len, ctx.sampleRate);
    const pink = ctx.createBuffer(1, len, ctx.sampleRate);
    const brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = white.getChannelData(0), p = pink.getChannelData(0), b = brown.getChannelData(0);
    // Paul Kellet's economy pink filter; leaky integrator for brown.
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
        const x = Math.random() * 2 - 1;
        w[i] = x;
        b0 = 0.99765 * b0 + x * 0.099046;
        b1 = 0.963 * b1 + x * 0.2965164;
        b2 = 0.57 * b2 + x * 1.0526913;
        p[i] = (b0 + b1 + b2 + x * 0.1848) * 0.2;
        last = (last + 0.02 * x) / 1.02;
        b[i] = last * 3.5;
    }
    return { white, pink, brown };
}

// ---------------------------------------------------------------------------------------------
// One-shot voices: a bag of nodes that disconnects itself when its last source ends
// ---------------------------------------------------------------------------------------------

class Voice {
    readonly nodes: AudioNode[] = [];
    readonly sources: AudioScheduledSourceNode[] = [];
    /** Every layer mixes into this; it is also the fader used when the voice is stolen. */
    readonly input: GainNode;
    start = 0;
    end = 0;
    /** Estimated loudness at the listener when started, for voice stealing. */
    priority = 0;
    private pending = 0;

    constructor(readonly ctx: BaseAudioContext, readonly bank: NoiseBank) {
        this.input = ctx.createGain();
        this.nodes.push(this.input);
    }

    gain(dest: AudioNode): GainNode {
        const g = this.ctx.createGain();
        g.gain.value = 0;
        g.connect(dest);
        this.nodes.push(g);
        return g;
    }

    filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
        const f = this.ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = q;
        f.connect(dest);
        this.nodes.push(f);
        return f;
    }

    /** A slice of a noise buffer from a random offset, so repeats never sound identical. */
    noise(buf: AudioBuffer, t: number, dur: number, dest: AudioNode): AudioBufferSourceNode {
        const s = this.ctx.createBufferSource();
        s.buffer = buf;
        s.connect(dest);
        s.start(t, Math.random() * Math.max(0, buf.duration - dur - 0.05));
        s.stop(t + dur);
        this.track(s, t + dur);
        return s;
    }

    osc(type: OscillatorType, freq: number, t: number, dur: number, dest: AudioNode): OscillatorNode {
        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        o.connect(dest);
        o.start(t);
        o.stop(t + dur);
        this.track(o, t + dur);
        return o;
    }

    private track(s: AudioScheduledSourceNode, stopAt: number): void {
        this.nodes.push(s);
        this.sources.push(s);
        if (stopAt > this.end) this.end = stopAt;
    }

    /** Call once all layers are built: releases every node when the last source has ended. */
    arm(onDone: (v: Voice) => void): void {
        this.pending = this.sources.length;
        const ended = (): void => {
            if (--this.pending > 0) return;
            for (let i = 0; i < this.nodes.length; i++) this.nodes[i].disconnect();
            onDone(this);
        };
        for (let i = 0; i < this.sources.length; i++) this.sources[i].onended = ended;
    }

    /** Steal: a 15 ms fade (no click) then stop everything early. */
    kill(now: number): void {
        const g = this.input.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + 0.015);
        for (let i = 0; i < this.sources.length; i++) {
            try { this.sources[i].stop(now + 0.02); } catch { /* already stopped */ }
        }
    }
}

/** Attack (linear) then exponential decay towards silence. */
function env(p: AudioParam, t: number, attack: number, peak: number, decay: number): void {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    p.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    p.setValueAtTime(0, t + attack + decay + 0.001);
}

function jitter(amount: number): number {
    return 1 + (Math.random() * 2 - 1) * amount;
}

// ---------------------------------------------------------------------------------------------
// Synthesis. Each builds its layers into `v.input` starting at time `t`.
// Signature (v, t, x, flag) so the callers need no closures.
// ---------------------------------------------------------------------------------------------

type Synth = (v: Voice, t: number, x: number, flag: boolean) => void;

/** Footstep: heel thud (falling sine + low brown noise) then a sole scuff (band-passed white). x = loud. */
const synthStep: Synth = (v, t, loud) => {
    const r = jitter(0.12);
    const level = 0.45 + 0.55 * loud;
    const thud = v.gain(v.input);
    const o = v.osc('sine', 85 * r, t, 0.14, thud);
    o.frequency.setValueAtTime(85 * r, t);
    o.frequency.exponentialRampToValueAtTime(48 * r, t + 0.09);
    env(thud.gain, t, 0.004, 0.6 * level, 0.1);

    const body = v.gain(v.input);
    v.noise(v.bank.brown, t, 0.12, v.filter('lowpass', 380 * r, 0.9, body));
    env(body.gain, t, 0.003, 0.9 * level, 0.08);

    // Running steps scuff harder and brighter, which also helps tell running from walking.
    const ts = t + 0.012 + Math.random() * 0.02;
    const scuff = v.gain(v.input);
    v.noise(v.bank.white, ts, 0.08, v.filter('bandpass', (2600 + 1400 * loud) * jitter(0.15), 0.9, scuff));
    // Kept fairly strong: the low thud carries almost no direction, the scuff's highs do.
    env(scuff.gain, ts, 0.006, (0.16 + 0.3 * loud) * jitter(0.2), 0.055);
};

/** Silenced shot: band-passed "pft" burst, a short high "thwip", a low thump and the action clicking. */
const synthGun: Synth = (v, t) => {
    const pft = v.gain(v.input);
    v.noise(v.bank.white, t, 0.1, v.filter('bandpass', 1400 * jitter(0.06), 1.1, pft));
    env(pft.gain, t, 0.001, 1.0, 0.07);

    const thwip = v.gain(v.input);
    v.noise(v.bank.white, t, 0.04, v.filter('bandpass', 5000, 1.5, thwip));
    env(thwip.gain, t, 0.0005, 0.45, 0.025);

    const thump = v.gain(v.input);
    const o = v.osc('sine', 140, t, 0.09, thump);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.06);
    env(thump.gain, t, 0.002, 0.8, 0.07);

    // The slide cycling 45 ms later is what makes it read as a gun rather than a puff of air.
    const tc = t + 0.045;
    const click = v.gain(v.input);
    v.noise(v.bank.white, tc, 0.03, v.filter('bandpass', 3000, 4, click));
    env(click.gain, tc, 0.0005, 0.35, 0.015);
};

/** Bullet impact: very short high-passed crack, a tiny random-pitch tick, a dull low knock. */
const synthImpact: Synth = (v, t) => {
    const crack = v.gain(v.input);
    v.noise(v.bank.white, t, 0.04, v.filter('highpass', 2500, 0.7, crack));
    env(crack.gain, t, 0.0005, 0.7, 0.025);

    const tick = v.gain(v.input);
    v.osc('sine', 1100 + Math.random() * 700, t, 0.04, tick);
    env(tick.gain, t, 0.0005, 0.15, 0.03);

    const knock = v.gain(v.input);
    v.noise(v.bank.brown, t, 0.06, v.filter('bandpass', 250, 1.2, knock));
    env(knock.gain, t, 0.001, 0.6, 0.04);
};

/**
 * Knife windup (~220 ms), the defender's warning: a resonant band-pass sweeping UP through white
 * noise (airy rising "shing"), three inharmonic sine partials gliding up (steel on sheath), and a
 * low cloth swish swelling underneath. Nothing else in the game rises in pitch, so it stands out.
 */
const synthWindup: Synth = (v, t) => {
    const D = 0.22;
    const shing = v.gain(v.input);
    const bp = v.filter('bandpass', 1200, 6, shing);
    bp.frequency.setValueAtTime(1200, t);
    bp.frequency.exponentialRampToValueAtTime(7000, t + D);
    v.noise(v.bank.white, t, D + 0.05, bp);
    shing.gain.setValueAtTime(0, t);
    shing.gain.linearRampToValueAtTime(1.3, t + 0.17);
    shing.gain.linearRampToValueAtTime(0, t + D + 0.04);

    const ring = v.gain(v.input);
    ring.gain.setValueAtTime(0, t);
    ring.gain.linearRampToValueAtTime(0.05, t + 0.16);
    ring.gain.linearRampToValueAtTime(0, t + D + 0.03);
    const base = 1700 * jitter(0.03);
    const ratios = [2.0, 2.76, 3.52];
    for (let i = 0; i < ratios.length; i++) {
        const f = base * ratios[i];
        const o = v.osc('sine', f, t, D + 0.04, ring);
        o.frequency.setValueAtTime(f, t);
        o.frequency.linearRampToValueAtTime(f * 1.25, t + D);
    }

    const cloth = v.gain(v.input);
    const lp = v.filter('lowpass', 500, 0.8, cloth);
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1400, t + D);
    v.noise(v.bank.pink, t, D + 0.04, lp);
    cloth.gain.setValueAtTime(0, t);
    cloth.gain.linearRampToValueAtTime(0.5, t + 0.12);
    cloth.gain.linearRampToValueAtTime(0, t + D + 0.02);
};

/** Knife slash: fast band-pass whoosh (up then down); on a hit a thud plus a wet resonant squelch. flag = hit. */
const synthSlash: Synth = (v, t, _x, hit) => {
    const whoosh = v.gain(v.input);
    const bp = v.filter('bandpass', 500, 1.4, whoosh);
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.06);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.18);
    v.noise(v.bank.pink, t, 0.2, bp);
    whoosh.gain.setValueAtTime(0, t);
    whoosh.gain.linearRampToValueAtTime(1.8, t + 0.055);
    whoosh.gain.exponentialRampToValueAtTime(0.001, t + 0.19);

    if (!hit) return;
    const th = t + 0.05;
    const thud = v.gain(v.input);
    const o = v.osc('sine', 100, th, 0.16, thud);
    o.frequency.exponentialRampToValueAtTime(45, th + 0.12);
    env(thud.gain, th, 0.003, 0.9, 0.14);

    const wet = v.gain(v.input);
    const wf = v.filter('bandpass', 650, 3, wet);
    wf.frequency.setValueAtTime(650, th);
    wf.frequency.exponentialRampToValueAtTime(350, th + 0.08);
    v.noise(v.bank.pink, th, 0.11, wf);
    env(wet.gain, th, 0.004, 1.4, 0.09);

    const body = v.gain(v.input);
    v.noise(v.bank.brown, th, 0.09, v.filter('lowpass', 400, 0.8, body));
    env(body.gain, th, 0.002, 0.6, 0.07);
};

/** Hurt: a short, felt-more-than-heard low thump. */
const synthHurt: Synth = (v, t) => {
    const thump = v.gain(v.input);
    const o = v.osc('sine', 70, t, 0.26, thump);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.18);
    env(thump.gain, t, 0.004, 0.9, 0.22);

    const body = v.gain(v.input);
    v.noise(v.bank.brown, t, 0.18, v.filter('lowpass', 160, 0.8, body));
    env(body.gain, t, 0.003, 0.7, 0.15);
};

/** A single enveloped oscillator layer; returns the oscillator for pitch automation. */
function tone(v: Voice, type: OscillatorType, freq: number, t: number, attack: number, peak: number,
    decay: number, dest: AudioNode = v.input): OscillatorNode {
    const g = v.gain(dest);
    const o = v.osc(type, freq, t, attack + decay + 0.02, g);
    env(g.gain, t, attack, peak, decay);
    return o;
}

/**
 * Bomb beep: a clean ~60 ms blip, 1.1 kHz plus a quieter octave, with linear edges (no clicks).
 * Pure tones sit apart from every other sound in the game, and the octave gives HRTF some highs.
 */
const synthBeep: Synth = (v, t) => {
    const D = 0.06;
    const partials = [1100, 2200];
    const levels = [0.55, 0.18];
    for (let i = 0; i < 2; i++) {
        const g = v.gain(v.input);
        v.osc('sine', partials[i], t, D + 0.01, g);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(levels[i], t + 0.004);
        g.gain.setValueAtTime(levels[i], t + D - 0.015);
        g.gain.linearRampToValueAtTime(0, t + D);
    }
};

// Cues: non-positional announcements. Peaks are kept modest so the compressor only glues them.

/** Round start: a short rising two-note chime (E5 -> B5), triangle plus a soft octave shimmer. */
const synthRoundStart: Synth = (v, t) => {
    const notes = [659, 988];
    for (let i = 0; i < 2; i++) {
        const tn = t + i * 0.13;
        tone(v, 'triangle', notes[i], tn, 0.005, 0.5, i === 1 ? 0.55 : 0.3);
        tone(v, 'sine', notes[i] * 2, tn, 0.005, 0.12, i === 1 ? 0.4 : 0.2);
    }
};

/** Bomb planted: an alarming low-high warble (siren steps), square tamed by a low-pass. */
const synthPlanted: Synth = (v, t) => {
    const STEP = 0.085, N = 8;
    const D = STEP * N;
    const g = v.gain(v.input);
    const lp = v.filter('lowpass', 2400, 0.9, g);
    const o = v.osc('square', 440, t, D + 0.05, lp);
    const o2 = v.osc('sawtooth', 441, t, D + 0.05, lp);
    for (let i = 0; i < N; i++) {
        const f = i % 2 === 0 ? 440 : 740;
        o.frequency.setValueAtTime(f, t + i * STEP);
        o2.frequency.setValueAtTime(f * 1.004, t + i * STEP);
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.01);
    g.gain.setValueAtTime(0.16, t + D - 0.06);
    g.gain.linearRampToValueAtTime(0, t + D);
};

/** Bomb defused: the click of a cut wire, then a relieved, gently descending tone. */
const synthDefused: Synth = (v, t) => {
    const click = v.gain(v.input);
    v.noise(v.bank.white, t, 0.03, v.filter('bandpass', 3200, 3, click));
    env(click.gain, t, 0.0005, 0.9, 0.018);
    const tc = t + 0.006;
    const knock = v.gain(v.input);
    v.osc('sine', 1800, tc, 0.03, knock);
    env(knock.gain, tc, 0.0005, 0.2, 0.02);

    const td = t + 0.09;
    const o = tone(v, 'sine', 880, td, 0.03, 0.42, 0.75);
    o.frequency.setValueAtTime(880, td);
    o.frequency.exponentialRampToValueAtTime(523, td + 0.6);
    const o2 = tone(v, 'triangle', 440, td, 0.03, 0.2, 0.7);
    o2.frequency.setValueAtTime(440, td);
    o2.frequency.exponentialRampToValueAtTime(262, td + 0.6);
};

/** Bomb exploded: a white-noise blast with a falling low-pass, a low sine boom and a brown rumble tail (~1.2 s). */
const synthExploded: Synth = (v, t) => {
    const blast = v.gain(v.input);
    const lp = v.filter('lowpass', 7000, 0.7, blast);
    lp.frequency.setValueAtTime(7000, t);
    lp.frequency.exponentialRampToValueAtTime(350, t + 1.1);
    v.noise(v.bank.white, t, 1.75, lp);
    env(blast.gain, t, 0.004, 0.5, 1.7);

    const boom = v.gain(v.input);
    const o = v.osc('sine', 70, t, 1.2, boom);
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.9);
    env(boom.gain, t, 0.006, 0.9, 1.15);

    const rumble = v.gain(v.input);
    v.noise(v.bank.brown, t, 1.9, v.filter('lowpass', 220, 0.8, rumble));
    env(rumble.gain, t, 0.02, 0.9, 1.85);
};

/** Round won: a bright three-note rise (C5 E5 G5), the last held. */
const synthWin: Synth = (v, t) => {
    const notes = [523, 659, 784];
    for (let i = 0; i < 3; i++) {
        const tn = t + i * 0.12;
        const last = i === 2;
        tone(v, 'triangle', notes[i], tn, 0.005, 0.42, last ? 0.7 : 0.22);
        tone(v, 'sine', notes[i] * 2, tn, 0.005, 0.13, last ? 0.5 : 0.15);
    }
};

/** Round lost: a low falling two-note (A3 -> E3), the second sagging further. */
const synthLose: Synth = (v, t) => {
    const g = v.gain(v.input);
    g.gain.value = 1;
    const lp = v.filter('lowpass', 1400, 0.7, g);
    tone(v, 'triangle', 220, t, 0.01, 0.5, 0.35, lp);
    tone(v, 'sawtooth', 110, t, 0.01, 0.1, 0.3, lp);
    const t2 = t + 0.28;
    const o = tone(v, 'triangle', 165, t2, 0.01, 0.55, 0.85, lp);
    o.frequency.setValueAtTime(165, t2);
    o.frequency.linearRampToValueAtTime(150, t2 + 0.8);
    const o2 = tone(v, 'sawtooth', 82.5, t2, 0.01, 0.12, 0.7, lp);
    o2.frequency.setValueAtTime(82.5, t2);
    o2.frequency.linearRampToValueAtTime(75, t2 + 0.8);
};

const CUES: Record<CueKind, { synth: Synth; gain: number }> = {
    roundStart: { synth: synthRoundStart, gain: 0.8 },
    planted: { synth: synthPlanted, gain: 0.9 },
    defused: { synth: synthDefused, gain: 0.85 },
    exploded: { synth: synthExploded, gain: 0.85 },
    win: { synth: synthWin, gain: 0.8 },
    lose: { synth: synthLose, gain: 0.8 },
};

/** Seconds between bomb beeps: ~1 s above 20 s left, shrinking smoothly to ~0.15 s at zero. */
function beepInterval(timeLeft: number): number {
    const u = Math.min(1, Math.max(0, timeLeft / BEEP_SLOW_FROM));
    return BEEP_MIN + (BEEP_MAX - BEEP_MIN) * u * Math.sqrt(u);
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** Pre-2018 browsers (and some Safari versions) have only the setPosition/setOrientation forms. */
interface LegacyListener {
    setPosition(x: number, y: number, z: number): void;
    setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
}
interface LegacyPanner {
    setPosition(x: number, y: number, z: number): void;
}

function makePanner(ctx: BaseAudioContext, hrtf: boolean, ref: number, max: number): PannerNode {
    const p = ctx.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    // Linear: full volume inside `ref`, exactly silent at `max` — the gameplay range.
    p.distanceModel = 'linear';
    p.refDistance = ref;
    p.maxDistance = max;
    p.rolloffFactor = 1;
    return p;
}

function setPannerPos(p: PannerNode, x: number, y: number, z: number): void {
    if (p.positionX) {
        p.positionX.value = x;
        p.positionY.value = y;
        p.positionZ.value = z;
    } else {
        (p as unknown as LegacyPanner).setPosition(x, y, z);
    }
}

/** Same curve as the panner's linear model, for skipping and prioritising voices. */
function linearGain(d: number, ref: number, max: number): number {
    if (d <= ref) return 1;
    if (d >= max) return 0;
    return 1 - (d - ref) / (max - ref);
}

// ---------------------------------------------------------------------------------------------
// Breathing loops
// ---------------------------------------------------------------------------------------------

interface Breather {
    id: number;
    src: AudioBufferSourceNode;
    formant: BiquadFilterNode;
    band: BiquadFilterNode;
    amp: GainNode;
    occF: BiquadFilterNode;
    occG: GainNode;
    fade: GainNode;
    panner: PannerNode;
    /** Frame number in which the ghost was last present and alive. */
    seen: number;
    dying: boolean;
    /** Smoothed exertion 0..1 from the ghost's visibility. */
    exert: number;
    /** Context time the next breath cycle starts. */
    nextBreath: number;
    occTimer: number;
    /** False until the first occlusion test, which is applied instantly rather than smoothed. */
    occInit: boolean;
    occluded: boolean;
    head: Vec3;
}

// ---------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------

const STEP_CFG: ShotCfg = { range: STEP_RANGE, ref: 1, hrtf: true, occLift: 0.4 };
const GUN_CFG: ShotCfg = { range: GUN_RANGE, ref: 2, hrtf: false, occLift: 0 };
const IMPACT_CFG: ShotCfg = { range: IMPACT_RANGE, ref: 1, hrtf: false, occLift: 0 };
const KNIFE_CFG: ShotCfg = { range: KNIFE_SOUND_RANGE, ref: 1, hrtf: true, occLift: 0 };
const BOMB_CFG: ShotCfg = { range: BOMB_RANGE, ref: 2, hrtf: true, occLift: 0 };
/** Unused by non-positional one-shots except as a placeholder. */
const CUE_CFG: ShotCfg = { range: 1, ref: 1, hrtf: false, occLift: 0 };
/** Scratch config for footsteps, whose range depends on loudness. */
const stepCfg: ShotCfg = { ...STEP_CFG };

export const createAudio: CreateAudio = (boxes: readonly Box[]): AudioEngine => {
    let ctx: AudioContext | null = null;
    let failed = false;
    let master: GainNode | null = null;
    let bank: NoiseBank | null = null;

    const voices: Voice[] = [];
    const breathers: Breather[] = [];
    const breatherById = new Map<number, Breather>();

    // Listener state from the last frame (scratch, reused).
    const lpos: Vec3 = [0, 0, 0];
    let haveListener = false;
    let frameNo = 0;
    const rayDir: Vec3 = [0, 0, 0];
    // Bomb beeper: seconds since the last beep, and whether a bomb was ticking last frame.
    let beepAcc = 0;
    let beeping = false;
    const beepPos: Vec3 = [0, 0, 0];

    // ---- occlusion --------------------------------------------------------------------------

    function occluded(x: number, y: number, z: number): boolean {
        const dx = x - lpos[0], dy = y - lpos[1], dz = z - lpos[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist <= OCC_MARGIN * 2) return false;
        rayDir[0] = dx / dist;
        rayDir[1] = dy / dist;
        rayDir[2] = dz / dist;
        return rayWorld(boxes, lpos, rayDir, dist) < dist - OCC_MARGIN;
    }

    // ---- one-shots --------------------------------------------------------------------------

    function removeVoice(v: Voice): void {
        const i = voices.indexOf(v);
        if (i < 0) return;
        voices[i] = voices[voices.length - 1];
        voices.pop();
    }

    /** Loudness a voice still contributes, falling as it plays out: oldest and quietest go first. */
    function liveness(v: Voice, now: number): number {
        const len = v.end - v.start;
        const left = len > 0 ? Math.max(0, (v.end - now) / len) : 0;
        return v.priority * left;
    }

    function oneShot(pos: Vec3 | null, cfg: ShotCfg, gain: number, synth: Synth, x: number, flag: boolean,
        weight = 1): void {
        if (!ctx || !master || !bank) return;
        const now = ctx.currentTime;

        let att = 1, occ = false;
        if (pos && haveListener) {
            const dx = pos[0] - lpos[0], dy = pos[1] - lpos[1], dz = pos[2] - lpos[2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            att = linearGain(d, cfg.ref, cfg.range);
            if (att <= 0) return; // beyond audible range: do not even build it
            occ = occluded(pos[0], pos[1] + cfg.occLift, pos[2]);
        }
        const priority = gain * att * (occ ? OCC_GAIN : 1) * weight;

        if (voices.length >= MAX_VOICES) {
            let worst: Voice | null = null, worstP = Infinity;
            for (let i = 0; i < voices.length; i++) {
                const p = liveness(voices[i], now);
                if (p < worstP) { worstP = p; worst = voices[i]; }
            }
            if (!worst || worstP >= priority) return; // the new sound is the least important one
            worst.kill(now);
            removeVoice(worst);
        }

        const t = now + LEAD;
        const v = new Voice(ctx, bank);
        v.start = t;
        v.priority = priority;
        v.input.gain.value = gain;
        synth(v, t, x, flag);

        if (pos) {
            // Per-voice occlusion stage, set once: the source does not move during a one-shot.
            const f = ctx.createBiquadFilter();
            f.type = 'lowpass';
            f.frequency.value = occ ? OCC_CUTOFF : OPEN_CUTOFF;
            f.Q.value = 0.707;
            const g = ctx.createGain();
            g.gain.value = occ ? OCC_GAIN : 1;
            const p = makePanner(ctx, cfg.hrtf, cfg.ref, cfg.range);
            setPannerPos(p, pos[0], pos[1], pos[2]);
            v.input.connect(f);
            f.connect(g);
            g.connect(p);
            p.connect(master);
            v.nodes.push(f, g, p);
        } else {
            v.input.connect(master);
        }
        v.arm(removeVoice);
        voices.push(v);
    }

    // ---- breathing --------------------------------------------------------------------------

    function createBreather(c: AudioContext, out: AudioNode, nb: NoiseBank, id: number, now: number): Breather {
        const src = c.createBufferSource();
        src.buffer = nb.pink;
        src.loop = true;
        // A fixed throaty resonance makes the noise read as a voice tract rather than wind.
        const formant = c.createBiquadFilter();
        formant.type = 'peaking';
        formant.frequency.value = 1800;
        formant.Q.value = 3;
        formant.gain.value = 7;
        const band = c.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = 900;
        band.Q.value = 1.4;
        const amp = c.createGain();
        amp.gain.value = 0;
        const occF = c.createBiquadFilter();
        occF.type = 'lowpass';
        occF.frequency.value = OPEN_CUTOFF;
        occF.Q.value = 0.707;
        const occG = c.createGain();
        const fade = c.createGain();
        fade.gain.setValueAtTime(0, now);
        fade.gain.linearRampToValueAtTime(1, now + LOOP_FADE);
        const panner = makePanner(c, true, 0.8, BREATH_RANGE);
        src.connect(formant);
        formant.connect(band);
        band.connect(amp);
        amp.connect(occF);
        occF.connect(occG);
        occG.connect(fade);
        fade.connect(panner);
        panner.connect(out);
        src.start(now, Math.random() * nb.pink.duration);
        const b: Breather = {
            id, src, formant, band, amp, occF, occG, fade, panner,
            seen: frameNo, dying: false, exert: 0,
            // Random phase so several ghosts do not breathe in unison.
            nextBreath: now + Math.random() * 0.6,
            occTimer: 0, occInit: false, occluded: false, head: [0, 0, 0],
        };
        src.onended = () => {
            src.disconnect(); formant.disconnect(); band.disconnect(); amp.disconnect();
            occF.disconnect(); occG.disconnect(); fade.disconnect(); panner.disconnect();
            const i = breathers.indexOf(b);
            if (i >= 0) { breathers[i] = breathers[breathers.length - 1]; breathers.pop(); }
        };
        return b;
    }

    /**
     * One inhale/exhale cycle, scheduled ahead. At rest the period is ~2.9 s (~0.34 Hz); exertion
     * (visibility) shortens it to ~1.7 s and makes it louder and rougher (lower Q). Inhale is higher
     * and hissy (band rises), exhale lower and longer (band falls): the filter sweep is what makes
     * filtered noise sound like breath rather than surf.
     */
    function scheduleBreath(b: Breather, t0: number): void {
        const e = b.exert;
        const P = (2.9 - 1.2 * e) * jitter(0.08);
        const level = 1.0 + 1.0 * e;
        const inh = 0.36 * P, hold = 0.06 * P, ex = 0.42 * P;
        const a = b.amp.gain, f = b.band.frequency;
        a.setValueAtTime(0.001, t0);
        a.linearRampToValueAtTime(0.8 * level * jitter(0.1), t0 + 0.7 * inh);
        a.linearRampToValueAtTime(0.45 * level, t0 + inh);
        a.linearRampToValueAtTime(0.02, t0 + inh + hold);
        a.linearRampToValueAtTime(1.0 * level * jitter(0.1), t0 + inh + hold + 0.25 * ex);
        a.linearRampToValueAtTime(0.001, t0 + inh + hold + ex);
        f.setValueAtTime(900, t0);
        f.exponentialRampToValueAtTime(1500 + 500 * e, t0 + inh);
        f.exponentialRampToValueAtTime(700, t0 + inh + hold);
        f.exponentialRampToValueAtTime(420, t0 + inh + hold + ex);
        b.band.Q.setValueAtTime(1.6 - 0.7 * e, t0);
        b.nextBreath = t0 + P;
    }

    function releaseBreather(b: Breather, now: number): void {
        b.dying = true;
        breatherById.delete(b.id);
        const g = b.fade.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + LOOP_FADE);
        b.src.stop(now + LOOP_FADE + 0.03);
    }

    // ---- listener ---------------------------------------------------------------------------

    function setListener(c: AudioContext, L: ListenerView): void {
        const sy = Math.sin(L.yaw), cy = Math.cos(L.yaw), sp = Math.sin(L.pitch), cp = Math.cos(L.pitch);
        const fx = -sy * cp, fy = sp, fz = -cy * cp;
        // "Up" is +Y tilted with the pitch so it stays perpendicular to forward (no degenerate
        // orientation when looking straight up or down).
        const ux = -sy * -sp, uy = cp, uz = -cy * -sp;
        const l = c.listener;
        if (l.positionX) {
            l.positionX.value = L.pos[0];
            l.positionY.value = L.pos[1];
            l.positionZ.value = L.pos[2];
            l.forwardX.value = fx;
            l.forwardY.value = fy;
            l.forwardZ.value = fz;
            l.upX.value = ux;
            l.upY.value = uy;
            l.upZ.value = uz;
        } else {
            const legacy = l as unknown as LegacyListener;
            legacy.setPosition(L.pos[0], L.pos[1], L.pos[2]);
            legacy.setOrientation(fx, fy, fz, ux, uy, uz);
        }
        lpos[0] = L.pos[0];
        lpos[1] = L.pos[1];
        lpos[2] = L.pos[2];
        haveListener = true;
    }

    // ---- public API -------------------------------------------------------------------------

    return {
        unlock(): void {
            if (failed) return;
            if (ctx) {
                if (ctx.state !== 'running') ctx.resume().catch(() => { /* retried on next gesture */ });
                return;
            }
            try {
                const Ctor: typeof AudioContext | undefined = window.AudioContext
                    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
                if (!Ctor) { failed = true; return; }
                const c = new Ctor({ latencyHint: 'interactive' });
                // Gentle glue compressor, then a fast high-ratio limiter so pile-ups never clip.
                // Thresholds sit well above normal single-sound levels so quiet breathing is never pumped.
                const comp = c.createDynamicsCompressor();
                comp.threshold.value = -12;
                comp.knee.value = 10;
                comp.ratio.value = 3;
                comp.attack.value = 0.005;
                comp.release.value = 0.15;
                const limit = c.createDynamicsCompressor();
                limit.threshold.value = -3;
                limit.knee.value = 0;
                limit.ratio.value = 20;
                limit.attack.value = 0.001;
                limit.release.value = 0.1;
                comp.connect(limit);
                limit.connect(c.destination);
                const m = c.createGain();
                m.gain.value = MASTER_GAIN;
                m.connect(comp);
                bank = makeNoiseBank(c);
                master = m;
                ctx = c;
                if (c.state !== 'running') c.resume().catch(() => { /* retried on next gesture */ });
            } catch {
                failed = true;
                ctx = null;
                master = null;
                bank = null;
            }
        },

        frame(dt: number, listener: ListenerView, remotes: readonly RemoteView[], bomb: BombView | null): void {
            if (!ctx || !master || !bank) return;
            const now = ctx.currentTime;
            frameNo++;
            setListener(ctx, listener);

            // Bomb beeper: first beep at once, then on an accumulator whose period shrinks with the clock.
            if (bomb) {
                const iv = beepInterval(bomb.timeLeft);
                if (!beeping) { beeping = true; beepAcc = iv; } else beepAcc += dt;
                if (beepAcc >= iv) {
                    // Keep the remainder (steady rhythm) but never let a stall cause a burst of beeps.
                    beepAcc = Math.min(beepAcc - iv, iv);
                    beepPos[0] = bomb.pos[0];
                    beepPos[1] = bomb.pos[1] + BOMB_LIFT;
                    beepPos[2] = bomb.pos[2];
                    oneShot(beepPos, BOMB_CFG, BEEP_GAIN, synthBeep, 0, false, BEEP_PRIORITY);
                }
            } else {
                beeping = false;
            }

            // Mark (and create) emitters for every living enemy ghost.
            if (listener.alive) {
                for (let i = 0; i < remotes.length; i++) {
                    const r = remotes[i];
                    if (r.team !== 'ghosts' || r.team === listener.team || !r.alive) continue;
                    let b = breatherById.get(r.id);
                    if (!b) {
                        b = createBreather(ctx, master, bank, r.id, now);
                        breatherById.set(r.id, b);
                        breathers.push(b);
                    }
                    b.seen = frameNo;
                    b.head[0] = r.pos[0];
                    b.head[1] = r.pos[1] + (r.crouched ? HEAD_CROUCH : HEAD_STAND);
                    b.head[2] = r.pos[2];
                    const target = Math.min(1, Math.max(0, r.vis / GHOST_MAX_VIS));
                    b.exert += (target - b.exert) * Math.min(1, dt * 3);
                }
            }

            // Update, or fade out the ones whose ghost is gone/dead (or the listener is dead).
            for (let i = breathers.length - 1; i >= 0; i--) {
                const b = breathers[i];
                if (b.dying) continue;
                if (b.seen !== frameNo) { releaseBreather(b, now); continue; }
                const h = b.head;
                setPannerPos(b.panner, h[0], h[1], h[2]);

                b.occTimer -= dt;
                if (b.occTimer <= 0 || !b.occInit) {
                    const first = !b.occInit;
                    b.occInit = true;
                    // First test now, then every 100 ms from a random phase so emitters spread out.
                    b.occTimer = first ? Math.random() * OCC_INTERVAL : Math.max(0, b.occTimer + OCC_INTERVAL);
                    const dx = h[0] - lpos[0], dy = h[1] - lpos[1], dz = h[2] - lpos[2];
                    const inRange = dx * dx + dy * dy + dz * dz < BREATH_RANGE * BREATH_RANGE;
                    const occ = inRange && occluded(h[0], h[1], h[2]);
                    if (first) {
                        b.occluded = occ;
                        b.occF.frequency.value = occ ? OCC_CUTOFF : OPEN_CUTOFF;
                        b.occG.gain.value = occ ? OCC_GAIN : 1;
                    } else if (occ !== b.occluded) {
                        b.occluded = occ;
                        b.occF.frequency.setTargetAtTime(occ ? OCC_CUTOFF : OPEN_CUTOFF, now, OCC_SMOOTH);
                        b.occG.gain.setTargetAtTime(occ ? OCC_GAIN : 1, now, OCC_SMOOTH);
                    }
                }

                // Keep about a quarter second of breath scheduled ahead.
                if (b.nextBreath < now) b.nextBreath = now + LEAD;
                if (b.nextBreath < now + 0.25) scheduleBreath(b, b.nextBreath);
            }
        },

        step(pos: Vec3, loud: number, isLocal: boolean): void {
            const l = Math.min(1, Math.max(0, loud));
            if (l <= 0) return;
            if (isLocal) {
                // Own footsteps: present for feedback, but subdued so they never mask enemies.
                oneShot(null, STEP_CFG, 0.3, synthStep, l, false);
                return;
            }
            // The gameplay range is measured along the ground, but the listener is at eye height and
            // the step at the feet: stretch the 3D range so a step on the same floor dies exactly at it.
            const r = Math.max(STEP_RANGE * l, 1.5);
            stepCfg.range = Math.sqrt(r * r + EYE_HEIGHT * EYE_HEIGHT);
            oneShot(pos, stepCfg, 1, synthStep, l, false);
        },

        gunshot(pos: Vec3, isLocal: boolean): void {
            oneShot(isLocal ? null : pos, GUN_CFG, isLocal ? 0.7 : 1, synthGun, 0, false);
        },

        impact(pos: Vec3): void {
            oneShot(pos, IMPACT_CFG, 0.8, synthImpact, 0, false);
        },

        knifeWindup(pos: Vec3, isLocal: boolean): void {
            oneShot(isLocal ? null : pos, KNIFE_CFG, isLocal ? 0.45 : 1, synthWindup, 0, false);
        },

        knifeSlash(pos: Vec3, hit: boolean, isLocal: boolean): void {
            oneShot(isLocal ? null : pos, KNIFE_CFG, isLocal ? 0.6 : 1, synthSlash, 0, hit);
        },

        hurt(): void {
            oneShot(null, STEP_CFG, 0.9, synthHurt, 0, false);
        },

        cue(kind: CueKind): void {
            const c = CUES[kind];
            if (c) oneShot(null, CUE_CFG, c.gain, c.synth, 0, false, CUE_PRIORITY);
        },
    };
};
