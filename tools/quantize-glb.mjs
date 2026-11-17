// Shrinks the weapon GLBs written by tools/blender/weapons.py and viewmodel.py (package M part 2) by storing vertex
// attributes in small integer formats instead of 32-bit floats:
//   NORMAL     -> signed byte, normalised (KHR_mesh_quantization)        12 -> 4 bytes per vertex
//   TEXCOORD_0 -> unsigned short, normalised (core glTF; UVs are 0..1)    8 -> 4
//   COLOR_0    -> unsigned byte, normalised (core glTF)                   8 or 16 -> 4
//   WEIGHTS_0  -> unsigned byte, normalised, summing to 255 (core glTF)  16 -> 4
// Positions, indices, joints, skins and animations are copied unchanged. PlayCanvas reads normalised accessors
// directly (the client's weapons.ts reads them back as floats when it merges meshes).
//
//   node tools/quantize-glb.mjs <file.glb> [...]      (rewrites each file in place)
import { readFileSync, writeFileSync } from 'node:fs';

const BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const align4 = n => (n + 3) & ~3;

/** Accessor values as plain numbers (normalised integers mapped to their float range). */
function readAccessor(g, bin, a) {
    const n = COMPS[a.type], size = BYTES[a.componentType], count = a.count;
    const out = new Float64Array(count * n);
    if (a.bufferView === undefined) return out;
    const bv = g.bufferViews[a.bufferView];
    const stride = bv.byteStride ?? n * size;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    for (let i = 0; i < count; i++) {
        for (let c = 0; c < n; c++) {
            const o = base + i * stride + c * size;
            let v;
            switch (a.componentType) {
                case 5126: v = dv.getFloat32(o, true); break;
                case 5125: v = dv.getUint32(o, true); break;
                case 5123: v = dv.getUint16(o, true); if (a.normalized) v /= 65535; break;
                case 5122: v = dv.getInt16(o, true); if (a.normalized) v = Math.max(v / 32767, -1); break;
                case 5121: v = dv.getUint8(o); if (a.normalized) v /= 255; break;
                case 5120: v = dv.getInt8(o); if (a.normalized) v = Math.max(v / 127, -1); break;
            }
            out[i * n + c] = v;
        }
    }
    return out;
}

function rawAccessorBytes(g, bin, a) {
    const n = COMPS[a.type], size = BYTES[a.componentType];
    const bv = g.bufferViews[a.bufferView];
    const stride = bv.byteStride ?? n * size;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = Buffer.alloc(a.count * n * size);
    for (let i = 0; i < a.count; i++) bin.copy(out, i * n * size, base + i * stride, base + i * stride + n * size);
    return out;
}

