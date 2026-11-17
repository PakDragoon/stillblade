/**
 * Key and mouse bindings: one table of actions, and pure functions around it.
 *
 * Adding an action is one row in `ACTIONS` ("Drop bomb", package C, was added that way). Everything else, the
 * settings list, the controls page, conflict detection and the on-screen hints, reads this table.
 *
 * An input is a string: a keyboard `KeyboardEvent.code` ("KeyG", "ShiftLeft", "Digit1") or a mouse
 * button ("Mouse0" left, "Mouse1" middle, "Mouse2" right, "Mouse3" and "Mouse4" the side buttons).
 * Esc is never bindable: the browser owns it for the pointer lock. The mouse wheel stays fixed to
 * weapon cycling. Nothing here touches the DOM except `BindingsStore`, which uses localStorage.
 */

import { MOUSE_CODES } from './mouse-buttons';

/**
 * When an action can be used: `lobby` only in warmup, `round` only outside warmup, `any` always.
 * Two actions conflict on a shared input only if their contexts can be active at the same time.
 */
export type ActionContext = 'any' | 'lobby' | 'round';

export interface ActionDef {
    id: string;
    label: string;
    group: string;
    /** Default primary and optional secondary input. */
    defaults: readonly [string, string?];
    context: ActionContext;
}

export const GROUPS = ['Movement', 'Weapons', 'Interface', 'Warmup lobby'] as const;

export const ACTIONS = [
    { id: 'forward', label: 'Move forward', group: 'Movement', defaults: ['KeyW'], context: 'any' },
    { id: 'back', label: 'Move back', group: 'Movement', defaults: ['KeyS'], context: 'any' },
    { id: 'left', label: 'Move left', group: 'Movement', defaults: ['KeyA'], context: 'any' },
    { id: 'right', label: 'Move right', group: 'Movement', defaults: ['KeyD'], context: 'any' },
    { id: 'jump', label: 'Jump', group: 'Movement', defaults: ['Space'], context: 'any' },
    { id: 'walk', label: 'Quiet walk', group: 'Movement', defaults: ['ShiftLeft'], context: 'any' },
    { id: 'crouch', label: 'Crouch', group: 'Movement', defaults: ['KeyC', 'ControlLeft'], context: 'any' },
    { id: 'fire', label: 'Attack', group: 'Weapons', defaults: ['Mouse0', 'KeyF'], context: 'any' },
    { id: 'aim', label: 'Aim down sights', group: 'Weapons', defaults: ['Mouse2', 'KeyZ'], context: 'any' },
    { id: 'reload', label: 'Reload', group: 'Weapons', defaults: ['KeyR'], context: 'any' },
    { id: 'use', label: 'Plant or defuse (hold)', group: 'Weapons', defaults: ['KeyE'], context: 'any' },
    { id: 'dropBomb', label: 'Drop bomb (bomb carrier)', group: 'Weapons', defaults: ['KeyG'], context: 'round' },
    { id: 'prevWeapon', label: 'Previous weapon', group: 'Weapons', defaults: ['KeyQ'], context: 'any' },
    { id: 'slot1', label: 'Weapon 1 (rifle)', group: 'Weapons', defaults: ['Digit1'], context: 'any' },
    { id: 'slot2', label: 'Weapon 2 (pistol)', group: 'Weapons', defaults: ['Digit2'], context: 'any' },
    { id: 'slot3', label: 'Weapon 3', group: 'Weapons', defaults: ['Digit3'], context: 'any' },
    { id: 'scores', label: 'Scoreboard (hold)', group: 'Interface', defaults: ['Tab'], context: 'any' },
    { id: 'chatAll', label: 'Chat to everyone', group: 'Interface', defaults: ['Enter'], context: 'any' },
    { id: 'chatTeam', label: 'Chat to your team', group: 'Interface', defaults: ['KeyY'], context: 'any' },
    { id: 'specPrev', label: 'Follow previous teammate (dead)', group: 'Interface', defaults: ['ArrowLeft'], context: 'any' },
    { id: 'specNext', label: 'Follow next teammate (dead)', group: 'Interface', defaults: ['ArrowRight'], context: 'any' },
    { id: 'ready', label: 'Ready or not ready', group: 'Warmup lobby', defaults: ['KeyG'], context: 'lobby' },
    { id: 'start', label: 'Start the match (creator)', group: 'Warmup lobby', defaults: ['KeyU'], context: 'lobby' },
    { id: 'switchTeam', label: 'Switch team', group: 'Warmup lobby', defaults: ['KeyM'], context: 'lobby' },
    { id: 'lobbyPanel', label: 'Open the lobby panel', group: 'Warmup lobby', defaults: ['KeyL'], context: 'lobby' }
] as const satisfies readonly ActionDef[];

