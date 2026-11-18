import { KNIFE_COOLDOWN_TICKS, KNIFE_WINDUP_TICKS, TICK_RATE } from './constants';

/**
 * Every defender weapon's numbers, in one table. The rules that use them live in `shared/gun.ts`;
 * adding a weapon is a new row here (plus a model and sounds), not new rules.
 *
 * Timings are counted in the shooter's own processed commands (60 per second), like movement, so
 * client and server agree on them exactly. Every counter travels in one byte of the snapshot: keep
 * magazine, reserve, reload (both kinds), draw, aim and fire-interval values at or below 255 (a test
 * checks), and the knife's draw, windup and cooldown too.
 */
export interface WeaponDef {
    /** Stable name used by the presentation (models, sounds). */
    readonly id: WeaponId;
    /** Shown on the HUD. */
    readonly label: string;
    /** Holding the trigger keeps firing; otherwise every shot needs a new press. */
    readonly auto: boolean;
    /** Minimum commands between shots. */
    readonly fireInterval: number;
    readonly magSize: number;
    /** Spare rounds at spawn; refilled every round. */
    readonly reserve: number;
    /** Commands a reload takes; fire is impossible meanwhile. */
    readonly reloadTicks: number;
    /**
     * Commands a reload takes when it starts with an empty magazine (the "empty reload": after the new magazine the
     * bolt or slide must be worked to chamber a round). At least `reloadTicks`; equal when the gun has no separate
     * empty reload. `reloadTicksOf` (shared/gun.ts) picks between the two.
     */
    readonly reloadEmptyTicks: number;
    /** Commands from selecting this weapon until it can fire (the switch). */
    readonly drawTicks: number;
    /** Damage of a torso hit; other body parts scale it by `ZONE_MULTIPLIER` (shared/zones.ts). */
    readonly bodyDamage: number;
    /** Spread cone half-angles (radians): standing still, crouched still, added at full run, in the air. */
    readonly spreadStill: number;
    readonly spreadCrouched: number;
    readonly spreadMoving: number;
    readonly spreadAir: number;
    /** Commands without a shot before recoil starts to recover (more than `fireInterval`). */
    readonly recoilRecoverTicks: number;
    /** Once recovering, one row of the pattern is undone every this many commands. */
    readonly recoilDecayTicks: number;
    /** Recoil pattern in degrees, [pitch up, yaw left] per shot of an uninterrupted burst. */
    readonly patternDeg: readonly (readonly [number, number])[];
    /**
     * Aim down sights: commands to go fully in (and out). For a gun that `takesSights`, the sight in use
     * decides (`SIGHTS`); the value here is then the default sight's, used where no loadout is known.
     */
    readonly adsTicks: number;
    /** Field-of-view magnification when fully aimed (1.5 = things look 1.5 times bigger). Same rule as `adsTicks`. */
    readonly adsZoom: number;
    /** The sight the player chose (`SIGHTS`) replaces this gun's aim time and zoom. Only the rifle. */
    readonly takesSights: boolean;
    /** Spread and recoil multipliers when fully aimed (blended in by aim progress). */
    readonly adsSpread: number;
    readonly adsRecoil: number;
}

export type WeaponId = 'rifle' | 'pistol';

const ticks = (ms: number): number => Math.round((ms / 1000) * TICK_RATE);

/**
 * A rifle sight (package M). The player picks one in the loadout page; the server makes the choice
 * active at that player's next spawn (`resetLoadout`), and the active sight travels in the self snapshot
 * (`LoadoutState.sight`, one byte) so the client predicts aim exactly. A sight changes only the aimed zoom
 * and the aim-in time: spread, recoil and their aim multipliers stay the gun's (`WeaponDef`).
 * `adsTicks` travels as `LoadoutState.aim`, one byte: keep it at or below 255 (a test checks).
 */
export interface SightDef {
    /** Stable name used by the presentation (the sight mesh on the gun, the overlay) and the saved loadout. */
    readonly id: SightId;
    /** Shown in the loadout page. */
    readonly label: string;
    /** One line in the loadout page on what it does. */
    readonly blurb: string;
    /** Commands to aim fully in (and out). */
    readonly adsTicks: number;
    /** Field-of-view magnification when fully aimed. */
    readonly adsZoom: number;
}

