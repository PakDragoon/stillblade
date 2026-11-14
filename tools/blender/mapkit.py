"""
Stillblade map kit: map definitions and the verification pass, in plain Python (no bpy).

A map is defined in tools/blender/maps/<id>.py by filling in a MapDef: collision boxes, visual-only
boxes, stair flights, spawns, bomb sites, paint decals and lights. tools/blender/mapbuilder.py turns
a MapDef into the shipped files (GLB, JSON, lightmap) inside Blender; this module holds everything
that does not need Blender, so the checks also run on their own:

    python tools/blender/mapkit.py <id>        verify one map (no Blender needed)

Authoring space is Blender's: Z up, metres. X = map width, Y = map length, ghosts at -Y facing +Y.
Engine space (glTF, Y up, -Z forward) = (x, z, -y).
"""

import heapq
import importlib
import math
import os
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
MAPS_DIR = os.path.join(HERE, "maps")

# Player and movement numbers, mirrored from shared/constants.ts (checked against it in verify()).
HULL_W = 0.6
HULL_H = 1.8
EYE = 1.62
STEP_HEIGHT = 0.35
JUMP_REACH = 1.1          # tallest ledge a standing jump lands on (apex ~1.17 m, "clears a 1 m crate")
MIN_WALKWAY = 1.4         # any two solids at walking height must touch or leave at least this gap
MAX_STEP_RISE = 0.3       # stair rises are kept under STEP_HEIGHT with margin
MIN_TREAD = 0.4
MIN_STAIR_WIDTH = 1.6
HEADROOM = 2.0            # clear height above every reachable standing spot
EPS = 1e-4                # same tolerance as shared/collision.ts
CELL = 0.25               # flood-fill grid spacing (m)

# ---------------------------------------------------------------------------------------------
# Albedo texture library (shared by every map; files land in client/public/maps/).
# `src` is a CC0 Poly Haven diffuse map in source-art/textures/ (see client/public/maps/CREDITS.md);
# it is resized, low-frequency "detiled", reduced in contrast (log space), desaturated, and scaled to
# the target mean linear albedo `albedo` (x `tint`). `tile` = metres covered by one repeat.
# Two maps that use the same entry share the same file, so entries are never edited per map.
# ---------------------------------------------------------------------------------------------
TEXTURE_LIBRARY = {
    "floor": dict(src="concrete_floor_02_diff_1k.jpg", out="tex_floor.webp", tile=2.5,
                  albedo=0.23, contrast=0.75, sat=0.45, detile=0.55, tint=(1.0, 0.99, 0.96)),
    "wall_outer": dict(src="factory_brick_diff_1k.jpg", out="tex_wall_outer.webp", tile=1.5,
                       albedo=0.2, contrast=0.75, sat=0.85, detile=0.6, tint=(1.0, 1.0, 1.0)),
    "wall_inner": dict(src="concrete_wall_004_diff_1k.jpg", out="tex_wall_inner.webp", tile=2.0,
                       albedo=0.27, contrast=0.9, sat=0.8, detile=0.5, tint=(1.0, 1.0, 1.0)),
    "crate": dict(src="raw_plank_wall_diff_1k.jpg", out="tex_crate.webp", tile=1.87,
                  albedo=0.30, contrast=0.7, sat=0.85, detile=0.5, tint=(1.0, 1.0, 1.0)),
    "metal": dict(src="blue_metal_plate_diff_1k.jpg", out="tex_metal.webp", tile=2.5,
                  albedo=0.19, contrast=0.8, sat=0.35, detile=0.5, tint=(1.0, 1.0, 1.0)),
    # Warehouse additions
    "wh_floor": dict(src="hangar_concrete_floor_diff_1k.jpg", out="tex_wh_floor.webp", tile=3.0,
                     albedo=0.26, contrast=0.7, sat=0.4, detile=0.6, tint=(1.0, 0.99, 0.97)),
    "wh_block": dict(src="concrete_block_wall_diff_1k.jpg", out="tex_wh_block.webp", tile=2.0,
                     albedo=0.30, contrast=0.8, sat=0.5, detile=0.5, tint=(1.0, 1.0, 1.0)),
    "wh_paint": dict(src="painted_concrete_diff_1k.jpg", out="tex_wh_paint.webp", tile=2.0,
                     albedo=0.52, contrast=0.6, sat=0.25, detile=0.6, tint=(1.0, 1.0, 1.0)),
    "wh_metal": dict(src="metal_plate_02_diff_1k.jpg", out="tex_wh_metal.webp", tile=1.5,
                     albedo=0.28, contrast=0.7, sat=0.3, detile=0.5, tint=(1.0, 1.0, 1.0)),
    "wh_tiles": dict(src="concrete_tiles_diff_1k.jpg", out="tex_wh_tiles.webp", tile=2.4,
                     albedo=0.34, contrast=0.7, sat=0.3, detile=0.4, tint=(1.0, 1.0, 1.0)),
}


