/**
 * The browser side of the loading screen's progress (`loading.ts`): fetches a file once with a streamed body, so its
 * bytes are counted as they arrive (decoded bytes, so a server that compresses the file changes nothing), and hands
 * those bytes to the PlayCanvas asset that wanted the file (`asset.file.contents`), so the engine never downloads it a
 * second time. A failed download waits for the player's "Try again" while a loading screen holds failures.
 */
import * as pc from 'playcanvas';
import { sizes } from 'virtual:asset-sizes';
import type { FileTrack } from './loading';

/** A path under `client/public` ("maps/warehouse.glb") from a URL the client fetches ("./maps/warehouse.glb"). */
export function publicPath(url: string, base: string): string {
    let p = url;
    if (base && p.startsWith(base)) p = p.slice(base.length);
    p = p.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/^\.?\//, '').replace(/[?#].*$/, '');
    return p;
}

/** The size the build measured for a file the client fetches, or null. */
export function sizeOf(url: string): number | null {
    return sizes[publicPath(url, import.meta.env.BASE_URL)] ?? null;
}

/** The response came from the browser's cache (no body over the network): a 0-byte or header-only transfer. */
function fromCache(url: string): boolean {
    try {
        const entries = performance.getEntriesByName(new URL(url, location.href).href, 'resource');
        const e = entries[entries.length - 1] as PerformanceResourceTiming | undefined;
        return !!e && e.encodedBodySize > 0 && e.transferSize < e.encodedBodySize;
    } catch {
        return false;
    }
}

/** Reads a response body chunk by chunk, reporting the bytes so far. */
async function readBody(r: Response, file: FileTrack | null): Promise<ArrayBuffer> {
    if (!r.body || !file) return r.arrayBuffer();
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        file.progress(got);
    }
    // One copy into a buffer of exactly what arrived.
    const out = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out.buffer;
}

/** The file is missing (a dev server answering with its index page): not worth trying again. */
export class MissingFileError extends Error {}

/**
 * Fetches `url` once, reporting progress to `file`. A network or HTTP failure asks `file.fail` with a retry; the
 * promise waits for the answer, then tries again or rejects. `rejectHtml` treats an HTML answer as a missing file.
 */
export async function fetchTracked(url: string, file: FileTrack | null, opts?: { rejectHtml?: boolean }): Promise<{ buffer: ArrayBuffer; type: string }> {
    for (;;) {
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
            const type = r.headers.get('content-type') ?? '';
            if (opts?.rejectHtml && type.includes('text/html')) throw new MissingFileError(`${url} is missing`);
            // Content-Length is the real size only when the body is not compressed on the way.
            const length = Number(r.headers.get('content-length'));
            const headerTotal = !r.headers.get('content-encoding') && length > 0 ? length : null;
            file?.begin(headerTotal);
            const buffer = await readBody(r, file);
            file?.done(fromCache(url));
            return { buffer, type };
        } catch (err) {
            if (!file) throw err;
            if (err instanceof MissingFileError) { file.fail(err.message); throw err; }
            const message = err instanceof Error ? err.message : String(err);
            const again = await new Promise<boolean>(resolve => file.fail(message, () => resolve(true), () => resolve(false)));
            if (!again) throw err;
        }
    }
}

interface FileData { url: string; contents?: ArrayBuffer }

/**
 * Starts loading a PlayCanvas asset whose 'load' and 'error' handlers are already attached, in place of
 * `app.assets.add(asset); app.assets.load(asset)`. With a track, the file is fetched here (progress, retry) and its
 * bytes given to the engine; a file the engine already holds from an earlier asset (a texture two maps share) is not
 * fetched again and counts as cached. Without a track it loads exactly as before.
 */
export function loadAssetTracked(app: pc.Application, asset: pc.Asset, file: FileTrack | null): void {
    const data = asset.file as FileData | null;
    const url = data?.url;
    if (!file || !url || app.loader.getFromCache(url, asset.type)) {
        if (file) file.done(true);
        app.assets.add(asset);
        app.assets.load(asset);
        return;
    }
    fetchTracked(url, file).then(({ buffer }) => {
        data!.contents = buffer;
        // A file that downloaded but will not parse fails for good (its loader falls back).
        asset.once('error', (err: unknown) => file.fail(String(err)));
        // The engine has its own copies once loaded: let the downloaded bytes go.
        asset.once('load', () => { data!.contents = undefined; });
        app.assets.add(asset);
        app.assets.load(asset);
    }, (err: unknown) => {
        asset.fire('error', err instanceof Error ? err.message : String(err), asset);
    });
}
