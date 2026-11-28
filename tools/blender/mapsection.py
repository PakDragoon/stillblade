"""
Vertical cross-sections of a map's collision boxes, as SVG (plain Python, no Blender):

    python tools/blender/mapsection.py <map id> <spec.json> <out_dir>

The spec is a list of sections, each:
    {"name": "a_roof_route", "title": "...",
     "axis": "x" | "y",          # the section runs along authoring X or Y ...
     "cut": 0.0,                  # ... through this authoring Y (axis x) or X (axis y)
     "from": -24.0, "to": 0.0,    # range along the axis (authoring metres)
     "zmin": -1.6, "zmax": 5.0,
     "behind": 3.0,               # boxes up to this far behind the cut are drawn faintly (context)
     "flip": false,               # true: draw `to` on the left
     "players": [{"at": -20.0, "z": 0.0, "crouch": false, "label": "..."}],
     "sight": [{"from": [at, z], "to": [at, z], "label": "...", "blocked": true}],
     "marks": [{"at": -20.0, "z": 3.0, "text": "..."}],
     "axis_label": "plan x (m)", "tick_offset": 40.0, "tick_sign": 1}
Boxes cut by the plane are filled by category; a 1.8 m standing hull (1.2 m crouched) is drawn for each player.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mapkit  # noqa: E402

PX = 40.0
FILL = {
    "floor": "#5b6068", "basin_stairs": "#9aa7b4", "stairs": "#9aa7b4", "platform": "#3fae6e", "outer_wall": "#6f7680",
    "inner_wall": "#8e98a3", "crate": "#f0a030", "vehicle": "#6d8f7a", "roof": "#c9b25a",
}


def section_svg(m, s):
    ax = 0 if s["axis"] == "x" else 1
    other = 1 - ax
    a0, a1 = s["from"], s["to"]
    z0, z1 = s["zmin"], s["zmax"]
    flip = s.get("flip", False)
    behind = s.get("behind", 0.0)
    left, top, pad_b = 60, 70, 60
    w = int((a1 - a0) * PX) + left + 40
    h = int((z1 - z0) * PX) + top + pad_b

    def X(a):
        return left + ((a1 - a) if flip else (a - a0)) * PX

    def Z(z):
        return top + (z1 - z) * PX

    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" font-family="Segoe UI,Arial">' % (w, h),
           '<rect width="100%" height="100%" fill="#14171d"/>',
           '<text x="%d" y="26" font-size="17" font-weight="700" fill="#fff">%s</text>' % (left, s["title"]),
           '<text x="%d" y="48" font-size="12" fill="#aab">%s</text>' % (left, s.get("subtitle", ""))]
    # grid: 1 m
    z = int(z0)
    while z <= z1:
        out.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="#262b35"/>' % (left, Z(z), w - 40, Z(z)))
        out.append('<text x="%d" y="%.1f" font-size="10" fill="#778" text-anchor="end">%+.0f m</text>' % (left - 6, Z(z) + 3, z))
        z += 1
    off, sign = s.get("tick_offset", 0.0), s.get("tick_sign", 1)
    a = int(a0) if a0 == int(a0) else int(a0) + 1
    while a <= a1:
        if a % 2 == 0:
            out.append('<line x1="%.1f" y1="%d" x2="%.1f" y2="%.1f" stroke="#262b35"/>' % (X(a), top, X(a), Z(z0)))
            out.append('<text x="%.1f" y="%.1f" font-size="10" fill="#778" text-anchor="middle">%g</text>'
                       % (X(a), Z(z0) + 14, off + sign * a))
        a += 1
    out.append('<text x="%d" y="%d" font-size="11" fill="#99a">%s</text>' % (left, h - 12, s.get("axis_label", "")))
    cut = s["cut"]
    for layer in ("behind", "cut"):
        for b in sorted(m.boxes, key=lambda b: b["mn"][2]):
            mn, mx = b["mn"], b["mx"]
            if mx[ax] <= a0 or mn[ax] >= a1 or mx[2] <= z0 or mn[2] >= z1:
                continue
            in_cut = mn[other] - 1e-6 <= cut <= mx[other] + 1e-6
            if layer == "cut" and not in_cut:
                continue
            if layer == "behind":
                if in_cut or behind <= 0:
                    continue
                d = mn[other] - cut if mn[other] > cut else cut - mx[other]
                if d > behind:
                    continue
            xa, xb = sorted((X(max(mn[ax], a0)), X(min(mx[ax], a1))))
            za, zb = Z(min(mx[2], z1)), Z(max(mn[2], z0))
            col = FILL.get(b["category"], "#8e98a3")
            if layer == "cut":
                out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="#111" stroke-width="0.6"/>'
                           % (xa, za, xb - xa, zb - za, col))
            else:
                out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" stroke="%s" stroke-opacity="0.45" '
                           'stroke-dasharray="4,3"/>' % (xa, za, xb - xa, zb - za, col))
    for sl in s.get("sight", []):
        (pa, pz), (qa, qz) = sl["from"], sl["to"]
        col = "#ff5566" if sl.get("blocked") else "#55ff99"
        # where the line first enters a box cut by the plane (in section coordinates)
        hit = 1.0
        for b in m.boxes:
            mn, mx = b["mn"], b["mx"]
            if not (mn[other] - 1e-6 <= cut <= mx[other] + 1e-6):
                continue
            t0, t1, ok = 0.0, 1.0, True
            for o, d, lo, hi in ((pa, qa - pa, mn[ax], mx[ax]), (pz, qz - pz, mn[2], mx[2])):
                if abs(d) < 1e-9:
                    ok = ok and lo < o < hi
                    continue
                u, v = sorted(((lo - o) / d, (hi - o) / d))
                t0, t1 = max(t0, u), min(t1, v)
            if ok and t0 < t1 and t0 < hit:
                hit = t0
        ha, hz = pa + (qa - pa) * hit, pz + (qz - pz) * hit
        out.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="2" stroke-dasharray="7,4"/>'
                   % (X(pa), Z(pz), X(ha), Z(hz), col))
        if hit < 1.0:
            out.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-opacity="0.25" stroke-width="1" '
                       'stroke-dasharray="2,4"/>' % (X(ha), Z(hz), X(qa), Z(qz), col))
            out.append('<circle cx="%.1f" cy="%.1f" r="4" fill="none" stroke="%s" stroke-width="2"/>' % (X(ha), Z(hz), col))
        if sl.get("label"):
            out.append('<text x="%.1f" y="%.1f" font-size="11" fill="%s">%s</text>' % (X(pa) + 6, Z(pz) - 6, col, sl["label"]))
    for p in s.get("players", []):
        hh = 1.2 if p.get("crouch") else 1.8
        xa, xb = sorted((X(p["at"] - 0.3), X(p["at"] + 0.3)))
        out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="#ffd84d" fill-opacity="0.35" stroke="#ffd84d" '
                   'stroke-width="1.5" rx="3"/>' % (xa, Z(p["z"] + hh), xb - xa, hh * PX))
        eye = p["z"] + (1.02 if p.get("crouch") else 1.62)
        out.append('<circle cx="%.1f" cy="%.1f" r="3" fill="#ffd84d"/>' % (X(p["at"]), Z(eye)))
        if p.get("label"):
            ly = Z(p["z"] + hh) - 6 if not p.get("label_below") else Z(p["z"]) + 14
            out.append('<text x="%.1f" y="%.1f" font-size="11" fill="#ffd84d" text-anchor="middle">%s</text>'
                       % (X(p["at"]), ly, p["label"]))
    for mk in s.get("marks", []):
        out.append('<text x="%.1f" y="%.1f" font-size="11.5" fill="#dde" text-anchor="middle">%s</text>'
                   % (X(mk["at"]), Z(mk["z"]), mk["text"]))
    out.append("</svg>")
    return "\n".join(out)


def main():
    if len(sys.argv) < 4:
        raise SystemExit("usage: python tools/blender/mapsection.py <map id> <spec.json> <out_dir>")
    m = mapkit.load_map(sys.argv[1])
    spec = json.load(open(sys.argv[2], encoding="utf-8"))
    os.makedirs(sys.argv[3], exist_ok=True)
    for s in spec:
        path = os.path.join(sys.argv[3], s["name"] + ".svg")
        with open(path, "w", encoding="utf-8") as f:
            f.write(section_svg(m, s))
        print(path)


if __name__ == "__main__":
    main()
