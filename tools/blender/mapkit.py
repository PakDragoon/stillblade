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
import json
import math
import os
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
MAPS_DIR = os.path.join(HERE, "maps")

# Player and movement numbers, mirrored from shared/constants.ts (checked against it in verify()).
HULL_W = 0.6
HULL_H = 1.8
HULL_H_CROUCHED = 1.2
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
    "wh_paint": dict(src="plastered_wall_02_diff_1k.jpg", out="tex_wh_paint.webp", tile=2.0,
                     albedo=0.5, contrast=1.0, sat=0.15, detile=0.4, tint=(1.0, 1.0, 1.0)),
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
    "-": [[(0.08, 0.5), (0.5, 0.5)]],
}
GLYPH_ADVANCE = {"A": 0.86, "B": 0.86, "P": 0.8, "1": 0.72, "2": 0.78, ">": 0.95, "-": 0.62}


def text_quads(text, height, stroke=0.16, angle=0.0):
    """Quads [(u, v) x 4] for a string in a local frame: u to the right, v up, centred on (0, 0),
    rotated by `angle` degrees counter-clockwise (an arrow ">" with angle -90 points down).
    A space advances half a glyph."""
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
    ca, sa = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    out = []
    for q in quads:
        pts = [((u - width / 2) * height, (v - 0.5) * height) for u, v in q]
        out.append([(u * ca - v * sa, u * sa + v * ca) for u, v in pts])
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
        self.low_ceilings = []   # dicts: name, mn, mx, clearance, crouch (allowed low ceilings, see low_ceiling)
        self.max_sightline = None    # metres; None = not checked for this map
        self.route_gates = {}        # site -> [(label, (x0, y0, z0, x1, y1, z1))]: distinct ghost routes
        self.sun_scale = 0.40
        self.sky_scale = 2.6
        self.lightmap_size = 4096
        self.samples = 512
        self.max_glb_bytes = 1024 * 1024

    # ---- geometry --------------------------------------------------------------------------
    def box(self, name, category, mn, mx, tint=None, hide=(), group=None):
        """A collision box, drawn with its category's surface. `hide` lists faces that can never be
        seen ("top", "bottom", "+x", ...), or ("all",) for a solid drawn only by visual-only boxes
        inside it (racks, vehicles). Boxes sharing a `group` are pieces of one solid (the collision
        steps of an angled shape): the walkway-gap check does not compare them with each other."""
        mn = tuple(float(v) for v in mn)
        mx = tuple(float(v) for v in mx)
        if not all(a < b for a, b in zip(mn, mx)):
            raise ValueError("box %s has min >= max: %s %s" % (name, mn, mx))
        b = dict(name=name, category=category, mn=mn, mx=mx, tint=tint, hide=tuple(hide))
        if group is not None:
            b["group"] = group
        self.boxes.append(b)
        return name

    def visual(self, name, surface, mn, mx, tint=None, yaw=0.0, pitch=0.0, hide=()):
        """A visual-only box. With `yaw` (degrees, counter-clockwise seen from above) or `pitch`
        (degrees about the box's own X axis, applied first; positive tilts its +Y end up) the box
        (mn, mx) is turned about its centre: an oriented box, for angled shapes whose collision is a
        separate set of boxes. `hide` names faces of an oriented box (in its own frame: "top",
        "bottom", "+x", "-x", "+y", "-y") that can never be seen. Its mn/mx become the
        axis-aligned bounds of the turned box; the verifier tests it against players exactly."""
        mn = tuple(float(v) for v in mn)
        mx = tuple(float(v) for v in mx)
        if not all(a < b for a, b in zip(mn, mx)):
            raise ValueError("visual %s has min >= max: %s %s" % (name, mn, mx))
        if not yaw and not pitch:
            self.visuals.append(dict(name=name, surface=surface, mn=mn, mx=mx, tint=tint))
            return name
        centre = tuple((a + b) / 2 for a, b in zip(mn, mx))
        half = tuple((b - a) / 2 for a, b in zip(mn, mx))
        cy, sy = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
        cp, sp = math.cos(math.radians(pitch)), math.sin(math.radians(pitch))
        # columns: the box's own x, y, z axes in world space (pitch about x, then yaw about z)
        ax = (cy, sy, 0.0)
        ay = (-sy * cp, cy * cp, sp)
        az = (sy * sp, -cy * sp, cp)
        corners = []
        for x0, y0, z0 in ((mn[0], mn[1], mn[2]), (mx[0], mn[1], mn[2]), (mx[0], mx[1], mn[2]), (mn[0], mx[1], mn[2]),
                           (mn[0], mn[1], mx[2]), (mx[0], mn[1], mx[2]), (mx[0], mx[1], mx[2]), (mn[0], mx[1], mx[2])):
            u, v, w = x0 - centre[0], y0 - centre[1], z0 - centre[2]
            corners.append(tuple(centre[i] + u * ax[i] + v * ay[i] + w * az[i] for i in range(3)))
        bmn = tuple(min(c[i] for c in corners) for i in range(3))
        bmx = tuple(max(c[i] for c in corners) for i in range(3))
        self.visuals.append(dict(name=name, surface=surface, mn=bmn, mx=bmx, tint=tint, obb=True, centre=centre,
                                 half=half, axes=(ax, ay, az), corners=corners, hide=tuple(hide)))
        return name

    def flight(self, name, x0, x1, y0, direction, z0, z1, rise, tread, axis="y", base=None, category="stairs",
               hide=()):
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
                self.box(nm, category, (x0, lo, base), (x1, hi, top), hide=hide)
            else:
                self.box(nm, category, (lo, x0, base), (hi, x1, top), hide=hide)
            steps.append(nm)
        self.flights.append(dict(name=name, steps=steps, z0=z0, z1=z1, axis=axis))
        return y0 + direction * tread * (n - 1)

    # ---- gameplay --------------------------------------------------------------------------
    def spawn(self, team, x, y, z, yaw):
        self.spawns[team].append(((float(x), float(y), float(z)), float(yaw)))

    def low_ceiling(self, name, mn, mx, clearance, crouch=False):
        """An allowed low ceiling: reachable spots inside the box (mn, mx; feet heights inside its z
        range) need only `clearance` metres of headroom instead of HEADROOM. With crouch=True the
        verifier's walk graph uses the crouched hull there, so the space is passable only crouched
        (crouch openings); otherwise a standing player must still fit (clearance >= HULL_H)."""
        self.low_ceilings.append(dict(name=name, mn=tuple(float(v) for v in mn), mx=tuple(float(v) for v in mx),
                                      clearance=float(clearance), crouch=bool(crouch)))

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

    def floor_text(self, text, centre, z, height, colour, up=(0, 1), layer=2, stroke=0.16, angle=0.0):
        """Text painted on a floor; `up` is the direction (x, y) of the letters' tops."""
        ux, uy = up
        n = math.hypot(ux, uy)
        ux, uy = ux / n, uy / n
        rx, ry = uy, -ux                       # right = up rotated -90 deg (reads correctly from below)
        off = (0.006, 0.012, 0.018)[layer]
        for q in text_quads(text, height, stroke, angle):
            pts = [(centre[0] + rx * u + ux * v, centre[1] + ry * u + uy * v, z) for u, v in q]
            self.decal(pts, 2, 1, off, colour)

    def hazard_band(self, x0, y0, x1, y1, z, colour, width=0.35, stripe=0.3, gap=0.35, layer=1, skip_y=()):
        """Diagonal warning stripes painted in a band `width` wide just inside the rectangle's edges
        (a bomb site's border). Each stripe is a parallelogram with two edges on the band's edges, so it
        lies inside the band; the corners are left plain. `skip_y` lists floor seams (y values) a stripe
        must not cross, since a slanted decal has to sit on one face."""
        off = (0.006, 0.012, 0.018)[layer]
        pitch = stripe + gap

        def ok(ya, yb):
            return not any(ya - 1e-6 < s < yb + 1e-6 for s in skip_y)

        # along x (south and north edges)
        for yb, d in ((y0, 1), (y1, -1)):
            ya, yc = (yb, yb + width) if d > 0 else (yb - width, yb)
            x = x0 + width
            while x + stripe + width <= x1 - width + 1e-9:
                if ok(ya, yc):
                    pts = [(x, ya, z), (x + stripe, ya, z), (x + stripe + width, yc, z), (x + width, yc, z)]
                    self.decal(pts, 2, 1, off, colour)
                x += pitch
        # along y (west and east edges)
        for xb, d in ((x0, 1), (x1, -1)):
            xa, xc = (xb, xb + width) if d > 0 else (xb - width, xb)
            y = y0 + width
            while y + stripe + width <= y1 - width + 1e-9:
                if ok(y, y + stripe + width):
                    pts = [(xa, y, z), (xc, y + width, z), (xc, y + stripe + width, z), (xa, y + stripe, z)]
                    self.decal(pts, 2, 1, off, colour)
                y += pitch

    def wall_rect(self, centre, axis, sign, w, h, colour, layer=0):
        """Rectangle painted on a wall face whose outward normal is (axis, sign); `centre` on the face."""
        off = (0.008, 0.014, 0.02)[layer]
        right = self._wall_right(axis, sign)
        pts = []
        for u, v in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
            pts.append((centre[0] + right[0] * u, centre[1] + right[1] * u, centre[2] + v))
        self.decal(pts, axis, sign, off, colour)

    def wall_text(self, text, centre, axis, sign, height, colour, layer=1, stroke=0.16, angle=0.0):
        off = (0.008, 0.014, 0.02)[layer]
        right = self._wall_right(axis, sign)
        for q in text_quads(text, height, stroke, angle):
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
    """Spots a player fits, standing (HULL_H) or, inside the map's crouch zones (low_ceiling with
    crouch=True), crouched (HULL_H_CROUCHED). `crouch_only` holds the spots where only a crouched
    player fits; moves into, out of and between them are walking moves tested with the crouched hull,
    and no jump starts or lands there. A map without crouch zones gets exactly the standing graph."""

    def __init__(self, m):
        self.m = m
        self.crouch_zones = [z for z in getattr(m, "low_ceilings", ()) if z["crouch"]]
        self.crouch_only = set()
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

    def in_crouch_zone(self, x, y, z):
        for zn in self.crouch_zones:
            mn, mx = zn["mn"], zn["mx"]
            if mn[0] <= x <= mx[0] and mn[1] <= y <= mx[1] and mn[2] - 1e-6 <= z <= mx[2] + 1e-6:
                return True
        return False

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
                    elif self.crouch_zones and self.in_crouch_zone(x, y, z) and self.clear(col, z, z + HULL_H_CROUCHED):
                        self.crouch_only.add(len(self.nodes))
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
        """(node, cost, kind) for every move from node nid. kind: walk / jump / fall.
        A walking move that starts or ends on a crouch-only spot is tested with the crouched hull."""
        ix, iy, z = self.nodes[nid]
        out = []
        co = self.crouch_only
        crouched_here = nid in co

        def diag_ok(dx, dy, hh):
            # diagonal: both side cells must let the hull through at this height
            for sx, sy in ((ix + dx, iy), (ix, iy + dy)):
                if not self.clear(self.col_at(sx, sy), z + STEP_HEIGHT, z + hh):
                    return False
            return True

        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            ids = self.at.get((ix + dx, iy + dy))
            if not ids:
                continue
            diagonal = bool(dx and dy)
            if diagonal and not co and not diag_ok(dx, dy, HULL_H):
                continue
            dist = CELL * (1.4142 if diagonal else 1.0)
            col_b = self.col_at(ix + dx, iy + dy)
            walk = None
            for j in ids:
                zb = self.nodes[j][2]
                if zb <= z + STEP_HEIGHT + 1e-6:
                    walk = j
            if walk is not None:
                zb = self.nodes[walk][2]
                hh = HULL_H_CROUCHED if (crouched_here or walk in co) else HULL_H
                if (not diagonal or not co or diag_ok(dx, dy, hh)) and                         (zb >= z - 1e-6 or self.clear(col_b, z, z + hh)):
                    out.append((walk, dist, "walk" if zb >= z - STEP_HEIGHT - 1e-6 else "fall"))
            if crouched_here or (diagonal and co and not diag_ok(dx, dy, HULL_H)):
                continue
            for j in ids:
                zb = self.nodes[j][2]
                if j in co:
                    continue
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

    def reach(self, starts, allow_jump=True, blocked=None):
        """Dijkstra from the start nodes: {node: path length}. `blocked`: nodes never entered."""
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
                if blocked is not None and j in blocked:
                    continue
                if j not in dist:
                    heapq.heappush(heap, (d + c, j))
        return dist


