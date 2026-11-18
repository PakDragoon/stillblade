import { describe, expect, it } from 'vitest';
import { LoadTracker, STALL_MS, UNKNOWN_SIZE, formatBytes, type StepId } from './loading';
import { publicPath } from './fetch-progress';
import { mapFiles, sizes } from 'virtual:asset-sizes';

/** A tracker on a hand-moved clock, with sizes from a table. */
function setup(table: Record<string, number> = {}) {
    let t = 0;
    const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
    const tracker = new LoadTracker(clock.now, url => table[url] ?? null);
    return { tracker, clock };
}

describe('progress weighting', () => {
    it('weights download steps by bytes', () => {
        const { tracker } = setup({ a: 900, b: 100 });
        tracker.define('map', 'Map', { kind: 'bytes' });
        tracker.define('weapons', 'Weapons', { kind: 'bytes' });
        const a = tracker.file('map', 'a', 'geometry');
        const b = tracker.file('weapons', 'b', 'rifle');
        const screen = tracker.screen(['map', 'weapons']);
        b.begin(null); b.progress(100); b.done();
        // The small file finishing is only a tenth of the bar.
        expect(screen.read(0).shown).toBeCloseTo(0.1);
        a.begin(null); a.progress(450);
        expect(screen.read(0).shown).toBeCloseTo(0.55);
        a.progress(900); a.done();
        const v = screen.read(0);
        expect(v.complete).toBe(true);
        expect(v.shown).toBe(1);
        expect(v.percent).toBe(100);
    });

    it('gives time-only steps a fixed share', () => {
        const { tracker, clock } = setup({ a: 1000 });
        tracker.define('connect', 'Connecting to server', { kind: 'timed', share: 0.1, expectedMs: 1000 });
        tracker.define('map', 'Map', { kind: 'bytes' });
        tracker.file('map', 'a', 'geometry');
        const screen = tracker.screen(['connect', 'map']);
        expect(screen.read(clock.now()).shown).toBe(0);
        tracker.begin('connect');
        clock.advance(100_000);
        // A long connect creeps toward 90 % of its share, never past it.
        const creeping = screen.read(clock.now()).shown;
        expect(creeping).toBeGreaterThan(0.08);
        expect(creeping).toBeLessThanOrEqual(0.09 + 1e-9);
        tracker.end('connect');
        expect(screen.read(clock.now()).shown).toBeCloseTo(0.1);
        expect(screen.read(clock.now()).current).toBe('Map…');
    });

    it('skipped steps leave the list and the bar', () => {
        const { tracker } = setup({ a: 100 });
        tracker.define('graphics', 'Checking your graphics', { kind: 'timed', share: 0.5 });
        tracker.define('map', 'Map', { kind: 'bytes' });
        tracker.skip('graphics');
        const f = tracker.file('map', 'a', 'geometry');
        const screen = tracker.screen(['graphics', 'map']);
        f.begin(null); f.progress(50);
        const v = screen.read(0);
        expect(v.steps.map(s => s.id)).toEqual(['map']);
        expect(v.shown).toBeCloseTo(0.5);
    });

    it('says what is loading in plain words', () => {
        const { tracker } = setup({ geo: 1_263_144, light: 867_374 });
        tracker.define('map', 'Map: Warehouse', { kind: 'bytes' });
        tracker.define('sounds', 'Sounds', { kind: 'bytes' });
        const geo = tracker.file('map', 'geo', 'geometry');
        const light = tracker.file('map', 'light', 'lighting');
        geo.begin(null); geo.progress(1_263_144); geo.done();
        light.begin(null); light.progress(400_000);
        const screen = tracker.screen(['map', 'sounds']);
        expect(screen.read(0).current).toBe('Map: Warehouse (lighting) 1.7 / 2.1 MB');
        light.done();
        const s = Array.from({ length: 4 }, (_, i) => tracker.file('sounds', `s${i}`, 'step'));
        s[0].begin(null); s[0].progress(3000); s[0].done();
        const v = screen.read(0);
        expect(v.current).toBe('Sounds 1 / 4');
        expect(v.steps.find(x => x.id === 'map')!.detail).toBe('2.1 / 2.1 MB');
    });

    it('names the step that is moving: a needed one before an optional one, either before one still waiting', () => {
        const { tracker } = setup({ a: 200_000, b: 300_000 });
        tracker.define('graphics', 'Checking your graphics', { kind: 'timed', share: 0.04, optional: true });
        tracker.define('map', 'Map: Warehouse', { kind: 'bytes' });
        tracker.define('hands', 'First-person hands', { kind: 'bytes', optional: true });
        const screen = tracker.screen(['graphics', 'map', 'hands']);
        expect(screen.read(0).current).toBe('Checking your graphics…'); // nothing moving: the first waiting step
        tracker.file('hands', 'b', 'rifle').begin(null);
        expect(screen.read(0).current).toBe('First-person hands (rifle) 0 / 300 KB'); // only the hands move
        tracker.begin('graphics');
        const m = tracker.file('map', 'a', 'geometry');
        m.begin(null); m.progress(50_000);
        expect(screen.read(0).current).toBe('Map: Warehouse (geometry) 50 / 200 KB'); // the needed step wins
    });

    it('formats sizes', () => {
        expect(formatBytes(12_400_000, 31_000_000)).toBe('12.4 / 31.0 MB');
        expect(formatBytes(120_000, 323_307)).toBe('120 / 323 KB');
    });
});

