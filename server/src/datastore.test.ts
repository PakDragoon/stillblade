import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../shared/constants';
import { MATCH_KEEP_MONTHS, RECORD_KEEP_DAYS, RECORD_MAX_MB } from '../../shared/privacy';
import type { NetCmd } from '../../shared/protocol';
import { GRACE_MS } from '../../shared/rules';
import type { MapData } from '../../shared/types';
import { DataStore, dataConfigFromEnv } from './datastore';
import { Game } from './game';
import type { MatchLogLine } from './matchlog';
import { replayRecording } from './replay';
import { roomObserver } from './roomdata';

const TICK_MS = 1000 / TICK_RATE;
const temp = (): string => mkdtempSync(join(tmpdir(), 'sb-data-'));

function map(): MapData {
    return {
        name: 'greybox',
        bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
        boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }],
        spawns: { ghosts: [{ pos: [0, 0, 10], yaw: 0 }], defenders: [{ pos: [0, 0, -10], yaw: 180 }] },
        bombSites: [{ name: 'A', min: [-3, 0, 7], max: [3, 2.5, 13] }]
    };
}

const cmd = (seq: number, now: number, over: Partial<NetCmd> = {}): NetCmd => ({
    seq, forward: 0, right: 0, yaw: 0, pitch: Math.fround((seq % 2) * 0.01), jump: false, walk: false, crouch: false, fire: false,
    use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: now, ...over
});

