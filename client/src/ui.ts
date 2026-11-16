import './ui.css';
import {
    CHAT_MAX_CHARS, FEEDBACK_MAX_CHARS, type ChatMsg, type KickVoteInfo, type MapVoteMsg, type RosterEntry, type SummaryMsg, type Team
} from '@shared/protocol';
import type { RoomListEntry } from '@shared/room-list';
import type { MapListEntry } from '@shared/maps';
import { DEFAULT_ROOM_OPTIONS, type RoomOptions } from '@shared/room-options';
import type { Phase } from '@shared/rules';
import {
    ACTIONS, GROUPS, assignBinding, bindings, clearSecondary, conflictsWith, findConflicts, fullText, hintText,
    inputFromKeyEvent, inputLabel, inputMatches, mouseInput, actionDef, type ActionId, type Slot
} from './bindings';
import { optionChips, optionControls, roomListView } from './community-ui';
import { button, h } from './dom';
import { reporter } from './report';
import type { Settings, SettingsStore } from './settings';

/**
 * `options` apply only when this join creates the room ("Create room"); `quick` asks the server for the fullest
 * public room with space (Quick play), `room` being empty then.
 */
export interface JoinChoice { name: string; room: string; map: string; options?: RoomOptions; quick?: boolean }

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
    /** The creator changes room options (warmup only; the server checks). */
    options(patch: Partial<RoomOptions>): void;
    /** Start a vote to remove a player, answer the running vote, remove the other player in a room of two, pick the next map. */
    voteKick(target: number): void;
    castVote(yes: boolean): void;
    removePlayer(target: number): void;
    mapVote(map: string): void;
}

const WORDS_A = ['amber', 'calm', 'dusk', 'ember', 'frost', 'grey', 'hollow', 'iron', 'jade', 'low', 'mist', 'north', 'quiet', 'raven', 'slate', 'still'];
const WORDS_B = ['owl', 'fox', 'blade', 'heron', 'lynx', 'moth', 'otter', 'pike', 'reed', 'shade', 'tern', 'vale', 'wolf', 'yard', 'crow', 'wren'];

/** A short readable room code such as `quiet-heron-42`. */
export function makeRoomCode(): string {
    const pick = (a: string[]): string => a[Math.floor(Math.random() * a.length)];
    return `${pick(WORDS_A)}-${pick(WORDS_B)}-${10 + Math.floor(Math.random() * 90)}`;
}

