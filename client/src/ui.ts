import './ui.css';
import { CHAT_MAX_CHARS, type ChatMsg, type RosterEntry, type SummaryMsg, type Team } from '@shared/protocol';
import type { MapListEntry } from '@shared/maps';
import type { Phase } from '@shared/rules';
import type { Settings, SettingsStore } from './settings';

export interface JoinChoice { name: string; room: string; map: string }

/** What the menus ask the game to do. The Ui itself never touches the network or the simulation. */
export interface UiHooks {
    join(choice: JoinChoice): void;
    ready(ready: boolean): void;
    start(): void;
    switchTeam(): void;
    leave(): void;
    chat(text: string, team: boolean): void;
    retry(): void;
    backToMenu(): void;
    /** Ask for the mouse back (a click or key press is the gesture) / give it up for a menu. */
    lock(): void;
    unlock(): void;
    isLocked(): boolean;
    /** The chat box took (or returned) the keyboard: game keys must not fire while it is true. */
    typing(on: boolean): void;
}

const WORDS_A = ['amber', 'calm', 'dusk', 'ember', 'frost', 'grey', 'hollow', 'iron', 'jade', 'low', 'mist', 'north', 'quiet', 'raven', 'slate', 'still'];
const WORDS_B = ['owl', 'fox', 'blade', 'heron', 'lynx', 'moth', 'otter', 'pike', 'reed', 'shade', 'tern', 'vale', 'wolf', 'yard', 'crow', 'wren'];

/** A short readable room code such as `quiet-heron-42`. */
export function makeRoomCode(): string {
    const pick = (a: string[]): string => a[Math.floor(Math.random() * a.length)];
    return `${pick(WORDS_A)}-${pick(WORDS_B)}-${10 + Math.floor(Math.random() * 90)}`;
}

const CONTROLS: [string, string][] = [
    ['W A S D', 'Move'], ['Mouse', 'Look'], ['Left click or F', 'Attack (gun for defenders, knife for ghosts)'],
    ['R', 'Reload'], ['E (hold)', 'Plant the bomb (ghosts) or defuse it (defenders)'], ['Space', 'Jump'],
    ['Shift', 'Quiet walk'], ['C or Ctrl', 'Crouch'], ['Tab (hold)', 'Scoreboard'],
    ['Enter', 'Chat to everyone'], ['Y', 'Chat to your team'], ['Left and right arrows', 'Follow another teammate when dead'],
    ['G', 'Ready or not ready (warmup)'], ['U', 'Start the match (room creator, warmup)'], ['M', 'Switch team (warmup)'],
    ['L', 'Open the lobby (warmup)'], ['Esc', 'Pause menu: resume, settings, leave'],
];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '', parent?: HTMLElement): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    parent?.appendChild(e);
    return e;
}

function button(label: string, cls: string, parent: HTMLElement, onClick: () => void): HTMLButtonElement {
    const b = h('button', cls, label, parent);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
}

const TEAM_NAME: Record<Team, string> = { ghosts: 'Ghosts', defenders: 'Defenders' };

export class Ui {
    private readonly root = h('div');
    private readonly menu = h('div', 'screen solid', '', this.root);
    private readonly loading = h('div', 'screen solid', '', this.root);
    private readonly error = h('div', 'screen solid', '', this.root);
    private readonly lobby = h('div', 'screen', '', this.root);
    private readonly pause = h('div', 'screen', '', this.root);
    private readonly settingsScreen = h('div', 'screen', '', this.root);
    private readonly controls = h('div', 'screen', '', this.root);
    private readonly result = h('div', 'screen', '', this.root);
    private readonly strip = h('div', '', '', this.root);
    private readonly chatLog = h('div', '', '', this.root);
    private readonly chatForm = h('form', '', '', this.root);
    private readonly chatTag = h('span', '', 'All', this.chatForm);
    private readonly chatInput = h('input', '', '', this.chatForm);
    private readonly hint = h('div', '', 'Click to play', this.root);
    private readonly toastEl = h('div', '', '', this.root);
    private toastTimer = 0;
    /** Scripted runs: no automatic lobby panel, pause menu or click hint. */
    quiet = false;

