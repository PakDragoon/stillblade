/**
 * The loading screen's card (drawn inside `#loading-screen` by `Ui.showProgress`): a title, one bar with a percentage,
 * a line saying what is loading right now, the steps ticked off as they finish with their sizes, a calm note when a
 * step stalls, and the buttons for a failed download. It only redraws what changed, a few times a second.
 * Shows assets and connection steps only, never anything about other players.
 */
import { button, h } from './dom';
import type { ScreenView, StepState } from './loading';

export interface LoadActions {
    /** Try every failed download again. */
    retry(): void;
    /** Give up on the failed downloads: "Continue without them" when every one is optional, else "Back to menu". */
    giveUp(): void;
    /** Start now and let the optional steps finish in the background (offered when only they are left and slow). */
    playNow?(): void;
}

const MARK: Record<StepState, string> = { waiting: '', active: '', done: '✓', failed: '!', skipped: '' };

export class LoadingView {
    private readonly fill: HTMLElement;
    private readonly pct: HTMLElement;
    private readonly now: HTMLElement;
    private readonly list: HTMLElement;
    private readonly note: HTMLElement;
    private readonly row: HTMLElement;
    private readonly retryBtn: HTMLButtonElement;
    private readonly giveUpBtn: HTMLButtonElement;
    private readonly playBtn: HTMLButtonElement | null;
    private readonly rows = new Map<string, { li: HTMLElement; mark: HTMLElement; name: HTMLElement; size: HTMLElement; state: string; text: string }>();
    private last = '';

    constructor(parent: HTMLElement, title: string, sub: string, actions: LoadActions) {
        const c = h('div', 'card load', '', parent);
        h('h2', '', title, c);
        if (sub) h('p', 'dim sub', sub, c);
        const meter = h('div', 'meter', '', c);
        const bar = h('div', 'bar', '', meter);
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        this.fill = h('i', '', '', bar);
        this.pct = h('span', 'pct', '0 %', meter);
        this.now = h('p', 'now', '', c);
        this.now.setAttribute('aria-live', 'polite');
        this.list = h('ul', 'steps', '', c);
        this.note = h('p', 'note', '', c);
        this.row = h('div', 'row', '', c);
        this.retryBtn = button('Try again', 'primary', this.row, () => actions.retry());
        this.giveUpBtn = button('Back to menu', '', this.row, () => actions.giveUp());
        // Shown alone (never with the failure buttons), so it is that moment's main action.
        this.playBtn = actions.playNow ? button('Play now', 'primary', this.row, () => actions.playNow!()) : null;
        this.row.style.display = 'none';
        this.note.style.display = 'none';
    }

    update(v: ScreenView): void {
        // Nothing to redraw (the screen polls a few times a second).
        const key = `${v.percent}|${v.current}|${v.stalled}|${v.failed}|${v.requiredComplete}|${v.steps.map(s => `${s.state}${s.detail}${s.cached}`).join(',')}`;
        if (key === this.last) return;
        this.last = key;
        this.fill.style.width = `${(v.shown * 100).toFixed(1)}%`;
        this.fill.parentElement!.setAttribute('aria-valuenow', String(v.percent));
        this.pct.textContent = `${v.percent} %`;
        this.now.textContent = v.current;
        this.now.classList.toggle('bad', v.failed);

        const seen = new Set<string>();
        for (const s of v.steps) {
            seen.add(s.id);
            let r = this.rows.get(s.id);
            if (!r) {
                const li = h('li', '', '', this.list);
                r = { li, mark: h('span', 'mark', '', li), name: h('span', 'name', '', li), size: h('span', 'size', '', li), state: '', text: '' };
                this.rows.set(s.id, r);
            }
            const state = s.pendingRetry ? 'failed' : s.state;
            if (r.state !== state) { r.li.className = state; r.mark.textContent = MARK[state]; r.state = state; }
            if (r.name.textContent !== s.title) r.name.textContent = s.title;
            const failedText = s.state === 'failed' && !s.pendingRetry ? (s.optional ? 'skipped' : 'failed') : '';
            const text = failedText || (s.cached && s.state === 'done' ? `${s.detail} · cached` : s.detail);
            if (r.text !== text) { r.size.textContent = text; r.text = text; }
        }
        for (const [id, r] of this.rows) if (!seen.has(id)) { r.li.remove(); this.rows.delete(id); }

        // A failed download waits for an answer; a stalled step gets a calm note (and Play now, if only extras are left).
        let note = '';
        if (v.failed) note = 'A download failed. Check your connection, then try again.';
        else if (v.stalled) note = v.requiredComplete && this.playBtn
            ? 'This is taking longer than usual. You can play now; the rest finishes in the background.'
            : 'This is taking longer than usual. A slow connection can take a minute; it keeps going on its own.';
        this.note.textContent = note;
        this.note.style.display = note ? '' : 'none';
        this.retryBtn.style.display = v.failed ? '' : 'none';
        this.giveUpBtn.style.display = v.failed ? '' : 'none';
        this.giveUpBtn.textContent = v.canContinue ? 'Continue without them' : 'Back to menu';
        const play = !v.failed && v.stalled && v.requiredComplete && !!this.playBtn;
        if (this.playBtn) this.playBtn.style.display = play ? '' : 'none';
        this.row.style.display = v.failed || play ? '' : 'none';
    }
}
