// A whole bot-versus-bot match in-process, as fast as the machine runs it (no network, no real time):
// `npx tsx tools/botmatch.ts <map id> [--level easy|normal|hard] [--per-team 5] [--rounds 6] [--quiet] [--record <folder>]`.
// `--record`: keep the match record and input recording in <folder> (a data folder: matches/, recordings/), as the
// server would; bot-only matches are recorded only when asked.
// Prints every round's result and the final statistics. Used once per map to check that bots finish a
// match (package E); `tools/bench.ts --bots` measures what they cost.
import { fileURLToPath } from 'node:url';
import { TICK_RATE } from '../shared/constants';
import type { BotLevel } from '../shared/room-options';
import { Game } from '../server/src/game';
import { defaultMapId, loadMaps } from '../server/src/maps';
import { DataStore, dataConfigFromEnv } from '../server/src/datastore';
import { roomObserver } from '../server/src/roomdata';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const maps = loadMaps(fileURLToPath(new URL('../client/public/maps', import.meta.url)));
const mapId = args[0] && !args[0].startsWith('--') ? args[0] : defaultMapId(maps);
const map = maps.get(mapId);
if (!map) throw new Error(`unknown map ${mapId}`);
const level = opt('level', 'normal') as BotLevel;
const perTeam = Number(opt('per-team', '5'));
const roundsToWin = Number(opt('rounds', '6'));
const quiet = args.includes('--quiet');
const TICK_MS = 1000 / TICK_RATE;

const game = new Game(map, { options: { botLevel: level, roundsToWin } });
game.code = `botmatch-${mapId}`;
const recordDir = args.includes('--record') ? opt('record', 'data') : '';
const store = recordDir ? new DataStore(dataConfigFromEnv({ SB_DATA_DIR: recordDir })) : null;
if (store) { store.prepare(); game.observer = roomObserver(store, { record: true, commit: '' }); }
for (let i = 0; i < perTeam; i++) { game.addBot('ghosts'); game.addBot('defenders'); }

let t = 0;
let lastPhase = game.phase;
let roundStart = 0;
const started = performance.now();
let worst = 0;
let finished = false;
const limit = 60 * 60 * TICK_RATE; // an hour of game time at most
const reasons: Record<string, number> = {};
while (t < limit) {
    t++;
    const a = performance.now();
    game.tick(t * TICK_MS);
    worst = Math.max(worst, performance.now() - a);
    if (game.phase !== lastPhase) {
        if (game.phase === 'live') roundStart = t;
        if (game.phase === 'over') {
            const g = game as unknown as { winner: string; reason: string; matchOver: boolean };
            reasons[`${g.winner} ${g.reason}`] = (reasons[`${g.winner} ${g.reason}`] ?? 0) + 1;
            const alive = { ghosts: 0, defenders: 0 };
            for (const p of game.players.values()) if (p.alive) alive[p.team]++;
            if (!quiet) {
                console.log(`round ${game.roundsPlayed}: ${g.winner} by ${g.reason} after ${((t - roundStart) / TICK_RATE).toFixed(1)} s ` +
                    `(alive ghosts ${alive.ghosts}, defenders ${alive.defenders}); score ${game.score[0]}:${game.score[1]}`);
            }
            if (g.matchOver) {
                finished = true;
                console.log(`\nmatch over on ${mapId} (${level}) after ${(t / TICK_RATE / 60).toFixed(1)} min of game time, ` +
                    `${((performance.now() - started) / 1000).toFixed(1)} s of real time; worst tick ${worst.toFixed(2)} ms`);
                console.log('round endings:', JSON.stringify(reasons));
                const rows = [...game.players.values()].map(p => ({ name: p.name, side: p.group, ...p.stats }));
                console.table(rows);
                if (store) { await store.flush(); console.log(`recorded in ${store.cfg.dir}`); }
                break;
            }
        }
        lastPhase = game.phase;
    }
}
if (!finished) { console.log('match did not finish within an hour of game time'); process.exit(1); }
