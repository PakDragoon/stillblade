import { button, h } from './dom';
import type { Tier } from './graphics';

const CAPTURE_MS = 30_000;
const COUNTDOWN_MS = 4_000;
const SAMPLE_LIMIT = 32_768;

export class FrameCapture {
    private readonly times = new Float64Array(SAMPLE_LIMIT);
    private previous = NaN;
    private count = 0;
    private elapsed = 0;
    private hitches = 0;
    private scaleSum = 0;
    private lowestScale = Infinity;
    private drawSum = 0;

    record(now: number, scale: number, draws: number): boolean {
        const interval = now - this.previous;
        this.previous = now;
        // First frame sets the time origin. Never treat time spent preparing as a rendered frame.
        if (!(interval > 0)) return false;
        this.times[this.count++] = interval;
        this.elapsed += interval;
        if (interval > 50) this.hitches++;
        this.scaleSum += scale;
        this.lowestScale = Math.min(this.lowestScale, scale);
        this.drawSum += draws;
        return this.elapsed >= CAPTURE_MS || this.count >= SAMPLE_LIMIT;
    }

    get seconds(): number { return this.elapsed / 1000; }

    summary() {
        const sorted = this.times.slice(0, this.count).sort();
        const percentile = (q: number): number => round(sorted[Math.ceil(this.count * q) - 1]);
        return {
            frames: this.count,
            seconds: round(this.seconds),
            averageFps: round(this.count / this.seconds),
            p50Ms: percentile(0.5),
            p95Ms: percentile(0.95),
            p99Ms: percentile(0.99),
            maxMs: round(sorted[this.count - 1]),
            framesOver50Ms: this.hitches,
            averageRenderScale: round(this.scaleSum / this.count),
            minimumRenderScale: round(this.lowestScale),
            averageDrawCalls: round(this.drawSum / this.count)
        };
    }
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/** The optional capture is local only. Nothing is sent to the match server or feedback endpoint. */
export function frameCapturePanel(canvas: HTMLCanvasElement, renderer: string, multisamplingRequested: boolean) {
    const panel = h('section', 'frame-capture', '', document.body);
    panel.setAttribute('aria-label', 'Performance test');
    const status = h('span', '', '30-second performance test', panel);
    status.setAttribute('role', 'status');
    let capture: FrameCapture | null = null;
    let startsAt = 0;
    let shown = -1;
    let initialMap: string | undefined;
    let initialTier: Tier | undefined;
    let report = '';
    let viewportWidth = 0;
    let viewportHeight = 0;

    const start = button('Start', '', panel, () => {
        capture = new FrameCapture();
        startsAt = performance.now() + COUNTDOWN_MS;
        shown = -1;
        initialMap = initialTier = undefined;
        report = '';
        start.disabled = download.disabled = true;
        status.textContent = 'Starting in 4 s. Return to play.';
    });
    const download = button('Download results', '', panel, () => {
        const url = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'stillblade-performance.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    download.disabled = true;

    function cancel(message: string): void {
        if (!capture) return;
        capture = null;
        status.textContent = message;
        start.disabled = false;
    }

    window.addEventListener('resize', () => cancel('Window resized. Start again.'));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) cancel('Tab went into the background. Start again.');
    });

    return (map: string, tier: Tier, draws: number, loading: boolean): void => {
        if (!capture) return;
        if (loading || (initialMap !== undefined && (map !== initialMap || tier !== initialTier))) {
            cancel('Map or quality changed. Start again.');
            return;
        }
        const now = performance.now();
        if (now < startsAt) return;
        if (initialMap === undefined) {
            initialMap = map;
            initialTier = tier;
            viewportWidth = canvas.clientWidth;
            viewportHeight = canvas.clientHeight;
        }
        // Backing width reflects the scale WebGL used, including device pixel ratio and canvas rounding.
        if (capture.record(now, canvas.width / Math.max(1, viewportWidth), draws)) {
            const results = capture.summary();
            status.textContent = `Done · p50 ${results.p50Ms} ms · p95 ${results.p95Ms} ms · p99 ${results.p99Ms} ms`;
            report = JSON.stringify({ map, tier, renderer, multisamplingRequested, viewportWidth, viewportHeight, ...results }, null, 2);
            capture = null;
            start.disabled = download.disabled = false;
            return;
        }
        const seconds = Math.floor(capture.seconds);
        if (seconds !== shown) {
            shown = seconds;
            status.textContent = `Measuring · ${seconds} / 30 s`;
        }
    };
}
