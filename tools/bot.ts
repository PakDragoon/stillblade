// A headless stand-in player for testing alone: `npm run bot` (add `-- --shoot` to make it fire).
// It joins the server, walks forward for a few seconds, then strafes side to side.
//   --shoot       fire 10-round bursts with short pauses; press R between bursts when low
//   --pistol      hold the pistol (slot 2) instead of the rifle; with --shoot it taps one shot every
//                 12 commands (a new trigger press each, as semi-automatic fire needs)
//   --aim         hold aim down sights
//   --knife       hold the knife (slot 3) and keep swinging (with or without --shoot)
//   --suppressed  create the room with suppressed weapons (only if the bot creates the room)
//   --map <id>    map for the room if the bot creates it (default: the server's default map)
//   --room <code> room to join (default: the public room)
//   --still       stand still instead of walking (handy as a target)
//   --plant       as a ghost in a live round: carrying the bomb, walk to the nearest bomb site on the spawn's
//                 floor (tools/botpath.ts) and hold use there to plant; not carrying it, walk to a dropped
//                 bomb the bot knows about to pick it up; otherwise stand still
//   --drop        as the bomb carrier, drop the bomb once, 2 s into each live round (with --plant it then
//                 walks back over it after the 1 s repick wait and carries on)
//   --unready     do not press ready (the match then waits for the human or the room creator)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { TICK_RATE } from '../shared/constants';
import { DEFAULT_PORT, decodeServer, encodeClient, type NetCmd, type Team } from '../shared/protocol';
import { insideSite, type Phase } from '../shared/rules';
import type { MapData, Vec3 } from '../shared/types';
import { findPath, sitesAt } from './botpath';

const argValue = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
};
const query = new URLSearchParams({ name: 'Bot' });
const mapArg = argValue('--map');
const roomArg = argValue('--room');
if (mapArg) query.set('map', mapArg);
if (roomArg) query.set('room', roomArg);
if (process.argv.includes('--suppressed')) query.set('suppressed', '1');
const url = process.env.SB_SERVER_URL ?? `ws://localhost:${DEFAULT_PORT}/?${query}`;
const shoot = process.argv.includes('--shoot');
const still = process.argv.includes('--still');
const pistol = process.argv.includes('--pistol');
const aimDown = process.argv.includes('--aim');
const knife = process.argv.includes('--knife');
const plant = process.argv.includes('--plant');
const dropOnce = process.argv.includes('--drop');
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
// For --plant and --drop: what the bot knows of the map, itself and the bomb.
let map: MapData | null = null;
let team: Team = 'ghosts';
let phase: Phase = 'warmup';
let carrier = false;
let dropped: Vec3 | null = null;
const pos: Vec3 = [0, 0, 0];
let liveTicks = 0, droppedThisRound = false;
let path: Vec3[] | null = null, pathGoal: Vec3 | null = null, pathAge = 0;

ws.on('open', () => console.log(`bot connected to ${url}${shoot ? ' (shooting)' : ''}${pistol ? ' (pistol)' : ''}${knife ? ' (knife)' : ''}`));
ws.on('close', (code, reason) => { console.log(`bot disconnected (${code}${reason.length ? ` ${reason}` : ''})`); process.exit(code === 1008 ? 1 : 0); });
ws.on('error', err => { console.error(`bot could not connect: ${err.message}`); process.exit(1); });
ws.on('message', (data, isBinary) => {
    const msg = decodeServer(isBinary ? (data as Buffer) : data.toString());
    if (msg.type === 'welcome') {
        console.log(`bot is player ${msg.id} on ${msg.team}, map ${msg.map} (${msg.mapName}), ${msg.options?.suppressed ? 'suppressed' : 'unsuppressed'} weapons`);
        team = msg.team;
        if (plant || dropOnce) {
            try { map = JSON.parse(readFileSync(resolve('client/public/maps', `${msg.map}.json`), 'utf8')) as MapData; }
            catch { console.log('bot could not read the map file (run it from the project folder): --plant does nothing'); }
        }
        // Rooms wait in warmup until everyone is ready (or the creator starts): a bot is always ready.
        if (!process.argv.includes('--unready')) ws.send(encodeClient({ type: 'ready', ready: true }));
    }
    else if (msg.type === 'snap') {
        serverTime = msg.time;
        team = msg.me.team;
        pos[0] = msg.me.pos[0]; pos[1] = msg.me.pos[1]; pos[2] = msg.me.pos[2];
        if (msg.me.carry.carrier !== carrier) console.log(msg.me.carry.carrier ? 'bot has the bomb' : 'bot no longer has the bomb');
        carrier = msg.me.carry.carrier;
        // With the knife in hand there is no magazine to watch.
        const gun = msg.me.loadout.guns[msg.me.loadout.slot] ?? { mag: 0, reserve: 0, reload: 0 };
        ({ mag, reserve } = gun);
        reloading = gun.reload > 0;
        if (shoot && !knife && mag === 0 && reserve === 0 && !outOfAmmo) console.log('bot is out of ammunition until it respawns');
        outOfAmmo = mag === 0 && reserve === 0;
    }
    else if (msg.type === 'round') {
        if (msg.phase !== phase && msg.phase === 'freeze') { liveTicks = 0; droppedThisRound = false; }
        if (msg.phase !== phase && msg.phase === 'planted') console.log('bomb planted');
        phase = msg.phase;
        if (msg.phase === 'warmup' && !process.argv.includes('--unready')) {
            ws.send(encodeClient({ type: 'ready', ready: true })); // a match that fell back to warmup needs everyone ready again
        }
    }
    else if (msg.type === 'bomb') dropped = msg.dropped;
    else if (msg.type === 'spawn') { yaw = Math.fround(msg.yaw); ticksSinceSpawn = 0; }
});

