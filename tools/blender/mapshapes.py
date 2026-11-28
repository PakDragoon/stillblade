"""
Plane geometry for map definitions (plain Python, no bpy): turning angled or curved shapes into the
axis-aligned collision boxes the game uses. Used by tools/blender/maps/<id>.py; mapkit.py verifies
whatever comes out.

All shapes are in authoring metres (X, Y). A rectangle is (x0, y0, x1, y1) with x0 < x1, y0 < y1;
a polygon is a list of (x, y).
"""

import math


def turned_rect(cx, cy, length, width, angle):
    """Corners of a length x width rectangle centred on (cx, cy), its length turned `angle` degrees
    counter-clockwise from +X."""
    a = math.radians(angle)
    ux, uy = math.cos(a), math.sin(a)
    hl, hw = length / 2, width / 2
    return [(cx + ux * hl - uy * hw, cy + uy * hl + ux * hw), (cx - ux * hl - uy * hw, cy - uy * hl + ux * hw),
            (cx - ux * hl + uy * hw, cy - uy * hl - ux * hw), (cx + ux * hl + uy * hw, cy + uy * hl - ux * hw)]


def segment_rect(a, b, off0, off1, ext0=0.0, ext1=0.0):
    """Corners of the strip beside the segment a -> b, between offsets off0 and off1 measured to the
    segment's right (negative: to its left), lengthened by ext0 before a and ext1 after b."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dy)
    ux, uy = dx / ln, dy / ln
    rx, ry = uy, -ux
    p0 = (a[0] - ux * ext0, a[1] - uy * ext0)
    p1 = (b[0] + ux * ext1, b[1] + uy * ext1)
    return [(p0[0] + rx * off0, p0[1] + ry * off0), (p1[0] + rx * off0, p1[1] + ry * off0),
            (p1[0] + rx * off1, p1[1] + ry * off1), (p0[0] + rx * off1, p0[1] + ry * off1)]


def rect_frame(corners):
    """(centre x, centre y, length, width, angle) of a rectangle given by 4 corners in order, length
    along the first edge."""
    (x0, y0), (x1, y1), (_x2, _y2), (x3, y3) = corners
    cx = sum(c[0] for c in corners) / 4
    cy = sum(c[1] for c in corners) / 4
    return cx, cy, math.hypot(x1 - x0, y1 - y0), math.hypot(x3 - x0, y3 - y0), math.degrees(math.atan2(y1 - y0, x1 - x0))


def signed_area(poly):
    return 0.5 * sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
                     for i in range(len(poly)))


def _clip(poly, axis, lo, hi):
    """Convex polygon clipped to lo <= coordinate[axis] <= hi."""
    def cut(pts, keep, edge):
        out = []
        n = len(pts)
        for i in range(n):
            p, q = pts[i], pts[(i + 1) % n]
            ip, iq = keep(p), keep(q)
            if ip:
                out.append(p)
            if ip != iq:
                t = (edge - p[axis]) / (q[axis] - p[axis])
                out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
        return out
    pts = cut(poly, lambda p: p[axis] >= lo, lo)
    if pts:
        pts = cut(pts, lambda p: p[axis] <= hi, hi)
    return pts


def main_angle(poly):
    """Angle (0..90 degrees) between +X or +Y and the polygon's longest edge, and the axis to cut
    strips across (0 = strips are X ranges, 1 = strips are Y ranges)."""
    best, ang = -1.0, 0.0
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        if ln > best:
            best, ang = ln, math.degrees(math.atan2(abs(b[1] - a[1]), abs(b[0] - a[0])))
    return (ang, 0) if ang <= 45 else (90 - ang, 1)


def cover(polys, overhang=0.25, max_strip=1.0, min_strip=0.25, axis=None, strip=None):
    """Axis-aligned rectangles, none overlapping another, that together contain every convex polygon
    in `polys`. The union is cut into strips across `axis` (chosen from the first polygon's longest
    edge when None); each strip becomes one rectangle per run of covered space. The strip width keeps
    the corner a rectangle adds beyond a sloping edge under `overhang` (between min_strip and max_strip)."""
    ang, ax = main_angle(polys[0])
    if axis is not None:
        ax = axis
    if strip is None:
        t = math.tan(math.radians(ang))
        strip = max_strip if t < 1e-6 else min(max_strip, max(min_strip, overhang / t))
    lo = min(p[ax] for poly in polys for p in poly)
    hi = max(p[ax] for poly in polys for p in poly)
    n = max(1, int(math.ceil((hi - lo) / strip - 1e-9)))
    step = (hi - lo) / n
    other = 1 - ax
    out = []
    for k in range(n):
        a, b = lo + step * k, (lo + step * (k + 1)) if k < n - 1 else hi
        spans = []
        for poly in polys:
            pts = _clip(poly, ax, a, b)
            if len(pts) >= 2:
                spans.append([min(p[other] for p in pts), max(p[other] for p in pts)])
        spans.sort()
        merged = []
        for s in spans:
            if merged and s[0] <= merged[-1][1] + 1e-9:
                merged[-1][1] = max(merged[-1][1], s[1])
            else:
                merged.append(s)
        for s0, s1 in merged:
            if s1 - s0 < 1e-6:
                continue
            out.append((a, s0, b, s1) if ax == 0 else (s0, a, s1, b))
    return out


def union_rects(rects):
    """The union of axis-aligned rectangles as disjoint rectangles (row runs merged downward)."""
    xs = sorted(set([r[0] for r in rects] + [r[2] for r in rects]))
    ys = sorted(set([r[1] for r in rects] + [r[3] for r in rects]))
    filled = set()
    for i in range(len(xs) - 1):
        cx = (xs[i] + xs[i + 1]) / 2
        for j in range(len(ys) - 1):
            cy = (ys[j] + ys[j + 1]) / 2
            if any(r[0] < cx < r[2] and r[1] < cy < r[3] for r in rects):
                filled.add((i, j))
    return _merge_cells(filled, xs, ys)


def _merge_cells(filled, xs, ys):
    runs_by_row = []
    for j in range(len(ys) - 1):
        runs, i = [], 0
        while i < len(xs) - 1:
            if (i, j) in filled:
                k = i
                while k + 1 < len(xs) - 1 and (k + 1, j) in filled:
                    k += 1
                runs.append((i, k))
                i = k + 1
            else:
                i += 1
        runs_by_row.append(runs)
    out, open_ = [], {}
    for j, runs in enumerate(runs_by_row):
        nxt = {}
        for run in runs:
            nxt[run] = open_.pop(run, j)
        for run, j0 in open_.items():
            out.append((xs[run[0]], ys[j0], xs[run[1] + 1], ys[j]))
        open_ = nxt
    for run, j0 in open_.items():
        out.append((xs[run[0]], ys[j0], xs[run[1] + 1], ys[len(ys) - 1]))
    return sorted(out, key=lambda r: (r[1], r[0]))


def rectilinear_rects(poly):
    """A polygon whose edges all run along X or Y, as disjoint rectangles."""
    xs = sorted(set(p[0] for p in poly))
    ys = sorted(set(p[1] for p in poly))
    filled = set()
    for i in range(len(xs) - 1):
        cx = (xs[i] + xs[i + 1]) / 2
        for j in range(len(ys) - 1):
            if point_in_poly((cx, (ys[j] + ys[j + 1]) / 2), poly):
                filled.add((i, j))
    return _merge_cells(filled, xs, ys)


def point_in_poly(p, poly):
    x, y = p
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def _seg_hits_rect(a, b, r):
    """Segment a-b passes through the open rectangle r (Liang-Barsky)."""
    t0, t1 = 0.0, 1.0
    d = (b[0] - a[0], b[1] - a[1])
    for k, lo, hi in ((0, r[0], r[2]), (1, r[1], r[3])):
        if abs(d[k]) < 1e-12:
            if not lo < a[k] < hi:
                return False
            continue
        u0, u1 = (lo - a[k]) / d[k], (hi - a[k]) / d[k]
        if u0 > u1:
            u0, u1 = u1, u0
        t0, t1 = max(t0, u0), min(t1, u1)
        if t0 >= t1 - 1e-12:
            return False
    return True


def rect_meets_poly(r, poly, eps=1e-6):
    """The open rectangle r and the polygon's inside share some area (touching does not count)."""
    s = (r[0] + eps, r[1] + eps, r[2] - eps, r[3] - eps)
    if point_in_poly(((s[0] + s[2]) / 2, (s[1] + s[3]) / 2), poly):
        return True
    for c in ((s[0], s[1]), (s[2], s[1]), (s[2], s[3]), (s[0], s[3])):
        if point_in_poly(c, poly):
            return True
    for p in poly:
        if s[0] < p[0] < s[2] and s[1] < p[1] < s[3]:
            return True
    n = len(poly)
    return any(_seg_hits_rect(poly[i], poly[(i + 1) % n], s) for i in range(n))