class VerifyError(Exception):
    pass


def overlap3(amn, amx, bmn, bmx, eps=1e-6):
    return all(amn[i] < bmx[i] - eps and bmn[i] < amx[i] - eps for i in range(3))


def rect_dist(amn, amx, bmn, bmx):
    dx = max(0.0, bmn[0] - amx[0], amn[0] - bmx[0])
    dy = max(0.0, bmn[1] - amx[1], amn[1] - bmx[1])
    return math.hypot(dx, dy)


def name_rand(name, salt=0):
    """Deterministic pseudo-random value in [-1, 1] from a name."""
    h = 2166136261
    for v in (zlib.crc32(name.encode("utf-8")), salt):
        h ^= v & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    h ^= h >> 15
    h = (h * 0x2C1B3C6D) & 0xFFFFFFFF
    h ^= h >> 12
    h = (h * 0x297A2D39) & 0xFFFFFFFF
    h ^= h >> 15
    return h / 2147483647.5 - 1.0


# ---------------------------------------------------------------------------------------------
# Stroke font for paint (site letters, signage): centre lines in a 1-unit-tall cell, drawn as
# rotated quads, so letters have diagonals and round bowls instead of blocky pixels.
# ---------------------------------------------------------------------------------------------
def _arc(cx, cy, r, a0, a1, n=10):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


GLYPH_STROKES = {
    "A": [[(0.03, 0.0), (0.3, 1.0), (0.44, 1.0), (0.71, 0.0)], [(0.17, 0.36), (0.57, 0.36)]],
    "B": [[(0.08, 0.0), (0.08, 1.0), (0.38, 1.0)] + _arc(0.38, 0.755, 0.245, 90, -90)
          + [(0.08, 0.51), (0.41, 0.51)] + _arc(0.41, 0.255, 0.255, 90, -90) + [(0.08, 0.0)]],
    "P": [[(0.08, 0.0), (0.08, 1.0), (0.38, 1.0)] + _arc(0.38, 0.72, 0.28, 90, -90) + [(0.08, 0.44)]],
    "1": [[(0.16, 0.8), (0.36, 1.0), (0.36, 0.0)], [(0.12, 0.0), (0.6, 0.0)]],
    "2": [_arc(0.33, 0.7, 0.25, 160, -30, 8) + [(0.07, 0.0), (0.62, 0.0)]],
    ">": [[(0.0, 0.5), (0.78, 0.5)], [(0.45, 0.85), (0.8, 0.5), (0.45, 0.15)]],   # arrow, points +u
}
GLYPH_ADVANCE = {"A": 0.86, "B": 0.86, "P": 0.8, "1": 0.72, "2": 0.78, ">": 0.95}


def text_quads(text, height, stroke=0.16):
    """Quads [(u, v) x 4] for a string in a local frame: u to the right, v up, baseline v = 0,
    centred on u = 0, v = 0.5 * height. A space advances half a glyph."""
    quads = []
    x = 0.0
    for ch in text:
        if ch == " ":
            x += 0.5
            continue
        for line in GLYPH_STROKES[ch]:
            for (ax, ay), (bx, by) in zip(line[:-1], line[1:]):
                dx, dy = bx - ax, by - ay
                ln = math.hypot(dx, dy)
                if ln < 1e-9:
                    continue
                ux, uy = dx / ln, dy / ln
                h = stroke / 2
                ax2, ay2, bx2, by2 = ax - ux * h * 0.9, ay - uy * h * 0.9, bx + ux * h * 0.9, by + uy * h * 0.9
                nx, ny = -uy * h, ux * h
                quads.append([(x + ax2 - nx, ay2 - ny), (x + bx2 - nx, by2 - ny),
                              (x + bx2 + nx, by2 + ny), (x + ax2 + nx, ay2 + ny)])
        x += GLYPH_ADVANCE[ch]
    width = max(0.0, x - 0.12)
    out = []
    for q in quads:
        out.append([((u - width / 2) * height, (v - 0.5) * height) for u, v in q])
    return out


