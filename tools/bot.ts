// A headless stand-in player for testing alone: `npm run bot` (add `-- --shoot` to make it fire).
// It joins the server, walks forward for a few seconds, then strafes side to side.
//   --map <id>    map for the room if the bot creates it (default: the server's default map)
//   --room <code> room to join (default: the public room)
//   --still       stand still instead of walking (handy as a target)
import WebSocket from 'ws';
import { TICK_RATE } from '../shared/constants';
import { DEFAULT_PORT, decodeServer, encodeClient, type NetCmd } from '../shared/protocol';

const argValue = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
};
const query = new URLSearchParams({ name: 'Bot' });
const mapArg = argValue('--map');
const roomArg = argValue('--room');
if (mapArg) query.set('map', mapArg);
if (roomArg) query.set('room', roomArg);
const url = process.env.SB_SERVER_URL ?? `ws://localhost:${DEFAULT_PORT}/?${query}`;
const shoot = process.argv.includes('--shoot');
const still = process.argv.includes('--still');
const WALK_IN_TICKS = 4 * TICK_RATE;
const STRAFE_TICKS = 1.5 * TICK_RATE;

const ws = new WebSocket(url);
let seq = 0;
let yaw = 0;
let serverTime = 0;
let ticksSinceSpawn = 0;

ws.on('open', () => console.log(`bot connected to ${url}${shoot ? ' (shooting)' : ''}`));
ws.on('close', (code, reason) => { console.log(`bot disconnected (${code}${reason.length ? ` ${reason}` : ''})`); process.exit(code === 1008 ? 1 : 0); });
ws.on('error', err => { console.error(`bot could not connect: ${err.message}`); process.exit(1); });
ws.on('message', (data, isBinary) => {
    const msg = decodeServer(isBinary ? (data as Buffer) : data.toString());
    if (msg.type === 'welcome') console.log(`bot is player ${msg.id} on ${msg.team}, map ${msg.map} (${msg.mapName})`);
    else if (msg.type === 'snap') serverTime = msg.time;
    else if (msg.type === 'spawn') { yaw = Math.fround(msg.yaw); ticksSinceSpawn = 0; }
});

setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const t = ticksSinceSpawn++;
    const strafing = t >= WALK_IN_TICKS;
    const cmd: NetCmd = {
        seq: seq++,
        forward: still || strafing ? 0 : 1,
        right: still || !strafing ? 0 : Math.floor((t - WALK_IN_TICKS) / STRAFE_TICKS) % 2 === 0 ? 1 : -1,
        yaw, pitch: 0, jump: false, walk: false, crouch: false,
        fire: shoot, use: false, viewTime: serverTime
    };
    ws.send(encodeClient({ type: 'cmd', cmd }));
}, 1000 / TICK_RATE);
