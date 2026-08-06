/**
 * Magnetic edge snapping for cell move/resize - pure logic, Fences-style.
 * Each active axis independently attracts to nearby cells' edges within a
 * small threshold, so cells line up flush without pixel hunting.
 */
import type { CellRect } from '@bindings/CellRect';

export const SNAP_THRESHOLD = 8;

export interface ResizeEdges {
    n?: boolean;
    s?: boolean;
    e?: boolean;
    w?: boolean;
}

export interface ResizeSnapOptions {
    minWidth: number;
    minHeight: number;
    threshold?: number;
}

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

function nearestEdge(
    edge: number,
    candidates: readonly number[],
    threshold: number,
): number | null {
    let best = { d: threshold + 1, v: edge };
    for (const cand of candidates) {
        const d = Math.abs(cand - edge);
        if (d < best.d) best = { d, v: cand };
    }
    return best.d <= threshold ? best.v : null;
}

/** Snap only the actively resized edge(s), keeping the opposite side fixed. */
export function snapResizeRect(
    rect: CellRect,
    edges: ResizeEdges,
    others: readonly CellRect[],
    options: ResizeSnapOptions,
): CellRect {
    const threshold = options.threshold ?? SNAP_THRESHOLD;
    const verticalEdges = others.flatMap((o) => [o.x, o.x + o.width]);
    const horizontalEdges = others.flatMap((o) => [o.y, o.y + o.height]);
    let { x, y, width, height } = rect;

    if (edges.w && !edges.e) {
        const right = x + width;
        const snapped = nearestEdge(x, verticalEdges, threshold);
        if (snapped !== null && snapped >= 0 && right - snapped >= options.minWidth) {
            x = snapped;
            width = right - snapped;
        }
    } else if (edges.e && !edges.w) {
        const snapped = nearestEdge(x + width, verticalEdges, threshold);
        if (snapped !== null && snapped - x >= options.minWidth) {
            width = snapped - x;
        }
    }

    if (edges.n && !edges.s) {
        const bottom = y + height;
        const snapped = nearestEdge(y, horizontalEdges, threshold);
        if (snapped !== null && snapped >= 0 && bottom - snapped >= options.minHeight) {
            y = snapped;
            height = bottom - snapped;
        }
    } else if (edges.s && !edges.n) {
        const snapped = nearestEdge(y + height, horizontalEdges, threshold);
        if (snapped !== null && snapped - y >= options.minHeight) {
            height = snapped - y;
        }
    }

    return { x, y, width, height };
}
