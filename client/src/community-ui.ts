import { ROOM_MAX_PLAYERS, ROOM_MIN_PLAYERS, ROUNDS_TO_WIN_CHOICES, type RoomOptions } from '@shared/room-options';
import type { RoomListEntry } from '@shared/room-list';
import { button, h } from './dom';

/** Players, rounds to win and the three switches as editable controls; `onChange` gets the one field that changed. */
export function optionControls(
    parent: HTMLElement, value: RoomOptions, onChange: (patch: Partial<RoomOptions>) => void, idPrefix: string
): HTMLElement {
    const grid = h('div', 'optgrid', '', parent);
    const check = (key: 'public' | 'suppressed', title: string, hint: string): void => {
        const label = h('label', 'opt', '', grid);
        const box = h('input', '', '', label);
        box.type = 'checkbox'; box.id = `${idPrefix}${key}`; box.checked = value[key];
        box.addEventListener('change', () => onChange({ [key]: box.checked }));
        label.append(title);
        h('small', 'dim', hint, label);
    };
    check('public', 'Public room', 'Listed in the room list; anyone can join');
    check('suppressed', 'Suppressed weapons', 'Quieter gunshots, smaller muzzle flash');

    const players = h('label', 'f', 'Most players', grid);
    const max = h('select', '', '', players);
    max.id = `${idPrefix}max`;
    for (let n = ROOM_MIN_PLAYERS; n <= ROOM_MAX_PLAYERS; n++) max.add(new Option(String(n), String(n)));
    max.value = String(value.maxPlayers);
    max.addEventListener('change', () => onChange({ maxPlayers: Number(max.value) }));

    const rounds = h('label', 'f', 'Rounds to win', grid);
    const win = h('select', '', '', rounds);
    win.id = `${idPrefix}rounds`;
    for (const n of ROUNDS_TO_WIN_CHOICES) win.add(new Option(n === 3 ? '3 (short match)' : n === 9 ? '9 (long match)' : '6 (standard)', String(n)));
    win.value = String(value.roundsToWin);
    win.addEventListener('change', () => onChange({ roundsToWin: Number(win.value) }));

    const bots = h('label', 'opt off', '', grid);
    const botBox = h('input', '', '', bots);
    botBox.type = 'checkbox'; botBox.id = `${idPrefix}bots`; botBox.checked = value.fillBots; botBox.disabled = true;
    bots.append('Fill with bots');
    h('small', 'dim', 'Coming soon', bots);
    return grid;
}

/** The room's options as small tags (what players who cannot change them see). */
export function optionChips(parent: HTMLElement, o: RoomOptions): void {
    const chip = (text: string, on = false): void => { h('span', on ? 'opt on' : 'opt', text, parent); };
    chip(o.public ? 'Public' : 'Private', o.public);
    chip(`Up to ${o.maxPlayers} players`);
    chip(`First to ${o.roundsToWin}`);
    chip(o.suppressed ? 'Suppressed weapons' : 'Unsuppressed weapons', o.suppressed);
    if (o.fillBots) chip('Bots fill empty places', true);
}

/** The public room list in the menu: a refresh button, one row per room, a join button on each. */
export function roomListView(
    parent: HTMLElement, load: () => Promise<RoomListEntry[]>, join: (code: string) => void
): { refresh(): void; el: HTMLElement } {
    const card = h('aside', 'card', '', parent);
    card.id = 'room-list';
    const head = h('div', 'row', '', card);
    h('h3', '', 'Public rooms', head);
    h('span', 'sp', '', head);
    const refreshBtn = button('Refresh', '', head, () => refresh());
    const list = h('div', 'rooms', '', card);
    let ticket = 0;

    const show = (text: string): void => { list.replaceChildren(); h('p', 'dim empty', text, list); };
    const refresh = (): void => {
        const mine = ++ticket;
        refreshBtn.disabled = true;
        show('Looking for rooms…');
        load().then(rooms => {
            if (mine !== ticket) return;
            list.replaceChildren();
            if (rooms.length === 0) { show('No public rooms right now. Make one with "Create room" and tick Public, or use Quick play.'); return; }
            for (const r of rooms) {
                const row = h('div', 'room', '', list);
                const info = h('div', '', '', row);
                h('b', '', r.code, info);
                h('span', 'dim', ` ${r.mapName}`, info);
                const full = r.players >= r.capacity;
                const state = r.phase === 'match' && r.score ? `In match ${r.score.ghosts}:${r.score.defenders}` : 'In the lobby';
                const bits = [`${r.players} / ${r.capacity} players`, state, `first to ${r.options.roundsToWin}`];
                if (r.options.suppressed) bits.push('suppressed');
                h('div', 'dim small', bits.join(' · '), info);
                const go = button(full ? 'Full' : 'Join', full ? '' : 'primary', row, () => join(r.code));
                go.disabled = full;
            }
        }, () => { if (mine === ticket) show('Could not load the room list. Is the server reachable?'); })
            .finally(() => { if (mine === ticket) refreshBtn.disabled = false; });
    };
    refresh();
    return { refresh, el: card };
}
