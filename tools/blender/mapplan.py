"""
Top-down plan images of a map, one per floor level (plain Python, no Blender):

    python tools/blender/mapplan.py <id> [out_dir]      (default out_dir: docs/review/maps)

Each image shows, for one level: floor slabs (grey), solids at walking height (dark, by category),
visual-only boxes (outline), stairs (orange), reachable standing spots (green dots), bomb sites
(red / blue), spawns (ghosts purple, defenders cyan) and a 2 m grid. North (+Y, defender side) is up.
"""

import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mapkit  # noqa: E402

PX = 12          # pixels per metre

CAT_COLOURS = {
    "outer_wall": (60, 60, 70), "inner_wall": (95, 95, 110), "crate": (150, 110, 60),
    "platform": (90, 120, 150), "stairs": (230, 140, 40), "rack": (200, 120, 40), "car": (120, 60, 160),
    "machine": (70, 120, 120), "rail": (200, 200, 60), "column": (40, 40, 40),
}


class Canvas:
    def __init__(self, w, h, bg=(250, 250, 248)):
        self.w, self.h = w, h
        self.px = bytearray(bytes(bg) * (w * h))

    def rect(self, x0, y0, x1, y1, col, outline=False):
        x0, x1 = max(0, min(x0, x1)), min(self.w - 1, max(x0, x1))
        y0, y1 = max(0, min(y0, y1)), min(self.h - 1, max(y0, y1))
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if outline and not (x in (x0, x1) or y in (y0, y1)):
                    continue
                i = (y * self.w + x) * 3
                self.px[i:i + 3] = bytes(col)

    def blend_rect(self, x0, y0, x1, y1, col, a):
        x0, x1 = max(0, min(x0, x1)), min(self.w - 1, max(x0, x1))
        y0, y1 = max(0, min(y0, y1)), min(self.h - 1, max(y0, y1))
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                i = (y * self.w + x) * 3
                for k in range(3):
                    self.px[i + k] = int(self.px[i + k] * (1 - a) + col[k] * a)

    def save(self, path):
        raw = b"".join(b"\x00" + bytes(self.px[y * self.w * 3:(y + 1) * self.w * 3]) for y in range(self.h))

        def chunk(t, d):
            c = struct.pack(">I", len(d)) + t + d
            return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
        with open(path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
                    + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def render(m, g, out_dir):
    xs = [b["mn"][0] for b in m.boxes] + [b["mx"][0] for b in m.boxes]
    ys = [b["mn"][1] for b in m.boxes] + [b["mx"][1] for b in m.boxes]
    X0, X1, Y0, Y1 = min(xs) - 1, max(xs) + 1, min(ys) - 1, max(ys) + 1
    W, H = int((X1 - X0) * PX), int((Y1 - Y0) * PX)

    def tx(x):
        return int((x - X0) * PX)

    def ty(y):
        return int((Y1 - y) * PX)

    levels = sorted(set(round(b["mx"][2], 3) for b in m.boxes if b["category"] in m.floor_categories))
    reach = getattr(m, "_reach", None)
    paths = []
    for lv in levels:
        c = Canvas(W, H)
        for gx in range(int(X0) // 2 * 2, int(X1) + 2, 2):
            c.rect(tx(gx), 0, tx(gx), H - 1, (232, 232, 230))
        for gy in range(int(Y0) // 2 * 2, int(Y1) + 2, 2):
            c.rect(0, ty(gy), W - 1, ty(gy), (232, 232, 230))
        for b in m.boxes:
            if b["category"] in m.floor_categories and abs(b["mx"][2] - lv) < 1e-3:
                c.rect(tx(b["mn"][0]), ty(b["mx"][1]), tx(b["mx"][0]), ty(b["mn"][1]), (205, 205, 200))
        for name, (x0, y0), (x1, y1), z in m.sites:
            if abs(z - lv) < 0.5:
                c.blend_rect(tx(x0), ty(y1), tx(x1), ty(y0), (230, 60, 50) if name == "A" else (60, 90, 230), 0.35)
        for b in m.boxes:
            if b["category"] in m.floor_categories:
                continue
            if b["mn"][2] < lv + mapkit.HULL_H and b["mx"][2] > lv + 0.05:
                col = CAT_COLOURS.get(b["category"], (80, 80, 80))
                if b["mx"][2] <= lv + 1.2:          # low (jumpable / stand-on): lighter
                    col = tuple(int(v * 0.5 + 255 * 0.5) for v in col)
                c.rect(tx(b["mn"][0]), ty(b["mx"][1]), tx(b["mx"][0]), ty(b["mn"][1]), col)
        for v in m.visuals:
            if v["mn"][2] < lv + 3.0 and v["mx"][2] > lv:
                c.rect(tx(v["mn"][0]), ty(v["mx"][1]), tx(v["mx"][0]), ty(v["mn"][1]), (150, 150, 150), outline=True)
        if reach is not None:
            for n in reach:
                ix, iy, z = g.nodes[n]
                if abs(z - lv) <= 1.25 or (lv == levels[0] and z < lv) or \
                        (z > lv and all(not (lv < L <= z + 1e-6) for L in levels if L != lv) and abs(z - lv) < 3.0):
                    if ix % 2 == 0 and iy % 2 == 0:
                        x, y = g.centre(ix, iy)
                        c.rect(tx(x), ty(y), tx(x), ty(y), (40, 170, 70))
        for team, col in (("ghosts", (150, 50, 200)), ("defenders", (20, 180, 210))):
            for (x, y, z), _ in m.spawns[team]:
                if abs(z - lv) < 1.0:
                    c.rect(tx(x) - 3, ty(y) - 3, tx(x) + 3, ty(y) + 3, col)
        path = os.path.join(out_dir, "%s_plan_%s.png" % (m.id, ("%+.1f" % lv).replace("+", "p").replace("-", "m").replace(".", "_")))
        c.save(path)
        paths.append(path)
    return paths


def main():
    map_id = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.normpath(os.path.join(HERE, "..", "..", "docs", "review", "maps"))
    os.makedirs(out_dir, exist_ok=True)
    m = mapkit.load_map(map_id)
    try:
        g = mapkit.verify(m)
    except mapkit.VerifyError as exc:
        print(exc)
        g = getattr(m, "_graph", None)
    if g is None:
        g = mapkit.WalkGraph(m)
    for p in render(m, g, out_dir):
        print("wrote", p)


if __name__ == "__main__":
    main()
