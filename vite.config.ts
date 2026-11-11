import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    root: 'client',
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
        include: ['shared/**/*.test.ts', 'server/**/*.test.ts']
    }
});