# ---------------------------------------------------------------------------------------------
# Map definition
# ---------------------------------------------------------------------------------------------
class MapDef:
    """Everything that makes one map. Filled in by a definition module in tools/blender/maps/."""

    def __init__(self, map_id, display_name):
        self.id = map_id
        self.display_name = display_name
        self.boxes = []          # dicts: name, category, mn, mx, tint, hide (face names never visible)
        self.visuals = []        # dicts: name, surface, mn, mx, tint (visual only, no collision)
        self.surfaces = []       # ordered surface keys; each needs a TEXTURE_LIBRARY entry of the same name
        self.category_surface = {}
        self.noise_amp = {}      # surface -> large-scale brightness variation amplitude
        self.wall_surfaces = set()   # surfaces that get skirting / grime / coping bands
        self.floor_surfaces = {"floor"}   # surfaces cut into sub-quads for large-scale variation
        self.varied_surfaces = {"crate"}  # surfaces whose boxes vary a little in brightness/warmth
        self.paint_surface = "floor"      # albedo texture under the paint decals
        self.spawns = {"ghosts": [], "defenders": []}   # ((x, y, z), engine yaw degrees)
        self.sites = []          # (name, (x0, y0), (x1, y1), floor z)
        self.site_h = 2.5
        self.flights = []        # dicts: name, steps (box names, bottom to top), z0, z1
        self.structure_categories = {"stairs", "platform"}   # pieces of one walkable structure
        self.floor_categories = {"floor"}    # categories whose tops are floor levels
        self.lights = []         # dicts: type POINT / AREA / SPOT, pos, colour, power, ...
        self.decals = []         # dicts: corners (4 x xyz), axis, sign, off, colour
        self.sample_spots = []   # (label, point, axis, sign) printed after the bake
        self.max_sightline = None    # metres; None = not checked for this map
        self.sun_scale = 0.40
        self.sky_scale = 2.6
        self.lightmap_size = 4096
        self.samples = 512
        self.max_glb_bytes = 1024 * 1024

    # ---- geometry --------------------------------------------------------------------------
    def box(self, name, category, mn, mx, tint=None, hide=()):
        """A collision box, drawn with its category's surface. `hide` lists faces that can never be
        seen ("top", "bottom", "+x", ...), or ("all",) for a solid drawn only by visual-only boxes
        inside it (racks, vehicles)."""
        mn = tuple(float(v) for v in mn)
        mx = tuple(float(v) for v in mx)
        if not all(a < b for a, b in zip(mn, mx)):
            raise ValueError("box %s has min >= max: %s %s" % (name, mn, mx))
        self.boxes.append(dict(name=name, category=category, mn=mn, mx=mx, tint=tint, hide=tuple(hide)))
        return name

    def visual(self, name, surface, mn, mx, tint=None):
        mn = tuple(float(v) for v in mn)
        mx = tuple(float(v) for v in mx)
        if not all(a < b for a, b in zip(mn, mx)):
            raise ValueError("visual %s has min >= max: %s %s" % (name, mn, mx))
        self.visuals.append(dict(name=name, surface=surface, mn=mn, mx=mx, tint=tint))
        return name

    def flight(self, name, x0, x1, y0, direction, z0, z1, rise, tread, axis="y", base=None):
        """A straight stair of box steps climbing from floor z0 to floor z1.

        The first step starts at `y0` (or x0 when axis="x"; then x0/x1 are the cross range) and the
        stair climbs toward `direction` (+1 or -1) along that axis. Each step is a solid box from
        `base` (default z0) up to its tread, so there is nothing to crawl under. The landing at z1
        is NOT created here: the floor the stair arrives at must start where the last step ends.
        Returns the coordinate where the top floor must begin."""
        n = int(round((z1 - z0) / rise))
        if abs(n * rise - (z1 - z0)) > 1e-6:
            raise ValueError("flight %s: %.3f m is not a whole number of %.3f m rises" % (name, z1 - z0, rise))
        base = z0 if base is None else base
        steps = []
        for i in range(n - 1):
            top = z0 + rise * (i + 1)
            a = y0 + direction * tread * i
            b = a + direction * tread
            lo, hi = min(a, b), max(a, b)
            nm = "%s_%02d" % (name, i + 1)
            if axis == "y":
                self.box(nm, "stairs", (x0, lo, base), (x1, hi, top))
            else:
                self.box(nm, "stairs", (lo, x0, base), (hi, x1, top))
            steps.append(nm)
        self.flights.append(dict(name=name, steps=steps, z0=z0, z1=z1, axis=axis))
        return y0 + direction * tread * (n - 1)

    # ---- gameplay --------------------------------------------------------------------------
    def spawn(self, team, x, y, z, yaw):
        self.spawns[team].append(((float(x), float(y), float(z)), float(yaw)))

    def site(self, name, p0, p1, z):
        self.sites.append((name, (float(p0[0]), float(p0[1])), (float(p1[0]), float(p1[1])), float(z)))

    # ---- lights (baked only) ----------------------------------------------------------------
    def point_light(self, pos, colour, power, radius=0.2):
        self.lights.append(dict(type="POINT", pos=pos, colour=colour, power=power, radius=radius))

    def area_light(self, pos, size, colour, power, direction=(0, 0, -1)):
        self.lights.append(dict(type="AREA", pos=pos, size=size, colour=colour, power=power, direction=direction))

    def spot_light(self, pos, direction, colour, power, angle=70.0, blend=0.4, radius=0.1):
        self.lights.append(dict(type="SPOT", pos=pos, direction=direction, colour=colour, power=power,
                                angle=angle, blend=blend, radius=radius))

    # ---- paint ------------------------------------------------------------------------------
    def decal(self, corners, axis, sign, off, colour):
        self.decals.append(dict(corners=[tuple(float(c) for c in p) for p in corners], axis=axis, sign=sign,
                                off=off, colour=tuple(colour)))

    def floor_rect(self, x0, y0, x1, y1, z, colour, layer=1):
        off = (0.006, 0.012, 0.018)[layer]
        self.decal([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], 2, 1, off, colour)

    def floor_text(self, text, centre, z, height, colour, up=(0, 1), layer=2, stroke=0.16):
        """Text painted on a floor; `up` is the direction (x, y) of the letters' tops."""
        ux, uy = up
        n = math.hypot(ux, uy)
        ux, uy = ux / n, uy / n
        rx, ry = uy, -ux                       # right = up rotated -90 deg (reads correctly from below)
        off = (0.006, 0.012, 0.018)[layer]
        for q in text_quads(text, height, stroke):
            pts = [(centre[0] + rx * u + ux * v, centre[1] + ry * u + uy * v, z) for u, v in q]
            self.decal(pts, 2, 1, off, colour)

    def wall_rect(self, centre, axis, sign, w, h, colour, layer=0):
        """Rectangle painted on a wall face whose outward normal is (axis, sign); `centre` on the face."""
        off = (0.008, 0.014, 0.02)[layer]
        right = self._wall_right(axis, sign)
        pts = []
        for u, v in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
            pts.append((centre[0] + right[0] * u, centre[1] + right[1] * u, centre[2] + v))
        self.decal(pts, axis, sign, off, colour)

    def wall_text(self, text, centre, axis, sign, height, colour, layer=1, stroke=0.16):
        off = (0.008, 0.014, 0.02)[layer]
        right = self._wall_right(axis, sign)
        for q in text_quads(text, height, stroke):
            pts = [(centre[0] + right[0] * u, centre[1] + right[1] * u, centre[2] + v) for u, v in q]
            self.decal(pts, axis, sign, off, colour)

    @staticmethod
    def _wall_right(axis, sign):
        n = [0.0, 0.0, 0.0]
        n[axis] = float(sign)
        view = (-n[0], -n[1])                  # looking at the wall
        return (view[1], -view[0])             # cross(view, +Z)

    # ---- derived ------------------------------------------------------------------------------
    def solids(self):
        return [(b["mn"], b["mx"]) for b in self.boxes]

    def engine_data(self):
        """Gameplay JSON (engine coordinates) without the render setup."""
        def r3(v):
            out = round(v, 3)
            return 0.0 if out == 0 else out

        def to_engine(p):
            return (p[0], p[2], -p[1])

        def ebox(mn, mx):
            a, b = to_engine(mn), to_engine(mx)
            return [r3(min(a[i], b[i])) for i in range(3)], [r3(max(a[i], b[i])) for i in range(3)]

        boxes = []
        for b in self.boxes:
            emn, emx = ebox(b["mn"], b["mx"])
            boxes.append({"name": b["name"], "category": b["category"], "min": emn, "max": emx})
        bmn = [min(b["min"][i] for b in boxes) for i in range(3)]
        bmx = [max(b["max"][i] for b in boxes) for i in range(3)]
        spawns = {team: [{"pos": [r3(c) for c in to_engine(p)], "yaw": yaw} for p, yaw in lst]
                  for team, lst in self.spawns.items()}
        sites = []
        for name, (x0, y0), (x1, y1), z in self.sites:
            emn, emx = ebox((x0, y0, z), (x1, y1, z + self.site_h))
            sites.append({"name": name, "min": emn, "max": emx})
        return {
            "name": self.id,
            "displayName": self.display_name,
            "bounds": {"min": bmn, "max": bmx},
            "boxes": boxes,
            "spawns": spawns,
            "bombSites": sites,
        }


