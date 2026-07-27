/**
 * Desktop main application surface.
 * Manages cells, free icons on a Windows-like grid, drag-and-drop,
 * right-click menu, config persistence, and reconciles the icon list with
 * the real desktop folder (initial load + `desktop-changed` watcher events).
 */
import { createSignal, onMount, onCleanup, createEffect, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { useI18n } from '~/i18n';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopScan } from '@bindings/DesktopScan';
import type { Cell } from '@bindings/Cell';
import type { DesktopIcon as DIcon } from '@bindings/DesktopIcon';
import { arrangeFreeIcons, effectiveCellRect, nearestFreeSlot, reconcileConfig, snapToGrid } from '~/lib/grid';
import { deleteSubCell, removeIcon, withActiveIcons } from '~/lib/cell';
import { dragRect, iconsInRect, sameParentDir } from '~/lib/select';
import { organizeConfig, type CategoryKey } from '~/lib/organize';
import { getCachedIcon } from '~/lib/icon-cache';
import CellBox from './ui/CellBox';
import DesktopIconComponent from './ui/DesktopIcon';
import ContextMenu from './ui/ContextMenu';
import SettingsDialog from './ui/SettingsDialog';
import { FiPlus, FiRefreshCw, FiSettings, FiPower, FiFile, FiGrid } from 'solid-icons/fi';
import toast from 'solid-toast';

