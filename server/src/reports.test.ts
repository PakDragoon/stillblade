import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ERROR_MAX_CHARS, FEEDBACK_MAX_CHARS, PROTOCOL_VERSION, REPORT_MAX_BYTES, STACK_MAX_CHARS, decodeClient, encodeClient, type ClientMsg, type ReportMsg
} from '../../shared/protocol';
import { buildReport, reportBytes } from '../../shared/report';
import { handleReportRequest } from './report-http';
import {
    ConnectionReportLimit, ERRORS_PER_SESSION, FEEDBACK_PER_WINDOW, FEEDBACK_WINDOW_MS, Reports, SlidingLimit, cleanReport, originAllowed, routeClientMessage
} from './reports';

const MIN = 60_000;
const feedback = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'report', kind: 'feedback', text, ctx: {}, ...extra });
const error = (text: string, stack?: string): Record<string, unknown> => ({ type: 'report', kind: 'error', text, stack, ctx: {} });

describe('cleaning and capping', () => {
    it('caps every text field in characters, not UTF-16 units', () => {
        expect(cleanReport(feedback('x'.repeat(900)))!.text).toHaveLength(FEEDBACK_MAX_CHARS);
        expect(Array.from(cleanReport(feedback('😀'.repeat(900)))!.text)).toHaveLength(FEEDBACK_MAX_CHARS);
        expect(cleanReport(error('e'.repeat(900), 's'.repeat(5000)))!.text).toHaveLength(ERROR_MAX_CHARS);
        expect(cleanReport(error('e', 's'.repeat(5000)))!.stack).toHaveLength(STACK_MAX_CHARS);
        const ctx = cleanReport(feedback('hi', { ctx: { ua: 'u'.repeat(900), gpu: 'g'.repeat(900), path: `/${'p'.repeat(900)}` } }))!.ctx;
        expect(ctx.ua).toHaveLength(200);
        expect(ctx.gpu).toHaveLength(200);
        expect(ctx.path!.length).toBeLessThanOrEqual(100);
    });

    it('strips control characters and keeps line breaks only in feedback and stacks', () => {
        const t = cleanReport(feedback('a\u0000b\u001b[31mc\u0007\r\nd\n\n\n\ne'))!.text;
        expect(t).toBe('ab[31mc\nd\n\ne');
        expect(cleanReport(error('boom\nline two\u0000'))!.text).toBe('boom line two');
        expect(cleanReport(error('x', 'at a\nat b\u0001'))!.stack).toBe('at a\nat b');
    });

    it('drops wrong types and bad values instead of failing', () => {
        const r = cleanReport(feedback('hi', { ctx: { fps: 'fast', renderScale: 9, ping: -4, ua: 5, gpu: null, path: 'https://x' } }))!;
        expect(r.ctx).toEqual({ renderScale: 1, ping: 0, ua: '', gpu: '', path: '' });
        expect(cleanReport(feedback('hi', { ctx: 'nope' }))!.ctx).toEqual({ ua: '', gpu: '', path: '' });
        expect(cleanReport(feedback('hi', { ctx: { fps: NaN } }))!.ctx.fps).toBeUndefined();
    });

    it('keeps the path without its query and fragment', () => {
        expect(cleanReport(feedback('hi', { ctx: { path: '/play/?room=secret#x' } }))!.ctx.path).toBe('/play/');
    });

    it('refuses what is not a report or has nothing in it', () => {
        for (const bad of [null, 5, 'x', {}, { kind: 'other', text: 'x' }, feedback(''), feedback('   \u0000 '), feedback(5 as unknown as string), error('')]) {
            expect(cleanReport(bad)).toBeNull();
        }
    });

    it('does not copy unknown fields (a name or chat text smuggled in is not kept)', () => {
        const r = cleanReport(feedback('hi', { name: 'Eve', chat: 'secret', ctx: { name: 'Eve', fps: 60 } }))! as unknown as Record<string, unknown>;
        expect(JSON.stringify(r)).not.toContain('Eve');
        expect(JSON.stringify(r)).not.toContain('secret');
        expect(r.stack).toBeUndefined();
    });
});

describe('rate limits', () => {
    it('allows 3 feedback notes per 10 minutes per connection, then again after the window', () => {
        const l = new ConnectionReportLimit();
        for (let i = 0; i < FEEDBACK_PER_WINDOW; i++) expect(l.allow('feedback', i * 1000)).toBe(true);
        expect(l.allow('feedback', 5000)).toBe(false);
        expect(l.allow('feedback', 5 * MIN)).toBe(false);
        expect(l.allow('feedback', FEEDBACK_WINDOW_MS + 1000)).toBe(true); // the first has aged out
    });

    it('allows 5 error reports per session, however long it lasts, and keeps the two kinds apart', () => {
        const l = new ConnectionReportLimit();
        for (let i = 0; i < ERRORS_PER_SESSION; i++) expect(l.allow('error', i)).toBe(true);
        expect(l.allow('error', 100 * MIN)).toBe(false);
        expect(l.allow('feedback', 0)).toBe(true);
        expect(new ConnectionReportLimit().allow('error', 0)).toBe(true); // another connection has its own
    });

    it('a refused event does not extend the window', () => {
        const l = new SlidingLimit(1, 1000);
        expect(l.allow(0)).toBe(true);
        expect(l.allow(900)).toBe(false);
        expect(l.allow(1001)).toBe(true);
    });

    it('limits per address over HTTP to 5 per 10 minutes', () => {
        const r = new Reports('', () => {});
        for (let i = 0; i < 5; i++) expect(r.ipLimits.allow('1.2.3.4', i)).toBe(true);
        expect(r.ipLimits.allow('1.2.3.4', 6)).toBe(false);
        expect(r.ipLimits.allow('5.6.7.8', 6)).toBe(true);
        expect(r.ipLimits.allow('1.2.3.4', 10 * MIN + 1)).toBe(true);
    });
});