def raster(window, cell, keep):
    """Cells of `cell` metres over the rectangle `window` for which keep(cell rectangle) is true,
    merged into disjoint rectangles."""
    nx = int(round((window[2] - window[0]) / cell))
    ny = int(round((window[3] - window[1]) / cell))
    xs = [window[0] + cell * i for i in range(nx + 1)]
    ys = [window[1] + cell * j for j in range(ny + 1)]
    filled = set()
    for i in range(nx):
        for j in range(ny):
            if keep((xs[i], ys[j], xs[i + 1], ys[j + 1])):
                filled.add((i, j))
    return _merge_cells(filled, xs, ys)


def subtract(r, hole):
    """Rectangle r minus rectangle `hole`, as up to four rectangles."""
    if hole[0] >= r[2] or hole[2] <= r[0] or hole[1] >= r[3] or hole[3] <= r[1]:
        return [r]
    out = []
    if hole[1] > r[1]:
        out.append((r[0], r[1], r[2], hole[1]))
    if hole[3] < r[3]:
        out.append((r[0], hole[3], r[2], r[3]))
    y0, y1 = max(r[1], hole[1]), min(r[3], hole[3])
    if hole[0] > r[0]:
        out.append((r[0], y0, hole[0], y1))
    if hole[2] < r[2]:
        out.append((hole[2], y0, r[2], y1))
    return out


