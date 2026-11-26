/**
 * Feedback notes and automatic error reports. No socket code: pure functions and a few small classes,
 * so every rule is tested directly (reports.test.ts). `server/src/main.ts` routes messages here before
 * they can reach `Game`, and `report-http.ts` serves the same rules over HTTP when the socket is down.
 */
import { appendFile } from 'node:fs';
import {
    ERROR_MAX_CHARS, FEEDBACK_MAX_CHARS, PROTOCOL_VERSION, STACK_MAX_CHARS, type ClientMsg, type ReportCtx, type ReportMsg
} from '../../shared/protocol';
import { cleanReportCtx, cleanReportText } from '../../shared/report';

/** One feedback note per connection: at most this many per window. */
export const FEEDBACK_PER_WINDOW = 3;
export const FEEDBACK_WINDOW_MS = 10 * 60_000;
/** Automatic error reports allowed over a whole connection (session). */
export const ERRORS_PER_SESSION = 5;
/** Reports from one address over HTTP. */
export const HTTP_PER_WINDOW = 5;
export const HTTP_WINDOW_MS = 10 * 60_000;
/** A backstop on everything the server writes, whoever sends it (reconnecting does not reset it). */
export const GLOBAL_PER_WINDOW = 120;
export const GLOBAL_WINDOW_MS = 10 * 60_000;

/** What the server itself knows about the sender; the client's copy of any of it is never used. */
export interface ReportSource {
    via: 'ws' | 'http';
    room?: string;
    map?: string;
    team?: string;
    playerId?: number;
    name?: string;
}

/** One line of the log file. */
export interface ReportLine {
    time: string;
    kind: 'feedback' | 'error';
    text: string;
    stack?: string;
    ctx: ReportCtx;
    server: ReportSource & { protocol: number };
}

/** The message with every field cleaned and capped, or null if it is not worth keeping. */
export function cleanReport(msg: unknown): ReportMsg | null {
    if (typeof msg !== 'object' || msg === null) return null;
    const m = msg as Record<string, unknown>;
    if (m.kind !== 'feedback' && m.kind !== 'error') return null;
    const text = cleanReportText(m.text, m.kind === 'feedback' ? FEEDBACK_MAX_CHARS : ERROR_MAX_CHARS, m.kind === 'feedback');
    if (!text) return null;
    const out: ReportMsg = { type: 'report', kind: m.kind, text, ctx: cleanReportCtx(m.ctx) };
    if (m.kind === 'error') {
        const stack = cleanReportText(m.stack, STACK_MAX_CHARS, true);
        if (stack) out.stack = stack;
    }
    return out;
}

/** A sliding-window rate limit: at most `max` events in any `windowMs`. */
export class SlidingLimit {
    private readonly times: number[] = [];

    constructor(private readonly max: number, private readonly windowMs: number) {}

    expired(now: number): boolean {
        return this.times.length === 0 || now - this.times[this.times.length - 1] >= this.windowMs;
    }

    /** Records an event at `now` (ms) and returns true if it is allowed. A refused one is not recorded. */
    allow(now: number): boolean {
        while (this.times.length > 0 && now - this.times[0] >= this.windowMs) this.times.shift();
        if (this.times.length >= this.max) return false;
        this.times.push(now);
        return true;
    }
}

/** The limits that belong to one connection: 3 notes per 10 minutes and 5 error reports per session. */
export class ConnectionReportLimit {
    private readonly notes = new SlidingLimit(FEEDBACK_PER_WINDOW, FEEDBACK_WINDOW_MS);
    private errors = 0;

    allow(kind: ReportMsg['kind'], now: number): boolean {
        if (kind === 'feedback') return this.notes.allow(now);
        if (this.errors >= ERRORS_PER_SESSION) return false;
        this.errors++;
        return true;
    }
}

/** Per-address limits for the HTTP route. */
export class IpReportLimits {
    private readonly byIp = new Map<string, SlidingLimit>();