describe('unknown sizes', () => {
    it('uses the Content-Length when the manifest does not know the file', () => {
        const { tracker } = setup();
        tracker.define('map', 'Map', { kind: 'bytes' });
        const f = tracker.file('map', 'x', 'geometry');
        const screen = tracker.screen(['map']);
        f.begin(2000);
        f.progress(500);
        expect(screen.read(0).shown).toBeCloseTo(0.25);
    });

    it('guesses, grows with what arrives, never passes 99 % before the end, never goes backwards', () => {
        const { tracker } = setup();
        tracker.define('map', 'Map', { kind: 'bytes' });
        const f = tracker.file('map', 'x', 'geometry');
        const screen = tracker.screen(['map']);
        f.begin(null);
        f.progress(UNKNOWN_SIZE / 2);
        expect(screen.read(0).shown).toBeCloseTo(0.5);
        // More than the guess arrives: the total grows with it, the bar holds at 99 % (raw fraction would be 1).
        f.progress(UNKNOWN_SIZE * 3);
        const v = screen.read(0);
        expect(v.shown).toBeLessThanOrEqual(0.99);
        expect(v.percent).toBe(99);
        expect(v.complete).toBe(false);
        f.done();
        expect(screen.read(0).shown).toBe(1);
    });

    it('a new larger file does not move the bar back', () => {
        const { tracker } = setup({ a: 100, b: 10_000 });
        tracker.define('weapons', 'Weapons', { kind: 'bytes' });
        const a = tracker.file('weapons', 'a', 'rifle');
        const screen = tracker.screen(['weapons']);
        a.begin(null); a.progress(100); a.done();
        expect(screen.read(0).shown).toBe(1); // all known files done: complete
        const b = tracker.file('weapons', 'b', 'pistol');
        b.begin(null);
        const v = screen.read(0);
        expect(v.complete).toBe(false);
        expect(v.shown).toBe(1); // raw fraction dropped to 1 %, the bar did not
    });
});

describe('cached files', () => {
    it('a cached file finishes instantly and counts its full size', () => {
        const { tracker } = setup({ a: 5000, b: 5000 });
        tracker.define('characters', 'Characters', { kind: 'bytes' });
        const a = tracker.file('characters', 'a', 'models');
        const b = tracker.file('characters', 'b', 'textures');
        const screen = tracker.screen(['characters']);
        a.done(true); // the engine already held it: no bytes reported at all
        expect(screen.read(0).shown).toBeCloseTo(0.5);
        b.begin(null); b.progress(5000); b.done(true);
        const v = screen.read(0);
        expect(v.complete).toBe(true);
        expect(v.steps[0].cached).toBe(true);
        expect(v.steps[0].detail).toBe('10 / 10 KB');
    });

    it('a screen whose steps all finished before it opened reads 100 % at once', () => {
        const { tracker } = setup({ a: 1 });
        tracker.define('hands', 'First-person hands', { kind: 'bytes' });
        tracker.file('hands', 'a', 'rifle').done(true);
        const v = tracker.screen(['hands']).read(0);
        expect(v.shown).toBe(1);
        expect(v.current).toBe('Ready');
    });
});