# =============================================================================================
# Prop models: visual-only geometry built from boxes (MapDef.visual), for any map.
#
# A model is built in a Frame: the box (mn, mx) it fills, normally the prop's own collision box
# (drawn with hide=("all",) so only the model shows). Everything a model adds stays inside that box,
# so it never reaches into the space players stand in, and what players see matches what stops them
# within a few centimetres. Coordinates in a frame: u along the prop's length (0 at its back, L at its
# front), v across it (0..W), z up from its base. Surfaces are passed in a dict `S` with the keys a
# model needs (e.g. S["paint"], S["metal"]), so a map chooses its own materials.
# =============================================================================================
DARK = (0.18, 0.18, 0.19)
RUBBER = (0.11, 0.11, 0.12)
GLASS = (0.10, 0.13, 0.16)
CHROME = (0.55, 0.56, 0.58)
LAMP_WHITE = (0.95, 0.93, 0.85)
LAMP_RED = (0.6, 0.08, 0.06)
LAMP_AMBER = (0.9, 0.55, 0.1)


def cylinder(m, name, surface, c, r, length, axis, sides=10, tint=None, lm=1.0, caps=(True, True), t=None):
    """A cylinder of `sides` flat facets (oriented visual boxes) around centre c, along "x", "y" or "z",
    `length` long, radius r to the outside of the facets. caps: (start, end) discs made of three boxes.
    Returns the number of boxes added."""
    t = t or min(0.05, r * 0.3)
    w = 2.0 * r * math.tan(math.pi / sides) * 1.03
    n = 0
    for k in range(sides):
        th = 360.0 * (k + 0.5) / sides
        a = math.radians(th)
        if axis == "x":
            nrm = (0.0, -math.sin(a), math.cos(a))
            half, yaw, pitch, hide = (length / 2, w / 2, t / 2), 0.0, th, ("bottom", "+y", "-y")
        elif axis == "y":
            nrm = (math.sin(a), 0.0, math.cos(a))
            half, yaw, pitch, hide = (length / 2, w / 2, t / 2), 90.0, th, ("bottom", "+y", "-y")
        else:
            nrm = (-math.sin(a), math.cos(a), 0.0)
            half, yaw, pitch, hide = (w / 2, t / 2, length / 2), th, 0.0, ("-y", "+x", "-x")
        cc = tuple(c[i] + (r - t / 2) * nrm[i] for i in range(3))
        m.visual("%s_f%02d" % (name, k), surface, tuple(cc[i] - half[i] for i in range(3)),
                 tuple(cc[i] + half[i] for i in range(3)), tint, yaw=yaw, pitch=pitch, hide=hide, lm=lm)
        n += 1
    ri = r * math.cos(math.pi / sides) - t * 0.5
    for end, on in zip((-1, 1), caps):
        if not on:
            continue
        for j, (sa, sb) in enumerate(((0.92, 0.42), (0.42, 0.92), (0.72, 0.72))):
            d = 0.02
            if axis == "x":
                p = c[0] + end * (length / 2 - d)
                mn = (p - d, c[1] - ri * sa, c[2] - ri * sb)
                mx = (p + d, c[1] + ri * sa, c[2] + ri * sb)
            elif axis == "y":
                p = c[1] + end * (length / 2 - d)
                mn = (c[0] - ri * sa, p - d, c[2] - ri * sb)
                mx = (c[0] + ri * sa, p + d, c[2] + ri * sb)
            else:
                p = c[2] + end * (length / 2 - d)
                mn = (c[0] - ri * sa, c[1] - ri * sb, p - d)
                mx = (c[0] + ri * sa, c[1] + ri * sb, p + d)
            m.visual("%s_c%d%d" % (name, end + 1, j), surface, mn, mx, tint, lm=lm * 0.5)
            n += 1
    return n


class Frame:
    """A model's local frame on the box (mn, mx): see the section comment. `along` ("x" or "y") is the
    length axis (default: the longer side); `flip` turns the model half round (its front at -X / -Y)."""

    def __init__(self, m, name, mn, mx, along=None, flip=False):
        self.m, self.name = m, name
        self.mn, self.mx = tuple(mn), tuple(mx)
        sx, sy = mx[0] - mn[0], mx[1] - mn[1]
        self.along = along or ("x" if sx >= sy else "y")
        self.flip = flip
        self.L = sx if self.along == "x" else sy
        self.W = sy if self.along == "x" else sx
        self.H = mx[2] - mn[2]
        self.n = 0

    def world(self, u, v, z):
        if self.flip:
            u, v = self.L - u, self.W - v
        if self.along == "x":
            return (self.mn[0] + u, self.mx[1] - v, self.mn[2] + z)
        return (self.mn[0] + v, self.mn[1] + u, self.mn[2] + z)

    def axis(self, a):
        """World axis name of a frame axis ("u", "v", "z")."""
        if a == "z":
            return "z"
        return ("x" if self.along == "x" else "y") if a == "u" else ("y" if self.along == "x" else "x")

    def box(self, surface, u0, u1, v0, v1, z0, z1, tint=None, lm=1.0):
        p, q = self.world(u0, v0, z0), self.world(u1, v1, z1)
        self.n += 1
        return self.m.visual("%s_%03d" % (self.name, self.n), surface, tuple(min(a, b) for a, b in zip(p, q)),
                             tuple(max(a, b) for a, b in zip(p, q)), tint, lm=lm)

    def turned(self, surface, u0, u1, v0, v1, z0, z1, tilt, tint=None, lm=1.0, hide=()):
        """A box tilted by `tilt` degrees about the frame's v axis (its +u end goes down for tilt > 0): a sloped
        windscreen or roof sheet. Kept inside the frame by the caller."""
        p, q = self.world(u0, v0, z0), self.world(u1, v1, z1)
        mn = tuple(min(a, b) for a, b in zip(p, q))
        mx = tuple(max(a, b) for a, b in zip(p, q))
        self.n += 1
        nm = "%s_%03d" % (self.name, self.n)
        sgn = -1 if self.flip else 1
        if self.along == "y":       # the box's own Y axis is the frame's u: pitch about its own X (= v)
            return self.m.visual(nm, surface, mn, mx, tint, pitch=-tilt * sgn, hide=hide, lm=lm)
        # along x: turn the box so its own Y is the frame's u, then pitch
        c = tuple((a + b) / 2 for a, b in zip(mn, mx))
        hx, hy, hz = (mx[0] - mn[0]) / 2, (mx[1] - mn[1]) / 2, (mx[2] - mn[2]) / 2
        return self.m.visual(nm, surface, (c[0] - hy, c[1] - hx, c[2] - hz), (c[0] + hy, c[1] + hx, c[2] + hz), tint,
                             yaw=-90.0, pitch=-tilt * sgn, hide=hide, lm=lm)

    def cyl(self, surface, u, v, z, r, length, axis, sides=10, tint=None, lm=1.0, caps=(True, True)):
        self.n += 1
        return cylinder(self.m, "%s_%03d" % (self.name, self.n), surface, self.world(u, v, z), r, length,
                        self.axis(axis), sides, tint, lm, caps)


