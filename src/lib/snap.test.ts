import { describe, expect, it } from 'vitest';
import { snapPosition, snapResizeRect } from './snap';

const OTHER = { x: 100, y: 100, width: 200, height: 150 };
const VERTICAL_OTHER = { x: 100, y: 20, width: 200, height: 150 };
const HORIZONTAL_OTHER = { x: 10, y: 100, width: 200, height: 150 };

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

describe('snapResizeRect', () => {
    it('aligns resized east and south edges', () => {
        expect(snapResizeRect(
            { x: 10, y: 20, width: 86, height: 70 },
            { e: true },
            [VERTICAL_OTHER],
            { minWidth: 50, minHeight: 50 },
        )).toEqual({ x: 10, y: 20, width: 90, height: 70 });

        expect(snapResizeRect(
            { x: 10, y: 20, width: 80, height: 226 },
            { s: true },
            [HORIZONTAL_OTHER],
            { minWidth: 50, minHeight: 50 },
        )).toEqual({ x: 10, y: 20, width: 80, height: 230 });
    });

    it('aligns resized west and north edges while keeping opposite edges fixed', () => {
        expect(snapResizeRect(
            { x: 96, y: 20, width: 104, height: 70 },
            { w: true },
            [VERTICAL_OTHER],
            { minWidth: 50, minHeight: 50 },
        )).toEqual({ x: 100, y: 20, width: 100, height: 70 });

        expect(snapResizeRect(
            { x: 10, y: 96, width: 80, height: 104 },
            { n: true },
            [HORIZONTAL_OTHER],
            { minWidth: 50, minHeight: 50 },
        )).toEqual({ x: 10, y: 100, width: 80, height: 100 });
    });

    it('does not snap if that would violate minimum size', () => {
        expect(snapResizeRect(
            { x: 294, y: 20, width: 56, height: 70 },
            { w: true },
            [VERTICAL_OTHER],
            { minWidth: 60, minHeight: 50 },
        )).toEqual({ x: 294, y: 20, width: 56, height: 70 });
    });

    it('snaps to nearby edges even when the rectangles do not overlap on the other axis', () => {
        expect(snapResizeRect(
            { x: 10, y: 20, width: 86, height: 70 },
            { e: true },
            [{ x: 100, y: 200, width: 200, height: 100 }],
            { minWidth: 50, minHeight: 50 },
        )).toEqual({ x: 10, y: 20, width: 90, height: 70 });

        expect(snapResizeRect(
            { x: 10, y: 20, width: 80, height: 86 },
            { s: true },
            [{ x: 200, y: 100, width: 100, height: 200 }],
            { minWidth: 50, minHeight: 50 },
        )).toEqual({ x: 10, y: 20, width: 80, height: 80 });
    });
});
