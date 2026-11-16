import { ERROR_MAX_CHARS, FEEDBACK_MAX_CHARS, REPORT_GPU_MAX_CHARS, REPORT_MAX_BYTES, REPORT_PATH_MAX_CHARS, REPORT_UA_MAX_CHARS, STACK_MAX_CHARS, type ReportCtx, type ReportMsg } from './protocol';

/** Control characters other than the line feed (kept in notes and stacks), plus the Unicode line and paragraph separators. */
const CONTROL_KEEP_LF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
/** Everything that counts as white space or a control character, for single-line fields. */
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Text for a report: control characters removed (a line break is kept when `lines` is true), runs of
 * spaces collapsed, trimmed, and cut to `max` characters (counted as characters, not UTF-16 units).
 * Used by the server to clean what it receives and by the client to cap what it sends.
 */
export function cleanReportText(raw: unknown, max: number, lines = false): string {
    if (typeof raw !== 'string') return '';
    let t = raw.replace(/\r\n?/g, '\n');
    t = lines ? t.replace(/[^\S\n]+/g, ' ').replace(CONTROL_KEEP_LF, '').replace(/\n{3,}/g, '\n\n') : t.replace(CONTROL_OR_SPACE, ' ');
    t = t.trim();
    const chars = Array.from(t);
    return chars.length > max ? chars.slice(0, max).join('').trim() : t;
}

/** A finite number inside [lo, hi], else undefined. */
export function cleanReportNumber(raw: unknown, lo: number, hi: number, digits = 0): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    const v = Math.min(hi, Math.max(lo, raw));
    const k = 10 ** digits;
    return Math.round(v * k) / k;
}

/** The page path without query or fragment, or '' if it is not a path. */
export function cleanReportPath(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const t = cleanReportText(raw.split(/[?#]/)[0], REPORT_PATH_MAX_CHARS);
    return t.startsWith('/') ? t : '';
}

/** Every field of a client report cleaned and capped; wrong types are dropped. Never throws. */
export function cleanReportCtx(raw: unknown): ReportCtx {
    const c = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const out: ReportCtx = {};
    const fps = cleanReportNumber(c.fps, 0, 1000, 1);
    const scale = cleanReportNumber(c.renderScale, 0, 1, 2);
    const ping = cleanReportNumber(c.ping, 0, 60000);
    if (fps !== undefined) out.fps = fps;
    if (scale !== undefined) out.renderScale = scale;
    if (ping !== undefined) out.ping = ping;
    out.ua = cleanReportText(c.ua, REPORT_UA_MAX_CHARS);
    out.gpu = cleanReportText(c.gpu, REPORT_GPU_MAX_CHARS);
    out.path = cleanReportPath(c.path);
    return out;
}

/** UTF-8 size of the frame the client will send. */
export function reportBytes(msg: ReportMsg): number {
    return new TextEncoder().encode(JSON.stringify(msg)).length;
}

/**
 * Builds the message to send: every field cleaned, then, if the serialised frame is still over the
 * server's frame limit (a stack of four-byte characters can be), the stack and then the text are cut
 * until it fits. Returns null when there is nothing worth sending.
 */
export function buildReport(kind: ReportMsg['kind'], text: unknown, stack: unknown, ctx: ReportCtx): ReportMsg | null {
    const t = cleanReportText(text, kind === 'feedback' ? FEEDBACK_MAX_CHARS : ERROR_MAX_CHARS, kind === 'feedback');
    if (!t) return null;
    const msg: ReportMsg = { type: 'report', kind, text: t, ctx: cleanReportCtx(ctx) };
    const s = kind === 'error' ? cleanReportText(stack, STACK_MAX_CHARS, true) : '';
    if (s) msg.stack = s;
    const budget = REPORT_MAX_BYTES - 200;
    for (let guard = 0; guard < 40 && reportBytes(msg) > budget; guard++) {
        if (msg.stack) {
            const a = Array.from(msg.stack);
            if (a.length > 100) msg.stack = a.slice(0, Math.floor(a.length * 0.7)).join('');
            else delete msg.stack;
        } else {
            const a = Array.from(msg.text);
            msg.text = a.slice(0, Math.max(1, Math.floor(a.length * 0.8))).join('');
        }
    }
    return msg;
}
