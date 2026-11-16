// Measures what one full room costs the server: `npx tsx tools/bench.ts [map id] [--bots]`.
// `--bots`: ten server bots (five a side) play real rounds for two simulated minutes instead.
// Ten players all running, strafing and attacking for a simulated minute, snapshots encoded as
// they would be on the wire. The map defaults to the server's default map.
import { fileURLToPath } from 'node:url';
import { TICK_RATE } from '../shared/constants';
import { encodeServer, type NetCmd } from '../shared/protocol';
import { Game } from '../server/src/game';
import { defaultMapId, loadMaps } from '../server/src/maps';

const PLAYERS = 10;
const SECONDS = 60;
const TICK_MS = 1000 / TICK_RATE;

const maps = loadMaps(fileURLToPath(new URL('../client/public/maps', import.meta.url)));
const args = process.argv.slice(2);
const mapId = args.find(a => !a.startsWith('--')) ?? defaultMapId(maps);
const map = maps.get(mapId);
if (!map) throw new Error(`unknown map ${mapId} (have: ${[...maps.keys()].join(', ')})`);
if (args.includes('--bots')) {
    const botGame = new Game(map, {});
    botGame.code = 'bench';
    for (let i = 0; i < PLAYERS / 2; i++) { botGame.addBot('ghosts'); botGame.addBot('defenders'); }
    const ticks = 2 * SECONDS * TICK_RATE;
    const times = new Float64Array(ticks);
    const t0 = performance.now();
    for (let t = 1; t <= ticks; t++) {
        const a = performance.now();
        botGame.tick(t * TICK_MS);
        times[t - 1] = performance.now() - a;
    }
    const total = performance.now() - t0;
    const sorted = [...times].sort((x, y) => x - y);
    const pct = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    console.log(`map ${map.name}: ${PLAYERS} bots, ${2 * SECONDS} s simulated (${botGame.roundsPlayed} rounds finished) in ${total.toFixed(0)} ms`);
    let firstSecond = 0, later = 0;
    for (let i = 0; i < ticks; i++) { if (i < TICK_RATE) firstSecond = Math.max(firstSecond, times[i]); else later = Math.max(later, times[i]); }
    console.log(`average ${(total / ticks).toFixed(3)} ms per tick, median ${pct(0.5).toFixed(3)}, 99th percentile ${pct(0.99).toFixed(3)}; ` +
        `worst ${later.toFixed(2)} ms (first second, while the graph is built and the code warms up: ${firstSecond.toFixed(2)} ms)`);
    process.exit(0);
}

const game = new Game(map, { rounds: false }); // warmup keeps everyone alive and moving

let bytes = 0;
let messages = 0;
const ids: number[] = [];
for (let i = 0; i < PLAYERS; i++) {
    ids.push(game.join({
        send: msg => {
            const wire = encodeServer(msg);
            bytes += typeof wire === 'string' ? wire.length : wire.byteLength;
            messages++;
        }
    }, `Bench${i}`));
}

const totalTicks = SECONDS * TICK_RATE;
let worst = 0;
const started = performance.now();
for (let t = 1; t <= totalTicks; t++) {
    const tickStart = performance.now();
    game.tick(t * TICK_MS);
    for (let i = 0; i < PLAYERS; i++) {
        const cmd: NetCmd = {
            seq: t, forward: 1, right: Math.sin(t / 40 + i) > 0 ? 1 : -1, yaw: Math.fround(t / 90 + i), pitch: 0,
            jump: t % 97 === i, walk: false, crouch: false, fire: true, use: false, reload: false, slot: 0, swap: false, aim: false, drop: false, viewTime: t * TICK_MS - 100
        };
        game.handleCmd(ids[i], cmd);
    }
    worst = Math.max(worst, performance.now() - tickStart);
}
const elapsed = performance.now() - started;

const perTick = elapsed / totalTicks;
console.log(`map ${map.name}: ${PLAYERS} players, ${SECONDS} s simulated in ${elapsed.toFixed(0)} ms`);
console.log(`average ${perTick.toFixed(3)} ms per tick (${((perTick / TICK_MS) * 100).toFixed(2)}% of one core), worst tick ${worst.toFixed(2)} ms`);
console.log(`outbound ${(bytes / SECONDS / PLAYERS / 1024).toFixed(2)} KB/s per player, ${(messages / SECONDS / PLAYERS).toFixed(0)} messages/s per player`);