def _wheels(F, S, us, r, wide, tint=RUBBER, sides=10):
    """Wheel pairs at the u positions in `us`, radius r, `wide` across, flush with both sides."""
    for u in us:
        for v in (wide / 2, F.W - wide / 2):
            F.cyl(S["paint"], u, v, r, r, wide, "v", sides, tint, 0.5, caps=(v < F.W / 2, v > F.W / 2))
            hub = 0.42 * r
            vv = (0.0, 0.012) if v < F.W / 2 else (F.W - 0.012, F.W)
            F.box(S["paint"], u - hub, u + hub, vv[0], vv[1], r - hub, r + hub, (0.42, 0.42, 0.4), 0.3)


def vehicle(m, name, mn, mx, kind, S, colour, along=None, flip=False):
    """A road vehicle filling the box (front at u = L): kind "bus", "van", "truck" (canvas cargo truck),
    "tanker" (fuel tanker) or "apv" (armoured patrol vehicle)."""
    F = Frame(m, name, mn, mx, along, flip)
    L, W, H = F.L, F.W, F.H
    p, met = S["paint"], S["metal"]
    if kind == "bus":
        r = 0.5
        _wheels(F, S, (2.9, L - 2.4), r, 0.3)
        F.box(p, 0.25, L - 0.25, 0.32, W - 0.32, 0.3, 0.75, DARK, 0.4)                         # chassis
        F.box(p, 0.03, L - 0.03, 0.03, W - 0.03, 0.75, 1.62, colour)                             # lower body
        F.box(p, 0.03, L - 0.03, 0.03, W - 0.03, 2.48, H - 0.12, colour)                         # upper band
        F.box(p, 0.15, L - 0.15, 0.1, W - 0.1, H - 0.12, H, tuple(c * 0.92 for c in colour), 0.5)   # roof
        F.box(p, 0.12, L - 1.0, 0.1, W - 0.1, 1.62, 2.48, GLASS, 0.5)                             # window glass
        for k in range(10):                                                                        # pillars
            u = 0.03 + k * (L - 1.1) / 9.0
            F.box(p, u, u + 0.14, 0.03, W - 0.03, 1.62, 2.48, colour, 0.4)
        F.box(p, L - 1.0, L - 0.03, 0.03, W - 0.03, 1.62, 1.75, colour, 0.4)
        F.box(p, L - 0.08, L - 0.02, 0.15, W - 0.15, 1.75, 2.42, GLASS, 0.5)                      # windscreen
        F.box(p, L - 0.03, L, 0.12, W - 0.12, 0.3, 0.6, DARK, 0.4)                                # bumper
        F.box(p, 0.0, 0.03, 0.12, W - 0.12, 0.3, 0.6, DARK, 0.4)
        for v in (0.25, W - 0.45):
            F.box(p, L - 0.02, L, v, v + 0.2, 0.85, 1.0, LAMP_WHITE, 0.2)
            F.box(p, 0.0, 0.02, v, v + 0.2, 0.85, 1.0, LAMP_RED, 0.2)
        for z in (1.0, 1.3):                                                                       # rub rails
            F.box(p, 0.4, L - 0.4, 0.0, 0.03, z, z + 0.06, DARK, 0.2)
            F.box(p, 0.4, L - 0.4, W - 0.03, W, z, z + 0.06, DARK, 0.2)
        return F
    if kind == "van":
        r = 0.34
        _wheels(F, S, (0.95, L - 0.95), r, 0.22, sides=8)
        F.box(p, 0.02, L - 0.95, 0.02, W - 0.02, 0.4, H - 0.08, colour)                            # box body
        F.box(p, 0.1, L - 1.05, 0.08, W - 0.08, H - 0.08, H, tuple(c * 0.93 for c in colour), 0.5)
        F.box(p, L - 0.95, L - 0.02, 0.02, W - 0.02, 0.4, 1.15, colour)                           # bonnet
        F.turned(p, L - 1.05, L - 0.45, 0.06, W - 0.06, 1.1, 1.95, 28.0, GLASS, 0.5)              # windscreen
        F.box(p, L - 1.25, L - 0.95, 0.02, W - 0.02, 1.15, H - 0.08, colour, 0.5)
        F.box(p, L - 1.6, L - 1.0, 0.0, 0.02, 1.25, 1.75, GLASS, 0.3)                              # side windows
        F.box(p, L - 1.6, L - 1.0, W - 0.02, W, 1.25, 1.75, GLASS, 0.3)
        F.box(p, L - 0.03, L, 0.15, W - 0.15, 0.3, 0.55, DARK, 0.3)
        F.box(p, L - 0.03, L, 0.5, W - 0.5, 0.65, 0.95, DARK, 0.3)                                 # grille
        for v in (0.15, W - 0.4):
            F.box(p, L - 0.025, L, v, v + 0.25, 0.85, 1.0, LAMP_WHITE, 0.2)
        F.box(p, 0.0, 0.03, 0.15, W - 0.15, 0.3, 0.55, DARK, 0.3)
        F.box(p, 0.0, 0.02, W / 2 - 0.01, W / 2 + 0.01, 0.6, H - 0.15, DARK, 0.2)                 # rear doors split
        return F
    if kind in ("truck", "tanker"):
        r = 0.55
        _wheels(F, S, (1.2, 2.45, L - 1.4), r, 0.34)
        F.box(p, 0.0, L - 0.1, 0.4, W - 0.4, 0.5, 1.05, DARK, 0.4)                                 # chassis
        cab0 = L - 2.3
        F.box(p, cab0, L - 0.05, 0.05, W - 0.05, 1.05, 2.0, colour)                                # cab
        F.box(p, cab0, L - 0.5, 0.05, W - 0.05, 2.0, 2.85, colour)
        F.turned(p, L - 0.62, L - 0.12, 0.1, W - 0.1, 1.95, 2.8, 12.0, GLASS, 0.5)
        F.box(p, cab0 + 0.1, L - 0.6, 0.12, W - 0.12, 2.85, 2.95, tuple(c * 0.9 for c in colour), 0.4)
        F.box(p, cab0 + 0.6, L - 0.9, 0.03, 0.05, 2.1, 2.6, GLASS, 0.3)                           # door windows
        F.box(p, cab0 + 0.6, L - 0.9, W - 0.05, W - 0.03, 2.1, 2.6, GLASS, 0.3)
        F.box(p, L - 0.05, L, 0.1, W - 0.1, 0.55, 0.95, DARK, 0.3)                                  # bumper
        F.box(p, L - 0.06, L - 0.03, 0.55, W - 0.55, 1.15, 1.85, DARK, 0.3)                        # grille
        for v in (0.15, W - 0.4):
            F.box(p, L - 0.03, L, v, v + 0.25, 1.1, 1.25, LAMP_WHITE, 0.2)
        if kind == "truck":
            F.box(p, 0.0, cab0 - 0.15, 0.03, W - 0.03, 1.05, 1.45, colour)                         # cargo bed
            F.box(S["fabric"], 0.05, cab0 - 0.2, 0.06, W - 0.06, 1.45, H - 0.25, S.get("canvas", (0.62, 0.56, 0.42)))
            F.box(S["fabric"], 0.1, cab0 - 0.25, 0.25, W - 0.25, H - 0.25, H, S.get("canvas", (0.62, 0.56, 0.42)), 0.5)
            for k in range(5):                                                                      # canvas bows
                u = 0.3 + k * (cab0 - 0.8) / 4.0
                F.box(S["fabric"], u, u + 0.08, 0.03, W - 0.03, 1.45, H - 0.27, DARK, 0.2)
        else:
            rt = (H - 0.15 - 1.05) / 2.0
            F.cyl(met, (cab0 - 0.15) / 2.0, W / 2, 1.05 + rt, rt, cab0 - 0.35, "u", 12, colour)  # tank
            F.box(p, 0.4, cab0 - 0.5, W / 2 - 0.25, W / 2 + 0.25, H - 0.17, H, DARK, 0.3)         # walkway on top
            for u in (0.6, cab0 - 0.9):
                F.box(p, u, u + 0.25, 0.15, W - 0.15, 0.95, 1.12, DARK, 0.3)                       # straps
        F.box(p, 0.0, 0.03, 0.2, W - 0.2, 0.55, 0.8, DARK, 0.3)
        return F
    if kind == "apv":
        r = 0.58
        _wheels(F, S, (1.15, L - 1.15), r, 0.38)
        F.box(p, 0.05, L - 0.05, 0.4, W - 0.4, 0.45, 0.95, DARK, 0.4)                               # V hull
        F.box(p, 0.0, L - 0.9, 0.03, W - 0.03, 0.95, 2.45, colour)                                  # crew box
        F.box(p, L - 0.9, L - 0.05, 0.05, W - 0.05, 0.95, 1.55, colour)                             # bonnet
        F.turned(p, L - 1.15, L - 0.75, 0.1, W - 0.1, 1.5, 2.4, 22.0, GLASS, 0.5)                  # windscreen
        F.box(p, 0.15, L - 1.05, 0.12, W - 0.12, 2.45, 2.52, tuple(c * 0.9 for c in colour), 0.4)
        F.cyl(p, L * 0.45, W / 2, 2.61, 0.55, 0.18, "z", 10, tuple(c * 0.85 for c in colour), 0.4)  # turret ring
        F.box(p, L * 0.45 - 0.35, L * 0.45 + 0.35, W / 2 - 0.5, W / 2 + 0.5, 2.52, H - 0.02, tuple(c * 0.8 for c in colour), 0.4)
        for u in (0.9, 2.2, 3.5):                                                                   # armour panels
            F.box(p, u, u + 1.15, 0.0, 0.03, 1.2, 2.2, tuple(c * 0.93 for c in colour), 0.3)
            F.box(p, u, u + 1.15, W - 0.03, W, 1.2, 2.2, tuple(c * 0.93 for c in colour), 0.3)
        F.box(p, 1.6, 2.4, 0.0, 0.035, 1.75, 2.15, GLASS, 0.3)                                       # vision blocks
        F.box(p, 1.6, 2.4, W - 0.035, W, 1.75, 2.15, GLASS, 0.3)
        F.box(p, L - 0.05, L, 0.15, W - 0.15, 0.55, 1.2, DARK, 0.3)                                  # bull bar
        F.cyl(S["paint"], 0.25, W / 2, 1.5, 0.48, 0.3, "u", 10, RUBBER, 0.4)                        # spare wheel
        for v in (0.2, W - 0.45):
            F.box(p, L - 0.03, L, v, v + 0.25, 1.3, 1.45, LAMP_WHITE, 0.2)
        return F
    raise ValueError("vehicle kind %s" % kind)


