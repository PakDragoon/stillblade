import { BOT_LEVELS, ROOM_MAX_PLAYERS, ROOM_MIN_PLAYERS, ROUNDS_TO_WIN_CHOICES, type BotLevel, type RoomOptions } from '@shared/room-options';
import type { RoomListEntry } from '@shared/room-list';
import type { MapListEntry } from '@shared/maps';
import { button, h } from './dom';
import { crowdText, describeOptions } from './menu-logic';

/** A two-way (or more) choice shown as side-by-side cards, one always on. `onPick` runs when the player changes it. */
export function segmented<T extends string>(
    parent: HTMLElement, choices: readonly { value: T; title: string; hint: string }[], current: T, onPick: (v: T) => void, label: string
): { set(v: T): void; el: HTMLElement } {
    const el = h('div', 'seg', '', parent);
    el.setAttribute('role', 'radiogroup');
    el.setAttribute('aria-label', label);
    const btns = new Map<T, HTMLButtonElement>();
    const set = (v: T): void => {
        for (const [k, b] of btns) { b.classList.toggle('on', k === v); b.setAttribute('aria-checked', String(k === v)); }
    };
    for (const c of choices) {
        const b = button('', 'segopt', el, () => { set(c.value); onPick(c.value); });
        b.setAttribute('role', 'radio');
        h('b', '', c.title, b);
        h('small', '', c.hint, b);
        btns.set(c.value, b);
    }
    set(current);
    return { set, el };
}

/** Where the map shows in the options form: a choice (the create form) or a fixed name (the lobby, where the map is voted between matches). */
export interface MapField {
    list?: readonly MapListEntry[];
    value: string;
    name: string;
    onPick?: (id: string) => void;
}

/**
 * Every room option in one form, always in this order: visibility, map, most players, rounds to win, suppressed
 * weapons, fill with bots, bot skill (enabled only while filling). `onChange` gets the one field that changed.
 * The create page and the creator's lobby panel both use it, so they cannot drift apart.
 */
export function optionControls(
    parent: HTMLElement, value: RoomOptions, onChange: (patch: Partial<RoomOptions>) => void, idPrefix: string, map?: MapField
): HTMLElement {
    const grid = h('div', 'optgrid', '', parent);
    const vis = h('div', 'optfield wide', '', grid);
    h('span', 'optlabel', 'Who can join', vis);
    segmented(vis, [
        { value: 'private', title: 'Private', hint: 'Only people with the code or invite link' },
        { value: 'public', title: 'Public', hint: 'Listed in Rooms; Quick play can send people in' }
    ], value.public ? 'public' : 'private', v => onChange({ public: v === 'public' }), 'Who can join');

    const mapL = h('label', 'optfield', '', grid);
    h('span', 'optlabel', 'Map', mapL);
    if (map?.list && map.onPick) {
        const sel = h('select', '', '', mapL);
        sel.id = `${idPrefix}map`;
        for (const m of map.list) sel.add(new Option(m.name, m.id));
        sel.value = map.value;
        const pick = map.onPick;
        sel.addEventListener('change', () => pick(sel.value));
    } else {
        h('span', 'optvalue', map?.name ?? '', mapL);
        h('small', 'dim', 'The room votes on the next map after each match', mapL);
    }

    const players = h('label', 'optfield', '', grid);
    h('span', 'optlabel', 'Most players', players);
    const max = h('select', '', '', players);
    max.id = `${idPrefix}max`;
    for (let n = ROOM_MIN_PLAYERS; n <= ROOM_MAX_PLAYERS; n++) max.add(new Option(String(n), String(n)));
    max.value = String(value.maxPlayers);
    max.addEventListener('change', () => onChange({ maxPlayers: Number(max.value) }));

    const rounds = h('label', 'optfield', '', grid);
    h('span', 'optlabel', 'Rounds to win', rounds);
    const win = h('select', '', '', rounds);
    win.id = `${idPrefix}rounds`;
    for (const n of ROUNDS_TO_WIN_CHOICES) win.add(new Option(n === 3 ? '3 (short match)' : n === 9 ? '9 (long match)' : '6 (standard)', String(n)));
    win.value = String(value.roundsToWin);
    win.addEventListener('change', () => onChange({ roundsToWin: Number(win.value) }));

    const sup = h('label', 'optfield check', '', grid);
    const supBox = h('input', '', '', sup);
    supBox.type = 'checkbox'; supBox.id = `${idPrefix}suppressed`; supBox.checked = value.suppressed;
    supBox.addEventListener('change', () => onChange({ suppressed: supBox.checked }));
    const supText = h('span', '', '', sup);
    h('b', '', 'Suppressed weapons', supText);
    h('small', 'dim', 'Quieter gunshots, smaller muzzle flash', supText);

    const bots = h('label', 'optfield check', '', grid);
    const botBox = h('input', '', '', bots);
    botBox.type = 'checkbox'; botBox.id = `${idPrefix}bots`; botBox.checked = value.fillBots;
    const botText = h('span', '', '', bots);
    h('b', '', 'Fill with bots', botText);
    h('small', 'dim', 'Half the room size; each bot leaves when a person joins', botText);

    const levelL = h('label', 'optfield', '', grid);
    h('span', 'optlabel', 'Bot skill', levelL);
    const level = h('select', '', '', levelL);
    level.id = `${idPrefix}level`;
    for (const l of BOT_LEVELS) level.add(new Option(l === 'easy' ? 'Easy' : l === 'hard' ? 'Hard' : 'Normal', l));
    level.value = value.botLevel;
    level.addEventListener('change', () => onChange({ botLevel: level.value as BotLevel }));
    const syncLevel = (): void => { level.disabled = !botBox.checked; levelL.classList.toggle('off', !botBox.checked); };
    botBox.addEventListener('change', () => { syncLevel(); onChange({ fillBots: botBox.checked }); });
    syncLevel();
    return grid;
}