export type ActionId = typeof ACTIONS[number]['id'];
export type Slot = 0 | 1;
/** Primary and secondary input of every action; null is "unbound". */
export type BindingMap = Record<ActionId, [string | null, string | null]>;

const BY_ID = new Map<string, ActionDef>(ACTIONS.map(a => [a.id, a]));

export function actionDef(id: string): ActionDef | undefined {
    return BY_ID.get(id);
}

export function defaultBindings(): BindingMap {
    const map = {} as BindingMap;
    for (const a of ACTIONS) map[a.id] = [a.defaults[0], a.defaults[1] ?? null];
    return map;
}

export function cloneBindings(map: BindingMap): BindingMap {
    const out = {} as BindingMap;
    for (const a of ACTIONS) out[a.id] = [map[a.id][0], map[a.id][1]];
    return out;
}

// ---- inputs --------------------------------------------------------------------------------------

const MOUSE_RE = /^Mouse[0-4]$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,23}$/;

/** True for a keyboard code (not Esc) or Mouse0 to Mouse4. */
export function isBindableInput(code: unknown): code is string {
    if (typeof code !== 'string') return false;
    if (MOUSE_RE.test(code)) return true;
    return code !== 'Escape' && !code.startsWith('Mouse') && KEY_RE.test(code);
}

export function mouseInput(button: number): string | null {
    return Number.isInteger(button) && button >= 0 && button <= 4 ? MOUSE_CODES[button] : null;
}

export function isMouseInput(code: string): boolean {
    return MOUSE_RE.test(code);
}

const NAMED: Record<string, string> = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'Page Up', PageDown: 'Page Down', CapsLock: 'Caps Lock', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', IntlBackslash: '\\',
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left Meta', MetaRight: 'Right Meta',
    ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow', ArrowUp: 'Up Arrow', ArrowDown: 'Down Arrow',
    NumpadAdd: 'Numpad +', NumpadSubtract: 'Numpad -', NumpadMultiply: 'Numpad *', NumpadDivide: 'Numpad /',
    NumpadDecimal: 'Numpad .', NumpadEnter: 'Numpad Enter', ContextMenu: 'Menu'
};
const MOUSE_NAMES = ['Left Mouse', 'Middle Mouse', 'Right Mouse', 'Mouse 4', 'Mouse 5'];

/** "KeyG" is "G", "ShiftLeft" is "Left Shift", "Mouse3" is "Mouse 4". Unknown codes are shown as they are. */
export function inputLabel(code: string): string {
    if (MOUSE_RE.test(code)) return MOUSE_NAMES[Number(code.slice(5))];
    if (NAMED[code]) return NAMED[code];
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1];
    m = /^Digit([0-9])$/.exec(code);
    if (m) return m[1];
    m = /^Numpad([0-9])$/.exec(code);
    if (m) return `Numpad ${m[1]}`;
    return code;
}

/** The code to bind for a key press: `code`, which is layout independent. */
export function inputFromKeyEvent(e: { code: string }): string | null {
    return isBindableInput(e.code) ? e.code : null;
}

// ---- validation ----------------------------------------------------------------------------------

/**
 * Reads a stored value. Each action is validated on its own: anything that is not a two-element
 * array of valid input or null falls back to that action's default, and unknown actions are ignored.
 * An input used twice within one action keeps only its first place.
 */
export function parseBindings(raw: unknown): BindingMap {
    const out = defaultBindings();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
    const src = raw as Record<string, unknown>;
    for (const a of ACTIONS) {
        const v = src[a.id];
        if (!Array.isArray(v) || v.length !== 2) continue;
        const [p, s] = v as unknown[];
        const ok = (x: unknown): x is string | null => x === null || isBindableInput(x);
        if (!ok(p) || !ok(s)) continue;
        out[a.id] = [p, s !== null && s === p ? null : s];
    }
    return out;
}

// ---- conflicts -----------------------------------------------------------------------------------

/** Contexts that can be active together: `any` overlaps everything, `lobby` and `round` never overlap. */
export function contextsOverlap(a: ActionContext, b: ActionContext): boolean {
    return a === 'any' || b === 'any' || a === b;
}

