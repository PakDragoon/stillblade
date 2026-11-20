// Turns the raw Kenney packs into the shipped sounds (package H).
//
//   node tools/process-audio.mjs [--src tools/audio-source] [--out client/public/audio] [--map tools/audio-map.json]
//
// Needs ffmpeg on the PATH. `--src` holds one folder per unzipped pack (any depth below it; the pack's folder name
// is recorded in CREDITS.md): the Kenney packs, and `freesound/` with the single Freesound recordings (package N;
// file names `<id>__<author>__<title>`). For every sound set in the map it picks the raw files, makes them mono,
// trims leading silence, cuts to `maxDur`, applies pitch / high-pass / low-pass / denoise if asked, peak-normalises to
// -4.5 dBFS (then the map's `gain`), and encodes MP3 (mono, 64 kbit/s). A set with no raw file is reported and left
// out: the game keeps playing the synthesised sound for it. Writes CREDITS.md next to the files and prints every
// size and the total.
//
// A set picks its files either by `match` (regular expressions on the file name; first `n` distinct files) or by
// `cuts`: a list of [file regex, start second, optional dB] naming one cut out of a long recording each (several
// shots in one file). `prefer` is an alternative config tried first (a real pistol recording, when one has been put
// into freesound/; the AK-based stand-in is the fallback).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const SRC = resolve(arg('src', 'tools/audio-source'));
const OUT = resolve(arg('out', 'client/public/audio'));
const MAP = JSON.parse(readFileSync(resolve(arg('map', 'tools/audio-map.json')), 'utf8'));
const EXT = 'mp3';
const PEAK_DB = -4.5;
const RAW_EXT = new Set(['.ogg', '.wav', '.mp3', '.flac']);

if (!existsSync(SRC)) {
    console.log(`No raw packs in ${SRC}: nothing to do (every sound stays synthesised). Unzip the Kenney packs into it, one folder each.`);
    process.exit(0);
}
if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.error('ffmpeg is not on the PATH'); process.exit(1); }

function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else if (RAW_EXT.has(extname(e.name).toLowerCase())) out.push(p);
    }
    return out;
}
const raw = walk(SRC).sort();
const stem = p => basename(p, extname(p));
console.log(`${raw.length} raw files under ${SRC}`);

function ffmpeg(args) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').split('\n').slice(-6).join('\n')}`);
    return r.stderr;
}

/** The filter chain up to (not including) normalisation. */
function chain(cfg, ss = 0, dur = cfg.maxDur) {
    // `headroom`: 9 dB first, for recordings that peak above 0 dBFS (float WAV): `volumedetect` clips at 0 dBFS, so it
    // would measure them too low. The normalisation below puts the level back. (Off for the Kenney packs so their
    // shipped files stay byte-identical.)
    const f = cfg.headroom ? ['volume=-9dB', 'aformat=channel_layouts=mono'] : ['aformat=channel_layouts=mono'];
    if (ss > 0) f.push(`atrim=start=${ss}`, 'asetpts=PTS-STARTPTS');
    if (!cfg.keepStart) f.push('silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.004');
    if (cfg.hp) f.push(`highpass=f=${cfg.hp}`);
    if (cfg.denoise) f.push(`afftdn=nr=${cfg.denoise}:nf=-60`);
    if (cfg.pitch && cfg.pitch !== 1) f.push(`asetrate=${Math.round(44100 * cfg.pitch)}`, 'aresample=44100');
    if (cfg.lp) f.push(`lowpass=f=${cfg.lp}`);
    if (cfg.fadeIn) f.push(`afade=t=in:st=0:d=${cfg.fadeIn}`);
    if (dur) { const fo = cfg.fade ?? 0.03; f.push(`atrim=duration=${dur}`, `afade=t=out:st=${Math.max(0, dur - fo)}:d=${fo}`); }
    return f.join(',');
}

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith(`.${EXT}`)) rmSync(join(OUT, f));

