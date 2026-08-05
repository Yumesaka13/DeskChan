/**
 * Windows-like desktop grid + desktop<->config reconcile logic.
 *
 * Free icons live in fixed-size slots filled top-to-bottom, then
 * left-to-right (column-major) - exactly like the native desktop. All
 * functions here are pure so they can be unit-tested; the -1 position
 * sentinel marks icons that still need a slot assigned.
 */
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopIcon } from '@bindings/DesktopIcon';
import type { DesktopScan } from '@bindings/DesktopScan';
import type { Cell } from '@bindings/Cell';
import type { CellRect } from '@bindings/CellRect';

/** Slot metrics (CSS px) - close to Windows 11 medium-icon spacing. */
export const GRID = { cellW: 76, cellH: 100, originX: 10, originY: 6 } as const;

/** Height of a cell's title bar - also a collapsed cell's full height. */
export const CELL_TITLEBAR_H = 32;

/** The screen space a cell actually occupies - collapsed cells free up
 *  everything below their title bar (for drops and slot allocation). */
export function effectiveCellRect(c: Cell): CellRect {
    return c.collapsed ? { ...c.rect, height: CELL_TITLEBAR_H } : c.rect;
}

export interface Size {
    width: number;
    height: number;
}

export type SortField = 'name' | 'type' | 'modified';
export type SortDirection = 'asc' | 'desc';

function slotPos(col: number, row: number): { x: number; y: number } {
    return { x: GRID.originX + col * GRID.cellW, y: GRID.originY + row * GRID.cellH };
}

function slotKey(x: number, y: number): string {
    const col = Math.max(0, Math.round((x - GRID.originX) / GRID.cellW));
    const row = Math.max(0, Math.round((y - GRID.originY) / GRID.cellH));
    return `${col},${row}`;
}

/** Snap a free-icon top-left position to the nearest grid slot. */
export function snapToGrid(x: number, y: number): { x: number; y: number } {
    const col = Math.max(0, Math.round((x - GRID.originX) / GRID.cellW));
    const row = Math.max(0, Math.round((y - GRID.originY) / GRID.cellH));
    return slotPos(col, row);
}

/** Does the slot at (x, y) overlap any cell? Icons must not spawn under cells. */
function coveredByCell(cells: CellRect[], x: number, y: number): boolean {
    return cells.some(
        (c) => x < c.x + c.width && x + GRID.cellW > c.x && y < c.y + c.height && y + GRID.cellH > c.y,
    );
}

/**
 * Column-major slot allocator: returns `count` positions, skipping slots
 * already occupied by icons or covered by cells. If the screen fills up, a
 * second pass reuses taken slots (visible overlap beats offscreen icons).
 */
export function allocateSlots(
    count: number,
    occupied: { x: number; y: number }[],
    cells: CellRect[],
    viewport: Size,
): { x: number; y: number }[] {
    const taken = new Set(occupied.map((p) => slotKey(p.x, p.y)));
    const rows = Math.max(1, Math.floor((viewport.height - GRID.originY) / GRID.cellH));
    const cols = Math.max(1, Math.floor((viewport.width - GRID.originX) / GRID.cellW));
    const out: { x: number; y: number }[] = [];
    for (let pass = 0; pass < 2 && out.length < count; pass++) {
        for (let col = 0; col < cols && out.length < count; col++) {
            for (let row = 0; row < rows && out.length < count; row++) {
                const pos = slotPos(col, row);
                if (pass === 0 && (taken.has(slotKey(pos.x, pos.y)) || coveredByCell(cells, pos.x, pos.y))) {
                    continue;
                }
                taken.add(slotKey(pos.x, pos.y));
                out.push(pos);
            }
        }
    }
    while (out.length < count) out.push(slotPos(0, 0)); // pathological overflow
    return out;
}

/**
 * Snap a drop position to the nearest slot NOT occupied by another icon and
 * not covered by a cell - Windows never stacks icons when snapping is on.
 * Falls back to plain snapping when every slot is taken.
 */
export function nearestFreeSlot(
    x: number,
    y: number,
    occupied: { x: number; y: number }[],
    cells: CellRect[],
    viewport: Size,
): { x: number; y: number } {
    const taken = new Set(occupied.map((p) => slotKey(p.x, p.y)));
    const rows = Math.max(1, Math.floor((viewport.height - GRID.originY) / GRID.cellH));
    const cols = Math.max(1, Math.floor((viewport.width - GRID.originX) / GRID.cellW));
    let best: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
            const pos = slotPos(col, row);
            if (taken.has(slotKey(pos.x, pos.y)) || coveredByCell(cells, pos.x, pos.y)) continue;
            const dist = (pos.x - x) ** 2 + (pos.y - y) ** 2;
            if (dist < bestDist) {
                bestDist = dist;
                best = pos;
            }
        }
    }
    return best ?? snapToGrid(x, y);
}

