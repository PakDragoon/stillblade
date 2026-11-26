import { expect, it } from 'vitest';
import { FrameCapture } from './frame-capture';

it('counts visible frame intervals, hitches and actual scale without including lead-in time', () => {
    const capture = new FrameCapture();
    expect(capture.record(10_000, 1, 20)).toBe(false);
    for (let i = 1; i <= 100; i++) capture.record(10_000 + i * 16.5, 1, 20);
    capture.record(11_750, 0.5, 40);
    expect(capture.summary()).toEqual({
        frames: 101, seconds: 1.75, averageFps: 57.71,
        p50Ms: 16.5, p95Ms: 16.5, p99Ms: 16.5, maxMs: 100,
        framesOver50Ms: 1, averageRenderScale: 1, minimumRenderScale: 0.5, averageDrawCalls: 20.2
    });
});

it('finishes at 30 seconds of sampled frames', () => {
    const capture = new FrameCapture();
    for (let t = 0; t < 30_000; t += 20) expect(capture.record(t, 1, 24)).toBe(false);
    expect(capture.record(30_000, 1, 24)).toBe(true);
    expect(capture.summary()).toMatchObject({ averageFps: 50, frames: 1500, p99Ms: 20 });
});
