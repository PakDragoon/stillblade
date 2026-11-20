// Package W: re-simulates an input recording with the shared rules and the server's own match code, and
// checks it against the checkpoints saved in it. `npx tsx tools/replay.ts <file.sbrec.gz...>`
// Prints "all N checkpoints match", or the first checkpoint that disagrees and how. Exit code 1 if any
// recording disagrees. The recording must be replayed with the code it was made with (its header names the
// commit) and on the same map build (checked).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '../shared/protocol';
import { loadMaps } from '../server/src/maps';
import { replayRecording } from '../server/src/replay';

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (files.length === 0) {
    console.log('usage: npx tsx tools/replay.ts <recording.sbrec.gz...>');
    process.exit(1);
}
const maps = loadMaps(process.env.SB_MAPS_DIR ?? fileURLToPath(new URL('../client/public/maps', import.meta.url)));
let bad = 0;
for (const f of files) {
    try {
        const started = performance.now();
        const r = replayRecording(readFileSync(f), maps);
        const h = r.header;
        const people = h.players.filter(p => !p.bot).map(p => p.name).join(', ') || 'none';
        console.log(`${basename(f)}: ${h.map}, room ${h.room}, started ${h.started}, commit ${h.commit || 'unknown'}, protocol ${h.protocol}` +
            `${h.protocol !== PROTOCOL_VERSION ? ` (this code is protocol ${PROTOCOL_VERSION}: expect differences)` : ''}`);
        console.log(`  ${h.players.length} players at the start (people: ${people}); ${r.ticks} ticks (${(r.ticks / h.tickRate / 60).toFixed(1)} min), ` +
            `${r.commands} commands, ${r.rounds.recorded.length} rounds; replayed in ${((performance.now() - started) / 1000).toFixed(1)} s`);
        if (r.truncated) console.log('  the file ends without its closing record (the server stopped or the copy is incomplete): checked up to its end');
        if (r.mismatch) {
            bad++;
            console.log(`  DIFFERS at checkpoint ${r.mismatch.checkpoint} (game time ${(r.mismatch.now / 1000).toFixed(1)} s): ${r.mismatch.detail}`);
        } else {
            console.log(`  all ${r.checkpoints} checkpoints match`);
        }
        if (r.rounds.recorded.join() !== r.rounds.replayed.join()) {
            console.log(`  rounds recorded: ${r.rounds.recorded.join(' | ')}\n  rounds replayed: ${r.rounds.replayed.join(' | ')}`);
        }
    } catch (err) {
        bad++;
        console.log(`${basename(f)}: cannot replay: ${(err as Error).message}`);
    }
}
process.exit(bad ? 1 : 0);
