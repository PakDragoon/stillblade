import { INTERP_DELAY_MS } from '@shared/constants';
import {
    PROTOCOL_VERSION, decodeServer, encodeClient, type NetCmd, type PlayerSnap, type SelfSnap,
    type RosterEntry, type RoundMsg, type ServerMsg, type ShotEvent, type SlashEvent, type SoundEvent, type Team
} from '@shared/protocol';
import type { Vec3 } from '@shared/types';
import type { RemoteView } from './presenter-api';

export interface NetHandlers {
    /** A new authoritative state for the local player, with the last command the server simulated. */
    snapshot(me: SelfSnap, ack: number): void;
    spawn(pos: Vec3, yaw: number): void;
    shot(ev: ShotEvent): void;
    slash(ev: SlashEvent): void;
    sound(ev: SoundEvent): void;
    round(msg: RoundMsg): void;
    roster(players: RosterEntry[]): void;
}

interface Sample {
    time: number;
    pos: Vec3;
    yaw: number;
    pitch: number;
    crouched: boolean;
    alive: boolean;
    vis: number;
}

interface Remote {
    team: Team;
    samples: Sample[];
    view: RemoteView;
    seen: number;
}

const MAX_SAMPLES = 24;
const PING_SLOTS = 256;

function lerpAngle(a: number, b: number, t: number): number {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
}

/**
 * Connection to the game server: sends commands, receives snapshots, and keeps an interpolation
 * buffer for every other player. `lagMs` adds artificial round-trip latency for testing.
 */
export class Net {
    id = 0;
    team: Team = 'ghosts';
    connected = false;
    /** Round-trip estimate in ms. */
    ping = 0;
    readonly views: RemoteView[] = [];

    private ws: WebSocket;
    private readonly remotes = new Map<number, Remote>();
    private readonly sentAt = new Float64Array(PING_SLOTS);
    /** Server clock minus local clock, as of the freshest snapshot seen. */
    private clockOffset = -Infinity;
    private snapCount = 0;

    constructor(url: string, private readonly lagMs: number, private readonly handlers: NetHandlers) {
        this.ws = new WebSocket(url);
        this.ws.onopen = () => { this.connected = true; };
        this.ws.onclose = () => { this.connected = false; };
        this.ws.onmessage = e => {
            const msg = decodeServer(e.data as string);
            if (this.lagMs > 0) setTimeout(() => this.receive(msg), this.lagMs / 2);
            else this.receive(msg);
        };
    }

    send(cmd: NetCmd): void {
        if (this.ws.readyState !== WebSocket.OPEN) return;
        this.sentAt[cmd.seq % PING_SLOTS] = performance.now();
        const data = encodeClient({ type: 'cmd', cmd });
        if (this.lagMs > 0) setTimeout(() => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data); }, this.lagMs / 2);
        else this.ws.send(data);
    }

    /** Best estimate of the server clock (ms) right now. */
    serverTime(): number {
        return performance.now() + this.clockOffset;
    }

    /** Server time (ms) other players are drawn at this frame; also the lag-compensation target. */
    renderTime(): number {
        return performance.now() + this.clockOffset - INTERP_DELAY_MS;
    }

    private receive(msg: ServerMsg): void {
        switch (msg.type) {
            case 'welcome':
                if (msg.version !== PROTOCOL_VERSION) console.warn('Server protocol version differs; reload the page.');
                this.id = msg.id;
                this.team = msg.team;
                break;
            case 'snap': {
                const now = performance.now();
                // Track the least-delayed snapshot; drift slowly toward later ones so jitter does not jerk the clock.
                const offset = msg.time - now;
                this.clockOffset = offset > this.clockOffset ? offset : this.clockOffset + (offset - this.clockOffset) * 0.02;
                if (msg.ack >= 0) {
                    const rtt = now - this.sentAt[msg.ack % PING_SLOTS];
                    this.ping += (rtt - this.ping) * (this.ping === 0 ? 1 : 0.1);
                }
                this.team = msg.me.team;
                this.snapCount++;
                for (const p of msg.players) this.addSample(p, msg.time);
                for (const [id, r] of this.remotes) if (r.seen !== this.snapCount) this.remotes.delete(id);
                this.handlers.snapshot(msg.me, msg.ack);
                break;
            }
            case 'spawn':
                this.handlers.spawn(msg.pos, msg.yaw);
                break;
            case 'shot':
                this.handlers.shot(msg);
                break;
            case 'slash':
                this.handlers.slash(msg);
                break;
            case 'sound':
                this.handlers.sound(msg);
                break;
            case 'round':
                this.handlers.round(msg);
                break;
            case 'roster':
                this.handlers.roster(msg.players);
                break;
        }
    }

    private addSample(p: PlayerSnap, time: number): void {
        let r = this.remotes.get(p.id);
        if (!r) {
            r = {
                team: p.team, samples: [], seen: 0,
                view: { id: p.id, team: p.team, pos: [0, 0, 0], yaw: 0, pitch: 0, crouched: false, alive: false, vis: 0 }
            };
            this.remotes.set(p.id, r);
        }
        r.seen = this.snapCount;
        r.team = r.view.team = p.team; // sides swap at halftime
        // Recycle the oldest sample rather than allocating one per snapshot.
        const s = r.samples.length >= MAX_SAMPLES ? r.samples.shift()! : { time: 0, pos: [0, 0, 0] as Vec3, yaw: 0, pitch: 0, crouched: false, alive: false, vis: 0 };
        s.time = time;
        s.pos[0] = p.pos[0]; s.pos[1] = p.pos[1]; s.pos[2] = p.pos[2];
        s.yaw = p.yaw; s.pitch = p.pitch; s.crouched = p.crouched; s.alive = p.alive; s.vis = p.vis;
        r.samples.push(s);
    }

    /** Refreshes `views` with every other player blended to `renderTime()`. Call once per frame. */
    interpolate(): readonly RemoteView[] {
        const t = this.renderTime();
        const views = this.views;
        views.length = 0;
        for (const r of this.remotes.values()) {
            const samples = r.samples;
            let i = samples.length - 1;
            while (i > 0 && samples[i].time > t) i--;
            const a = samples[i];
            const b = samples[Math.min(i + 1, samples.length - 1)];
            const span = b.time - a.time;
            // Clamp: never extrapolate past the newest snapshot, and snap across deaths and respawns.
            const k = span > 0 && a.alive === b.alive ? Math.max(0, Math.min(1, (t - a.time) / span)) : t >= b.time ? 1 : 0;
            const v = r.view;
            v.pos[0] = a.pos[0] + (b.pos[0] - a.pos[0]) * k;
            v.pos[1] = a.pos[1] + (b.pos[1] - a.pos[1]) * k;
            v.pos[2] = a.pos[2] + (b.pos[2] - a.pos[2]) * k;
            v.yaw = lerpAngle(a.yaw, b.yaw, k);
            v.pitch = a.pitch + (b.pitch - a.pitch) * k;
            v.vis = a.vis + (b.vis - a.vis) * k;
            const near = k < 0.5 ? a : b;
            v.crouched = near.crouched;
            v.alive = near.alive;
            views.push(v);
        }
        return views;
    }
}
