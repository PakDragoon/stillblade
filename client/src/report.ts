/**
 * Feedback notes and automatic error reports, client side. Reports go over the game socket when it is open
 * and by HTTP POST to the game server when it is not. The wire rules (caps, byte limit, what is never sent)
 * live in `shared/report.ts`; the player's name and chat text are never put in a report.
 */
import type { ReportCtx, ReportMsg } from '@shared/protocol';
import { buildReport } from '@shared/report';

/** At most this many automatic error reports per page session; the same message is sent once. */
export const MAX_ERROR_REPORTS = 5;

export interface LiveContext {
    fps: number;
    renderScale: number;
    ping: number;
}

/** The one HTTP endpoint of the game server, derived from its WebSocket address. */
export function reportUrl(serverBase: string): string {
    return `${serverBase.replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '')}/report`;
}

class Reporter {
    private url = '';
    private canvas: HTMLCanvasElement | null = null;
    private send: ((msg: ReportMsg) => boolean) | null = null;
    private live: () => Partial<LiveContext> = () => ({});
    private gpu: string | null = null;
    private readonly seen = new Set<string>();
    private errors = 0;
    private installed = false;
    /** The map name, for the "what is attached" line (the server adds its own copy). */
    mapName = '';

    /** Where HTTP reports go, and the canvas whose graphics card is read. Call once, early. */
    configure(serverBase: string, canvas: HTMLCanvasElement): void {
        this.url = reportUrl(serverBase);
        this.canvas = canvas;
    }

    /** The open game socket, as a function that returns false when it cannot send. */
    setSocket(send: ((msg: ReportMsg) => boolean) | null): void {
        this.send = send;
    }

    /** Frame rate, render scale and ping, read at the moment a report is built. */
    setLive(fn: () => Partial<LiveContext>): void {
        this.live = fn;
    }

    /** The graphics card string (unmasked renderer), empty if the browser hides it. Read once. */
    gpuString(): string {
        if (this.gpu !== null) return this.gpu;
        let gpu = '';
        try {
            const gl = (this.canvas?.getContext('webgl2') ?? this.canvas?.getContext('webgl')) as WebGLRenderingContext | null | undefined;
            const ext = gl?.getExtension('WEBGL_debug_renderer_info');
            if (gl && ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
        } catch { /* hidden or lost context */ }
        this.gpu = gpu;
        return gpu;
    }

    private context(): ReportCtx {
        const live = this.live();
        return {
            fps: live.fps, renderScale: live.renderScale, ping: live.ping,
            ua: navigator.userAgent, gpu: this.gpuString(), path: location.pathname
        };
    }

    /** One line for the feedback panel: what a note carries. */
    attachedSummary(): string {
        const fps = this.live().fps;
        const parts = [this.mapName ? `the map (${this.mapName})` : 'the map', fps ? `your frame rate (${Math.round(fps)})` : 'your frame rate', 'your graphics card', 'your browser'];
        return `Sent with it: ${parts.join(', ')}. Never your chat.`;
    }

    /** Sends a note. Resolves true when it was handed to the socket or accepted over HTTP. */
    async sendFeedback(text: string): Promise<boolean> {
        const msg = buildReport('feedback', text, undefined, this.context());
        return msg !== null && await this.deliver(msg);
    }

    private async deliver(msg: ReportMsg): Promise<boolean> {
        try {
            if (this.send?.(msg)) return true;
        } catch { /* fall through to HTTP */ }
        if (!this.url) return false;
        try {
            const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(msg), keepalive: true });
            return res.ok;
        } catch {
            return false;
        }
    }

    /** An automatic report: at most 5 per session, identical messages once. Never throws. */
    reportError(message: string, stack?: string): void {
        try {
            const msg = buildReport('error', message, stack, this.context());
            if (!msg) return;
            if (this.errors >= MAX_ERROR_REPORTS || this.seen.has(msg.text)) return;
            this.seen.add(msg.text);
            this.errors++;
            void this.deliver(msg);
        } catch { /* a failing reporter must never cause another error */ }
    }

    /** Hooks window.onerror, unhandled promise rejections and a lost WebGL context. */
    install(): void {
        if (this.installed) return;
        this.installed = true;
        window.addEventListener('error', e => {
            if (!(e instanceof ErrorEvent) || (!e.message && !e.error)) return; // a failed image or script load, not a thrown error
            if (/ResizeObserver loop/.test(e.message)) return;
            const err = e.error as { stack?: unknown } | null | undefined;
            this.reportError(e.message || String(e.error), typeof err?.stack === 'string' ? err.stack : undefined);
        });
        window.addEventListener('unhandledrejection', e => {
            const r = e.reason as { message?: unknown; stack?: unknown } | string | null | undefined;
            const message = typeof r === 'string' ? r : typeof r?.message === 'string' ? r.message : 'Unhandled promise rejection';
            this.reportError(message, typeof r === 'object' && r !== null && typeof r.stack === 'string' ? r.stack : undefined);
        });
        this.canvas?.addEventListener('webglcontextlost', () => this.reportError('WebGL context lost'));
    }
}

/** The page's one reporter. */
export const reporter = new Reporter();
