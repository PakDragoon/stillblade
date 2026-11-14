import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MAP, isMapId } from '../../shared/maps';
import type { MapData } from '../../shared/types';

/** Throws unless `d` has everything the game rules read from a map. */
export function checkMapData(d: unknown, id: string): MapData {
    const m = d as Partial<MapData> | null;
    const fail = (why: string): never => { throw new Error(`map ${id}: ${why}`); };
    if (!m || typeof m !== 'object') fail('not an object');
    if (m!.name !== id) fail(`"name" is ${JSON.stringify(m!.name)}, expected the file id`);
    if (!Array.isArray(m!.boxes) || m!.boxes.length === 0) fail('no collision boxes');
    if (!m!.spawns || !Array.isArray(m!.spawns.ghosts) || !Array.isArray(m!.spawns.defenders) ||
        m!.spawns.ghosts.length === 0 || m!.spawns.defenders.length === 0) fail('needs spawns for both teams');
    if (!Array.isArray(m!.bombSites)) fail('no bomb site list');
    return m as MapData;
}

/**
 * Every map in `dir`: each `<id>.json` holding map data (index.json, the client's list, is skipped).
 * Keyed by id. Throws on a malformed map, so a bad build is noticed when the server starts.
 */
export function loadMaps(dir: string): Map<string, MapData> {
    const maps = new Map<string, MapData>();
    for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith('.json') || file === 'index.json') continue;
        const id = file.slice(0, -5);
        if (!isMapId(id)) continue;
        maps.set(id, checkMapData(JSON.parse(readFileSync(join(dir, file), 'utf8')), id));
    }
    return maps;
}

/** DEFAULT_MAP when it is loaded, otherwise the first map found. */
export function defaultMapId(maps: ReadonlyMap<string, MapData>, preferred = DEFAULT_MAP): string {
    if (maps.has(preferred)) return preferred;
    const first = maps.keys().next();
    if (first.done) throw new Error('no maps loaded');
    return first.value;
}
