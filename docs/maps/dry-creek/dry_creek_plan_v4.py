"""Dry Creek draft 2: original layout, 80 x 80 m, north up. Defenders top right, ghosts bottom left.
Sites far apart, each a little closer to the defenders. Dense streets between structures."""
import sys, html, math

N = 80
S = 10.5
OX, OY = 30, 74
out = sys.argv[1]

TALL, HUMAN, JUMP, CROUCH, RAISED, LOW, SITE_A, SITE_B, SPAWN, ROOF, VEH, HARD = (
    "#8e98a3", "#4fa3e0", "#f0a030", "#b07de0", "#5cc98a", "#3fd0d8", "#e2574c", "#3d7fd6", "#ffd84d", "#c9b25a",
    "#6d8f7a", "#c0c6cc")
shapes, walls = [], []
def r(col, x0, y0, x1, y1, op=0.85, label=None):
    shapes.append((col, x0, y0, x1, y1, op, label))
def w(*pts):
    for a, b in zip(pts, pts[1:]):
        walls.append((a[0], a[1], b[0], b[1]))

w((0, 0), (N, 0), (N, N), (0, N), (0, 0))

# ---------------- spawns ----------------
r(SPAWN, 66, 2, 78, 12, 0.35, "D spawn")
r(SPAWN, 2, 68, 14, 78, 0.35, "G spawn")

# ---------------- dividing walls (3.5 m): they make the lanes; gaps are the chokes ----------------
w((18, 34), (18, 44)); w((18, 48), (18, 60))                 # west lane | mid, gap "Garage gap" y 44-48
w((18, 60), (26, 60)); w((30, 60), (54, 60))                 # mid | south lane, gap "Fuel gap" x 26-30
w((18, 32), (30, 32)); w((34, 32), (44, 32))                 # A yard | mid, gap "A short" x 30-34
w((18, 4), (18, 20))                                         # A yard west wall, "A long" enters at y 20-32
w((44, 0), (44, 14)); w((44, 18), (44, 32))                  # A yard | defender side, gap y 14-18
w((56, 36), (56, 46)); w((56, 50), (56, 60))                 # mid | B, gap "B mid" y 46-50
w((56, 36), (62, 36)); w((66, 36), (75, 36))                 # B | defender side, gap x 62-66 (B north)
w((54, 60), (54, 64)); w((54, 64), (62, 64)); w((66, 64), (75, 64))   # south lane | B, gap "B south" x 62-66
w((44, 32), (54, 32))                                        # mid north wall, defenders enter mid at x 54-56

# ---------------- site A: barracks inside a walled yard ----------------
r(SITE_A, 22.5, 11, 37, 17.5, 0.18)
w((26, 10), (21, 10), (21, 12.5)); w((21, 15), (21, 18), (30, 18)); w((27.4, 10), (38, 10), (38, 13)); w((38, 15.5), (38, 18), (34, 18))
w((30, 22), (21, 22), (21, 24.5)); w((21, 27.5), (21, 29), (30, 29)); w((31.4, 29), (38, 29), (38, 22), (34, 22))
r(ROOF, 21, 18, 30, 22, 0.6, "Low roof")
r(ROOF, 30, 18, 34, 22, 0.35)
r(CROUCH, 31.3, 19.3, 32.7, 20.7, 0.95)
r(TALL, 34, 18, 38, 22, 0.6)
r(JUMP, 19.2, 19, 20.7, 20.5)
r(HARD, 27, 12.6, 31.5, 15, 0.95, "Console")
r(HUMAN, 22.5, 11.2, 24.5, 12.7); r(HUMAN, 34.5, 15.5, 36.5, 17)
r(JUMP, 24, 24.5, 25.5, 26); r(HUMAN, 33, 26, 36.5, 27.5)
r(HUMAN, 40, 22, 42, 26)                                     # sandbags in the yard

# ---------------- west lane: motor pool ----------------
r(TALL, 0, 22, 12, 32, label="Garage")
r(VEH, 6, 40, 9, 46, 0.85, "APV")
r(VEH, 12, 50, 15, 55, 0.85, "Van")
r(HUMAN, 3, 56, 7, 58); r(JUMP, 13, 36, 14.5, 37.5)
r(TALL, 0, 4, 14, 14, label="Watchtower")

