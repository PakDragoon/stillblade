import { describe, expect, it } from 'vitest';
import { resolveTier, tierFromFrameTimes, tierFromRenderer, urlTier } from './graphics';
import { parseQuality } from './settings';
import { faceAt, surfaceOf } from './effects';
import type { Box } from '@shared/types';

describe('graphics tier', () => {
    it('reads ?tier= from the address', () => {
        expect(urlTier('?tier=low')).toBe('low');
        expect(urlTier('?auto=1&tier=high')).toBe('high');
        expect(urlTier('?tier=ultra')).toBeNull();
        expect(urlTier('')).toBeNull();
    });

    it('puts integrated and software renderers on Low and known cards on High', () => {
        expect(tierFromRenderer('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('low');
        expect(tierFromRenderer('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('low');
        expect(tierFromRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).toBe('low');
        expect(tierFromRenderer('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('low');
        expect(tierFromRenderer('Mali-G78')).toBe('low');
        expect(tierFromRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
        expect(tierFromRenderer('ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
        expect(tierFromRenderer('ANGLE (Intel, Intel(R) Arc(TM) A750 Graphics Direct3D11)')).toBe('high');
        // A low-end mobile GeForce or an unknown chip: measure instead.
        expect(tierFromRenderer('ANGLE (NVIDIA, NVIDIA GeForce MX250 Direct3D11)')).toBeNull();
        expect(tierFromRenderer('Apple M2')).toBeNull();
        expect(tierFromRenderer('')).toBeNull();
    });

    it('picks High only when the loaded frames held 60 FPS', () => {
        const fast = Array.from({ length: 120 }, () => 1 / 60);
        const slow = Array.from({ length: 60 }, () => 1 / 40);
        const jittery = Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? 0.03 : 1 / 60));
        expect(tierFromFrameTimes(fast)).toBe('high');
        expect(tierFromFrameTimes(slow)).toBe('low');
        expect(tierFromFrameTimes(jittery)).toBe('low');
        expect(tierFromFrameTimes(fast.slice(0, 10))).toBe('low');   // too few frames: unsure, so Low
    });

    it('lets the address win, then the setting, then the measurement, else Low', () => {
        expect(resolveTier('high', 'low', 'low')).toBe('high');
        expect(resolveTier(null, 'high', 'low')).toBe('high');
        expect(resolveTier(null, 'auto', 'high')).toBe('high');
        expect(resolveTier(null, 'auto', null)).toBe('low');
    });

    it('migrates the old quality setting', () => {
        expect(parseQuality('low')).toBe('low');
        expect(parseQuality('medium')).toBe('low');
        expect(parseQuality('high')).toBe('auto');   // the old default
        expect(parseQuality('gpu')).toBe('gpu');
        expect(parseQuality('auto')).toBe('auto');
        expect(parseQuality(undefined)).toBe('auto');
    });
});

describe('effects surfaces', () => {
    const boxes: Box[] = [
        { name: 'floor', category: 'floor', min: [-5, -1, -5], max: [5, 0, 5] },
        { name: 'crate', category: 'crate', min: [0, 0, 0], max: [1, 1, 1] },
        { name: 'step', category: 'stairs', min: [3, 0, 3], max: [4, 0.25, 4] }
    ];
    const out = { axis: -1, sign: 0, surface: 'concrete' as ReturnType<typeof surfaceOf> };

    it('names the surface by category', () => {
        expect(surfaceOf('crate')).toBe('wood');
        expect(surfaceOf('stairs')).toBe('metal');
        expect(surfaceOf('outer_wall')).toBe('concrete');
        expect(surfaceOf(undefined)).toBe('concrete');
    });

    it('finds the face a point lies on', () => {
        expect(faceAt(boxes, [2, 0, 2], out)).toBe(true);
        expect(out).toEqual({ axis: 1, sign: 1, surface: 'concrete' });
        expect(faceAt(boxes, [1, 0.5, 0.5], out)).toBe(true);
        expect(out).toEqual({ axis: 0, sign: 1, surface: 'wood' });
        expect(faceAt(boxes, [3.5, 0.25, 3.5], out)).toBe(true);
        expect(out.surface).toBe('metal');
    });

    it('finds no face for a point in the air (a player or the end of the range)', () => {
        expect(faceAt(boxes, [2, 1.2, 2], out)).toBe(false);
        expect(faceAt(boxes, [40, 3, 40], out)).toBe(false);
    });
});