/** The same options, read-only, in the same order and grid (what players who cannot change them see). */
export function optionSummary(parent: HTMLElement, o: RoomOptions, mapName: string): HTMLElement {
    const grid = h('div', 'optgrid readonly', '', parent);
    grid.title = 'Chosen by the room creator';
    for (const [label, value] of describeOptions(o, mapName)) {
        const f = h('div', label === 'Visibility' ? 'optfield wide' : 'optfield', '', grid);
        h('span', 'optlabel', label, f);
        h('span', 'optvalue', value, f);
    }
    return grid;
}

/**
 * The public room list: a header row, one row per room (code, map, players, phase) with a Join button, a Refresh button
 * in `head`. `onEmpty` is a button inside the empty state ("Create a public room").
 */
export function roomListView(
    parent: HTMLElement, head: HTMLElement, load: () => Promise<RoomListEntry[]>, join: (code: string) => void, onEmpty?: () => void
): { refresh(): void; el: HTMLElement } {
    const refreshBtn = button('Refresh', '', head, () => refresh());
    const list = h('div', 'rooms', '', parent);
    list.id = 'room-list';
    list.setAttribute('aria-live', 'polite');
    let ticket = 0;

    const show = (text: string, action?: [string, () => void]): void => {
        list.replaceChildren();
        const box = h('div', 'emptybox', '', list);
        h('p', 'dim', text, box);
        if (action) button(action[0], '', box, action[1]);
    };
    const refresh = (): void => {
        const mine = ++ticket;
        refreshBtn.disabled = true;
        show('Looking for rooms…');
        load().then(rooms => {
            if (mine !== ticket) return;
            if (rooms.length === 0) {
                show('No public rooms right now. Make the first one, or practise alone while you wait.', onEmpty ? ['Create a public room', onEmpty] : undefined);
                return;
            }
            list.replaceChildren();
            const cols = h('div', 'room cols', '', list);
            for (const c of ['Room', 'Map', 'Players', 'State', '']) h('span', '', c, cols);
            for (const r of rooms) {
                const row = h('div', 'room', '', list);
                h('b', '', r.code, row);
                h('span', '', r.mapName, row);
                h('span', '', crowdText(r.players, r.bots, r.capacity), row);
                h('span', 'dim', r.phase === 'match' && r.score ? `Match ${r.score.ghosts}:${r.score.defenders}` : 'Lobby', row);
                const full = r.players >= r.capacity;
                const go = button(full ? 'Full' : 'Join', '', row, () => join(r.code));
                go.disabled = full;
                go.setAttribute('aria-label', `${full ? 'Full' : 'Join'} room ${r.code}`);
            }
        }, () => { if (mine === ticket) show('Could not load the room list. Is the server reachable?', ['Try again', () => refresh()]); })
            .finally(() => { if (mine === ticket) refreshBtn.disabled = false; });
    };
    refresh();
    return { refresh, el: list };
}
