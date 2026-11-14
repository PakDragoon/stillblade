import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HULL_HALF_WIDTH, HULL_HEIGHT, TICK_RATE } from '../../shared/constants';
import { overlapsAny } from '../../shared/collision';
import { PROTOCOL_VERSION, type NetCmd, type ServerMsg } from '../../shared/protocol';
import { FREEZE_MS, PLANT_TICKS, insideSite } from '../../shared/rules';
import type { MapData, Vec3 } from '../../shared/types';
import { Game } from './game';
import { checkMapData, defaultMapId, loadMaps } from './maps';
import { Rooms, cleanRoomId } from './rooms';

const TICK_MS = 1000 / TICK_RATE;

function tinyMap(name: string, displayName = name): MapData {
    return {
        name, displayName,
        bounds: { min: [-20, -0.5, -20], max: [20, 4, 20] },
        boxes: [{ min: [-20, -0.5, -20], max: [20, 0, 20] }],
        spawns: { ghosts: [{ pos: [0, 0, 10], yaw: 0 }], defenders: [{ pos: [0, 0, -10], yaw: 180 }] },
        bombSites: [{ name: 'A', min: [-3, 0, 7], max: [3, 2.5, 13] }]
    };
}

class Inbox {
    readonly msgs: ServerMsg[] = [];
    readonly conn = { send: (m: ServerMsg) => { this.msgs.push(structuredClone(m)); } };
    welcome(): Extract<ServerMsg, { type: 'welcome' }> {
        const m = this.msgs.find(x => x.type === 'welcome');
        if (!m) throw new Error('no welcome');
        return m as Extract<ServerMsg, { type: 'welcome' }>;
    }
}

describe('rooms and maps', () => {
    const maps = new Map([['alpha', tinyMap('alpha', 'Alpha Base')], ['beta', tinyMap('beta', 'Beta Yard')]]);

    it('creates a room on the map its first player asks for, and tells later players that map', () => {
        const rooms = new Rooms(maps, 'alpha');
        const a = new Inbox();
        const first = rooms.join('r1', 'beta', a.conn, 'A', 0);
        expect(first).toMatchObject({ ok: true, created: true });
        expect(rooms.rooms.get('r1')!.map.name).toBe('beta');
        expect(a.welcome()).toMatchObject({ map: 'beta', mapName: 'Beta Yard', version: PROTOCOL_VERSION });

        // A joiner asking for another (known) map gets the room's map, not a new room.
        const b = new Inbox();
        const second = rooms.join('r1', 'alpha', b.conn, 'B', 0);
        expect(second).toMatchObject({ ok: true, created: false });
        expect(b.welcome().map).toBe('beta');
        expect(rooms.rooms.size).toBe(1);
    });

    it('uses the default map when none is given', () => {
        const rooms = new Rooms(maps, 'alpha');
        const a = new Inbox();
        expect(rooms.join('r2', null, a.conn, '', 0).ok).toBe(true);
        expect(a.welcome().map).toBe('alpha');
        const b = new Inbox();
        expect(rooms.join('r3', '', b.conn, '', 0).ok).toBe(true);
        expect(b.welcome().map).toBe('alpha');
    });

    it('refuses an unknown map id without creating a room, even for an existing room', () => {
        const rooms = new Rooms(maps, 'alpha');
        const a = new Inbox();
        expect(rooms.join('r4', 'nowhere', a.conn, '', 0)).toEqual({ ok: false, reason: 'Unknown map' });
        expect(rooms.rooms.size).toBe(0);
        expect(a.msgs).toHaveLength(0);
        rooms.join('r4', 'alpha', new Inbox().conn, '', 0);
        expect(rooms.join('r4', '../greybox', new Inbox().conn, '', 0)).toEqual({ ok: false, reason: 'Unknown map' });
        expect(rooms.rooms.get('r4')!.players.size).toBe(1);
    });

    it('drops a room when its last player leaves, and enforces the limits', () => {
        const rooms = new Rooms(maps, 'alpha', { maxRooms: 1, maxPlayersPerRoom: 1 });
        const r = rooms.join('x', null, new Inbox().conn, '', 0);
        expect(rooms.join('x', null, new Inbox().conn, '', 0)).toEqual({ ok: false, reason: 'Room full' });
        expect(rooms.join('y', null, new Inbox().conn, '', 0)).toEqual({ ok: false, reason: 'Server full' });
        if (!r.ok) throw new Error('join failed');
        rooms.leave('x', r.id);
        expect(rooms.rooms.size).toBe(0);
    });

    it('cleans room codes and rejects a missing default map', () => {
        expect(cleanRoomId('  My Room!! ')).toBe('myroom');
        expect(cleanRoomId(null)).toBe('public');
        expect(() => new Rooms(maps, 'gamma')).toThrow();
        expect(defaultMapId(maps, 'gamma')).toBe('alpha');
        expect(() => checkMapData({ ...tinyMap('alpha'), spawns: { ghosts: [], defenders: [] } }, 'alpha')).toThrow();
        expect(() => checkMapData(tinyMap('alpha'), 'beta')).toThrow();
    });
});