    prune(now: number): number {
        for (const [ip, limit] of this.byIp) if (limit.expired(now)) this.byIp.delete(ip);
        return this.byIp.size;
    }

    allow(ip: string, now: number): boolean {
        let l = this.byIp.get(ip);
        if (!l) {
            if (this.byIp.size >= 5000 && this.prune(now) >= 5000) return false;
            l = new SlidingLimit(HTTP_PER_WINDOW, HTTP_WINDOW_MS);
            this.byIp.set(ip, l);
        }
        return l.allow(now);
    }
}

/**
 * Validates, limits and writes reports. `file` is the log path (an empty string writes only to `out`);
 * a failed write is reported to `onError` and never thrown.
 */
export class Reports {
    private readonly global = new SlidingLimit(GLOBAL_PER_WINDOW, GLOBAL_WINDOW_MS);
    readonly ipLimits = new IpReportLimits();

    constructor(
        private readonly file: string,
        private readonly out: (line: string) => void = line => console.log(line),
        private readonly onError: (err: Error) => void = err => console.warn(`feedback log not written: ${err.message}`),
        private readonly clock: () => number = () => Date.now()
    ) {}

    /**
     * Files one report. `limit` is the sender's own limit (a connection's); pass null for the HTTP route,
     * which applies the per-address limit itself. Returns what happened, so callers can answer.
     */
    submit(raw: unknown, source: ReportSource, limit: ConnectionReportLimit | null, now: number = this.clock()): Promise<'saved' | 'invalid' | 'limited'> {
        const msg = cleanReport(raw);
        if (!msg) return Promise.resolve('invalid');
        if (limit && !limit.allow(msg.kind, now)) return Promise.resolve('limited');
        if (!this.global.allow(now)) return Promise.resolve('limited');
        const line: ReportLine = { time: new Date(now).toISOString(), kind: msg.kind, text: msg.text, ctx: msg.ctx, server: { ...cleanSource(source), protocol: PROTOCOL_VERSION } };
        if (msg.stack) line.stack = msg.stack;
        const json = JSON.stringify(line);
        this.out(`[report] ${json}`);
        return this.write(json).then(() => 'saved' as const);
    }

    private write(json: string): Promise<void> {
        if (!this.file) return Promise.resolve();
        return new Promise(resolve => {
            try {
                appendFile(this.file, `${json}\n`, err => { if (err) this.onError(err); resolve(); });
            } catch (err) {
                this.onError(err instanceof Error ? err : new Error(String(err)));
                resolve();
            }
        });
    }
}

/** The server's own facts, cleaned again so a strange player name cannot break the log line. */
function cleanSource(s: ReportSource): ReportSource {
    const out: ReportSource = { via: s.via };
    if (s.room !== undefined) out.room = cleanReportText(s.room, 40);
    if (s.map !== undefined) out.map = cleanReportText(s.map, 60);
    if (s.team !== undefined) out.team = cleanReportText(s.team, 20);
    if (typeof s.playerId === 'number' && Number.isFinite(s.playerId)) out.playerId = s.playerId;
    if (s.name !== undefined) out.name = cleanReportText(s.name, 40);
    return out;
}

/**
 * Page origins allowed to talk to the server: the one check for the socket and for HTTP. An empty list
 * means any origin (development). Trailing slashes are ignored; a missing origin is "", which only an
 * empty list accepts.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
    if (allowed.length === 0) return true;
    return allowed.includes((origin ?? '').replace(/\/$/, ''));
}

/**
 * Routes one decoded client message: a report goes to `onReport` and never reaches the game; anything
 * else goes to `game.handleMessage`.
 */
export function routeClientMessage(
    msg: ClientMsg,
    game: { handleMessage(id: number, msg: ClientMsg): void },
    id: number,
    onReport: (msg: ReportMsg) => void
): void {
    if (msg.type === 'report') { onReport(msg); return; }
    game.handleMessage(id, msg);
}