/** Display name for a path: basename; files additionally hide the extension. */
export function displayName(path: string, isDir: boolean): string {
    const base = path.split(/[\\/]/).pop() ?? path;
    if (isDir) return base;
    const stem = base.replace(/\.[^.]+$/, '');
    return stem || base;
}

/**
 * Resolve the label for a saved desktop icon. Icon names are persisted without
 * file extensions, while folders retain their full names. Comparing the saved
 * name with the path stem lets the UI restore an extension for files without
 * mistaking a folder named "archive.zip" for a file.
 */
export function displayIconName(
    icon: Pick<DesktopIcon, 'name' | 'path'>,
    showFileExtensions: boolean,
    showShortcutExtensions = false,
): string {
    const base = icon.path.split(/[\\/]/).pop() ?? icon.path;
    const stem = base.replace(/(?<=.)\.[^.]+$/, '');
    if (base === stem || icon.name !== stem) return icon.name;
    if (base.toLowerCase().endsWith('.lnk')) return showShortcutExtensions ? base : stem;
    return showFileExtensions ? base : stem;
}

/** Parent directory of a path, lowercased (for desktop-ownership checks). */
function parentDirLower(path: string): string {
    const low = pathKey(path);
    return low.slice(0, Math.max(low.lastIndexOf('\\'), low.lastIndexOf('/')));
}

