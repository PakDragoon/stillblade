/**
 * Sound test page (`?soundtest=1`): every sound of the game by group, a Play button for each, and controls for the
 * distance, the direction, a wall in between, suppressed or not, and the footstep surface and loudness. It needs no
 * server and no map, and plays through the real `createAudio` (the same code the game runs) with a tiny made-up
 * world: a floor box of the chosen surface and, when asked, a wall box between you and the sound.
 *
 * The listener stands at the origin facing -Z (north). Front is -Z, left -X, right +X, behind +Z. For headphones.
 */
import { GHOST_MAX_VIS, STEP_LOUD_CROUCH, STEP_LOUD_RUN, STEP_LOUD_WALK, STEP_RANGE, BREATH_RANGE, GUNSHOT_RANGE, GUNSHOT_RANGE_SUPPRESSED, KNIFE_SOUND_RANGE, RELOAD_SOUND_RANGE } from '@shared/constants';
import { SLOT_KNIFE } from '@shared/weapons';
import type { Box, Vec3 } from '@shared/types';
import { createAudio } from './audio';
import type { AudioEngine, BombView, ListenerView } from './audio-api';
import type { RemoteView } from './presenter-api';

type Angle = 'front' | 'left' | 'right' | 'behind';
const DIRS: Record<Angle, [number, number]> = { front: [0, -1], left: [-1, 0], right: [1, 0], behind: [0, 1] };
const EYE = 1.62;
const SURFACE_CATEGORY: Record<string, string> = { concrete: 'outer_wall', metal: 'platform', wood: 'crate' };

const boxes: Box[] = [];
const engine: AudioEngine = createAudio(boxes, { loadDelayMs: 0 });

const state = {
    dist: 8, angle: 'front' as Angle, wall: false, suppressed: false, local: false,
    surface: 'concrete', loud: STEP_LOUD_RUN, recorded: true, gunLayer: true, real: true,
    breathing: false, exert: 0, bombTicking: false, bombLeft: 30
};

/** The made-up world: a floor of the chosen surface, and a wall halfway to the sound when asked. */
function rebuildWorld(): void {
    boxes.length = 0;
    boxes.push({ name: 'floor', category: SURFACE_CATEGORY[state.surface], min: [-200, -1, -200], max: [200, 0, 200] });
    if (state.wall) {
        const [dx, dz] = DIRS[state.angle];
        const mid = state.dist / 2;
        const cx = dx * mid, cz = dz * mid;
        boxes.push({
            name: 'wall', category: 'outer_wall',
            min: [cx - (dx === 0 ? 4 : 0.15), 0, cz - (dz === 0 ? 4 : 0.15)],
            max: [cx + (dx === 0 ? 4 : 0.15), 4, cz + (dz === 0 ? 4 : 0.15)]
        });
    }
}

/** Where a sound is: `state.dist` metres from the listener in the chosen direction, `y` above the floor. */
function where(y = 0): Vec3 {
    const [dx, dz] = DIRS[state.angle];
    return [dx * state.dist, y, dz * state.dist];
}

const listener: ListenerView = { pos: [0, EYE, 0], yaw: 0, pitch: 0, team: 'defenders', alive: true };
const ghost: RemoteView = {
    id: 1, team: 'ghosts', pos: [0, 0, 0], yaw: 0, pitch: 0, crouched: false, alive: true, vis: 0,
    reloading: false, weapon: 0, switching: false, aiming: false
};
const remotes: RemoteView[] = [];
const bomb: BombView = { pos: [0, 0, 0], timeLeft: 30 };

function unlock(): void { engine.unlock(); }

// ---- what each button does ------------------------------------------------------------------

interface Item { label: string; note?: string; run: () => void; }
interface Group { title: string; items: Item[]; }

let reloadId = 100;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function stepOnce(): void { engine.step(where(0), state.loud, state.local); }
async function stepRun(n: number): Promise<void> {
    const gap = state.loud >= 0.9 ? 340 : state.loud >= 0.25 ? 520 : 680;
    for (let i = 0; i < n; i++) { stepOnce(); await sleep(gap); }
}
async function shots(weapon: number, n: number): Promise<void> {
    const gap = weapon === 0 ? 110 : 160;
    for (let i = 0; i < n; i++) { engine.gunshot(where(EYE), state.local, weapon, state.suppressed); await sleep(gap); }
}