# ---------------- mid: parade ground and command post ----------------
r(TALL, 30, 40, 44, 50, label="Command post")
r(VEH, 22, 34.5, 34, 37, 0.85, "School bus")
r(TALL, 46, 38, 49, 48, label="Trailer")
r(TALL, 50.5, 38, 53.5, 48, label="Trailer")
r(JUMP, 24, 52, 25.5, 53.5); r(HUMAN, 46, 52, 48, 56)
r(HUMAN, 24, 44, 26, 48)

# ---------------- south lane: fuel depot ----------------
r(TALL, 30, 66, 36, 72, label="Fuel tank"); r(TALL, 40, 66, 46, 72, label="Fuel tank")
r(HUMAN, 20, 64, 22, 68); r(JUMP, 49, 70, 50.5, 71.5); r(HUMAN, 52, 74, 58, 76)
r(TALL, 20, 72, 26, 80, label="Pump hut"); r(TALL, 60, 72, 70, 80, label="Generator shed")

# ---------------- site B: sunken depot ----------------
r(LOW, 60, 42, 72, 58, 0.5)
r(SITE_B, 62.5, 44.5, 69.5, 55.5, 0.2)
r(HARD, 64, 48, 68.5, 51.5, 0.95, "Transformer")
r(HUMAN, 61.5, 53.5, 63.5, 55.5); r(JUMP, 69, 44.5, 70.5, 46)
r(TALL, 62, 40, 66, 42, 0.35)      # north ramp
r(TALL, 58, 47, 60, 51, 0.35)      # west stairs
r(TALL, 62, 58, 66, 60, 0.35)      # south stairs
r(RAISED, 75.5, 34, 80, 64, 0.6); w((75.5, 34), (75.5, 47)); w((75.5, 53), (75.5, 64)); r(RAISED, 73.5, 47, 75.5, 53, 0.95); r(TALL, 72, 49, 73.5, 53, 0.35)
r(RAISED, 75.5, 30, 80, 34, 0.95); r(RAISED, 75.5, 64, 80, 68, 0.95)

# ---------------- defender side ----------------
r(TALL, 46, 4, 60, 14, label="HQ")
r(TALL, 62, 18, 72, 24, label="Containers")
r(HUMAN, 48, 22, 52, 24); r(JUMP, 58, 28, 59.5, 29.5)
pins = [
    (1, 69, 7, "Defender spawn (top right)"),
    (2, 5, 73, "Ghost spawn (bottom left)"),
    (3, 25, 16.4, "Site A plant zone (red): inside the north barrack"),
    (4, 63.6, 46, "Site B plant zone (blue): 2.5 m in from every rim"),
    (5, 39.4, 14.2, "A east door (defenders)"),
    (6, 26.7, 8.7, "A north crouch gap (watchtower flank)"),
    (7, 19.6, 26, "A south barrack door (from A long)"),
    (8, 30.7, 30.4, "A south crouch gap (from A short)"),
    (9, 19.9, 17.5, "Box onto the low roof"),
    (10, 32, 23.4, "Hole into the passage"),
    (11, 10, 18.5, "A long"),
    (12, 32, 33.2, "A short: mid into the A yard"),
    (13, 18, 46, "Garage gap: west lane to mid"),
    (14, 28, 60, "Fuel gap: south lane to mid"),
    (15, 57.5, 48, "B mid: mid into B"),
    (16, 64, 64, "B south: from the fuel depot"),
    (17, 64, 36, "B north: defenders"),
    (18, 77.8, 42, "Walkway, fenced from the basin"),
    (19, 37, 52.5, "Mid: parade ground"),
    (20, 9, 48, "West lane: motor pool"),
    (21, 38, 63, "South lane: fuel depot"),
    (22, 19.6, 13.7, "NEW A west door, straight into the site"),
    (23, 74.5, 50, "NEW plank down, then B east stairs"),
]
rules = [
    "Fixed after review (2026-11-28):",
    "1  A: new west door into the site from A long, so long,",
    "   short and roof come from different angles to the console.",
    "2  B walkway: fenced from the basin; one plank down at the",
    "   marked point, then stairs into B. No gap jumping, no perch.",
    "3  B defuse: plant zone 2.5 m in from every rim, and the site",
    "   box stops below rim height: no plant or defuse from above.",
    "4  Sightlines: garage, watchtower, pump hut and a generator",
    "   shed now reach the outer wall; the top strip is closed",
    "   at x 44. No edge strip over 40 m.",
    "Still to prove in 3D: one defender at the console can't",
    "watch long, short and roof at once; B footsteps on the",
    "walkway sound different from the basin.",
]
W = OX + N * S + 560
H = OY + N * S + 70
p = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Segoe UI,Arial">',
     f'<rect width="{W}" height="{H}" fill="#14171d"/>',
     f'<text x="{OX}" y="34" font-size="24" font-weight="700" fill="#fff">Dry Creek (working name): draft 4, after review</text>',
     f'<text x="{OX}" y="57" font-size="13" fill="#aab">Top-down, north up, 80 x 80 m, grid = 4 m. Not based on any existing game map.</text>',
     f'<rect x="{OX}" y="{OY}" width="{N*S}" height="{N*S}" fill="#1d2129"/>']
