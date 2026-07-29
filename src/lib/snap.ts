/**
 * Magnetic edge snapping for cell drags - pure logic, Fences-style.
 * While a cell is being moved, each axis independently attracts to nearby
 * cells' edges within a small threshold: same-edge alignment (left<->left,
 * right<->right) and adjacency (my left to their right and vice versa), so
 * cells line up flush or butt against each other without pixel hunting.
 */
import type { CellRect } from '@bindings/CellRect';

export const SNAP_THRESHOLD = 8;

/** Snap a proposed top-left position of a widthxheight box against the
 *  other boxes; the nearest candidate within the threshold wins per axis. */
export function snapPosition(
    x: number,
    y: number,
    width: number,
    height: number,
    others: readonly CellRect[],
    threshold: number = SNAP_THRESHOLD,
): { x: number; y: number } {
    let bestX = { d: threshold + 1, v: x };
    let bestY = { d: threshold + 1, v: y };
    for (const o of others) {
        for (const cand of [o.x, o.x + o.width, o.x - width, o.x + o.width - width]) {
            const d = Math.abs(cand - x);
            if (d < bestX.d) bestX = { d, v: cand };
        }
        for (const cand of [o.y, o.y + o.height, o.y - height, o.y + o.height - height]) {
            const d = Math.abs(cand - y);
            if (d < bestY.d) bestY = { d, v: cand };
        }
    }
    return { x: bestX.v, y: bestY.v };
}