def container(m, name, mn, mx, S, colour, along=None, doors_at_end=True, flip=False):
    """An ISO shipping container filling the box: corrugated walls (the metal texture) set 4 cm in, corner posts,
    top and bottom rails, and doors with locking bars on its +u end."""
    F = Frame(m, name, mn, mx, along, flip)
    L, W, H = F.L, F.W, F.H
    met, p = S["metal"], S["paint"]
    dark = tuple(c * 0.7 for c in colour)
    F.box(met, 0.08, L - 0.08, 0.04, W - 0.04, 0.12, H - 0.1, colour)                               # walls
    F.box(met, 0.08, L - 0.08, 0.06, W - 0.06, H - 0.1, H - 0.02, tuple(c * 0.9 for c in colour), 0.5)   # roof
    for u0, u1 in ((0.0, 0.16), (L - 0.16, L)):                                                     # corner posts
        for v0, v1 in ((0.0, 0.16), (W - 0.16, W)):
            F.box(p, u0, u1, v0, v1, 0.0, H, dark, 0.4)
    for v0, v1 in ((0.0, 0.05), (W - 0.05, W)):                                                     # side rails
        F.box(p, 0.16, L - 0.16, v0, v1, 0.0, 0.14, dark, 0.3)
        F.box(p, 0.16, L - 0.16, v0, v1, H - 0.12, H, dark, 0.3)
    F.box(p, 0.0, 0.08, 0.16, W - 0.16, 0.0, H, dark, 0.4)                                          # back end wall
    if doors_at_end:
        F.box(met, L - 0.08, L - 0.03, 0.16, W - 0.16, 0.14, H - 0.12, colour, 0.6)                 # doors
        F.box(p, L - 0.03, L - 0.01, W / 2 - 0.015, W / 2 + 0.015, 0.14, H - 0.12, DARK, 0.2)       # door seam
        for v in (0.45, W / 2 - 0.3, W / 2 + 0.3, W - 0.45):                                        # locking bars
            F.box(p, L - 0.025, L, v - 0.025, v + 0.025, 0.2, H - 0.18, CHROME, 0.2)
            F.box(p, L - 0.03, L, v - 0.06, v + 0.06, 1.15, 1.3, DARK, 0.2)
    else:
        F.box(p, L - 0.08, L, 0.16, W - 0.16, 0.0, H, dark, 0.4)
    return F