/** Stable Windows path identity for persisted and freshly scanned entries. */
function pathKey(path: string): string {
    const lower = path.replace(/\//g, '\\').toLowerCase();
    const withoutDevicePrefix = lower.startsWith('\\\\?\\unc\\')
        ? `\\\\${lower.slice(8)}`
        : lower.startsWith('\\\\?\\')
            ? lower.slice(4)
            : lower;
    return withoutDevicePrefix.replace(/\\+$/, '');
}

/**
 * Remove visual duplicates for the same file across the free desktop, cells,
 * and sub-cells. A file has one desktop representation, so keeping more than
 * one stale copy lets a rename or watcher event render it twice. When a
 * caller supplies an ID, retain that icon even if a duplicate appears earlier
 * in the config; this preserves the location of the icon the user acted on.
 */
export function deduplicateConfigIcons(cfg: DeskConfig, preferredIconId?: string): DeskConfig {
    const winners = new Map<string, DesktopIcon>();
    const consider = (icon: DesktopIcon) => {
        const key = pathKey(icon.path);
        const current = winners.get(key);
        if (!current || icon.id === preferredIconId) winners.set(key, icon);
    };
    cfg.free_icons.forEach(consider);
    cfg.cells.forEach((cell) => {
        cell.icons.forEach(consider);
        cell.sub_cells.forEach((subCell) => subCell.icons.forEach(consider));
    });

    const keep = (icons: DesktopIcon[]) => icons.filter((icon) => winners.get(pathKey(icon.path)) === icon);
    const free_icons = keep(cfg.free_icons);
    const cells = cfg.cells.map((cell) => {
        const icons = keep(cell.icons);
        const sub_cells = cell.sub_cells.map((subCell) => {
            const subIcons = keep(subCell.icons);
            return subIcons.length === subCell.icons.length ? subCell : { ...subCell, icons: subIcons };
        });
        const subCellsChanged = sub_cells.some((subCell, index) => subCell !== cell.sub_cells[index]);
        return icons.length === cell.icons.length && !subCellsChanged
            ? cell
            : { ...cell, icons, sub_cells: subCellsChanged ? sub_cells : cell.sub_cells };
    });
    const changed =
        free_icons.length !== cfg.free_icons.length ||
        cells.some((cell, index) => cell !== cfg.cells[index]);
    return changed ? { ...cfg, free_icons, cells } : cfg;
}

/**
 * Sync the config with a desktop scan:
 * - drop desktop-owned icons (free AND in-cell) whose file disappeared
 * - add icons for new desktop files
 * - assign grid slots to every icon carrying the "unplaced" sentinel (pos < 0)
 *
 * Icons pointing outside the desktop dirs (added via dialog) are never
 * removed by a scan alone; callers can pass paths explicitly removed by a
 * native MOVE. Returns the SAME object when nothing changed, so callers can
 * skip re-render / config save.
 */
export function reconcileConfig(
    cfg: DeskConfig,
    scan: DesktopScan,
    viewport: Size,
    removedPaths: readonly string[] = [],
): DeskConfig {
    const dirs = new Set(scan.dirs.map(pathKey));
    const present = new Set(scan.entries.map((e) => pathKey(e.path)));
    const explicitlyRemoved = new Set(removedPaths.map(pathKey));
    const gone = (p: string) => explicitlyRemoved.has(pathKey(p))
        || (dirs.has(parentDirLower(p)) && !present.has(pathKey(p)));

    const freeKept = cfg.free_icons.filter((i) => !gone(i.path));
    // Preserve object identity for untouched cells - Desktop's <For> keys by
    // reference, so a new object recreates the whole CellBox mid-gesture
    // (dropping live hover/resize state) even when the cell didn't change.
    const cells = cfg.cells.map((c) => {
        const icons = c.icons.filter((i) => !gone(i.path));
        const subs = c.sub_cells.map((s) => {
            const kept = s.icons.filter((i) => !gone(i.path));
            return kept.length === s.icons.length ? s : { ...s, icons: kept };
        });
        const subsChanged = subs.some((s, n) => s !== c.sub_cells[n]);
        if (icons.length === c.icons.length && !subsChanged) return c;
        return { ...c, icons, sub_cells: subsChanged ? subs : c.sub_cells };
    });

    const deduplicated = deduplicateConfigIcons({ ...cfg, free_icons: freeKept, cells });
    const canonicalFree = deduplicated.free_icons;
    const canonicalCells = deduplicated.cells;
    const known = new Set([
        ...canonicalFree.map((i) => pathKey(i.path)),
        ...canonicalCells.flatMap((c) => [
            ...c.icons.map((i) => pathKey(i.path)),
            ...c.sub_cells.flatMap((s) => s.icons.map((i) => pathKey(i.path))),
        ]),
    ]);
    const fresh: DesktopIcon[] = scan.entries
        .filter((e) => !known.has(pathKey(e.path)))
        .map((e) => ({
            id: crypto.randomUUID(),
            name: displayName(e.path, e.is_dir),
            path: e.path,
            icon_path: null,
            pos_x: -1,
            pos_y: -1,
        }));

    let free = [...canonicalFree, ...fresh];
    const unplaced = free.filter((i) => i.pos_x < 0 || i.pos_y < 0);
    if (unplaced.length > 0) {
        const occupied = free
            .filter((i) => i.pos_x >= 0 && i.pos_y >= 0)
            .map((i) => ({ x: i.pos_x, y: i.pos_y }));
        const slots = allocateSlots(unplaced.length, occupied, canonicalCells.map(effectiveCellRect), viewport);
        const slotById = new Map(unplaced.map((icon, n) => [icon.id, slots[n]!]));
        free = free.map((i) => {
            const s = slotById.get(i.id);
            return s ? { ...i, pos_x: s.x, pos_y: s.y } : i;
        });
    }

    const changed =
        fresh.length > 0 ||
        unplaced.length > 0 ||
        free.length !== cfg.free_icons.length ||
        canonicalCells.some((c, n) => c !== cfg.cells[n]);
    return changed ? { ...cfg, cells: canonicalCells, free_icons: free } : cfg;
}

/** Re-lay out ALL free icons compactly in column-major order (auto-arrange). */
export function arrangeFreeIcons(cfg: DeskConfig, viewport: Size): DeskConfig {
    const slots = allocateSlots(cfg.free_icons.length, [], cfg.cells.map(effectiveCellRect), viewport);
    return {
        ...cfg,
        free_icons: cfg.free_icons.map((i, n) => ({ ...i, pos_x: slots[n]!.x, pos_y: slots[n]!.y })),
    };
}

/** Sort free desktop icons using the latest native scan, then place them in
 * Windows-style grid order. Entries not present in a scan sort after known
 * desktop entries so visual-only items remain stable and visible. */
export function sortFreeIcons(
    cfg: DeskConfig,
    scan: DesktopScan,
    field: SortField,
    direction: SortDirection,
    viewport: Size,
): DeskConfig {
    const metadata = new Map(scan.entries.map((entry) => [entry.path.toLowerCase(), entry]));
    const typeOf = (path: string) => {
        const entry = metadata.get(path.toLowerCase());
        if (!entry) return '\uffff';
        if (entry.is_dir) return 'folder';
        return path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
    };
    const compareText = (left: string, right: string) => left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: 'base',
    });
    const multiplier = direction === 'asc' ? 1 : -1;
    const free_icons = [...cfg.free_icons].sort((left, right) => {
        const leftEntry = metadata.get(left.path.toLowerCase());
        const rightEntry = metadata.get(right.path.toLowerCase());
        let result: number;
        if (field === 'modified') {
            result = (leftEntry?.modified_at_millis ?? -1) - (rightEntry?.modified_at_millis ?? -1);
        } else if (field === 'type') {
            result = compareText(typeOf(left.path), typeOf(right.path));
        } else {
            result = compareText(left.name, right.name);
        }
        return (result || compareText(left.name, right.name)) * multiplier;
    });
    return arrangeFreeIcons({ ...cfg, free_icons }, viewport);
}
