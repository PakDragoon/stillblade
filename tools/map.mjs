// Builds a map from tools/blender/maps/<id>.py in headless Blender: `npm run map -- <id> [--no-bake]`.
// Set BLENDER to the Blender executable if it is not at the default Windows install path.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_BLENDER = 'C:/Program Files/Blender Foundation/Blender 5.3/blender.exe';
const blender = process.env.BLENDER ?? (existsSync(DEFAULT_BLENDER) ? DEFAULT_BLENDER : 'blender');
const script = fileURLToPath(new URL('./blender/build_map.py', import.meta.url));
const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('-')) {
    console.error('usage: npm run map -- <map id> [--no-bake] [--samples N] [--size N] [--verify-only]');
    process.exit(2);
}
const result = spawnSync(blender, ['--background', '--factory-startup', '--python', script, '--', ...args], { stdio: 'inherit' });
if (result.error) {
    console.error(`could not start Blender (${blender}): ${result.error.message}`);
    process.exit(1);
}
process.exit(result.status ?? 1);
