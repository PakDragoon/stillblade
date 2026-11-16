// Debug aid for the bots: one round in-process with a line per second about every ghost and every kill.
// `npx tsx tools/bottrace.ts <map id> [--level normal] [--rounds N]`
import { fileURLToPath } from 'node:url';
import { TICK_RATE } from '../shared/constants';
import type { BotLevel } from '../shared/room-options';
import { Game } from '../server/src/game';
import { BotBrain } from '../server/src/bots';
import { defaultMapId, loadMaps } from '../server/src/maps';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const maps = loadMaps(fileURLToPath(new URL('../client/public/maps', import.meta.url)));
const mapId = args[0] && !args[0].startsWith('--') ? args[0] : defaultMapId(maps);
const map = maps.get(mapId)!;
const game = new Game(map, { options: { botLevel: opt('level', 'normal') as BotLevel } });
game.code = `trace-${mapId}`;
for (let i = 0; i < 5; i++) { game.addBot('ghosts'); game.addBot('defenders'); }
const first = [...game.players.values()][0];
const send = first.conn.send.bind(first.conn);
const name = (id: number): string => game.players.get(id)?.name ?? String(id);
let t = 0;
BotBrain.debug = line => console.log(`  t=${(t / TICK_RATE).toFixed(1)} ${line}`);
first.conn.send = msg => {
    if (msg.type === 'kill') {
        const k = game.players.get(msg.killer)!, v = game.players.get(msg.victim)!;
        const d = Math.hypot(k.state.pos[0] - v.state.pos[0], k.state.pos[2] - v.state.pos[2]);
        const fw = Math.cos(k.yaw) * 0 ; void fw;
        const dx = v.state.pos[0] - k.state.pos[0], dz = v.state.pos[2] - k.state.pos[2];
        const facing = (-Math.sin(k.yaw) * dx - Math.cos(k.yaw) * dz) / Math.max(1e-6, Math.hypot(dx, dz));
        console.log(`  victim mode ${v.brain?.mode} killer facing ${facing.toFixed(2)} killer mode ${k.brain?.mode}`);
        console.log(`  t=${(t / TICK_RATE).toFixed(1)} KILL ${name(msg.killer)} -> ${name(msg.victim)} ${msg.kind} ${msg.zone ?? ''} at ${d.toFixed(1)} m (victim vis ${v.vis.toFixed(2)})`);
    }
    send(msg);
};
const rounds = Number(opt('rounds', '1'));
let done = 0, last = game.phase;
const f = (v: number): string => v.toFixed(1);
while (t < 60 * 60 * 10 && done < rounds) {
    t++;
    game.tick((t * 1000) / TICK_RATE);
    if (game.phase !== last) {
        console.log(`t=${(t / TICK_RATE).toFixed(1)} phase ${game.phase}`);
        if (game.phase === 'over') done++;
        last = game.phase;
    }
    if (t % TICK_RATE === 0 && (game.phase === 'live' || game.phase === 'planted')) {
        const parts: string[] = [];
        for (const p of game.players.values()) {
            if (!p.alive) continue;
            const s = p.state;
            const tag = p.team === 'ghosts' ? 'G' : 'D';
            parts.push(`${tag}${p.id}${p.carry.carrier ? '*' : ''}(${f(s.pos[0])},${f(s.pos[1])},${f(s.pos[2])} v${p.vis.toFixed(2)}${s.crouched ? ' c' : ''}${p.team === 'ghosts' ? ' ' + p.brain?.mode : ''})`);
        }
        console.log(`t=${(t / TICK_RATE).toFixed(0)} ${parts.join(' ')}`);
    }
}
console.log('sites', JSON.stringify(map.bombSites.map(s => [s.name, s.min, s.max])));
console.log('spawns', JSON.stringify(map.spawns.ghosts[0].pos), JSON.stringify(map.spawns.defenders[0].pos));
