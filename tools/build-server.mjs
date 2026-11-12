// Bundles the game server into one ESM file: dist/server/main.js (run with `npm start`).
//
// `ws` is bundled in, so the production server needs no node_modules at all: the
// Docker image is just this file plus the map JSON. `ws` is CommonJS and calls
// require() for Node built-ins, which an ESM bundle has no global for, so the
// banner recreates `require` with createRequire. bufferutil / utf-8-validate are
// optional native speed-ups that `ws` loads inside try/catch; they stay external
// and `ws` falls back to its pure-JS code when they are absent.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const outdir = 'dist/server';
rmSync(outdir, { recursive: true, force: true });

await build({
    entryPoints: ['server/src/main.ts'],
    outfile: `${outdir}/main.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    external: ['bufferutil', 'utf-8-validate'],
    banner: {
        js: "import { createRequire as __sbCreateRequire } from 'node:module'; const require = __sbCreateRequire(import.meta.url);"
    },
    logLevel: 'info'
});
