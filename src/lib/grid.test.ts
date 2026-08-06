import { describe, expect, it } from 'vitest';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopIcon } from '@bindings/DesktopIcon';
import type { DesktopScan } from '@bindings/DesktopScan';
import { GRID, allocateSlots, arrangeFreeIcons, deduplicateConfigIcons, displayIconName, displayName, reconcileConfig, snapToGrid, sortFreeIcons } from './grid';

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
        theme: 'auto',
        ...partial,
        use_styled_file_menu: partial?.use_styled_file_menu ?? true,
        show_file_extensions: partial?.show_file_extensions ?? true,
        show_shortcut_extensions: partial?.show_shortcut_extensions ?? false,
        excluded_from_organize: partial?.excluded_from_organize ?? [],
        desktop_overlay_opacity: partial?.desktop_overlay_opacity ?? 0.01,
    };
}

function scan(paths: string[], dirs = ['C:\\Users\\me\\Desktop']): DesktopScan {
    return { dirs, entries: paths.map((path) => ({ path, is_dir: false, modified_at_millis: 0 })) };
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
        const slots = allocateSlots(10, [], [], { width: 100, height: 120 }); // 1\u81331 grid
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
                sort_field: 'name', sort_direction: 'asc',
                hover_expand: true, sub_cells: [], active_sub: null, sub_style: 'Compact', show_title: true,
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

    it('removes explicitly moved external icons', () => {
        const externalPath = 'D:\\elsewhere\\moved.txt';
        const config = cfg({ free_icons: [icon(externalPath, 10, 6)] });
        const result = reconcileConfig(config, scan([]), VIEWPORT, [externalPath]);
        expect(result.free_icons).toHaveLength(0);
    });

    it('does not re-add files already organized into a cell', () => {
        const path = 'C:\\Users\\me\\Desktop\\in-cell.txt';
        const config = cfg({
            cells: [{
                id: 'c1', title: 'Cell',
                rect: { x: 500, y: 500, width: 320, height: 240 },
                background_color: null, opacity: 0.85, layout: 'Grid', collapsed: false,
                sort_field: 'name', sort_direction: 'asc',
                hover_expand: true, sub_cells: [], active_sub: null, sub_style: 'Compact', show_title: true,
                icons: [icon(path, 0, 0)],
            }],
        });
        const result = reconcileConfig(config, scan([path.toUpperCase()]), VIEWPORT);
        expect(result).toBe(config); // path match is case-insensitive \u922B?no change
    });

    it('removes duplicate paths across free icons, cells, and sub-cells', () => {
        const path = 'C:\\Users\\me\\Desktop\\single.txt';
        const free = icon(path, GRID.originX, GRID.originY);
        const cellIcon = { ...icon(path, 0, 0), id: 'in-cell' };
        const subIcon = { ...icon(path, 0, 0), id: 'in-sub-cell' };
        const config = cfg({
            free_icons: [free],
            cells: [{
                id: 'c1', title: 'Cell',
                rect: { x: 500, y: 500, width: 320, height: 240 },
                background_color: null, opacity: 0.85, layout: 'Grid', collapsed: false,
                sort_field: 'name', sort_direction: 'asc', hover_expand: true,
                sub_cells: [{ id: 's1', title: 'Sub', icons: [subIcon] }],
                active_sub: null, sub_style: 'Compact', show_title: true,
                icons: [cellIcon],
            }],
        });

        const result = reconcileConfig(config, scan([path]), VIEWPORT);
        expect(result.free_icons).toEqual([free]);
        expect(result.cells[0]!.icons).toEqual([]);
        expect(result.cells[0]!.sub_cells[0]!.icons).toEqual([]);
    });

    it('treats slash variants of the same Windows path as one icon', () => {
        const backslashPath = 'C:\\Users\\me\\Desktop\\slash-variant.txt';
        const config = cfg({
            free_icons: [
                icon('C:/Users/me/Desktop/slash-variant.txt', GRID.originX, GRID.originY),
                icon(backslashPath, GRID.originX + GRID.cellW, GRID.originY),
            ],
        });
        const result = reconcileConfig(config, scan([backslashPath]), VIEWPORT);
        expect(result.free_icons).toHaveLength(1);
        expect(result.free_icons[0]!.path).toBe('C:/Users/me/Desktop/slash-variant.txt');
    });

    it('treats a Windows device path and its normal path as one icon', () => {
        const normalPath = 'D:\\Desktop\\device-variant.txt';
        const config = cfg({
            free_icons: [
                icon('\\\\?\\D:\\Desktop\\device-variant.txt', GRID.originX, GRID.originY),
                icon(normalPath, GRID.originX + GRID.cellW, GRID.originY),
            ],
        });
        const result = reconcileConfig(config, scan([normalPath], ['D:\\Desktop']), VIEWPORT);
        expect(result.free_icons).toHaveLength(1);
    });

    it('keeps the preferred icon when resolving a duplicate path', () => {
        const path = 'C:\\Users\\me\\Desktop\\renamed.txt';
        const free = icon(path, GRID.originX, GRID.originY);
        const selected = { ...icon(path, 0, 0), id: 'renamed-icon' };
        const config = cfg({
            free_icons: [free],
            cells: [{
                id: 'c1', title: 'Cell',
                rect: { x: 500, y: 500, width: 320, height: 240 },
                background_color: null, opacity: 0.85, layout: 'Grid', collapsed: false,
                sort_field: 'name', sort_direction: 'asc', hover_expand: true,
                sub_cells: [], active_sub: null, sub_style: 'Compact', show_title: true,
                icons: [selected],
            }],
        });

        const result = deduplicateConfigIcons(config, selected.id);
        expect(result.free_icons).toEqual([]);
        expect(result.cells[0]!.icons).toEqual([selected]);
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

describe('displayIconName', () => {
    it('restores a file extension from the path when enabled', () => {
        const report = icon('C:\\Users\\me\\Desktop\\report.final.pdf');
        expect(report.name).toBe('report.final');
        expect(displayIconName(report, true)).toBe('report.final.pdf');
        expect(displayIconName(report, false)).toBe('report.final');
    });

    it('does not treat a folder-like saved name as a removable extension', () => {
        const folder: DesktopIcon = {
            ...icon('C:\\Users\\me\\Desktop\\archive.zip'),
            name: 'archive.zip',
        };
        expect(displayIconName(folder, true)).toBe('archive.zip');
        expect(displayIconName(folder, false)).toBe('archive.zip');
    });

    it('controls shortcut extensions separately from other file extensions', () => {
        const shortcut = icon('C:\\Users\\me\\Desktop\\DeskChan.lnk');
        expect(displayIconName(shortcut, true, false)).toBe('DeskChan');
        expect(displayIconName(shortcut, true, true)).toBe('DeskChan.lnk');
        expect(displayIconName(shortcut, false, true)).toBe('DeskChan.lnk');
    });
});

describe('sortFreeIcons', () => {
    it('sorts by name, type, and modification time in either direction', () => {
        const config = cfg({
            free_icons: [
                icon('C:\\Users\\me\\Desktop\\zeta.txt', 0, 0),
                icon('C:\\Users\\me\\Desktop\\Alpha.png', 0, 0),
                icon('C:\\Users\\me\\Desktop\\Folder', 0, 0),
            ],
        });
        const desktopScan: DesktopScan = {
            dirs: ['C:\\Users\\me\\Desktop'],
            entries: [
                { path: 'C:\\Users\\me\\Desktop\\zeta.txt', is_dir: false, modified_at_millis: 20 },
                { path: 'C:\\Users\\me\\Desktop\\Alpha.png', is_dir: false, modified_at_millis: 30 },
                { path: 'C:\\Users\\me\\Desktop\\Folder', is_dir: true, modified_at_millis: 10 },
            ],
        };
        expect(sortFreeIcons(config, desktopScan, 'name', 'asc', VIEWPORT).free_icons.map((item) => item.name))
            .toEqual(['Alpha', 'Folder', 'zeta']);
        expect(sortFreeIcons(config, desktopScan, 'type', 'asc', VIEWPORT).free_icons.map((item) => item.name))
            .toEqual(['Folder', 'Alpha', 'zeta']);
        expect(sortFreeIcons(config, desktopScan, 'modified', 'desc', VIEWPORT).free_icons.map((item) => item.name))
            .toEqual(['Alpha', 'zeta', 'Folder']);
    });
});

