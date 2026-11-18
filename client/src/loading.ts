/**
 * Load progress for the loading screen: every download the client makes (the map and its textures, the weapons,
 * characters, first-person hands and sounds) and the steps that only take time (connecting, the graphics check,
 * building the map's lighting) report here, and a `LoadScreen` turns them into one bar, a line saying what is loading
 * right now, and a list of steps ticked off as they finish. Pure: no DOM, no engine, no network, so it is tested
 * directly (`loading.test.ts`); `fetch-progress.ts` is the browser side that feeds it bytes.
 *
 * Only asset and connection steps exist here: nothing about other players is ever shown.
 *
 * How the bar is weighted: download steps by their bytes, and each time-only step by a fixed share of the bar
 * (`share`, for example 0.05), so a 3 MB map is most of the bar and connecting is a small slice of it. Sizes come from
 * a manifest built from `client/public` at build time (`asset-sizes.ts`), so the totals are known before anything
 * arrives and the bar does not jump back when a new file starts. A file missing from it uses its Content-Length, or a
 * guess (`UNKNOWN_SIZE`) that grows with what arrives. The bar shown never goes backwards, never passes 100 %, and
 * sits at 99 % at most until every step has finished.
 */

export type StepId = 'connect' | 'graphics' | 'map' | 'lighting' | 'weapons' | 'characters' | 'hands' | 'sounds';
export type StepState = 'waiting' | 'active' | 'done' | 'failed' | 'skipped';
type ItemState = 'waiting' | 'loading' | 'done' | 'failed' | 'skipped';

/** No progress on the current step for this long shows the "taking longer than usual" note (ms). */
export const STALL_MS = 10_000;
/** The size assumed for a file the manifest does not know and whose server sends no length (bytes). */
export const UNKNOWN_SIZE = 512 * 1024;
/** A time-only step in progress fills at most this much of its share until it really ends. */
const TIMED_CAP = 0.9;

/** One file's download, as its loader reports it. */
export interface FileTrack {
    /** The response arrived; `headerTotal` is its Content-Length when that is the real size (not compressed), else null. */
    begin(headerTotal: number | null): void;
    /** Bytes received so far. */
    progress(loaded: number): void;
    /** All bytes are in; `cached` when they came from the browser's cache (or a file already loaded this session). */
    done(cached?: boolean): void;
    /**
     * The download failed. With `retry` and `giveUp`, it waits for the player's answer while a loading screen holds
     * failures (`LoadTracker.holding`), and gives up at once when nobody can answer; without them it is final.
     */
    fail(message: string, retry?: () => void, giveUp?: () => void): void;
    /** Not needed after all (sounds without Web Audio). */
    skip(): void;
}

/** What loaders see: a track for one file of one step. */
export interface LoadReporter {
    file(step: StepId, url: string, label: string): FileTrack;
}

interface Item {
    label: string;
    expected: number | null;
    headerTotal: number | null;
    loaded: number;
    state: ItemState;
    cached: boolean;
    retry: (() => void) | null;
    giveUp: (() => void) | null;
}

export interface StepOptions {
    /** 'bytes': weighted by its files' sizes. 'timed': a fixed `share` of the bar. */
    kind: 'bytes' | 'timed';
    /** Time-only steps: the fraction of the whole bar this step stands for. */
    share?: number;
    /** Time-only steps: about how long it takes (ms); the bar creeps toward 90 % of the share over this time. */
    expectedMs?: number;
    /** The game can start without it (box stand-ins, synthesised sounds): offers "Continue without" when it fails. */
    optional?: boolean;
}

interface Step extends Required<StepOptions> {
    id: StepId;
    title: string;
    items: Map<string, Item>;
    /** Time-only steps' own state (download steps derive theirs from their files). */
    timed: StepState;
    startedAt: number;
    /** Last time anything happened in this step (ms), for the stall note. */
    activity: number;
    /** Explicitly not needed (the graphics check when the tier is already known). */
    skipped: boolean;
}

