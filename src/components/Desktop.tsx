/**
 * Desktop main application surface.
 * Manages cells, free icons on a Windows-like grid, drag-and-drop,
 * right-click menu, config persistence, and reconciles the icon list with
 * the real desktop folder (initial load + `desktop-changed` watcher events).
 */
import { createSignal, onMount, onCleanup, createEffect, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, monitorFromPoint } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';
import { useI18n } from '~/i18n';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopScan } from '@bindings/DesktopScan';
import type { Cell } from '@bindings/Cell';
import type { DesktopIcon as DIcon } from '@bindings/DesktopIcon';
import { arrangeFreeIcons, displayIconName, effectiveCellRect, nearestFreeSlot, reconcileConfig, snapToGrid, sortFreeIcons, type SortDirection, type SortField } from '~/lib/grid';
import { popRedo, popUndo, pushHistory, type HistoryState } from '~/lib/history';
import { allIcons, deleteSubCell, removeIcon, reorderIcons, withActiveIcons } from '~/lib/cell';
import { dragRect, iconsInRect, sameParentDir } from '~/lib/select';
import { organizeConfig, type CategoryKey } from '~/lib/organize';
import { getCachedIcon } from '~/lib/icon-cache';
import CellBox from './ui/CellBox';
import DesktopIconComponent from './ui/DesktopIcon';
import ContextMenu from './ui/ContextMenu';
import SettingsDialog from './ui/SettingsDialog';
import { FiCheck, FiPlus, FiRefreshCw, FiSettings, FiPower, FiFile, FiGrid, FiImage, FiMonitor, FiMoreHorizontal, FiClipboard, FiCopy, FiMove, FiTrash2, FiClock, FiX, FiEdit2 } from 'solid-icons/fi';
import toast from 'solid-toast';

