import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_OPTIONS, parseRoomOptions, roomOptionsQuery } from './room-options';

describe('room options from the join query', () => {
    it('defaults to unsuppressed weapons', () => {
        expect(DEFAULT_ROOM_OPTIONS).toEqual({ suppressed: false });
        expect(parseRoomOptions(new URLSearchParams(''))).toEqual({ suppressed: false });
        expect(parseRoomOptions(new URLSearchParams('room=x&map=warehouse'))).toEqual({ suppressed: false });
    });

    it('reads suppressed=1 (and true); anything else is off', () => {
        expect(parseRoomOptions(new URLSearchParams('suppressed=1'))).toEqual({ suppressed: true });
        expect(parseRoomOptions(new URLSearchParams('room=a&suppressed=true'))).toEqual({ suppressed: true });
        for (const v of ['0', 'false', '', 'yes', '2', 'on']) {
            expect(parseRoomOptions(new URLSearchParams(`suppressed=${v}`)).suppressed).toBe(false);
        }
    });

    it('writes only what differs from the default, and reads back what it wrote', () => {
        const q = new URLSearchParams();
        roomOptionsQuery({ suppressed: false }, q);
        expect(q.toString()).toBe('');
        roomOptionsQuery({ suppressed: true }, q);
        expect(q.toString()).toBe('suppressed=1');
        expect(parseRoomOptions(q)).toEqual({ suppressed: true });
    });
});
