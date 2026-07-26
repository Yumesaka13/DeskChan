/**
 * Desktop main application surface.
 * Manages cells, free icons on a Windows-like grid, drag-and-drop,
 * right-click menu, config persistence, and reconciles the icon list with
 * the real desktop folder (initial load + `desktop-changed` watcher events).
 */
import { createSignal, onMount, onCleanup, createEffect, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useI18n } from '~/i18n';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopScan } from '@bindings/DesktopScan';
import type { Cell } from '@bindings/Cell';
import type { DesktopIcon as DIcon } from '@bindings/DesktopIcon';
import { arrangeFreeIcons, effectiveCellRect, nearestFreeSlot, reconcileConfig, snapToGrid } from '~/lib/grid';
import { organizeConfig, type CategoryKey } from '~/lib/organize';
import { getCachedIcon } from '~/lib/icon-cache';
import CellBox from './ui/CellBox';
import DesktopIconComponent from './ui/DesktopIcon';
import ContextMenu from './ui/ContextMenu';
import SettingsDialog from './ui/SettingsDialog';
import { FiPlus, FiRefreshCw, FiSettings, FiPower, FiTrash2, FiFile, FiGrid } from 'solid-icons/fi';
import toast from 'solid-toast';

export default function Desktop() {
    const { t } = useI18n();
    const [config, setConfig] = createSignal<DeskConfig | null>(null);
    const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number } | null>(null);
    const [settingsOpen, setSettingsOpen] = createSignal(false);
    const [selectedId, setSelectedId] = createSignal<string | null>(null);

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
                setSelectedId(null);
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
            const targetCell = cellAtPoint(ds.x, ds.y);

            if (targetCell && targetCell !== ds.cellId) {
                setConfig((p) => p ? {
                    ...p,
                    free_icons: ds.source === 'free' ? p.free_icons.filter((i) => i.id !== ds.iconId) : p.free_icons,
                    cells: p.cells.map((c) => {
                        if (c.id === ds.cellId && ds.source === 'cell') return { ...c, icons: c.icons.filter((i) => i.id !== ds.iconId) };
                        if (c.id === targetCell) return { ...c, icons: [...c.icons, ds.icon] };
                        return c;
                    }),
                } : p);
            } else if (!targetCell) {
                const pos = resolveDropPos(ds.x - ds.offsetX, ds.y - ds.offsetY, ds.iconId);
                if (ds.source === 'cell') {
                    setConfig((p) => p ? {
                        ...p,
                        cells: p.cells.map((c) => c.id === ds.cellId ? { ...c, icons: c.icons.filter((i) => i.id !== ds.iconId) } : c),
                        free_icons: [...p.free_icons, { ...ds.icon, pos_x: pos.x, pos_y: pos.y }],
                    } : p);
                } else {
                    setConfig((p) => p ? {
                        ...p,
                        free_icons: p.free_icons.map((i) => i.id === ds.iconId
                            ? { ...i, pos_x: pos.x, pos_y: pos.y }
                            : i),
                    } : p);
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

    /** Create an icon entry and add it to a cell (no file movement — just config). */
    const addIconToCell = (cellId: string, filePath: string) => {
        const icon: DIcon = {
            id: crypto.randomUUID(),
            name: filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? t('default.icon_name'),
            path: filePath,
            icon_path: null,
            pos_x: 0, pos_y: 0,
        };
        updateCell(cellId, (c) => ({ ...c, icons: [...c.icons, icon] }));
    };
    /** Move an existing icon from its current cell to a target cell. */
    const moveIconToCell = (iconId: string, targetCellId: string) => {
        const cfg = config();
        if (!cfg) return;
        // Find the icon in its current cell
        for (const cell of cfg.cells) {
            const icon = cell.icons.find((i) => i.id === iconId);
            if (icon && cell.id !== targetCellId) {
                // Remove from source cell, add to target cell
                setConfig((p) =>
                    p
                        ? {
                              ...p,
                              cells: p.cells.map((c) => {
                                  if (c.id === cell.id) {
                                      return { ...c, icons: c.icons.filter((i) => i.id !== iconId) };
                                  }
                                  if (c.id === targetCellId) {
                                      return { ...c, icons: [...c.icons, icon] };
                                  }
                                  return c;
                              }),
                          }
                        : p,
                );
                return;
            }
        }
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

    // ── Create new cell / add icons via dialog ───────────────────────────
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
            collapsed: false,
            hover_expand: true,
            icons: [],
        };
        setConfig((p) => (p ? { ...p, cells: [...p.cells, newCell] } : p));
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

    const addIconsViaDialog = async (cellId: string) => {
        try {
            const selected = await open({ multiple: true, title: t('default.add_files_title') });
            if (!selected) return;
            const arr = Array.isArray(selected) ? selected : [selected];
            const paths = arr.map((p) => (typeof p === 'string' ? p : (p as { path: string }).path));
            for (const p of paths) {
                addIconToCell(cellId, p);
            }
        } catch {
            // user cancelled or dialog error
        }
    };

    const openIcon = async (ic: DIcon) => {
        try {
            await invoke('open_file', { path: ic.path });
        } catch {
            toast.error(t('toast.open_file_failed'));
        }
    };

    /** Native Windows shell context menu for an icon. For cell icons a
     *  "remove" entry is appended; free icons mirror real desktop files, so
     *  the native verbs (delete, rename, …) plus the watcher cover them. */
    const showIconMenu = async (icon: DIcon, cellId?: string) => {
        try {
            const extraItems = cellId ? [t('icon.remove')] : [];
            const picked = await invoke<number | null>('show_icon_menu', {
                path: icon.path,
                extraItems,
            });
            if (picked === 0 && cellId) {
                updateCell(cellId, (c) => ({ ...c, icons: c.icons.filter((i) => i.id !== icon.id) }));
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
            onClick={() => setSelectedId(null)}
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
                        onResize={(id, w, h) =>
                            updateCell(id, (c) => ({ ...c, rect: { ...c.rect, width: w, height: h } }))
                        }
                        onOpenIcon={openIcon}
                        onRemoveIcon={(cid, iid) =>
                            updateCell(cid, (c) => ({ ...c, icons: c.icons.filter((i) => i.id !== iid) }))
                        }
                        onDropIcons={(cid, paths) => paths.forEach(p => addIconToCell(cid, p))}
                        onMoveIcon={moveIconToCell}
                        onDelete={(id) =>
                            setConfig((p) =>
                                p ? { ...p, cells: p.cells.filter((c) => c.id !== id) } : p,
                            )
                        }
                        onAddIcons={addIconsViaDialog}
                        onDragStart={(iconId, cellId, icon, e) => {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setDragState({
                                iconId, source: 'cell', cellId, icon,
                                x: e.clientX, y: e.clientY,
                                startX: e.clientX, startY: e.clientY,
                                offsetX: e.clientX - rect.left,
                                offsetY: e.clientY - rect.top,
                                moved: false,
                            });
                            invoke('set_dragging', { dragging: true }).catch(() => {});
                        }}
                        onToggleCollapse={(id) => {
                            // Explicit collapse must roll up immediately even
                            // with the pointer still inside (mouseenter only
                            // re-fires after leaving and re-entering)
                            setHoverCellId(null);
                            updateCell(id, (c) => ({ ...c, collapsed: !c.collapsed }));
                        }}
                        onToggleHoverExpand={(id) =>
                            updateCell(id, (c) => ({ ...c, hover_expand: !c.hover_expand }))
                        }
                        onIconMenu={(cellId, icon) => { void showIconMenu(icon, cellId); }}
                        showTitles={config()?.show_titles ?? true}
                        hovered={hoverCellId() === cell.id}
                        onHover={cellHover}
                        onNewCell={createNewCell}
                        onExit={() => invoke('quit_app').catch(() => {})}
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
                            selected={selectedId() === icon.id}
                            onSelect={(ic) => setSelectedId(ic.id)}
                            onOpen={openIcon}
                            onNativeMenu={(ic) => { void showIconMenu(ic); }}
                            labelClass="desktop-icon-label"
                            onDragStart={(iconId, e) => {
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setDragState({
                                    iconId, source: 'free', cellId: '', icon,
                                    x: e.clientX, y: e.clientY,
                                    startX: e.clientX, startY: e.clientY,
                                    offsetX: e.clientX - rect.left,
                                    offsetY: e.clientY - rect.top,
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
                            label: t('desktop.context.settings'),
                            icon: <FiSettings />,
                            onClick: () => setSettingsOpen(true),
                        },
                        {
                            label: t('desktop.context.organize'),
                            icon: <FiGrid />,
                            onClick: () => { void organizeDesktop(); },
                        },
                        {
                            label: t('desktop.context.reset'),
                            icon: <FiTrash2 />,
                            destructive: true,
                            onClick: async () => {
                                try {
                                    // Bug fix: the returned config was ignored before, so
                                    // reset never updated the UI. Apply it, then reconcile
                                    // to assign grid slots to the fresh (sentinel) icons.
                                    setConfig(await invoke<DeskConfig>('reset_config'));
                                    await reconcileDesktop();
                                } catch {
                                    toast.error(t('toast.load_config_failed'));
                                }
                            },
                        },
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
            />

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
                        </div>
                    </Show>
                )}
            </Show>
        </div>
    );
}
