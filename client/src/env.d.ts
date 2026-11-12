/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** WebSocket URL of the game server for production builds, e.g. wss://play.example.com */
    readonly VITE_SERVER_URL?: string;
}
