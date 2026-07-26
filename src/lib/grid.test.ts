import { describe, expect, it } from 'vitest';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopIcon } from '@bindings/DesktopIcon';
import type { DesktopScan } from '@bindings/DesktopScan';
import { GRID, allocateSlots, arrangeFreeIcons, displayName, reconcileConfig, snapToGrid } from './grid';

const VIEWPORT = { width: 1920, height: 1080 };

function icon(path: string, x = -1, y = -1): DesktopIcon {
    return { id: path, name: displayName(path, false), path, icon_path: null, pos_x: x, pos_y: y };
}

function cfg(partial?: Partial<DeskConfig>): DeskConfig {
    return {
        version: 3,
        cells: [],
        free_icons: [],
        auto_arrange: false,
        snap_to_grid: true,
        show_titles: true,
        theme: 'auto',
        ...partial,
    };
}

function scan(paths: string[], dirs = ['C:\\Users\\me\\Desktop']): DesktopScan {
    return { dirs, entries: paths.map((path) => ({ path, is_dir: false })) };
}

describe('snapToGrid', () => {
    it('snaps to the nearest slot origin and never goes negative', () => {
        expect(snapToGrid(0, 0)).toEqual({ x: GRID.originX, y: GRID.originY });
        expect(snapToGrid(-500, -500)).toEqual({ x: GRID.originX, y: GRID.originY });
        const nearSecondCol = GRID.originX + GRID.cellW + 5;
        expect(snapToGrid(nearSecondCol, 0).x).toBe(GRID.originX + GRID.cellW);
    });
});

describe('allocateSlots', () => {
    it('fills column-major: top to bottom, then next column', () => {
        const rows = Math.floor((VIEWPORT.height - GRID.originY) / GRID.cellH);
        const slots = allocateSlots(rows + 1, [], [], VIEWPORT);
        expect(slots[0]).toEqual({ x: GRID.originX, y: GRID.originY });
        expect(slots[1]).toEqual({ x: GRID.originX, y: GRID.originY + GRID.cellH });
        // First slot of the second column comes after the first column is full
        expect(slots[rows]).toEqual({ x: GRID.originX + GRID.cellW, y: GRID.originY });
    });

    it('skips occupied slots and slots covered by cells', () => {
        const occupied = [{ x: GRID.originX, y: GRID.originY }];
        // A cell covering the second slot of the first column
        const cells = [{ x: 0, y: GRID.originY + GRID.cellH, width: 200, height: 50 }];
        const [first] = allocateSlots(1, occupied, cells, VIEWPORT);
        expect(first).toEqual({ x: GRID.originX, y: GRID.originY + 2 * GRID.cellH });
    });

    it('reuses slots instead of going offscreen when the desktop is full', () => {
        const slots = allocateSlots(10, [], [], { width: 100, height: 120 }); // 1×1 grid
        expect(slots).toHaveLength(10);
        expect(slots.every((s) => s.x === GRID.originX && s.y === GRID.originY)).toBe(true);
    });
});

describe('reconcileConfig', () => {
    it('adds new desktop files into free grid slots', () => {
        const result = reconcileConfig(cfg(), scan(['C:\\Users\\me\\Desktop\\a.txt']), VIEWPORT);
        expect(result.free_icons).toHaveLength(1);
        expect(result.free_icons[0]!.name).toBe('a');
        expect(result.free_icons[0]!.pos_x).toBe(GRID.originX);
        expect(result.free_icons[0]!.pos_y).toBe(GRID.originY);
    });

    it('removes desktop-owned icons whose file disappeared (free and in cells)', () => {
        const config = cfg({
            free_icons: [icon('C:\\Users\\me\\Desktop\\gone.txt', 10, 6)],
            cells: [{
                id: 'c1', title: 'Cell',
                rect: { x: 500, y: 500, width: 320, height: 240 },
                background_color: null, opacity: 0.85, layout: 'Grid', collapsed: false,
                icons: [icon('C:\\Users\\me\\Desktop\\also-gone.txt', 0, 0)],
            }],
        });
        const result = reconcileConfig(config, scan([]), VIEWPORT);
        expect(result.free_icons).toHaveLength(0);
        expect(result.cells[0]!.icons).toHaveLength(0);
    });

    it('never removes icons pointing outside the desktop dirs', () => {
        const config = cfg({ free_icons: [icon('D:\\elsewhere\\keep.txt', 10, 6)] });
        const result = reconcileConfig(config, scan([]), VIEWPORT);
        expect(result.free_icons).toHaveLength(1);
    });

    it('does not re-add files already organized into a cell', () => {
        const path = 'C:\\Users\\me\\Desktop\\in-cell.txt';
        const config = cfg({
            cells: [{
                id: 'c1', title: 'Cell',
                rect: { x: 500, y: 500, width: 320, height: 240 },
                background_color: null, opacity: 0.85, layout: 'Grid', collapsed: false,
                icons: [icon(path, 0, 0)],
            }],
        });
        const result = reconcileConfig(config, scan([path.toUpperCase()]), VIEWPORT);
        expect(result).toBe(config); // path match is case-insensitive → no change
    });

    it('assigns slots to sentinel (-1) icons without moving placed ones', () => {
        const placed = icon('C:\\Users\\me\\Desktop\\placed.txt', GRID.originX, GRID.originY);
        const config = cfg({ free_icons: [placed, icon('C:\\Users\\me\\Desktop\\new.txt')] });
        const result = reconcileConfig(
            config,
            scan(['C:\\Users\\me\\Desktop\\placed.txt', 'C:\\Users\\me\\Desktop\\new.txt']),
            VIEWPORT,
        );
        const kept = result.free_icons.find((i) => i.path.endsWith('placed.txt'))!;
        const added = result.free_icons.find((i) => i.path.endsWith('new.txt'))!;
        expect({ x: kept.pos_x, y: kept.pos_y }).toEqual({ x: GRID.originX, y: GRID.originY });
        // New icon lands in the next slot down, not on top of the placed one
        expect({ x: added.pos_x, y: added.pos_y }).toEqual({ x: GRID.originX, y: GRID.originY + GRID.cellH });
    });

    it('returns the identical object when nothing changed', () => {
        const config = cfg({ free_icons: [icon('C:\\Users\\me\\Desktop\\a.txt', 10, 6)] });
        expect(reconcileConfig(config, scan(['C:\\Users\\me\\Desktop\\a.txt']), VIEWPORT)).toBe(config);
    });
});

describe('arrangeFreeIcons', () => {
    it('compacts all icons column-major, keeping array order', () => {
        const config = cfg({
            free_icons: [icon('a', 500, 500), icon('b', 700, 300)],
        });
        const result = arrangeFreeIcons(config, VIEWPORT);
        expect({ x: result.free_icons[0]!.pos_x, y: result.free_icons[0]!.pos_y })
            .toEqual({ x: GRID.originX, y: GRID.originY });
        expect({ x: result.free_icons[1]!.pos_x, y: result.free_icons[1]!.pos_y })
            .toEqual({ x: GRID.originX, y: GRID.originY + GRID.cellH });
    });
});
