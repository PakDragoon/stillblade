/**
 * The pure rules of the recorded-sound layer (package H), kept apart from Web Audio so they can be tested:
 * the sample manifest, which variant to play, whether a sound may use samples at all (the fallback rule), the
 * surface under a footstep, and the loudness and pitch of a step. Presentation only: ordinary randomness is fine
 * here, and nothing in `shared/` depends on any of it.
 */
import type { Box, Vec3 } from '@shared/types';
import { surfaceOf, type Surface } from './effects';

/** Shipped files are mono MP3: every current browser decodes it (Ogg Vorbis only arrived in Safari 18.4). */
export const SAMPLE_EXT = 'mp3';

/**
 * Every recorded sound set and how many variants it has. The variants of set `s` are `s_1` ... `s_n` (file
 * `s_1.mp3`). `tools/audio-map.mjs` must name exactly these (a test checks it). A set with nothing loaded falls
 * back to the synthesised sound, so this list is also the list of what may be missing.
 */
export const SAMPLE_SETS: Readonly<Record<string, number>> = {
    step_concrete: 4, step_metal: 4, step_wood: 4,
    impact_concrete: 3, impact_metal: 3, impact_wood: 3,
    // Package H's thump layers (kept for the old-versus-new comparison on the sound test page and as the layer of
    // the synthesised shot when a recording is missing).
    thump_rifle_loud: 2, thump_pistol_loud: 2, thump_rifle_supp: 1, thump_pistol_supp: 1,
    // Package N: real gunshots (close recordings, a distant tail, suppressed versions derived from them) and the
    // ghost's recorded breaths, cut one breath cycle per file.
    shot_rifle_loud: 5, shot_rifle_far: 2, shot_rifle_supp: 2,
    shot_pistol_loud: 2, shot_pistol_far: 1, shot_pistol_supp: 2,
    breath_calm: 4, breath_hard: 3,
    reload_rifle_out: 1, reload_rifle_in: 1, reload_rifle_bolt: 1,
    reload_pistol_out: 1, reload_pistol_in: 1, reload_pistol_slide: 1,
    knife_windup: 1, knife_slash: 2, knife_hit: 2,
    bomb_beep: 1, bomb_planted: 1, bomb_defused: 1, bomb_drop: 1, bomb_pickup: 1, explosion: 1,
    hit_body: 1, hit_head: 1, hit_kill: 1, dry: 1,
    switch_rifle: 1, switch_pistol: 1, switch_knife: 1, ui_click: 2
};

/**
 * Level of each set relative to the synthesised sound it replaces or layers over (1 when absent). The files are
 * peak-normalised by `tools/process-audio.mjs`, so these are the only knobs for the mix; they are untuned until
 * the packs exist and someone has listened (HANDOFF.md, Package H).
 */
export const SAMPLE_GAIN: Readonly<Record<string, number>> = {
    // Measured (tools/sound-check.mjs, 2026-11-17) against the synthesised sound each one replaces or layers over:
    // the gun layers would otherwise add 5 to 10 dB (a suppressed shot must stay quiet), bullet impacts were 14 dB
    // hotter than the synthesised ones (footsteps must stay the loudest thing a defender listens for), the knife
    // windup is the defender's warning and came out 4.6 dB quieter, reloads are meant to be quiet.
    thump_rifle_loud: 0.65, thump_pistol_loud: 0.65, thump_rifle_supp: 0.3, thump_pistol_supp: 0.25,
    // Package N, set from tools/sound-check.mjs measurements (nobody has listened): the recorded shot is the whole
    // gunshot now, so these are the loudness of the shot itself.
    shot_rifle_loud: 2.0, shot_rifle_far: 0.5, shot_rifle_supp: 0.48,
    // Pistol: real Makarov and Glock recordings since 2026-11-18 (the AK stand-in needed 2.7 / 0.65): set to sit about
    // 2 dB under the rifle up close, measured with tools/sound-check.mjs, not listened to.
    shot_pistol_loud: 0.6, shot_pistol_far: 0.8, shot_pistol_supp: 0.13,
    breath_calm: 0.45, breath_hard: 0.9,
    impact_concrete: 0.4, impact_metal: 0.4, impact_wood: 0.4,
    knife_windup: 1.4,
    reload_rifle_out: 0.8, reload_rifle_in: 0.8, reload_rifle_bolt: 0.8,
    reload_pistol_out: 0.8, reload_pistol_in: 0.8, reload_pistol_slide: 0.8
};

