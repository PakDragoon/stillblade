/**
 * Package W: the server's data folder. Everything the server keeps lives under one folder that survives
 * rebuilds (`SB_DATA_DIR`; `./data` locally, `/data` in the container, a host folder mounted there):
 *
 *   feedback.log                    feedback notes and error reports (server/src/reports.ts), one JSON line each
 *   matches/<YYYY-MM>.jsonl         match records (server/src/matchlog.ts), one JSON line per round, match end or abandoned match
 *   recordings/<date>-<room>-<n>.sbrec.gz   input recordings (server/src/recording.ts), one gzip file per match
 *
 * Every write is asynchronous and queued; nothing here runs file I/O inside a game tick (callers hand over
 * buffers and thunks, the work happens on later turns of the event loop and in libuv's thread pool). A
 * failed write logs a warning (at most once a minute per kind) and never throws.
 */
import { mkdirSync, type WriteStream } from 'node:fs';
import { appendFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createGzip, type Gzip } from 'node:zlib';
import { MATCH_KEEP_MONTHS, RECORD_KEEP_DAYS, RECORD_MAX_MB } from '../../shared/privacy';

export interface DataConfig {
    /** The data folder (absolute). */
    dir: string;
    /** The feedback log path, or '' for console only. */
    feedbackFile: string;
    /** Input recordings on (`SB_RECORD`, default on). Match records are always on when there is a data folder. */
    record: boolean;
    /** Recordings kept at most this many bytes in all; the oldest are deleted first. */
    recordMaxBytes: number;
    /** Recordings older than this many days are deleted. */
    recordKeepDays: number;
    /** Monthly match-record files older than this many months are deleted. */
    matchKeepMonths: number;
}

/** Reads the configuration from the environment (see the file comment and DEPLOY.md). */
export function dataConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DataConfig {
    const dir = resolve(env.SB_DATA_DIR || 'data');
    const num = (v: string | undefined, fallback: number): number => {
        const n = Number(v);
        return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
        dir,
        // Kept working as before: an explicit path (or '' for console only) wins over the data folder.
        feedbackFile: env.SB_FEEDBACK_FILE ?? join(dir, 'feedback.log'),
        record: env.SB_RECORD !== '0',
        recordMaxBytes: num(env.SB_RECORD_MAX_MB, RECORD_MAX_MB) * 1024 * 1024,
        recordKeepDays: num(env.SB_RECORD_KEEP_DAYS, RECORD_KEEP_DAYS),
        matchKeepMonths: num(env.SB_MATCH_KEEP_MONTHS, MATCH_KEEP_MONTHS)
    };
}

/** "2026-11" for a time, in UTC. */
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
/** "2026-11-20" for a time, in UTC. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** An open recording: bytes go in, gzip and the file happen off the tick. */
export interface RecordingSink {
    /** The file name (no folder); final once the file is open (a taken name gets the next number). */
    readonly name: string;
    /** Hands over `bytes` (the sink keeps the array: pass a copy of a reused buffer). */
    write(bytes: Uint8Array): void;
    /** Finishes the file; resolves when it is on disk (or failed). */
    end(): Promise<void>;
}

export class DataStore {
    private readonly chains = new Map<string, Promise<void>>();
    private readonly open = new Set<Promise<void>>();
    private readonly warnedAt = new Map<string, number>();
    private pruning: Promise<void> | null = null;
    readonly matchesDir: string;
    readonly recordingsDir: string;

    constructor(
        readonly cfg: DataConfig,
        private readonly warnOut: (msg: string) => void = msg => console.warn(msg),
        private readonly clock: () => number = () => Date.now()
    ) {
        this.matchesDir = join(cfg.dir, 'matches');
        this.recordingsDir = join(cfg.dir, 'recordings');
    }

    /**
     * Startup only (synchronous, before the game loop runs): creates the folders and reports clearly if they
     * cannot be written, so a wrong owner on the host folder shows in the log at once.
     */
    prepare(): boolean {
        try {
            for (const d of [this.cfg.dir, this.matchesDir, this.recordingsDir]) mkdirSync(d, { recursive: true });
            return true;
        } catch (err) {
            this.warn('dir', `data folder ${this.cfg.dir} cannot be created or written (${(err as Error).message}); match records and recordings will not be kept`);
            return false;
        }
    }

    /** A warning, at most once a minute per `kind`. */
    warn(kind: string, msg: string): void {
        const now = this.clock();
        const last = this.warnedAt.get(kind);
        if (last !== undefined && now - last < 60_000) return;
        this.warnedAt.set(kind, now);
        this.warnOut(`[data] ${msg}`);
    }

