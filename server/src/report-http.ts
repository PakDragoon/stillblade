import type { IncomingMessage, ServerResponse } from 'node:http';
import { REPORT_MAX_BYTES } from '../../shared/protocol';
import { originAllowed, type Reports } from './reports';

export interface ReportHttpDeps {
    reports: Reports;
    allowedOrigins: readonly string[];
    /** The address of the caller as the server should count it (X-Forwarded-For only when the proxy is trusted). */
    clientIp: (req: IncomingMessage) => string;
}

function cors(req: IncomingMessage, res: ServerResponse, deps: ReportHttpDeps): void {
    const origin = req.headers.origin;
    // Headers only for an origin that is on the list, never a wildcard; with no list (development) the caller's own origin is echoed.
    if (origin && originAllowed(origin, deps.allowedOrigins)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
    }
}

/**
 * `POST /report` (and its `OPTIONS` preflight), used when the socket is down. Same origin check as the
 * socket, a body of at most REPORT_MAX_BYTES, a per-address limit, and the same validation and log.
 * Returns true if the request was for this route.
 */
export function handleReportRequest(req: IncomingMessage, res: ServerResponse, deps: ReportHttpDeps): boolean {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/report') return false;
    cors(req, res, deps);
    const done = (status: number, body = ''): void => { res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(body); };

    if (req.method === 'OPTIONS') {
        if (!originAllowed(req.headers.origin, deps.allowedOrigins)) { done(403); return true; }
        res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type');
        res.setHeader('access-control-max-age', '600');
        done(204);
        return true;
    }
    if (req.method !== 'POST') { done(405); return true; }
    if (!originAllowed(req.headers.origin, deps.allowedOrigins)) { done(403); return true; }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > REPORT_MAX_BYTES) { done(413); req.resume(); return true; }

    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > REPORT_MAX_BYTES) { tooBig = true; return; }
        chunks.push(c);
    });
    req.on('error', () => { /* connection dropped */ });
    req.on('end', () => {
        if (tooBig) { done(413); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { done(400); return; }
        const ip = deps.clientIp(req);
        // The per-address limit is checked before anything is written; a refused one does not count against itself.
        if (!deps.reports.ipLimits.allow(ip, Date.now())) { done(429); return; }
        void deps.reports.submit(parsed, { via: 'http' }, null).then(r => done(r === 'saved' ? 204 : r === 'limited' ? 429 : 400));
    });
    return true;
}
