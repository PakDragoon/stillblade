import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Box } from '@shared/types';
import {
    DEFAULT_SOUND_MODE, RELOAD_CUES, SAMPLE_EXT, SAMPLE_SETS, allSampleFiles, pickVariant, sampleFiles, stepVariation,
    surfaceUnder, useRecorded, varied
} from './audio-logic';
import { breathDistanceGain } from './audio';

describe('sample manifest', () => {
    it('names variants set_1 .. set_n', () => {
        expect(sampleFiles('step_wood')).toEqual(['step_wood_1.mp3', 'step_wood_2.mp3', 'step_wood_3.mp3', 'step_wood_4.mp3']);
        expect(sampleFiles('nothing')).toEqual([]);
        expect(SAMPLE_EXT).toBe('mp3');
    });
    it('lists every file once', () => {
        const all = allSampleFiles();
        expect(new Set(all).size).toBe(all.length);
        expect(all.length).toBe(Object.values(SAMPLE_SETS).reduce((a, b) => a + b, 0));
    });
    it('has the sets the engine asks for (footsteps and impacts per surface, every reload part)', () => {
        for (const s of ['concrete', 'metal', 'wood']) {
            expect(SAMPLE_SETS[`step_${s}`]).toBeGreaterThanOrEqual(3);
            expect(SAMPLE_SETS[`impact_${s}`]).toBeGreaterThanOrEqual(2);
        }
        for (const k of Object.values(RELOAD_CUES)) for (const p of k.parts) expect(SAMPLE_SETS[p]).toBeGreaterThan(0);
    });
    it('matches the processing map (tools/audio-map.json) exactly', () => {
        const map = JSON.parse(readFileSync('tools/audio-map.json', 'utf8')) as Record<string, { n: number }>;
        const mapped = Object.keys(map).filter(k => !k.startsWith('_')).sort();
        expect(mapped).toEqual(Object.keys(SAMPLE_SETS).sort());
        for (const k of mapped) expect(map[k].n).toBe(SAMPLE_SETS[k]);
    });
    it('keeps the reload cues at the animation times', () => {
        expect(RELOAD_CUES.rifle.times).toEqual([0.3, 1.4, 1.9]);
        expect(RELOAD_CUES.pistol.times).toEqual([0.15, 0.7, 1.0]);
    });
});

describe('pickVariant', () => {
    it('returns -1 when nothing is loaded (play the synthesised sound)', () => {
        expect(pickVariant([null, null, undefined], 0.5, -1)).toBe(-1);
        expect(pickVariant([], 0.5, -1)).toBe(-1);
    });
    it('only picks loaded variants', () => {
        for (let r = 0; r < 1; r += 0.05) expect([1, 3]).toContain(pickVariant([null, 'a', null, 'b'], r, -1));
    });
    it('never repeats the last variant while another is loaded', () => {
        for (let last = 0; last < 4; last++) {
            for (let r = 0; r < 1; r += 0.05) expect(pickVariant(['a', 'b', 'c', 'd'], r, last)).not.toBe(last);
        }
    });
    it('repeats the last one when it is the only one loaded', () => {
        expect(pickVariant([null, 'a', null], 0.9, 1)).toBe(1);
    });
    it('reaches every variant across the range of r', () => {
        const seen = new Set<number>();
        for (let r = 0; r < 1; r += 0.01) seen.add(pickVariant(['a', 'b', 'c'], r, -1));
        expect([...seen].sort()).toEqual([0, 1, 2]);
    });
    it('copes with r outside [0, 1)', () => {
        expect(pickVariant(['a', 'b'], 1, -1)).toBe(1);
        expect(pickVariant(['a', 'b'], -3, -1)).toBe(0);
    });
});

