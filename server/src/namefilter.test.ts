import { describe, expect, it } from 'vitest';
import { FILTERED_NAME, chooseName, cleanName, createWordFilter, isSystemName, maskChat, wordFilter } from './namefilter';

describe('word filter mechanics (neutral test words)', () => {
    const f = createWordFilter(['blorpish'], ['blorp']);

    it('matches look-alikes, repeats, separators and case', () => {
        for (const t of ['blorp', 'BLORP', 'bl0rp', 'b1orp', 'bbbloooorrrp', 'b.l.o.r.p', 'b l o r p', 'b-l_o r p', 'say blorp now']) {
            expect(f.matches(t), t).toBe(true);
        }
    });

    it('whole-word entries leave longer ordinary words alone', () => {
        for (const t of ['blorpy', 'reblorp', 'xblorpx', 'blorping', 'a blorper']) expect(f.matches(t), t).toBe(false);
    });

    it('anywhere entries are caught inside a longer string', () => {
        expect(f.matches('xxblorpishxx')).toBe(true);
        expect(f.matches('blorpishness')).toBe(true);
    });

    it('masks with asterisks of the same length and keeps everything else', () => {
        expect(f.mask('hey blorp you')).toBe('hey ***** you');
        expect(f.mask('b l o r p!')).toBe('*********!');
        expect(f.mask('BLORP blorp')).toBe('***** *****');
        expect(f.mask('nothing here')).toBe('nothing here');
    });

    it('does not take long to scan a long run of one letter', () => {
        const start = performance.now();
        wordFilter.matches('s'.repeat(120));
        wordFilter.mask('a '.repeat(60));
        expect(performance.now() - start).toBeLessThan(200);
    });
});

describe('the built-in list', () => {
    it('catches a slur and its common evasions', () => {
        for (const t of ['nigger', 'N1GG3R', 'n.i.g.g.e.r', 'niiiigger', 'n i g g e r', 'xxniggerxx', 'faggot', 'f4gg0t']) {
            expect(wordFilter.matches(t), t).toBe(true);
        }
        expect(wordFilter.matches('fag')).toBe(true);
        expect(wordFilter.matches('you cunt')).toBe(true);
    });

    it('leaves ordinary words that merely contain a blocked string alone', () => {
        for (const t of ['Scunthorpe', 'class', 'assassin', 'niggardly', 'raccoon', 'fagin', 'Mike', 'retardant', 'dykes', 'bypass', 'Chinkapin']) {
            // "dykes" is deliberately on the list as a whole word; everything else here is an ordinary word.
            if (t === 'dykes') continue;
            expect(wordFilter.matches(t), t).toBe(false);
        }
        expect(wordFilter.matches('I like the game, good luck everyone')).toBe(false);
    });

    it('masks chat without dropping it', () => {
        expect(maskChat('you cunt, gg')).toBe('you ****, gg');
        expect(maskChat('plain text stays')).toBe('plain text stays');
        expect(maskChat('')).toBe('');
    });
});

describe('player names', () => {
    it('cleans odd characters and cuts to 16', () => {
        expect(cleanName('  Sam<script>  ')).toBe('Samscript');
        expect(cleanName('abcdefghijklmnopqrstuvwxyz')).toHaveLength(16);
    });

    it('turns a filtered name into Player', () => {
        expect(chooseName('n1gger', [])).toBe(FILTERED_NAME);
        expect(chooseName('Fine', [])).toBe('Fine');
        // The characters stripped from the typed name still count when checking what was typed.
        expect(cleanName('n!gger')).toBe('ngger');
        expect(chooseName('ngger', [], 'n!gger')).toBe(FILTERED_NAME);
        expect(chooseName('ngger', [])).toBe('ngger');
        expect(chooseName(cleanName('c.u.n.t'), [], 'c.u.n.t')).toBe(FILTERED_NAME);
    });

    it('refuses the system names and their variants', () => {
        for (const n of ['Server', 'SERVER', 'Admin', 'adm1n', 'Adm!n', 'Admin2', 'S e r v e r', 'System', 'Stillblade', 'StillBlade 7', 'Servr', 'moderator', 'Administrater']) {
            expect(isSystemName(n), n).toBe(true);
            expect(chooseName(n, [])).toBe(FILTERED_NAME);
        }
        for (const n of ['Sam', 'Serge', 'Administration Fan', 'Still', 'Blade', 'Adam', 'Systems Check']) expect(isSystemName(n), n).toBe(false);
    });

    it('numbers duplicates, ignoring case, and numbers filtered names too', () => {
        expect(chooseName('Sam', ['Sam'])).toBe('Sam (2)');
        expect(chooseName('sam', ['Sam', 'Sam (2)'])).toBe('sam (3)');
        expect(chooseName('Sam', ['Sam (2)'])).toBe('Sam');
        expect(chooseName('Admin', [FILTERED_NAME])).toBe('Player (2)');
        expect(chooseName('abcdefghijklmnop', ['abcdefghijklmnop'])).toHaveLength(16);
        expect(chooseName('abcdefghijklmnop', ['abcdefghijklmnop'])).toMatch(/\(2\)$/);
    });

    it('leaves an empty name empty so the caller can number it', () => {
        expect(chooseName('', [])).toBe('');
    });
});
