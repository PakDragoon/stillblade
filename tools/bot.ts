// A headless stand-in player for testing alone: `npm run bot` (add `-- --shoot` to make it fire).
// It joins the server, walks forward for a few seconds, then strafes side to side.
//   --shoot       fire 10-round bursts with short pauses; press R between bursts when low
//   --pistol      hold the pistol (slot 2) instead of the rifle; with --shoot it taps one shot every
//                 12 commands (a new trigger press each, as semi-automatic fire needs)
//   --aim         hold aim down sights
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
const pistol = process.argv.includes('--pistol');
const aimDown = process.argv.includes('--aim');
/** Pistol fire: press for one command, release, every this many commands (the minimum interval is 9). */
const TAP_EVERY = 12;
const WALK_IN_TICKS = 4 * TICK_RATE;
const STRAFE_TICKS = 1.5 * TICK_RATE;
const BURST_TICKS = 60; // 10 rounds at 10 per second
const PAUSE_TICKS = 30;
/** Reload between bursts when fewer rounds than this are left. */
const RELOAD_BELOW = pistol ? 5 : 12;

const ws = new WebSocket(url);
let seq = 0;
let yaw = 0;
let serverTime = 0;
let ticksSinceSpawn = 0;
let mag = 0, reserve = 0, reloading = false, outOfAmmo = false;

ws.on('open', () => console.log(`bot connected to ${url}${shoot ? ' (shooting)' : ''}${pistol ? ' (pistol)' : ''}`));
ws.on('close', (code, reason) => { console.log(`bot disconnected (${code}${reason.length ? ` ${reason}` : ''})`); process.exit(code === 1008 ? 1 : 0); });
ws.on('error', err => { console.error(`bot could not connect: ${err.message}`); process.exit(1); });
ws.on('message', (data, isBinary) => {
    const msg = decodeServer(isBinary ? (data as Buffer) : data.toString());
    if (msg.type === 'welcome') console.log(`bot is player ${msg.id} on ${msg.team}, map ${msg.map} (${msg.mapName})`);
    else if (msg.type === 'snap') {
        serverTime = msg.time;
        const gun = msg.me.loadout.guns[msg.me.loadout.slot];
        ({ mag, reserve } = gun);
        reloading = gun.reload > 0;
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
        forward: still || strafing ? 0 : 1,
        right: still || !strafing ? 0 : Math.floor((t - WALK_IN_TICKS) / STRAFE_TICKS) % 2 === 0 ? 1 : -1,
        yaw, pitch: 0, jump: false, walk: false, crouch: false,
        fire: shoot && inBurst && !reloading && (!pistol || t % TAP_EVERY === 0),
        // The server ignores R with a full magazine or an empty reserve, so it is safe to send.
        reload: shoot && !inBurst && mag < RELOAD_BELOW,
        use: false, viewTime: serverTime,
        // Asking for the slot it already holds does nothing, so it is safe to send every command.
        slot: pistol ? 2 : 1, swap: false, aim: aimDown
    };
    ws.send(encodeClient({ type: 'cmd', cmd }));
}, 1000 / TICK_RATE);
