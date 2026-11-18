// Vite plugin: the module `virtual:asset-sizes`, the size in bytes of every file in `client/public` and the files each
// map loads, measured when Vite starts or builds. The loading screen (client/src/loading.ts) weights its bar by these
// sizes, so it knows every total before a byte arrives and needs no Content-Length (which a compressing server, or
// Cloudflare, may leave out). It is part of the page's script: no extra download.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';

const ID = 'virtual:asset-sizes';
const RESOLVED = '\0' + ID;

function walk(dir: string, root: string, out: Record<string, number>): void {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, root, out);
        else if (!/\.md$/i.test(name)) out[relative(root, p).replace(/\\/g, '/')] = st.size;
    }
}

/** Every file a map's load fetches, by map id: its data, geometry, lightmap, sky and albedo textures. */
function mapFiles(publicDir: string, sizes: Record<string, number>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const path of Object.keys(sizes)) {
        const m = /^maps\/([a-z0-9_-]+)\.json$/.exec(path);
        if (!m || m[1] === 'index') continue;
        const files = [`maps/${m[1]}.json`, `maps/${m[1]}.glb`];
        try {
            const look = JSON.parse(readFileSync(join(publicDir, path), 'utf8')).look as
                { lightmap?: string; sky?: { texture?: string }; materials?: Record<string, { albedo?: string }> } | undefined;
            if (look) {
                const extra = [look.lightmap, look.sky?.texture, ...Object.values(look.materials ?? {}).map(x => x.albedo)];
                for (const f of extra) if (f && !files.includes(`maps/${f}`)) files.push(`maps/${f}`);
            }
        } catch { /* a map without look data loads only its JSON and GLB */ }
        out[m[1]] = files;
    }
    return out;
}

export function assetSizes(publicDir: string): Plugin {
    return {
        name: 'stillblade-asset-sizes',
        resolveId(id) { return id === ID ? RESOLVED : null; },
        load(id) {
            if (id !== RESOLVED) return null;
            const sizes: Record<string, number> = {};
            walk(publicDir, publicDir, sizes);
            return `export const sizes = ${JSON.stringify(sizes)};\nexport const mapFiles = ${JSON.stringify(mapFiles(publicDir, sizes))};\n`;
        }
    };
}