# ---------------------------------------------------------------------------------------------
# Navigation graph for the server's bots (written into the map JSON as "nav").
#
# The walk graph's reachable spots (0.25 m grid) are grouped into NAV_CELLS x NAV_CELLS blocks
# (1 m); inside a block, spots joined by walking moves form one node, placed on the spot nearest
# their middle. Two nodes are linked when a fine move joins their blocks, and only if a player
# walking the straight line between the two node points stays on spots of the walk graph using
# moves of the graph (so a bot steering straight at the next node never cuts a corner or climbs
# a stair from its side). Edge kinds: 0 walk (level), 1 step (stairs or a small rise), 2 jump,
# 3 drop, 8 crouch (a walking link whose line passes a crouch-only spot: the bot holds crouch along
# it). Crouch is 8, not 4, because 4 (NAV_BOTH) is the "both ways" bit in the file; older map files
# never contain 8, so they read the same. Positions are feet positions in engine coordinates.
# ---------------------------------------------------------------------------------------------
NAV_CELLS = 4
NAV_KINDS = {"walk": 0, "step": 1, "jump": 2, "drop": 3, "crouch": 8}


def _trace_line(g, reach, a, b, kinds, visited=None):
    """Follows the straight line from fine node a to fine node b over graph moves; True if it arrives.
    `visited` (a list), when given, receives every fine node the line passes, a and b included."""
    ax, ay = g.centre(*g.nodes[a][:2])
    bx, by = g.centre(*g.nodes[b][:2])
    length = math.hypot(bx - ax, by - ay)
    steps = max(1, int(length / (CELL * 0.4)) + 1)
    cur = a
    if visited is not None:
        visited.append(a)
    for k in range(1, steps + 1):
        t = k / steps
        x, y = ax + (bx - ax) * t, ay + (by - ay) * t
        cell = (int((x - g.x0) / CELL), int((y - g.y0) / CELL))
        ix, iy, z = g.nodes[cur]
        if cell == (ix, iy):
            continue
        best = None
        for j, _c, kind in g.neighbours(cur):
            jx, jy, jz = g.nodes[j]
            if (jx, jy) != cell or j not in reach or kind not in kinds:
                continue
            # Prefer level moves, then the height nearest the target's (several floors share a cell).
            score = (0 if kind == "walk" else 1, abs(jz - g.nodes[b][2]))
            if best is None or score < best[0]:
                best = (score, j)
        if best is None:
            return False
        cur = best[1]
        if visited is not None:
            visited.append(cur)
    if visited is not None:
        visited.append(b)
    return cur == b or abs(g.nodes[cur][2] - g.nodes[b][2]) < 1e-3


