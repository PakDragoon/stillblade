/**
 * Package W: what one room keeps (server/src/datastore.ts): its match records and, unless switched off,
 * its input recordings. `Rooms` attaches one of these to every room except practice ranges.
 */
import { execFileSync } from 'node:child_process';
import type { GameObserver } from './game-events';
import type { RecordingSink } from './datastore';
import { MatchLog } from './matchlog';
import { Recorder, commitFromEnv } from './recording';

type Hook = (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, g: unknown, h: unknown) => void;

/**
 * Wraps `inner` so that an exception in any hook is caught, reported once through `onError`, and switches
 * that observer off for good: a bug in record keeping must never stop a match.
 */
export function guardObserver(inner: GameObserver, onError: (err: unknown) => void): GameObserver {
    let broken = false;
    const out: GameObserver = {};
    const names = new Set<string>(Object.keys(inner));
    for (let proto = Object.getPrototypeOf(inner); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const k of Object.getOwnPropertyNames(proto)) if (k !== 'constructor') names.add(k);
    }
    for (const k of names) {
        const fn = (inner as Record<string, unknown>)[k];
        if (typeof fn !== 'function') continue;
        const f = fn as Hook;
        // Fixed parameters (the longest hook has seven), not `...args`: no array is made per command.
        (out as Record<string, unknown>)[k] = (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, g: unknown, h: unknown): void => {
            if (broken) return;
            try { f.call(inner, a, b, c, d, e, g, h); } catch (err) { broken = true; onError(err); }
        };
    }
    return out;
}

/** The part of `DataStore` a room uses (tests pass one that keeps everything in memory). */
export interface RoomDataStore {
    openRecording(base: string): RecordingSink;
    appendMatchLine(file: string, line: () => string): void;
    warn(kind: string, msg: string): void;
}

export interface RoomDataOptions {
    /** Record inputs (SB_RECORD); match records are kept regardless. */
    record: boolean;
    /** The server's commit, for recording headers. */
    commit: string;
}

/** The observer for one room: match records, plus the recorder when recording is on. */
export function roomObserver(store: RoomDataStore, opts: RoomDataOptions): GameObserver {
    const recorder = opts.record ? new Recorder(base => store.openRecording(base), opts.commit) : null;
    const log = new MatchLog(
        (month, line) => store.appendMatchLine(`${month}.jsonl`, () => JSON.stringify(line)),
        () => Date.now(),
        () => recorder?.current ?? null
    );
    const warn = (what: string) => (err: unknown): void => store.warn(what, `${what} switched off for a room after an error: ${(err as Error)?.stack ?? err}`);
    const parts: GameObserver[] = [guardObserver(log, warn('match records'))];
    if (recorder) parts.push(guardObserver(recorder, warn('recording')));
    return parts.length === 1 ? parts[0] : fanOut(parts);
}

/** Calls each observer in turn (the match log first, so its lines name the recording that is still open). */
function fanOut(parts: GameObserver[]): GameObserver {
    const out: GameObserver = {};
    const keys = new Set<string>();
    for (const p of parts) for (const k of Object.keys(p)) keys.add(k);
    for (const k of keys) {
        const fns = parts.map(p => (p as Record<string, unknown>)[k]).filter((f): f is Hook => typeof f === 'function');
        (out as Record<string, unknown>)[k] = fns.length === 1 ? fns[0]
            : (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, g: unknown, h: unknown): void => {
                for (let i = 0; i < fns.length; i++) fns[i](a, b, c, d, e, g, h);
            };
    }
    return out;
}

/** The git commit for recording headers: SB_COMMIT (set when the image is built), else asked of `git` once at startup. */
export function serverCommit(env: NodeJS.ProcessEnv = process.env): string {
    return commitFromEnv(env, () => {
        try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString(); }
        catch { return ''; } // no git in the container: SB_COMMIT is the way there
    });
}