/** Rows of the controls page: what each input does now, from the live bindings, plus the inputs that cannot be rebound. */
function controlRows(): [string, string][] {
    const map = bindings().value;
    const rows: [string, string][] = [['Mouse', 'Look'], ['Mouse wheel', 'Cycle weapons (fixed)']];
    for (const a of ACTIONS) rows.push([fullText(map, a.id), a.label]);
    rows.push(['Esc', 'Pause menu: resume, settings, leave (fixed)']);
    return rows;
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
    private readonly feedback = h('div', 'screen', '', this.root);
    private readonly strip = h('div', '', '', this.root);
    private readonly chatLog = h('div', '', '', this.root);
    private readonly chatForm = h('form', '', '', this.root);
    private readonly chatTag = h('span', '', 'All', this.chatForm);
    private readonly chatInput = h('input', '', '', this.chatForm);
    private readonly hint = h('div', '', 'Click to play', this.root);
    private readonly toastEl = h('div', '', '', this.root);
    private readonly voteBanner = h('div', '', '', this.root);
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
    private options: RoomOptions = { ...DEFAULT_ROOM_OPTIONS };
    private lobbyMsg: HTMLElement | null = null;
    private startBtn: HTMLButtonElement | null = null;
    private resultCountdown: HTMLElement | null = null;
    private resultNextAt = 0;
    private shownCountdown = -1;
    private summaryOpen = false;
    /** The row being rebound (waiting for a key or mouse button) and a conflict waiting for the player's answer. */
    private capture: { id: ActionId; slot: Slot } | null = null;
    private pendingBind: { id: ActionId; slot: Slot; input: string; others: ActionId[] } | null = null;
    private bindList: HTMLElement | null = null;
    private feedbackBox: HTMLTextAreaElement | null = null;
    /** The vote to remove a player that is running, the result card's map vote, and the pieces that show them. */
    private kickInfo: KickVoteInfo | null = null;
    private bannerTimer: HTMLElement | null = null;
    private mapVoteMsg: MapVoteMsg | null = null;
    private mapVoteBox: HTMLElement | null = null;
    private mapVoteTimer: HTMLElement | null = null;
    private mapStatus = '';
    private pausePlayers: HTMLElement | null = null;
    private serverNow = 0;

    constructor(private readonly settings: SettingsStore, private readonly hooks: UiHooks) {
        this.root.id = 'ui';
        document.body.appendChild(this.root);
        this.menu.id = 'menu-screen'; this.loading.id = 'loading-screen'; this.error.id = 'error-screen';
        this.lobby.id = 'lobby-screen'; this.pause.id = 'pause-screen'; this.settingsScreen.id = 'settings-screen';
        this.controls.id = 'controls-screen'; this.result.id = 'result-screen'; this.feedback.id = 'feedback-screen';
        this.strip.id = 'lobby-strip'; this.chatLog.id = 'chat-log'; this.chatForm.id = 'chat-form'; this.hint.id = 'click-hint';
        this.toastEl.id = 'toast';
        this.voteBanner.id = 'vote-banner';
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
        this.buildFeedback();
        document.addEventListener('keydown', e => this.onKey(e));
        document.addEventListener('mousedown', e => {
            const code = mouseInput(e.button);
            if (code && this.inGame && !this.typing && this.hooks.isLocked()) this.onInput(code, e);
        });
        // Hints that are already on screen follow a rebinding.
        bindings().watch(() => { if (this.inGame) this.refreshStrip(); });
    }

    // ---- cursor policy ----------------------------------------------------------------------

    /** True while something on screen needs the mouse pointer (so the game must not hold it). */
    get cursorNeeded(): boolean {
        return this.typing || [this.menu, this.loading, this.error, this.lobby, this.pause, this.settingsScreen, this.controls, this.result, this.feedback]
            .some(s => s.classList.contains('open'));
    }

    /** A game-only overlay is open (not the pre-game menu, loading or error screens). */
    private get modalOpen(): boolean {
        return [this.lobby, this.pause, this.settingsScreen, this.controls, this.result, this.feedback].some(s => s.classList.contains('open'));
    }

    private open(screen: HTMLElement): void {
        screen.classList.add('open');
        if (screen === this.pause) this.renderPausePlayers();
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
            for (const s of [this.pause, this.settingsScreen, this.controls, this.lobby, this.feedback]) s.classList.remove('open');
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
        this.cancelBinding();
        for (const s of [this.pause, this.settingsScreen, this.controls, this.lobby, this.feedback]) s.classList.remove('open');
        this.refreshHint();
        this.hooks.lock();
    }

    // ---- keyboard ---------------------------------------------------------------------------

    private onKey(e: KeyboardEvent): void {
        if (e.target === this.chatInput || e.target instanceof HTMLTextAreaElement) return; // the feedback box handles its own keys
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
            if (e.key === 'Escape' && this.inGame) this.escape();
            return;
        }
        if (!this.inGame) return;
        const k = this.kickInfo;
        if (k && k.target !== this.localId && (e.code === 'F1' || e.code === 'F2')) {
            e.preventDefault(); // F1 is the browser's help key
            if (!e.repeat) this.hooks.castVote(e.code === 'F1');
            return;
        }
        if (e.code === 'Escape') {
            // A browser that reports Esc both as a lock loss and as a key press must not toggle twice.
            if (performance.now() - this.lockLostAt < 200) return;
            this.escape();
            return;
        }
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        this.onInput(e.code, e);
    }

    /** A key press or mouse button (as its binding name) for the actions this class owns: chat and the lobby. */
    private onInput(code: string, e?: Event): void {
        const map = bindings().value;
        if (this.modalOpen) {
            // The lobby panel takes the same keys it advertises.
            if (this.lobby.classList.contains('open') && this.phase === 'warmup') {
                if (inputMatches(map, 'lobbyPanel', code)) this.resume();
                else if (inputMatches(map, 'ready', code)) this.toggleReady();
                else if (inputMatches(map, 'start', code)) this.hooks.start();
                else if (inputMatches(map, 'switchTeam', code)) this.hooks.switchTeam();
            }
            return;
        }
        if (inputMatches(map, 'chatAll', code)) { e?.preventDefault(); this.openChat(false); }
        else if (inputMatches(map, 'chatTeam', code)) { e?.preventDefault(); this.openChat(true); }
        else if (this.phase === 'warmup') {
            if (inputMatches(map, 'ready', code)) this.toggleReady();
            else if (inputMatches(map, 'start', code)) this.hooks.start();
            else if (inputMatches(map, 'switchTeam', code)) this.hooks.switchTeam();
            else if (inputMatches(map, 'lobbyPanel', code)) this.openLobby();
        }
    }

    private escape(): void {
        if (this.capture || this.pendingBind) { this.cancelBinding(); return; }
        if (this.feedback.classList.contains('open')) { this.closeFeedback(); return; }
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
    showMenu(maps: MapListEntry[], defaults: { name: string; room: string; map: string },
        loadRooms: () => Promise<RoomListEntry[]> = () => Promise.resolve([])): Promise<JoinChoice> {
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
        // Room options for "Create room" (shared/room-options.ts); joining keeps the room's own. Private unless ticked.
        let chosen: RoomOptions = { ...DEFAULT_ROOM_OPTIONS };
        const create = h('button', 'primary', 'Create private room', card);
        optionControls(card, chosen, patch => {
            chosen = { ...chosen, ...patch };
            create.textContent = chosen.public ? 'Create public room' : 'Create private room';
        }, 'opt-');
        card.insertBefore(create, null);
        const orRow = h('p', 'or', 'or join friends', card);
        void orRow;
        const joinRow = h('div', 'row', '', card);
        const code = h('input', '', '', joinRow);
        code.type = 'text'; code.maxLength = 24; code.placeholder = 'Room code'; code.spellcheck = false; code.value = defaults.room;
        code.setAttribute('aria-label', 'Room code');
        const join = h('button', defaults.room ? 'primary' : '', 'Join room', joinRow);
        const quick = h('button', '', 'Quick play (public room)', card);
        const err = h('p', 'dim', '', card);

        const side = h('div', 'stack', '', wrap);
        const how = h('aside', 'card', '', side);
        how.id = 'howto';
        let seen = false;
        try { seen = localStorage.getItem('sb-howto') === '1'; } catch { /* storage blocked: show it */ }
        h('h3', '', 'How a match works', how);
        const dl = h('dl', '', '', how);
        const item = (cls: string, t: string, d: string): void => { h('dt', cls, t, dl); h('dd', '', d, dl); };
        item('g', 'Ghosts', 'Invisible while still, carrying only a knife. Plant the bomb on a site, then keep it alive until it blows.');
        item('d', 'Defenders', 'Always visible, armed with guns. You cannot see a standing ghost: follow footsteps, breathing and the knife windup.');
        item('', 'Rounds', 'Four seconds to set up, two minutes to play. First side to six rounds wins; sides swap after round five.');
        const keys = bindings().value;
        item('', 'Keys', `Move ${hintText(keys, 'forward')} ${hintText(keys, 'left')} ${hintText(keys, 'back')} ${hintText(keys, 'right')}, attack ${hintText(keys, 'fire')}, aim ${hintText(keys, 'aim')}, reload ${hintText(keys, 'reload')}, plant or defuse ${hintText(keys, 'use')}. You can change every key in Settings.`);
        const gotIt = button('Got it', '', how, () => { how.style.display = 'none'; try { localStorage.setItem('sb-howto', '1'); } catch { /* shown again next time */ } });
        if (seen) how.style.display = 'none';
        void gotIt;
        this.menu.classList.add('open');
        setTimeout(() => (defaults.room ? code : name).focus(), 0);

        return new Promise(resolve => {
            const go = (room: string, mapId: string, options?: RoomOptions, quick = false): void => {
                const n = name.value.trim();
                try { localStorage.setItem('sb-name', n); localStorage.setItem('sb-howto', '1'); } catch { /* not remembered */ }
                resolve({ name: n, room, map: mapId, options, quick });
            };
            const list = roomListView(side, loadRooms, code => go(code, ''));
            side.insertBefore(list.el, how);
            create.addEventListener('click', e => { e.preventDefault(); go(makeRoomCode(), map.value, chosen); });
            join.addEventListener('click', e => {
                e.preventDefault();
                const c = code.value.trim();
                if (!c) { err.textContent = 'Enter the room code your friend sent you.'; code.focus(); return; }
                go(c, '');
            });
            quick.addEventListener('click', e => { e.preventDefault(); go('', map.value, undefined, true); });
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
    enterGame(room: string, mapId: string, mapName: string, options: RoomOptions = DEFAULT_ROOM_OPTIONS): void {
        this.hideScreens();
        this.inGame = true;
        this.room = room;
        this.mapId = mapId;
        this.mapName = mapName;
        this.options = { ...options };
        this.refreshStrip();
        if (this.phase === 'warmup' && !this.quiet) this.openLobby();
        else this.refreshHint();
    }

    /** The creator changed the options (or the room's map changed): the lobby shows them. */
    setOptions(options: RoomOptions): void {
        this.options = { ...options };
        if (this.lobby.classList.contains('open')) this.renderLobby();
    }

    /** The room moved to another map between matches: invite links and the lobby name it from now on. */
    setMap(mapId: string, mapName: string): void {
        this.mapId = mapId;
        this.mapName = mapName;
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
        if (this.pause.classList.contains('open')) this.renderPausePlayers();
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
        const key = (id: ActionId): void => { h('b', '', hintText(bindings().value, id), this.strip); };
        key('ready');
        this.strip.append(me?.ready ? ' unready  ' : ' ready  ');
        if (me?.creator) { key('start'); this.strip.append(' start  '); }
        key('switchTeam'); this.strip.append(' switch team  '); key('lobbyPanel'); this.strip.append(' lobby');
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
        // Options: the creator edits them in warmup (the server checks again); everyone else sees them as tags.
        const optRow = h('div', 'optrow', '', card);
        if (me?.creator && this.phase === 'warmup') optionControls(optRow, this.options, patch => this.hooks.options(patch), 'lobby-opt-');
        else {
            const tags = h('div', 'tags', '', optRow);
            optionChips(tags, this.options);
            tags.title = 'Chosen by the room creator';
        }
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
                this.addRemoveButton(row, p);
            }
        }
        const n = { ghosts: 0, defenders: 0 };
        for (const p of this.roster) n[p.team]++;
        const bothTeams = n.ghosts > 0 && n.defenders > 0;
        this.lobbyMsg = h('p', 'msg', '', card);
        const row = h('div', 'row', '', card);
        button(me?.ready ? `Not ready (${bindings().hint('ready')})` : `Ready (${bindings().hint('ready')})`, me?.ready ? 'go on' : 'go', row, () => this.toggleReady());
        button(`Switch team (${bindings().hint('switchTeam')})`, '', row, () => this.hooks.switchTeam());
        if (me?.creator) {
            this.startBtn = button(`Start match (${bindings().hint('start')})`, 'primary', row, () => this.hooks.start());
            this.startBtn.disabled = !bothTeams;
            this.startBtn.title = bothTeams ? '' : 'Each team needs at least one player';
        }
        h('span', 'sp', '', row);
        button('Walk around', '', row, () => this.resume());
        const everyone = this.roster.length > 0 && this.roster.every(p => p.ready);
        this.lobbyMsg.textContent = !bothTeams ? 'Waiting for a player on each team. You can walk around in the meantime.'
            : everyone ? 'Everyone is ready: starting.' : 'The match starts when everyone is ready, or the creator starts it.';
    }

    /**
     * A small button on another player's row: "Vote out" (three or more players), or "Remove" for the creator in a
     * room of two in warmup. The server checks every rule again.
     */
    private addRemoveButton(row: HTMLElement, p: RosterEntry): void {
        if (p.id === this.localId) return;
        const me = this.me();
        if (this.roster.length === 2 && me?.creator && this.phase === 'warmup') {
            button('Remove', 'mini danger', row, () => this.hooks.removePlayer(p.id));
        } else if (this.roster.length >= 3 && !this.kickInfo) {
            button('Vote out', 'mini', row, () => this.hooks.voteKick(p.id)).title = 'Start a vote to remove this player from the room';
        }
    }

    private renderPausePlayers(): void {
        const box = this.pausePlayers;
        if (!box) return;
        box.replaceChildren();
        const others = this.roster.filter(p => p.id !== this.localId);
        if (others.length === 0 || this.roster.length < 2) return;
        h('h3', '', 'Players', box);
        for (const p of others) {
            const row = h('div', 'prow', '', box);
            h('span', '', p.name, row);
            this.addRemoveButton(row, p);
        }
    }

    // ---- vote to remove a player ----------------------------------------------------------------

    /** The vote started, changed or ended (`vote` null). Shown as a banner with the two answer keys. */
    setKickVote(vote: KickVoteInfo | null, serverNowMs: number): void {
        this.kickInfo = vote;
        this.serverNow = serverNowMs;
        this.voteBanner.replaceChildren();
        this.bannerTimer = null;
        this.voteBanner.style.display = vote ? 'block' : 'none';
        if (this.lobby.classList.contains('open')) this.renderLobby();
        if (this.pause.classList.contains('open')) this.renderPausePlayers();
        if (!vote) return;
        const b = this.voteBanner;
        h('b', '', `Remove ${vote.targetName} from the room?`, b);
        h('span', 'dim', ` called by ${vote.callerName}`, b);
        const line = h('div', 'counts', '', b);
        line.append(`Yes ${vote.yes} of ${vote.needed} needed · No ${vote.no} · `);
        this.bannerTimer = h('span', '', '', line);
        if (vote.target === this.localId) {
            h('div', 'dim', 'The other players are voting on whether you stay.', b);
        } else {
            const row = h('div', 'row', '', b);
            const yes = button('Yes (F1)', vote.mine === true ? 'go' : '', row, () => this.hooks.castVote(true));
            const no = button('No (F2)', vote.mine === false ? 'danger on' : 'danger', row, () => this.hooks.castVote(false));
            yes.title = no.title = vote.mine === null ? 'Your vote' : 'You can change your vote';
        }
        this.tickBanner();
    }

    private tickBanner(): void {
        const k = this.kickInfo;
        if (!k || !this.bannerTimer) return;
        this.bannerTimer.textContent = `${Math.max(0, Math.ceil((k.endsAt - this.serverNow) / 1000))} s left`;
    }

    // ---- map vote ---------------------------------------------------------------------------------

    /** The map vote changed (or opened); drawn on the result card while it is up. */
    setMapVote(msg: MapVoteMsg): void {
        this.mapVoteMsg = msg;
        this.renderMapVote();
    }

    /** What the map change is doing ("Downloading Warehouse..."), shown under the vote. */
    setMapStatus(text: string): void {
        this.mapStatus = text;
        this.renderMapVote();
    }

    private renderMapVote(): void {
        const box = this.mapVoteBox, msg = this.mapVoteMsg;
        if (!box) return;
        box.replaceChildren();
        this.mapVoteTimer = null;
        if (!msg || msg.maps.length < 2) { if (msg) h('p', 'dim', 'Next match: same map.', box); return; }
        const closed = msg.next !== undefined;
        const nextName = msg.maps.find(m => m.id === msg.next)?.name ?? msg.next ?? '';
        const head = h('div', 'row', '', box);
        h('h3', '', closed ? `Next map: ${nextName}` : 'Vote for the next map', head);
        h('span', 'sp', '', head);
        if (!closed) this.mapVoteTimer = h('span', 'dim', '', head);
        const row = h('div', 'picks', '', box);
        for (const m of msg.maps) {
            const label = `${m.name}${m.id === msg.current ? ' (same map)' : ''}`;
            const b = button('', m.id === msg.mine ? 'pick on' : 'pick', row, () => this.hooks.mapVote(m.id));
            b.disabled = closed;
            b.append(label);
            h('span', 'n', String(m.votes), b);
        }
        if (this.mapStatus) h('p', 'dim small', this.mapStatus, box);
        this.tickMapVote();
    }

    private tickMapVote(): void {
        if (!this.mapVoteTimer || !this.mapVoteMsg) return;
        this.mapVoteTimer.textContent = `Voting closes in ${Math.max(0, Math.ceil((this.mapVoteMsg.closesAt - this.serverNow) / 1000))} s`;
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
        button('Controls', '', stack, () => { this.renderControls(); this.close(this.pause); this.open(this.controls); });
        button('Send feedback', '', stack, () => this.openFeedback());
        button('Leave room', 'danger', stack, () => this.hooks.leave());
        this.pausePlayers = h('div', 'plist', '', card);
    }

    private buildControls(): void {
        const card = h('div', 'card', '', this.controls);
        h('h2', '', 'Controls', card);
        h('dl', '', '', card);
        this.renderControls();
        const row = h('div', 'row', '', card);
        button('Back', 'primary', row, () => { this.close(this.controls); this.open(this.pause); });
        button('Change keys', '', row, () => { this.close(this.controls); this.open(this.settingsScreen); });
    }

    /** Fills the controls page from the live bindings (called whenever it opens). */
    private renderControls(): void {
        const dl = this.controls.querySelector('dl');
        if (!dl) return;
        dl.replaceChildren();
        for (const [k, d] of controlRows()) { h('dt', '', k, dl); h('dd', '', d, dl); }
    }

    private buildSettings(): void {
        const card = h('div', 'card', '', this.settingsScreen);
        h('h2', '', 'Settings', card);
        h('p', 'dim', 'Saved on this device and applied straight away.', card);
        const grid = h('div', 'grid', '', card);
        const s = this.settings;
        const slider = (label: string, key: 'sensitivity' | 'aimSensitivity' | 'fov' | 'master' | 'effects' | 'footsteps' | 'crosshairSize',
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
        h('h3', 'group', 'Controls', grid);
        slider('Aim sensitivity (while aiming)', 'aimSensitivity', 0.25, 2, 0.05, v => `${v.toFixed(2)}x`);
        const mode = (label: string, key: 'crouchToggle' | 'walkToggle' | 'aimToggle'): void => {
            const c = h('div', 'ctl', '', grid);
            const l = h('label', '', label, c);
            const e = h('select', '', '', c);
            e.add(new Option('Hold', 'hold')); e.add(new Option('Toggle', 'toggle'));
            e.value = s.value[key] ? 'toggle' : 'hold';
            l.htmlFor = e.id = `set-${key}`;
            e.addEventListener('change', () => s.set(key, e.value === 'toggle'));
        };
        mode('Crouch', 'crouchToggle');
        mode('Quiet walk', 'walkToggle');
        mode('Aim down sights', 'aimToggle');
        h('p', 'dim bind-help', 'Click a key, then press the new key or mouse button. Esc cancels. Backspace or Delete on the second column clears it. The mouse wheel always cycles weapons.', grid);
        this.bindList = h('div', 'bindings', '', grid);
        this.renderBindings();
        const row = h('div', 'row', '', card);
        button('Back', 'primary', row, () => { this.cancelBinding(); this.close(this.settingsScreen); this.open(this.pause); });
        button('Reset controls to defaults', '', row, () => { this.cancelBinding(); bindings().reset(); this.renderBindings(); });
        button('Reset to defaults', '', row, () => {
            s.reset();
            this.settingsScreen.replaceChildren();
            this.buildSettings();
        });
    }

    // ---- rebinding ------------------------------------------------------------------------------

    private renderBindings(): void {
        const list = this.bindList;
        if (!list) return;
        list.replaceChildren();
        const map = bindings().value;
        const shared = findConflicts(map);
        const pending = this.pendingBind;
        for (const group of GROUPS) {
            h('h4', '', group, list);
            const grid = h('div', 'bind-grid', '', list);
            for (const a of ACTIONS) {
                if (a.group !== group) continue;
                const involved = shared.has(a.id) || (pending !== null && (pending.id === a.id || pending.others.includes(a.id)));
                const row = h('div', involved ? 'bind conflict' : 'bind', '', grid);
                row.dataset.action = a.id;
                h('span', 'name', a.label, row);
                for (const slot of [0, 1] as const) {
                    const input = map[a.id][slot];
                    const waiting = this.capture?.id === a.id && this.capture.slot === slot;
                    const b = button(waiting ? 'Press a key…' : input === null ? (slot === 0 ? 'Unbound' : '—') : inputLabel(input),
                        waiting ? 'key waiting' : input === null ? 'key empty' : 'key', row, () => this.startCapture(a.id, slot));
                    b.dataset.slot = String(slot);
                    b.title = slot === 0 ? 'Main key' : 'Second key (optional)';
                }
                if (pending && pending.id === a.id) {
                    const names = pending.others.map(o => actionDef(o)?.label ?? o).join(', ');
                    const msg = h('div', 'conflict-msg', '', row);
                    msg.append(`${inputLabel(pending.input)} is already used by ${names}. `);
                    button('Use it here', 'primary', msg, () => this.applyBinding());
                    button('Cancel', '', msg, () => this.cancelBinding());
                } else if (pending && pending.others.includes(a.id)) {
                    h('div', 'conflict-msg', `${inputLabel(pending.input)} would move to ${actionDef(pending.id)?.label ?? ''}.`, row);
                } else if (shared.has(a.id)) {
                    h('div', 'conflict-msg', 'A key here is used twice.', row);
                }
            }
        }
    }

    /** Waits for the next key or mouse button and binds it to one column of an action. */
    private startCapture(id: ActionId, slot: Slot): void {
        this.cancelBinding();
        this.capture = { id, slot };
        window.addEventListener('keydown', this.onCaptureKey, true);
        window.addEventListener('mousedown', this.onCaptureMouse, true);
        this.renderBindings();
    }

    private stopListening(): void {
        window.removeEventListener('keydown', this.onCaptureKey, true);
        window.removeEventListener('mousedown', this.onCaptureMouse, true);
    }

    /** Leaves rebinding without changing anything (also used when a menu closes). */
    private cancelBinding(): void {
        const was = this.capture !== null || this.pendingBind !== null;
        this.stopListening();
        this.capture = null;
        this.pendingBind = null;
        if (was) this.renderBindings();
    }

    private readonly onCaptureKey = (e: KeyboardEvent): void => {
        // While a row waits for a key, nothing else on the page may react to it.
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat || !this.capture) return;
        if (e.code === 'Escape') { this.cancelBinding(); return; }
        if ((e.code === 'Backspace' || e.code === 'Delete') && this.capture.slot === 1) {
            bindings().set(clearSecondary(bindings().value, this.capture.id));
            this.cancelBinding();
            this.renderBindings();
            return;
        }
        const input = inputFromKeyEvent(e);
        if (input) this.chooseBinding(input);
    };

    private readonly onCaptureMouse = (e: MouseEvent): void => {
        if (!this.capture) return;
        // A left click on a button cancels the wait and does what the button does.
        if (e.button === 0 && e.target instanceof Element && e.target.closest('button')) { this.cancelBinding(); return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        const input = mouseInput(e.button);
        // The click, auxclick and context menu that follow this press must not reach the page either.
        const swallow = (ev: Event): void => { ev.preventDefault(); ev.stopImmediatePropagation(); };
        const types = ['click', 'auxclick', 'contextmenu'];
        for (const t of types) window.addEventListener(t, swallow, true);
        setTimeout(() => { for (const t of types) window.removeEventListener(t, swallow, true); }, 80);
        if (input) this.chooseBinding(input);
    };

    private chooseBinding(input: string): void {
        const cap = this.capture;
        if (!cap) return;
        this.stopListening();
        this.capture = null;
        const others = conflictsWith(bindings().value, cap.id, input).filter(o => o !== cap.id);
        // Moving an input between the two columns of one action is not a conflict.
        if (others.length > 0) this.pendingBind = { id: cap.id, slot: cap.slot, input, others };
        else bindings().set(assignBinding(bindings().value, cap.id, cap.slot, input));
        this.renderBindings();
    }

    /** The player confirmed: the new binding wins and the other action takes what this column held. */
    private applyBinding(): void {
        const p = this.pendingBind;
        if (!p) return;
        this.pendingBind = null;
        bindings().set(assignBinding(bindings().value, p.id, p.slot, p.input));
        this.renderBindings();
    }

    // ---- feedback ---------------------------------------------------------------------------------

    private feedbackStatus: HTMLElement | null = null;
    private feedbackSend: HTMLButtonElement | null = null;
    private feedbackCount: HTMLElement | null = null;
    private feedbackAttached: HTMLElement | null = null;

    private buildFeedback(): void {
        const card = h('div', 'card', '', this.feedback);
        h('h2', '', 'Send feedback', card);
        h('p', 'dim', 'What felt wrong, what broke, or what would you change? The developer reads every note.', card);
        const box = h('textarea', '', '', card);
        box.rows = 6;
        box.spellcheck = true;
        box.placeholder = 'Type here';
        box.setAttribute('aria-label', 'Your feedback');
        this.feedbackBox = box;
        const meta = h('div', 'row', '', card);
        this.feedbackCount = h('span', 'dim', `0 / ${FEEDBACK_MAX_CHARS}`, meta);
        h('span', 'sp', '', meta);
        this.feedbackStatus = h('span', 'status', '', meta);
        this.feedbackAttached = h('p', 'dim small', '', card);
        const row = h('div', 'row', '', card);
        this.feedbackSend = button('Send', 'primary', row, () => { void this.sendFeedback(); });
        this.feedbackSend.disabled = true;
        button('Cancel', '', row, () => this.closeFeedback());
        box.addEventListener('input', () => {
            // Counted in characters, not UTF-16 units, to match the server's cap.
            const chars = Array.from(box.value);
            if (chars.length > FEEDBACK_MAX_CHARS) box.value = chars.slice(0, FEEDBACK_MAX_CHARS).join('');
            this.feedbackCount!.textContent = `${Math.min(chars.length, FEEDBACK_MAX_CHARS)} / ${FEEDBACK_MAX_CHARS}`;
            this.feedbackSend!.disabled = box.value.trim() === '';
            this.feedbackStatus!.textContent = '';
        });
        box.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeFeedback(); } });
    }

    private openFeedback(): void {
        const box = this.feedbackBox;
        if (!box) return;
        box.value = '';
        this.feedbackCount!.textContent = `0 / ${FEEDBACK_MAX_CHARS}`;
        this.feedbackSend!.disabled = true;
        this.feedbackStatus!.textContent = '';
        this.feedbackAttached!.textContent = reporter.attachedSummary();
        this.open(this.feedback);
        box.focus();
    }

    private closeFeedback(): void {
        this.close(this.feedback);
        this.feedbackBox?.blur();
    }

    private async sendFeedback(): Promise<void> {
        const box = this.feedbackBox, send = this.feedbackSend, status = this.feedbackStatus;
        if (!box || !send || !status || box.value.trim() === '') return;
        send.disabled = true;
        status.textContent = 'Sending…';
        status.className = 'status';
        const ok = await reporter.sendFeedback(box.value);
        status.textContent = ok ? 'Thanks, sent' : 'Could not send. Try again.';
        status.className = ok ? 'status ok' : 'status bad';
        if (ok) { box.value = ''; this.feedbackCount!.textContent = `0 / ${FEEDBACK_MAX_CHARS}`; setTimeout(() => { if (status.className === 'status ok') this.closeFeedback(); }, 1200); }
        else send.disabled = false;
    }

    // ---- result card ------------------------------------------------------------------------

    showSummary(sum: SummaryMsg, localId: number): void {
        this.summaryOpen = true;
        for (const s of [this.pause, this.settingsScreen, this.controls, this.lobby, this.feedback]) s.classList.remove('open');
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
        this.mapVoteBox = h('div', 'mapvote', '', card);
        this.renderMapVote();
        const foot = h('div', 'row foot', '', card);
        this.resultCountdown = h('span', 'dim', '', foot);
        h('span', 'sp', '', foot);
        button('Send feedback', '', foot, () => this.openFeedback());
        button('Leave room', 'danger', foot, () => this.hooks.leave());
        this.resultNextAt = sum.nextAt;
        this.shownCountdown = -1;
        this.open(this.result);
        this.refreshStrip();
    }

    hideSummary(): void {
        if (!this.summaryOpen) return;
        this.summaryOpen = false;
        this.mapVoteBox = null;
        this.mapVoteMsg = null;
        this.mapStatus = '';
        this.close(this.result);
        this.refreshStrip();
    }

    /** Every frame: counts the result screen down. Writes the DOM only when the second changes. */
    tick(serverNowMs: number): void {
        this.serverNow = serverNowMs;
        if (this.kickInfo) this.tickBanner();
        if (!this.summaryOpen || !this.resultCountdown) return;
        this.tickMapVote();
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
