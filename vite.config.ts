import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { assetSizes } from './tools/asset-sizes-plugin';

export default defineConfig({
    root: 'client',
    // Relative asset URLs, so the build can be hosted under any path.
    base: './',
    // The size of every shipped file, for the loading screen's progress bar (client/src/asset-sizes.ts).
    plugins: [assetSizes(fileURLToPath(new URL('./client/public', import.meta.url)))],
    resolve: {
        alias: {
            '@shared': fileURLToPath(new URL('./shared', import.meta.url))
        }
    },
    server: { port: 5173, strictPort: true },
    build: {
        outDir: '../dist/client',
        emptyOutDir: true,
        target: 'es2022'
    },
    test: {
        root: '.',
        include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'client/**/*.test.ts']
    }
});