def nav_graph(m):
    """The bots' navigation graph from the verified walk graph (`verify` must have run)."""
    g, reach = m._graph, m._reach
    blocks = {}
    for n in reach:
        ix, iy, _z = g.nodes[n]
        blocks.setdefault((ix // NAV_CELLS, iy // NAV_CELLS), []).append(n)
    comp = {}
    nodes = []          # (fine node of the representative, block key)
    for key in sorted(blocks):
        members = set(blocks[key])
        for n in sorted(members):
            if n in comp:
                continue
            group, stack = [], [n]
            comp[n] = len(nodes)
            while stack:
                c = stack.pop()
                group.append(c)
                for j, _cost, kind in g.neighbours(c):
                    if kind == "walk" and j in members and j not in comp:
                        comp[j] = len(nodes)
                        stack.append(j)
            cx = sum(g.centre(*g.nodes[c][:2])[0] for c in group) / len(group)
            cy = sum(g.centre(*g.nodes[c][:2])[1] for c in group) / len(group)
            cz = sum(g.nodes[c][2] for c in group) / len(group)
            rep = min(group, key=lambda c: (math.hypot(g.centre(*g.nodes[c][:2])[0] - cx,
                                                      g.centre(*g.nodes[c][:2])[1] - cy),
                                           abs(g.nodes[c][2] - cz), c))
            nodes.append(rep)
    links = {}
    for n in reach:
        a = comp[n]
        for j, _cost, kind in g.neighbours(n):
            b = comp.get(j)
            if b is None or b == a:
                continue
            # A fall of up to a step's height is still a walk; anything more is a drop.
            if kind == "fall":
                kind = "drop"
            prev = links.get((a, b))
            order = ("walk", "drop", "jump")
            if prev is None or order.index(kind) < order.index(prev):
                links[(a, b)] = kind
    edges = []
    dropped = 0
    co = g.crouch_only
    for (a, b), kind in sorted(links.items()):
        ra, rb = nodes[a], nodes[b]
        allowed = {"walk"} if kind == "walk" else {"walk", "fall", "jump"}
        visited = [] if co else None
        if not _trace_line(g, reach, ra, rb, allowed, visited):
            dropped += 1
            continue
        crouch = bool(co) and any(n in co for n in visited)
        if crouch and kind != "walk":
            dropped += 1        # no jumping or dropping through a crouch-only space
            continue
        dz = g.nodes[rb][2] - g.nodes[ra][2]
        if kind == "walk":
            kind = "crouch" if crouch else ("walk" if abs(dz) < 0.05 else "step")
        edges.append((a, b, NAV_KINDS[kind]))
    pts = []
    for rep in nodes:
        ix, iy, z = g.nodes[rep]
        x, y = g.centre(ix, iy)
        # Engine coordinates: (x, z, -y).
        pts.append([round(x, 3), round(z, 3), round(-y, 3) + 0.0])
    return {"cell": CELL * NAV_CELLS, "nodes": pts, "edges": [list(e) for e in edges]}, comp, dropped


NAV_BOTH = 4    # added to an edge kind in the file: the link goes both ways


def nav_json(nav):
    """The "nav" member as written into the map JSON: flat arrays, a link that goes both ways with the
    same kind written once with NAV_BOTH added, a few values per line to keep the file diffable."""
    kinds = {(a, b): k for a, b, k in nav["edges"]}
    flat_edges = []
    for (a, b), k in sorted(kinds.items()):
        back = kinds.get((b, a))
        if back == k:
            if a < b:
                flat_edges += [a, b, k + NAV_BOTH]
            continue
        flat_edges += [a, b, k]
    flat_nodes = [c for p in nav["nodes"] for c in p]

    def rows(values, per):
        lines = []
        for i in range(0, len(values), per):
            lines.append("      " + ", ".join(json.dumps(v) for v in values[i:i + per]))
        return "[\n" + ",\n".join(lines) + "\n    ]"
    return ('{\n    "cell": %s,\n    "nodes": %s,\n    "edges": %s\n  }'
            % (json.dumps(nav["cell"]), rows(flat_nodes, 24), rows(flat_edges, 30)))


def nav_reach(nav, starts):
    """Node ids reachable over the nav graph's directed edges from `starts`."""
    out = {}
    for a, b, _k in nav["edges"]:
        out.setdefault(a, []).append(b)
    seen = set(starts)
    stack = list(starts)
    while stack:
        n = stack.pop()
        for b in out.get(n, ()):
            if b not in seen:
                seen.add(b)
                stack.append(b)
    return seen


def obb_overlaps_aabb(v, amn, amx, eps=1e-6):
    """True if the oriented visual box v (MapDef.visual with yaw/pitch) and the axis-aligned box
    (amn, amx) share volume (touching does not count): separating axis test over the 15 axes."""
    ac = [(amn[i] + amx[i]) / 2 for i in range(3)]
    ah = [(amx[i] - amn[i]) / 2 for i in range(3)]
    oc, oh, oa = v["centre"], v["half"], v["axes"]
    d = [oc[i] - ac[i] for i in range(3)]
    world = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
    axes = list(world) + list(oa)
    for u in world:
        for w in oa:
            c = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
            if c[0] * c[0] + c[1] * c[1] + c[2] * c[2] > 1e-12:
                axes.append(c)
    for L in axes:
        ra = sum(ah[i] * abs(L[i]) for i in range(3))
        rb = sum(oh[k] * abs(sum(oa[k][i] * L[i] for i in range(3))) for k in range(3))
        dist = abs(sum(d[i] * L[i] for i in range(3)))
        n = math.sqrt(sum(c * c for c in L))
        if dist >= ra + rb - eps * n:
            return False
    return True


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
                        ("STEP_HEIGHT", STEP_HEIGHT), ("HULL_HEIGHT_CROUCHED", HULL_H_CROUCHED)):
        key = "export const %s = " % name
        i = text.find(key)
        if i < 0:
            errors.append("shared/constants.ts has no %s" % name)
            continue
        got = float(text[i + len(key):].split(";")[0])
        if abs(got - value) > 1e-9:
            errors.append("mapkit %s %.3f differs from shared/constants.ts %.3f" % (name, value, got))


def _merge_runs(boxes):
    """Footprints of boxes merged where they continue each other in a straight run with the same
    cross-section (the pieces of one wall around its openings, the steps of one flight), so the gap
    check sees one wall instead of a sill sitting next to its own wall."""
    rects = [dict(name=b["name"], cats={b["category"]}, mn=list(b["mn"]), mx=list(b["mx"]),
                  groups={b["group"]} if b.get("group") else set()) for b in boxes]
    for k in (1, 0):                      # merge runs along Y, then along X
        o = 1 - k
        rects.sort(key=lambda r: (round(r["mn"][o], 6), round(r["mx"][o], 6), r["mn"][k]))
        out = []
        for r in rects:
            p = out[-1] if out else None
            if p and abs(p["mn"][o] - r["mn"][o]) < 1e-6 and abs(p["mx"][o] - r["mx"][o]) < 1e-6                     and r["mn"][k] <= p["mx"][k] + 1e-6:
                p["mx"][k] = max(p["mx"][k], r["mx"][k])
                p["mn"][2] = min(p["mn"][2], r["mn"][2])
                p["mx"][2] = max(p["mx"][2], r["mx"][2])
                p["cats"] |= r["cats"]
                p["groups"] |= r["groups"]
                if "+" not in p["name"]:
                    p["name"] += "+"
            else:
                out.append(r)
        rects = out
    return rects


def _gap_filled(a, b, band, grid, ia, ib):
    """True if other solids at this level fill the space between boxes a and b (e.g. the full-height
    piece of a wall between a window sill and the next wall), so there is no slot to walk into."""
    lo, hi = [], []
    for k in (0, 1):
        if a["mx"][k] <= b["mn"][k]:
            lo.append(a["mx"][k]); hi.append(b["mn"][k])
        elif b["mx"][k] <= a["mn"][k]:
            lo.append(b["mx"][k]); hi.append(a["mn"][k])
        else:
            lo.append(max(a["mn"][k], b["mn"][k])); hi.append(min(a["mx"][k], b["mx"][k]))
    cand = [c for c in grid.query(lo[0] - 0.01, lo[1] - 0.01, hi[0] + 0.01, hi[1] + 0.01) if c not in (ia, ib)]
    n = 5
    for u in range(n):
        for v in range(n):
            x = lo[0] + (hi[0] - lo[0]) * (u + 0.5) / n
            y = lo[1] + (hi[1] - lo[1]) * (v + 0.5) / n
            if not any(band[c]["mn"][0] - 1e-6 <= x <= band[c]["mx"][0] + 1e-6 and
                       band[c]["mn"][1] - 1e-6 <= y <= band[c]["mx"][1] + 1e-6 for c in cand):
                return False
    return True


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
        raw = [b for b in boxes if b["category"] not in m.floor_categories
               and b["mn"][2] < lv + HULL_H - 1e-6 and b["mx"][2] > lv + 0.05]
        for i, a in enumerate(raw):
            for b in raw[i + 1:]:
                if overlap3(a["mn"], a["mx"], b["mn"], b["mx"]):
                    if a.get("group") and a.get("group") == b.get("group"):
                        continue
                    narrow.append("%s overlaps %s" % (a["name"], b["name"]))
        band = _merge_runs(raw)
        grid = Grid2D([(b["mn"], b["mx"]) for b in band], 2.0)
        for i, a in enumerate(band):
            cand = grid.query(a["mn"][0] - MIN_WALKWAY, a["mn"][1] - MIN_WALKWAY,
                              a["mx"][0] + MIN_WALKWAY, a["mx"][1] + MIN_WALKWAY)
            for j in cand:
                if j <= i:
                    continue
                b = band[j]
                if a["cats"] <= m.structure_categories and b["cats"] <= m.structure_categories:
                    continue
                if a["groups"] & b["groups"]:
                    continue
                d = rect_dist(a["mn"], a["mx"], b["mn"], b["mx"])
                if 1e-6 < d < MIN_WALKWAY - 1e-6 and not _gap_filled(a, b, band, grid, i, j):
                    narrow.append("level %.2f: %s <-> %s gap %.2f m" % (lv, a["name"], b["name"], d))
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

    # Every flight is climbable on foot: some spot on the first step has a walking move up from the
    # floor below it, and some spot on the top step a walking move onto the floor above. (A flight
    # whose bottom step is against a wall can only be entered from the side, where the hull spans
    # two steps: too high to step, only jumpable.)
    by_box = {bx["name"]: bx for bx in boxes}

    def on_box(bx):
        out = []
        h = HULL_W / 2      # a hull stands on a step while overhanging its edge by up to this
        for ix in range(int((bx["mn"][0] - h - g.x0) / CELL), int((bx["mx"][0] + h - g.x0) / CELL) + 1):
            for iy in range(int((bx["mn"][1] - h - g.y0) / CELL), int((bx["mx"][1] + h - g.y0) / CELL) + 1):
                x, y = g.centre(ix, iy)
                if bx["mn"][0] - h < x < bx["mx"][0] + h and bx["mn"][1] - h < y < bx["mx"][1] + h:
                    out += [n for n in g.at.get((ix, iy), ()) if abs(g.nodes[n][2] - bx["mx"][2]) < 1e-3]
        return out

    for fl in m.flights:
        first, top = by_box[fl["steps"][0]], by_box[fl["steps"][-1]]
        up = any(abs(g.nodes[j][2] - fl["z0"]) < 1e-3 and any(k == n and kind == "walk" for k, _c, kind in g.neighbours(j))
                 for n in on_box(first) for j, _c, _k in g.neighbours(n))
        off = any(abs(g.nodes[j][2] - fl["z1"]) < 1e-3 and kind == "walk"
                  for n in on_box(top) for j, _c, kind in g.neighbours(n))
        if not (up and off):
            errors.append("flight %s cannot be climbed on foot (%s)" % (fl["name"], "bottom step" if not up else "top step"))
    log("%s flights climbable on foot: %d checked" % (tag, len(m.flights)))

    # Headroom above every reachable spot: HEADROOM, or a low-ceiling zone's own clearance inside it.
    zones = getattr(m, "low_ceilings", [])

    def zone_of(x, y, z):
        for k, zn in enumerate(zones):
            mn, mx = zn["mn"], zn["mx"]
            if mn[0] <= x <= mx[0] and mn[1] <= y <= mx[1] and mn[2] - 1e-6 <= z <= mx[2] + 1e-6:
                return k
        return None

    def clearance(col, z, limit):
        top = limit
        for i in col:
            mn, mx = g.solids[i]
            if mx[2] > z + EPS and mn[2] < top:
                top = max(z, mn[2])
        return top - z

    low = []
    zone_spots = [[] for _ in zones]
    for n in reach:
        ix, iy, z = g.nodes[n]
        x, y = g.centre(ix, iy)
        col = g.col_at(ix, iy)
        k = zone_of(x, y, z) if zones else None
        if k is None:
            if not g.clear(col, z, z + HEADROOM):
                low.append((round(x, 2), round(y, 2), z))
            continue
        c = clearance(col, z, z + HEADROOM)
        zone_spots[k].append(c)
        if c < zones[k]["clearance"] - 1e-6:
            errors.append("low-ceiling zone %s: spot (%.2f, %.2f, %.2f) has %.2f m, under its %.2f m"
                          % (zones[k]["name"], x, y, z, c, zones[k]["clearance"]))
    if low:
        errors.append("%d reachable spots have less than %.1f m headroom, e.g. %s" % (len(low), HEADROOM, low[:6]))
    log("%s headroom: %d reachable spots under %.1f m%s" % (tag, len(low), HEADROOM,
                                                           " outside the low-ceiling zones" if zones else ""))
    for k, zn in enumerate(zones):
        cs = zone_spots[k]
        if not any(c < HEADROOM - 1e-6 for c in cs):
            errors.append("low-ceiling zone %s covers no reachable spot under %.1f m (remove it)" % (zn["name"], HEADROOM))
        if not zn["crouch"] and zn["clearance"] < HULL_H - 1e-6:
            errors.append("low-ceiling zone %s: %.2f m is under a standing player; mark it crouch" % (zn["name"], zn["clearance"]))
        crouch_spots = sum(1 for c in cs if c < HULL_H - 1e-6)
        log("%s low ceiling %-22s %s: %d reachable spots, %d under %.1f m, lowest %.2f m (allowed %.2f), %d crouch-only"
            % (tag, zn["name"], "crouch" if zn["crouch"] else "standing", len(cs),
               sum(1 for c in cs if c < HEADROOM - 1e-6), HEADROOM, min(cs) if cs else 0.0, zn["clearance"], crouch_spots))

    # Visual-only geometry must stay out of the space players occupy (a crouched hull on crouch-only
    # spots; oriented boxes are tested exactly).
    if m.visuals:
        vgrid = Grid2D([(v["mn"], v["mx"]) for v in m.visuals], 2.0)
        clipping = set()
        h = HULL_W / 2
        for n in reach:
            ix, iy, z = g.nodes[n]
            x, y = g.centre(ix, iy)
            top = z + (HULL_H_CROUCHED if n in g.crouch_only else 1.95)
            for i in vgrid.query(x - h, y - h, x + h, y + h):
                v = m.visuals[i]
                if overlap3((x - h, y - h, z), (x + h, y + h, top), v["mn"], v["mx"]):
                    if not v.get("obb") or obb_overlaps_aabb(v, (x - h, y - h, z), (x + h, y + h, top)):
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

    # The bots' navigation graph: every spawn must reach every site over it, and back.
    nav, comp, dropped_links = nav_graph(m)
    m.nav = nav
    rev_nav = {"edges": [[b, a, k] for a, b, k in nav["edges"]]}
    for team, nodes in spawn_nodes.items():
        starts = [comp[n] for n in nodes if n in comp]
        fwd = nav_reach(nav, starts)
        back = nav_reach(rev_nav, starts)
        for name, ids in site_nodes.items():
            sids = set(comp[n] for n in ids if n in comp)
            if not sids & fwd:
                errors.append("nav graph: %s spawn cannot reach site %s" % (team, name))
            if not sids & back:
                errors.append("nav graph: site %s cannot get back to the %s spawn" % (name, team))
    all_starts = [comp[n] for ns in spawn_nodes.values() for n in ns if n in comp]
    orphans = len(nav["nodes"]) - len(nav_reach(nav, all_starts))
    kinds = {k: 0 for k in NAV_KINDS.values()}
    for _a, _b, k in nav["edges"]:
        kinds[k] += 1
    log("%s nav graph: %d nodes, %d edges (walk %d, step %d, jump %d, drop %d%s), %d links refused by the line test, "
        "%d nodes not reachable from a spawn" % (tag, len(nav["nodes"]), len(nav["edges"]), kinds[0], kinds[1],
                                                 kinds[2], kinds[3],
                                                 (", crouch %d" % kinds[8]) if g.crouch_only else "",
                                                 dropped_links, orphans))

    # Distinct routes: each gate alone must connect the ghost spawn to the site, and closing every
    # gate must cut the site off (so the gates really are separate ways in).
    def in_gate(n, box):
        ix, iy, z = g.nodes[n]
        x, y = g.centre(ix, iy)
        return box[0] <= x <= box[3] and box[1] <= y <= box[4] and box[2] <= z <= box[5]
    for site_name, gates in m.route_gates.items():
        ids = set(site_nodes.get(site_name, []))
        gate_nodes = [set(n for n in reach if in_gate(n, box)) for _label, box in gates]
        for k, (label, _box) in enumerate(gates):
            if not gate_nodes[k]:
                errors.append("route gate %s / %s covers no reachable spot" % (site_name, label))
                continue
            closed = set().union(*[gn for i, gn in enumerate(gate_nodes) if i != k])
            d = g.reach(spawn_nodes["ghosts"][2:3], True, closed)
            best = min((d[n] for n in ids if n in d), default=None)
            if best is None:
                errors.append("site %s: no route through %s alone" % (site_name, label))
            log("%s route to %s via %-42s %s" % (tag, site_name, label, "-" if best is None else "%.1f m" % best))
        all_closed = set().union(*gate_nodes) if gate_nodes else set()
        d = g.reach(spawn_nodes["ghosts"][2:3], True, all_closed)
        if any(n in d for n in ids):
            errors.append("site %s is reachable with every route gate closed (routes not distinct)" % site_name)

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
