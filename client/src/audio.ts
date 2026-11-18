/**
 * Spatial audio for Stillblade. Every sound can be synthesised with Web Audio from three pre-generated noise
 * buffers plus oscillators, filters and gain envelopes. Package H adds recorded CC0 samples (client/public/audio,
 * loaded in the background after the game is playable): a sound plays its sample when one has loaded and the
 * synthesised sound otherwise, so the game is never silent, and gunshots layer the sample over the synthesised
 * shot. Which sound plays is decided by the pure rules in audio-logic.ts; distance, direction, occlusion, ranges
 * and volumes below do not care which kind of source a voice holds.
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
import {
    BREATH_RANGE, EYE_HEIGHT, GHOST_MAX_VIS, GUNSHOT_RANGE, GUNSHOT_RANGE_SUPPRESSED, KNIFE_SOUND_RANGE, RELOAD_SOUND_RANGE,
    STEP_RANGE, TICK_RATE
} from '@shared/constants';
import { BOMB_SOUND_RANGE } from '@shared/bomb';
import { rayWorld } from '@shared/raycast';
import { DEFENDER_KNIFE, SLOT_KNIFE, WEAPONS, type WeaponId } from '@shared/weapons';
import type { Box, Vec3 } from '@shared/types';
import type { AudioEngine, AudioOptions, BombView, CreateAudio, CueKind, ListenerView } from './audio-api';
import type { RemoteView } from './presenter-api';
import {
    BREATH_SETS, DEFAULT_SOUND_MODE, RELOAD_BOLT_SLAM, RELOAD_CUES, SAMPLE_GAIN, SAMPLE_SETS, breathGap, breathLevel, breathRate, gunBlend,
    pickBreathSet, pickVariant, sampleFiles, stepVariation, surfaceUnder, useRecorded, varied, type SoundMode
} from './audio-logic';
import { faceAt, type Surface } from './effects';

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

const MASTER_GAIN = 0.8;
/** Simultaneous one-shot voices; breathing loops are not counted. */
const MAX_VOICES = 24;
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
/** A reload cut this close to its end is one completing normally: nothing is silenced (s). */
const RELOAD_TAIL = 0.15;
/** A remote reload whose `reloading` flag has not shown up this long after its sound is treated as already over (s). */
const RELOAD_SEEN_GRACE = 0.35;
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
    /** What the event is about, for samples: the surface of a step or impact, or the weapon of a switch. */
    tag = '';
    /** The loaded samples and the mode, or null for a voice that must stay synthesised. */
    samples: SampleBank | null = null;
    /** Distance (m) from the listener to the source when started, 0 for a sound with no position; for the gunshot's close/distant blend. */
    dist = 0;
    /** Audible range (m) of this sound, from its config. */
    range = 1;
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

    /** A variant of recorded set `set`, or null when recorded sounds are off or none has loaded (play the synth). */
    pick(set: string): AudioBuffer | null {
        return this.samples ? this.samples.pick(set) : null;
    }

    /** Like `pick`, for the package N recordings: null too when the sound test page switched them off (play package H's sound). */
    pickReal(set: string): AudioBuffer | null {
        return this.samples && this.samples.mode.real ? this.samples.pick(set) : null;
    }

    /** Are recorded sounds on and loaded for every one of these sets (see `useRecorded`)? */
    has(parts: readonly string[]): boolean {
        return this.samples ? this.samples.usable(parts) : false;
    }

    /** Plays a sample at time `t`, at `level` (times the set's calibration) and playback `rate`. */
    play(set: string, buf: AudioBuffer, t: number, level: number, rate: number): void {
        const g = this.gain(this.input);
        g.gain.value = level * (SAMPLE_GAIN[set] ?? 1);
        const s = this.ctx.createBufferSource();
        s.buffer = buf;
        s.playbackRate.value = rate;
        s.connect(g);
        s.start(t);
        this.track(s, t + buf.duration / rate);
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
// Recorded samples
// ---------------------------------------------------------------------------------------------

/** The decoded samples of one audio context, by set; a slot stays empty until its file has loaded (or for good if it never does). */
class SampleBank {
    readonly sets = new Map<string, (AudioBuffer | null)[]>();
    private readonly last = new Map<string, number>();
    mode: SoundMode = { ...DEFAULT_SOUND_MODE };
    loaded = 0;
    total = 0;

    constructor() {
        for (const set of Object.keys(SAMPLE_SETS)) {
            this.sets.set(set, new Array<AudioBuffer | null>(SAMPLE_SETS[set]).fill(null));
            this.total += SAMPLE_SETS[set];
        }
    }

    has(set: string): boolean {
        const a = this.sets.get(set);
        if (!a) return false;
        for (let i = 0; i < a.length; i++) if (a[i]) return true;
        return false;
    }

    usable(parts: readonly string[]): boolean {
        return useRecorded(this.mode, s => this.has(s), parts);
    }

    /** A variant of `set` (never the same one twice running), or null to play the synthesised sound. */
    pick(set: string): AudioBuffer | null {
        if (!this.mode.recorded) return null;
        const a = this.sets.get(set);
        if (!a) return null;
        const i = pickVariant(a, Math.random(), this.last.get(set) ?? -1);
        if (i < 0) return null;
        this.last.set(set, i);
        return a[i];
    }
}

/** Fetches and decodes every sample file in small batches. A file that is missing or will not decode is skipped. */
async function loadSamples(ctx: BaseAudioContext, bank: SampleBank, base: string): Promise<void> {
    const jobs: { set: string; index: number; url: string }[] = [];
    for (const set of Object.keys(SAMPLE_SETS)) {
        const files = sampleFiles(set);
        for (let i = 0; i < files.length; i++) jobs.push({ set, index: i, url: base + files[i] });
    }
    const one = async (j: { set: string; index: number; url: string }): Promise<void> => {
        try {
            const r = await fetch(j.url);
            if (!r.ok) return;
            const type = r.headers.get('content-type') ?? '';
            if (type.includes('text/html')) return; // a dev server answering a missing file with its index page
            const buf = await ctx.decodeAudioData(await r.arrayBuffer());
            const arr = bank.sets.get(j.set);
            if (arr && !arr[j.index]) { arr[j.index] = buf; bank.loaded++; }
        } catch { /* missing or undecodable: that sound stays synthesised */ }
    };
    for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map(one));
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

/**
 * Unsuppressed rifle (room option off): a sharp crack, a heavy low-passed muzzle blast, a falling low boom
 * and a long dull tail (the report rolling off walls), then the action cycling. About 0.9 s in all.
 */
const synthLoudRifle: Synth = (v, t) => {
    const crack = v.gain(v.input);
    v.noise(v.bank.white, t, 0.05, v.filter('highpass', 3000, 0.7, crack));
    env(crack.gain, t, 0.0004, 1.1, 0.03);

    const blast = v.gain(v.input);
    v.noise(v.bank.pink, t, 0.3, v.filter('lowpass', 2400 * jitter(0.05), 0.8, blast));
    env(blast.gain, t, 0.001, 1.5, 0.16);

    const boom = v.gain(v.input);
    const o = v.osc('sine', 120 * jitter(0.04), t, 0.36, boom);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.26);
    env(boom.gain, t, 0.002, 1.2, 0.3);

    const tt = t + 0.03;
    const tail = v.gain(v.input);
    v.noise(v.bank.brown, tt, 0.9, v.filter('lowpass', 650, 0.7, tail));
    tail.gain.setValueAtTime(0, tt);
    tail.gain.linearRampToValueAtTime(0.55, tt + 0.06);
    tail.gain.exponentialRampToValueAtTime(0.0001, tt + 0.88);

    const tc = t + 0.045;
    const click = v.gain(v.input);
    v.noise(v.bank.white, tc, 0.03, v.filter('bandpass', 3000, 4, click));
    env(click.gain, tc, 0.0005, 0.3, 0.015);
};