const GROUPS: Group[] = [
    {
        title: 'Footsteps (use Surface and Step above)', items: [
            { label: 'One step', run: stepOnce },
            { label: 'Six steps in a row', note: 'at the cadence of the chosen step', run: () => void stepRun(6) },
        ]
    },
    {
        title: 'Gunshots (use Suppressed above)', items: [
            { label: 'Rifle shot', run: () => void shots(0, 1) },
            { label: 'Rifle, 5 shots', run: () => void shots(0, 5) },
            { label: 'Pistol shot', run: () => void shots(1, 1) },
            { label: 'Pistol, 4 shots', run: () => void shots(1, 4) },
            { label: 'Dry fire', run: () => engine.dryFire() },
        ]
    },
    {
        title: 'Reload and weapon switch', items: [
            { label: 'Rifle reload (2.2 s)', note: 'out 0.3 s, in 1.4 s, bolt 1.9 s', run: () => engine.reload(where(0), state.local, 0, reloadId++) },
            { label: 'Pistol reload (1.4 s)', note: 'out 0.15 s, in 0.7 s, slide 1.0 s', run: () => engine.reload(where(0), state.local, 1, reloadId++) },
            { label: 'Reload, cut off after 1 s', note: 'must go silent at once', run: () => { const id = reloadId++; engine.reload(where(0), state.local, 0, id); setTimeout(() => engine.cancelReload(id), 1000); } },
            { label: 'Switch to rifle', run: () => engine.weaponSwitch(0) },
            { label: 'Switch to pistol', run: () => engine.weaponSwitch(1) },
            { label: 'Switch to knife', run: () => engine.weaponSwitch(SLOT_KNIFE) },
        ]
    },
    {
        title: 'Knife', items: [
            { label: 'Windup', note: 'the defender\'s warning', run: () => engine.knifeWindup(where(0), state.local) },
            { label: 'Slash (miss)', run: () => engine.knifeSlash(where(0), false, state.local) },
            { label: 'Slash (hit)', run: () => engine.knifeSlash(where(0), true, state.local) },
            { label: 'Windup then hit', run: () => { engine.knifeWindup(where(0), state.local); setTimeout(() => engine.knifeSlash(where(0), true, state.local), 220); } },
        ]
    },
    {
        title: 'Bomb', items: [
            { label: 'Planted (announcement)', run: () => engine.cue('planted') },
            { label: 'One beep', run: () => { bomb.pos = where(0); bomb.timeLeft = 30; engine.frame(0.016, listener, remotes, bomb); } },
            { label: 'Defused', run: () => engine.cue('defused') },
            { label: 'Exploded', run: () => engine.cue('exploded') },
            { label: 'Dropped', run: () => engine.bomb('drop', where(0), state.local) },
            { label: 'Picked up', run: () => engine.bomb('pickup', where(0), state.local) },
        ]
    },
    {
        title: 'Bullet impacts (use Surface above)', items: [
            { label: 'One impact', run: () => engine.impact(where(0)) },
            { label: 'Five impacts', run: () => { for (let i = 0; i < 5; i++) setTimeout(() => engine.impact(where(0)), i * 140); } },
        ]
    },
    {
        title: 'Your own feedback (no distance)', items: [
            { label: 'Hit marker: body', run: () => engine.hitMarker('body') },
            { label: 'Hit marker: head', run: () => engine.hitMarker('head') },
            { label: 'Hit marker: kill', run: () => engine.hitMarker('kill') },
            { label: 'Hurt', run: () => engine.hurt() },
            { label: 'UI click', run: () => engine.uiClick() },
            { label: 'Round start', run: () => engine.cue('roundStart') },
            { label: 'Round won', run: () => engine.cue('win') },
            { label: 'Round lost', run: () => engine.cue('lose') },
        ]
    },
];

// ---- page -----------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    Object.assign(e, props);
    if (props.class) e.className = props.class;
    for (const k of kids) e.append(k);
    return e;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
    return el('label', {}, text + ' ', control);
}

