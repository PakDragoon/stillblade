/**
 * One connection's measuring ping. The probe's WebSocket ping carries a token; only a pong echoing that same token
 * gives a sample, so the keep-alive heartbeat's own pings and pongs can never be mistaken for it. Transport only:
 * wall-clock time is fine here and nothing in the game reads it.
 */
export class PingProbe {
    private token = 0;
    private outstanding = -1;
    private sentAt = 0;

    /** Whether a probe ping is still waiting for its pong. */
    get busy(): boolean { return this.outstanding >= 0; }

    /** Starts a probe at `now` (ms) and returns the payload to put in the ping. */
    start(now: number): Buffer {
        this.token = (this.token + 1) >>> 0;
        this.outstanding = this.token;
        this.sentAt = now;
        const payload = Buffer.alloc(4);
        payload.writeUInt32BE(this.token);
        return payload;
    }

    /** The round trip in ms if `payload` is the awaited probe's echo, else undefined (a heartbeat pong, or a stale one). */
    pong(payload: Buffer, now: number): number | undefined {
        if (this.outstanding < 0 || payload.length !== 4 || payload.readUInt32BE(0) !== this.outstanding) return undefined;
        this.outstanding = -1;
        return Math.max(0, now - this.sentAt);
    }
}