/**
 * --plant: the yaw and forward input that walk toward the bomb site (carrying) or a dropped bomb, and
 * whether to hold use; null when there is nothing to do.
 */
function objective(): { yaw: number; forward: number; use: boolean } | null {
    if (!plant || !map || team !== 'ghosts' || phase !== 'live') return null;
    let goal: Vec3 | null = null;
    if (carrier) {
        if (insideSite(pos, map)) return { yaw, forward: 0, use: true };
        let best = Infinity;
        for (const s of sitesAt(map, pos[1])) {
            const d = Math.hypot(s[0] - pos[0], s[2] - pos[2]);
            if (d < best) { best = d; goal = s; }
        }
    } else if (dropped) goal = dropped;
    if (!goal) return null;
    if (!path || !pathGoal || pathGoal[0] !== goal[0] || pathGoal[2] !== goal[2] || ++pathAge > 2 * TICK_RATE) {
        path = findPath(map, pos, goal);
        pathGoal = goal;
        pathAge = 0;
        if (!path) return null;
    }
    while (path.length > 1 && Math.hypot(path[0][0] - pos[0], path[0][2] - pos[2]) < 0.35) path.shift();
    const next = path[0];
    const d = Math.hypot(next[0] - pos[0], next[2] - pos[2]);
    return { yaw: Math.fround(Math.atan2(-(next[0] - pos[0]), -(next[2] - pos[2]))), forward: d > 0.1 ? 1 : 0, use: false };
}

setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const t = ticksSinceSpawn++;
    if (phase === 'live') liveTicks++;
    // --drop: once per round, 2 s into the live phase, while carrying it.
    const drop = dropOnce && carrier && !droppedThisRound && liveTicks > 2 * TICK_RATE;
    if (drop) { droppedThisRound = true; console.log('bot drops the bomb'); }
    const goal = objective();
    if (goal) yaw = goal.yaw;
    const strafing = t >= WALK_IN_TICKS;
    const inBurst = t % (BURST_TICKS + PAUSE_TICKS) < BURST_TICKS;
    const cmd: NetCmd = {
        seq: seq++,
        forward: goal ? goal.forward : still || strafing || plant ? 0 : 1,
        right: goal || still || !strafing || plant ? 0 : Math.floor((t - WALK_IN_TICKS) / STRAFE_TICKS) % 2 === 0 ? 1 : -1,
        yaw, pitch: 0, jump: false, walk: false, crouch: false,
        // The knife swings for as long as the trigger is held (one swing per cooldown).
        fire: knife ? t > TICK_RATE : shoot && inBurst && !reloading && (!pistol || t % TAP_EVERY === 0),
        // The server ignores R with a full magazine or an empty reserve, so it is safe to send.
        reload: !knife && shoot && !inBurst && mag < RELOAD_BELOW,
        use: goal?.use ?? false, drop, viewTime: serverTime,
        // Asking for the slot it already holds does nothing, so it is safe to send every command.
        slot: knife ? 3 : pistol ? 2 : 1, swap: false, aim: aimDown
    };
    ws.send(encodeClient({ type: 'cmd', cmd }));
}, 1000 / TICK_RATE);
