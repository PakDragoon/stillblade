// Package W: balance numbers from match records. `npx tsx tools/matchstats.ts <file.jsonl...>`
// (the files in data/matches/ on the server, or copied with `npm run data -- pull`). Prints the win rate
// per side and per map, how rounds are won, the average round length and kills by weapon and body zone.
// `--json` prints the numbers as JSON instead.
import { readFileSync } from 'node:fs';
import { formatStats, matchStats, parseLines } from './matchsummary';

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
if (files.length === 0) {
    console.log('usage: npx tsx tools/matchstats.ts <matches.jsonl...> [--json]');
    process.exit(1);
}
const lines = files.flatMap(f => parseLines(readFileSync(f, 'utf8')));
const stats = matchStats(lines);
console.log(args.includes('--json') ? JSON.stringify(stats, null, 2) : formatStats(stats));
