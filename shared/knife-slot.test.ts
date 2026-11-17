import { describe, expect, it } from 'vitest';
import { KNIFE_COOLDOWN_TICKS, KNIFE_WINDUP_TICKS } from './constants';
import {
    GUN_IDLE, MELEE_SLASH, MELEE_SWING, aimFraction, cancelReloads, copyLoadout, createLoadout, heldGun, heldWeapon,
    holdingKnife, justSwitched, recoilScale, resetLoadout, sameLoadout, stepLoadout, type LoadoutInput, type LoadoutState
} from './gun';
import { DEFENDER_KNIFE, SIGHT_IRON, SLOT_COUNT, SLOT_KNIFE, SLOT_PISTOL, SLOT_RIFLE, WEAPONS, slotId, slotLabel } from './weapons';

const RIFLE = WEAPONS[SLOT_RIFLE];
const PISTOL = WEAPONS[SLOT_PISTOL];
const input = (over: Partial<LoadoutInput> = {}): LoadoutInput =>
    ({ fire: false, reload: false, slot: 0, swap: false, aim: false, ...over });
function runL(l: LoadoutState, n: number, each: (i: number) => Partial<LoadoutInput> = () => ({}), armed = true): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(stepLoadout(l, input(each(i)), armed));
    return out;
}
/** A fresh loadout with the knife drawn and ready. */
function knifeReady(): LoadoutState {
    const l = createLoadout();
    stepLoadout(l, input({ slot: 3 }), true);
    runL(l, DEFENDER_KNIFE.drawTicks);
    expect(l.draw).toBe(0);
    return l;
}
/**
 * The slot request the mouse wheel makes (client/src/input.ts `sampleWeapons`): from the slot in hand, `steps`
 * notches, wrapping over every slot. Repeated here because input.ts needs a browser.
 */