/** The other actions that already use `input` and could be active together with `id`. */
export function conflictsWith(map: BindingMap, id: ActionId, input: string): ActionId[] {
    const me = BY_ID.get(id);
    if (!me) return [];
    const out: ActionId[] = [];
    for (const a of ACTIONS) {
        if (a.id === id || !contextsOverlap(a.context, me.context)) continue;
        if (map[a.id][0] === input || map[a.id][1] === input) out.push(a.id);
    }
    return out;
}

/** Every action that shares an input with another action it could be active with. */
export function findConflicts(map: BindingMap): Set<ActionId> {
    const out = new Set<ActionId>();
    for (const a of ACTIONS) {
        for (const input of map[a.id]) {
            if (input === null) continue;
            for (const other of conflictsWith(map, a.id, input)) { out.add(a.id); out.add(other); }
        }
    }
    return out;
}

/**
 * Binds `input` to one slot of `id` and returns the new map. The new binding wins: any conflicting
 * action loses the input and takes the input this slot held (a swap), or is left without it when the
 * slot was empty. Binding an input to the other slot of the same action moves it.
 */
export function assignBinding(map: BindingMap, id: ActionId, slot: Slot, input: string): BindingMap {
    const out = cloneBindings(map);
    const previous = out[id][slot];
    if (out[id][1 - slot as Slot] === input) out[id][1 - slot as Slot] = previous;
    for (const other of conflictsWith(map, id, input)) {
        for (const s of [0, 1] as const) if (out[other][s] === input) out[other][s] = previous;
    }
    out[id][slot] = input;
    return out;
}

/** True if `code` is one of the two inputs bound to `id`. */
export function inputMatches(map: BindingMap, id: ActionId, code: string): boolean {
    return map[id][0] === code || map[id][1] === code;
}

/** Clears the secondary binding (the primary is only ever replaced, never emptied by the player). */
export function clearSecondary(map: BindingMap, id: ActionId): BindingMap {
    const out = cloneBindings(map);
    out[id][1] = null;
    return out;
}

export function resetAction(map: BindingMap, id: ActionId): BindingMap {
    const out = cloneBindings(map);
    out[id] = [...defaultBindings()[id]] as [string | null, string | null];
    return out;
}

// ---- display -------------------------------------------------------------------------------------

/** What a hint should show for an action: the primary input, or the secondary if the primary is gone. */
export function hintText(map: BindingMap, id: ActionId): string {
    const [p, s] = map[id];
    const use = p ?? s;
    return use === null ? 'unbound' : inputLabel(use);
}

/** Both inputs, "G or Left Mouse", for the controls page. */
export function fullText(map: BindingMap, id: ActionId): string {
    const [p, s] = map[id];
    const parts = [p, s].filter((x): x is string => x !== null).map(inputLabel);
    return parts.length === 0 ? 'unbound' : parts.join(' or ');
}

// ---- store ---------------------------------------------------------------------------------------

const STORAGE_KEY = 'sb-bindings';

/** Minimal slice of Storage so tests can pass a fake. */
export interface KeyValueStorage {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
}

/** The live bindings plus change notification. `version` rises on every change so cached hints can refresh. */
export class BindingsStore {
    private map: BindingMap;
    private readonly listeners: ((m: BindingMap) => void)[] = [];
    /** Bumped on every change. */
    version = 0;

    constructor(private readonly storage: KeyValueStorage | null = defaultStorage()) {
        let raw: unknown = null;
        try {
            const text = storage?.getItem(STORAGE_KEY);
            if (text) raw = JSON.parse(text);
        } catch { /* storage blocked or corrupt: defaults */ }
        this.map = parseBindings(raw);
    }

    get value(): BindingMap {
        return this.map;
    }

    watch(fn: (m: BindingMap) => void): void {
        this.listeners.push(fn);
        fn(this.map);
    }

    set(map: BindingMap): void {
        this.map = cloneBindings(map);
        this.version++;
        try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.map)); } catch { /* not saved */ }
        for (const fn of this.listeners) fn(this.map);
    }

    reset(): void {
        this.set(defaultBindings());
    }

    hint(id: ActionId): string {
        return hintText(this.map, id);
    }
}

function defaultStorage(): KeyValueStorage | null {
    try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

let shared: BindingsStore | null = null;

/** The one store the game uses (input, menus and HUD hints all read it). */
export function bindings(): BindingsStore {
    shared ??= new BindingsStore();
    return shared;
}