function quantize(file) {
    const b = readFileSync(file);
    const jsonLen = b.readUInt32LE(12);
    const g = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
    const binStart = 20 + align4(jsonLen) + 8;
    const bin = b.subarray(binStart, binStart + b.readUInt32LE(20 + align4(jsonLen)));
    const before = b.length;

    const semantic = new Map();
    for (const m of g.meshes ?? []) for (const p of m.primitives) {
        for (const [k, v] of Object.entries(p.attributes)) semantic.set(v, k);
        if (p.indices !== undefined) semantic.set(p.indices, 'INDICES');
    }
    const isVertex = i => semantic.has(i) && semantic.get(i) !== 'INDICES';

    const chunks = [];
    const views = [];
    let offset = 0;
    const push = (buf, stride, target) => {
        const view = { buffer: 0, byteOffset: offset, byteLength: buf.length };
        if (stride) view.byteStride = stride;
        if (target) view.target = target;
        views.push(view);
        chunks.push(buf);
        const pad = align4(buf.length) - buf.length;
        if (pad) chunks.push(Buffer.alloc(pad));
        offset += align4(buf.length);
        return views.length - 1;
    };

    g.accessors.forEach((a, i) => {
        if (a.bufferView === undefined) return;
        const sem = semantic.get(i);
        const n = COMPS[a.type];
        if (sem === 'NORMAL' || sem === 'TEXCOORD_0' || sem === 'COLOR_0' || sem === 'WEIGHTS_0') {
            const v = readAccessor(g, bin, a);
            let buf, stride, ctype;
            if (sem === 'NORMAL') {
                buf = Buffer.alloc(a.count * 4); stride = 4; ctype = 5120;
                for (let k = 0; k < a.count; k++) for (let c = 0; c < 3; c++) buf.writeInt8(Math.round(Math.max(-1, Math.min(1, v[k * 3 + c])) * 127), k * 4 + c);
            } else if (sem === 'TEXCOORD_0') {
                buf = Buffer.alloc(a.count * 4); stride = 4; ctype = 5123;
                for (let k = 0; k < a.count * 2; k++) buf.writeUInt16LE(Math.round(Math.max(0, Math.min(1, v[k])) * 65535), k * 2);
            } else if (sem === 'COLOR_0') {
                buf = Buffer.alloc(a.count * 4); stride = 4; ctype = 5121;
                for (let k = 0; k < a.count; k++) for (let c = 0; c < 4; c++) buf.writeUInt8(Math.round(Math.max(0, Math.min(1, c < n ? v[k * n + c] : 1)) * 255), k * 4 + c);
                a.type = 'VEC4';
            } else {
                buf = Buffer.alloc(a.count * 4); stride = 4; ctype = 5121;
                for (let k = 0; k < a.count; k++) {
                    const w = [0, 1, 2, 3].map(c => Math.max(0, v[k * 4 + c]));
                    const sum = w.reduce((x, y) => x + y, 0) || 1;
                    const q = w.map(x => Math.round((x / sum) * 255));
                    // Keep the sum exactly 255: fix the rounding on the largest weight.
                    const big = q.indexOf(Math.max(...q));
                    q[big] += 255 - q.reduce((x, y) => x + y, 0);
                    for (let c = 0; c < 4; c++) buf.writeUInt8(q[c], k * 4 + c);
                }
            }
            a.componentType = ctype;
            a.normalized = true;
            delete a.byteOffset;
            if (sem === 'NORMAL' || sem === 'TEXCOORD_0') {
                // min/max must describe the stored values; positions keep theirs, these are optional: drop them.
                delete a.min; delete a.max;
            }
            a.bufferView = push(buf, stride, 34962);
        } else {
            const raw = rawAccessorBytes(g, bin, a);
            const size = BYTES[a.componentType];
            const stride = isVertex(i) && (n * size) % 4 === 0 ? n * size : undefined;
            const target = sem === 'INDICES' ? 34963 : isVertex(i) ? 34962 : undefined;
            delete a.byteOffset;
            a.bufferView = push(raw, stride, target);
        }
    });
    // Images or other views not referenced by accessors (none expected): carry them over.
    for (const im of g.images ?? []) {
        if (im.bufferView !== undefined) {
            const bv = g.bufferViews[im.bufferView];
            im.bufferView = push(Buffer.from(bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)));
        }
    }
    g.bufferViews = views;
    g.buffers = [{ byteLength: offset }];
    g.extensionsUsed = [...new Set([...(g.extensionsUsed ?? []), 'KHR_mesh_quantization'])];
    g.extensionsRequired = [...new Set([...(g.extensionsRequired ?? []), 'KHR_mesh_quantization'])];

    let json = Buffer.from(JSON.stringify(g), 'utf8');
    json = Buffer.concat([json, Buffer.alloc(align4(json.length) - json.length, 0x20)]);
    const binBuf = Buffer.concat(chunks);
    const total = 12 + 8 + json.length + 8 + binBuf.length;
    const out = Buffer.alloc(total);
    out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
    out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20);
    const o = 20 + json.length;
    out.writeUInt32LE(binBuf.length, o); out.writeUInt32LE(0x004e4942, o + 4); binBuf.copy(out, o + 8);
    writeFileSync(file, out);
    console.log(`${file}: ${before} -> ${total} bytes`);
}

for (const f of process.argv.slice(2)) quantize(f);