function build(): void {
    document.title = 'Stillblade sound test';
    document.body.className = '';
    document.body.replaceChildren();
    document.body.style.cssText = 'overflow:auto;background:#101318;color:#e8eaed;font:15px/1.5 system-ui,sans-serif;margin:0';
    const style = el('style', {});
    style.textContent = `
        html,body{height:auto!important;overflow:auto!important}
        #st{max-width:860px;margin:0 auto;padding:16px 20px 60px}
        h1{font-size:22px;margin:8px 0}h2{font-size:16px;margin:22px 0 8px;color:#9fd0ff}
        .bar{position:sticky;top:0;background:#101318;padding:8px 0 10px;border-bottom:1px solid #2a3140;z-index:2}
        .row{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;margin:6px 0}
        label{white-space:nowrap}select,input[type=number]{background:#1b212b;color:#e8eaed;border:1px solid #3a4456;border-radius:4px;padding:3px 6px}
        input[type=range]{vertical-align:middle}
        button{background:#2a6df4;color:#fff;border:0;border-radius:5px;padding:7px 12px;font:inherit;cursor:pointer}
        button:hover{background:#4a85ff}button.off{background:#4a5568}
        .items{display:flex;flex-wrap:wrap;gap:8px}.item{display:flex;flex-direction:column;align-items:flex-start;gap:2px}
        .note{font-size:12px;color:#8b94a5}.status{font-size:13px;color:#c8d1e0}.hint{font-size:12px;color:#8b94a5}
    `;
    document.head.append(style);
    const root = el('div', { id: 'st' });
    root.append(el('h1', {}, 'Stillblade sound test'));
    root.append(el('div', { class: 'hint' }, 'Put on headphones. You stand at the centre facing north (front). Every button plays through the real game audio code.'));

    // Controls (sticky).
    const bar = el('div', { class: 'bar' });
    const distOut = el('b', {}, `${state.dist} m`);
    const dist = el('input', { type: 'range', min: '1', max: '70', step: '0.5', value: String(state.dist) });
    dist.oninput = () => { state.dist = Number(dist.value); distOut.textContent = `${state.dist} m`; rebuildWorld(); };
    const angle = el('select', {}, ...(['front', 'left', 'right', 'behind'] as Angle[]).map(a => el('option', { value: a }, a)));
    angle.onchange = () => { state.angle = angle.value as Angle; rebuildWorld(); };
    const wall = el('input', { type: 'checkbox' });
    wall.onchange = () => { state.wall = wall.checked; rebuildWorld(); };
    const sup = el('input', { type: 'checkbox' });
    sup.onchange = () => { state.suppressed = sup.checked; };
    const local = el('input', { type: 'checkbox' });
    local.onchange = () => { state.local = local.checked; };
    const surface = el('select', {}, ...['concrete', 'metal', 'wood'].map(s => el('option', { value: s }, s)));
    surface.onchange = () => { state.surface = surface.value; rebuildWorld(); };
    const step = el('select', {},
        el('option', { value: String(STEP_LOUD_RUN) }, 'run (full)'),
        el('option', { value: String(STEP_LOUD_WALK) }, 'walk (shift)'),
        el('option', { value: String(STEP_LOUD_CROUCH) }, 'crouch'));
    step.onchange = () => { state.loud = Number(step.value); };
    const rec = el('input', { type: 'checkbox', checked: true });
    rec.onchange = () => { state.recorded = rec.checked; engine.setSoundMode({ recorded: rec.checked }); };
    const real = el('input', { type: 'checkbox', checked: true });
    real.onchange = () => { state.real = real.checked; engine.setSoundMode({ real: real.checked }); };
    const layer = el('input', { type: 'checkbox', checked: true });
    layer.onchange = () => { state.gunLayer = layer.checked; engine.setSoundMode({ gunLayer: layer.checked }); };

    const mk = (name: string, init: number): HTMLInputElement => {
        const s = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(init) });
        s.oninput = () => { vols[name as 'master'] = Number(s.value); engine.setVolumes(vols); };
        return s;
    };
    const vols = { master: 1, effects: 1, footsteps: 1 };

    bar.append(
        el('div', { class: 'row' }, labelled('Distance', dist), distOut, labelled('Direction', angle),
            labelled('Behind a wall', wall), labelled('Suppressed', sup), labelled('As my own sound', local)),
        el('div', { class: 'row' }, labelled('Surface', surface), labelled('Step', step),
            labelled('Recorded samples', rec), labelled('New recordings (guns, breathing)', real), labelled('Old gunshot layer', layer)),
        el('div', { class: 'row' }, labelled('Master', mk('master', 1)), labelled('Effects', mk('effects', 1)), labelled('Footsteps', mk('footsteps', 1))),
    );
    const status = el('div', { class: 'status' });
    bar.append(status);
    root.append(bar);

    // Audible ranges, so the distance slider means something.
    root.append(el('div', { class: 'hint' },
        `Audible ranges: footsteps ${STEP_RANGE} m running, ${(STEP_RANGE * STEP_LOUD_WALK).toFixed(1)} m walking, ${(STEP_RANGE * STEP_LOUD_CROUCH).toFixed(1)} m crouched; ` +
        `gunshots ${GUNSHOT_RANGE} m (${GUNSHOT_RANGE_SUPPRESSED} m suppressed); reload ${RELOAD_SOUND_RANGE} m; knife windup ${KNIFE_SOUND_RANGE} m; breathing ${BREATH_RANGE} m; bomb beep 35 m. ` +
        'Samples play only after the first click, and load in the background: the status line says how many are in. ' +
        'Switch "Recorded samples" off to hear the synthesised sound it replaces. Package N: "New recordings" is the real gunshots and breathing; switch it off to hear the old versions from package H ' +
        '(synthesised shot under a recorded thump, synthesised breathing); with it off, "Old gunshot layer" off is the pure synthesised shot.'));

    // Looping things.
    const loops = el('div', { class: 'items' });
    const breathBtn = el('button', {}, 'Ghost breathing: off');
    const exert = el('select', {}, el('option', { value: '0' }, 'calm (standing still)'), el('option', { value: '0.5' }, 'half exerted'), el('option', { value: '1' }, 'running (exerted)'));
    exert.onchange = () => { state.exert = Number(exert.value); };
    breathBtn.onclick = () => {
        unlock();
        state.breathing = !state.breathing;
        breathBtn.textContent = `Ghost breathing: ${state.breathing ? 'ON' : 'off'}`;
        breathBtn.className = state.breathing ? '' : 'off';
    };
    breathBtn.className = 'off';
    const bombBtn = el('button', {}, 'Bomb beeping (30 s countdown): off');
    bombBtn.className = 'off';
    bombBtn.onclick = () => {
        unlock();
        state.bombTicking = !state.bombTicking;
        state.bombLeft = 30;
        bombBtn.textContent = `Bomb beeping (30 s countdown): ${state.bombTicking ? 'ON' : 'off'}`;
        bombBtn.className = state.bombTicking ? '' : 'off';
    };
    loops.append(el('div', { class: 'item' }, breathBtn, el('span', { class: 'note' }, 'distance as above; breathing is heard to 8 m')),
        el('div', { class: 'item' }, labelled('Ghost is', exert)), bombBtn);
    root.append(el('h2', {}, 'Loops'), loops);

    for (const g of GROUPS) {
        root.append(el('h2', {}, g.title));
        const box = el('div', { class: 'items' });
        for (const it of g.items) {
            const b = el('button', {}, it.label);
            b.onclick = () => { unlock(); rebuildWorld(); it.run(); };
            box.append(el('div', { class: 'item' }, b, ...(it.note ? [el('span', { class: 'note' }, it.note)] : [])));
        }
        root.append(box);
    }
    document.body.append(root);
    document.addEventListener('pointerdown', unlock, { once: true });

    setInterval(() => {
        const s = engine.sampleStatus();
        status.textContent = s.loaded === 0
            ? `Recorded samples: none loaded (0 of ${s.total}): every sound is the synthesised one.`
            : `Recorded samples: ${s.loaded} of ${s.total} loaded${s.loaded < s.total ? ' (the rest play synthesised)' : ''}.`;
    }, 400);
}