for i in range(0, N + 1, 4):
    p.append(f'<line x1="{OX+i*S}" y1="{OY}" x2="{OX+i*S}" y2="{OY+N*S}" stroke="#262b35"/>')
    p.append(f'<line x1="{OX}" y1="{OY+i*S}" x2="{OX+N*S}" y2="{OY+i*S}" stroke="#262b35"/>')
for col, x0, y0, x1, y1, op, label in shapes:
    p.append(f'<rect x="{OX+x0*S}" y="{OY+y0*S}" width="{(x1-x0)*S}" height="{(y1-y0)*S}" fill="{col}" fill-opacity="{op}" stroke="{col}" stroke-width="1.5"/>')
    if label:
        p.append(f'<text x="{OX+(x0+x1)/2*S}" y="{OY+(y0+y1)/2*S+4}" text-anchor="middle" font-size="10.5" fill="#111" font-weight="700">{html.escape(label)}</text>')
for x0, y0, x1, y1 in walls:
    p.append(f'<line x1="{OX+x0*S}" y1="{OY+y0*S}" x2="{OX+x1*S}" y2="{OY+y1*S}" stroke="#cfd6dd" stroke-width="4.5" stroke-linecap="square"/>')
for n, x, y, _ in pins:
    cx, cy = OX + x * S, OY + y * S
    p.append(f'<circle cx="{cx}" cy="{cy}" r="10" fill="#fff" stroke="#14171d" stroke-width="2"/>')
    p.append(f'<text x="{cx}" y="{cy+4}" text-anchor="middle" font-size="11" font-weight="700" fill="#14171d">{n}</text>')
lx, y = OX + N * S + 24, OY + 6
for t, c in [("Tall, can't climb", TALL), ("Hard cover 2.2 m (site centrepiece)", HARD), ("Human height 1.8 m", HUMAN),
             ("Jump box 1.0 m", JUMP), ("Crouch-only / roof hole", CROUCH), ("Raised 1.2 m / planks", RAISED),
             ("Below ground 1.2 m", LOW), ("Roof you can stand on", ROOF), ("Vehicle", VEH), ("Site A", SITE_A), ("Site B", SITE_B)]:
    p.append(f'<rect x="{lx}" y="{y}" width="14" height="14" rx="3" fill="{c}"/><text x="{lx+22}" y="{y+12}" font-size="13" fill="#dde">{t}</text>')
    y += 20
y += 10
for n, _, _, t in pins:
    p.append(f'<text x="{lx}" y="{y}" font-size="12.5" fill="#dde"><tspan font-weight="700">{n}</tspan>  {html.escape(t)}</text>')
    y += 18
y += 12
for i, t in enumerate(rules):
    p.append(f'<text x="{lx}" y="{y}" font-size="12.5" fill="{"#fff" if i == 0 else "#c8d0d8"}" font-weight="{700 if i == 0 else 400}">{html.escape(t)}</text>')
    y += 18
p.append('</svg>')
open(out, "w", encoding="utf-8").write("\n".join(p))
print(out, "text ends", y, "page", H)

# rough straight-line distances (paths will be longer)
D, G = (72, 7), (8, 73)
A, B = (29, 15), (66, 50)
f = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1])
print("D->A %.0f  D->B %.0f  G->A %.0f  G->B %.0f  A<->B %.0f" % (f(D, A), f(D, B), f(G, A), f(G, B), f(A, B)))