    /**
     * Appends one line to `matches/<file>`. `line` is called later, off the tick (so a large record is turned
     * into text outside the game loop); lines to one file are written in order.
     */
    appendMatchLine(file: string, line: () => string): void {
        const path = join(this.matchesDir, file);
        const prev = this.chains.get(path) ?? Promise.resolve();
        const next = prev.then(async () => {
            await new Promise<void>(r => setImmediate(r));
            await mkdir(this.matchesDir, { recursive: true });
            await appendFile(path, `${line()}\n`);
        }).catch(err => this.warn('matches', `match record not written to ${path}: ${(err as Error).message}`));
        this.chains.set(path, next);
        void next.then(() => { if (this.chains.get(path) === next) this.chains.delete(path); });
    }

    /**
     * Starts a recording file named `<base>-<n>.sbrec.gz` with the first free `n` from 1. Returns at once;
     * the file is found and opened asynchronously and gzip runs in the thread pool. Write errors warn once
     * and the rest of that recording is dropped.
     */
    openRecording(base: string): RecordingSink {
        const gzip: Gzip = createGzip({ level: 6 });
        let failed = false;
        let file: WriteStream | null = null;
        const sink = {
            name: `${base}-1.sbrec.gz`,
            write: (bytes: Uint8Array): void => { if (!failed) gzip.write(bytes); },
            end: (): Promise<void> => Promise.resolve()
        };
        const fail = (err: unknown): void => {
            if (!failed) this.warn('recording', `recording ${sink.name} not written: ${(err as Error).message}`);
            failed = true;
        };
        gzip.on('error', fail);
        const opened = (async () => {
            await mkdir(this.recordingsDir, { recursive: true });
            for (let n = 1; n < 1000; n++) {
                const name = `${base}-${n}.sbrec.gz`;
                try {
                    const fh = await open(join(this.recordingsDir, name), 'wx');
                    sink.name = name;
                    // The stream owns the handle (and closes it at the end); a bare fd would be closed when
                    // the handle object is garbage-collected, mid-recording.
                    file = fh.createWriteStream();
                    file.on('error', fail);
                    gzip.pipe(file);
                    return;
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
                }
            }
            throw new Error('no free file name');
        })().catch(err => { fail(err); gzip.resume(); });
        let ending: Promise<void> | null = null;
        sink.end = (): Promise<void> => {
            if (ending) return ending;
            const p: Promise<void> = (async () => {
                await opened;
                await new Promise<void>(r => {
                    const f = file as WriteStream | null;
                    if (f && !failed) { f.once('close', () => r()); f.once('error', () => r()); gzip.end(); }
                    else { gzip.resume(); gzip.end(); setImmediate(r); }
                });
            })();
            ending = p;
            this.open.add(p);
            void p.then(() => { this.open.delete(p); void this.prune(); });
            return p;
        };
        return sink;
    }

    /**
     * Deletes old data: recordings older than `recordKeepDays` and then the oldest until the folder is under
     * `recordMaxBytes`; monthly match files older than `matchKeepMonths`. Runs at startup and after every
     * recording closes; one at a time.
     */
    prune(): Promise<void> {
        return this.pruning ??= this.pruneNow()
            .catch(err => this.warn('prune', `old data not cleaned up: ${(err as Error).message}`))
            .finally(() => { this.pruning = null; });
    }

    private async pruneNow(): Promise<void> {
        const now = this.clock();
        const files: { path: string; size: number; mtime: number }[] = [];
        for (const name of await readdir(this.recordingsDir).catch(() => [] as string[])) {
            if (!name.endsWith('.sbrec.gz')) continue;
            const path = join(this.recordingsDir, name);
            const s = await stat(path).catch(() => null);
            if (s?.isFile()) files.push({ path, size: s.size, mtime: s.mtimeMs });
        }
        files.sort((a, b) => a.mtime - b.mtime || (a.path < b.path ? -1 : 1));
        let total = files.reduce((n, f) => n + f.size, 0);
        const oldest = now - this.cfg.recordKeepDays * 86_400_000;
        for (const f of files) {
            if (f.mtime >= oldest && total <= this.cfg.recordMaxBytes) break;
            await unlink(f.path).catch(() => undefined);
            total -= f.size;
        }
        // Match records: whole months, by file name.
        const d = new Date(now);
        const keepFrom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - this.cfg.matchKeepMonths + 1, 1)).toISOString().slice(0, 7);
        for (const name of await readdir(this.matchesDir).catch(() => [] as string[])) {
            const m = /^(\d{4}-\d{2})\.jsonl$/.exec(name);
            if (m && m[1] < keepFrom) await unlink(join(this.matchesDir, name)).catch(() => undefined);
        }
    }

    /** Waits for every queued line and open recording (call `end` on recordings first). */
    async flush(): Promise<void> {
        await Promise.all([...this.chains.values(), ...this.open]);
        if (this.pruning) await this.pruning;
    }
}
