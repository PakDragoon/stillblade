// Package W: reads what the game server keeps, from the owner's PC, over SSH (the key that already logs in).
//
//   npm run data -- feedback [--n 20]       the last feedback notes and error reports, readable
//   npm run data -- matches [--days 14]     recent matches (date, map, score, how each round ended) and the balance numbers
//   npm run data -- recordings              lists the server's recordings and copies new ones to vps-data/recordings/
//   npm run data -- pull                    copies everything (feedback log, match records, recordings) to vps-data/
//
// Options: --host ubuntu@52.66.56.184 (or SB_VPS_HOST), --dir stillblade/deploy/data (the data folder on the
// server, relative to the login's home; or SB_VPS_DATA), --out vps-data (the local, git-ignored copy),
// --local <folder> reads a data folder on this PC instead of the server (no SSH).
// No key, password or token is stored or asked for: `ssh` and `scp` use the owner's own setup.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeMatch, formatStats, groupMatches, matchStats, parseLines } from './matchsummary';
import { formatReport } from './reportformat';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const command = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) ?? '';
const host = opt('host', process.env.SB_VPS_HOST || 'ubuntu@52.66.56.184');
const remoteDir = opt('dir', process.env.SB_VPS_DATA || 'stillblade/deploy/data').replace(/\/$/, '');
const out = opt('out', 'vps-data');
const local = args.includes('--local') ? opt('local', 'data') : '';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

/** The remote shell sees this as one word. */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Runs a command on the server and returns what it printed (exits on failure with ssh's own message). */
function remote(cmd: string): string {
    const r = spawnSync('ssh', [...SSH_OPTS, host, cmd], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.error) { console.error(`could not run ssh: ${r.error.message}`); process.exit(1); }
    if (r.status !== 0 && r.status !== 1) { console.error(r.stderr.trim() || `ssh exited with ${r.status}`); process.exit(1); }
    return r.stdout;
}

/** Text of a data file (relative to the data folder), from the server or `--local`. Missing files read as ''. */
function readData(rel: string, tailLines = 0): string {
    if (local) {
        const p = join(local, rel);
        if (!existsSync(p)) return '';
        const text = readFileSync(p, 'utf8');
        return tailLines ? text.split('\n').slice(-tailLines - 1).join('\n') : text;
    }
    const path = q(`${remoteDir}/${rel}`);
    return remote(tailLines ? `tail -n ${tailLines} ${path} 2>/dev/null` : `cat ${path} 2>/dev/null`);
}

/** Recording files on the server (or local folder): name, size and date. */
function listRecordings(): { name: string; size: number; date: string }[] {
    if (local) {
        const dir = join(local, 'recordings');
        if (!existsSync(dir)) return [];
        return readdirSync(dir).filter(n => n.endsWith('.sbrec.gz')).map(n => {
            const s = statSync(join(dir, n));
            return { name: n, size: s.size, date: s.mtime.toISOString().slice(0, 16).replace('T', ' ') };
        });
    }
    const text = remote(`cd ${q(`${remoteDir}/recordings`)} 2>/dev/null && find . -maxdepth 1 -name '*.sbrec.gz' -printf '%f %s %TY-%Tm-%Td %TH:%TM\\n'`);
    return text.trim().split('\n').filter(Boolean).map(l => {
        const [name, size, day, time] = l.split(' ');
        return { name, size: Number(size), date: `${day} ${time}` };
    }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Copies remote files (paths relative to the data folder) into `dest`. */
function copy(rels: string[], dest: string): void {
    if (rels.length === 0) return;
    mkdirSync(dest, { recursive: true });
    if (local) {
        for (const r of rels) {
            const from = join(local, r);
            const to = join(dest, r.split('/').pop()!);
            if (existsSync(from)) copyFileSync(from, to);
        }
        return;
    }
    // A few at a time, so one command line never gets too long.
    for (let i = 0; i < rels.length; i += 20) {
        const batch = rels.slice(i, i + 20).map(r => `${host}:${remoteDir}/${r}`);
        const r = spawnSync('scp', [...SSH_OPTS, '-p', ...batch, dest], { stdio: 'inherit' });
        if (r.status !== 0) { console.error('scp failed'); process.exit(1); }
    }
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

function months(days: number): string[] {
    const set = new Set<string>();
    const now = Date.now();
    for (let d = 0; d <= days; d += 1) set.add(new Date(now - d * 86_400_000).toISOString().slice(0, 7));
    return [...set].sort();
}

switch (command) {
    case 'feedback': {
        const n = Number(opt('n', '20'));
        const lines = readData('feedback.log', n).split('\n').filter(l => l.trim());
        if (lines.length === 0) { console.log('No feedback notes or error reports yet.'); break; }
        for (const l of lines) console.log(`${formatReport(l)}\n`);
        console.log(`(${lines.length} most recent; --n 50 for more)`);
        break;
    }
    case 'matches': {
        const days = Number(opt('days', '14'));
        const from = new Date(Date.now() - days * 86_400_000).toISOString();
        const lines = months(days).flatMap(m => parseLines(readData(`matches/${m}.jsonl`))).filter(l => l.time >= from);
        const groups = groupMatches(lines);
        if (groups.length === 0) { console.log(`No matches in the last ${days} days.`); break; }
        console.log(`Matches in the last ${days} days (side 1 and side 2 are the two teams; G = ghosts won the round, D = defenders):\n`);
        for (const g of groups) console.log(describeMatch(g));
        console.log(`\n${formatStats(matchStats(lines))}`);
        break;
    }
    case 'recordings': {
        const list = listRecordings();
        const total = list.reduce((n, r) => n + r.size, 0);
        for (const r of list) console.log(`${r.date}  ${mb(r.size).padStart(9)}  ${r.name}`);
        console.log(`${list.length} recordings, ${mb(total)} on the server`);
        const dest = join(out, 'recordings');
        const missing = list.filter(r => !existsSync(join(dest, r.name))).map(r => `recordings/${r.name}`);
        copy(missing, dest);
        console.log(missing.length ? `copied ${missing.length} new to ${dest}` : `nothing new to copy (${dest} has them all)`);
        console.log('Check one with: npx tsx tools/replay.ts <file>');
        break;
    }
    case 'pull': {
        copy(['feedback.log'], out);
        const matchFiles = local
            ? (existsSync(join(local, 'matches')) ? readdirSync(join(local, 'matches')) : [])
            : remote(`ls ${q(`${remoteDir}/matches`)} 2>/dev/null`).split('\n');
        copy(matchFiles.filter(n => /^\d{4}-\d{2}\.jsonl$/.test(n.trim())).map(n => `matches/${n.trim()}`), join(out, 'matches'));
        const dest = join(out, 'recordings');
        const missing = listRecordings().filter(r => !existsSync(join(dest, r.name))).map(r => `recordings/${r.name}`);
        copy(missing, dest);
        console.log(`copied to ${out}/: feedback.log, ${matchFiles.length} match files, ${missing.length} new recordings`);
        break;
    }
    default:
        console.log('usage: npm run data -- <feedback|matches|recordings|pull> [--n 20] [--days 14] [--host user@address] [--dir path] [--out folder] [--local folder]');
        process.exit(command ? 1 : 0);
}