def hesco(m, name, mn, mx, S, cell=1.0, fill=None):
    """A Hesco bastion (wire mesh cells lined with fabric, filled with sand) filling the box: the fabric body
    3 cm in, wire posts at each cell joint and rails round the top and the middle, sand at the top."""
    F = Frame(m, name, mn, mx, "x")
    L, W, H = F.L, F.W, F.H
    fab, p = S["fabric"], S["paint"]
    wire = (0.42, 0.43, 0.42)
    F.box(fab, 0.03, L - 0.03, 0.03, W - 0.03, 0.0, H - 0.04, S.get("hesco", (0.72, 0.66, 0.52)))
    F.box(S["ground"], 0.05, L - 0.05, 0.05, W - 0.05, H - 0.04, H - 0.02, fill or (0.9, 0.85, 0.75), 0.4)
    t = 0.025
    nu = max(1, int(round(L / cell)))
    nv = max(1, int(round(W / cell)))
    for k in range(nu + 1):                                                                          # long faces
        u = min(L - t, max(0.0, k * L / nu - t / 2))
        F.box(p, u, u + t, 0.0, t, 0.0, H, wire, 0.15)
        F.box(p, u, u + t, W - t, W, 0.0, H, wire, 0.15)
    for k in range(1, nv):                                                                           # short faces
        v = k * W / nv - t / 2
        F.box(p, 0.0, t, v, v + t, 0.0, H, wire, 0.15)
        F.box(p, L - t, L, v, v + t, 0.0, H, wire, 0.15)
    for z0 in (H - 0.05, H * 0.5 - 0.025):                                                          # rails
        F.box(p, 0.0, L, 0.0, t, z0, z0 + 0.05, wire, 0.15)
        F.box(p, 0.0, L, W - t, W, z0, z0 + 0.05, wire, 0.15)
        F.box(p, 0.0, t, t, W - t, z0, z0 + 0.05, wire, 0.15)
        F.box(p, L - t, L, t, W - t, z0, z0 + 0.05, wire, 0.15)
    return F