describe('failures and retry', () => {
    it('holds a failed download for the player, and retrying starts it again', () => {
        const { tracker } = setup({ a: 100 });
        tracker.holding = true;
        tracker.define('map', 'Map: Warehouse', { kind: 'bytes' });
        const f = tracker.file('map', 'a', 'geometry');
        const screen = tracker.screen(['map']);
        let retried = 0, gaveUp = 0;
        f.begin(null); f.progress(60);
        f.fail('HTTP 503', () => retried++, () => gaveUp++);
        let v = screen.read(0);
        expect(v.failed).toBe(true);
        expect(v.canContinue).toBe(false); // the map is needed: Back to menu, not Continue
        expect(v.complete).toBe(false);
        expect(v.current).toBe('Download failed: Map: Warehouse');
        const before = v.shown;
        tracker.retryFailed();
        expect(retried).toBe(1);
        expect(gaveUp).toBe(0);
        v = screen.read(0);
        expect(v.failed).toBe(false);
        expect(v.shown).toBe(before); // starts again from 0 bytes, the bar holds
        f.begin(null); f.progress(100); f.done();
        expect(screen.read(0).complete).toBe(true);
        tracker.retryFailed(); // nothing pending: nothing happens
        expect(retried).toBe(1);
    });

    it('optional steps can be continued without; giving up finishes them', () => {
        const { tracker } = setup({ a: 100, b: 100 });
        tracker.holding = true;
        tracker.define('map', 'Map', { kind: 'bytes' });
        tracker.define('sounds', 'Sounds', { kind: 'bytes', optional: true });
        const m = tracker.file('map', 'a', 'geometry');
        const s = tracker.file('sounds', 'b', 'step');
        const screen = tracker.screen(['map', 'sounds']);
        m.done();
        let gaveUp = 0;
        s.fail('network', () => { /* not chosen */ }, () => gaveUp++);
        let v = screen.read(0);
        expect(v.failed).toBe(true);
        expect(v.canContinue).toBe(true);
        expect(v.requiredComplete).toBe(true);
        tracker.giveUpFailed();
        expect(gaveUp).toBe(1);
        v = screen.read(0);
        expect(v.failed).toBe(false);
        expect(v.complete).toBe(true);
        expect(v.shown).toBe(1);
        expect(v.steps.find(x => x.id === 'sounds')!.state).toBe('failed');
    });

    it('gives up at once when no screen holds failures', () => {
        const { tracker } = setup({ a: 100 });
        tracker.define('weapons', 'Weapons', { kind: 'bytes', optional: true });
        const f = tracker.file('weapons', 'a', 'rifle');
        let gaveUp = 0;
        f.fail('network', () => { /* never */ }, () => gaveUp++);
        expect(gaveUp).toBe(1);
        expect(tracker.screen(['weapons']).read(0).complete).toBe(true);
    });

    it('a final failure (a file that will not parse) finishes the step without asking', () => {
        const { tracker } = setup({ a: 100 });
        tracker.holding = true;
        tracker.define('hands', 'First-person hands', { kind: 'bytes', optional: true });
        tracker.file('hands', 'a', 'rifle').fail('bad file');
        const v = tracker.screen(['hands']).read(0);
        expect(v.failed).toBe(false);
        expect(v.complete).toBe(true);
    });
});

describe('stalls', () => {
    it('notes a step with no progress for 10 s, and clears when bytes move', () => {
        const { tracker, clock } = setup({ a: 1000 });
        tracker.define('map', 'Map', { kind: 'bytes' });
        const f = tracker.file('map', 'a', 'geometry');
        const screen = tracker.screen(['map']);
        f.begin(null); f.progress(10);
        clock.advance(STALL_MS - 1);
        expect(screen.read(clock.now()).stalled).toBe(false);
        clock.advance(2);
        expect(screen.read(clock.now()).stalled).toBe(true);
        f.progress(20);
        expect(screen.read(clock.now()).stalled).toBe(false);
    });

    it('a step waiting since before the screen opened is not stalled at once', () => {
        const { tracker, clock } = setup();
        tracker.define('sounds', 'Sounds', { kind: 'bytes' });
        tracker.file('sounds', 'a', 'step');
        clock.advance(60_000);
        const screen = tracker.screen(['sounds']);
        expect(screen.read(clock.now()).stalled).toBe(false);
        clock.advance(STALL_MS + 1);
        expect(screen.read(clock.now()).stalled).toBe(true);
    });
});

describe('the same file announced twice', () => {
    it('is one file: a loader may announce its files first and fetch them later', () => {
        const { tracker } = setup({ a: 100, b: 300 });
        tracker.define('map', 'Map', { kind: 'bytes' });
        tracker.file('map', 'a', 'layout');
        tracker.file('map', 'b', 'lighting');
        const screen = tracker.screen(['map']);
        const again = tracker.file('map', 'b', 'lighting');
        again.begin(null); again.progress(300); again.done();
        const v = screen.read(0);
        expect(v.steps[0].count).toBe(2);
        expect(v.shown).toBeCloseTo(0.75);
    });

    it('redefining a step empties it (a map change)', () => {
        const { tracker } = setup({ a: 100 });
        tracker.define('map', 'Map: Test Map 1', { kind: 'bytes' });
        tracker.file('map', 'a', 'geometry').done();
        tracker.define('map', 'Map: Warehouse', { kind: 'bytes' });
        const ids: StepId[] = ['map'];
        const v = tracker.screen(ids).read(0);
        expect(v.steps[0].title).toBe('Map: Warehouse');
        expect(v.steps[0].state).toBe('waiting');
        expect(v.complete).toBe(false);
    });
});

describe('the size manifest', () => {
    it('measures the shipped files and lists every file a map loads', () => {
        expect(sizes['maps/warehouse.glb']).toBeGreaterThan(100_000);
        const files = mapFiles.warehouse;
        expect(files.slice(0, 2)).toEqual(['maps/warehouse.json', 'maps/warehouse.glb']);
        expect(files).toContain('maps/warehouse_baked.webp');
        expect(files).toContain('maps/sky.jpg');
        for (const f of files) expect(sizes[f]).toBeGreaterThan(0);
        expect(mapFiles.index).toBeUndefined();
    });

    it('maps the URLs the client fetches to manifest paths', () => {
        expect(publicPath('./maps/warehouse.glb', './')).toBe('maps/warehouse.glb');
        expect(publicPath('/sub/models/weapons.glb', '/sub/')).toBe('models/weapons.glb');
        expect(publicPath('https://example.com/audio/ui_click_1.mp3?v=2', './')).toBe('audio/ui_click_1.mp3');
    });
});