def load_map(map_id):
    if not map_id.replace("_", "").isalnum():
        raise SystemExit("bad map id %r" % map_id)
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    path = os.path.join(MAPS_DIR, map_id + ".py")
    if not os.path.exists(path):
        found = sorted(f[:-3] for f in os.listdir(MAPS_DIR) if f.endswith(".py") and not f.startswith("_"))
        raise SystemExit("no map definition %s (have: %s)" % (path, ", ".join(found)))
    mod = importlib.import_module("maps." + map_id)
    m = mod.MAP
    if m.id != map_id:
        raise SystemExit("maps/%s.py defines map id %r" % (map_id, m.id))
    return m


# ---------------------------------------------------------------------------------------------
# Spatial index over boxes (XY buckets), used by the flood fill and the ray tests.
# ---------------------------------------------------------------------------------------------
class Grid2D:
    def __init__(self, boxes, cell=2.0):
        self.cell = cell
        self.boxes = boxes
        self.buckets = {}
        for i, (mn, mx) in enumerate(boxes):
            for gx in range(int(math.floor(mn[0] / cell)), int(math.floor(mx[0] / cell)) + 1):
                for gy in range(int(math.floor(mn[1] / cell)), int(math.floor(mx[1] / cell)) + 1):
                    self.buckets.setdefault((gx, gy), []).append(i)

    def query(self, x0, y0, x1, y1):
        c = self.cell
        out = set()
        for gx in range(int(math.floor(x0 / c)), int(math.floor(x1 / c)) + 1):
            for gy in range(int(math.floor(y0 / c)), int(math.floor(y1 / c)) + 1):
                out.update(self.buckets.get((gx, gy), ()))
        return out

    def segment_clear(self, a, b):
        """True if the segment a -> b (3D) enters no box (touching a face does not count)."""
        d = [b[i] - a[i] for i in range(3)]
        length = math.sqrt(sum(c * c for c in d))
        if length < 1e-9:
            return True
        steps = max(1, int(length / (self.cell * 0.5)) + 1)
        seen = set()
        for k in range(steps + 1):
            t0 = max(0.0, (k - 0.5) / steps)
            t1 = min(1.0, (k + 0.5) / steps)
            xs = (a[0] + d[0] * t0, a[0] + d[0] * t1)
            ys = (a[1] + d[1] * t0, a[1] + d[1] * t1)
            for i in self.query(min(xs), min(ys), max(xs), max(ys)):
                if i in seen:
                    continue
                seen.add(i)
                if _segment_hits_box(a, d, *self.boxes[i]):
                    return False
        return True