const wheel = (held: number, steps: number): number => ((((held + steps) % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT) + 1;

describe('defender knife: the slot', () => {
    it('is slot 3, after the two guns, with the numbers decided for it', () => {
        expect(SLOT_KNIFE).toBe(2);
        expect(SLOT_COUNT).toBe(3);
        expect(slotId(SLOT_KNIFE)).toBe('knife');
        expect(slotLabel(SLOT_KNIFE)).toBe('Knife');
        expect(DEFENDER_KNIFE).toMatchObject({
            drawTicks: 18, windupTicks: KNIFE_WINDUP_TICKS, cooldownTicks: KNIFE_COOLDOWN_TICKS, damage: 35, backstabDamage: 70
        });
        expect(KNIFE_WINDUP_TICKS).toBe(12); // 0.2 s, like the ghosts'
    });

    it('takes key 3 and the draw time, then swings, lands after the windup, and waits out the cooldown', () => {
        const l = createLoadout();
        stepLoadout(l, input({ slot: 3 }), true);
        expect(l).toMatchObject({ slot: SLOT_KNIFE, prev: SLOT_RIFLE, draw: DEFENDER_KNIFE.drawTicks });
        expect(justSwitched(l)).toBe(true);
        expect(holdingKnife(l)).toBe(true);
        expect(heldWeapon(l)).toBeNull();
        expect(heldGun(l)).toBeNull();
        // Nothing swings during the draw, however long the trigger is held.
        const drawing = runL(l, DEFENDER_KNIFE.drawTicks - 1, () => ({ fire: true }));
        expect(drawing.every(r => r === GUN_IDLE)).toBe(true);
        expect(l.draw).toBe(1);
        // Held: the draw ends on the next command and a swing starts on it, lands after exactly the windup, and the next starts after the cooldown.
        const held = runL(l, 2 * KNIFE_COOLDOWN_TICKS + 1, () => ({ fire: true }));
        const swings = held.map((r, i) => (r === MELEE_SWING ? i : -1)).filter(i => i >= 0);
        const slashes = held.map((r, i) => (r === MELEE_SLASH ? i : -1)).filter(i => i >= 0);
        expect(swings).toEqual([0, KNIFE_COOLDOWN_TICKS, 2 * KNIFE_COOLDOWN_TICKS]);
        expect(slashes).toEqual([KNIFE_WINDUP_TICKS, KNIFE_COOLDOWN_TICKS + KNIFE_WINDUP_TICKS]);
        // No gun was touched.
        expect(l.guns.map(g => g.mag)).toEqual([RIFLE.magSize, PISTOL.magSize]);
    });

    it('lands a swing that was started even if the trigger is let go', () => {
        const l = knifeReady();
        expect(stepLoadout(l, input({ fire: true }), true)).toBe(MELEE_SWING);
        const r = runL(l, KNIFE_WINDUP_TICKS);
        expect(r.filter(x => x === MELEE_SLASH)).toHaveLength(1);
        expect(r.at(-1)).toBe(MELEE_SLASH);
    });

    it('has no aim: aiming does nothing while it is held, and switching to it drops aim to 0 at once', () => {
        const l = createLoadout();
        runL(l, RIFLE.adsTicks, () => ({ aim: true }));
        expect(aimFraction(l)).toBe(1);
        stepLoadout(l, input({ slot: 3, aim: true }), true);
        expect(l.aim).toBe(0);
        runL(l, 60, () => ({ aim: true }));
        expect(l.aim).toBe(0);
        expect(aimFraction(l)).toBe(0);
        expect(recoilScale(l)).toBe(1);
    });

    it('ignores reload, and lets the guns recover their recoil and finish nothing while it is held', () => {
        const l = createLoadout();
        runL(l, 5 * RIFLE.fireInterval, () => ({ fire: true }));
        const burst = l.guns[SLOT_RIFLE].burst;
        expect(burst).toBeGreaterThan(0);
        stepLoadout(l, input({ slot: 3 }), true);
        runL(l, 200, () => ({ reload: true }));
        expect(l.guns[SLOT_RIFLE].burst).toBe(0); // recovered while away
        expect(l.guns.every(g => g.reload === 0)).toBe(true);
        expect(l.guns[SLOT_RIFLE].mag).toBe(RIFLE.magSize - 5);
    });

    it('switches with Q both ways, and the mouse wheel reaches it and wraps past it', () => {
        const l = knifeReady();
        expect(l.prev).toBe(SLOT_RIFLE);
        stepLoadout(l, input({ swap: true }), true);
        expect(l).toMatchObject({ slot: SLOT_RIFLE, prev: SLOT_KNIFE, draw: RIFLE.drawTicks });
        stepLoadout(l, input({ swap: true }), true);
        expect(l).toMatchObject({ slot: SLOT_KNIFE, prev: SLOT_RIFLE, draw: DEFENDER_KNIFE.drawTicks });

        // Wheel: pistol + 1 notch is the knife, knife + 1 wraps to the rifle, rifle - 1 wraps to the knife.
        expect(wheel(SLOT_PISTOL, 1)).toBe(3);
        expect(wheel(SLOT_KNIFE, 1)).toBe(1);
        expect(wheel(SLOT_RIFLE, -1)).toBe(3);
        const w = createLoadout();
        stepLoadout(w, input({ slot: wheel(w.slot, -1) }), true);
        expect(w.slot).toBe(SLOT_KNIFE);
        stepLoadout(w, input({ slot: wheel(w.slot, 1) }), true);
        expect(w.slot).toBe(SLOT_RIFLE);
        stepLoadout(w, input({ slot: wheel(w.slot, 2) }), true);
        expect(w.slot).toBe(SLOT_KNIFE);
    });

    it('cancels a windup in progress when switching away: it never lands, the cooldown keeps running', () => {
        const l = knifeReady();
        expect(stepLoadout(l, input({ fire: true }), true)).toBe(MELEE_SWING);
        runL(l, 5);
        expect(l.knife.windup).toBeGreaterThan(0);
        stepLoadout(l, input({ slot: 1 }), true);
        expect(l.knife.windup).toBe(0);
        const cooldown = l.knife.cooldown;
        expect(cooldown).toBe(KNIFE_COOLDOWN_TICKS - 6); // set on the swing, then 5 commands and the switch
        // Timers run while the knife is put away; nothing lands.
        const away = runL(l, 10);
        expect(away.some(r => r === MELEE_SLASH || r === MELEE_SWING)).toBe(false);
        expect(l.knife.cooldown).toBe(cooldown - 10);
        // Back to the knife: no leftover swing, and a new one only once the cooldown is out.
        stepLoadout(l, input({ slot: 3 }), true);
        const left = l.knife.cooldown;
        expect(left).toBeGreaterThan(DEFENDER_KNIFE.drawTicks); // the cooldown outlasts the draw here
        const back = runL(l, DEFENDER_KNIFE.drawTicks + KNIFE_COOLDOWN_TICKS, () => ({ fire: true }));
        const firstSwing = back.indexOf(MELEE_SWING);
        expect(firstSwing).toBe(left - 1); // the first command on which the cooldown is out
        expect(back.indexOf(MELEE_SLASH)).toBe(firstSwing + KNIFE_WINDUP_TICKS);
    });

    it('holds a due swing while unarmed (defusing) and lands it on the first armed command', () => {
        const l = knifeReady();
        stepLoadout(l, input({ fire: true }), true);
        expect(runL(l, KNIFE_WINDUP_TICKS + 5, () => ({}), false).includes(MELEE_SLASH)).toBe(false);
        expect(l.knife.windup).toBe(1);
        expect(stepLoadout(l, input(), true)).toBe(MELEE_SLASH);
        // And never starts a swing unarmed.
        const fresh = knifeReady();
        expect(runL(fresh, 30, () => ({ fire: true }), false).includes(MELEE_SWING)).toBe(false);
    });

    it('does not fire a freshly drawn pistol from a trigger held through a knife swing', () => {
        const l = knifeReady();
        runL(l, 3, () => ({ fire: true }));
        runL(l, PISTOL.drawTicks + 10, i => ({ fire: true, slot: i === 0 ? 2 : 0 }));
        expect(l.slot).toBe(SLOT_PISTOL);
        expect(l.guns[SLOT_PISTOL].mag).toBe(PISTOL.magSize);
        runL(l, 1);
        expect(stepLoadout(l, input({ fire: true }), true)).toBe(0);
    });

    it('is reset at spawn, cleared at death, and copied and compared with the rest of the loadout', () => {
        const l = knifeReady();
        stepLoadout(l, input({ fire: true }), true);
        const copy = createLoadout();
        copyLoadout(copy, l);
        expect(sameLoadout(copy, l)).toBe(true);
        expect(copy.knife).not.toBe(l.knife);
        copy.knife.windup--;
        expect(sameLoadout(copy, l)).toBe(false);
        cancelReloads(l);
        expect(l.knife).toEqual({ cooldown: 0, windup: 0 });
        resetLoadout(l, SIGHT_IRON);
        expect(sameLoadout(l, createLoadout())).toBe(true);
        expect(l.slot).toBe(SLOT_RIFLE);
    });

    it('counts only processed commands: the same inputs give the same results whatever the command numbers', () => {
        // stepLoadout never sees `seq`; this pins that a scripted session is a pure function of its inputs.
        const script = (): number[] => {
            const l = createLoadout();
            return runL(l, 400, i => ({
                slot: i === 5 ? 3 : i === 150 ? 1 : i === 170 ? 3 : 0, swap: i === 300, fire: i % 7 < 5, aim: i % 50 < 10
            }));
        };
        const a = script();
        expect(a.filter(r => r === MELEE_SLASH).length).toBeGreaterThan(3);
        expect(script()).toEqual(a);
    });
});