export type SightId = 'iron' | 'reddot' | 'scope2x';

/**
 * Every rifle sight, indexed by the number that travels (snapshot byte, roster, join query, `sight`
 * message). Starting values, untuned: they need the owner's hands on a mouse.
 */
export const SIGHTS: readonly SightDef[] = [
    { id: 'iron', label: 'Iron sights', blurb: "The rifle's own sights. Fastest to aim, slight zoom (1.3x).", adsTicks: 12, adsZoom: 1.3 },
    { id: 'reddot', label: '1x red dot', blurb: 'A red dot on clear glass: quick to aim, easy to track targets (1.4x).', adsTicks: 12, adsZoom: 1.4 },
    { id: 'scope2x', label: '2x scope', blurb: 'Twice the zoom for long lanes, but slower to aim and a narrow view (2.0x).', adsTicks: 16, adsZoom: 2.0 }
];
export const SIGHT_COUNT = SIGHTS.length;
/** The sight everyone starts with, bots always use, and anything unreadable falls back to. */
export const SIGHT_IRON = 0;

/** A valid sight index from anything (a saved loadout, a query parameter, a message): unknown is `SIGHT_IRON`. */
export function cleanSight(v: unknown): number {
    const n = typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < SIGHT_COUNT ? n : SIGHT_IRON;
}

/** The sight with this index, or the iron sight for anything out of range. */
export const sightDef = (sight: number): SightDef => SIGHTS[sight >= 0 && sight < SIGHT_COUNT ? sight : SIGHT_IRON];

/** Slot 1: the original defender gun, automatic. */
const RIFLE: WeaponDef = {
    id: 'rifle', label: 'Rifle', auto: true,
    fireInterval: ticks(100), magSize: 30, reserve: 90, reloadTicks: ticks(2200), reloadEmptyTicks: ticks(2700), drawTicks: ticks(400),
    bodyDamage: 34,
    spreadStill: 0.004, spreadCrouched: 0.002, spreadMoving: 0.035, spreadAir: 0.06,
    recoilRecoverTicks: 9, recoilDecayTicks: 2,
    // Climbs for the first shots, then wanders right, left and right again: learnable.
    patternDeg: [
        [0.00, 0.00], [0.30, 0.04], [0.70, -0.04], [1.15, 0.08], [1.65, -0.06],
        [2.15, 0.10], [2.60, 0.02], [3.00, -0.10], [3.35, -0.25], [3.60, -0.45],
        [3.80, -0.70], [3.95, -0.95], [4.05, -1.20], [4.15, -1.40], [4.20, -1.50],
        [4.25, -1.35], [4.30, -1.00], [4.35, -0.55], [4.40, -0.05], [4.45, 0.45],
        [4.50, 0.90], [4.55, 1.20], [4.55, 1.35], [4.60, 1.25], [4.60, 0.95],
        [4.65, 0.55], [4.65, 0.15], [4.70, -0.20], [4.70, -0.45], [4.75, -0.60]
    ],
    // Aim time and zoom come from the sight (SIGHTS); these are the iron sight's, for code with no loadout.
    adsTicks: SIGHTS[SIGHT_IRON].adsTicks, adsZoom: SIGHTS[SIGHT_IRON].adsZoom, takesSights: true, adsSpread: 0.5, adsRecoil: 0.8
};

/** Slot 2: semi-automatic sidearm. A sharp kick per shot that recovers quickly between taps. */
const PISTOL: WeaponDef = {
    id: 'pistol', label: 'Pistol', auto: false,
    fireInterval: ticks(150), magSize: 12, reserve: 36, reloadTicks: ticks(1400), reloadEmptyTicks: ticks(1400), drawTicks: ticks(250),
    bodyDamage: 26,
    spreadStill: 0.003, spreadCrouched: 0.0015, spreadMoving: 0.02, spreadAir: 0.05,
    // Recovery starts one command after the minimum interval and undoes a row every command:
    // measured taps stay accurate, spamming at the limit climbs.
    recoilRecoverTicks: 10, recoilDecayTicks: 1,
    patternDeg: [
        [0.00, 0.00], [0.85, 0.10], [1.55, -0.12], [2.15, 0.18], [2.65, -0.15], [3.05, 0.22],
        [3.35, -0.20], [3.60, 0.25], [3.80, -0.20], [3.95, 0.25], [4.05, -0.15], [4.10, 0.20]
    ],
    adsTicks: 8, adsZoom: 1.2, takesSights: false, adsSpread: 0.6, adsRecoil: 0.85
};