export default function Desktop() {
    const { t } = useI18n();
    const [config, setConfig] = createSignal<DeskConfig | null>(null);
    const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number } | null>(null);
    const [settingsOpen, setSettingsOpen] = createSignal(false);

    // Multi-selection of free icons (marquee / ctrl+click), Windows-like
    const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<string>>(new Set());

    // A drag that ends on the pressed icon still fires a trailing click,
    // which would collapse the fresh multi-selection to one icon — swallow it.
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

    // ── Marquee (rubber-band) selection over free icons ──────────────────
    const [marquee, setMarquee] = createSignal<
        { x0: number; y0: number; x1: number; y1: number } | null
    >(null);
    let marqueeAdditive = false; // ctrl held at start → add to the selection
    let marqueeBase: ReadonlySet<string> = new Set();

    const handleDesktopMouseDown = (e: MouseEvent) => {
        // Only start on the bare desktop background (button 0); icons and
        // cells are absolutely-positioned children, so target ≠ currentTarget
        if (e.button !== 0 || e.target !== e.currentTarget) return;
        marqueeAdditive = e.ctrlKey || e.metaKey;
        marqueeBase = selectedIds();
        setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
        // Same guard as icon drags: the Rust polling loop must not re-order
        // our window mid-gesture (it can break WebView2's pointer capture)
        invoke('set_dragging', { dragging: true }).catch(() => {});

        const move = (ev: MouseEvent) => {
            const m = marquee();
            if (!m) return; // cancelled (Escape) — mouseup will detach us
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
            // A sub-threshold drag is a plain empty-desktop click → clear
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

    // ── Pointer-event simulated drag state ───────────────────────────────
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
        /** Every icon moving together — the multi-selection for free-icon
         *  drags, or just the dragged icon itself. */
        group: DIcon[];
        /** Only becomes a real drag after a small movement threshold —
         *  otherwise plain clicks/double-clicks would trigger drop logic. */
        moved: boolean;
    }
    const [dragState, setDragState] = createSignal<DragState | null>(null);

    // ── Desktop ⇄ config reconcile ───────────────────────────────────────
    // Core of auto-refresh: scan the real desktop folders and sync the
    // config (add new files into free slots, drop deleted ones). Triggered
    // on mount, by the Rust folder watcher, and by the Refresh menu item.
    const reconcileDesktop = async () => {
        try {
            const scan = await invoke<DesktopScan>('scan_desktop');
            setConfig((p) => {
                if (!p) return p;
                const next = reconcileConfig(p, scan, viewportSize());
                // Auto-arrange compacts the layout on every desktop change
                return p.auto_arrange && next !== p ? arrangeFreeIcons(next, viewportSize()) : next;
            });
        } catch {
            /* scan is best-effort; manual refresh can retry */
        }
    };

    // ── Load config, initial reconcile, watcher subscription ────────────
    onMount(async () => {
        try {
            setConfig(await invoke<DeskConfig>('get_config'));
        } catch {
            toast.error(t('toast.load_config_failed'));
            return;
        }
        void reconcileDesktop();
    });

    onMount(() => {
        const unlisten = listen('desktop-changed', () => { void reconcileDesktop(); });
        onCleanup(() => { void unlisten.then((fn) => fn()); });
    });

    // ── Keyboard shortcuts: context menu + cancel drag ───────────────────
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            // Shift+F10 or ContextMenu key → open menu (works when click-through active)
            if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
                e.preventDefault();
                setContextMenu({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
            }
            // Escape → cancel drag / close menu / clear selection
            if (e.key === 'Escape') {
                setDragState(null);
                setContextMenu(null);
                // Cancel an active marquee too — its move handler bails once
                // the signal is null, so the cleared selection stays cleared
                setMarquee(null);
                setSelectedIds(new Set<string>());
            }
        };
        window.addEventListener('keydown', onKey);
        onCleanup(() => window.removeEventListener('keydown', onKey));
    });

    // ── Global pointer-event drag tracking ──────────────────────────────
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
                // Reset timeout on each move — if no move for 2s, auto-cancel
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
            // Re-resolve members from the CURRENT config — a watcher
            // reconcile mid-drag may have replaced or removed icon objects,
            // and re-adding stale snapshots could duplicate files.
            const groupIds = new Set(
                (ds.group.length > 0 ? ds.group : [ds.icon]).map((g) => g.id),
            );

            if (targetCell && targetCell !== ds.cellId) {
                // The whole selection drops into the target's active tab
                setConfig((p) => {
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
            } else if (!targetCell) {
                if (ds.source === 'cell') {
                    const pos = resolveDropPos(ds.x - ds.offsetX, ds.y - ds.offsetY, ds.iconId);
                    setConfig((p) => p ? {
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
                    setConfig((p) => {
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

    // ── Save config (debounced, not in frequent callbacks) ───────────────
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

    // ── Cell operations ──────────────────────────────────────────────────
    const updateCell = (id: string, fn: (c: Cell) => Cell) =>
        setConfig((p) =>
            p ? { ...p, cells: p.cells.map((c) => (c.id === id ? fn(c) : c)) } : p,
        );

    /** Create an icon entry and add it to a cell's active tab
     *  (no file movement — just config). */
    const addIconToCell = (cellId: string, filePath: string) => {
        const icon: DIcon = {
            id: crypto.randomUUID(),
            name: filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? t('default.icon_name'),
            path: filePath,
            icon_path: null,
            pos_x: 0, pos_y: 0,
        };
        updateCell(cellId, (c) => withActiveIcons(c, (icons) => [...icons, icon]));
    };

    /** Find which cell (if any) is at the given coordinates. DOM hit-testing
     *  reflects what the user actually sees — a rolled-up cell only occupies
     *  its title bar, a hover-expanded one its full box. */
    const cellAtPoint = (x: number, y: number): string | null =>
        document.elementFromPoint(x, y)?.closest('[data-cell-id]')
            ?.getAttribute('data-cell-id') ?? null;

    /** Resolve a free-icon drop position — nearest unoccupied slot when snapping. */
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

    // ── External file drops (from Explorer) ──────────────────────────────
    const addFreeIconAt = (filePath: string, x: number, y: number) => {
        setConfig((p) => {
            if (!p) return p;
            // The folder watcher may have reconciled it in already — dedupe by path
            const low = filePath.toLowerCase();
            if (p.free_icons.some((i) => i.path.toLowerCase() === low) ||
                p.cells.some((c) => c.icons.some((i) => i.path.toLowerCase() === low))) {
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
        });
    };

    /** Drop external file at (x, y): into a cell, or copy to desktop as free icon. */
    const dropExternalFile = (filePath: string, x: number, y: number) => {
        const targetCell = cellAtPoint(x, y);
        if (targetCell) {
            addIconToCell(targetCell, filePath);
        } else {
            invoke<string>('copy_to_desktop', { path: filePath }).then((newPath) => {
                const pos = resolveDropPos(x - 38, y - 48);
                addFreeIconAt(newPath, pos.x, pos.y);
            }).catch(() => {});
        }
    };

    const handleDomDrop = (e: DragEvent) => {
        e.preventDefault();
        const files = e.dataTransfer?.files;
        if (!files?.length) return;
        for (let i = 0; i < files.length; i++) {
            const file = files[i] as File & { path?: string };
            dropExternalFile(file.path ?? file.name, e.clientX, e.clientY);
        }
    };

    // ── Tauri native drag-and-drop event ─────────────────────────────────
    onMount(() => {
        const getWindow = window.__TAURI__?.window?.getCurrentWindow;
        if (!getWindow) return;

        try {
            getWindow()?.onDragDropEvent?.((ev) => {
                const p = ev.payload;
                if (p.type !== 'drop' || !p.paths?.length) return;

                const dpr = window.devicePixelRatio || 1;
                const cssX = (p.position?.x ?? 400) / dpr;
                const cssY = (p.position?.y ?? 300) / dpr;
                for (const filePath of p.paths) {
                    dropExternalFile(filePath, cssX, cssY);
                }
            });
        } catch {
            // onDragDropEvent may not be available in all Tauri v2 versions
        }
    });

    // ── Create new cell / sub-box ────────────────────────────────────────
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
            // Pinned (manual) mode: hover_expand=true with collapsed=false is
            // an inconsistent in-between where the first mode-button click
            // seems to do nothing.
            collapsed: false,
            hover_expand: false,
            icons: [],
            sub_cells: [],
            active_sub: null,
            sub_style: 'Compact',
        };
        setConfig((p) => (p ? { ...p, cells: [...p.cells, newCell] } : p));
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
            setConfig((p) => (p ? organizeConfig(p, dirPaths, viewportSize(), titles) : p));
        } catch {
            toast.error(t('toast.organize_failed'));
        }
    };

    const openIcon = async (ic: DIcon) => {
        try {
            await invoke('open_file', { path: ic.path });
        } catch {
            toast.error(t('toast.open_file_failed'));
        }
    };

    // ── Config data operations (settings dialog: export / import / reset) ──
    const exportConfig = async () => {
        const cfg = config();
        if (!cfg) return;
        try {
            const dest = await save({
                title: t('settings.export_title'),
                defaultPath: 'deskchan.toml',
                filters: [{ name: 'TOML', extensions: ['toml'] }],
            });
            if (!dest) return; // user cancelled
            await invoke('export_config', { cfg, path: dest });
            toast.success(t('toast.export_done'));
        } catch {
            toast.error(t('toast.export_failed'));
        }
    };

    const importConfig = async () => {
        try {
            const src = await open({
                title: t('settings.import_title'),
                multiple: false,
                filters: [{ name: 'TOML', extensions: ['toml'] }],
            });
            if (!src) return; // user cancelled
            const path = typeof src === 'string' ? src : (src as { path: string }).path;
            setConfig(await invoke<DeskConfig>('import_config', { path }));
            await reconcileDesktop();
            toast.success(t('toast.import_done'));
        } catch {
            toast.error(t('toast.import_failed'));
        }
    };

    const resetConfig = async () => {
        try {
            // Destructive (removes all cells) → native confirm first
            if (!(await ask(t('settings.reset_confirm'), { kind: 'warning' }))) return;
            setConfig(await invoke<DeskConfig>('reset_config'));
            await reconcileDesktop();
            setSettingsOpen(false);
            toast.success(t('toast.reset_done'));
        } catch {
            toast.error(t('toast.load_config_failed'));
        }
    };

    /** Native Windows shell context menu for an icon. For cell icons a
     *  "remove" entry is appended; free icons mirror real desktop files, so
     *  the native verbs (delete, rename, …) plus the watcher cover them.
     *  Right-clicking inside a multi-selection opens the combined menu for
     *  all selected same-folder files (Explorer semantics); right-clicking
     *  an unselected icon selects just it first. */
    const showIconMenu = async (icon: DIcon, cellId?: string) => {
        let paths = [icon.path];
        if (!cellId) {
            if (selectedIds().has(icon.id) && selectedIds().size > 1) {
                // The shell menu can only serve ONE parent folder (single
                // IShellFolder); narrow the visible selection to the subset
                // the menu will actually act on, so highlight === action.
                const sameDir = (config()?.free_icons ?? [])
                    .filter((i) => selectedIds().has(i.id) && sameParentDir(i.path, icon.path));
                paths = sameDir.map((i) => i.path);
                if (sameDir.length < selectedIds().size) {
                    setSelectedIds(new Set(sameDir.map((i) => i.id)));
                }
            } else {
                setSelectedIds(new Set([icon.id]));
            }
        }
        try {
            const extraItems = cellId ? [t('icon.remove')] : [];
            const picked = await invoke<number | null>('show_icon_menu', {
                paths,
                extraItems,
            });
            if (picked === 0 && cellId) {
                updateCell(cellId, (c) => removeIcon(c, icon.id));
            }
        } catch {
            /* best-effort; double-click open still works */
        }
    };

    // ── Render ───────────────────────────────────────────────────────────
    let desktopRef!: HTMLDivElement;

    // Native drag listeners on window level — capture phase forces allow
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
            // 0.01 opacity prevents WebView2 from leaking drag to OS desktop.
            // 0.005 gets rounded to 0 by Chromium; 0.01 is the minimum safe value.
            style={{ "background-color": "rgba(255, 255, 255, 0.01)" }}
            onMouseDown={handleDesktopMouseDown}
            onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY });
            }}
        >
            {/* Cells — <For> with key prevents destroying/recreating components on config change */}
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
                            setConfig((p) =>
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
                        onIconMenu={(cellId, icon) => { void showIconMenu(icon, cellId); }}
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
                        showTitles={config()?.show_titles ?? true}
                        hovered={hoverCellId() === cell.id}
                        onHover={cellHover}
                    />
                )}
            </For>

            {/* Free icons — Windows-like fixed grid slots, absolute positions.
                No remove button: like the native desktop, a free icon exists
                exactly as long as its file does (the watcher enforces this). */}
            <For each={config()?.free_icons ?? []}>
                {(icon) => (
                    <div
                        data-icon
                        class="absolute"
                        style={{
                            left: `${icon.pos_x}px`,
                            top: `${icon.pos_y}px`,
                            // Sentinel (-1) icons are placed by the next reconcile
                            ...(icon.pos_x < 0 || icon.pos_y < 0 ? { display: 'none' } : {}),
                        }}
                    >
                        <DesktopIconComponent
                            icon={icon}
                            selected={selectedIds().has(icon.id)}
                            onSelect={selectIcon}
                            onOpen={openIcon}
                            onNativeMenu={(ic) => { void showIconMenu(ic); }}
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
                            onClick: () => { void reconcileDesktop(); },
                        },
                        {
                            label: t('desktop.context.arrangement'),
                            icon: <FiGrid />,
                            submenu: [
                                {
                                    label: `${config()?.auto_arrange ? '☑ ' : '☐ '}${t('desktop.context.arrange_auto')}`,
                                    onClick: () => {
                                        setConfig((p) => {
                                            if (!p) return p;
                                            const next = { ...p, auto_arrange: !p.auto_arrange };
                                            // Turning auto-arrange on compacts immediately
                                            return next.auto_arrange ? arrangeFreeIcons(next, viewportSize()) : next;
                                        });
                                    },
                                },
                                {
                                    label: `${config()?.snap_to_grid ? '☑ ' : '☐ '}${t('desktop.context.arrange_snap')}`,
                                    onClick: () => {
                                        setConfig((p) => {
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
                            ],
                        },
                        {
                            label: t('desktop.context.organize'),
                            icon: <FiGrid />,
                            onClick: () => { void organizeDesktop(); },
                        },
                        { separator: true },
                        {
                            label: t('desktop.context.settings'),
                            icon: <FiSettings />,
                            onClick: () => setSettingsOpen(true),
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

            {/* Settings dialog */}
            <SettingsDialog
                open={settingsOpen()}
                onClose={() => setSettingsOpen(false)}
                showTitles={config()?.show_titles ?? true}
                onSave={({ showTitles }) =>
                    setConfig((p) => (p ? { ...p, show_titles: showTitles } : p))
                }
                onExport={() => { void exportConfig(); }}
                onImport={() => { void importConfig(); }}
                onReset={() => { void resetConfig(); }}
            />

            {/* Marquee rectangle — theme-aware, render only past the click threshold */}
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

            {/* Drag ghost — follows cursor once the drag threshold is passed */}
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
                                {ds().icon.name}
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