/** Unsuppressed pistol: a higher, snappier crack and blast, a shorter boom and tail, the slide. About 0.65 s. */
const synthLoudPistol: Synth = (v, t) => {
    const crack = v.gain(v.input);
    v.noise(v.bank.white, t, 0.04, v.filter('highpass', 3800, 0.7, crack));
    env(crack.gain, t, 0.0003, 1.15, 0.022);

    const blast = v.gain(v.input);
    v.noise(v.bank.pink, t, 0.22, v.filter('lowpass', 3200 * jitter(0.05), 0.9, blast));
    env(blast.gain, t, 0.0008, 1.35, 0.11);

    const boom = v.gain(v.input);
    const o = v.osc('sine', 175 * jitter(0.04), t, 0.24, boom);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.16);
    env(boom.gain, t, 0.0015, 0.95, 0.19);

    const tt = t + 0.025;
    const tail = v.gain(v.input);
    v.noise(v.bank.brown, tt, 0.62, v.filter('lowpass', 800, 0.7, tail));
    tail.gain.setValueAtTime(0, tt);
    tail.gain.linearRampToValueAtTime(0.42, tt + 0.05);
    tail.gain.exponentialRampToValueAtTime(0.0001, tt + 0.6);

    const back = t + 0.03;
    const click = v.gain(v.input);
    v.noise(v.bank.white, back, 0.025, v.filter('bandpass', 3600, 4, click));
    env(click.gain, back, 0.0004, 0.35, 0.012);
    metalClick(v, back + 0.03, 4400, 0.25);
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

/** A small metallic click at `t`: tight band-passed white noise plus a faint inharmonic ping. */
function metalClick(v: Voice, t: number, freq: number, level: number): void {
    const c = v.gain(v.input);
    v.noise(v.bank.white, t, 0.03, v.filter('bandpass', freq * jitter(0.05), 5, c));
    env(c.gain, t, 0.0005, level, 0.014);
    const ping = v.gain(v.input);
    v.osc('sine', freq * 0.71 * jitter(0.04), t, 0.06, ping);
    v.osc('sine', freq * 1.13 * jitter(0.04), t, 0.06, ping);
    env(ping.gain, t, 0.0005, level * 0.08, 0.045);
}

/** A dull clunk at `t`: low-passed brown noise and a short falling sine. */
function clunk(v: Voice, t: number, freq: number, level: number): void {
    const body = v.gain(v.input);
    v.noise(v.bank.brown, t, 0.07, v.filter('lowpass', 700, 0.9, body));
    env(body.gain, t, 0.002, level, 0.05);
    const knock = v.gain(v.input);
    const o = v.osc('sine', freq, t, 0.08, knock);
    o.frequency.exponentialRampToValueAtTime(freq * 0.55, t + 0.05);
    env(knock.gain, t, 0.002, level * 0.6, 0.05);
}

/** A short metal-on-metal scrape from `t`: band-passed white noise sweeping `f0` -> `f1`. */
function scrape(v: Voice, t: number, dur: number, f0: number, f1: number, level: number): void {
    const s = v.gain(v.input);
    const bp = v.filter('bandpass', f0, 2.5, s);
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    v.noise(v.bank.white, t, dur + 0.02, bp);
    s.gain.setValueAtTime(0, t);
    s.gain.linearRampToValueAtTime(level, t + dur * 0.3);
    s.gain.linearRampToValueAtTime(0, t + dur);
}

/**
 * Rifle reload, all scheduled from `t` at the first-person clip's times (RELOAD_CUES, package R): magazine release
 * click and the magazine rocked out, the new one seated (clunk + latch click). flag = the empty reload (2.7 s): the
 * charging handle is then pulled back and let go (a scrape and the bolt slamming home). Quiet by design.
 */