/** File names (no folder) of every variant of a set. */
export function sampleFiles(set: string): string[] {
    const n = SAMPLE_SETS[set] ?? 0;
    const out: string[] = [];
    for (let i = 1; i <= n; i++) out.push(`${set}_${i}.${SAMPLE_EXT}`);
    return out;
}

/** Every file the client may load. */
export function allSampleFiles(): string[] {
    const out: string[] = [];
    for (const set of Object.keys(SAMPLE_SETS)) out.push(...sampleFiles(set));
    return out;
}

/** Player choices on the sound test page (and nothing else): recorded samples on or off, the gunshot layer on or off. */
export interface SoundMode {
    /** False plays only the synthesised sounds (for comparison). */
    recorded: boolean;
    /** Gunshots: the recorded layer over the synthesised shot. False is the pure synthesised shot. */
    gunLayer: boolean;
    /**
     * Package N: gunshots and ghost breathing from the real recordings. False plays package H's sounds instead
     * (the synthesised shot under a recorded thump, the synthesised breathing), for comparison.
     */
    real: boolean;
}

export const DEFAULT_SOUND_MODE: Readonly<SoundMode> = { recorded: true, gunLayer: true, real: true };

/**
 * Index of the variant to play from `items` (entries not loaded are null/undefined), or -1 when none is loaded,
 * which means "use the synthesised sound". `r` is a random number in [0, 1). The variant used last time (`last`)
 * is skipped when another is loaded, so a repeated sound is never the same file twice in a row.
 */
export function pickVariant<T>(items: readonly (T | null | undefined)[], r: number, last: number): number {
    let n = 0;
    for (let i = 0; i < items.length; i++) if (items[i] != null && i !== last) n++;
    if (n === 0) {
        // Only the last one is loaded (or nothing is).
        return last >= 0 && last < items.length && items[last] != null ? last : -1;
    }
    let k = Math.min(n - 1, Math.floor(Math.min(0.999999, Math.max(0, r)) * n));
    for (let i = 0; i < items.length; i++) {
        if (items[i] == null || i === last) continue;
        if (k-- === 0) return i;
    }
    return -1;
}

/**
 * The fallback rule for a sound made of several recorded parts (a reload is three): it plays from samples only
 * when recorded sounds are on and EVERY part has at least one variant loaded; otherwise the whole synthesised
 * sound plays, so a reload never comes out half recorded and half synthetic.
 */
export function useRecorded(mode: SoundMode, loaded: (set: string) => boolean, parts: readonly string[]): boolean {
    if (!mode.recorded) return false;
    for (let i = 0; i < parts.length; i++) if (!loaded(parts[i])) return false;
    return true;
}

/** Amplitude factor for a pitch ratio or gain varied by +-`amount` (a fraction) from `r` in [0, 1). */
export function varied(amount: number, r: number): number {
    return 1 + (r * 2 - 1) * amount;
}

/**
 * Level and playback rate of a footstep sample. `loud` is 0..1 (1 running, 0.3 walking, 0.18 crouched, as the
 * synthesised step uses it). A run is full level at a normal pitch; walking and crouching are quieter, and
 * crouching plays a little slower and lower (a soft, careful tread). `r1` and `r2` in [0, 1) vary level (+-1.5 dB)
 * and pitch (+-6 %) so no two steps are the same.
 */
export function stepVariation(loud: number, r1: number, r2: number): { gain: number; rate: number } {
    const l = Math.min(1, Math.max(0, loud));
    const gain = (0.45 + 0.55 * l) * varied(0.17, r1);
    const rate = (0.88 + 0.12 * Math.min(1, l / 0.5)) * varied(0.06, r2);
    return { gain, rate };
}

/**
 * The surface a footstep at `pos` (feet) is made on: the box whose top face is within 0.25 m of the feet and
 * whose footprint contains them (the highest such top wins), by the box's category as package G's impacts use
 * (`surfaceOf`). Concrete when no box is found (the ground may not be a box).
 */
