"""
Lays a drawn plan (SVG, as written by docs/maps/dry-creek/dry_creek_plan_v4.py) over an orthographic overhead
screenshot of the built map, as one HTML page, and renders it to PNG with headless Chrome:

    python tools/plan-overlay.py <overhead.jpg> <plan.svg> <out.png> [--half 40.6] [--size 1200]

The overhead must be taken from above the map's centre (plan 40, 40) with an orthographic half height of `--half`
metres (tools/map-shots.mjs, docs/review/maps/drycreek/overhead.json). The plan's page and map backgrounds, its
grid and its legend are dropped; its shapes, walls and numbered pins are drawn over the screenshot.
"""

import base64
import os
import re
import subprocess
import sys
import tempfile

CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opt = dict(zip(sys.argv[1::1], sys.argv[2::1]))
    half = float(opt.get("--half", 40.6))
    size = int(opt.get("--size", 1200))
    shot, plan, out = args[0], args[1], args[2]
    svg = open(plan, encoding="utf-8").read()
    # plan geometry: origin and scale from the drawing script (OX, OY, S) and the map size N
    ox, oy, s, n = 30.0, 74.0, 10.5, 80.0
    body = []
    for el in re.findall(r"<(?:rect|line|circle|text)[^>]*?(?:/>|>.*?</text>)", svg, flags=re.S):
        if (el.startswith("<rect") and ('fill="#14171d"' in el or 'fill="#1d2129"' in el)) or 'stroke="#262b35"' in el:
            continue
        m = re.search(r'\bx1?="([0-9.]+)"', el) or re.search(r'\bcx="([0-9.]+)"', el)
        if m and float(m.group(1)) > ox + n * s + 4:        # the legend, right of the map
            continue
        if el.startswith("<rect"):
            el = re.sub(r'fill-opacity="[0-9.]+"', 'fill-opacity="0.18"', el)
        body.append(el)
    px_per_m = size / (2 * half)
    left = (half - 40.0) * px_per_m
    inner = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%g %g %g %g" style="position:absolute;left:%.2fpx;top:%.2fpx;'
        'width:%.2fpx;height:%.2fpx">%s</svg>' % (ox, oy, n * s, n * s, left, left, n * px_per_m, n * px_per_m, "".join(body)))
    img = base64.b64encode(open(shot, "rb").read()).decode()
    html = ('<html><body style="margin:0;background:#000"><div style="position:relative;width:%dpx;height:%dpx">'
            '<img src="data:image/jpeg;base64,%s" style="position:absolute;left:0;top:0;width:%dpx;height:%dpx">%s'
            '</div></body></html>' % (size, size, img, size, size, inner))
    fd, path = tempfile.mkstemp(suffix=".html")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(html)
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--screenshot=" + os.path.abspath(out),
                    "--window-size=%d,%d" % (size, size), "file:///" + path.replace("\\", "/")],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    os.unlink(path)
    print(out)


if __name__ == "__main__":
    main()