const synthReload: Synth = (v, t, _x, empty) => {
    const cue = empty ? RELOAD_CUES.rifle_empty : RELOAD_CUES.rifle;
    const out = t + cue.times[0] + Math.random() * 0.03;
    metalClick(v, out, 3400, 0.5);
    scrape(v, out + 0.02, 0.09, 1500, 900, 0.18);
    const seat = t + cue.times[1] + Math.random() * 0.03;
    scrape(v, seat - 0.06, 0.06, 900, 1600, 0.14);
    clunk(v, seat, 190, 0.55);
    metalClick(v, seat + 0.012, 2800, 0.45);
    if (!empty) return;
    const bolt = t + RELOAD_CUES.rifle_empty.times[2];
    const home = bolt + RELOAD_BOLT_SLAM;
    scrape(v, bolt, 0.07, 1600, 3200, 0.22);
    metalClick(v, bolt + 0.07, 3800, 0.4);
    metalClick(v, home, 3000, 0.6);
    clunk(v, home, 230, 0.45);
};

/**
 * Suppressed pistol shot: like the rifle's but sharper, shorter and higher (a smaller charge through a smaller
 * can), with a more prominent slide: it cycles sooner and slams back a moment later.
 */
const synthPistol: Synth = (v, t) => {
    const pft = v.gain(v.input);
    v.noise(v.bank.white, t, 0.06, v.filter('bandpass', 2100 * jitter(0.06), 1.3, pft));
    env(pft.gain, t, 0.0007, 0.95, 0.04);

    const thwip = v.gain(v.input);
    v.noise(v.bank.white, t, 0.03, v.filter('bandpass', 6800, 1.6, thwip));
    env(thwip.gain, t, 0.0004, 0.55, 0.016);

    const thump = v.gain(v.input);
    const o = v.osc('sine', 210, t, 0.06, thump);
    o.frequency.exponentialRampToValueAtTime(75, t + 0.035);
    env(thump.gain, t, 0.0015, 0.55, 0.04);

    const back = t + 0.03;
    const click = v.gain(v.input);
    v.noise(v.bank.white, back, 0.025, v.filter('bandpass', 3600, 4, click));
    env(click.gain, back, 0.0004, 0.45, 0.012);
    metalClick(v, back + 0.03, 4400, 0.3);
};

/**
 * Pistol reload (~1.4 s, all scheduled from `t`; the viewmodel jolts in presenter.ts use the same times):
 * magazine release and drop at 0.15 s, new magazine slid in and seated at 0.7 s, slide pulled back at
 * 1.0 s and released home at 1.17 s.
 */
const synthPistolReload: Synth = (v, t) => {
    const out = t + 0.15 + Math.random() * 0.02;
    metalClick(v, out, 3900, 0.45);
    scrape(v, out + 0.015, 0.06, 1800, 1100, 0.14);
    const seat = t + 0.7 + Math.random() * 0.02;
    scrape(v, seat - 0.05, 0.05, 1100, 1900, 0.12);
    clunk(v, seat, 260, 0.45);
    metalClick(v, seat + 0.01, 3200, 0.5);
    const rack = t + 1.0;
    scrape(v, rack, 0.07, 2000, 3800, 0.2);
    metalClick(v, rack + 0.075, 4200, 0.35);
    const home = t + 1.17;
    metalClick(v, home, 3300, 0.65);
    clunk(v, home, 300, 0.35);
};

/**
 * Weapon switch, scheduled over the draw time (x, seconds): a cloth rustle as the old one is put away, then the
 * new one coming up. flag = pistol: a leather holster squeak and a light click; otherwise the sling's
 * heavier clunk and a louder click as the rifle settles.
 */
const synthSwitch: Synth = (v, t, draw, pistol) => {
    const d = draw > 0.05 ? draw : 0.3;
    const cloth = v.gain(v.input);
    const band = v.filter('bandpass', 700, 0.7, cloth);
    band.frequency.setValueAtTime(600, t);
    band.frequency.linearRampToValueAtTime(1600, t + d * 0.45);
    v.noise(v.bank.pink, t, d * 0.6, band);
    cloth.gain.setValueAtTime(0, t);
    cloth.gain.linearRampToValueAtTime(0.5, t + d * 0.2);
    cloth.gain.linearRampToValueAtTime(0, t + d * 0.55);
    if (pistol) {
        const squeak = v.gain(v.input);
        const bp = v.filter('bandpass', 1300, 5, squeak);
        bp.frequency.setValueAtTime(1300, t + d * 0.25);
        bp.frequency.linearRampToValueAtTime(1700, t + d * 0.5);
        v.noise(v.bank.pink, t + d * 0.25, d * 0.3, bp);
        squeak.gain.setValueAtTime(0, t + d * 0.25);
        squeak.gain.linearRampToValueAtTime(0.35, t + d * 0.35);
        squeak.gain.linearRampToValueAtTime(0, t + d * 0.55);
        metalClick(v, t + d * 0.8, 4000, 0.4);
    } else {
        clunk(v, t + d * 0.55, 170, 0.35);
        metalClick(v, t + d * 0.8, 3200, 0.5);
    }
};

/** Dry fire: a lone hammer click, crisp and small. */
const synthDry: Synth = (v, t) => {
    metalClick(v, t, 4200, 0.7);
    const tick = v.gain(v.input);
    v.noise(v.bank.brown, t, 0.03, v.filter('bandpass', 900, 1.5, tick));
    env(tick.gain, t, 0.001, 0.25, 0.018);
};

/** The bomb dropped onto the floor: a dull case thud and a small rattle of its straps. */
const synthBombDrop: Synth = (v, t) => {
    const thud = v.gain(v.input);
    const o = v.osc('sine', 120, t, 0.16, thud);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    env(thud.gain, t, 0.002, 0.7, 0.12);
    const body = v.gain(v.input);
    v.noise(v.bank.brown, t, 0.12, v.filter('bandpass', 420, 1.4, body));
    env(body.gain, t, 0.002, 0.6, 0.09);
    metalClick(v, t + 0.05, 2600, 0.25);
};