export interface StepView {
    id: StepId;
    title: string;
    state: StepState;
    /** Bytes in and the step's total (0 for time-only steps). */
    loaded: number;
    total: number;
    /** Files done (or skipped) and files in all. */
    doneCount: number;
    count: number;
    /** Every finished file came from the cache. */
    cached: boolean;
    /** The size column: "1.2 / 2.9 MB", "18 / 74 · 120 / 323 KB", or ''. */
    detail: string;
    /** A failed download waits for Try again / Continue without. */
    pendingRetry: boolean;
    optional: boolean;
}

export interface ScreenView {
    /** The bar as shown, 0..1: never backwards, and it reaches 1 only by `complete` (or held there by never-backwards). */
    shown: number;
    /** Whole percent for the label. */
    percent: number;
    /** What is loading right now, in plain words. */
    current: string;
    steps: StepView[];
    /** The current step has made no progress for `STALL_MS`. */
    stalled: boolean;
    /** Some download failed and waits for an answer. */
    failed: boolean;
    /** Every failed step can be done without. */
    canContinue: boolean;
    /** Every step finished (done, skipped, or failed for good). */
    complete: boolean;
    /** Every step the game cannot start without has finished. */
    requiredComplete: boolean;
}

/** "1.2 / 2.9 MB", or "120 / 323 KB" for totals under about a megabyte. */
export function formatBytes(loaded: number, total: number): string {
    if (total >= 950_000) return `${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
    return `${Math.round(loaded / 1e3)} / ${Math.round(total / 1e3)} KB`;
}

/** A file's size for the weighting: what arrived if more than expected, else the best guess. */
function itemTotal(i: Item): number {
    if (i.state === 'skipped') return 0;
    const guess = i.expected ?? i.headerTotal ?? (i.state === 'done' && i.loaded > 0 ? i.loaded : UNKNOWN_SIZE);
    return Math.max(i.loaded, guess);
}

/** Bytes counted as in: a finished or given-up file counts whole (a cached one never reports its bytes). */
function itemLoaded(i: Item): number {
    if (i.state === 'done' || (i.state === 'failed' && !i.retry)) return itemTotal(i);
    return Math.min(i.loaded, itemTotal(i));
}

export class LoadTracker implements LoadReporter {
    private readonly steps = new Map<StepId, Step>();
    /**
     * A loading screen is up that can ask the player what to do about a failed download. While false, a failed
     * download gives up at once (its loader falls back as it always did).
     */
    holding = false;

    constructor(private readonly now: () => number, private readonly sizeOf: (url: string) => number | null = () => null) {}

    /** Defines (or redefines, emptied) a step. */
    define(id: StepId, title: string, opts: StepOptions): void {
        const t = this.now();
        this.steps.set(id, {
            id, title, kind: opts.kind, share: opts.share ?? 0, expectedMs: opts.expectedMs ?? 1000, optional: opts.optional ?? false,
            items: new Map(), timed: 'waiting', startedAt: t, activity: t, skipped: false
        });
    }

    /** Renames a step ("Map" becomes "Map: Warehouse" once the room's map is known). */
    rename(id: StepId, title: string): void {
        const s = this.steps.get(id);
        if (s) s.title = title;
    }

    private step(id: StepId): Step {
        const s = this.steps.get(id);
        if (!s) throw new Error(`load step ${id} is not defined`);
        return s;
    }

    private touch(s: Step): void {
        s.activity = this.now();
    }

    /** A time-only step started. */
    begin(id: StepId): void {
        const s = this.step(id);
        s.timed = 'active';
        s.skipped = false;
        s.startedAt = this.now();
        this.touch(s);
    }

    /** A time-only step ended. */
    end(id: StepId): void {
        const s = this.step(id);
        s.timed = 'done';
        this.touch(s);
    }

    /** The step is not needed: it disappears from the list and the bar (its files too). */
    skip(id: StepId): void {
        const s = this.step(id);
        s.skipped = true;
        for (const i of s.items.values()) if (i.state !== 'done') i.state = 'skipped';
        this.touch(s);
    }

    /**
     * A track for one file of a step. The same URL in the same step is the same file: a loader may announce its
     * files up front (so the totals are right from the start) and ask again when it fetches each one.
     */
    file(stepId: StepId, url: string, label: string): FileTrack {
        const s = this.step(stepId);
        let item = s.items.get(url);
        if (!item) {
            item = { label, expected: this.sizeOf(url), headerTotal: null, loaded: 0, state: 'waiting', cached: false, retry: null, giveUp: null };
            s.items.set(url, item);
            this.touch(s);
        }
        const i = item;
        return {
            begin: headerTotal => {
                i.state = 'loading';
                i.loaded = 0;
                i.headerTotal = headerTotal && headerTotal > 0 ? headerTotal : null;
                i.retry = i.giveUp = null;
                this.touch(s);
            },
            progress: loaded => {
                if (i.state !== 'loading') i.state = 'loading';
                if (loaded > i.loaded) { i.loaded = loaded; this.touch(s); }
            },
            done: cached => {
                i.state = 'done';
                i.cached = !!cached;
                i.retry = i.giveUp = null;
                this.touch(s);
            },
            fail: (message, retry, giveUp) => {
                void message;
                i.state = 'failed';
                this.touch(s);
                if (retry && giveUp && this.holding) {
                    i.retry = () => {
                        i.state = 'loading';
                        i.loaded = 0;
                        i.retry = i.giveUp = null;
                        this.touch(s);
                        retry();
                    };
                    i.giveUp = () => { i.retry = i.giveUp = null; giveUp(); };
                } else {
                    i.retry = i.giveUp = null;
                    giveUp?.();
                }
            },
            skip: () => {
                i.state = 'skipped';
                this.touch(s);
            }
        };
    }

    /** Tries every failed download that waits for an answer again. */
    retryFailed(): void {
        for (const s of this.steps.values()) for (const i of s.items.values()) i.retry?.();
    }

    /** Gives up every failed download that waits for an answer (their loaders fall back or report the failure). */
    giveUpFailed(): void {
        for (const s of this.steps.values()) for (const i of s.items.values()) i.giveUp?.();
    }

    /** A screen showing these steps, in this order, from now. */
    screen(ids: readonly StepId[]): LoadScreen {
        return new LoadScreen(this, ids, this.now());
    }

    /** One step as the screen shows it (null if it was never defined). */
    view(id: StepId): (StepView & { activity: number; startedAt: number; share: number; expectedMs: number; kind: 'bytes' | 'timed'; part: string }) | null {
        const s = this.steps.get(id);
        if (!s) return null;
        let loaded = 0, total = 0, doneCount = 0, count = 0, pendingRetry = false;
        let anyLoading = false, anyFailed = false, allCached = true, finishedAny = false;
        /** The file loading right now with the most left to come: names the part ("lighting", "rifle"). */
        let part = '', partLeft = -1;
        for (const i of s.items.values()) {
            if (i.state === 'skipped') continue;
            count++;
            total += itemTotal(i);
            loaded += itemLoaded(i);
            if (i.state === 'done') { doneCount++; finishedAny = true; if (!i.cached) allCached = false; }
            if (i.state === 'loading') {
                anyLoading = true;
                const left = itemTotal(i) - i.loaded;
                if (left > partLeft) { partLeft = left; part = i.label; }
            }
            if (i.state === 'failed') { anyFailed = true; if (i.retry) pendingRetry = true; }
        }
        let state: StepState;
        if (s.skipped) state = 'skipped';
        else if (s.kind === 'timed') state = s.timed;
        else if (count === 0) state = s.items.size > 0 ? 'skipped' : 'waiting';
        else if (anyFailed) state = 'failed';
        else if (doneCount === count) state = 'done';
        else if (anyLoading || doneCount > 0) state = 'active';
        else state = 'waiting';
        let detail = '';
        if (s.kind === 'bytes' && count > 0) {
            detail = formatBytes(loaded, total);
            if (id === 'sounds') detail = `${doneCount} / ${count} · ${detail}`;
        }
        return {
            id, title: s.title, state, loaded, total, doneCount, count, cached: finishedAny && allCached && doneCount === count,
            detail, pendingRetry, optional: s.optional, activity: s.activity, startedAt: s.startedAt, share: s.share,
            expectedMs: s.expectedMs, kind: s.kind, part
        };
    }
}

/** A finished step: done, not needed, or failed with nothing left to try. */
function finished(v: StepView): boolean {
    return v.state === 'done' || v.state === 'skipped' || (v.state === 'failed' && !v.pendingRetry);
}

/**
 * One loading screen's view of the tracker: the steps it lists, the bar (kept from going backwards), and when it
 * opened (a step that has been waiting since before the screen opened is not "stalled" the moment it appears).
 */
export class LoadScreen {
    private shown = 0;

    constructor(private readonly tracker: LoadTracker, readonly ids: readonly StepId[], private readonly openedAt: number) {}

    /** The raw weighted fraction, 0..1 (may go down when a file larger than expected turns up). */
    static fraction(steps: readonly NonNullable<ReturnType<LoadTracker['view']>>[], now: number): number {
        let shares = 0, timed = 0, loaded = 0, total = 0, bytesSteps = 0, bytesDone = 0;
        for (const v of steps) {
            if (v.state === 'skipped') continue;
            if (v.kind === 'timed') {
                shares += v.share;
                if (v.state === 'done') timed += v.share;
                else if (v.state === 'active') {
                    const t = Math.max(0, now - v.startedAt) / Math.max(1, v.expectedMs);
                    timed += v.share * TIMED_CAP * (1 - Math.exp(-t));
                }
            } else {
                bytesSteps++;
                if (finished(v)) bytesDone++;
                loaded += v.loaded;
                total += v.total;
            }
        }
        // Download steps that have not announced any file yet weigh nothing; with no bytes at all, count steps.
        const bytesPart = total > 0 ? loaded / total : bytesSteps > 0 ? bytesDone / bytesSteps : 1;
        if (shares >= 1) return timed / shares;
        const f = bytesPart * (1 - shares) + timed;
        return Math.min(1, Math.max(0, f));
    }

    read(now: number): ScreenView {
        const all = this.ids.map(id => this.tracker.view(id)).filter((v): v is NonNullable<typeof v> => v !== null);
        const visible = all.filter(v => v.state !== 'skipped');
        const complete = visible.every(finished);
        const requiredComplete = visible.every(v => v.optional || finished(v));
        const fraction = LoadScreen.fraction(visible, now);
        // Never backwards beats the 99 % cap: a bar that was full stays full if a late file turns up.
        this.shown = complete ? 1 : Math.max(this.shown, Math.min(0.99, fraction));
        const failedSteps = visible.filter(v => v.pendingRetry);
        // The line names what is moving: a needed step in progress first, then an optional one, then the next waiting.
        const currentStep = failedSteps[0]
            ?? visible.find(v => v.state === 'active' && !v.optional)
            ?? visible.find(v => v.state === 'active')
            ?? visible.find(v => !finished(v)) ?? null;
        let current = 'Ready';
        if (failedSteps.length > 0) {
            current = `Download failed: ${failedSteps.map(v => v.title).join(', ')}`;
        } else if (currentStep) {
            if (currentStep.kind === 'timed') current = `${currentStep.title}…`;
            else if (currentStep.id === 'sounds') current = `Sounds ${currentStep.doneCount} / ${currentStep.count}`;
            else if (currentStep.count === 0 || currentStep.state === 'waiting') current = `${currentStep.title}…`;
            else {
                const part = currentStep.part && currentStep.part !== currentStep.title ? ` (${currentStep.part})` : '';
                current = `${currentStep.title}${part} ${formatBytes(currentStep.loaded, currentStep.total)}`;
            }
        }
        const stalled = !!currentStep && failedSteps.length === 0 && now - Math.max(currentStep.activity, this.openedAt) > STALL_MS;
        const steps: StepView[] = visible.map(v => ({
            id: v.id, title: v.title, state: v.state, loaded: v.loaded, total: v.total, doneCount: v.doneCount, count: v.count,
            cached: v.cached, detail: v.detail, pendingRetry: v.pendingRetry, optional: v.optional
        }));
        return {
            shown: this.shown, percent: Math.floor(this.shown * 100), current, steps, stalled,
            failed: failedSteps.length > 0, canContinue: failedSteps.every(v => v.optional), complete, requiredComplete
        };
    }
}