/**
 * The guns, indexed by slot: slot 0 is key 1, slot 1 is key 2. Every defender carries all of them.
 * Guns only: the knife (slot 3, `DEFENDER_KNIFE` below) has no magazine, recoil or aim, so it sits
 * beside this table rather than in it. Code that walks the guns uses `GUN_COUNT`; code that walks
 * every slot a defender can hold uses `SLOT_COUNT` and treats `SLOT_KNIFE` itself.
 */
export const WEAPONS: readonly WeaponDef[] = [RIFLE, PISTOL];
export const GUN_COUNT = WEAPONS.length;
export const SLOT_RIFLE = 0;
export const SLOT_PISTOL = 1;

/** The defender's knife: melee, the same timing rule as the ghosts' knife (shared/knife.ts), weaker. */
export interface MeleeDef {
    readonly id: 'knife';
    readonly label: string;
    /** Commands from selecting it until it can swing (the switch). */
    readonly drawTicks: number;
    /** Commands from the start of a swing until it lands, and from the start until the next may start. */
    readonly windupTicks: number;
    readonly cooldownTicks: number;
    readonly damage: number;
    readonly backstabDamage: number;
}

/** Slot 3 (key 3). Reach, cone and timing are the ghost knife's; only the damage is lower. */
export const DEFENDER_KNIFE: MeleeDef = {
    id: 'knife', label: 'Knife',
    drawTicks: ticks(300),
    // stepKnife (shared/knife.ts) counts these; they are listed here so the table states the whole weapon.
    windupTicks: KNIFE_WINDUP_TICKS, cooldownTicks: KNIFE_COOLDOWN_TICKS,
    damage: 35, backstabDamage: 70
};

/** Slot index of the defender knife: right after the guns. */
export const SLOT_KNIFE = GUN_COUNT;
/** Every slot a defender holds: the guns, then the knife. */
export const SLOT_COUNT = GUN_COUNT + 1;

export type SlotId = WeaponId | 'knife';

/** Whether a slot is a gun (has an entry in WEAPONS). */
export const isGunSlot = (slot: number): boolean => slot >= 0 && slot < GUN_COUNT;

/** Presentation id of a slot (models, sounds); out-of-range slots read as the first gun. */
export function slotId(slot: number): SlotId {
    return slot === SLOT_KNIFE ? 'knife' : WEAPONS[isGunSlot(slot) ? slot : 0].id;
}

/** HUD and kill-feed name of a slot. */
export function slotLabel(slot: number): string {
    return slot === SLOT_KNIFE ? DEFENDER_KNIFE.label : WEAPONS[isGunSlot(slot) ? slot : 0].label;
}

/** Aim-in commands of the gun in `slot` with `sight` mounted (the sight counts only on a gun that takes sights). */
export function adsTicksOf(slot: number, sight: number): number {
    const def = WEAPONS[isGunSlot(slot) ? slot : 0];
    return def.takesSights ? sightDef(sight).adsTicks : def.adsTicks;
}

/** Fully aimed zoom of the gun in `slot` with `sight` mounted (1 for the knife). */
export function adsZoomOf(slot: number, sight: number): number {
    if (!isGunSlot(slot)) return 1;
    const def = WEAPONS[slot];
    return def.takesSights ? sightDef(sight).adsZoom : def.adsZoom;
}

/** Commands it takes to draw the weapon in a slot. */
export function drawTicksOf(slot: number): number {
    return slot === SLOT_KNIFE ? DEFENDER_KNIFE.drawTicks : WEAPONS[slot].drawTicks;
}
