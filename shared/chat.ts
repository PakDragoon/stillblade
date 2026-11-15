import { CHAT_MAX_CHARS } from './protocol';

/**
 * Chat text as shown: control, format and unassigned characters removed, whitespace collapsed,
 * trimmed, at most CHAT_MAX_CHARS characters (counted as characters, not UTF-16 units). Empty means drop it.
 */
export function cleanChat(raw: string): string {
    // \p{C} is control, format, surrogate, private-use and unassigned; \s then covers line separators.
    const text = raw.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(text);
    return chars.length > CHAT_MAX_CHARS ? chars.slice(0, CHAT_MAX_CHARS).join('').trim() : text;
}
