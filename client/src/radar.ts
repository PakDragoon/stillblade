import type { Team } from '@shared/protocol';
import type { Box, MapData, Vec3 } from '@shared/types';
import type { RemoteView } from './presenter-api';

const SIZE = 168;
/** Metres from the centre to the edge of the radar. */
const RANGE = 24;
const PX_PER_M = SIZE / 2 / RANGE;
const REDRAW_EVERY = 1 / 20;
const TEAM_COLOR: Record<Team, string> = { ghosts: '#9d8cff', defenders: '#ff9a3c' };

export interface RadarSubject {
    pos: Vec3;
    /** View yaw in radians (0 faces -Z). */
    yaw: number;
    team: Team;
}

/**
 * A small top-down map drawn from the map's collision boxes for the floor the subject stands on.
 * Shows only what the client already knows and may show: the subject, living teammates, the bomb
 * sites and the planted bomb. It is never given enemies, so it cannot show them.
 */
export class Radar {
    private readonly canvas = document.createElement('canvas');
    private readonly ctx: CanvasRenderingContext2D | null;
    private map: MapData | null = null;
    private readonly floors: Box[] = [];
    private readonly walls: Box[] = [];
    private band = NaN;
    private acc = 1;
    private shown = true;

    constructor(parent: HTMLElement) {
        this.canvas.id = 'sb-radar';
        this.canvas.width = this.canvas.height = SIZE;
        this.ctx = this.canvas.getContext('2d');
        parent.appendChild(this.canvas);
    }

    setMap(map: MapData): void {
        this.map = map;
        this.band = NaN;
    }

    setVisible(v: boolean): void {
        if (v === this.shown) return;
        this.shown = v;
        this.canvas.style.display = v ? 'block' : 'none';
    }

    /** Sorts the boxes into floor surfaces at the subject's level and solids that block them there. */
    private classify(feetY: number): void {
        this.floors.length = 0;
        this.walls.length = 0;
        for (const b of this.map!.boxes) {
            const top = b.max[1];
            if (Math.abs(top - feetY) < 0.45 && b.max[0] - b.min[0] > 0.3) this.floors.push(b);
            else if (b.min[1] < feetY + 1.8 && top > feetY + 0.45) this.walls.push(b);
        }
    }

    /**
     * Call every frame; it redraws about 20 times a second. `remotes` is the interpolated list (the
     * server only ever sends enemies the player may know of, and none are drawn regardless).
     */
    update(dt: number, subject: RadarSubject, remotes: readonly RemoteView[], bomb: Vec3 | null): void {
        const ctx = this.ctx;
        if (!ctx || !this.map || !this.shown) return;
        this.acc += dt;
        if (this.acc < REDRAW_EVERY) return;
        this.acc = 0;
        const [px, py, pz] = subject.pos;
        const band = Math.round(py * 2);
        if (band !== this.band) { this.band = band; this.classify(py); }

        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.save();
        ctx.beginPath();
        ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = 'rgba(8,11,15,.78)';
        ctx.fillRect(0, 0, SIZE, SIZE);
        // The map is drawn north-up (world -Z at the top); x grows right, z grows down.
        const sx = (x: number): number => SIZE / 2 + (x - px) * PX_PER_M;
        const sz = (z: number): number => SIZE / 2 + (z - pz) * PX_PER_M;
        ctx.fillStyle = 'rgba(120,150,170,.22)';
        for (const b of this.floors) ctx.fillRect(sx(b.min[0]), sz(b.min[2]), (b.max[0] - b.min[0]) * PX_PER_M, (b.max[2] - b.min[2]) * PX_PER_M);
        ctx.fillStyle = 'rgba(214,224,230,.82)';
        for (const b of this.walls) ctx.fillRect(sx(b.min[0]), sz(b.min[2]), Math.max(1, (b.max[0] - b.min[0]) * PX_PER_M), Math.max(1, (b.max[2] - b.min[2]) * PX_PER_M));

        ctx.lineWidth = 1.5;
        ctx.font = '600 11px Bahnschrift, system-ui, sans-serif';
        ctx.textAlign = 'center';
        for (const s of this.map.bombSites) {
            ctx.strokeStyle = 'rgba(255,211,107,.9)';
            ctx.strokeRect(sx(s.min[0]), sz(s.min[2]), (s.max[0] - s.min[0]) * PX_PER_M, (s.max[2] - s.min[2]) * PX_PER_M);
            ctx.fillStyle = 'rgba(255,211,107,.95)';
            ctx.fillText(s.name, sx((s.min[0] + s.max[0]) / 2), sz((s.min[2] + s.max[2]) / 2) + 4);
        }
        if (bomb) {
            ctx.fillStyle = Math.floor(performance.now() / 300) % 2 ? '#ff3b30' : '#7a1a14';
            ctx.beginPath();
            ctx.arc(sx(bomb[0]), sz(bomb[2]), 4.5, 0, Math.PI * 2);
            ctx.fill();
        }
        for (const r of remotes) {
            if (r.team !== subject.team || !r.alive) continue; // teammates only
            const sameFloor = Math.abs(r.pos[1] - py) < 2.2;
            ctx.fillStyle = ctx.strokeStyle = TEAM_COLOR[r.team];
            ctx.beginPath();
            ctx.arc(sx(r.pos[0]), sz(r.pos[2]), 3.5, 0, Math.PI * 2);
            if (sameFloor) ctx.fill(); else ctx.stroke();
        }
        // The subject: an arrow pointing where it looks.
        ctx.translate(SIZE / 2, SIZE / 2);
        ctx.rotate(-subject.yaw);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(0, -7);
        ctx.lineTo(5, 5);
        ctx.lineTo(0, 2);
        ctx.lineTo(-5, 5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
}
