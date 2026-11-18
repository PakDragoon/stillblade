import * as pc from 'playcanvas';

/** Reads one vertex attribute of `mesh` as floats (normalised integer formats mapped to 0..1). */
export function readStream(mesh: pc.Mesh, semantic: string): { data: number[]; components: number } | null {
    const vb = mesh.vertexBuffer;
    const el = vb?.getFormat().elements.find(e => e.name === semantic);
    if (!el) return null;
    const data: number[] = [];
    mesh.getVertexStream(semantic, data);
    if (el.normalize) {
        // Normalised integers (tools/quantize-glb.mjs): unsigned map to 0..1, signed to -1..1.
        const t = el.dataType;
        const max = t === pc.TYPE_UINT8 ? 255 : t === pc.TYPE_UINT16 ? 65535 : t === pc.TYPE_INT8 ? 127 : t === pc.TYPE_INT16 ? 32767 : 1;
        const signed = t === pc.TYPE_INT8 || t === pc.TYPE_INT16;
        for (let i = 0; i < data.length; i++) data[i] = signed ? Math.max(-1, data[i] / max) : data[i] / max;
    }
    return { data, components: el.numComponents };
}