    private inGame = false;
    private typing = false;
    private chatTeam = false;
    private lockLostAt = -1e9;
    private roster: RosterEntry[] = [];
    private localId = 0;
    private phase: Phase = 'warmup';
    private room = '';
    private mapId = '';
    private mapName = '';
    private lobbyMsg: HTMLElement | null = null;
    private startBtn: HTMLButtonElement | null = null;
    private resultCountdown: HTMLElement | null = null;
    private resultNextAt = 0;
    private shownCountdown = -1;
    private summaryOpen = false;

    constructor(private readonly settings: SettingsStore, private readonly hooks: UiHooks) {
        this.root.id = 'ui';
        document.body.appendChild(this.root);
        this.menu.id = 'menu-screen'; this.loading.id = 'loading-screen'; this.error.id = 'error-screen';
        this.lobby.id = 'lobby-screen'; this.pause.id = 'pause-screen'; this.settingsScreen.id = 'settings-screen';
        this.controls.id = 'controls-screen'; this.result.id = 'result-screen';
        this.strip.id = 'lobby-strip'; this.chatLog.id = 'chat-log'; this.chatForm.id = 'chat-form'; this.hint.id = 'click-hint';
        this.toastEl.id = 'toast';
        this.chatInput.maxLength = CHAT_MAX_CHARS * 2;
        this.chatInput.autocomplete = 'off';
        this.chatInput.spellcheck = false;
        this.chatInput.setAttribute('aria-label', 'Chat message');
        this.chatForm.addEventListener('submit', e => { e.preventDefault(); this.sendChat(); });
        this.chatInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.preventDefault(); this.closeChat(false); }
            else if (e.key === 'Enter') { e.preventDefault(); this.sendChat(); }
        });
        this.hint.addEventListener('click', () => this.hooks.lock());
        this.buildPause();
        this.buildSettings();
        this.buildControls();
        document.addEventListener('keydown', e => this.onKey(e));
    }

    // ---- cursor policy ----------------------------------------------------------------------

    /** True while something on screen needs the mouse pointer (so the game must not hold it). */
    get cursorNeeded(): boolean {
        return this.typing || [this.menu, this.loading, this.error, this.lobby, this.pause, this.settingsScreen, this.controls, this.result]
            .some(s => s.classList.contains('open'));
    }

    /** A game-only overlay is open (not the pre-game menu, loading or error screens). */
    private get modalOpen(): boolean {
        return [this.lobby, this.pause, this.settingsScreen, this.controls, this.result].some(s => s.classList.contains('open'));
    }

    private open(screen: HTMLElement): void {
        screen.classList.add('open');
        if (this.hooks.isLocked()) this.hooks.unlock();
        this.refreshHint();
    }

    private close(screen: HTMLElement): void {
        screen.classList.remove('open');
        this.refreshHint();
    }

    /** The mouse was captured or released (pointerlockchange). Losing it with nothing else open means Esc: pause. */
    onLockChange(locked: boolean): void {
        if (locked) {
            for (const s of [this.pause, this.settingsScreen, this.controls, this.lobby]) s.classList.remove('open');
            this.refreshHint();
            return;
        }
        this.lockLostAt = performance.now();
        if (this.inGame && !this.cursorNeeded && !this.quiet) this.open(this.pause);
        this.refreshHint();
    }

    private refreshHint(): void {
        const show = this.inGame && !this.cursorNeeded && !this.hooks.isLocked() && !this.quiet;
        this.hint.style.display = show ? 'block' : 'none';
    }

    private resume(): void {
        for (const s of [this.pause, this.settingsScreen, this.controls, this.lobby]) s.classList.remove('open');
        this.refreshHint();
        this.hooks.lock();
    }

    // ---- keyboard ---------------------------------------------------------------------------

    private onKey(e: KeyboardEvent): void {
        if (e.target === this.chatInput) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
            if (e.key === 'Escape' && this.inGame) this.escape();
            return;
        }
        if (!this.inGame) return;
        if (e.code === 'Escape') {
            // A browser that reports Esc both as a lock loss and as a key press must not toggle twice.
            if (performance.now() - this.lockLostAt < 200) return;
            this.escape();
            return;
        }
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        if (this.modalOpen) {
            // The lobby panel takes the same keys it advertises.
            if (this.lobby.classList.contains('open') && this.phase === 'warmup') {
                if (e.code === 'KeyL') this.resume();
                else if (e.code === 'KeyG') this.toggleReady();
                else if (e.code === 'KeyU') this.hooks.start();
                else if (e.code === 'KeyM') this.hooks.switchTeam();
            }
            return;
        }
        switch (e.code) {
            case 'Enter': e.preventDefault(); this.openChat(false); break;
            case 'KeyY': e.preventDefault(); this.openChat(true); break;
            case 'KeyG': if (this.phase === 'warmup') this.toggleReady(); break;
            case 'KeyU': if (this.phase === 'warmup') this.hooks.start(); break;
            case 'KeyM': if (this.phase === 'warmup') this.hooks.switchTeam(); break;
            case 'KeyL': if (this.phase === 'warmup') this.openLobby(); break;
        }
    }

    private escape(): void {
        if (this.summaryOpen) return;
        if (this.settingsScreen.classList.contains('open') || this.controls.classList.contains('open')) {
            this.close(this.settingsScreen); this.close(this.controls); this.open(this.pause);
        } else if (this.pause.classList.contains('open') || this.lobby.classList.contains('open')) this.resume();
        else this.open(this.pause);
    }

    // ---- pre-game screens -------------------------------------------------------------------

    private hideScreens(): void {
        for (const s of [this.menu, this.loading, this.error]) s.classList.remove('open');
    }

    /** The name, room and map choices. `prefillRoom` comes from an invite link. */
    showMenu(maps: MapListEntry[], defaults: { name: string; room: string; map: string }): Promise<JoinChoice> {
        this.hideScreens();
        this.menu.replaceChildren();
        const wrap = h('div', 'wrap', '', this.menu);
        const brand = h('div', 'brand', '', wrap);
        const rings = h('div', 'rings', '', brand);
        for (let i = 0; i < 3; i++) h('i', '', '', rings);
        h('h1', '', 'STILLBLADE', brand);
        h('p', '', 'Ghosts vanish when they stand still. Defenders have to listen.', brand);

        const card = h('form', 'card stack', '', wrap);
        card.autocomplete = 'off';
        const nameL = h('label', 'f', 'Your name', card);
        const name = h('input', '', '', nameL);
        name.type = 'text'; name.maxLength = 16; name.placeholder = 'Player'; name.spellcheck = false; name.value = defaults.name;
        const mapL = h('label', 'f', 'Map for a new room', card);
        const map = h('select', '', '', mapL);
        for (const m of maps) map.add(new Option(m.name, m.id));
        map.value = maps.some(m => m.id === defaults.map) ? defaults.map : maps[0]?.id ?? '';
        const create = h('button', 'primary', 'Create room', card);
        const orRow = h('p', 'or', 'or join friends', card);
        void orRow;
        const joinRow = h('div', 'row', '', card);
        const code = h('input', '', '', joinRow);
        code.type = 'text'; code.maxLength = 24; code.placeholder = 'Room code'; code.spellcheck = false; code.value = defaults.room;
        code.setAttribute('aria-label', 'Room code');
        const join = h('button', defaults.room ? 'primary' : '', 'Join room', joinRow);
        const quick = h('button', '', 'Quick play (public room)', card);
        const err = h('p', 'dim', '', card);

        const how = h('aside', 'card', '', wrap);
        how.id = 'howto';
        let seen = false;
        try { seen = localStorage.getItem('sb-howto') === '1'; } catch { /* storage blocked: show it */ }
        h('h3', '', 'How a match works', how);
        const dl = h('dl', '', '', how);
        const item = (cls: string, t: string, d: string): void => { h('dt', cls, t, dl); h('dd', '', d, dl); };
        item('g', 'Ghosts', 'Invisible while still, carrying only a knife. Plant the bomb on a site, then keep it alive until it blows.');
        item('d', 'Defenders', 'Always visible, armed with guns. You cannot see a standing ghost: follow footsteps, breathing and the knife windup.');
        item('', 'Rounds', 'Four seconds to set up, two minutes to play. First side to six rounds wins; sides swap after round five.');
        const gotIt = button('Got it', '', how, () => { how.style.display = 'none'; try { localStorage.setItem('sb-howto', '1'); } catch { /* shown again next time */ } });
        if (seen) how.style.display = 'none';
        void gotIt;
        this.menu.classList.add('open');
        setTimeout(() => (defaults.room ? code : name).focus(), 0);

        return new Promise(resolve => {
            const go = (room: string, mapId: string): void => {
                const n = name.value.trim();
                try { localStorage.setItem('sb-name', n); localStorage.setItem('sb-howto', '1'); } catch { /* not remembered */ }
                resolve({ name: n, room, map: mapId });
            };
            create.addEventListener('click', e => { e.preventDefault(); go(makeRoomCode(), map.value); });
            join.addEventListener('click', e => {
                e.preventDefault();
                const c = code.value.trim();
                if (!c) { err.textContent = 'Enter the room code your friend sent you.'; code.focus(); return; }
                go(c, '');
            });
            quick.addEventListener('click', e => { e.preventDefault(); go('', map.value); });
            card.addEventListener('submit', e => { e.preventDefault(); (code.value.trim() ? join : quick).click(); });
        });
    }

    showLoading(text: string, sub = ''): void {
        this.hideScreens();
        this.loading.replaceChildren();
        const c = h('div', 'card', '', this.loading);
        h('h2', '', text, c);
        if (sub) h('p', 'dim', sub, c);
        const bar = h('div', 'bar', '', c);
        h('i', '', '', bar);
        this.loading.classList.add('open');
    }

    showError(title: string, message: string, canRetry = true): void {
        this.hideScreens();
        this.error.replaceChildren();
        const c = h('div', 'card', '', this.error);
        h('h2', '', title, c);
        h('p', '', message, c);
        const row = h('div', 'row', '', c);
        if (canRetry) button('Try again', 'primary', row, () => this.hooks.retry());
        button('Back to menu', '', row, () => this.hooks.backToMenu());
        this.error.classList.add('open');
        this.hint.style.display = 'none';
    }

    /** The match is on: hides the pre-game screens and shows the lobby while the room is in warmup. */
    enterGame(room: string, mapId: string, mapName: string): void {
        this.hideScreens();
        this.inGame = true;
        this.room = room;
        this.mapId = mapId;
        this.mapName = mapName;
        this.refreshStrip();
        if (this.phase === 'warmup' && !this.quiet) this.openLobby();
        else this.refreshHint();
    }

    // ---- lobby ------------------------------------------------------------------------------

    setPhase(phase: Phase): void {
        const was = this.phase;
        this.phase = phase;
        if (phase !== 'warmup' && was === 'warmup' && this.lobby.classList.contains('open')) {
            this.close(this.lobby); // the match began while the lobby was open: back to the game
            this.refreshHint();
        }
        if (phase !== 'over' && this.summaryOpen) this.hideSummary();
        this.refreshStrip();
    }

    setRoster(players: readonly RosterEntry[], localId: number): void {
        this.roster = players.map(p => ({ ...p }));
        this.localId = localId;
        if (this.lobby.classList.contains('open')) this.renderLobby();
        this.refreshStrip();
    }

    private me(): RosterEntry | undefined {
        return this.roster.find(p => p.id === this.localId);
    }

    private toggleReady(): void {
        const me = this.me();
        this.hooks.ready(!(me?.ready ?? false));
    }

    private refreshStrip(): void {
        const warm = this.inGame && this.phase === 'warmup' && !this.lobby.classList.contains('open') && !this.summaryOpen;
        this.strip.style.display = warm ? 'block' : 'none';
        if (!warm) return;
        const ready = this.roster.filter(p => p.ready).length;
        const me = this.me();
        this.strip.replaceChildren();
        this.strip.append(`Warmup: ${ready} of ${this.roster.length} ready.  `);
        const g = h('b', '', 'G', this.strip); void g;
        this.strip.append(me?.ready ? ' unready  ' : ' ready  ');
        if (me?.creator) { h('b', '', 'U', this.strip); this.strip.append(' start  '); }
        h('b', '', 'M', this.strip); this.strip.append(' switch team  '); h('b', '', 'L', this.strip); this.strip.append(' lobby');
    }

    openLobby(): void {
        this.renderLobby();
        this.open(this.lobby);
        this.refreshStrip();
    }

    private inviteUrl(): string {
        const u = new URL(location.href);
        u.search = '';
        u.hash = '';
        u.searchParams.set('room', this.room || 'public');
        u.searchParams.set('map', this.mapId);
        return u.toString();
    }

    private renderLobby(): void {
        const me = this.me();
        this.lobby.replaceChildren();
        const card = h('div', 'card', '', this.lobby);
        const head = h('div', 'head', '', card);
        h('span', 'code', this.room || 'public', head);
        h('span', 'dim', this.mapName, head);
        h('span', 'sp', '', head);
        button('Copy invite link', '', head, () => {
            const url = this.inviteUrl();
            const done = (): void => this.toast('Invite link copied');
            if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => this.copyFallback(url));
            else this.copyFallback(url);
        });
        const teams = h('div', 'teams', '', card);
        for (const team of ['ghosts', 'defenders'] as const) {
            const col = h('div', `team ${team}`, '', teams);
            const members = this.roster.filter(p => p.team === team);
            h('h3', '', `${TEAM_NAME[team]} (${members.length})`, col);
            if (members.length === 0) h('p', 'empty', 'Nobody yet', col);
            for (const p of members) {
                const row = h('div', p.id === this.localId ? 'p me' : 'p', p.name, col);
                if (p.creator) h('span', 'host', 'creator', row);
                h('span', p.ready ? 'st ready' : 'st', p.ready ? 'Ready' : 'Not ready', row);
            }
        }
        const n = { ghosts: 0, defenders: 0 };
        for (const p of this.roster) n[p.team]++;
        const bothTeams = n.ghosts > 0 && n.defenders > 0;
        this.lobbyMsg = h('p', 'msg', '', card);
        const row = h('div', 'row', '', card);
        button(me?.ready ? 'Not ready (G)' : 'Ready (G)', me?.ready ? 'go on' : 'go', row, () => this.toggleReady());
        button('Switch team (M)', '', row, () => this.hooks.switchTeam());
        if (me?.creator) {
            this.startBtn = button('Start match (U)', 'primary', row, () => this.hooks.start());
            this.startBtn.disabled = !bothTeams;
            this.startBtn.title = bothTeams ? '' : 'Each team needs at least one player';
        }
        h('span', 'sp', '', row);
        button('Walk around', '', row, () => this.resume());
        const everyone = this.roster.length > 0 && this.roster.every(p => p.ready);
        this.lobbyMsg.textContent = !bothTeams ? 'Waiting for a player on each team. You can walk around in the meantime.'
            : everyone ? 'Everyone is ready: starting.' : 'The match starts when everyone is ready, or the creator starts it.';
    }

    private copyFallback(text: string): void {
        const t = h('textarea', '', '', document.body);
        t.value = text;
        t.style.cssText = 'position:fixed;left:-999px;top:0';
        t.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { /* blocked */ }
        t.remove();
        this.toast(ok ? 'Invite link copied' : `Copy this link: ${text}`);
    }

    toast(text: string): void {
        this.toastEl.textContent = text;
        this.toastEl.style.display = 'block';
        clearTimeout(this.toastTimer);
        this.toastTimer = window.setTimeout(() => { this.toastEl.style.display = 'none'; }, 3500);
    }

    // ---- pause, settings, controls ----------------------------------------------------------

    private buildPause(): void {
        const card = h('div', 'card', '', this.pause);
        h('h2', '', 'Paused', card);
        h('p', 'dim', 'The match keeps running.', card);
        const stack = h('div', 'stack', '', card);
        stack.style.marginTop = '16px';
        button('Resume', 'primary', stack, () => this.resume());
        button('Settings', '', stack, () => { this.close(this.pause); this.open(this.settingsScreen); });
        button('Controls', '', stack, () => { this.close(this.pause); this.open(this.controls); });
        button('Leave room', 'danger', stack, () => this.hooks.leave());
    }

    private buildControls(): void {
        const card = h('div', 'card', '', this.controls);
        h('h2', '', 'Controls', card);
        const dl = h('dl', '', '', card);
        for (const [k, d] of CONTROLS) { h('dt', '', k, dl); h('dd', '', d, dl); }
        button('Back', 'primary', card, () => { this.close(this.controls); this.open(this.pause); });
    }

    private buildSettings(): void {
        const card = h('div', 'card', '', this.settingsScreen);
        h('h2', '', 'Settings', card);
        h('p', 'dim', 'Saved on this device and applied straight away.', card);
        const grid = h('div', 'grid', '', card);
        const s = this.settings;
        const slider = (label: string, key: 'sensitivity' | 'fov' | 'master' | 'effects' | 'footsteps' | 'crosshairSize',
            min: number, max: number, step: number, fmt: (v: number) => string): void => {
            const c = h('div', 'ctl', '', grid);
            const l = h('label', '', label, c);
            const out = h('output', '', fmt(s.value[key]), c);
            const r = h('input', '', '', c);
            r.type = 'range'; r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(s.value[key]);
            l.htmlFor = r.id = `set-${key}`;
            r.addEventListener('input', () => { const v = Number(r.value); out.textContent = fmt(v); s.set(key, v); });
        };
        const toggle = (label: string, key: 'invertY' | 'showStats'): void => {
            const c = h('div', 'ctl', '', grid);
            const l = h('label', '', label, c);
            const i = h('input', '', '', c);
            i.type = 'checkbox'; i.checked = s.value[key];
            l.htmlFor = i.id = `set-${key}`;
            i.addEventListener('change', () => s.set(key, i.checked));
        };
        h('h3', 'group', 'Mouse and view', grid);
        slider('Mouse sensitivity', 'sensitivity', 0.1, 4, 0.05, v => `${v.toFixed(2)}x`);
        toggle('Invert vertical look', 'invertY');
        slider('Field of view', 'fov', 60, 110, 1, v => `${v}°`);
        h('h3', 'group', 'Sound', grid);
        const pct = (v: number): string => `${Math.round(v * 100)}%`;
        slider('Master volume', 'master', 0, 1, 0.05, pct);
        slider('Effects volume', 'effects', 0, 1, 0.05, pct);
        slider('Footstep volume', 'footsteps', 0, 1, 0.05, pct);
        h('h3', 'group', 'Crosshair', grid);
        const sel = (label: string, key: 'crosshairStyle' | 'quality', options: [string, string][]): void => {
            const c = h('div', 'ctl', '', grid);
            const l = h('label', '', label, c);
            const e = h('select', '', '', c);
            for (const [v, t] of options) e.add(new Option(t, v));
            e.value = s.value[key];
            l.htmlFor = e.id = `set-${key}`;
            e.addEventListener('change', () => s.set(key, e.value as never));
        };
        sel('Style', 'crosshairStyle', [['dot', 'Dot'], ['cross', 'Cross'], ['ring', 'Ring']]);
        const colour = h('div', 'ctl', '', grid);
        const cl = h('label', '', 'Colour', colour);
        const ci = h('input', '', '', colour);
        ci.type = 'color'; ci.value = s.value.crosshairColor;
        cl.htmlFor = ci.id = 'set-crosshairColor';
        ci.addEventListener('input', () => s.set('crosshairColor', ci.value));
        slider('Size', 'crosshairSize', 2, 12, 1, v => `${v}px`);
        h('h3', 'group', 'Display', grid);
        toggle('Show FPS and ping', 'showStats');
        sel('Graphics quality', 'quality', [['low', 'Low (60% resolution)'], ['medium', 'Medium (80%)'], ['high', 'High (full resolution)']]);
        const row = h('div', 'row', '', card);
        button('Back', 'primary', row, () => { this.close(this.settingsScreen); this.open(this.pause); });
        button('Reset to defaults', '', row, () => {
            s.reset();
            this.settingsScreen.replaceChildren();
            this.buildSettings();
        });
    }

    // ---- result card ------------------------------------------------------------------------

    showSummary(sum: SummaryMsg, localId: number): void {
        this.summaryOpen = true;
        for (const s of [this.pause, this.settingsScreen, this.controls, this.lobby]) s.classList.remove('open');
        if (this.typing) this.closeChat(false);
        this.result.replaceChildren();
        const card = h('div', 'card', '', this.result);
        const me = sum.players.find(p => p.id === localId);
        const top = h('div', 'top', '', card);
        const won = me ? me.team === sum.winner : false;
        h('span', `verdict ${won ? 'win' : 'lose'}`, me ? (won ? 'Victory' : 'Defeat') : `${TEAM_NAME[sum.winner]} win`, top);
        const score = h('span', 'score', '', top);
        h('span', 'g', String(sum.score.ghosts), score);
        score.append(' : ');
        h('span', 'd', String(sum.score.defenders), score);
        h('span', 'dim', `${TEAM_NAME[sum.winner]} take the match`, top);
        const mvp = sum.players.find(p => p.id === sum.mvp);
        if (mvp) {
            const m = h('p', 'mvp', '', card);
            m.append('Most valuable: ');
            h('b', '', mvp.name, m);
            m.append(`  ${mvp.kills} kills, ${mvp.assists} assists, ${mvp.damage} damage`);
        }
        const table = h('table', '', '', card);
        const cols = ['Player', 'K', 'D', 'A', 'HS', 'Dmg', 'Plant', 'Defuse'];
        for (const team of ['ghosts', 'defenders'] as const) {
            const members = sum.players.filter(p => p.team === team).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
            const hdr = h('tr', `teamhdr ${team}`, '', table);
            const hc = h('td', '', `${TEAM_NAME[team]} (${sum.score[team]})`, hdr);
            hc.colSpan = cols.length;
            const th = h('tr', '', '', table);
            for (const c of cols) h('th', '', c, th);
            if (members.length === 0) h('tr', '', '', table).append(h('td', 'dim', 'No players'));
            for (const p of members) {
                const tr = h('tr', p.id === localId ? 'me' : '', '', table);
                const n = h('td', '', p.name, tr);
                if (p.id === sum.mvp) h('span', 'star', ' ★', n);
                for (const v of [p.kills, p.deaths, p.assists, p.headshots + p.backstabs, p.damage, p.plants, p.defuses]) h('td', '', String(v), tr);
            }
        }
        const foot = h('div', 'row foot', '', card);
        this.resultCountdown = h('span', 'dim', '', foot);
        h('span', 'sp', '', foot);
        button('Leave room', 'danger', foot, () => this.hooks.leave());
        this.resultNextAt = sum.nextAt;
        this.shownCountdown = -1;
        this.open(this.result);
        this.refreshStrip();
    }

    hideSummary(): void {
        if (!this.summaryOpen) return;
        this.summaryOpen = false;
        this.close(this.result);
        this.refreshStrip();
    }

    /** Every frame: counts the result screen down. Writes the DOM only when the second changes. */
    tick(serverNowMs: number): void {
        if (!this.summaryOpen || !this.resultCountdown) return;
        const s = Math.max(0, Math.ceil((this.resultNextAt - serverNowMs) / 1000));
        if (s === this.shownCountdown) return;
        this.shownCountdown = s;
        this.resultCountdown.textContent = `Next match in ${s} s, same map and teams`;
    }

    // ---- chat -------------------------------------------------------------------------------

    private openChat(team: boolean): void {
        if (this.typing) return;
        this.typing = true;
        this.chatTeam = team;
        this.chatTag.textContent = team ? 'Team' : 'All';
        this.chatTag.className = team ? 'team' : '';
        this.chatForm.classList.add('open');
        this.chatLog.classList.add('typing');
        this.hooks.typing(true);
        // The mouse is released while typing so Esc reaches the chat box instead of the browser.
        if (this.hooks.isLocked()) this.hooks.unlock();
        this.chatInput.value = '';
        this.chatInput.focus();
        this.refreshHint();
    }

    private sendChat(): void {
        const text = this.chatInput.value.trim();
        if (text) this.hooks.chat(text, this.chatTeam);
        this.closeChat(true);
    }

    private closeChat(relock: boolean): void {
        if (!this.typing) return;
        this.typing = false;
        this.chatForm.classList.remove('open');
        this.chatLog.classList.remove('typing');
        this.chatInput.blur();
        this.hooks.typing(false);
        // Pressing Enter or Esc is a gesture, so the mouse can be taken back at once.
        if (!this.cursorNeeded) this.hooks.lock();
        void relock;
        this.refreshHint();
    }

    /** Adds a line to the fading chat log. `localAlive` guards the rule that the living never see the dead mid-round. */
    chat(msg: ChatMsg, localAlive: boolean, roundOn: boolean): void {
        if (msg.dead && localAlive && roundOn) return;
        const line = h('div', `${msg.team ? 'team' : ''}${msg.dead ? ' dead' : ''}`.trim(), '', this.chatLog);
        if (msg.dead) line.append('*dead* ');
        if (msg.team) line.append('(team) ');
        h('b', '', `${msg.name}: `, line);
        line.append(msg.text);
        this.trimChat(line);
    }

    note(text: string): void {
        const line = h('div', 'note', text, this.chatLog);
        this.trimChat(line);
    }

    private trimChat(line: HTMLElement): void {
        while (this.chatLog.children.length > 7) this.chatLog.firstElementChild?.remove();
        setTimeout(() => line.remove(), 12500);
    }

    // ---- misc -------------------------------------------------------------------------------

    applySettingsToPage(s: Settings): void {
        document.body.classList.toggle('no-stats', !s.showStats);
    }
}
