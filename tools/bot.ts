// A headless stand-in player for testing alone: `npm run bot` (add `-- --shoot` to make it fire).
// It joins the server, walks forward for a few seconds, then strafes side to side.
import WebSocket from 'ws';
import { TICK_RATE } from '../shared/constants';
import { DEFAULT_PORT, decodeServer, encodeClient, type NetCmd } from '../shared/protocol';

const url = process.env.SB_SERVER_URL ?? `ws://localhost:${DEFAULT_PORT}/?name=Bot`;
const shoot = process.argv.includes('--shoot');
const WALK_IN_TICKS = 4 * TICK_RATE;
const STRAFE_TICKS = 1.5 * TICK_RATE;

const ws = new WebSocket(url);
let seq = 0;
let yaw = 0;
let serverTime = 0;
let ticksSinceSpawn = 0;

ws.on('open', () => console.log(`bot connected to ${url}${shoot ? ' (shooting)' : ''}`));
ws.on('close', () => { console.log('bot disconnected'); process.exit(0); });
ws.on('error', err => { console.error(`bot could not connect: ${err.message}`); process.exit(1); });
ws.on('message', data => {
    const msg = decodeServer(data.toString());
    if (msg.type === 'welcome') console.log(`bot is player ${msg.id} on ${msg.team}`);
    else if (msg.type === 'snap') serverTime = msg.time;
    else if (msg.type === 'spawn') { yaw = msg.yaw; ticksSinceSpawn = 0; }
});

setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const t = ticksSinceSpawn++;
    const strafing = t >= WALK_IN_TICKS;
    const cmd: NetCmd = {
        seq: seq++,
        forward: strafing ? 0 : 1,
        right: strafing ? (Math.floor((t - WALK_IN_TICKS) / STRAFE_TICKS) % 2 === 0 ? 1 : -1) : 0,
        yaw, pitch: 0, jump: false, walk: false, crouch: false,
        fire: shoot, use: false, viewTime: serverTime
    };
    ws.send(encodeClient({ type: 'cmd', cmd }));
}, 1000 / TICK_RATE);