describe('package W: the data folder', () => {
    it('defaults to ./data, keeps SB_FEEDBACK_FILE working, and reads the switches', () => {
        const d = dataConfigFromEnv({});
        expect(d.dir.replace(/\\/g, '/')).toMatch(/\/data$/);
        expect(d.feedbackFile).toBe(join(d.dir, 'feedback.log'));
        expect(d.record).toBe(true);
        expect(d.recordMaxBytes).toBe(RECORD_MAX_MB * 1024 * 1024);
        expect(d.recordKeepDays).toBe(RECORD_KEEP_DAYS);
        expect(d.matchKeepMonths).toBe(MATCH_KEEP_MONTHS);
        const e = dataConfigFromEnv({ SB_DATA_DIR: '/srv/x', SB_FEEDBACK_FILE: '', SB_RECORD: '0', SB_RECORD_MAX_MB: '5' });
        expect(e.feedbackFile).toBe('');
        expect(e.record).toBe(false);
        expect(e.recordMaxBytes).toBe(5 * 1024 * 1024);
        expect(dataConfigFromEnv({ SB_FEEDBACK_FILE: 'other.log' }).feedbackFile).toBe('other.log');
    });

    it('writes match lines in order and a real gzip recording that replays from disk', async () => {
        const dir = temp();
        const store = new DataStore({ ...dataConfigFromEnv({ SB_DATA_DIR: dir }) });
        expect(store.prepare()).toBe(true);
        const game = new Game(map(), { lobby: true, options: { roundsToWin: 3 } });
        game.code = 'disk';
        game.observer = roomObserver(store, { record: true, commit: 'abc' });
        const a = game.join({ send() {} }, 'Ann'), b = game.join({ send() {} }, 'Bob');
        game.handleMessage(a, { type: 'ready', ready: true });
        game.handleMessage(b, { type: 'ready', ready: true });
        let t = 0, seq = 0;
        for (; t < 30 * TICK_RATE; t++) {
            game.tick(t * TICK_MS);
            seq++;
            game.handleCmd(a, cmd(seq, game.now, { forward: 1 }));
            game.handleCmd(b, cmd(seq, game.now, { right: 1 }));
        }
        // Bob leaves: the match is held, and given up after the grace time.
        game.leave(b);
        for (const end = t + GRACE_MS / TICK_MS + 10; t < end; t++) { game.tick(t * TICK_MS); game.handleCmd(a, cmd(++seq, game.now)); }
        await store.flush();
        const months = readdirSync(join(dir, 'matches'));
        expect(months).toHaveLength(1);
        const lines = readFileSync(join(dir, 'matches', months[0]), 'utf8').trim().split('\n').map(l => JSON.parse(l) as MatchLogLine);
        expect(lines.map(l => l.type)).toEqual(['abandoned']);
        expect(lines[0]).toMatchObject({ why: 'hold expired', room: 'disk', rounds: 0 });
        const recs = readdirSync(join(dir, 'recordings'));
        expect(recs).toHaveLength(1);
        expect(recs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-disk-1\.sbrec\.gz$/);
        expect((lines[0] as { recording: string }).recording).toBe(recs[0]);
        const res = replayRecording(readFileSync(join(dir, 'recordings', recs[0])), new Map([['greybox', map()]]));
        expect(res.mismatch).toBeNull();
        expect(res.truncated).toBe(false);
        expect(res.checkpoints).toBeGreaterThan(60);
        expect(res.header.commit).toBe('abc');
    });

    it('numbers recordings so a second match on the same day never overwrites the first', async () => {
        const dir = temp();
        const store = new DataStore(dataConfigFromEnv({ SB_DATA_DIR: dir }));
        store.prepare();
        const s1 = store.openRecording('2026-11-20-room');
        s1.write(new Uint8Array([1, 2, 3]));
        await s1.end();
        const s2 = store.openRecording('2026-11-20-room');
        s2.write(new Uint8Array([4]));
        await s2.end();
        expect(readdirSync(join(dir, 'recordings')).sort()).toEqual(['2026-11-20-room-1.sbrec.gz', '2026-11-20-room-2.sbrec.gz']);
        expect(s2.name).toBe('2026-11-20-room-2.sbrec.gz');
    });

    it('a folder it cannot write warns and never throws', async () => {
        const dir = temp();
        const blocker = join(dir, 'file');
        writeFileSync(blocker, 'x'); // a file where a folder should be
        const warnings: string[] = [];
        const store = new DataStore(dataConfigFromEnv({ SB_DATA_DIR: join(blocker, 'data') }), m => warnings.push(m));
        expect(store.prepare()).toBe(false);
        store.appendMatchLine('2026-11.jsonl', () => '{}');
        const sink = store.openRecording('2026-11-20-x');
        sink.write(new Uint8Array(10));
        await sink.end();
        await store.flush();
        expect(warnings.length).toBeGreaterThanOrEqual(2);
        expect(warnings.every(w => w.startsWith('[data] '))).toBe(true);
    });

    it('deletes recordings past the age limit, then the oldest over the size limit, and old match months', async () => {
        const dir = temp();
        const now = Date.UTC(2026, 10, 20);
        const store = new DataStore({ ...dataConfigFromEnv({ SB_DATA_DIR: dir }), recordMaxBytes: 2500, recordKeepDays: 90, matchKeepMonths: 12 }, () => undefined, () => now);
        store.prepare();
        const rec = (name: string, bytes: number, daysAgo: number): void => {
            const p = join(dir, 'recordings', name);
            writeFileSync(p, Buffer.alloc(bytes));
            const t = (now - daysAgo * 86_400_000) / 1000;
            utimesSync(p, t, t);
        };
        rec('a.sbrec.gz', 100, 120); // too old
        rec('b.sbrec.gz', 1000, 10);
        rec('c.sbrec.gz', 1000, 5);
        rec('d.sbrec.gz', 1000, 1);
        writeFileSync(join(dir, 'recordings', 'notes.txt'), 'kept'); // not a recording
        for (const m of ['2025-10', '2025-11', '2025-12', '2026-11']) writeFileSync(join(dir, 'matches', `${m}.jsonl`), '');
        await store.prune();
        expect(readdirSync(join(dir, 'recordings')).sort()).toEqual(['c.sbrec.gz', 'd.sbrec.gz', 'notes.txt']);
        // Twelve months kept: December 2025 to November 2026.
        expect(readdirSync(join(dir, 'matches')).sort()).toEqual(['2025-12.jsonl', '2026-11.jsonl']);
        expect(existsSync(join(dir, 'recordings', 'b.sbrec.gz'))).toBe(false);
    });

    it('SB_RECORD=0 keeps match records but makes no recording', async () => {
        const dir = temp();
        const store = new DataStore(dataConfigFromEnv({ SB_DATA_DIR: dir, SB_RECORD: '0' }));
        store.prepare();
        const game = new Game(map(), { lobby: true });
        game.code = 'norec';
        game.observer = roomObserver(store, { record: store.cfg.record, commit: '' });
        const a = game.join({ send() {} }, 'Ann'), b = game.join({ send() {} }, 'Bob');
        game.handleMessage(a, { type: 'ready', ready: true });
        game.handleMessage(b, { type: 'ready', ready: true });
        for (let t = 0; t < 10 * TICK_RATE; t++) game.tick(t * TICK_MS);
        game.observer.matchAbandoned!(game, 'room closed');
        await store.flush();
        expect(readdirSync(join(dir, 'recordings'))).toEqual([]);
        const line = JSON.parse(readFileSync(join(dir, 'matches', readdirSync(join(dir, 'matches'))[0]), 'utf8')) as { recording: unknown; why: string };
        expect(line).toMatchObject({ why: 'room closed', recording: null });
    });
});