def _segment_hits_box(o, d, mn, mx):
    near, far = 0.0, 1.0
    for i in range(3):
        if abs(d[i]) < 1e-12:
            if o[i] <= mn[i] + 1e-6 or o[i] >= mx[i] - 1e-6:
                return False
            continue
        t1 = (mn[i] - o[i]) / d[i]
        t2 = (mx[i] - o[i]) / d[i]
        if t1 > t2:
            t1, t2 = t2, t1
        near = max(near, t1)
        far = min(far, t2)
        if near >= far - 1e-9:
            return False
    return True


# ---------------------------------------------------------------------------------------------
# Walk graph: every spot a standing player fits, linked by walking, stepping, jumping and falling.
# ---------------------------------------------------------------------------------------------
class WalkGraph:
    def __init__(self, m):
        self.m = m
        self.solids = m.solids()
        self.index = Grid2D(self.solids, 2.0)
        xs = [b[0][0] for b in self.solids] + [b[1][0] for b in self.solids]
        ys = [b[0][1] for b in self.solids] + [b[1][1] for b in self.solids]
        self.x0, self.y0 = min(xs), min(ys)
        self.nx = int((max(xs) - self.x0) / CELL)
        self.ny = int((max(ys) - self.y0) / CELL)
        self.nodes = []          # (ix, iy, z)
        self.at = {}             # (ix, iy) -> [node ids], sorted by z
        self._build_nodes()

    def centre(self, ix, iy):
        return self.x0 + (ix + 0.5) * CELL, self.y0 + (iy + 0.5) * CELL

    def column(self, x, y):
        """Boxes whose footprint overlaps a hull centred at (x, y) (strictly, like the collision)."""
        h = HULL_W / 2
        out = []
        for i in self.index.query(x - h, y - h, x + h, y + h):
            mn, mx = self.solids[i]
            if x + h > mn[0] + EPS and x - h < mx[0] - EPS and y + h > mn[1] + EPS and y - h < mx[1] - EPS:
                out.append(i)
        return out

    def clear(self, col, z0, z1):
        """No box of `col` overlaps the height range (z0, z1)."""
        for i in col:
            mn, mx = self.solids[i]
            if mn[2] < z1 - EPS and mx[2] > z0 + EPS:
                return False
        return True

    def _build_nodes(self):
        for ix in range(self.nx):
            for iy in range(self.ny):
                x, y = self.centre(ix, iy)
                col = self.column(x, y)
                if not col:
                    continue
                tops = sorted(set(round(self.solids[i][1][2], 4) for i in col))
                ids = []
                for z in tops:
                    if self.clear(col, z, z + HULL_H):
                        ids.append(len(self.nodes))
                        self.nodes.append((ix, iy, z))
                if ids:
                    self.at[(ix, iy)] = ids
        self.cols = {}

    def col_at(self, ix, iy):
        key = (ix, iy)
        c = self.cols.get(key)
        if c is None:
            c = self.cols[key] = self.column(*self.centre(ix, iy))
        return c

    def neighbours(self, nid):
        """(node, cost, kind) for every move from node nid. kind: walk / jump / fall."""
        ix, iy, z = self.nodes[nid]
        out = []
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            ids = self.at.get((ix + dx, iy + dy))
            if not ids:
                continue
            if dx and dy:   # diagonal: both side cells must let the hull through at this height
                ok = True
                for sx, sy in ((ix + dx, iy), (ix, iy + dy)):
                    if not self.clear(self.col_at(sx, sy), z + STEP_HEIGHT, z + HULL_H):
                        ok = False
                if not ok:
                    continue
            dist = CELL * (1.4142 if dx and dy else 1.0)
            col_b = self.col_at(ix + dx, iy + dy)
            walk = None
            for j in ids:
                zb = self.nodes[j][2]
                if zb <= z + STEP_HEIGHT + 1e-6:
                    walk = j
            if walk is not None:
                zb = self.nodes[walk][2]
                if zb >= z - 1e-6 or self.clear(col_b, z, z + HULL_H):
                    out.append((walk, dist, "walk" if zb >= z - STEP_HEIGHT - 1e-6 else "fall"))
            for j in ids:
                zb = self.nodes[j][2]
                if z + STEP_HEIGHT + 1e-6 < zb <= z + JUMP_REACH + 1e-6:
                    if self.clear(self.col_at(ix, iy), z, zb + HULL_H):
                        out.append((j, dist + 1.0, "jump"))
        return out

    def node_near(self, x, y, z, tol=0.5):
        ix = int((x - self.x0) / CELL)
        iy = int((y - self.y0) / CELL)
        best = None
        for j in self.at.get((ix, iy), ()):
            dz = abs(self.nodes[j][2] - z)
            if dz <= tol and (best is None or dz < best[0]):
                best = (dz, j)
        return None if best is None else best[1]

    def reach(self, starts, allow_jump=True):
        """Dijkstra from the start nodes: {node: path length}."""
        dist = {}
        heap = [(0.0, s) for s in starts]
        while heap:
            d, n = heapq.heappop(heap)
            if n in dist:
                continue
            dist[n] = d
            for j, c, kind in self.neighbours(n):
                if kind == "jump" and not allow_jump:
                    continue
                if j not in dist:
                    heapq.heappush(heap, (d + c, j))
        return dist


