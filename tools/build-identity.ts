import { execFileSync } from 'node:child_process';
import type { Plugin } from 'vite';
import { PROTOCOL_VERSION } from '../shared/protocol';

/** Emit an independently fetchable identity for the deployed client. */
export function buildIdentity(): Plugin {
    return {
        name: 'stillblade-build-identity',
        generateBundle() {
            const commit = process.env.WORKERS_CI_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA ||
                process.env.GITHUB_SHA || gitHead();
            this.emitFile({
                type: 'asset',
                fileName: 'version.json',
                source: JSON.stringify({ protocol: PROTOCOL_VERSION, commit: commit || null }) + '\n'
            });
        }
    };
}

function gitHead(): string {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000
        }).trim();
    } catch {
        return '';
    }
}