export default function Desktop() {
    const { t } = useI18n();
    const [config, setConfig] = createSignal<DeskConfig | null>(null);
    const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number } | null>(null);
    const [settingsOpen, setSettingsOpen] = createSignal(false);
    const [settingsAnchor, setSettingsAnchor] = createSignal<{ x: number; y: number } | null>(null);

    const openSettingsDialog = async () => {
        const click = contextMenu();
        if (!click) { setSettingsOpen(true); return; }
        try {
            const appWindow = getCurrentWindow();
            const [outer, scale] = await Promise.all([appWindow.outerPosition(), appWindow.scaleFactor()]);
            const monitor = await monitorFromPoint(
                outer.x + click.x * scale,
                outer.y + click.y * scale,
            );
            if (monitor) {
                setSettingsAnchor({
                    x: (monitor.position.x - outer.x + monitor.size.width / 2) / scale,
                    y: (monitor.position.y - outer.y + monitor.size.height / 2) / scale,
                });
            } else {
                setSettingsAnchor(click);
            }
        } catch {
            setSettingsAnchor(click);
        }
        setSettingsOpen(true);
    };
    const [fileMenu, setFileMenu] = createSignal<{ icon: DIcon; cellId?: string; x: number; y: number } | null>(null);
    const pendingExternalMoves = new Set<string>();
    const [sortField, setSortField] = createSignal<SortField>('name');
    const [sortDirection, setSortDirection] = createSignal<SortDirection>('asc');
    const [historyOpen, setHistoryOpen] = createSignal(false);
    interface HistoryEntry {
        id: string;
        label: string;
        before: DeskConfig;
        after: DeskConfig;
        file?: FileUndoRecord;
    }
    interface FileUndoRecord { kind: string; sources: string[]; destinations: string[]; backups: string[]; }
    interface FileMutation { paths: string[]; record: FileUndoRecord; }
    interface RenamedIconMutation { path: string; name: string; record: FileUndoRecord; }
    const [history, setHistory] = createSignal<HistoryState<HistoryEntry>>({ undo: [], redo: [] });
    let applyingHistory = false;

    const cloneConfig = (value: DeskConfig) => structuredClone(value);
    const commitConfig = (label: string, change: (current: DeskConfig) => DeskConfig, file?: FileUndoRecord) => {
        const before = config();
        if (!before) return;
        const after = change(before);
        if (after === before) return;
        setConfig(after);
        if (!applyingHistory) {
            setHistory((current) => pushHistory(current, {
                id: crypto.randomUUID(), label, before: cloneConfig(before), after: cloneConfig(after), file,
            }));
        }
    };
    const undoLatest = async () => {
        const { entry, state } = popUndo(history());
        if (!entry) return;
        try {
            if (entry.file) await invoke('undo_file_operation', { record: entry.file });
        } catch {
            toast.error(t('toast.file_action_failed'));
            return;
        }
        applyingHistory = true;
        setConfig(cloneConfig(entry.before));
        applyingHistory = false;
        setHistory(state);
    };
    const redoLatest = async () => {
        const { entry, state } = popRedo(history());
        if (!entry) return;
        try {
            if (entry.file) await invoke('redo_file_operation', { record: entry.file });
        } catch {
            toast.error(t('toast.file_action_failed'));
            return;
        }
        applyingHistory = true;
        setConfig(cloneConfig(entry.after));
        applyingHistory = false;
        setHistory(state);
    };
    const undoThrough = async (index: number) => {
        while (history().undo.length > index) await undoLatest();
        setHistoryOpen(false);
    };

    // Multi-selection of free icons (marquee / ctrl+click), Windows-like
    const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<string>>(new Set());
    const [renamingIconId, setRenamingIconId] = createSignal<string | null>(null);
    let committingRenameIconId: string | null = null;

    const allConfigIcons = (cfg: DeskConfig): DIcon[] => [
        ...cfg.free_icons,
        ...cfg.cells.flatMap(allIcons),
    ];

    const selectedIcons = () => {
        const cfg = config();
        if (!cfg) return [];
        return allConfigIcons(cfg).filter((icon) => selectedIds().has(icon.id));
    };

    // A drag that ends on the pressed icon still fires a trailing click,
    // which would collapse the fresh multi-selection to one icon - swallow it.
    let suppressNextClick = false;

    /** Plain click selects exclusively; ctrl/meta+click toggles membership. */
    const selectIcon = (ic: DIcon, e: MouseEvent) => {
        if (suppressNextClick) {
            suppressNextClick = false;
            return;
        }
        setSelectedIds((prev) => {
            if (e.ctrlKey || e.metaKey) {
                const next = new Set(prev);
                if (next.has(ic.id)) next.delete(ic.id);
                else next.add(ic.id);
                return next;
            }
            return new Set([ic.id]);
        });
    };

    // -- Marquee (rubber-band) selection over free icons ------------------
    const [marquee, setMarquee] = createSignal<
        { x0: number; y0: number; x1: number; y1: number } | null
    >(null);
    let marqueeAdditive = false; // ctrl held at start -> add to the selection
    let marqueeBase: ReadonlySet<string> = new Set();

    const handleDesktopMouseDown = (e: MouseEvent) => {
        // Only start on the bare desktop background (button 0); icons and
        // cells are absolutely-positioned children, so target != currentTarget
        if (e.button !== 0 || e.target !== e.currentTarget) return;
        window.dispatchEvent(new Event('deskchan-clear-selection'));
        marqueeAdditive = e.ctrlKey || e.metaKey;
        marqueeBase = selectedIds();
        setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
        // Same guard as icon drags: the Rust polling loop must not re-order
        // our window mid-gesture (it can break WebView2's pointer capture)
        invoke('set_dragging', { dragging: true }).catch(() => {});

        const move = (ev: MouseEvent) => {
            const m = marquee();
            if (!m) return; // cancelled (Escape) - mouseup will detach us
            const next = { ...m, x1: ev.clientX, y1: ev.clientY };
            setMarquee(next);
            // Live selection while dragging, like Explorer
            const hit = iconsInRect(
                config()?.free_icons ?? [],
                dragRect(next.x0, next.y0, next.x1, next.y1),
            );
            setSelectedIds(marqueeAdditive ? new Set([...marqueeBase, ...hit]) : new Set(hit));
        };
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            invoke('set_dragging', { dragging: false }).catch(() => {});
            const m = marquee();
            setMarquee(null);
            // A sub-threshold drag is a plain empty-desktop click -> clear
            if (m && Math.abs(m.x1 - m.x0) < 4 && Math.abs(m.y1 - m.y0) < 4 && !marqueeAdditive) {
                setSelectedIds(new Set<string>());
            }
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    };

    // Hover-expand state lives here (not in CellBox) so it survives cell
    // component re-creation when the cell object is replaced by updateCell.
    const [hoverCellId, setHoverCellId] = createSignal<string | null>(null);
    let hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null;
    const cellHover = (id: string, inside: boolean) => {
        if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = null; }
        if (inside) {
            setHoverCellId(id);
        } else {
            // Small delay so brief pointer exits don't flap the roll-up
            hoverLeaveTimer = setTimeout(
                () => setHoverCellId((cur) => (cur === id ? null : cur)),
                250,
            );
        }
    };
    onCleanup(() => { if (hoverLeaveTimer) clearTimeout(hoverLeaveTimer); });

    const viewportSize = () => ({ width: window.innerWidth, height: window.innerHeight });

    // -- Pointer-event simulated drag state -------------------------------
    interface DragState {
        iconId: string;
        source: 'cell' | 'free';
        cellId: string;
        icon: DIcon;
        x: number;
        y: number;
        startX: number;
        startY: number;
        offsetX: number;
        offsetY: number;
        /** Every icon moving together - the multi-selection for free-icon
         *  drags, or just the dragged icon itself. */
        group: DIcon[];
        /** Only becomes a real drag after a small movement threshold -
         *  otherwise plain clicks/double-clicks would trigger drop logic. */
        moved: boolean;
    }
    const [dragState, setDragState] = createSignal<DragState | null>(null);

    // -- Desktop <-> config reconcile ---------------------------------------
    // Core of auto-refresh: scan the real desktop folders and sync the
    // config (add new files into free slots, drop deleted ones). Triggered
    // on mount, by the Rust folder watcher, and by the Refresh menu item.
    const reconcileSnapshot = (cfg: DeskConfig, scan: DesktopScan) => {
        const next = reconcileConfig(cfg, scan, viewportSize());
        // Auto-arrange compacts the layout on every desktop change.
        return cfg.auto_arrange && next !== cfg ? arrangeFreeIcons(next, viewportSize()) : next;
    };

    const reconcileDesktop = async () => {
        try {
            const scan = await invoke<DesktopScan>('scan_desktop');
            setConfig((p) => {
                if (!p) return p;
                return reconcileSnapshot(p, scan);
            });
        } catch {
            /* scan is best-effort; manual refresh can retry */
        }
    };

    // -- Load config, initial reconcile, watcher subscription ------------
    onMount(async () => {
        let loaded: DeskConfig;
        try {
            loaded = await invoke<DeskConfig>('get_config');
        } catch {
            toast.error(t('toast.load_config_failed'));
            return;
        }
        try {
            // Do not render stale persisted desktop entries before the first
            // scan. A later manual refresh used to remove these entries, but
            // the initial asynchronous paint made them flash on startup.
            const scan = await invoke<DesktopScan>('scan_desktop');
            setConfig(reconcileSnapshot(loaded, scan));
        } catch {
            // Keep the saved layout usable if the first native scan fails;
            // watcher events and manual Refresh will retry reconciliation.
            setConfig(loaded);
        }
    });

    onMount(() => {
        const unlisten = listen('desktop-changed', () => { void reconcileDesktop(); });
        onCleanup(() => { void unlisten.then((fn) => fn()); });
    });

    // -- Keyboard shortcuts: context menu + cancel drag -------------------
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const editing = target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || target?.isContentEditable;
            if (!editing && e.ctrlKey && e.altKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                setHistoryOpen(true);
                return;
            }
            if (!editing && e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                void undoLatest();
                return;
            }
            if (!editing && e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                void redoLatest();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !editing) {
                e.preventDefault();
                void pasteFromClipboard('auto');
                return;
            }
            if (e.key === 'F2' && !editing) {
                const icons = selectedIcons();
                if (icons.length === 1) {
                    e.preventDefault();
                    startRenameIcon(icons[0]);
                }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !editing) {
                const paths = selectedPaths();
                if (paths.length > 0) {
                    e.preventDefault();
                    invoke('file_action', { paths, action: 'copy' }).catch(() => toast.error(t('toast.file_action_failed')));
                }
                return;
            }
            if (e.key === 'Delete' && !editing) {
                const paths = selectedPaths();
                if (paths.length > 0) {
                    e.preventDefault();
                    void deletePaths(paths);
                    setSelectedIds(new Set<string>());
                }
                return;
            }
            // Shift+F10 or ContextMenu key -> open menu (works when click-through active)
            if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
                e.preventDefault();
                setContextMenu({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
            }
            // Escape -> cancel drag / close menu / clear selection
            if (e.key === 'Escape') {
                setDragState(null);
                setContextMenu(null);
                setHistoryOpen(false);
                setRenamingIconId(null);
                // Cancel an active marquee too - its move handler bails once
                // the signal is null, so the cleared selection stays cleared
                setMarquee(null);
                setSelectedIds(new Set<string>());
            }
        };
        window.addEventListener('keydown', onKey);
        onCleanup(() => window.removeEventListener('keydown', onKey));
    });

    // -- Global pointer-event drag tracking ------------------------------
    onMount(() => {
        let dragTimer: ReturnType<typeof setTimeout> | null = null;

        const clearDrag = () => {
            setDragState(null);
            invoke('set_dragging', { dragging: false }).catch(() => {});
            if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
        };

        const onMove = (e: PointerEvent) => {
            setDragState((prev) => {
                if (!prev) return null;
                // Reset timeout on each move - if no move for 2s, auto-cancel
                if (dragTimer) clearTimeout(dragTimer);
                dragTimer = setTimeout(clearDrag, 2000);
                const moved = prev.moved
                    || Math.abs(e.clientX - prev.startX) > 4
                    || Math.abs(e.clientY - prev.startY) > 4;
                return { ...prev, x: e.clientX, y: e.clientY, moved };
            });
        };

        const onEnd = () => {
            if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
            const ds = dragState();
            if (!ds) return;
            if (!ds.moved) { clearDrag(); return; } // plain click, not a drag
            suppressNextClick = true; // the trailing click must not reset the selection
            const targetCell = cellAtPoint(ds.x, ds.y);
            // Re-resolve members from the CURRENT config - a watcher
            // reconcile mid-drag may have replaced or removed icon objects,
            // and re-adding stale snapshots could duplicate files.
            const groupIds = new Set(
                (ds.group.length > 0 ? ds.group : [ds.icon]).map((g) => g.id),
            );

            if (targetCell && targetCell !== ds.cellId) {
                // The whole selection drops into the target's active tab
                commitConfig(t('history.move_into_cell'), (p) => {
                    if (!p) return p;
                    const live = ds.source === 'free'
                        ? p.free_icons.filter((i) => groupIds.has(i.id))
                        : [ds.icon];
                    return {
                        ...p,
                        free_icons: ds.source === 'free' ? p.free_icons.filter((i) => !groupIds.has(i.id)) : p.free_icons,
                        cells: p.cells.map((c) => {
                            if (c.id === ds.cellId && ds.source === 'cell') return removeIcon(c, ds.iconId);
                            if (c.id === targetCell) return withActiveIcons(c, (icons) => [...icons, ...live]);
                            return c;
                        }),
                    };
                });
            } else if (targetCell && targetCell === ds.cellId && ds.source === 'cell') {
                // In-cell reorder: the drop position picks the new slot
                // (before/after the icon under the cursor, or to the end)
                const el = document.elementFromPoint(ds.x, ds.y)?.closest('[data-icon-id]');
                const targetId = el?.getAttribute('data-icon-id') ?? null;
                const before = el
                    ? ds.x < el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2
                    : false;
                updateCell(ds.cellId, (c) =>
                    withActiveIcons(c, (icons) => reorderIcons(icons, ds.iconId, targetId, before)),
                );
            } else if (!targetCell) {
                if (ds.source === 'cell') {
                    const pos = resolveDropPos(ds.x - ds.offsetX, ds.y - ds.offsetY, ds.iconId);
                    commitConfig(t('history.move_into_cell'), (p) => p ? {
                        ...p,
                        cells: p.cells.map((c) => c.id === ds.cellId ? removeIcon(c, ds.iconId) : c),
                        free_icons: [...p.free_icons, { ...ds.icon, pos_x: pos.x, pos_y: pos.y }],
                    } : p);
                } else {
                    // Reposition: shift every group member by the drag delta,
                    // then snap sequentially (occupied accumulates) so members
                    // never stack onto the same slot. Positions come from the
                    // live config, not the drag-start snapshot.
                    const dx = ds.x - ds.startX;
                    const dy = ds.y - ds.startY;
                    commitConfig(t('history.move_into_cell'), (p) => {
                        if (!p) return p;
                        const cellRects = p.cells.map(effectiveCellRect);
                        const occupied = p.free_icons
                            .filter((i) => !groupIds.has(i.id) && i.pos_x >= 0)
                            .map((i) => ({ x: i.pos_x, y: i.pos_y }));
                        const movedPos = new Map<string, { x: number; y: number }>();
                        for (const g of p.free_icons.filter((i) => groupIds.has(i.id))) {
                            const nx = Math.max(0, g.pos_x + dx);
                            const ny = Math.max(0, g.pos_y + dy);
                            const pos = p.snap_to_grid
                                ? nearestFreeSlot(nx, ny, occupied, cellRects, viewportSize())
                                : { x: nx, y: ny };
                            occupied.push(pos);
                            movedPos.set(g.id, pos);
                        }
                        return {
                            ...p,
                            free_icons: p.free_icons.map((i) => {
                                const m = movedPos.get(i.id);
                                return m ? { ...i, pos_x: m.x, pos_y: m.y } : i;
                            }),
                        };
                    });
                }
            }
            clearDrag();
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointerleave', onEnd);
        window.addEventListener('pointercancel', onEnd);
        window.addEventListener('lostpointercapture', onEnd);
        onCleanup(() => {
            clearDrag();
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointerleave', onEnd);
            window.removeEventListener('pointercancel', onEnd);
            window.removeEventListener('lostpointercapture', onEnd);
        });
    });

    // -- Save config (debounced, not in frequent callbacks) ---------------
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    createEffect(() => {
        const cfg = config();
        if (!cfg) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            invoke('save_config', { cfg }).catch(() => {});
        }, 300);
        onCleanup(() => clearTimeout(saveTimer!));
    });

    // -- Cell operations --------------------------------------------------
    const updateCell = (id: string, fn: (c: Cell) => Cell) =>
        commitConfig(t('history.edit_cell'), (p) =>
            ({ ...p, cells: p.cells.map((c) => (c.id === id ? fn(c) : c)) }),
        );

    /** Move an existing visual icon, or add a new one, to a cell's active tab. */
    const addIconToCell = (cellId: string, filePath: string, file?: FileUndoRecord) => {
        const key = filePath.toLowerCase();
        commitConfig(t(file ? 'history.file_move' : 'history.move_into_cell'), (p) => {
            if (!p) return p;
            const existing = [...p.free_icons, ...p.cells.flatMap(allIcons)]
                .find((icon) => icon.path.toLowerCase() === key);
            const icon = existing ?? {
                id: crypto.randomUUID(),
                name: filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? t('default.icon_name'),
                path: filePath,
                icon_path: null,
                pos_x: 0, pos_y: 0,
            };
            const cells = p.cells.map((cell) => removeIcon(cell, icon.id));
            return {
                ...p,
                free_icons: p.free_icons.filter((candidate) => candidate.id !== icon.id),
                cells: cells.map((cell) => cell.id === cellId
                    ? withActiveIcons(cell, (icons) => [...icons, icon])
                    : cell),
            };
        }, file);
    };

    /** Find which cell (if any) is at the given coordinates. DOM hit-testing
     *  reflects what the user actually sees - a rolled-up cell only occupies
     *  its title bar, a hover-expanded one its full box. */
    const cellAtPoint = (x: number, y: number): string | null =>
        document.elementFromPoint(x, y)?.closest('[data-cell-id]')
            ?.getAttribute('data-cell-id') ?? null;

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

    // -- External file drops (from Explorer) ------------------------------
    const addFreeIconAt = (filePath: string, x: number, y: number, file?: FileUndoRecord) => {
        commitConfig(t(file ? 'history.file_move' : 'history.add_icon'), (p) => {
            if (!p) return p;
            // The folder watcher may have reconciled it in already - dedupe by
            // path across free icons AND every cell container (subs included)
            const low = filePath.toLowerCase();
            if (p.free_icons.some((i) => i.path.toLowerCase() === low) ||
                p.cells.some((c) => allIcons(c).some((i) => i.path.toLowerCase() === low))) {
                return p;
            }
            const icon: DIcon = {
                id: crypto.randomUUID(),
                name: filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? t('default.icon_name'),
                path: filePath,
                icon_path: null,
                pos_x: x, pos_y: y,
            };
            return { ...p, free_icons: [...p.free_icons, icon] };
        }, file);
    };

    /** Move an Explorer drop to the configured desktop, then place its icon. */
    const dropExternalFile = (filePath: string, x: number, y: number) => {
        const key = filePath.toLowerCase();
        if (pendingExternalMoves.has(key)) return;
        pendingExternalMoves.add(key);
        const targetCell = cellAtPoint(x, y);
        const freePosition = targetCell ? null : resolveDropPos(x - 38, y - 48);
        invoke<FileMutation>('move_to_desktop_with_undo', { path: filePath }).then((mutation) => {
            const newPath = mutation.paths[0];
            if (targetCell) {
                addIconToCell(targetCell, newPath, mutation.record);
            } else {
                addFreeIconAt(newPath, freePosition!.x, freePosition!.y, mutation.record);
            }
        }).catch(() => {
            toast.error(t('toast.drop_failed'));
        }).finally(() => pendingExternalMoves.delete(key));
    };

    const handleDomDrop = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const files = e.dataTransfer?.files;
        if (!files?.length) return;
        for (let i = 0; i < files.length; i++) {
            const file = files[i] as File & { path?: string };
            dropExternalFile(file.path ?? file.name, e.clientX, e.clientY);
        }
    };

    // -- Tauri native drag-and-drop event ---------------------------------
    onMount(() => {
        let unlisten: (() => void) | undefined;
        let disposed = false;

        void getCurrentWindow().onDragDropEvent((ev) => {
            const p = ev.payload;
            if (p.type !== 'drop' || !p.paths?.length) return;

            const dpr = window.devicePixelRatio || 1;
            const cssX = (p.position?.x ?? 400) / dpr;
            const cssY = (p.position?.y ?? 300) / dpr;
            for (const filePath of p.paths) {
                dropExternalFile(filePath, cssX, cssY);
            }
        }).then((stopListening) => {
            if (disposed) stopListening();
            else unlisten = stopListening;
        }).catch(() => {
            toast.error(t('toast.drop_failed'));
        });

        onCleanup(() => {
            disposed = true;
            unlisten?.();
        });
    });

    // -- Create new cell / sub-box ----------------------------------------
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
            const scan = await invoke<DesktopScan>('scan_desktop');
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
            commitConfig(t('history.organize'), (p) => organizeConfig(
                p,
                dirPaths,
                new Set(p.excluded_from_organize.map((path) => path.toLowerCase())),
                viewportSize(),
                titles,
            ));
        } catch {
            toast.error(t('toast.organize_failed'));
        }
    };

    const pasteFromClipboard = async (mode: 'auto' | 'copy' | 'move') => {
        try {
            const before = config();
            const mutation = await invoke<FileMutation>('paste_from_clipboard_with_undo', { mode });
            if (mutation.paths.length > 0 && before) {
                const scan = await invoke<DesktopScan>('scan_desktop');
                const after = reconcileSnapshot(before, scan);
                setConfig(after);
                setHistory((current) => pushHistory(current, {
                    id: crypto.randomUUID(),
                    label: t(mutation.record.kind === 'copy' ? 'history.file_copy' : 'history.file_move'),
                    before: cloneConfig(before), after: cloneConfig(after), file: mutation.record,
                }));
            }
        } catch {
            toast.error(t('toast.paste_failed'));
        }
    };

    const sortDesktop = async (field: SortField, direction: SortDirection) => {
        try {
            const scan = await invoke<DesktopScan>('scan_desktop');
            commitConfig(t('history.sort'), (p) => sortFreeIcons(p, scan, field, direction, viewportSize()));
            setSortField(field);
            setSortDirection(direction);
        } catch {
            toast.error(t('toast.sort_failed'));
        }
    };

    const arrangeCellIcons = async (cellId: string, field: SortField, direction: SortDirection) => {
        try {
            const scan = await invoke<DesktopScan>('scan_desktop');
            const metadata = new Map(scan.entries.map((entry) => [entry.path.toLowerCase(), entry]));
            const extension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
            const compareText = (left: string, right: string) => left.localeCompare(right, undefined, {
                numeric: true, sensitivity: 'base',
            });
            const multiplier = direction === 'asc' ? 1 : -1;
            updateCell(cellId, (cell) => ({
                ...withActiveIcons(cell, (icons) => [...icons].sort((left, right) => {
                const leftEntry = metadata.get(left.path.toLowerCase());
                const rightEntry = metadata.get(right.path.toLowerCase());
                const result = field === 'modified'
                    ? (leftEntry?.modified_at_millis ?? -1) - (rightEntry?.modified_at_millis ?? -1)
                    : field === 'type'
                        ? compareText(extension(left.path), extension(right.path))
                        : compareText(left.name, right.name);
                return (result || compareText(left.name, right.name)) * multiplier;
                })),
                sort_field: field,
                sort_direction: direction,
            }));
        } catch {
            toast.error(t('toast.sort_failed'));
        }
    };

    const openIcon = async (ic: DIcon) => {
        try {
            await invoke('open_file', { path: ic.path });
        } catch {
            toast.error(t('toast.open_file_failed'));
        }
    };

    const openSettings = async (section: 'personalization' | 'display') => {
        try {
            await invoke('open_settings', { section });
        } catch {
            toast.error(t('toast.open_settings_failed'));
        }
    };

    // -- Config data operations (settings dialog: export / import / reset) --
    const exportConfig = async () => {
        const cfg = config();
        if (!cfg) return;
        try {
            const exported = await invoke<boolean>('export_config', { cfg });
            if (!exported) return;
            toast.success(t('toast.export_done'));
        } catch {
            toast.error(t('toast.export_failed'));
        }
    };

    const importConfig = async () => {
        try {
            const imported = await invoke<DeskConfig | null>('import_config');
            if (!imported) return;
            setConfig(imported);
            await reconcileDesktop();
            toast.success(t('toast.import_done'));
        } catch {
            toast.error(t('toast.import_failed'));
        }
    };

    const resetConfig = async () => {
        try {
            // Destructive (removes all cells) -> native confirm first
            if (!(await ask(t('settings.reset_confirm'), { kind: 'warning' }))) return;
            setConfig(await invoke<DeskConfig>('reset_config'));
            await reconcileDesktop();
            toast.success(t('toast.reset_done'));
        } catch {
            toast.error(t('toast.load_config_failed'));
        }
    };

    /** Native Windows shell context menu for an icon. For cell icons a
     *  "remove" entry is appended; free icons mirror real desktop files, so
     *  the native verbs (delete, rename, ...) plus the watcher cover them.
     *  Right-clicking inside a multi-selection opens the combined menu for
     *  all selected same-folder files (Explorer semantics); right-clicking
     *  an unselected icon selects just it first. */
    const nativeMenuPaths = (icon: DIcon) => {
        let paths = [icon.path];
        if (selectedIds().has(icon.id) && selectedIds().size > 1) {
            // Explorer's native menu needs one parent folder. The styled menu
            // still uses the shared selection for copy/delete, while the
            // system-menu fallback narrows only its shell invocation.
            const cfg = config();
            const sameDir = cfg
                ? allConfigIcons(cfg)
                    .filter((i) => selectedIds().has(i.id) && sameParentDir(i.path, icon.path))
                : [icon];
            paths = sameDir.map((i) => i.path);
        } else {
            setSelectedIds(new Set([icon.id]));
        }
        return paths;
    };

    const showNativeIconMenu = async (icon: DIcon) => {
        try {
            const paths = nativeMenuPaths(icon);
            const picked = await invoke<number | null>('show_icon_menu', {
                paths,
                extraItems: paths.length === 1 ? [t('icon.rename')] : [],
            });
            if (picked === 0) startRenameIcon(icon);
        } catch {
            /* best-effort; double-click open still works */
        }
    };

    const excludedFromOrganize = (icon: DIcon) =>
        config()?.excluded_from_organize.some((path) => path.toLowerCase() === icon.path.toLowerCase()) ?? false;

    const toggleOrganizeExclusion = (icon: DIcon) => {
        const key = icon.path.toLowerCase();
        commitConfig(t('history.edit_cell'), (p) => {
            if (!p) return p;
            const excluded = p.excluded_from_organize.some((path) => path.toLowerCase() === key);
            return {
                ...p,
                excluded_from_organize: excluded
                    ? p.excluded_from_organize.filter((path) => path.toLowerCase() !== key)
                    : [...p.excluded_from_organize, icon.path],
            };
        });
    };

    const selectedPaths = () => {
        return selectedIcons().map((icon) => icon.path);
    };

    const startRenameIcon = (icon: DIcon) => {
        setFileMenu(null);
        setContextMenu(null);
        setSelectedIds(new Set([icon.id]));
        setRenamingIconId(icon.id);
    };

    const renameIcon = async (icon: DIcon, name: string) => {
        if (committingRenameIconId === icon.id) return;
        const before = config();
        if (!before) return;
        committingRenameIconId = icon.id;
        try {
            const mutation = await invoke<RenamedIconMutation>('rename_desktop_icon_with_undo', {
                path: icon.path,
                name,
                preserveExtension: !before.show_file_extensions,
            });
            const oldPath = icon.path.toLowerCase();
            const updateIcon = (candidate: DIcon): DIcon =>
                candidate.path.toLowerCase() === oldPath
                    ? { ...candidate, path: mutation.path, name: mutation.name }
                    : candidate;
            const after: DeskConfig = {
                ...before,
                free_icons: before.free_icons.map(updateIcon),
                excluded_from_organize: before.excluded_from_organize.map((path) =>
                    path.toLowerCase() === oldPath ? mutation.path : path,
                ),
                cells: before.cells.map((cell) => ({
                    ...cell,
                    icons: cell.icons.map(updateIcon),
                    sub_cells: cell.sub_cells.map((sub) => ({ ...sub, icons: sub.icons.map(updateIcon) })),
                })),
            };
            setConfig(after);
            setHistory((current) => pushHistory(current, {
                id: crypto.randomUUID(),
                label: t('history.file_rename'),
                before: cloneConfig(before),
                after: cloneConfig(after),
                file: mutation.record,
            }));
            setSelectedIds(new Set([icon.id]));
            setRenamingIconId(null);
        } catch {
            toast.error(t('toast.rename_failed'));
        } finally {
            committingRenameIconId = null;
        }
    };

    const runFileAction = async (action: 'open_with' | 'cut' | 'copy' | 'delete' | 'properties') => {
        const menu = fileMenu();
        if (!menu) return;
        try {
            const paths = selectedIds().has(menu.icon.id) ? selectedPaths() : nativeMenuPaths(menu.icon);
            if (action === 'delete') await deletePaths(paths);
            else await invoke('file_action', { paths, action });
        } catch {
            toast.error(t('toast.file_action_failed'));
        }
    };

    const deletePaths = async (paths: string[]) => {
        const before = config();
        if (!before) return;
        try {
            const mutation = await invoke<FileMutation>('delete_with_undo', { paths });
            const removed = new Set(paths.map((path) => path.toLowerCase()));
            const after: DeskConfig = {
                ...before,
                free_icons: before.free_icons.filter((icon) => !removed.has(icon.path.toLowerCase())),
                cells: before.cells.map((cell) => ({
                    ...cell,
                    icons: cell.icons.filter((icon) => !removed.has(icon.path.toLowerCase())),
                    sub_cells: cell.sub_cells.map((sub) => ({ ...sub, icons: sub.icons.filter((icon) => !removed.has(icon.path.toLowerCase())) })),
                })),
            };
            setConfig(after);
            setHistory((current) => pushHistory(current, {
                id: crypto.randomUUID(), label: t('history.file_delete'),
                before: cloneConfig(before), after: cloneConfig(after), file: mutation.record,
            }));
        } catch { toast.error(t('toast.file_action_failed')); }
    };

    const showFileMenu = (icon: DIcon, cellId: string | undefined, event: MouseEvent) => {
        if (!config()?.use_styled_file_menu) {
            void showNativeIconMenu(icon);
            return;
        }
        nativeMenuPaths(icon);
        setFileMenu({ icon, cellId, x: event.clientX, y: event.clientY });
    };

    // -- Render -----------------------------------------------------------
    let desktopRef!: HTMLDivElement;

    // Native drag listeners on window level - capture phase forces allow
    onMount(() => {
        const allow = (e: Event) => {
            e.preventDefault();
            const dt = (e as DragEvent).dataTransfer;
            if (dt) dt.dropEffect = 'move';
        };
        // capture:true ensures we intercept BEFORE any child (CellBox) ignores the event
        window.addEventListener('dragenter', allow, { capture: true });
        window.addEventListener('dragover', allow, { capture: true });
        window.addEventListener('drop', handleDomDrop, { capture: true });
        onCleanup(() => {
            window.removeEventListener('dragenter', allow, { capture: true });
            window.removeEventListener('dragover', allow, { capture: true });
            window.removeEventListener('drop', handleDomDrop, { capture: true });
        });
    });

    return (
        <div
            ref={desktopRef}
            class="fixed inset-0 w-screen h-screen"
            // The interaction surface is visually transparent: wallpaper is
            // never tinted. Contrast is applied by each CellBox instead.
            style={{ "background-color": 'transparent' }}
            onMouseDown={handleDesktopMouseDown}
            onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY });
            }}
        >
            {/* Cells - <For> with key prevents destroying/recreating components on config change */}
            <For each={config()?.cells ?? []}>
                {(cell) => (
                    <CellBox
                        cell={cell}
                        onMove={(id, x, y) =>
                            updateCell(id, (c) => ({ ...c, rect: { ...c.rect, x, y } }))
                        }
                        onResize={(id, rect) => updateCell(id, (c) => ({ ...c, rect }))}
                        onOpenIcon={openIcon}
                        onDropIcons={(cid, paths) => paths.forEach(p => addIconToCell(cid, p))}
                        onDelete={(id) =>
                            commitConfig(t('history.edit_cell'), (p) =>
                                p ? { ...p, cells: p.cells.filter((c) => c.id !== id) } : p,
                            )
                        }
                        onDragStart={(iconId, cellId, icon, e) => {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setDragState({
                                iconId, source: 'cell', cellId, icon,
                                x: e.clientX, y: e.clientY,
                                startX: e.clientX, startY: e.clientY,
                                offsetX: e.clientX - rect.left,
                                offsetY: e.clientY - rect.top,
                                group: [icon],
                                moved: false,
                            });
                            invoke('set_dragging', { dragging: true }).catch(() => {});
                        }}
                        onToggleHoverExpand={(id) =>
                            // Coodesker semantics: entering auto mode arms the
                            // roll-up (cell stays open under the hovering
                            // pointer, rolls when it leaves); leaving auto
                            // mode pins the cell open.
                            updateCell(id, (c) => c.hover_expand
                                ? { ...c, hover_expand: false, collapsed: false }
                                : { ...c, hover_expand: true, collapsed: true })
                        }
                        onIconMenu={(cellId, icon, event) => showFileMenu(icon, cellId, event)}
                        selectedIconIds={selectedIds()}
                        onSelectIcon={(_cellId, icon, event) => selectIcon(icon, event)}
                        onClearIconSelection={() => setSelectedIds(new Set<string>())}
                        renamingIconId={renamingIconId()}
                        onRenameIcon={(icon, name) => { void renameIcon(icon, name); }}
                        onRenameIconCancel={() => setRenamingIconId(null)}
                        showFileExtensions={config()?.show_file_extensions ?? true}
                        desktopOverlayOpacity={config()?.desktop_overlay_opacity ?? 0.01}
                        onRename={(id, title) => updateCell(id, (c) => ({ ...c, title }))}
                        onCreateSub={createSubCell}
                        onSelectSub={(id, subId) =>
                            updateCell(id, (c) => ({ ...c, active_sub: subId }))
                        }
                        onRenameSub={(id, subId, title) =>
                            updateCell(id, (c) => ({
                                ...c,
                                sub_cells: c.sub_cells.map((s) => (s.id === subId ? { ...s, title } : s)),
                            }))
                        }
                        onDeleteSub={(id, subId) => updateCell(id, (c) => deleteSubCell(c, subId))}
                        onSetSubStyle={(id, style) =>
                            updateCell(id, (c) => ({ ...c, sub_style: style }))
                        }
                        onSetLayout={(id, layout) =>
                            updateCell(id, (c) => ({ ...c, layout }))
                        }
                        onArrangeIcons={arrangeCellIcons}
                        onToggleShowTitle={(id) =>
                            updateCell(id, (c) => ({ ...c, show_title: !c.show_title }))
                        }
                        hovered={hoverCellId() === cell.id}
                        onHover={cellHover}
                        snapRects={(config()?.cells ?? [])
                            .filter((c) => c.id !== cell.id)
                            .map(effectiveCellRect)}
                    />
                )}
            </For>

            {/* Free icons - Windows-like fixed grid slots, absolute positions.
                No remove button: like the native desktop, a free icon exists
                exactly as long as its file does (the watcher enforces this). */}
            <For each={config()?.free_icons ?? []}>
                {(icon) => (
                    <div
                        data-icon
                        class={selectedIds().has(icon.id) ? 'absolute z-30' : 'absolute z-0'}
                        style={{
                            left: `${icon.pos_x}px`,
                            top: `${icon.pos_y}px`,
                            // Sentinel (-1) icons are placed by the next reconcile
                            ...(icon.pos_x < 0 || icon.pos_y < 0 ? { display: 'none' } : {}),
                        }}
                    >
                        <DesktopIconComponent
                            icon={icon}
                            showFileExtensions={config()?.show_file_extensions ?? true}
                            selected={selectedIds().has(icon.id)}
                            onSelect={selectIcon}
                            onOpen={openIcon}
                            editing={renamingIconId() === icon.id}
                            onRename={(icon, name) => { void renameIcon(icon, name); }}
                            onRenameCancel={() => setRenamingIconId(null)}
                            onNativeMenu={(icon, event) => showFileMenu(icon, undefined, event)}
                            labelClass="desktop-icon-label"
                            onDragStart={(iconId, e) => {
                                // Pointer-down on an unselected icon selects it
                                // exclusively (Windows); on a selected one the
                                // whole selection drags as a group. Ctrl-clicks
                                // leave selection to the click handler.
                                if (!(e.ctrlKey || e.metaKey) && !selectedIds().has(iconId)) {
                                    setSelectedIds(new Set([iconId]));
                                }
                                const group = (config()?.free_icons ?? [])
                                    .filter((i) => selectedIds().has(i.id) || i.id === iconId);
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setDragState({
                                    iconId, source: 'free', cellId: '', icon,
                                    x: e.clientX, y: e.clientY,
                                    startX: e.clientX, startY: e.clientY,
                                    offsetX: e.clientX - rect.left,
                                    offsetY: e.clientY - rect.top,
                                    group,
                                    moved: false,
                                });
                                invoke('set_dragging', { dragging: true }).catch(() => {});
                            }}
                        />
                    </div>
                )}
            </For>

            {/* Empty state */}
            {config() && config()!.cells.length === 0 && config()!.free_icons.length === 0 && (
                <div class="flex items-center justify-center h-full">
                    <p class="text-gray-400 dark:text-gray-500 text-sm italic">
                        {t('desktop.empty')}
                    </p>
                </div>
            )}

            {/* Context menu */}
            {contextMenu() && (
                <ContextMenu
                    items={[
                        {
                            label: t('desktop.context.new_cell'),
                            icon: <FiPlus />,
                            onClick: createNewCell,
                        },
                        {
                            label: t('desktop.context.refresh'),
                            icon: <FiRefreshCw />,
                            onClick: () => { setSelectedIds(new Set<string>()); window.dispatchEvent(new Event('deskchan-clear-selection')); void reconcileDesktop(); },
                        },
                        {
                            label: t('desktop.context.paste'),
                            icon: <FiClipboard />,
                            submenu: [
                                {
                                    label: t('desktop.context.paste_copy'),
                                    icon: <FiCopy />,
                                    onClick: () => { void pasteFromClipboard('copy'); },
                                },
                                {
                                    label: t('desktop.context.paste_move'),
                                    icon: <FiMove />,
                                    onClick: () => { void pasteFromClipboard('move'); },
                                },
                            ],
                        },
                        {
                            label: t('desktop.context.arrangement'),
                            icon: <FiGrid />,
                            submenu: [
                                {
                                    label: t('desktop.context.arrange_auto'),
                                    // Fluent menus mark checked items with a
                                    // checkmark in the icon gutter, not text
                                    icon: config()?.auto_arrange ? <FiCheck /> : undefined,
                                    onClick: () => {
                                        commitConfig(t('history.sort'), (p) => {
                                            if (!p) return p;
                                            const next = { ...p, auto_arrange: !p.auto_arrange };
                                            // Turning auto-arrange on compacts immediately
                                            return next.auto_arrange ? arrangeFreeIcons(next, viewportSize()) : next;
                                        });
                                    },
                                },
                                {
                                    label: t('desktop.context.arrange_snap'),
                                    icon: config()?.snap_to_grid ? <FiCheck /> : undefined,
                                    onClick: () => {
                                        commitConfig(t('history.sort'), (p) => {
                                            if (!p) return p;
                                            const next = { ...p, snap_to_grid: !p.snap_to_grid };
                                            // Turning snapping on aligns everything at once (native behavior)
                                            return next.snap_to_grid
                                                ? {
                                                      ...next,
                                                      free_icons: next.free_icons.map((i) => i.pos_x < 0 ? i : { ...i, ...(() => {
                                                          const s = snapToGrid(i.pos_x, i.pos_y);
                                                          return { pos_x: s.x, pos_y: s.y };
                                                      })() }),
                                                  }
                                                : next;
                                        });
                                    },
                                },
                                { separator: true },
                                {
                                    label: t('desktop.context.sort_by'),
                                    submenu: [
                                        {
                                            label: t('desktop.context.sort_name'),
                                            icon: sortField() === 'name' ? <FiCheck /> : undefined,
                                            onClick: () => { void sortDesktop('name', sortDirection()); },
                                        },
                                        {
                                            label: t('desktop.context.sort_type'),
                                            icon: sortField() === 'type' ? <FiCheck /> : undefined,
                                            onClick: () => { void sortDesktop('type', sortDirection()); },
                                        },
                                        {
                                            label: t('desktop.context.sort_modified'),
                                            icon: sortField() === 'modified' ? <FiCheck /> : undefined,
                                            onClick: () => { void sortDesktop('modified', sortDirection()); },
                                        },
                                    ],
                                },
                                {
                                    label: t('desktop.context.sort_direction'),
                                    submenu: [
                                        {
                                            label: t('desktop.context.sort_ascending'),
                                            icon: sortDirection() === 'asc' ? <FiCheck /> : undefined,
                                            onClick: () => { void sortDesktop(sortField(), 'asc'); },
                                        },
                                        {
                                            label: t('desktop.context.sort_descending'),
                                            icon: sortDirection() === 'desc' ? <FiCheck /> : undefined,
                                            onClick: () => { void sortDesktop(sortField(), 'desc'); },
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            label: t('desktop.context.organize'),
                            icon: <FiGrid />,
                            onClick: () => { void organizeDesktop(); },
                        },
                        { separator: true },
                        // The system entries the native desktop menu offers
                        {
                            label: t('desktop.context.personalize'),
                            icon: <FiImage />,
                            onClick: () => { void openSettings('personalization'); },
                        },
                        {
                            label: t('desktop.context.display_settings'),
                            icon: <FiMonitor />,
                            onClick: () => { void openSettings('display'); },
                        },
                        {
                            label: t('desktop.context.system_menu'),
                            icon: <FiMoreHorizontal />,
                            onClick: () => {
                                void invoke('show_desktop_menu').catch(() => {});
                            },
                        },
                        { separator: true },
                        {
                            label: t('desktop.context.settings'),
                            icon: <FiSettings />,
                            onClick: () => { void openSettingsDialog(); },
                        },
                        { separator: true },
                        {
                            label: t('desktop.context.exit'),
                            icon: <FiPower />,
                            destructive: true,
                            onClick: () => {
                                invoke('quit_app').catch(() => {});
                            },
                        },
                    ]}
                    position={contextMenu()!}
                    onClose={() => setContextMenu(null)}
                />
            )}

            {fileMenu() && (
                <ContextMenu
                    items={[
                        {
                            label: t('icon.open_file'),
                            icon: <FiFile />,
                            onClick: () => { void openIcon(fileMenu()!.icon); },
                        },
                        {
                            label: t('icon.open_with'),
                            icon: <FiMoreHorizontal />,
                            onClick: () => { void runFileAction('open_with'); },
                        },
                        {
                            label: t('icon.rename'),
                            icon: <FiEdit2 />,
                            shortcut: 'F2',
                            disabled: selectedIds().has(fileMenu()!.icon.id) && selectedIds().size !== 1,
                            onClick: () => startRenameIcon(fileMenu()!.icon),
                        },
                        ...(!fileMenu()!.cellId ? [
                            {
                                label: t('icon.exclude_organize'),
                                icon: excludedFromOrganize(fileMenu()!.icon) ? <FiCheck /> : undefined,
                                onClick: () => toggleOrganizeExclusion(fileMenu()!.icon),
                            },
                        ] : []),
                        { separator: true } as const,
                        {
                            label: t('icon.cut'),
                            icon: <FiMove />,
                            onClick: () => { void runFileAction('cut'); },
                        },
                        {
                            label: t('icon.copy'),
                            icon: <FiCopy />,
                            onClick: () => { void runFileAction('copy'); },
                        },
                        {
                            label: t('icon.delete'),
                            icon: <FiTrash2 />,
                            destructive: true,
                            onClick: () => { void runFileAction('delete'); },
                        },
                        { separator: true } as const,
                        {
                            label: t('icon.properties'),
                            icon: <FiFile />,
                            onClick: () => { void runFileAction('properties'); },
                        },
                        { separator: true } as const,
                        {
                            label: t('icon.system_menu'),
                            icon: <FiMoreHorizontal />,
                            onClick: () => { void showNativeIconMenu(fileMenu()!.icon); },
                        },
                        ...(fileMenu()!.cellId ? [
                            { separator: true } as const,
                            {
                                label: t('icon.remove'),
                                icon: <FiTrash2 />,
                                destructive: true,
                                onClick: () => updateCell(fileMenu()!.cellId!, (cell) => removeIcon(cell, fileMenu()!.icon.id)),
                            },
                        ] : []),
                    ]}
                    position={{ x: fileMenu()!.x, y: fileMenu()!.y }}
                    onClose={() => setFileMenu(null)}
                />
            )}

            <Show when={historyOpen()}>
                <div class="fixed inset-0 z-[20000] flex items-center justify-center bg-black/35" onMouseDown={() => setHistoryOpen(false)}>
                    <section class="w-[min(28rem,calc(100vw-2rem))] max-h-[min(30rem,calc(100vh-2rem))] overflow-auto rounded-md border border-gray-300 bg-white shadow-xl dark:border-gray-600 dark:bg-gray-800" onMouseDown={(event) => event.stopPropagation()}>
                        <header class="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
                            <div class="flex items-center gap-2 font-medium"><FiClock />{t('history.title')}</div>
                            <button class="p-1" title={t('settings.close')} onClick={() => setHistoryOpen(false)}><FiX /></button>
                        </header>
                        <Show when={history().undo.length > 0} fallback={<p class="p-4 text-sm text-gray-500">{t('history.empty')}</p>}>
                            <div class="py-1">
                                <For each={[...history().undo].reverse()}>{(entry, reverseIndex) => {
                                    const index = history().undo.length - reverseIndex() - 1;
                                    return <button class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700" onClick={() => { void undoThrough(index); }}>
                                        <FiClock class="shrink-0" />{entry.label}
                                    </button>;
                                }}</For>
                            </div>
                        </Show>
                    </section>
                </div>
            </Show>

            {/* Settings dialog */}
            <SettingsDialog
                open={settingsOpen()}
                onClose={() => setSettingsOpen(false)}
                onExport={() => { void exportConfig(); }}
                onImport={() => { void importConfig(); }}
                onReset={() => { void resetConfig(); }}
                desktopOverlayOpacity={config()?.desktop_overlay_opacity ?? 0.01}
                onDesktopOverlayOpacityChange={(desktop_overlay_opacity) =>
                    setConfig((p) => p ? { ...p, desktop_overlay_opacity } : p)
                }
                useStyledFileMenu={config()?.use_styled_file_menu ?? true}
                onUseStyledFileMenuChange={(use_styled_file_menu) =>
                    setConfig((p) => p ? { ...p, use_styled_file_menu } : p)
                }
                showFileExtensions={config()?.show_file_extensions ?? true}
                onShowFileExtensionsChange={(show_file_extensions) =>
                    setConfig((p) => p ? { ...p, show_file_extensions } : p)
                }
                anchor={settingsAnchor()}
            />

            {/* Marquee rectangle - theme-aware, render only past the click threshold */}
            <Show when={marquee()}>
                {(m) => {
                    const r = () => dragRect(m().x0, m().y0, m().x1, m().y1);
                    return (
                        <Show when={r().width >= 4 || r().height >= 4}>
                            <div
                                class="absolute z-40 pointer-events-none rounded-sm border border-blue-500/70 bg-blue-500/10 dark:border-blue-300/60 dark:bg-blue-300/10"
                                style={{
                                    left: `${r().x}px`,
                                    top: `${r().y}px`,
                                    width: `${r().width}px`,
                                    height: `${r().height}px`,
                                }}
                            />
                        </Show>
                    );
                }}
            </Show>

            {/* Drag ghost - follows cursor once the drag threshold is passed */}
            <Show when={dragState()}>
                {(ds) => (
                    <Show when={ds().moved}>
                        <div
                            class="fixed z-[10000] pointer-events-none flex flex-col items-center gap-0.5 p-1 rounded opacity-80"
                            style={{
                                left: `${ds().x - ds().offsetX}px`,
                                top: `${ds().y - ds().offsetY}px`,
                                width: '72px',
                            }}
                        >
                            <div class="w-12 h-12 flex items-center justify-center">
                                <Show
                                    when={getCachedIcon(ds().icon.path)}
                                    fallback={<FiFile class="text-3xl text-gray-400 dark:text-gray-500" />}
                                >
                                    {(url) => <img src={url()} alt="" class="w-full h-full object-contain" draggable="false" />}
                                </Show>
                            </div>
                            <span class="text-xs text-center leading-tight line-clamp-2 max-w-full desktop-icon-label">
                                {displayIconName(ds().icon, config()?.show_file_extensions ?? true)}
                            </span>
                            {/* Group size badge, like Explorer's drag count */}
                            <Show when={ds().group.length > 1}>
                                <span class="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-brand-primary text-white text-[10px] flex items-center justify-center tabular-nums">
                                    {ds().group.length}
                                </span>
                            </Show>
                        </div>
                    </Show>
                )}
            </Show>
        </div>
    );
}
