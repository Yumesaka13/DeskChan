/**
 * Marquee (rubber-band) selection helpers — pure logic, testable without DOM.
 * Free desktop icons are selected when their bounding box intersects the
 * dragged rectangle, matching native Windows behavior.
 */
import type { DesktopIcon } from '@bindings/DesktopIcon';
import { GRID } from './grid';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Visual footprint of one free icon (slot-sized, like Explorer's hit box). */
export const ICON_BOX = { width: GRID.cellW, height: GRID.cellH } as const;

/** Convert two drag corners (any order) into a normalized rectangle. */
export function dragRect(x0: number, y0: number, x1: number, y1: number): Rect {
    return {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0),
    };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
    return (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
    );
}

/** Ids of free icons whose box intersects the marquee. Skips unplaced
 *  (sentinel-positioned) icons — they are not visible yet. */
export function iconsInRect(icons: readonly DesktopIcon[], marquee: Rect): string[] {
    return icons
        .filter((i) => i.pos_x >= 0 && i.pos_y >= 0)
        .filter((i) =>
            rectsIntersect(marquee, {
                x: i.pos_x,
                y: i.pos_y,
                width: ICON_BOX.width,
                height: ICON_BOX.height,
            }),
        )
        .map((i) => i.id);
}

/** Windows parent-directory equality (case-insensitive, both separators). */
export function sameParentDir(a: string, b: string): boolean {
    const parent = (p: string) => p.replace(/[\\/][^\\/]*$/, '').toLowerCase();
    return parent(a) === parent(b);
}
