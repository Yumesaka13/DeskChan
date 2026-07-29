import { describe, expect, it } from 'vitest';
import { snapPosition } from './snap';

const OTHER = { x: 100, y: 100, width: 200, height: 150 };

describe('snapPosition', () => {
    it('aligns same edges within the threshold', () => {
        // left<->left and top<->top
        expect(snapPosition(105, 94, 50, 50, [OTHER])).toEqual({ x: 100, y: 100 });
        // right<->right: my right (x+50) to their right (300) -> x = 250
        expect(snapPosition(246, 400, 50, 50, [OTHER]).x).toBe(250);
    });

    it('butts adjacent edges together', () => {
        // my left to their right (300) and my right to their left (100-50=50)
        expect(snapPosition(304, 400, 50, 50, [OTHER]).x).toBe(300);
        expect(snapPosition(47, 400, 50, 50, [OTHER]).x).toBe(50);
        // my top to their bottom (250)
        expect(snapPosition(400, 253, 50, 50, [OTHER]).y).toBe(250);
    });

    it('does not snap beyond the threshold and axes are independent', () => {
        expect(snapPosition(120, 94, 50, 50, [OTHER])).toEqual({ x: 120, y: 100 });
        expect(snapPosition(500, 500, 50, 50, [OTHER])).toEqual({ x: 500, y: 500 });
    });

    it('the nearest candidate wins', () => {
        const near = { x: 103, y: 0, width: 10, height: 10 };
        expect(snapPosition(105, 500, 50, 50, [OTHER, near]).x).toBe(103);
    });
});
