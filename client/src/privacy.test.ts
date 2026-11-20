import { describe, expect, it } from 'vitest';
import { MATCH_KEEP_MONTHS, PRIVACY_SECTIONS, RECORD_KEEP_DAYS, RECORD_MAX_MB } from '@shared/privacy';
import { PAGE_PARENT, PageNav } from './menu-logic';

describe('package W: the privacy page', () => {
    const text = PRIVACY_SECTIONS.flatMap(s => [s.title, ...s.lines]).join('\n');
    it('states the limits the server uses by default', () => {
        expect(text).toContain(`${RECORD_KEEP_DAYS} days`);
        expect(text).toContain(`${MATCH_KEEP_MONTHS} months`);
        expect(text).toContain(`${RECORD_MAX_MB / 1000} GB`);
    });
    it('says what is and is not kept', () => {
        for (const w of ['name', 'Feedback', 'error reports', 'graphics card', 'IP address', 'Chat is not recorded']) expect(text).toContain(w);
    });
    it('opens from the home page and goes back to it', () => {
        expect(PAGE_PARENT.privacy).toBe('home');
        const nav = new PageNav('home');
        nav.go('privacy');
        expect(nav.back()).toBe(true);
        expect(nav.page).toBe('home');
    });
});
