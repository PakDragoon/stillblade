import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../shared/constants';
import type { NetCmd, ServerMsg, SoundEvent } from '../../shared/protocol';
import type { MapData } from '../../shared/types';
import { SLOT_RIFLE, WEAPONS } from '../../shared/weapons';
import { Game } from './game';

/**
 * Package R: the empty reload. A rifle reload that starts with an empty magazine takes `reloadEmptyTicks` of the
 * player's processed commands (the bolt is worked), a tactical one `reloadTicks`; the reload sound tells the players
 * in earshot which it is (`empty`), so their client plays the bolt.
 */
const TICK_MS = 1000 / TICK_RATE;
const RIFLE = WEAPONS[SLOT_RIFLE];

const map: MapData = {
    name: 'test',
    bounds: { min: [-50, -0.5, -50], max: [50, 4, 50] },
    boxes: [{ min: [-50, -0.5, -50], max: [50, 0, 50] }],
    spawns: { ghosts: [{ pos: [0, 0, -6], yaw: 0 }], defenders: [{ pos: [0, 0, -10], yaw: 180 }, { pos: [2, 0, -10], yaw: 180 }] },
    bombSites: []
};

class Client {
    readonly inbox: ServerMsg[] = [];
    readonly id: number;
    seq = 0;
    constructor(private readonly game: Game) {
        this.id = game.join({ send: m => { this.inbox.push(structuredClone(m)); } }, '');
    }
    cmd(over: Partial<NetCmd> = {}, seqStep = 1): void {
        this.game.handleCmd(this.id, {
            seq: this.seq, forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, walk: false, crouch: false,
            fire: false, use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: this.game.now, ...over
        });
        this.seq += seqStep;
    }
    reloads(): SoundEvent[] {
        return this.inbox.filter((m): m is SoundEvent => m.type === 'sound' && m.kind === 'reload');
    }
}

function setup() {
    const game = new Game(map, { rounds: false });
    // Teams fill the smaller side, ghosts on a tie: ghost, then the defender who reloads, then a second ghost.
    const ghost = new Client(game);
    const shooter = new Client(game);
    const mate = new Client(game);
    expect(game.players.get(shooter.id)!.team).toBe('defenders');
    let ticks = 0;
    const clients = [ghost, shooter, mate];
    /** One server tick, then one command from every client (`each` picks the shooter's). */
    const step = (over: Partial<NetCmd> = {}, seqStep = 1): void => {
        game.tick(++ticks * TICK_MS);
        for (const c of clients) c.cmd(c === shooter ? over : {}, c === shooter ? seqStep : 1);
    };
    const gun = () => game.players.get(shooter.id)!.loadout.guns[SLOT_RIFLE];
    for (let i = 0; i < 5; i++) step();
    return { game, ghost, shooter, mate, step, gun };
}

describe('empty reload (package R)', () => {
    it('takes the rifle 162 processed commands from empty and tells the listeners it is an empty reload', () => {
        const s = setup();
        expect(s.game.players.get(s.shooter.id)!.alive).toBe(true);
        s.gun().mag = 0;
        s.step({ fire: true }); // firing on empty starts the reload
        expect(s.gun().reload).toBe(RIFLE.reloadEmptyTicks);
        for (let i = 0; i < RIFLE.reloadEmptyTicks - 1; i++) s.step();
        expect(s.gun()).toMatchObject({ mag: 0, reload: 1 });
        s.step();
        expect(s.gun()).toMatchObject({ mag: RIFLE.magSize, reload: 0 });
        // Heard within earshot (both ghosts spawn 4 m away) with the empty flag and the slot; never by the shooter.
        const heard = s.mate.reloads();
        expect(heard).toHaveLength(1);
        expect(heard[0]).toMatchObject({ id: s.shooter.id, weapon: SLOT_RIFLE, empty: true });
        expect(s.ghost.reloads()).toHaveLength(1);
        expect(s.shooter.reloads()).toHaveLength(0);
        // The sound carries no more than before: only its kind, who, where, loudness, slot and the flag.
        expect(Object.keys(heard[0]).sort()).toEqual(['empty', 'id', 'kind', 'loud', 'pos', 'type', 'weapon']);
    });

    it('keeps a tactical reload at 132 commands, without the flag', () => {
        const s = setup();
        s.gun().mag = 7;
        s.step({ reload: true });
        expect(s.gun().reload).toBe(RIFLE.reloadTicks);
        for (let i = 0; i < RIFLE.reloadTicks; i++) s.step();
        expect(s.gun()).toMatchObject({ mag: RIFLE.magSize, reload: 0 });
        const heard = s.mate.reloads();
        expect(heard).toHaveLength(1);
        expect(heard[0].empty).toBeUndefined();
    });

    it('is not shortened by a client jumping its command numbers', () => {
        const s = setup();
        s.gun().mag = 0;
        s.step({ reload: true }, 40);
        for (let i = 0; i < RIFLE.reloadEmptyTicks - 1; i++) s.step({}, 40);
        expect(s.gun()).toMatchObject({ mag: 0, reload: 1 });
        s.step({}, 40);
        expect(s.gun()).toMatchObject({ mag: RIFLE.magSize, reload: 0 });
    });
});
