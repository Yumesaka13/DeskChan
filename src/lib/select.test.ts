import { describe, expect, it } from 'vitest';
import type { DesktopIcon } from '@bindings/DesktopIcon';
import { dragRect, iconsInRect, rectsIntersect, sameParentDir, ICON_BOX } from './select';

function icon(id: string, x: number, y: number): DesktopIcon {
    return { id, name: id, path: `C:\\D\\${id}.txt`, icon_path: null, pos_x: x, pos_y: y };
}

describe('dragRect', () => {
    it('normalizes corners dragged in any direction', () => {
        expect(dragRect(100, 80, 20, 10)).toEqual({ x: 20, y: 10, width: 80, height: 70 });
        expect(dragRect(20, 10, 100, 80)).toEqual({ x: 20, y: 10, width: 80, height: 70 });
    });
});

describe('rectsIntersect', () => {
    const base = { x: 10, y: 10, width: 50, height: 50 };
    it('detects overlap and rejects mere edge contact', () => {
        expect(rectsIntersect(base, { x: 40, y: 40, width: 50, height: 50 })).toBe(true);
        // Touching edges (zero-area overlap) is NOT a selection, like Windows
        expect(rectsIntersect(base, { x: 60, y: 10, width: 20, height: 20 })).toBe(false);
        expect(rectsIntersect(base, { x: 100, y: 100, width: 5, height: 5 })).toBe(false);
    });
});

describe('iconsInRect', () => {
    const icons = [icon('a', 10, 6), icon('b', 10, 106), icon('c', 500, 500), icon('ghost', -1, -1)];

    it('selects every icon the marquee touches, skipping unplaced ones', () => {
        const marquee = dragRect(0, 0, 20, 120); // crosses a and b columns
        expect(iconsInRect(icons, marquee)).toEqual(['a', 'b']);
    });

    it('a marquee inside one icon box still selects it', () => {
        const inside = dragRect(15, 15, 15 + 2, 15 + 2);
        expect(iconsInRect(icons, inside)).toEqual(['a']);
    });

    it('selects nothing when the marquee is in empty space', () => {
        const empty = dragRect(200, 6, 200 + ICON_BOX.width / 2, 50);
        expect(iconsInRect(icons, empty)).toEqual([]);
    });
});

describe('sameParentDir', () => {
    it('is case-insensitive and separator-tolerant', () => {
        expect(sameParentDir('C:\\Users\\me\\Desktop\\a.txt', 'c:\\users\\me\\desktop\\B.lnk')).toBe(true);
        expect(sameParentDir('C:\\Users\\me\\Desktop\\a.txt', 'C:\\Users\\Public\\Desktop\\b.txt')).toBe(false);
    });
});