/** The bomb picked up: two quick strap and buckle clicks over a short cloth scuff. */
const synthBombPickup: Synth = (v, t) => {
    const scuff = v.gain(v.input);
    v.noise(v.bank.pink, t, 0.14, v.filter('bandpass', 1400, 1.2, scuff));
    env(scuff.gain, t, 0.01, 0.3, 0.1);
    metalClick(v, t + 0.04, 3400, 0.35);
    metalClick(v, t + 0.11, 3900, 0.3);
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

/** Hit marker: a short bright tick; the headshot is higher and doubled, the kill lower and longer. flag = head, x = 1 for a kill. */
const synthHit: Synth = (v, t, x, flag) => {
    const kill = x > 0.5;
    const f = kill ? 880 : flag ? 2300 : 1500;
    const a = v.gain(v.input);
    const o = v.osc('triangle', f, t, 0.12, a);
    if (kill) o.frequency.exponentialRampToValueAtTime(440, t + 0.14);
    env(a.gain, t, 0.002, 0.8, kill ? 0.16 : 0.05);
    if (flag && !kill) {
        const b = v.gain(v.input);
        v.osc('triangle', f * 1.5, t + 0.045, 0.08, b);
        env(b.gain, t + 0.045, 0.002, 0.6, 0.05);
    }
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
    planted: { synth: sampled('bomb_planted', synthPlanted, 1, 0), gain: 0.9 },
    defused: { synth: sampled('bomb_defused', synthDefused, 1, 0), gain: 0.85 },
    exploded: { synth: sampled('explosion', synthExploded, 1, 0.03), gain: 0.85 },
    win: { synth: synthWin, gain: 0.8 },
    lose: { synth: synthLose, gain: 0.8 },
};

// Recorded versions. Each is a Synth that plays a sample when `Voice.pick` finds one and the synthesised sound
// otherwise (or, for gunshots, over it), so every event keeps working with no sample loaded.

/** A variant of `set` in place of `synth`; `pitch` is the +-fraction of random playback-rate variation. */
function sampled(set: string, synth: Synth, level = 1, pitch = 0.05): Synth {
    return (v, t, x, flag) => {
        const b = v.pick(set);
        if (!b) { synth(v, t, x, flag); return; }
        v.play(set, b, t, level * varied(0.12, Math.random()), varied(pitch, Math.random()));
    };
}

/** The synthesised shot with a recorded layer over it (when the layer is on and a sample is loaded). */
function layered(set: string, synth: Synth, level: number): Synth {
    return (v, t, x, flag) => {
        synth(v, t, x, flag);
        const b = v.samples && v.samples.mode.gunLayer ? v.pick(set) : null;
        if (b) v.play(set, b, t, level * varied(0.08, Math.random()), varied(0.04, Math.random()));
    };
}

/**
 * Package N gunshot: the recorded shot is the whole sound. A close variant (never the same twice running, a slight
 * level and pitch variation) and, for the louder shots, a distant tail blended in by distance (`gunBlend`; the
 * fade to silence at the range is the voice's panner as for every sound). With no recording loaded, or with
 * `real` off on the test page, `old` plays: package H's synthesised shot under a recorded thump.
 */
function recordedShot(closeSet: string, farSet: string | null, old: Synth, level: number): Synth {
    return (v, t, x, flag) => {
        const close = v.pickReal(closeSet);
        if (!close) { old(v, t, x, flag); return; }
        const far = farSet ? v.pickReal(farSet) : null;
        let wc = 1, wf = 0;
        if (far) { const b = gunBlend(v.dist, v.range); wc = b.close; wf = b.far; }
        v.play(closeSet, close, t, level * wc * varied(0.12, Math.random()), varied(0.04, Math.random()));
        if (far) v.play(farSet as string, far, t + 0.012, level * wf * varied(0.1, Math.random()), varied(0.03, Math.random()));
    };
}

const STEP_SETS: Record<string, string> = { concrete: 'step_concrete', metal: 'step_metal', wood: 'step_wood' };
const IMPACT_SETS: Record<string, string> = { concrete: 'impact_concrete', metal: 'impact_metal', wood: 'impact_wood' };

/** Footstep on the surface in `v.tag`; x = loud. */
const sampledStep: Synth = (v, t, loud, flag) => {
    const set = STEP_SETS[v.tag] ?? 'step_concrete';
    const b = v.pick(set);
    if (!b) { synthStep(v, t, loud, flag); return; }
    const sv = stepVariation(loud, Math.random(), Math.random());
    v.play(set, b, t, sv.gain, sv.rate);
};

/** Bullet impact on the surface in `v.tag`. */
const sampledImpact: Synth = (v, t, x, flag) => {
    const set = IMPACT_SETS[v.tag] ?? 'impact_concrete';
    const b = v.pick(set);
    if (!b) { synthImpact(v, t, x, flag); return; }
    v.play(set, b, t, 0.9 * varied(0.15, Math.random()), varied(0.08, Math.random()));
};

/**
 * A reload from its recorded parts at the animation's times; all or none (the whole synthesised reload). flag = an
 * empty reload, which plays `empty`'s cues (the rifle's adds the bolt) when the weapon has them.
 */
function sampledReload(kind: 'rifle' | 'pistol', fallback: Synth, empty: keyof typeof RELOAD_CUES = kind): Synth {
    return (v, t, x, flag) => {
        const cue = RELOAD_CUES[flag ? empty : kind];
        if (!v.has(cue.parts)) { fallback(v, t, x, flag); return; }
        for (let i = 0; i < cue.parts.length; i++) {
            const b = v.pick(cue.parts[i]);
            if (b) v.play(cue.parts[i], b, t + cue.times[i], 1, 1);
        }
    };
}

const SLASH_PARTS = ['knife_slash'];
const SLASH_HIT_PARTS = ['knife_slash', 'knife_hit'];
/** Knife slash: the swing sample, and on a hit the hit sample 50 ms in (as the synthesised thud). flag = hit. */
const sampledSlash: Synth = (v, t, x, hit) => {
    if (!v.has(hit ? SLASH_HIT_PARTS : SLASH_PARTS)) { synthSlash(v, t, x, hit); return; }
    const a = v.pick('knife_slash');
    if (a) v.play('knife_slash', a, t, varied(0.1, Math.random()), varied(0.05, Math.random()));
    const h = hit ? v.pick('knife_hit') : null;
    if (h) v.play('knife_hit', h, t + 0.05, varied(0.1, Math.random()), varied(0.05, Math.random()));
};

const sampledHitBody = sampled('hit_body', synthHit, 1, 0.02);
const sampledHitHead = sampled('hit_head', synthHit, 1, 0.02);
const sampledHitKill = sampled('hit_kill', synthHit, 1, 0.02);
const SWITCH_SETS: Record<string, string> = { rifle: 'switch_rifle', pistol: 'switch_pistol', knife: 'switch_knife' };
const sampledSwitch: Synth = (v, t, draw, pistol) => {
    const set = SWITCH_SETS[v.tag] ?? 'switch_rifle';
    const b = v.pick(set);
    if (!b) { synthSwitch(v, t, draw, pistol); return; }
    v.play(set, b, t, varied(0.1, Math.random()), varied(0.04, Math.random()));
};
/** A UI click: a recorded tick, or a short synthesised blip. */
const synthUi: Synth = (v, t) => {
    const g = v.gain(v.input);
    const o = v.osc('sine', 1700, t, 0.04, g);
    o.frequency.setValueAtTime(1700, t);
    o.frequency.exponentialRampToValueAtTime(1100, t + 0.03);
    env(g.gain, t, 0.002, 0.5, 0.025);
};
const sampledUi = sampled('ui_click', synthUi, 1, 0.04);

const sampledBeep = sampled('bomb_beep', synthBeep, 1, 0);
const sampledWindup = sampled('knife_windup', synthWindup, 1, 0.03);
const sampledDry = sampled('dry', synthDry, 1, 0.03);
const sampledDrop = sampled('bomb_drop', synthBombDrop, 1, 0.05);
const sampledPickup = sampled('bomb_pickup', synthBombPickup, 1, 0.05);

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

/**
 * Distance attenuation of a ghost's breathing (amplitude, 1 = the old level at point blank). The panner only
 * places it (HRTF direction) and this curve, applied by its own gain stage, sets how loud it is:
 *   - inside BREATH_NEAR (2.5 m): a flat BREATH_NEAR_GAIN, about -10 dB below the old level at 1 m, so a ghost
 *     right next to you is no longer deafening (the owner found it far too loud up close);
 *   - BREATH_NEAR to BREATH_KNEE (6 m): eases down in decibels to the old curve's level at 6 m;
 *   - BREATH_KNEE to BREATH_RANGE: exactly the old curve (linear from 0.8 m to silence at 8 m), so it is heard at
 *     6 to 8 m as before and fades to nothing at the gameplay range.
 * Changed by measurement only (2026-11-16); needs the owner's ear.
 */
const BREATH_NEAR = 2.5;
const BREATH_NEAR_GAIN = 0.32;
const BREATH_KNEE = 6;
/** The old breathing panner: linear from 0.8 m (full) to BREATH_RANGE (silent). */
const BREATH_OLD_REF = 0.8;
const BREATH_KNEE_DB = 20 * Math.log10(linearGainOld(BREATH_KNEE));
const BREATH_NEAR_DB = 20 * Math.log10(BREATH_NEAR_GAIN);
/** Smoothing (s) of the breathing level as the distance changes. */
const BREATH_GAIN_SMOOTH = 0.03;

function linearGainOld(d: number): number {
    return linearGain(d, BREATH_OLD_REF, BREATH_RANGE);
}

export function breathDistanceGain(d: number): number {
    if (d <= BREATH_NEAR) return BREATH_NEAR_GAIN;
    if (d >= BREATH_KNEE) return linearGainOld(d);
    const t = (d - BREATH_NEAR) / (BREATH_KNEE - BREATH_NEAR);
    return Math.pow(10, (BREATH_NEAR_DB + (BREATH_KNEE_DB - BREATH_NEAR_DB) * t) / 20);
}

interface Breather {
    id: number;
    src: AudioBufferSourceNode;
    formant: BiquadFilterNode;
    band: BiquadFilterNode;
    amp: GainNode;
    /** Recorded breaths (package N) enter here, past the synthesis filters, straight into the occlusion stage. */
    rec: GainNode;
    /** Index last played per recorded set, so a ghost never repeats a breath. */
    lastBreath: [number, number];
    occF: BiquadFilterNode;
    occG: GainNode;
    fade: GainNode;
    /** Distance level (`breathDistanceGain`); the panner itself does not attenuate. */
    dist: GainNode;
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
/** Gunshots fade to silence exactly where the server stops sending them as sounds (shared/constants.ts). */
const GUN_CFG: ShotCfg = { range: GUNSHOT_RANGE_SUPPRESSED, ref: 2, hrtf: false, occLift: 0 };
const LOUD_GUN_CFG: ShotCfg = { range: GUNSHOT_RANGE, ref: 4, hrtf: false, occLift: 0 };
const IMPACT_CFG: ShotCfg = { range: IMPACT_RANGE, ref: 1, hrtf: false, occLift: 0 };
const KNIFE_CFG: ShotCfg = { range: KNIFE_SOUND_RANGE, ref: 1, hrtf: true, occLift: 0 };
const BOMB_CFG: ShotCfg = { range: BOMB_RANGE, ref: 2, hrtf: true, occLift: 0 };
/** Dropping and picking up the bomb: quiet, heard within BOMB_SOUND_RANGE like a soft footstep. */
const BOMB_HANDLE_CFG: ShotCfg = { range: BOMB_SOUND_RANGE, ref: 1, hrtf: true, occLift: 0.3 };
/** Reload: emitted from about hand height (RELOAD_LIFT above the feet); HRTF so it can be placed. */
const RELOAD_LIFT = 1.0;
const RELOAD_CFG: ShotCfg = { range: RELOAD_SOUND_RANGE, ref: 1, hrtf: true, occLift: 0 };
/** Unused by non-positional one-shots except as a placeholder. */
const CUE_CFG: ShotCfg = { range: 1, ref: 1, hrtf: false, occLift: 0 };
/** Scratch config for footsteps, whose range depends on loudness. */
const stepCfg: ShotCfg = { ...STEP_CFG };

/** Each gun's suppressed and unsuppressed shot and its reload, by id, then per slot of the weapon table. */
const WEAPON_SOUNDS: Record<WeaponId, { shot: Synth; loud: Synth; reload: Synth }> = {
    rifle: {
        shot: recordedShot('shot_rifle_supp', null, layered('thump_rifle_supp', synthGun, 0.9), 1),
        loud: recordedShot('shot_rifle_loud', 'shot_rifle_far', layered('thump_rifle_loud', synthLoudRifle, 0.9), 1),
        reload: sampledReload('rifle', synthReload, 'rifle_empty')
    },
    pistol: {
        shot: recordedShot('shot_pistol_supp', null, layered('thump_pistol_supp', synthPistol, 0.9), 1),
        loud: recordedShot('shot_pistol_loud', 'shot_pistol_far', layered('thump_pistol_loud', synthLoudPistol, 0.9), 1),
        reload: sampledReload('pistol', synthPistolReload)
    }
};
const SLOT_SOUNDS = WEAPONS.map(w => WEAPON_SOUNDS[w.id]);

function slotOf(weapon: number): number {
    return weapon >= 0 && weapon < WEAPONS.length ? weapon | 0 : 0;
}

export const createAudio: CreateAudio = (boxes: readonly Box[], opts?: AudioOptions): AudioEngine => {
    let ctx: AudioContext | null = null;
    const samples = new SampleBank();
    let loadDone: () => void = () => { /* replaced below */ };
    const loadedPromise = new Promise<void>(res => { loadDone = res; });
    const faceScratch = { axis: 0, sign: 0, surface: 'concrete' as Surface };
    let failed = false;
    let master: GainNode | null = null;
    let bank: NoiseBank | null = null;
    // Player volume settings (0..1): master scales the master gain, the others scale each sound.
    let volMaster = 1, volEffects = 1, volSteps = 1, stepMode = false;

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
    const reloadPos: Vec3 = [0, 0, 0];

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

    /** Builds and starts one sound; returns its voice, or null when nothing was started. */
    function oneShot(pos: Vec3 | null, cfg: ShotCfg, gain: number, synth: Synth, x: number, flag: boolean,
        weight = 1, tag = ''): Voice | null {
        if (!ctx || !master || !bank) return null;
        const now = ctx.currentTime;
        gain *= stepMode ? volSteps : volEffects;
        if (gain <= 0) return null;

        let att = 1, occ = false, dist = 0;
        if (pos && haveListener) {
            const dx = pos[0] - lpos[0], dy = pos[1] - lpos[1], dz = pos[2] - lpos[2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            dist = d;
            att = linearGain(d, cfg.ref, cfg.range);
            if (att <= 0) return null; // beyond audible range: do not even build it
            occ = occluded(pos[0], pos[1] + cfg.occLift, pos[2]);
        }
        const priority = gain * att * (occ ? OCC_GAIN : 1) * weight;

        if (voices.length >= MAX_VOICES) {
            let worst: Voice | null = null, worstP = Infinity;
            for (let i = 0; i < voices.length; i++) {
                const p = liveness(voices[i], now);
                if (p < worstP) { worstP = p; worst = voices[i]; }
            }
            if (!worst || worstP >= priority) return null; // the new sound is the least important one
            worst.kill(now);
            removeVoice(worst);
        }

        const t = now + LEAD;
        const v = new Voice(ctx, bank);
        v.start = t;
        v.dist = dist;
        v.range = cfg.range;
        v.tag = tag;
        v.samples = samples;
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
        return v;
    }

    // ---- reload sequences ---------------------------------------------------------------------
    // Each reload is one voice holding the whole scheduled sequence; it is remembered per player so a reload that
    // ends early (switch, death, round reset) can be cut off instead of playing to the end.

    interface ReloadVoice { id: number; local: boolean; voice: Voice; start: number; dur: number; seen: boolean; }
    const reloads: ReloadVoice[] = [];

    /** Forgets reload `i`; when `cut`, silences what is left of it unless it was about to finish anyway. */
    function endReload(i: number, now: number, cut: boolean): void {
        const r = reloads[i];
        if (cut && now - r.start < r.dur - RELOAD_TAIL) r.voice.kill(now);
        reloads[i] = reloads[reloads.length - 1];
        reloads.pop();
    }

    /** Cuts off reload sounds of remote defenders whose reload ended early. No allocation. */
    function checkReloads(now: number, remotes: readonly RemoteView[]): void {
        for (let i = reloads.length - 1; i >= 0; i--) {
            const rv = reloads[i];
            if (now - rv.start >= rv.dur) { endReload(i, now, false); continue; }
            if (rv.local) continue;
            let r: RemoteView | null = null;
            for (let j = 0; j < remotes.length; j++) {
                if (remotes[j].id === rv.id) { r = remotes[j]; break; }
            }
            if (!r) continue;
            if (!r.alive) { endReload(i, now, true); continue; }
            // Snapshots are interpolated behind the sound event: wait to see the reload before judging its end.
            if (r.reloading) rv.seen = true;
            else if (rv.seen || now - rv.start > RELOAD_SEEN_GRACE) endReload(i, now, true);
        }
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
        const rec = c.createGain();
        const occG = c.createGain();
        const fade = c.createGain();
        fade.gain.setValueAtTime(0, now);
        fade.gain.linearRampToValueAtTime(1, now + LOOP_FADE);
        // HRTF for direction only: rolloff 0, the level comes from `dist` (breathDistanceGain).
        const panner = makePanner(c, true, BREATH_OLD_REF, BREATH_RANGE);
        panner.rolloffFactor = 0;
        const dist = c.createGain();
        dist.gain.value = 0;
        src.connect(formant);
        formant.connect(band);
        band.connect(amp);
        amp.connect(occF);
        rec.connect(occF);
        occF.connect(occG);
        occG.connect(fade);
        fade.connect(dist);
        dist.connect(panner);
        panner.connect(out);
        src.start(now, Math.random() * nb.pink.duration);
        const b: Breather = {
            id, src, formant, band, amp, rec, lastBreath: [-1, -1], occF, occG, fade, dist, panner,
            seen: frameNo, dying: false, exert: 0,
            // Random phase so several ghosts do not breathe in unison.
            nextBreath: now + Math.random() * 0.6,
            occTimer: 0, occInit: false, occluded: false, head: [0, 0, 0],
        };
        src.onended = () => {
            src.disconnect(); formant.disconnect(); band.disconnect(); amp.disconnect(); rec.disconnect();
            occF.disconnect(); occG.disconnect(); fade.disconnect(); dist.disconnect(); panner.disconnect();
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

    /**
     * One recorded breath cycle (package N) scheduled at `t0`: the next one is picked at random (calm or exerted by the
     * ghost's exertion, never the cycle just played), then the silence before the one after. Costs a source and a gain
     * node every couple of seconds per ghost, no more.
     */
    function scheduleRecordedBreath(b: Breather, t0: number): void {
        const e = b.exert;
        const set = pickBreathSet(e, Math.random());
        const si = set === 'breath_calm' ? 0 : 1;
        const arr = samples.sets.get(set);
        const k = arr ? pickVariant(arr, Math.random(), b.lastBreath[si]) : -1;
        const buf = arr && k >= 0 ? arr[k] : null;
        if (!buf || !ctx) { b.nextBreath = t0 + 1; return; }
        b.lastBreath[si] = k;
        const rate = breathRate(e, Math.random());
        const g = ctx.createGain();
        g.gain.value = breathLevel(e) * (SAMPLE_GAIN[set] ?? 1) * varied(0.1, Math.random());
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.playbackRate.value = rate;
        s.connect(g);
        g.connect(b.rec);
        s.onended = () => { s.disconnect(); g.disconnect(); };
        s.start(t0);
        b.nextBreath = t0 + buf.duration / rate + breathGap(e, Math.random());
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

    function stepSound(pos: Vec3, l: number, isLocal: boolean): void {
        if (isLocal) {
            // Own footsteps: present for feedback, but subdued so they never mask enemies.
            oneShot(null, STEP_CFG, 0.3, sampledStep, l, false, 1, surfaceUnder(boxes, pos));
            return;
        }
        // The gameplay range is measured along the ground, but the listener is at eye height and
        // the step at the feet: stretch the 3D range so a step on the same floor dies exactly at it.
        const r = Math.max(STEP_RANGE * l, 1.5);
        stepCfg.range = Math.sqrt(r * r + EYE_HEIGHT * EYE_HEIGHT);
        oneShot(pos, stepCfg, 1, sampledStep, l, false, 1, surfaceUnder(boxes, pos));
    }

    return {
        unlock(): void {
            if (failed) return;
            if (ctx) {
                if (!opts?.context && ctx.state !== 'running') ctx.resume().catch(() => { /* retried on next gesture */ });
                return;
            }
            try {
                const Ctor: typeof AudioContext | undefined = window.AudioContext
                    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
                if (!Ctor && !opts?.context) { failed = true; loadDone(); return; }
                const c = opts?.context ? opts.context as AudioContext : new Ctor!({ latencyHint: 'interactive' });
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
                m.gain.value = MASTER_GAIN * volMaster;
                m.connect(comp);
                bank = makeNoiseBank(c);
                master = m;
                ctx = c;
                if (!opts?.context && c.state !== 'running') c.resume().catch(() => { /* retried on next gesture */ });
                // The samples load after the game is playable: a moment after the first unlock, a few at a time.
                const base = (import.meta.env?.BASE_URL ?? './') + 'audio/';
                setTimeout(() => { void loadSamples(c, samples, base).finally(loadDone); }, opts?.loadDelayMs ?? 1500);
            } catch {
                loadDone();
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
            checkReloads(now, remotes);

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
                    oneShot(beepPos, BOMB_CFG, BEEP_GAIN, sampledBeep, 0, false, BEEP_PRIORITY);
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
                const ddx = h[0] - lpos[0], ddy = h[1] - lpos[1], ddz = h[2] - lpos[2];
                const level = breathDistanceGain(Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz));
                if (!b.occInit) b.dist.gain.value = level; // a new emitter starts at its level (the fade-in covers it)
                else b.dist.gain.setTargetAtTime(level, now, BREATH_GAIN_SMOOTH);

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
                if (b.nextBreath < now + 0.25) {
                    // Recorded breaths when both recordings are loaded (and not switched off); else the synthesised cycle.
                    if (samples.usable(BREATH_SETS) && samples.mode.real) scheduleRecordedBreath(b, b.nextBreath);
                    else scheduleBreath(b, b.nextBreath);
                }
            }
        },

        step(pos: Vec3, loud: number, isLocal: boolean): void {
            const l = Math.min(1, Math.max(0, loud));
            if (l <= 0) return;
            stepMode = true;
            try { stepSound(pos, l, isLocal); } finally { stepMode = false; }
        },

        gunshot(pos: Vec3, isLocal: boolean, weapon: number, suppressed: boolean): void {
            const snd = SLOT_SOUNDS[slotOf(weapon)];
            if (suppressed) oneShot(isLocal ? null : pos, GUN_CFG, isLocal ? 0.7 : 1, snd.shot, 0, false);
            else oneShot(isLocal ? null : pos, LOUD_GUN_CFG, isLocal ? 0.7 : 1, snd.loud, 0, false, 2);
        },

        weaponSwitch(weapon: number): void {
            // The knife: the light holster sound, over its own draw time.
            if (weapon === SLOT_KNIFE) {
                oneShot(null, CUE_CFG, 0.4, sampledSwitch, DEFENDER_KNIFE.drawTicks / TICK_RATE, true, 1, 'knife');
                return;
            }
            const s = slotOf(weapon);
            oneShot(null, CUE_CFG, 0.4, sampledSwitch, WEAPONS[s].drawTicks / TICK_RATE, WEAPONS[s].id === 'pistol', 1, WEAPONS[s].id);
        },

        reload(pos: Vec3, isLocal: boolean, weapon: number, id: number, empty = false): void {
            if (!ctx) return;
            const slot = slotOf(weapon);
            const synth = SLOT_SOUNDS[slot].reload;
            // A new reload by the same player means the old one ended: cut whatever is left of it.
            for (let i = reloads.length - 1; i >= 0; i--) if (reloads[i].id === id) endReload(i, ctx.currentTime, true);
            let v: Voice | null;
            if (isLocal) v = oneShot(null, RELOAD_CFG, 0.45, synth, 0, empty);
            else {
                // The event carries the feet position: the magazine is worked at about hand height.
                reloadPos[0] = pos[0]; reloadPos[1] = pos[1] + RELOAD_LIFT; reloadPos[2] = pos[2];
                v = oneShot(reloadPos, RELOAD_CFG, 1, synth, 0, empty);
            }
            const ticks = empty ? WEAPONS[slot].reloadEmptyTicks : WEAPONS[slot].reloadTicks;
            if (v) reloads.push({ id, local: isLocal, voice: v, start: v.start, dur: ticks / TICK_RATE, seen: false });
        },

        cancelReload(id: number): void {
            if (!ctx) return;
            for (let i = reloads.length - 1; i >= 0; i--) if (reloads[i].id === id) endReload(i, ctx.currentTime, true);
        },

        dryFire(): void {
            oneShot(null, CUE_CFG, 0.5, sampledDry, 0, false);
        },

        impact(pos: Vec3): void {
            // The surface is the box face the bullet ended on (no face: a player or the range's end, played as concrete).
            const surf = faceAt(boxes, pos, faceScratch) ? faceScratch.surface : 'concrete';
            oneShot(pos, IMPACT_CFG, 0.8, sampledImpact, 0, false, 1, surf);
        },

        knifeWindup(pos: Vec3, isLocal: boolean): void {
            oneShot(isLocal ? null : pos, KNIFE_CFG, isLocal ? 0.45 : 1, sampledWindup, 0, false);
        },

        knifeSlash(pos: Vec3, hit: boolean, isLocal: boolean): void {
            oneShot(isLocal ? null : pos, KNIFE_CFG, isLocal ? 0.6 : 1, sampledSlash, 0, hit);
        },

        hitMarker(kind: 'body' | 'head' | 'kill'): void {
            oneShot(null, CUE_CFG, 0.55, kind === 'kill' ? sampledHitKill : kind === 'head' ? sampledHitHead : sampledHitBody,
                kind === 'kill' ? 1 : 0, kind === 'head');
        },

        uiClick(): void {
            oneShot(null, CUE_CFG, 0.35, sampledUi, 0, false);
        },

        whenLoaded(): Promise<void> {
            return loadedPromise;
        },

        sampleStatus(): { loaded: number; total: number } {
            return { loaded: samples.loaded, total: samples.total };
        },

        setSoundMode(mode: Partial<SoundMode>): void {
            if (mode.recorded !== undefined) samples.mode.recorded = mode.recorded;
            if (mode.gunLayer !== undefined) samples.mode.gunLayer = mode.gunLayer;
            if (mode.real !== undefined) samples.mode.real = mode.real;
        },

        setVolumes(v: { master: number; effects: number; footsteps: number }): void {
            volMaster = Math.min(1, Math.max(0, v.master));
            volEffects = Math.min(1, Math.max(0, v.effects));
            volSteps = Math.min(1, Math.max(0, v.footsteps));
            if (master) master.gain.value = MASTER_GAIN * volMaster;
        },

        hurt(): void {
            oneShot(null, STEP_CFG, 0.9, synthHurt, 0, false);
        },

        armorHit(): void {
            // The recorded metal impact (package H's samples), as if struck on the plate the player wears.
            oneShot(null, CUE_CFG, 0.6, sampledImpact, 0, false, 1, 'metal');
        },

        bomb(kind: 'drop' | 'pickup', pos: Vec3, isLocal: boolean): void {
            oneShot(isLocal ? null : pos, BOMB_HANDLE_CFG, isLocal ? 0.5 : 1, kind === 'drop' ? sampledDrop : sampledPickup, 0, false);
        },

        cue(kind: CueKind): void {
            const c = CUES[kind];
            if (c) oneShot(null, CUE_CFG, c.gain, c.synth, 0, false, CUE_PRIORITY);
        },
    };
};
