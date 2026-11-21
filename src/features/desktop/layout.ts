import { createSignal, onCleanup } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';
import toast from 'solid-toast';
import type { Cell } from '@bindings/Cell';
import type { FileUndoRecord } from '@bindings/FileUndoRecord';
import { allIcons, removeIcon, withActiveIcons } from '~/lib/cell';
import {
    effectiveCellRect,
    nearestFreeSlot,
    sortFreeIcons,
    type SortDirection,
    type SortField,
} from '~/lib/grid';
import { organizeConfig, type CategoryKey } from '~/lib/organize';
import type { DesktopSession } from './session';
import { viewportSize, type Translate } from './types';

export type DesktopLayout = ReturnType<typeof createDesktopLayout>;

export function createDesktopLayout(session: DesktopSession, t: Translate) {
    const { config, commitConfig } = session;
    const [sortField, setSortField] = createSignal<SortField>('name');
    const [sortDirection, setSortDirection] = createSignal<SortDirection>('asc');
    // Hover-expand state lives here (not in CellBox) so it survives cell
    // component re-creation when the cell object is replaced by updateCell.
    const [hoverCellId, setHoverCellId] = createSignal<string | null>(null);
    let hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null;
    const cellHover = (id: string, inside: boolean) => {
        if (hoverLeaveTimer) {
            clearTimeout(hoverLeaveTimer);
            hoverLeaveTimer = null;
        }
        if (inside) {
            setHoverCellId(id);
        } else {
            // Small delay so brief pointer exits don't flap the roll-up
            hoverLeaveTimer = setTimeout(() => setHoverCellId((cur) => (cur === id ? null : cur)), 250);
        }
    };
    onCleanup(() => {
        if (hoverLeaveTimer) clearTimeout(hoverLeaveTimer);
    });
    const updateCell = (id: string, change: (cell: Cell) => Cell) =>
        commitConfig(t('history.edit_cell'), (current) => {
            const cell = current.cells.find((entry) => entry.id === id);
            if (!cell) return current;
            const next = change(cell);
            return next === cell
                ? current
                : {
                      ...current,
                      cells: current.cells.map((entry) => (entry === cell ? next : entry)),
                  };
        });

    const removeCell = (id: string) =>
        commitConfig(t('history.edit_cell'), (current) => ({
            ...current,
            cells: current.cells.filter((cell) => cell.id !== id),
        }));

    /** Move an existing visual icon, or add a new one, to a cell's active tab. */
    const addIconToCell = (cellId: string, filePath: string, file?: FileUndoRecord) => {
        const key = filePath.toLowerCase();
        commitConfig(
            t(file ? 'history.file_move' : 'history.move_into_cell'),
            (p) => {
                if (!p) return p;
                const existing = [...p.free_icons, ...p.cells.flatMap(allIcons)].find(
                    (icon) => icon.path.toLowerCase() === key,
                );
                const icon = existing ?? {
                    id: crypto.randomUUID(),
                    name:
                        filePath
                            .split(/[\\/]/)
                            .pop()
                            ?.replace(/\.[^.]+$/, '') ?? t('default.icon_name'),
                    path: filePath,
                    icon_path: null,
                    pos_x: 0,
                    pos_y: 0,
                };
                const cells = p.cells.map((cell) => removeIcon(cell, icon.id));
                return {
                    ...p,
                    free_icons: p.free_icons.filter((candidate) => candidate.id !== icon.id),
                    cells: cells.map((cell) =>
                        cell.id === cellId ? withActiveIcons(cell, (icons) => [...icons, icon]) : cell,
                    ),
                };
            },
            file,
        );
    };

    /** Find which cell (if any) is at the given coordinates. DOM hit-testing
     *  reflects what the user actually sees - a rolled-up cell only occupies
     *  its title bar, a hover-expanded one its full box. */
    const cellAtPoint = (x: number, y: number): string | null =>
        document.elementFromPoint(x, y)?.closest('[data-cell-id]')?.getAttribute('data-cell-id') ?? null;

    /** Resolve a free-icon drop position - nearest unoccupied slot when snapping. */
    const resolveDropPos = (x: number, y: number, excludeIconId?: string): { x: number; y: number } => {
        const cfg = config();
        const px = Math.max(0, x);
        const py = Math.max(0, y);
        if (!cfg?.snap_to_grid) return { x: px, y: py };
        const occupied = cfg.free_icons
            .filter((i) => i.id !== excludeIconId && i.pos_x >= 0)
            .map((i) => ({ x: i.pos_x, y: i.pos_y }));
        return nearestFreeSlot(px, py, occupied, cfg.cells.map(effectiveCellRect), viewportSize());
    };
    const createNewCell = () => {
        const newCell: Cell = {
            id: crypto.randomUUID(),
            title: t('default.cell_title'),
            rect: {
                x: 200 + Math.random() * 200,
                y: 200 + Math.random() * 200,
                width: 320,
                height: 240,
            },
            background_color: null,
            opacity: 0.85,
            layout: 'Grid',
            sort_field: 'name',
            sort_direction: 'asc',
            // Pinned (manual) mode: hover_expand=true with collapsed=false is
            // an inconsistent in-between where the first mode-button click
            // seems to do nothing.
            collapsed: false,
            hover_expand: false,
            icons: [],
            sub_cells: [],
            active_sub: null,
            sub_style: 'Compact',
            show_title: true,
        };
        commitConfig(t('history.create_cell'), (p) => ({ ...p, cells: [...p.cells, newCell] }));
    };

    /** Append a new empty sub-box tab and make it the active one. */
    const createSubCell = (cellId: string) => {
        const sub = { id: crypto.randomUUID(), title: t('default.sub_title'), icons: [] };
        updateCell(cellId, (c) => ({
            ...c,
            sub_cells: [...c.sub_cells, sub],
            active_sub: sub.id,
        }));
    };

    /** One-click organize: needs the desktop scan to tell folders apart. */
    const organizeDesktop = async () => {
        try {
            const scan = await desktopCommand('scan_desktop');
            const dirPaths = new Set(scan.entries.filter((e) => e.is_dir).map((e) => e.path.toLowerCase()));
            const titles: Record<CategoryKey, string> = {
                folders: t('organize.folders'),
                apps: t('organize.apps'),
                documents: t('organize.documents'),
                images: t('organize.images'),
                media: t('organize.media'),
                archives: t('organize.archives'),
                others: t('organize.others'),
            };
            commitConfig(t('history.organize'), (p) =>
                organizeConfig(
                    p,
                    dirPaths,
                    new Set(p.excluded_from_organize.map((path) => path.toLowerCase())),
                    viewportSize(),
                    titles,
                ),
            );
        } catch {
            toast.error(t('toast.organize_failed'));
        }
    };
    const sortDesktop = async (field: SortField, direction: SortDirection) => {
        try {
            const scan = await desktopCommand('scan_desktop');
            commitConfig(t('history.sort'), (p) =>
                sortFreeIcons(p, scan, field, direction, viewportSize()),
            );
            setSortField(field);
            setSortDirection(direction);
        } catch {
            toast.error(t('toast.sort_failed'));
        }
    };

    const arrangeCellIcons = async (cellId: string, field: SortField, direction: SortDirection) => {
        try {
            const scan = await desktopCommand('scan_desktop');
            const metadata = new Map(scan.entries.map((entry) => [entry.path.toLowerCase(), entry]));
            const extension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
            const compareText = (left: string, right: string) =>
                left.localeCompare(right, undefined, {
                    numeric: true,
                    sensitivity: 'base',
                });
            const multiplier = direction === 'asc' ? 1 : -1;
            updateCell(cellId, (cell) => ({
                ...withActiveIcons(cell, (icons) =>
                    [...icons].sort((left, right) => {
                        const leftEntry = metadata.get(left.path.toLowerCase());
                        const rightEntry = metadata.get(right.path.toLowerCase());
                        const result =
                            field === 'modified'
                                ? (leftEntry?.modified_at_millis ?? -1) -
                                  (rightEntry?.modified_at_millis ?? -1)
                                : field === 'type'
                                  ? compareText(extension(left.path), extension(right.path))
                                  : compareText(left.name, right.name);
                        return (result || compareText(left.name, right.name)) * multiplier;
                    }),
                ),
                sort_field: field,
                sort_direction: direction,
            }));
        } catch {
            toast.error(t('toast.sort_failed'));
        }
    };

    return {
        updateCell,
        removeCell,
        addIconToCell,
        cellAtPoint,
        resolveDropPos,
        createNewCell,
        createSubCell,
        organizeDesktop,
        sortDesktop,
        sortField,
        sortDirection,
        arrangeCellIcons,
        hoverCellId,
        cellHover,
    };
}
