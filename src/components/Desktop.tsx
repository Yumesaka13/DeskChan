/**
 * Desktop �?main application surface.
 * Manages cells, drag-and-drop, right-click menu, config persistence,
 * and reports cell regions to Rust for click-through cursor polling.
 */
import { createSignal, onMount, onCleanup, createEffect, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useI18n } from '~/i18n';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { Cell } from '@bindings/Cell';
import type { DesktopIcon as DIcon } from '@bindings/DesktopIcon';
import CellBox from './ui/CellBox';
import DesktopIconComponent from './ui/DesktopIcon';
import ContextMenu, { type MenuItem } from './ui/ContextMenu';
import SettingsDialog from './ui/SettingsDialog';
import { FiPlus, FiRefreshCw, FiSettings, FiPower, FiTrash2, FiFile, FiGrid } from 'solid-icons/fi';
import toast from 'solid-toast';

/** Shape of Tauri v2 drag-drop event payload. */
interface DragDropPayload {
    type: string;
    paths?: string[];
    position?: { x: number; y: number };
}

export default function Desktop() {
    const { t } = useI18n();
    const [config, setConfig] = createSignal<DeskConfig | null>(null);
    const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number } | null>(null);
    const [settingsOpen, setSettingsOpen] = createSignal(false);

    // ── Pointer-event simulated drag state ───────────────────────────────
    interface DragState { iconId: string; source: 'cell' | 'free'; cellId: string; icon: DIcon; x: number; y: number; offsetX: number; offsetY: number; }
    const [dragState, setDragState] = createSignal<DragState | null>(null);

    // ── Load config ──────────────────────────────────────────────────────
    onMount(async () => {
        try {
            setConfig(await invoke<DeskConfig>('get_config'));
        } catch {
            toast.error(t('toast.load_config_failed'));
        }
    });

    // ── Keyboard shortcuts: context menu + cancel drag ───────────────────
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            // Shift+F10 or ContextMenu key → open menu (works when click-through active)
            if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
                e.preventDefault();
                setContextMenu({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
            }
            // Escape → cancel drag / close menu
            if (e.key === 'Escape') {
                setDragState(null);
                setContextMenu(null);
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
                return { ...prev, x: e.clientX, y: e.clientY };
            });
        };

        const onEnd = () => {
            if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
            const ds = dragState();
            if (!ds) return;
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
            } else if (!targetCell && ds.source === 'cell') {
                setConfig((p) => p ? {
                    ...p,
                    cells: p.cells.map((c) => c.id === ds.cellId ? { ...c, icons: c.icons.filter((i) => i.id !== ds.iconId) } : c),
                    free_icons: [...p.free_icons, ds.icon],
                } : p);
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

    /** Create an icon entry and add it to a cell (no file movement �?just config). */
    const addIconToCell = (cellId: string, filePath: string) => {
        const icon: DIcon = {
            id: crypto.randomUUID(),
            name: filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? t('default.icon_name'),
            path: filePath,
            icon_path: null,
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

    /** Find the cell containing an icon by its ID. */
    const findIconCell = (iconId: string): { cellId: string; icon: DIcon } | null => {
        const cfg = config();
        if (!cfg) return null;
        for (const cell of cfg.cells) {
            const icon = cell.icons.find((i) => i.id === iconId);
            if (icon) return { cellId: cell.id, icon };
        }
        return null;
    };
    /** Find which cell (if any) is at the given coordinates. */
    const cellAtPoint = (x: number, y: number): string | null => {
        const cfg = config();
        if (!cfg) return null;
        return (
            cfg.cells.find(
                (c) =>
                    x >= c.rect.x &&
                    x <= c.rect.x + c.rect.width &&
                    y >= c.rect.y &&
                    y <= c.rect.y + c.rect.height,
            )?.id ?? null
        );
    };

    // ── External file drops (from Explorer via HTML5 drag) ───────────────
    const handleDomDrop = (e: DragEvent) => {
        e.preventDefault();
        const files = e.dataTransfer?.files;
        if (!files?.length) return;

        const targetCell = cellAtPoint(e.clientX, e.clientY);

        for (let i = 0; i < files.length; i++) {
            const file = files[i] as File & { path?: string };
            const filePath = file.path ?? file.name;
            if (targetCell) {
                addIconToCell(targetCell, filePath);
            } else {
                const cellId = crypto.randomUUID();
                const newCell: Cell = {
                    id: cellId,
                    title: filePath.split(/[\\/]/).pop() ?? 'Cell',
                    rect: { x: e.clientX - 160, y: e.clientY - 120, width: 320, height: 240 },
                    background_color: null,
                    opacity: 0.85,
                    layout: 'Grid',
                    icons: [],
                };
                setConfig((p) => (p ? { ...p, cells: [...p.cells, newCell] } : p));
                addIconToCell(cellId, filePath);
            }
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

                const targetCell = cellAtPoint(cssX, cssY);
                for (const filePath of p.paths) {
                    if (targetCell) {
                        addIconToCell(targetCell, filePath);
                    } else {
                        const cellId = crypto.randomUUID();
                        const newCell: Cell = {
                            id: cellId,
                            title: filePath.split(/[\\/]/).pop() ?? t('default.cell_title'),
                            rect: { x: cssX - 160, y: cssY - 120, width: 320, height: 240 },
                            background_color: null,
                            opacity: 0.85,
                            layout: 'Grid',
                            icons: [],
                        };
                        setConfig((p2) => (p2 ? { ...p2, cells: [...p2.cells, newCell] } : p2));
                        addIconToCell(cellId, filePath);
                    }
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
            icons: [],
        };
        setConfig((p) => (p ? { ...p, cells: [...p.cells, newCell] } : p));
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
        window.addEventListener('drop', handleDomDrop as unknown as EventListener, { capture: true });
        onCleanup(() => {
            window.removeEventListener('dragenter', allow, { capture: true });
            window.removeEventListener('dragover', allow, { capture: true });
            window.removeEventListener('drop', handleDomDrop as unknown as EventListener, { capture: true });
        });
    });

    return (
        <div
            ref={desktopRef}
            class="fixed inset-0 w-screen h-screen"
            // 0.01 opacity prevents WebView2 from leaking drag to OS desktop.
            // 0.005 gets rounded to 0 by Chromium; 0.01 is the minimum safe value.
            style={{ "background-color": "rgba(255, 255, 255, 0.01)" }}
            onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY });
            }}
        >
            {/* Cells �?<For> with key prevents destroying/recreating components on config change */}
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
                        onOpenIcon={async (ic) => {
                            try {
                                await invoke('open_file', { path: ic.path });
                            } catch {
                                toast.error(t('toast.open_file_failed'));
                            }
                        }}
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
                                offsetX: e.clientX - rect.left,
                                offsetY: e.clientY - rect.top,
                            });
                            invoke('set_dragging', { dragging: true }).catch(() => {});
                        }}
                        onNewCell={createNewCell}
                        onExit={() => invoke('quit_app').catch(() => {})}
                    />
                )}
            </For>

            {/* Free-floating icons (desktop grid, top-to-bottom like Windows) */}
            <div class="absolute top-2 left-2 flex flex-col flex-wrap content-start gap-1" style="max-height: calc(100vh - 20px); max-width: calc(100vw - 20px);">
                <For each={config()?.free_icons ?? []}>
                    {(icon) => (
                        <div data-icon>
                            <DesktopIconComponent
                                icon={icon}
                                onOpen={async (ic) => {
                                    try { await invoke('open_file', { path: ic.path }); } catch { toast.error(t('toast.open_file_failed')); }
                                }}
                                onRemove={(ic) => setConfig((p) => p ? { ...p, free_icons: p.free_icons.filter((i) => i.id !== ic.id) } : p)}
                                onDragStart={(iconId, e) => {
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    setDragState({ iconId, source: 'free', cellId: '', icon, x: e.clientX, y: e.clientY, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top });
                                    invoke('set_dragging', { dragging: true }).catch(() => {});
                                }}
                            />
                        </div>
                    )}
                </For>
            </div>

            {/* Empty state */}
            {config() && config()!.cells.length === 0 && (
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
                            onClick: async () => {
                                try {
                                    setConfig(await invoke<DeskConfig>('get_config'));
                                } catch {
                                    /* ignore */
                                }
                            },
                        },
                        {
                            label: t('desktop.context.settings'),
                            icon: <FiSettings />,
                            onClick: () => setSettingsOpen(true),
                        },
                        {
                            label: t('desktop.context.organize'),
                            icon: <FiGrid />,
                            onClick: async () => {
                                try {
                                    setConfig(await invoke<DeskConfig>('organize_icons'));
                                } catch {
                                    toast.error(t('toast.organize_failed'));
                                }
                            },
                        },
                        {
                            label: t('desktop.context.reset'),
                            icon: <FiTrash2 />,
                            destructive: true,
                            onClick: () => {
                                invoke('reset_config').catch(() => {});
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

            {/* Drag ghost — follows cursor during simulated drag */}
            <Show when={dragState()}>
                {(ds) => (
                    <div
                        class="fixed z-[10000] pointer-events-none flex flex-col items-center gap-0.5 p-1.5 rounded-lg bg-white/80 dark:bg-gray-800/80 shadow-lg"
                        style={{
                            left: `${ds().x - ds().offsetX}px`,
                            top: `${ds().y - ds().offsetY}px`,
                            width: '72px',
                        }}
                    >
                        <div class="w-8 h-8 flex items-center justify-center">
                            <FiFile class="text-lg text-gray-400 dark:text-gray-500" />
                        </div>
                        <span class="text-xs text-gray-700 dark:text-gray-200 truncate max-w-full">
                            {ds().icon.name.length > 10
                                ? ds().icon.name.slice(0, 9) + '\u2026'
                                : ds().icon.name}
                        </span>
                    </div>
                )}
            </Show>
        </div>
    );
}