export function surfaceUnder(boxes: readonly Box[], pos: Readonly<Vec3>): Surface {
    let best = -Infinity;
    let found: Box | null = null;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const top = b.max[1];
        if (Math.abs(top - pos[1]) > 0.25) continue;
        if (pos[0] < b.min[0] - 0.05 || pos[0] > b.max[0] + 0.05 || pos[2] < b.min[2] - 0.05 || pos[2] > b.max[2] + 0.05) continue;
        if (top > best) { best = top; found = b; }
    }
    return found ? surfaceOf(found.category) : 'concrete';
}

/**
 * Reload cue times in seconds from the start, matching the first-person clips and the synthesised reloads. The rifle's
 * (package R) come from the downloaded animation pack retargeted onto the AK (tools/blender/viewmodel.py logs them as
 * "pack cues"): the tactical reload (2.2 s) takes the magazine out at 0.71 s and seats the new one at 1.55 s, with a
 * round still chambered, so no bolt; the empty reload (2.7 s, `reloadEmptyTicks`) takes it out at 0.74 s, seats it at
 * 1.63 s and pulls the charging handle at 1.94 s, which slams home `RELOAD_BOLT_SLAM` later (2.07 s).
 */
export const RELOAD_CUES = {
    rifle: { parts: ['reload_rifle_out', 'reload_rifle_in'], times: [0.71, 1.55] },
    rifle_empty: { parts: ['reload_rifle_out', 'reload_rifle_in', 'reload_rifle_bolt'], times: [0.74, 1.63, 1.94] },
    pistol: { parts: ['reload_pistol_out', 'reload_pistol_in', 'reload_pistol_slide'], times: [0.15, 0.7, 1.0] }
} as const;
/** Seconds from the charging handle's pull to the bolt slamming home in the rifle's empty reload (the synthesised one). */
export const RELOAD_BOLT_SLAM = 0.125;

/**
 * Package N: how a gunshot at distance `d` mixes the close recording and the distant tail (equal power, so the
 * loudness does not dip in the middle). Up to `CLOSE_UNTIL` m it is the close shot with a whisper of the tail; by
 * 80 % of the range (48 m for the loud rifle) it is the tail alone. The overall fade to silence at the range comes
 * from the voice's distance panner, not from here, so both layers reach silence exactly at `range`.
 */
export const GUN_CLOSE_UNTIL = 8;
export const GUN_FAR_FLOOR = 0.1;
export function gunBlend(d: number, range: number): { close: number; far: number } {
    const end = Math.max(GUN_CLOSE_UNTIL + 1, range * 0.8);
    const w = Math.min(1, Math.max(0, (d - GUN_CLOSE_UNTIL) / (end - GUN_CLOSE_UNTIL)));
    return { close: Math.cos(w * Math.PI / 2), far: Math.max(GUN_FAR_FLOOR, Math.sin(w * Math.PI / 2)) };
}

/**
 * Package N, recorded ghost breathing. A calm breath and an exerted one are separate recordings, each cut into
 * single breath cycles. Every cycle the next breath is chosen at random (never the one just played, per ghost);
 * the chance that it is an exerted one equals the ghost's exertion `e` (0..1), so a ghost that starts running turns
 * from calm to panting breath by breath rather than as two overlapping people, and the level, pace and pitch
 * move with `e` as well.
 */
export const BREATH_SETS = ['breath_calm', 'breath_hard'] as const;
export function pickBreathSet(e: number, r: number): 'breath_calm' | 'breath_hard' {
    return r < Math.min(1, Math.max(0, e)) ? 'breath_hard' : 'breath_calm';
}
/** Amplitude of a recorded breath: calm at rest, `BREATH_REC_EXERT` times that at full exertion. */
export const BREATH_REC_EXERT = 1.5;
export function breathLevel(e: number): number {
    return 1 + (BREATH_REC_EXERT - 1) * Math.min(1, Math.max(0, e));
}
/** Silence (s) after a recorded breath before the next starts; shorter when exerted. `r` in [0, 1). */
export function breathGap(e: number, r: number): number {
    return (0.45 - 0.35 * Math.min(1, Math.max(0, e))) * varied(0.35, r);
}
/** Playback rate of a recorded breath: a little faster when exerted, with +-4 % variation from `r` in [0, 1). */
export function breathRate(e: number, r: number): number {
    return (1 + 0.08 * Math.min(1, Math.max(0, e))) * varied(0.04, r);
}