describe('origin check', () => {
    it('accepts listed origins, ignoring a trailing slash', () => {
        const list = ['https://a.example'];
        expect(originAllowed('https://a.example', list)).toBe(true);
        expect(originAllowed('https://a.example/', list)).toBe(true);
    });
    it('refuses unlisted and missing origins when there is a list', () => {
        const list = ['https://a.example'];
        expect(originAllowed('https://evil.example', list)).toBe(false);
        expect(originAllowed('', list)).toBe(false);
        expect(originAllowed(undefined, list)).toBe(false);
    });
    it('accepts anything when the list is empty', () => {
        expect(originAllowed('https://anything', [])).toBe(true);
        expect(originAllowed(undefined, [])).toBe(true);
    });
});

describe('the log', () => {
    let dir = '';
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sb-feedback-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('appends one JSON line per report with the server facts and prints it', async () => {
        const file = join(dir, 'feedback.log');
        const printed: string[] = [];
        const r = new Reports(file, l => printed.push(l));
        const now = Date.UTC(2026, 10, 16, 12, 0, 0);
        const sent = feedback('the rifle feels floaty', { name: 'Mallory', ctx: { fps: 58.26, renderScale: 0.8, ping: 41.6, ua: 'UA', gpu: 'GPU', path: '/' } });
        expect(await r.submit(sent, { via: 'ws', room: 'quiet-heron-42', map: 'Warehouse', team: 'defenders', playerId: 3, name: 'Alice' }, new ConnectionReportLimit(), now)).toBe('saved');
        await r.submit(error('TypeError: x', 'at f (a.js:1:1)'), { via: 'http' }, null, now + 1);
        const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
        expect(lines).toHaveLength(2);
        const a = JSON.parse(lines[0]);
        expect(a).toEqual({
            time: '2026-11-16T12:00:00.000Z', kind: 'feedback', text: 'the rifle feels floaty',
            ctx: { fps: 58.3, renderScale: 0.8, ping: 42, ua: 'UA', gpu: 'GPU', path: '/' },
            server: { via: 'ws', room: 'quiet-heron-42', map: 'Warehouse', team: 'defenders', playerId: 3, name: 'Alice', protocol: PROTOCOL_VERSION }
        });
        expect(lines[0]).not.toContain('Mallory'); // only the server's own copy of the name is used
        const b = JSON.parse(lines[1]);
        expect(b.kind).toBe('error');
        expect(b.stack).toBe('at f (a.js:1:1)');
        expect(b.server).toEqual({ via: 'http', protocol: PROTOCOL_VERSION });
        expect(printed).toHaveLength(2);
        expect(printed[0].startsWith('[report] {')).toBe(true);
    });

    it('answers invalid and limited reports without writing', async () => {
        const file = join(dir, 'f.log');
        const r = new Reports(file, () => {});
        const limit = new ConnectionReportLimit();
        expect(await r.submit({ kind: 'feedback', text: '' }, { via: 'ws' }, limit)).toBe('invalid');
        for (let i = 0; i < 3; i++) await r.submit(feedback(`n${i}`), { via: 'ws' }, limit, 1000 + i);
        expect(await r.submit(feedback('n4'), { via: 'ws' }, limit, 2000)).toBe('limited');
        expect(readFileSync(file, 'utf8').trimEnd().split('\n')).toHaveLength(3);
    });

    it('never throws when the file cannot be written', async () => {
        const errors: string[] = [];
        const bad = join(dir, 'no', 'such', 'dir', 'f.log');
        const r = new Reports(bad, () => {}, e => errors.push(e.message));
        expect(await r.submit(feedback('hello'), { via: 'ws' }, null)).toBe('saved');
        expect(errors).toHaveLength(1);
        expect(existsSync(bad)).toBe(false);
    });

    it('writes only to the console when no file is set', async () => {
        const printed: string[] = [];
        expect(await new Reports('', l => printed.push(l)).submit(feedback('hello'), { via: 'ws' }, null)).toBe('saved');
        expect(printed).toHaveLength(1);
    });

    it('keeps a strange player name from breaking the line', async () => {
        const file = join(dir, 'f.log');
        await new Reports(file, () => {}).submit(feedback('hi'), { via: 'ws', name: 'a\nb"\u0000c' }, null);
        const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]).server.name).toBe('a b" c');
    });
});

