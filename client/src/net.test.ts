import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { Net } from './net';

class Socket {
    static latest: Socket;
    onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
    close = vi.fn();
    constructor(readonly url: URL) { Socket.latest = this; }

    receive(data: string | ArrayBuffer): void { this.onmessage?.({ data }); }
}

afterEach(() => vi.unstubAllGlobals());

describe('WebSocket version handshake', () => {
    it('advertises the current version and accepts a matching welcome', async () => {
        vi.stubGlobal('WebSocket', Socket);
        const net = new Net('ws://localhost:8080/?room=fern', 0);
        const socket = Socket.latest;
        expect(socket.url.searchParams.get('version')).toBe(String(PROTOCOL_VERSION));
        expect(socket.url.searchParams.get('room')).toBe('fern');
        socket.receive(JSON.stringify({ type: 'welcome', version: PROTOCOL_VERSION, id: 4, team: 'ghosts', map: 'warehouse' }));
        await expect(net.welcome).resolves.toMatchObject({ id: 4, team: 'ghosts', map: 'warehouse' });
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('rejects an older server before applying simulated delay or decoding its snapshots', async () => {
        vi.stubGlobal('WebSocket', Socket);
        const net = new Net('ws://localhost:8080/', 150);
        const socket = Socket.latest;
        socket.receive(JSON.stringify({ type: 'welcome', version: PROTOCOL_VERSION - 1, id: 4, team: 'ghosts', map: 'warehouse' }));
        socket.receive(new ArrayBuffer(1));
        await expect(net.welcome).rejects.toThrow('Game update required');
        expect(socket.close).toHaveBeenCalledOnce();
    });
});
