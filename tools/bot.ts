// A headless stand-in player for testing alone: `npm run bot` (add `-- --shoot` to make it fire).
// It joins the server, walks forward for a few seconds, then strafes side to side. A shooting bot
// fires 10-round bursts with short pauses and presses R between bursts once the magazine runs low.
import WebSocket from 'ws';
import { TICK_RATE } from '../shared/constants';
import { DEFAULT_PORT, decodeServer, encodeClient, type NetCmd } from '../shared/protocol';

const url = process.env.SB_SERVER_URL ?? `ws://localhost:${DEFAULT_PORT}/?name=Bot`;
const shoot = process.argv.includes('--shoot');
const WALK_IN_TICKS = 4 * TICK_RATE;
const STRAFE_TICKS = 1.5 * TICK_RATE;
const BURST_TICKS = 60; // 10 rounds at 10 per second
const PAUSE_TICKS = 30;
/** Reload between bursts when fewer rounds than this are left. */
const RELOAD_BELOW = 12;

const ws = new WebSocket(url);
let seq = 0;
let yaw = 0;
let serverTime = 0;
let ticksSinceSpawn = 0;
let mag = 0, reserve = 0, reloading = false, outOfAmmo = false;

ws.on('open', () => console.log(`bot connected to ${url}${shoot ? ' (shooting)' : ''}`));
ws.on('close', () => { console.log('bot disconnected'); process.exit(0); });
ws.on('error', err => { console.error(`bot could not connect: ${err.message}`); process.exit(1); });
ws.on('message', (data, isBinary) => {
    const msg = decodeServer(isBinary ? (data as Buffer) : data.toString());
    if (msg.type === 'welcome') console.log(`bot is player ${msg.id} on ${msg.team}`);
    else if (msg.type === 'snap') {
        serverTime = msg.time;
        ({ mag, reserve } = msg.me.gun);
        reloading = msg.me.gun.reload > 0;
        if (shoot && mag === 0 && reserve === 0 && !outOfAmmo) console.log('bot is out of ammunition until it respawns');
        outOfAmmo = mag === 0 && reserve === 0;
    }
    else if (msg.type === 'spawn') { yaw = Math.fround(msg.yaw); ticksSinceSpawn = 0; }
});

setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const t = ticksSinceSpawn++;
    const strafing = t >= WALK_IN_TICKS;
    const inBurst = t % (BURST_TICKS + PAUSE_TICKS) < BURST_TICKS;
    const cmd: NetCmd = {
        seq: seq++,
        forward: strafing ? 0 : 1,
        right: strafing ? (Math.floor((t - WALK_IN_TICKS) / STRAFE_TICKS) % 2 === 0 ? 1 : -1) : 0,
        yaw, pitch: 0, jump: false, walk: false, crouch: false,
        fire: shoot && inBurst && !reloading,
        // The server ignores R with a full magazine or an empty reserve, so it is safe to send.
        reload: shoot && !inBurst && mag < RELOAD_BELOW,
        use: false, viewTime: serverTime
    };
    ws.send(encodeClient({ type: 'cmd', cmd }));
}, 1000 / TICK_RATE);