// ---------------------------------------------------------------------------------------------
// The shipped maps: the server loads every one, and the round rules run on each map's own data.
// ---------------------------------------------------------------------------------------------
const shipped = loadMaps(fileURLToPath(new URL('../../client/public/maps', import.meta.url)));

/** A free standing spot inside bomb site `s`, nearest its centre. */
function plantSpot(map: MapData, s: MapData['bombSites'][number]): Vec3 {
    const hmin: Vec3 = [0, 0, 0], hmax: Vec3 = [0, 0, 0];
    const cx = (s.min[0] + s.max[0]) / 2, cz = (s.min[2] + s.max[2]) / 2;
    const y = s.min[1];
    for (let r = 0; r < 12; r += 0.25) {
        for (let k = 0; k < 16; k++) {
            const a = (k / 16) * Math.PI * 2;
            const p: Vec3 = [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
            hmin[0] = p[0] - HULL_HALF_WIDTH; hmax[0] = p[0] + HULL_HALF_WIDTH;
            hmin[1] = y + 0.01; hmax[1] = y + HULL_HEIGHT;
            hmin[2] = p[2] - HULL_HALF_WIDTH; hmax[2] = p[2] + HULL_HALF_WIDTH;
            if (insideSite(p, map) && !overlapsAny(map.boxes, hmin, hmax)) return p;
        }
    }
    throw new Error(`no free spot in site ${s.name} of ${map.name}`);
}

describe('shipped maps', () => {
    it('are all loaded, including Test Map 1 under its display name', () => {
        expect(shipped.get('greybox')?.displayName).toBe('Test Map 1');
        for (const [id, map] of shipped) {
            expect(map.name).toBe(id);
            expect(map.spawns.ghosts.length).toBe(5);
            expect(map.spawns.defenders.length).toBe(5);
            expect(map.bombSites.map(s => s.name)).toEqual(['A', 'B']);
        }
    });

    for (const [id, map] of shipped) {
        it(`runs the round rules on ${id}: spawns, freeze, then a plant at each site`, () => {
            for (const site of map.bombSites) {
                const game = new Game(map, { rounds: true });
                const seqs = new Map<number, number>();
                const inboxes = [new Inbox(), new Inbox()];
                const ids = inboxes.map((b, i) => game.join(b.conn, `P${i}`));
                let t = 0;
                const tick = (cmd: (id: number) => Partial<NetCmd> = () => ({})): void => {
                    game.tick(++t * TICK_MS);
                    for (const pid of ids) {
                        const seq = seqs.get(pid) ?? 0;
                        seqs.set(pid, seq + 1);
                        game.handleCmd(pid, {
                            seq, forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, walk: false, crouch: false,
                            fire: false, use: false, viewTime: game.now, ...cmd(pid)
                        });
                    }
                };
                // Everyone starts on one of this map's own spawn points.
                const ghost = game.players.get(ids[0])!;
                const defender = game.players.get(ids[1])!;
                expect(ghost.team).toBe('ghosts');
                expect(map.spawns.ghosts.some(s => s.pos.every((v, k) => Math.abs(v - ghost.state.pos[k]) < 1e-9))).toBe(true);
                expect(map.spawns.defenders.some(s => s.pos.every((v, k) => Math.abs(v - defender.state.pos[k]) < 1e-9))).toBe(true);
                for (let i = 0; i < Math.ceil(FREEZE_MS / TICK_MS) + 2; i++) tick();
                expect(game.phase).toBe('live');
                // Both stand on the map's floor after falling from their spawn.
                expect(ghost.state.onGround).toBe(true);
                expect(defender.state.onGround).toBe(true);

                // Put the ghost on the site and hold use: the plant needs the site box from this map.
                const spot = plantSpot(map, site);
                ghost.state.pos[0] = spot[0]; ghost.state.pos[1] = spot[1]; ghost.state.pos[2] = spot[2];
                for (let i = 0; i < 10; i++) tick();
                expect(ghost.state.onGround).toBe(true);
                for (let i = 0; i < PLANT_TICKS + 5; i++) tick(pid => (pid === ids[0] ? { use: true } : {}));
                expect(game.phase).toBe('planted');
                expect(game.bomb![1]).toBeCloseTo(site.min[1], 3);
            }
        });
    }
});