def twall_row(m, name, mn, mx, S, panel=1.25, tint=None):
    """A row of concrete T-walls filling the box: each panel a stem on a foot as wide as the box, a narrower top,
    and a dark joint between panels set back from the faces."""
    F = Frame(m, name, mn, mx)
    L, W, H = F.L, F.W, F.H
    c = S["concrete"]
    n = max(1, int(round(L / panel)))
    pw = L / n
    stem = min(W, 0.32)
    v0 = (W - stem) / 2
    foot_h = min(0.55, H * 0.25)
    for k in range(n):
        u0, u1 = k * pw + 0.012, (k + 1) * pw - 0.012
        tt = tint or (0.95 + 0.06 * ((k * 7) % 3 - 1) * 0.5,) * 3
        F.box(c, u0, u1, 0.0, W, 0.0, foot_h, tt)
        F.box(c, u0, u1, v0, W - v0, foot_h, H - 0.08, tt)
        F.box(c, u0 + 0.03, u1 - 0.03, v0 + 0.04, W - v0 - 0.04, H - 0.08, H, tt, 0.4)
        if k:
            F.box(c, k * pw - 0.012, k * pw + 0.012, 0.05, W - 0.05, 0.0, H - 0.1, (0.35, 0.35, 0.34), 0.15)
    return F


def sandbag_wall(m, name, mn, mx, S, row=0.15, tint=(0.66, 0.6, 0.46)):
    """Sandbags stacked to fill the box: a core set 4 cm in, and on every face each course as a bag-thick strip,
    alternate courses set 1.5 cm back, so the courses read from a distance."""
    F = Frame(m, name, mn, mx, "x")
    L, W, H = F.L, F.W, F.H
    fab = S["fabric"]
    F.box(fab, 0.04, L - 0.04, 0.04, W - 0.04, 0.0, H, tuple(c * 0.85 for c in tint), 0.5)
    n = max(1, int(round(H / row)))
    h = H / n
    for k in range(n):
        d = 0.0 if k % 2 == 0 else 0.015
        z0, z1 = k * h + 0.005, (k + 1) * h - 0.005
        shade = tuple(c * (1.0 if k % 2 == 0 else 0.93) for c in tint)
        F.box(fab, d, L - d, d, W - d, z0, z1, shade, 0.6)
    return F


def crate_stack(m, name, mn, mx, S, levels=None, tint=None):
    """Wooden crates stacked to fill the box, each with edge battens 2 cm proud of its sides (inside the box)."""
    F = Frame(m, name, mn, mx)
    L, W, H = F.L, F.W, F.H
    wood = S["wood"]
    n = levels or max(1, int(round(H / 0.9)))
    h = H / n
    for k in range(n):
        z0, z1 = k * h, (k + 1) * h
        tt = tint or (1.0, 0.97, 0.9)
        F.box(wood, 0.02, L - 0.02, 0.02, W - 0.02, z0, z1 - 0.01, tt)
        b = 0.08
        for u0, u1 in ((0.0, b), (L - b, L)):
            for v0, v1 in ((0.0, b), (W - b, W)):
                F.box(wood, u0, u1, v0, v1, z0, z1 - 0.01, tuple(c * 0.82 for c in tt), 0.2)
        for v0, v1 in ((0.0, 0.02), (W - 0.02, W)):
            F.box(wood, b, L - b, v0, v1, z1 - 0.09, z1 - 0.01, tuple(c * 0.82 for c in tt), 0.2)
            F.box(wood, b, L - b, v0, v1, z0, z0 + 0.08, tuple(c * 0.82 for c in tt), 0.2)
    return F


