// Measures what one full room costs the server: `npx tsx tools/bench.ts`.
// Ten players all running, strafing and attacking for a simulated minute, snapshots encoded as
// they would be on the wire.
import { readFileSync } from 'node:fs';
import { TICK_RATE } from '../shared/constants';
import { encodeServer, type NetCmd } from '../shared/protocol';
import type { MapData } from '../shared/types';
import { Game } from '../server/src/game';

const PLAYERS = 10;
const SECONDS = 60;
const TICK_MS = 1000 / TICK_RATE;

const map = JSON.parse(readFileSync(new URL('../client/public/maps/greybox.json', import.meta.url), 'utf8')) as MapData;
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
            jump: t % 97 === i, walk: false, crouch: false, fire: true, use: false, viewTime: t * TICK_MS - 100
        };
        game.handleCmd(ids[i], cmd);
    }
    worst = Math.max(worst, performance.now() - tickStart);
}
const elapsed = performance.now() - started;

const perTick = elapsed / totalTicks;
console.log(`${PLAYERS} players, ${SECONDS} s simulated in ${elapsed.toFixed(0)} ms`);
console.log(`average ${perTick.toFixed(3)} ms per tick (${((perTick / TICK_MS) * 100).toFixed(2)}% of one core), worst tick ${worst.toFixed(2)} ms`);
console.log(`outbound ${(bytes / SECONDS / PLAYERS / 1024).toFixed(2)} KB/s per player, ${(messages / SECONDS / PLAYERS).toFixed(0)} messages/s per player`);