describe('fallback rule', () => {
    const loaded = (have: readonly string[]) => (s: string) => have.includes(s);
    it('plays recorded only when every part is loaded', () => {
        const parts = RELOAD_CUES.rifle.parts;
        expect(useRecorded(DEFAULT_SOUND_MODE, loaded(parts), parts)).toBe(true);
        expect(useRecorded(DEFAULT_SOUND_MODE, loaded([parts[0], parts[1]]), parts)).toBe(false);
        expect(useRecorded(DEFAULT_SOUND_MODE, loaded([]), parts)).toBe(false);
    });
    it('plays synthesised when recorded sounds are switched off, however much is loaded', () => {
        expect(useRecorded({ recorded: false, gunLayer: true }, () => true, ['dry'])).toBe(false);
    });
    it('treats an empty parts list as usable (nothing missing)', () => {
        expect(useRecorded(DEFAULT_SOUND_MODE, () => false, [])).toBe(true);
    });
});

describe('step level and pitch', () => {
    it('is loudest running and quietest crouched', () => {
        const run = stepVariation(1, 0.5, 0.5), walk = stepVariation(0.3, 0.5, 0.5), crouch = stepVariation(0.18, 0.5, 0.5);
        expect(run.gain).toBeGreaterThan(walk.gain);
        expect(walk.gain).toBeGreaterThan(crouch.gain);
        expect(run.rate).toBeCloseTo(1, 5);
        expect(crouch.rate).toBeLessThan(walk.rate);
    });
    it('varies by a bounded amount', () => {
        const lo = stepVariation(1, 0, 0), hi = stepVariation(1, 1, 1);
        expect(20 * Math.log10(hi.gain / lo.gain)).toBeLessThan(3.5);
        expect(hi.rate / lo.rate).toBeLessThan(1.14);
        expect(varied(0.1, 0.5)).toBe(1);
    });
    it('clamps loudness to 0..1', () => {
        expect(stepVariation(5, 0.5, 0.5).gain).toBeCloseTo(stepVariation(1, 0.5, 0.5).gain, 6);
    });
});

describe('surfaceUnder', () => {
    const boxes: Box[] = [
        { category: 'outer_wall', min: [-50, -1, -50], max: [50, 0, 50] },
        { category: 'crate', min: [0, 0, 0], max: [2, 1, 2] },
        { category: 'platform', min: [10, 0, 10], max: [14, 3, 14] },
    ];
    it('finds the box whose top the feet stand on', () => {
        expect(surfaceUnder(boxes, [5, 0, 5])).toBe('concrete');
        expect(surfaceUnder(boxes, [1, 1, 1])).toBe('wood');
        expect(surfaceUnder(boxes, [12, 3, 12])).toBe('metal');
    });
    it('is concrete where there is no box, or the box is far above or below', () => {
        expect(surfaceUnder(boxes, [100, 0, 100])).toBe('concrete');
        expect(surfaceUnder([boxes[2]], [12, 0, 12])).toBe('concrete');
        expect(surfaceUnder([], [0, 0, 0])).toBe('concrete');
    });
    it('prefers the highest top in reach', () => {
        expect(surfaceUnder([boxes[0], { category: 'crate', min: [-1, 0, -1], max: [1, 0.1, 1] }], [0, 0.05, 0])).toBe('wood');
    });
});

describe('breathing distance curve is unchanged', () => {
    it('is flat inside 2.5 m, silent at 8 m, never rising with distance', () => {
        expect(breathDistanceGain(0.5)).toBeCloseTo(0.32, 6);
        expect(breathDistanceGain(2.5)).toBeCloseTo(0.32, 6);
        expect(breathDistanceGain(8)).toBe(0);
        expect(breathDistanceGain(30)).toBe(0);
        let prev = Infinity;
        for (let d = 0; d <= 8.5; d += 0.1) { const g = breathDistanceGain(d); expect(g).toBeLessThanOrEqual(prev + 1e-9); prev = g; }
    });
    it('meets the old curve at 6 m and 7 m', () => {
        expect(breathDistanceGain(6)).toBeCloseTo(1 - (6 - 0.8) / (8 - 0.8), 6);
        expect(breathDistanceGain(7)).toBeCloseTo(1 - (7 - 0.8) / (8 - 0.8), 6);
    });
});