let last = performance.now();
function loop(now: number): void {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    remotes.length = 0;
    if (state.breathing) {
        const p = where(0);
        ghost.pos[0] = p[0]; ghost.pos[1] = 0; ghost.pos[2] = p[2];
        ghost.vis = state.exert * 0.35;
        remotes.push(ghost);
    }
    let b: BombView | null = null;
    if (state.bombTicking) {
        state.bombLeft = Math.max(0.5, state.bombLeft - dt);
        const p = where(0);
        bomb.pos = p;
        bomb.timeLeft = state.bombLeft;
        b = bomb;
    }
    engine.frame(dt, listener, remotes, b);
    requestAnimationFrame(loop);
}

// ---- measuring (for the reviewer: levels without ears) -------------------------------------------

export interface MeasureSpec {
    event: 'step' | 'shot' | 'reload' | 'impact' | 'knifeWindup' | 'beep' | 'breath';
    /** A breath: the ghost's exertion 0..1 (default 0), and (with `real` false) the synthesised breathing. */
    exert?: number;
    /** Package N recordings (gunshots, breathing) on or off; default on. */
    real?: boolean;
    /** Render the event this many times and report the loudest peak and the mean RMS (gunshots pick a random variant). */
    reps?: number;
    dist: number;
    angle?: Angle;
    loud?: number;
    weapon?: number;
    suppressed?: boolean;
    surface?: string;
    wall?: boolean;
    /** Wait for the sample files to load first (they are not shipped yet, so the default is the synthesised sound). */
    recorded?: boolean;
    gunLayer?: boolean;
}

