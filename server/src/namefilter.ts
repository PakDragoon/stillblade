/**
 * Player names and chat text: the word filter, the reserved system names and duplicate numbering.
 * Pure functions, no sockets; tested in namefilter.test.ts.
 *
 * To extend the filter, add words to BLOCKED_ANYWHERE or BLOCKED_WORDS below (lower case, letters
 * only). Matching ignores case, common look-alike characters (n1gg3r), repeated letters (niiigger)
 * and a little punctuation or a space between letters (n.i.g.g.e.r).
 *  - BLOCKED_ANYWHERE: long, unambiguous words, caught even inside a longer string ("xxwordxx").
 *  - BLOCKED_WORDS: caught only as a whole word, so ordinary words that merely contain them
 *    ("Scunthorpe", "class", "niggardly") are left alone. Put plurals in explicitly.
 * The list is deliberately small: slurs and the obvious evasions, not every rude word.
 */
const BLOCKED_ANYWHERE: readonly string[] = ['nigger', 'faggot', 'wetback'];
const BLOCKED_WORDS: readonly string[] = [
    'nigga', 'niggas', 'fag', 'fags', 'kike', 'kikes', 'chink', 'chinks', 'spic', 'spics', 'gook', 'gooks', 'paki', 'pakis',
    'beaner', 'beaners', 'tranny', 'trannies', 'dyke', 'dykes', 'coon', 'coons', 'retard', 'retards', 'retarded', 'cunt', 'cunts'
];

/** Look-alike characters accepted for a letter (besides the letter itself). */
const LOOKALIKES: Readonly<Record<string, string>> = {
    a: '@4', b: '8', e: '3', g: '9', i: '1!|', l: '1|', o: '0', s: '$5', t: '7+', z: '2'
};
const WORD_CHAR = '[\\p{L}\\p{N}]';
/** Between two letters of a word: nothing, or one or two characters that are not letters or digits (space, dot, dash...). */
const SEPARATOR = '[^\\p{L}\\p{N}]{0,2}';

function escapeClass(chars: string): string {
    return chars.replace(/[\\\]^-]/g, '\\$&');
}

function wordPattern(word: string, wholeWord: boolean): RegExp {
    const body = [...word].map(c => {
        const alt = LOOKALIKES[c] ?? '';
        return `[${c}${escapeClass(alt)}]+`;
    }).join(SEPARATOR);
    return new RegExp(wholeWord ? `(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})` : body, 'giu');
}

export interface WordFilter {
    /** Whether `text` contains a blocked word. */
    matches(text: string): boolean;
    /** `text` with each blocked word replaced by asterisks of the same length. */
    mask(text: string): string;
}

export function createWordFilter(anywhere: readonly string[], wordsOnly: readonly string[]): WordFilter {
    const patterns = [...anywhere.map(w => wordPattern(w, false)), ...wordsOnly.map(w => wordPattern(w, true))];
    return {
        matches(text: string): boolean {
            for (const re of patterns) { re.lastIndex = 0; if (re.test(text)) return true; }
            return false;
        },
        mask(text: string): string {
            let out = text;
            for (const re of patterns) { re.lastIndex = 0; out = out.replace(re, m => '*'.repeat(m.length)); }
            return out;
        }
    };
}

export const wordFilter = createWordFilter(BLOCKED_ANYWHERE, BLOCKED_WORDS);

/** Chat: blocked words become asterisks, nothing else changes. Apply after `cleanChat`. */
export function maskChat(text: string): string {
    return wordFilter.mask(text);
}

/** Names nobody may pretend to be (the server, staff, the game). Matched after folding look-alikes and separators. */
export const SYSTEM_NAMES: readonly string[] = ['server', 'admin', 'administrator', 'system', 'stillblade', 'moderator', 'console', 'staff'];

/** Lower case, trailing digits dropped, look-alikes folded to letters, anything but letters removed, repeats collapsed. */
function fold(name: string): string {
    const noDigits = name.replace(/[\d\s]+$/u, '');
    const map: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '|': 'l' };
    let out = '';
    for (const c of noDigits.toLowerCase()) out += map[c] ?? c;
    return out.replace(/[^\p{L}]/gu, '').replace(/(.)\1+/gu, '$1');
}

function distanceAtMostOne(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i === a.length && i === b.length) return true;
    return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
}

/** "Server", "Adm1n", "S e r v e r 2", "Servr": anything that reads as a reserved name. */
export function isSystemName(name: string): boolean {
    const f = fold(name);
    if (f === '') return false;
    return SYSTEM_NAMES.some(s => {
        const folded = fold(s);
        return f === folded || (folded.length >= 5 && distanceAtMostOne(f, folded));
    });
}

export const FILTERED_NAME = 'Player';

/**
 * The name shown for a player who asked for `clean` (already stripped of odd characters and cut to
 * 16; `raw` is what was typed): a blocked or reserved name becomes "Player", and a name already taken in the room (compared
 * without regard to case) gets " (2)", " (3)"... The result is at most 16 characters.
 */
export function chooseName(clean: string, taken: Iterable<string>, raw = clean): string {
    // The raw text is checked too: stripping "@" or "$" from a name must not hide a look-alike spelling.
    const bad = (t: string): boolean => wordFilter.matches(t) || isSystemName(t);
    const base = clean === '' ? '' : bad(clean) || bad(raw) ? FILTERED_NAME : clean;
    if (base === '') return '';
    const used = new Set<string>();
    for (const n of taken) used.add(n.toLowerCase());
    if (!used.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
        const suffix = ` (${n})`;
        const shown = base.slice(0, 16 - suffix.length).trimEnd() + suffix;
        if (!used.has(shown.toLowerCase())) return shown;
    }
}

/** What a player typed, reduced to the characters a name may hold and cut to 16. */
export function cleanName(raw: string): string {
    return raw.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
}
