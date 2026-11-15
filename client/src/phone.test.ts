import { describe, expect, it } from 'vitest';
import { isTouchOnly, type MediaQuery } from './phone';
import { reportUrl } from './report';

const media = (map: Record<string, boolean>): MediaQuery => q => ({ matches: map[q] ?? false });

describe('phone detection', () => {
    it('is true only for a coarse pointer that cannot hover', () => {
        expect(isTouchOnly(media({ '(pointer: coarse)': true, '(hover: none)': true }))).toBe(true);
        expect(isTouchOnly(media({ '(pointer: coarse)': true, '(hover: none)': false }))).toBe(false); // touch laptop with a trackpad
        expect(isTouchOnly(media({ '(pointer: coarse)': false, '(hover: none)': true }))).toBe(false);
        expect(isTouchOnly(media({}))).toBe(false);
    });
    it('is false when matchMedia is missing or throws', () => {
        expect(isTouchOnly(undefined)).toBe(false);
        expect(isTouchOnly(() => { throw new Error('no'); })).toBe(false);
    });
});

describe('report address', () => {
    it('turns the socket address into the HTTP route', () => {
        expect(reportUrl('wss://stillblade-server.example.com')).toBe('https://stillblade-server.example.com/report');
        expect(reportUrl('ws://localhost:8080/')).toBe('http://localhost:8080/report');
    });
});
