/** Player settings, kept in localStorage and applied the moment they change. */

export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
    /** Multiplier on the base mouse sensitivity (1 = 0.0022 rad per pixel). */
    sensitivity: number;
    invertY: boolean;
    /** Vertical field of view in degrees. */
    fov: number;
    /** 0..1 */
    master: number;
    effects: number;
    footsteps: number;
    crosshairStyle: 'dot' | 'cross' | 'ring';
    crosshairColor: string;
    crosshairSize: number;
    showStats: boolean;
    quality: Quality;
    /** Crouch, quiet walk and aim: false = hold the key, true = press once to switch on, again to switch off. */
    crouchToggle: boolean;
    walkToggle: boolean;
    aimToggle: boolean;
    /** Multiplier on mouse look while aiming down sights, on top of the zoom slowdown. */
    aimSensitivity: number;
}

export const DEFAULT_SETTINGS: Settings = {
    sensitivity: 1, invertY: false, fov: 74, master: 0.8, effects: 1, footsteps: 1,
    crosshairStyle: 'dot', crosshairColor: '#e8eaed', crosshairSize: 4, showStats: false, quality: 'high',
    crouchToggle: false, walkToggle: false, aimToggle: false, aimSensitivity: 1
};

/** What each graphics choice does for now: the highest render-resolution scale the adaptive step may reach. */
export const QUALITY_RES: Record<Quality, number> = { low: 0.6, medium: 0.8, high: 1 };

const KEY = 'sb-settings';

const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/** Reads stored settings, falling back to defaults for anything missing or invalid. */
export function loadSettings(): Settings {
    let raw: Record<string, unknown> = {};
    try {
        const text = localStorage.getItem(KEY);
        if (text) raw = JSON.parse(text) as Record<string, unknown>;
    } catch { /* storage blocked or corrupt: defaults */ }
    const d = DEFAULT_SETTINGS;
    return {
        sensitivity: clamp(raw.sensitivity, 0.1, 4, d.sensitivity),
        invertY: raw.invertY === true,
        fov: Math.round(clamp(raw.fov, 60, 110, d.fov)),
        master: clamp(raw.master, 0, 1, d.master),
        effects: clamp(raw.effects, 0, 1, d.effects),
        footsteps: clamp(raw.footsteps, 0, 1, d.footsteps),
        crosshairStyle: raw.crosshairStyle === 'cross' || raw.crosshairStyle === 'ring' ? raw.crosshairStyle : 'dot',
        crosshairColor: typeof raw.crosshairColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.crosshairColor) ? raw.crosshairColor : d.crosshairColor,
        crosshairSize: Math.round(clamp(raw.crosshairSize, 2, 12, d.crosshairSize)),
        showStats: raw.showStats === true,
        quality: raw.quality === 'low' || raw.quality === 'medium' ? raw.quality : 'high',
        crouchToggle: raw.crouchToggle === true,
        walkToggle: raw.walkToggle === true,
        aimToggle: raw.aimToggle === true,
        aimSensitivity: clamp(raw.aimSensitivity, 0.25, 2, d.aimSensitivity)
    };
}

/** The live settings object plus change notification. */
export class SettingsStore {
    readonly value: Settings = loadSettings();
    private readonly listeners: ((s: Settings) => void)[] = [];

    /** Calls `fn` now and on every change. */
    watch(fn: (s: Settings) => void): void {
        this.listeners.push(fn);
        fn(this.value);
    }

    set<K extends keyof Settings>(key: K, v: Settings[K]): void {
        this.value[key] = v;
        try { localStorage.setItem(KEY, JSON.stringify(this.value)); } catch { /* not saved */ }
        for (const fn of this.listeners) fn(this.value);
    }

    reset(): void {
        Object.assign(this.value, DEFAULT_SETTINGS);
        try { localStorage.setItem(KEY, JSON.stringify(this.value)); } catch { /* not saved */ }
        for (const fn of this.listeners) fn(this.value);
    }
}
