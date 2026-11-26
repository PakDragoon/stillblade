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
