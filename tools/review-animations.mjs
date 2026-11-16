// Turns the frame folders rendered by tools/blender/review.py into review files with ffmpeg (must be on PATH):
//   node tools/review-animations.mjs <frames dir> [out dir = docs/review/animations]
// For each folder: <name>.jpg (one frame, or up to 12 evenly spaced frames tiled 4 x 3, left to right, top to
// bottom) and, for clips of more than one frame, <name>.mp4 (30 fps, every frame, H.264).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const framesDir = resolve(process.argv[2] ?? 'docs/review/animations/frames');
const outDir = resolve(process.argv[3] ?? 'docs/review/animations');
mkdirSync(outDir, { recursive: true });
const ff = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });

for (const name of readdirSync(framesDir).sort()) {
    const dir = join(framesDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const count = readdirSync(dir).filter(f => f.endsWith('.png')).length;
    if (count === 0) continue;
    const pattern = join(dir, '%03d.png');
    if (count === 1) {
        ff('-i', join(dir, '000.png'), '-q:v', '3', join(outDir, `${name}.jpg`));
    } else {
        const step = Math.max(1, Math.ceil(count / 12));
        ff('-framerate', '30', '-i', pattern, '-vf', `select='not(mod(n\\,${step}))',scale=320:180,tile=4x3`,
            '-frames:v', '1', '-q:v', '3', join(outDir, `${name}.jpg`));
        ff('-framerate', '30', '-i', pattern, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '30',
            '-movflags', '+faststart', join(outDir, `${name}.mp4`));
    }
    console.log(name, count, 'frames', existsSync(join(outDir, `${name}.mp4`)) ? '(sheet + video)' : '(still)');
}