def ibc_stack(m, name, mn, mx, S, levels=2):
    """IBC tanks (a white tank in a steel cage on a pallet) stacked to fill the box."""
    F = Frame(m, name, mn, mx)
    L, W, H = F.L, F.W, F.H
    p = S["paint"]
    h = H / levels
    cage = (0.5, 0.51, 0.5)
    for k in range(levels):
        z0 = k * h
        F.box(p, 0.0, L, 0.0, W, z0, z0 + 0.14, DARK, 0.4)                                            # pallet
        F.box(p, 0.06, L - 0.06, 0.06, W - 0.06, z0 + 0.14, z0 + h - 0.06, (0.86, 0.86, 0.82))      # tank
        F.box(p, L / 2 - 0.15, L / 2 + 0.15, W / 2 - 0.15, W / 2 + 0.15, z0 + h - 0.06, z0 + h - 0.02, DARK, 0.2)
        t = 0.03
        for u0 in (0.0, L / 2 - t / 2, L - t):
            for v0, v1 in ((0.0, t), (W - t, W)):
                F.box(p, u0, u0 + t, v0, v1, z0 + 0.14, z0 + h - 0.02, cage, 0.15)
        for v0 in (W / 2 - t / 2,):
            for u0, u1 in ((0.0, t), (L - t, L)):
                F.box(p, u0, u1, v0, v0 + t, z0 + 0.14, z0 + h - 0.02, cage, 0.15)
        for zz in (z0 + 0.45, z0 + h - 0.06):
            F.box(p, 0.0, L, 0.0, t, zz, zz + 0.04, cage, 0.15)
            F.box(p, 0.0, L, W - t, W, zz, zz + 0.04, cage, 0.15)
            F.box(p, 0.0, t, t, W - t, zz, zz + 0.04, cage, 0.15)
            F.box(p, L - t, L, t, W - t, zz, zz + 0.04, cage, 0.15)
    return F


def gable_roof(m, name, mn, mx, S, rise, ov=(0.3, 0.3, 0.3, 0.3), along=None, tint=(0.8, 0.8, 0.78),
               gable_surface=None, gable_tint=None):
    """A corrugated gable roof over the box (mn, mx) = the walls' outline, eaves at mn[2]: two pitched sheets
    meeting at the ridge (`rise` above the eaves, along the frame's u), a ridge cap, and the gable ends closed in
    stepped boards. `ov` = overhang past the walls at (u start, u end, v start, v end): 0 on a side that meets
    something players stand on. Visual only: it is all above the eaves."""
    F = Frame(m, name, mn, mx, along)
    L, W = F.L, F.W
    met = S["metal"]
    ou0, ou1, ov0, ov1 = ov
    k = rise / (W / 2)
    t = 0.05
    ax = F.axis("u")
    cxw, cyw = (mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2
    for side, o in ((0, ov0), (1, ov1)):
        run = W / 2 + o
        drop = o * k
        length = math.hypot(run, rise + drop)
        slope = math.degrees(math.atan2(rise + drop, run))
        v_mid = (W / 2 - run / 2) if side == 0 else (W / 2 + run / 2)
        z_mid = mn[2] + (rise - drop) / 2 + 0.07
        u_mid = (L + ou1 - ou0) / 2
        c = F.world(u_mid, v_mid, 0)
        lu = L + ou0 + ou1
        if ax == "x":
            sgn = 1 if c[1] > cyw else -1
            m.visual("%s_sheet%d" % (name, side), met, (c[0] - lu / 2, c[1] - length / 2, z_mid - t / 2),
                     (c[0] + lu / 2, c[1] + length / 2, z_mid + t / 2), tint, pitch=-slope * sgn, lm=0.6, under=True)
        else:
            sgn = 1 if c[0] > cxw else -1
            m.visual("%s_sheet%d" % (name, side), met, (c[0] - lu / 2, c[1] - length / 2, z_mid - t / 2),
                     (c[0] + lu / 2, c[1] + length / 2, z_mid + t / 2), tint, yaw=90.0, pitch=slope * sgn, lm=0.6,
                     under=True)
    F.box(met, -ou0, L + ou1, W / 2 - 0.15, W / 2 + 0.15, rise + 0.05, rise + 0.13,
          tuple(c * 0.8 for c in tint), 0.3)                                                          # ridge cap
    steps = 9
    gs = gable_surface or S["wood"]
    for end in (0.0, L - 0.05):
        for j in range(steps):
            z0 = rise * j / steps
            frac = 1.0 - (j + 0.5) / steps
            F.box(gs, end, end + 0.05, W / 2 - frac * W / 2, W / 2 + frac * W / 2, z0, z0 + rise / steps,
                  gable_tint or (0.9, 0.86, 0.78), 0.4)
    return F


def flat_roof(m, name, mn, mx, S, overhang=0.25, tint=(0.78, 0.78, 0.76), parapet=0.0, along=None):
    """A corrugated flat roof sheet over the box (mn = eave height), `overhang` past the walls, with a fascia;
    visual only (above the eaves)."""
    F = Frame(m, name, mn, mx, along)
    L, W = F.L, F.W
    met = S["metal"]
    F.box(met, -overhang, L + overhang, -overhang, W + overhang, 0.0, 0.06, tint, 0.6)
    F.box(S["paint"], -overhang, L + overhang, -overhang, -overhang + 0.04, -0.12, 0.08,
          tuple(c * 0.7 for c in tint), 0.2)
    F.box(S["paint"], -overhang, L + overhang, W + overhang - 0.04, W + overhang, -0.12, 0.08,
          tuple(c * 0.7 for c in tint), 0.2)
    if parapet:
        F.box(S["concrete"], 0.0, L, 0.0, 0.2, 0.06, 0.06 + parapet, (0.9, 0.88, 0.84), 0.4)
        F.box(S["concrete"], 0.0, L, W - 0.2, W, 0.06, 0.06 + parapet, (0.9, 0.88, 0.84), 0.4)
    return F