/**
 * Renders one event through the real engine into an OfflineAudioContext (HRTF, wall muffling, compressor and all)
 * and returns the peak and RMS of the stereo output in dBFS. Not heard by anyone.
 */
async function measure(spec: MeasureSpec): Promise<{ peakDb: number; rmsDb: number }> {
    const reps = Math.max(1, spec.reps ?? 1);
    let peak = 0, rms = 0;
    for (let i = 0; i < reps; i++) {
        const r = await measureOnce(spec);
        peak = Math.max(peak, r.peak);
        rms += r.rms / reps;
    }
    const db = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -Infinity);
    return { peakDb: db(peak), rmsDb: db(rms) };
}

async function measureOnce(spec: MeasureSpec): Promise<{ peak: number; rms: number }> {
    const sr = 44100;
    const seconds = spec.event === 'breath' ? 10 : 3;
    const ctx = new OfflineAudioContext(2, sr * seconds, sr);
    const bx: Box[] = [{ category: SURFACE_CATEGORY[spec.surface ?? 'concrete'], min: [-200, -1, -200], max: [200, 0, 200] }];
    const dir = DIRS[spec.angle ?? 'front'];
    if (spec.wall) {
        const m = spec.dist / 2;
        bx.push({ category: 'outer_wall', min: [dir[0] * m - (dir[0] === 0 ? 4 : 0.15), 0, dir[1] * m - (dir[1] === 0 ? 4 : 0.15)], max: [dir[0] * m + (dir[0] === 0 ? 4 : 0.15), 4, dir[1] * m + (dir[1] === 0 ? 4 : 0.15)] });
    }
    const e = createAudio(bx, { context: ctx, loadDelayMs: spec.recorded ? 0 : 1e9 });
    e.setSoundMode({ recorded: !!spec.recorded, gunLayer: spec.gunLayer ?? true, real: spec.real ?? true });
    e.unlock();
    if (spec.recorded) await e.whenLoaded();
    e.setVolumes({ master: 1, effects: 1, footsteps: 1 });
    e.frame(0.016, listener, [], null);
    const at = (y: number): Vec3 => [dir[0] * spec.dist, y, dir[1] * spec.dist];
    switch (spec.event) {
        case 'step': e.step(at(0), spec.loud ?? 1, false); break;
        case 'shot': e.gunshot(at(EYE), false, spec.weapon ?? 0, !!spec.suppressed); break;
        case 'reload': e.reload(at(0), false, spec.weapon ?? 0, 1); break;
        case 'impact': e.impact(at(0)); break;
        case 'knifeWindup': e.knifeWindup(at(0), false); break;
        case 'beep': e.frame(0.016, listener, [], { pos: at(0), timeLeft: 30 }); break;
        case 'breath': {
            // A standing ghost (exertion from its visibility), the engine ticked every 0.25 s as the game does each frame.
            const g: RemoteView = { ...ghost, pos: [...at(0)] as Vec3, vis: (spec.exert ?? 0) * GHOST_MAX_VIS };
            const tick = (dt: number): void => e.frame(dt, listener, [g], null);
            tick(1);
            for (let t = 0.25; t < seconds - 0.2; t += 0.25) void ctx.suspend(t).then(() => { tick(0.25); void ctx.resume(); });
            break;
        }
    }
    const out = await ctx.startRendering();
    // Breathing: skip the first second (the 0.15 s fade-in and the first cycle's random start would hide the steady level).
    const from = spec.event === 'breath' ? sr : 0;
    let peak = 0, sum = 0, n = 0;
    for (let c = 0; c < out.numberOfChannels; c++) {
        const d = out.getChannelData(c);
        for (let i = from; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; n++; }
    }
    return { peak, rms: Math.sqrt(sum / n) };
}

(window as unknown as { __soundtest: object }).__soundtest = { measure, engine, state };

rebuildWorld();
build();
requestAnimationFrame(loop);