describe('routing', () => {
    it('never lets a report reach the game, and passes every other message through', () => {
        const seen: ClientMsg[] = [];
        const game = { handleMessage: (_id: number, m: ClientMsg) => { seen.push(m); } };
        const reported: ReportMsg[] = [];
        const rep = decodeClient(encodeClient({ type: 'report', kind: 'feedback', text: 'hi', ctx: {} }) as string);
        routeClientMessage(rep, game, 1, m => reported.push(m));
        routeClientMessage({ type: 'chat', team: false, text: 'x' }, game, 1, m => reported.push(m));
        routeClientMessage({ type: 'start' }, game, 1, m => reported.push(m));
        expect(reported).toHaveLength(1);
        expect(seen.map(m => m.type)).toEqual(['chat', 'start']);
    });
});

describe('client message builder', () => {
    it('keeps every serialised report inside the server frame limit, even in four-byte text', () => {
        const emoji = '😀'.repeat(2000);
        const quotes = '"'.repeat(2000);
        const ctx = { ua: emoji, gpu: emoji, path: '/', fps: 60 };
        for (const m of [buildReport('feedback', emoji, undefined, ctx), buildReport('error', emoji, emoji, ctx), buildReport('error', quotes, quotes, ctx), buildReport('feedback', quotes, undefined, ctx)]) {
            expect(m).not.toBeNull();
            expect(reportBytes(m!)).toBeLessThanOrEqual(REPORT_MAX_BYTES);
        }
        expect(buildReport('feedback', '   ', undefined, {})).toBeNull();
    });
});

describe('POST /report', () => {
    let server: Server;
    let dir = '';
    let port = 0;
    let file = '';
    const origins: string[] = [];
    let ip = '9.9.9.9';

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'sb-http-'));
        file = join(dir, 'f.log');
        origins.length = 0;
        ip = '9.9.9.9';
        const reports = new Reports(file, () => {});
        server = createServer((req, res) => {
            if (!handleReportRequest(req, res, { reports, allowedOrigins: origins, clientIp: () => ip })) res.writeHead(404).end();
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as AddressInfo).port;
    });
    afterEach(async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
    });

    const call = (method: string, body: string | null, headers: Record<string, string> = {}, path = '/report'): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> =>
        new Promise((resolve, reject) => {
            const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
                res.resume();
                res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
            });
            req.on('error', reject);
            if (body !== null) req.write(body);
            req.end();
        });
    const good = JSON.stringify({ type: 'report', kind: 'error', text: 'boom', stack: 'at x', ctx: { fps: 30 } });

    it('stores a valid report with no room or player', async () => {
        const r = await call('POST', good);
        expect(r.status).toBe(204);
        const line = JSON.parse(readFileSync(file, 'utf8').trim());
        expect(line.server).toEqual({ via: 'http', protocol: PROTOCOL_VERSION });
        expect(line.text).toBe('boom');
    });

    it('refuses other paths, methods and bad bodies', async () => {
        expect((await call('POST', good, {}, '/other')).status).toBe(404);
        expect((await call('GET', null)).status).toBe(405);
        expect((await call('POST', '{not json')).status).toBe(400);
        expect((await call('POST', JSON.stringify({ kind: 'feedback', text: '' }))).status).toBe(400);
    });

    it('refuses a body over the cap, declared or not', async () => {
        expect((await call('POST', JSON.stringify({ kind: 'feedback', text: 'x'.repeat(5000), ctx: {} }))).status).toBe(413);
        expect(existsSync(file)).toBe(false);
    });

    it('applies the same origin check as the socket, with CORS headers only for allowed origins', async () => {
        origins.push('https://game.example');
        const ok = await call('POST', good, { origin: 'https://game.example' });
        expect(ok.status).toBe(204);
        expect(ok.headers['access-control-allow-origin']).toBe('https://game.example');
        const bad = await call('POST', good, { origin: 'https://evil.example' });
        expect(bad.status).toBe(403);
        expect(bad.headers['access-control-allow-origin']).toBeUndefined();
        expect((await call('POST', good)).status).toBe(403); // no origin at all
        expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    });

    it('answers a preflight for allowed origins only', async () => {
        origins.push('https://game.example');
        const ok = await call('OPTIONS', null, { origin: 'https://game.example', 'access-control-request-method': 'POST' });
        expect(ok.status).toBe(204);
        expect(ok.headers['access-control-allow-origin']).toBe('https://game.example');
        expect(String(ok.headers['access-control-allow-methods'])).toContain('POST');
        const bad = await call('OPTIONS', null, { origin: 'https://evil.example' });
        expect(bad.status).toBe(403);
        expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('accepts any origin when the list is empty', async () => {
        expect((await call('POST', good, { origin: 'https://anything.example' })).status).toBe(204);
    });

    it('limits each address to 5 per 10 minutes', async () => {
        for (let i = 0; i < 5; i++) expect((await call('POST', good)).status).toBe(204);
        expect((await call('POST', good)).status).toBe(429);
        ip = '8.8.8.8';
        expect((await call('POST', good)).status).toBe(204);
    });
});
