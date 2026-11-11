/** Engine space: Y up, right-handed, -Z forward, metres. */
export type Vec3 = [number, number, number];

export interface Box {
    name?: string;
    category?: string;
    min: Vec3;
    max: Vec3;
}

export interface Spawn {
    /** Feet position. */
    pos: Vec3;
    /** Degrees about +Y; 0 faces -Z, positive is counter-clockwise seen from above. */
    yaw: number;
}

/** Produced by tools/blender/greybox.py alongside the .glb of the same name. */
export interface MapData {
    name: string;
    bounds: { min: Vec3; max: Vec3 };
    boxes: Box[];
    spawns: { ghosts: Spawn[]; defenders: Spawn[] };
    bombSites: { name: string; min: Vec3; max: Vec3 }[];
    /** File name (next to the map) of the baked lighting atlas, if the map has one. */
    baked?: string;
}

/** One tick of player intent. This is what the client will send to the server. */
export interface InputCmd {
    /** -1..1, +1 is forward. */
    forward: number;
    /** -1..1, +1 is strafe right. */
    right: number;
    /** View yaw in radians (same convention as Spawn.yaw). */
    yaw: number;
    jump: boolean;
    /** Quiet walk. */
    walk: boolean;
    crouch: boolean;
}

/** Everything needed to resimulate a player; kept flat so it is cheap to copy and serialise. */
export interface PlayerState {
    /** Feet position (centre of the hull's bottom face). */
    pos: Vec3;
    vel: Vec3;
    onGround: boolean;
    crouched: boolean;
}
