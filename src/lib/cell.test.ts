import { describe, expect, it } from 'vitest';
import type { Cell } from '@bindings/Cell';
import type { DesktopIcon } from '@bindings/DesktopIcon';
import { activeIcons, allIcons, deleteSubCell, removeIcon, reorderIcons, totalIconCount, withActiveIcons } from './cell';

function icon(id: string): DesktopIcon {
    return { id, name: id, path: `C:\\D\\${id}.txt`, icon_path: null, pos_x: 0, pos_y: 0 };
}

function cell(partial?: Partial<Cell>): Cell {
    return {
        id: 'c1', title: 'Cell',
        rect: { x: 0, y: 0, width: 320, height: 240 },
        background_color: null, opacity: 0.85, layout: 'Grid',
        collapsed: false, hover_expand: true,
        icons: [icon('a')],
        sub_cells: [
            { id: 's1', title: 'Sub 1', icons: [icon('b')] },
            { id: 's2', title: 'Sub 2', icons: [icon('c'), icon('d')] },
        ],
        active_sub: null,
        sub_style: 'Compact', show_title: true,
        ...partial,
    };
}

describe('activeIcons / withActiveIcons', () => {
    it('targets the cell own icons when no sub is active', () => {
        const c = cell();
        expect(activeIcons(c).map((i) => i.id)).toEqual(['a']);
        const next = withActiveIcons(c, (icons) => [...icons, icon('x')]);
        expect(next.icons.map((i) => i.id)).toEqual(['a', 'x']);
        expect(next.sub_cells).toBe(c.sub_cells); // untouched
    });

    it('targets the active sub-box, leaving siblings alone', () => {
        const c = cell({ active_sub: 's2' });
        expect(activeIcons(c).map((i) => i.id)).toEqual(['c', 'd']);
        const next = withActiveIcons(c, (icons) => icons.slice(1));
        expect(next.sub_cells[1]!.icons.map((i) => i.id)).toEqual(['d']);
        expect(next.sub_cells[0]).toBe(c.sub_cells[0]);
        expect(next.icons).toBe(c.icons);
    });

    it('falls back to own icons when active_sub points at a deleted sub', () => {
        const c = cell({ active_sub: 'ghost' });
        expect(activeIcons(c).map((i) => i.id)).toEqual(['a']);
    });
});

describe('removeIcon', () => {
    it('removes from whichever container holds the icon', () => {
        const c = cell();
        expect(totalIconCount(removeIcon(c, 'a'))).toBe(3);
        expect(totalIconCount(removeIcon(c, 'c'))).toBe(3);
        expect(removeIcon(c, 'c').sub_cells[1]!.icons.map((i) => i.id)).toEqual(['d']);
    });
});

describe('allIcons', () => {
    it('spans the own tab and every sub-box', () => {
        expect(allIcons(cell()).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    });
});

describe('reorderIcons', () => {
    const list = [icon('a'), icon('b'), icon('c')];

    it('moves before and after a target', () => {
        expect(reorderIcons(list, 'c', 'a', true).map((i) => i.id)).toEqual(['c', 'a', 'b']);
        expect(reorderIcons(list, 'a', 'c', false).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    });

    it('moves to the end when there is no target', () => {
        expect(reorderIcons(list, 'a', null, false).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    });

    it('returns the same array for no-ops', () => {
        expect(reorderIcons(list, 'a', 'a', true)).toBe(list);
        expect(reorderIcons(list, 'a', 'b', true)).toBe(list); // already before b
        expect(reorderIcons(list, 'ghost', 'a', true)).toBe(list);
    });
});

describe('deleteSubCell', () => {
    it('moves the sub icons into the own tab and clears the selection', () => {
        const c = cell({ active_sub: 's2' });
        const next = deleteSubCell(c, 's2');
        expect(next.icons.map((i) => i.id)).toEqual(['a', 'c', 'd']);
        expect(next.sub_cells.map((s) => s.id)).toEqual(['s1']);
        expect(next.active_sub).toBeNull();
        expect(totalIconCount(next)).toBe(totalIconCount(c));
    });

    it('keeps an unrelated selection', () => {
        const next = deleteSubCell(cell({ active_sub: 's1' }), 's2');
        expect(next.active_sub).toBe('s1');
    });
});

