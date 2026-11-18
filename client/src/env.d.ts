/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** WebSocket URL of the game server for production builds, e.g. wss://play.example.com */
    readonly VITE_SERVER_URL?: string;
}

/** Sizes of the files in client/public, measured at build time (tools/asset-sizes-plugin.ts). */
declare module 'virtual:asset-sizes' {
    /** Bytes by path under client/public ("maps/warehouse.glb"). */
    export const sizes: Record<string, number>;
    /** Every file each map's load fetches, by map id, as paths under client/public. */
    export const mapFiles: Record<string, string[]>;
}