# ---------------------------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------------------------
def check_constants(errors):
    """The kit's movement numbers must match shared/constants.ts."""
    path = os.path.normpath(os.path.join(HERE, "..", "..", "shared", "constants.ts"))
    if not os.path.exists(path):
        return
    text = open(path, encoding="utf-8").read()
    for name, value in (("HULL_HALF_WIDTH", HULL_W / 2), ("HULL_HEIGHT", HULL_H), ("EYE_HEIGHT", EYE),
                        ("STEP_HEIGHT", STEP_HEIGHT)):
        key = "export const %s = " % name
        i = text.find(key)
        if i < 0:
            errors.append("shared/constants.ts has no %s" % name)
            continue
        got = float(text[i + len(key):].split(";")[0])
        if abs(got - value) > 1e-9:
            errors.append("mapkit %s %.3f differs from shared/constants.ts %.3f" % (name, value, got))


def verify(m, log=print):
    """Runs every automatic check on a map; raises VerifyError listing all failures."""
    tag = "[%s]" % m.id
    log("%s --- verification ---" % tag)
    errors = []
    check_constants(errors)
    boxes = m.boxes

    names = [b["name"] for b in boxes] + [v["name"] for v in m.visuals]
    if len(names) != len(set(names)):
        seen, dup = set(), set()
        for n in names:
            (dup if n in seen else seen).add(n)
        errors.append("duplicate box names: %s" % sorted(dup)[:10])
    for b in boxes:
        if b["category"] not in m.category_surface:
            errors.append("box %s: category %s has no surface" % (b["name"], b["category"]))
    for s in m.surfaces:
        if s not in TEXTURE_LIBRARY:
            errors.append("surface %s has no TEXTURE_LIBRARY entry" % s)
    for v in m.visuals:
        if v["surface"] not in m.surfaces:
            errors.append("visual %s: unknown surface %s" % (v["name"], v["surface"]))

    # Stairs: every flight climbs in rises <= MAX_STEP_RISE with treads >= MIN_TREAD.
    by_name = {b["name"]: b for b in boxes}
    for fl in m.flights:
        steps = [by_name[n] for n in fl["steps"]]
        tops = [fl["z0"]] + [s["mx"][2] for s in steps] + [fl["z1"]]
        rises = [round(tops[i + 1] - tops[i], 4) for i in range(len(tops) - 1)]
        for r in rises:
            if r > MAX_STEP_RISE + 1e-6 or r <= 0:
                errors.append("flight %s: bad rise %.3f" % (fl["name"], r))
        ax = 1 if fl["axis"] == "y" else 0
        for s in steps:
            tread = s["mx"][ax] - s["mn"][ax]
            width = s["mx"][1 - ax] - s["mn"][1 - ax]
            if tread < MIN_TREAD - 1e-6:
                errors.append("%s tread %.3f < %.2f" % (s["name"], tread, MIN_TREAD))
            if width < MIN_STAIR_WIDTH - 1e-6:
                errors.append("%s width %.3f < %.2f" % (s["name"], width, MIN_STAIR_WIDTH))
        log("%s flight %-10s %2d steps, %.2f -> %.2f m, max rise %.3f"
            % (tag, fl["name"], len(steps), fl["z0"], fl["z1"], max(rises)))

    # Narrow gaps: at every floor level, solids reaching into walking height must touch or leave
    # >= MIN_WALKWAY between them (no slots a player squeezes into, no false openings).
    levels = sorted(set(round(b["mx"][2], 3) for b in boxes if b["category"] in m.floor_categories))
    narrow = []
    for lv in levels:
        band = [b for b in boxes if b["category"] not in m.floor_categories
                and b["mn"][2] < lv + HULL_H - 1e-6 and b["mx"][2] > lv + 0.05]
        grid = Grid2D([(b["mn"], b["mx"]) for b in band], 2.0)
        for i, a in enumerate(band):
            cand = grid.query(a["mn"][0] - MIN_WALKWAY, a["mn"][1] - MIN_WALKWAY,
                              a["mx"][0] + MIN_WALKWAY, a["mx"][1] + MIN_WALKWAY)
            for j in cand:
                if j <= i:
                    continue
                b = band[j]
                if a["category"] in m.structure_categories and b["category"] in m.structure_categories:
                    continue
                d = rect_dist(a["mn"], a["mx"], b["mn"], b["mx"])
                if 1e-6 < d < MIN_WALKWAY - 1e-6:
                    narrow.append("level %.2f: %s <-> %s gap %.2f m" % (lv, a["name"], b["name"], d))
                if overlap3(a["mn"], a["mx"], b["mn"], b["mx"]):
                    narrow.append("%s overlaps %s" % (a["name"], b["name"]))
    errors.extend(sorted(set(narrow)))
    log("%s walkway gaps: levels %s, %d narrow gaps or overlaps" % (tag, levels, len(set(narrow))))

    # Walk graph: reachability, stuck spots, headroom, spawns, sites, path lengths.
    g = WalkGraph(m)
    log("%s walk graph: %d standing spots on a %.2f m grid" % (tag, len(g.nodes), CELL))
    spawn_nodes = {}
    for team, lst in m.spawns.items():
        if len(lst) != 5:
            errors.append("%s has %d spawns (need 5)" % (team, len(lst)))
        spawn_nodes[team] = []
        for i, ((x, y, z), _yaw) in enumerate(lst):
            n = g.node_near(x, y, z, 0.01)
            if n is None:
                errors.append("%s spawn %d at (%.2f, %.2f, %.2f) is not a free standing spot" % (team, i, x, y, z))
            else:
                spawn_nodes[team].append(n)
            for j in range(i + 1, len(lst)):
                (x2, y2, z2), _ = lst[j]
                if math.hypot(x - x2, y - y2) < 1.2 - 1e-6 and abs(z - z2) < 1:
                    errors.append("%s spawns %d/%d closer than 1.2 m" % (team, i, j))

    starts = spawn_nodes["ghosts"] + spawn_nodes["defenders"]
    reach = g.reach(starts) if starts else {}
    m._graph, m._reach = g, reach
    log("%s reachable: %d of %d spots" % (tag, len(reach), len(g.nodes)))

    # Stuck: every reachable spot must lead back to a spawn.
    if spawn_nodes["ghosts"]:
        rev = {}
        for n in reach:
            for j, _c, _k in g.neighbours(n):
                rev.setdefault(j, []).append(n)
        back = set(spawn_nodes["ghosts"])
        stack = list(back)
        while stack:
            n = stack.pop()
            for p in rev.get(n, ()):
                if p not in back:
                    back.add(p)
                    stack.append(p)
        stuck = [n for n in reach if n not in back]
        if stuck:
            ex = [(round(g.centre(*g.nodes[n][:2])[0], 2), round(g.centre(*g.nodes[n][:2])[1], 2), g.nodes[n][2])
                  for n in stuck[:5]]
            errors.append("%d reachable spots cannot get back to the ghost spawn (stuck), e.g. %s" % (len(stuck), ex))
        log("%s stuck spots: %d" % (tag, len(stuck)))
        if spawn_nodes["defenders"] and not any(n in reach for n in spawn_nodes["defenders"]):
            errors.append("defender spawn is not connected to the ghost spawn")

    # Headroom above every reachable spot.
    low = []
    for n in reach:
        ix, iy, z = g.nodes[n]
        if not g.clear(g.col_at(ix, iy), z, z + HEADROOM):
            x, y = g.centre(ix, iy)
            low.append((round(x, 2), round(y, 2), z))
    if low:
        errors.append("%d reachable spots have less than %.1f m headroom, e.g. %s" % (len(low), HEADROOM, low[:6]))
    log("%s headroom: %d reachable spots under %.1f m" % (tag, len(low), HEADROOM))

    # Visual-only geometry must stay out of the space players occupy.
    if m.visuals:
        vgrid = Grid2D([(v["mn"], v["mx"]) for v in m.visuals], 2.0)
        clipping = set()
        h = HULL_W / 2
        for n in reach:
            ix, iy, z = g.nodes[n]
            x, y = g.centre(ix, iy)
            for i in vgrid.query(x - h, y - h, x + h, y + h):
                v = m.visuals[i]
                if overlap3((x - h, y - h, z), (x + h, y + h, z + 1.95), v["mn"], v["mx"]):
                    clipping.add(v["name"])
        if clipping:
            errors.append("visual-only boxes intrude into player space: %s" % sorted(clipping)[:12])
        log("%s visual-only boxes: %d, %d intrude into player space" % (tag, len(m.visuals), len(clipping)))

    # Bomb sites reachable, and path lengths from each spawn.
    site_nodes = {}
    for name, (x0, y0), (x1, y1), z in m.sites:
        ids = []
        for n in reach:
            ix, iy, nz = g.nodes[n]
            x, y = g.centre(ix, iy)
            if x0 <= x <= x1 and y0 <= y <= y1 and z - 0.1 <= nz <= z + m.site_h:
                ids.append(n)
        site_nodes[name] = ids
        if not ids:
            errors.append("bomb site %s is not reachable" % name)
    lengths = {}
    for team, nodes in spawn_nodes.items():
        if not nodes:
            continue
        for allow_jump in (False, True):
            d = g.reach(nodes[2:3] or nodes[:1], allow_jump)
            for name, ids in site_nodes.items():
                best = min((d[n] for n in ids if n in d), default=None)
                lengths[(team, name, allow_jump)] = best
    for team in ("ghosts", "defenders"):
        for name, _a, _b, _z in m.sites:
            walk = lengths.get((team, name, False))
            jump = lengths.get((team, name, True))
            if walk is None:
                errors.append("%s cannot walk to site %s without jumping" % (team, name))
            log("%s path %-9s -> site %s: %s m walking, %s m with jumps"
                % (tag, team, name, "-" if walk is None else "%.1f" % walk, "-" if jump is None else "%.1f" % jump))
    m.path_lengths = lengths

    # Sightlines from ghost spawn eyes to defender spawn eyes (every map).
    eyes = {team: [(p[0], p[1], p[2] + EYE) for p, _ in lst] for team, lst in m.spawns.items()}
    seen_pairs = []
    for i, a in enumerate(eyes["ghosts"]):
        for j, b in enumerate(eyes["defenders"]):
            if g.index.segment_clear(a, b):
                seen_pairs.append((i, j, round(math.dist(a, b), 1)))
    if seen_pairs:
        errors.append("ghost spawn eyes see defender spawn eyes (ghost, defender, metres): %s" % seen_pairs)
    log("%s spawn sightlines: %d of %d ghost->defender eye pairs clear"
        % (tag, len(seen_pairs), len(eyes["ghosts"]) * len(eyes["defenders"])))

    # Longest clear sightline between standing eye points on a 1.5 m grid (when the map sets a limit).
    if m.max_sightline:
        pts = []
        step = int(round(1.5 / CELL))
        for n in reach:
            ix, iy, z = g.nodes[n]
            if ix % step == 0 and iy % step == 0:
                x, y = g.centre(ix, iy)
                pts.append((x, y, z + EYE))
        longest, worst = 0.0, None
        lim2 = (m.max_sightline * 0.8) ** 2
        for i in range(len(pts)):
            a = pts[i]
            for j in range(i + 1, len(pts)):
                b = pts[j]
                d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
                if d2 <= lim2 or d2 <= longest * longest:
                    continue
                if g.index.segment_clear(a, b):
                    longest, worst = math.sqrt(d2), (a, b)
        if worst:
            log("%s longest sightline %.1f m: (%.1f, %.1f, %.1f) -> (%.1f, %.1f, %.1f)"
                % ((tag, longest) + tuple(worst[0]) + tuple(worst[1])))
        if longest > m.max_sightline:
            errors.append("longest sightline %.1f m exceeds %.1f m" % (longest, m.max_sightline))
        m.longest_sightline = longest
        log("%s sightlines: %d eye points, longest %.1f m (limit %.1f)" % (tag, len(pts), longest, m.max_sightline))

    if errors:
        for e in errors:
            log("%s FAIL: %s" % (tag, e))
        raise VerifyError("%s: %d verification failure(s)" % (m.id, len(errors)))
    log("%s verification passed" % tag)
    return g


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: python tools/blender/mapkit.py <map id>")
    try:
        verify(load_map(sys.argv[1]))
    except VerifyError as exc:
        print(exc)
        sys.exit(1)