const rows = [];
const missing = [];
let total = 0;
for (const [set, base] of Object.entries(MAP)) {
    if (set.startsWith('_')) continue;
    // `prefer` first (when files for it exist), then the set's own config.
    let cfg = base, files = [];
    for (const c of [base.prefer, base].filter(Boolean)) {
        const picked = [];
        if (c.cuts) {
            for (const [pattern, ss, db, dur] of c.cuts) {
                const re = new RegExp(pattern);
                const p = raw.find(r => re.test(stem(r)));
                if (p) picked.push({ src: p, ss, db: db ?? 0, dur: dur ?? c.maxDur });
            }
        } else {
            for (const pattern of c.match) {
                const re = new RegExp(pattern);
                for (const p of raw) if (re.test(stem(p)) && !picked.some(x => x.src === p)) picked.push({ src: p, ss: 0, db: 0, dur: c.maxDur });
                if (picked.length >= c.n) break;
            }
        }
        if (picked.length) { cfg = c; files = picked.slice(0, c.cuts ? c.cuts.length : c.n); break; }
    }
    if (files.length === 0) { missing.push(set); continue; }
    if (files.length < (cfg.cuts ? cfg.cuts.length : cfg.n)) console.log(`  ${set}: only ${files.length} of ${cfg.cuts ? cfg.cuts.length : cfg.n} variants found`);
    files.forEach(({ src, ss, db, dur }, i) => {
        const name = `${set}_${i + 1}.${EXT}`;
        const pre = chain(cfg, ss, dur);
        // Pass 1: measure the peak after the chain; pass 2: normalise to PEAK_DB (+ the map's gain) and encode.
        const log = ffmpeg(['-i', src, '-af', `${pre},volumedetect`, '-f', 'null', '-']);
        const m = /max_volume: (-?[\d.]+) dB/.exec(log);
        const peak = m ? Number(m[1]) : 0;
        const gain = PEAK_DB - peak + (cfg.gain ?? 0) + db;
        ffmpeg(['-i', src, '-af', `${pre},volume=${gain.toFixed(2)}dB`, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', '-ar', '44100', join(OUT, name)]);
        const size = statSync(join(OUT, name)).size;
        total += size;
        const parts = relative(SRC, src).split(sep);
        const did = ['mono', ss > 0 ? `cut from ${ss.toFixed(3)} s` : 'trimmed', dur ? `${dur} s long` : '', cfg.pitch ? `speed x${cfg.pitch}` : '',
            cfg.hp ? `high-pass ${cfg.hp} Hz` : '', cfg.lp ? `low-pass ${cfg.lp} Hz` : '', cfg.denoise ? `denoised ${cfg.denoise} dB` : '',
            `peak-normalised to ${PEAK_DB + (cfg.gain ?? 0) + db} dBFS`, 'MP3 64 kbit/s'].filter(Boolean).join(', ');
        rows.push({ name, pack: parts[0], file: parts.slice(1).join('/'), did, size, used: src });
    });
}

/** "Kenney impact-sounds" or "Freesound 136399 by felixblume" for a raw file. */
function sourceOf(r) {
    if (r.pack === 'freesound') {
        const m = /^(\d+)__([^_]+)__/.exec(basename(r.file));
        if (m) return `[Freesound ${m[1]}](https://freesound.org/s/${m[1]}/) by ${m[2]}`;
        return `Freesound (${basename(r.file)})`;
    }
    if (r.pack === 'knife-pack') return 'Fab "Knife FPS Animations" (the owner’s knife pack, package V)';
    return `Kenney ${r.pack}`;
}
/** Licence of a raw file's pack. */
const licenceOf = r => (r.pack === 'knife-pack' ? 'Fab Standard License' : 'CC0');
const usedFiles = new Set(rows.map(r => r.used));
const unused = raw.filter(p => relative(SRC, p).split(sep)[0] === 'freesound' && !usedFiles.has(p));
const lines = [
    '# Credits for the recorded sounds',
    '',
    'Every file here is derived from sounds that are released under Creative Commons CC0 1.0 (public domain; no',
    'attribution required, given here anyway): the Kenney packs (https://kenney.nl) and single recordings from',
    'Freesound (https://freesound.org), except the knife swings, which come from the owner’s Fab "Knife FPS Animations"',
    'pack (Fab Standard License: only these processed files ship). Generated by `tools/process-audio.mjs`; do not edit by',
    'hand. The raw files are',
    'not in the repository (`tools/audio-source/` is git-ignored).',
    '',
    '| Shipped file | Source | Original file | Licence | What was done |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.name} | ${sourceOf(r)} | ${r.file} | ${licenceOf(r)} | ${r.did} |`),
    ''
];
if (unused.length) lines.push('Freesound files present but not used by any sound:', '', ...unused.map(p => `- ${basename(p)}`), '');
if (missing.length) lines.push('Sounds with no recorded file (they play the synthesised sound):', '', ...missing.map(m => `- ${m}`), '');
writeFileSync(join(OUT, 'CREDITS.md'), lines.join('\n'));

for (const r of rows) console.log(`  ${r.name.padEnd(28)} ${String(r.size).padStart(7)} B  <- ${r.pack}/${r.file}`);
console.log(`\n${rows.length} files, ${(total / 1024).toFixed(1)} KiB total.`);
if (missing.length) console.log(`No raw file for: ${missing.join(', ')} (stay synthesised; fix tools/audio-map.json if a file exists under another name)`);
