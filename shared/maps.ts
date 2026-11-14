/** The map a new room gets when its creator does not pick one. */
export const DEFAULT_MAP = 'warehouse';

/** One entry of client/public/maps/index.json (written by the map builder). */
export interface MapListEntry {
    /** File id: `<id>.json` and `<id>.glb` in the maps folder. */
    id: string;
    /** Display name for menus. */
    name: string;
}

/** Map ids are file names: lower-case letters, digits, `_` and `-`, at most 32 characters. */
export function isMapId(s: string): boolean {
    return /^[a-z0-9_-]{1,32}$/.test(s);
}
