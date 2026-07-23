/**
 * Desktop �?main application surface.
 * Manages cells, drag-and-drop, right-click menu, config persistence,
 * and reports cell regions to Rust for click-through cursor polling.
 */
import { createSignal, onMount, onCleanup, createEffect, For } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useI18n } from '~/i18n';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { Cell } from '@bindings/Cell';
import type { CellRect } from '@bindings/CellRect';
import type { DesktopIcon as DIcon } from '@bindings/DesktopIcon';
import CellBox from './ui/CellBox';
import ContextMenu, { type MenuItem } from './ui/ContextMenu';
import SettingsDialog from './ui/SettingsDialog';
import { FiPlus, FiRefreshCw, FiSettings, FiPower, FiTrash2, FiFile } from 'solid-icons/fi';
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
    interface DragState { iconId: string; cellId: string; icon: DIcon; x: number; y: number; offsetX: number; offsetY: number; }
    const [dragState, setDragState] = createSignal<DragState | null>(null);

    // ── Load config ──────────────────────────────────────────────────────
    onMount(async () => {
        try {
            setConfig(await invoke<DeskConfig>('get_config'));
        } catch {
            toast.error('Failed to load configuration');
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
        const onMove = (e: PointerEvent) => {
            setDragState((prev) => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
        };
        const onEnd = () => {
            const ds = dragState();
            if (!ds) return;
            const targetCell = cellAtPoint(ds.x, ds.y);
            if (targetCell && targetCell !== ds.cellId) {
                moveIconToCell(ds.iconId, targetCell);
            } else if (!targetCell) {
                const newId = crypto.randomUUID();
                setConfig((p) => p ? {
                    ...p,
                    cells: p.cells.map((c) => c.id === ds.cellId
                        ? { ...c, icons: c.icons.filter((i) => i.id !== ds.iconId) }
                        : c
                    ).concat({
                        id: newId, title: ds.icon.name,
                        rect: { x: ds.x - 80, y: ds.y - 60, width: 160, height: 120 },
                        background_color: null, opacity: 0.85, layout: 'Grid' as const, icons: [ds.icon],
                    }),
                } : p);
            }
            setDragState(null);
            invoke('set_dragging', { dragging: false }).catch(() => {});
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointerleave', onEnd);  // cursor leaves window → cancel drag
        window.addEventListener('pointercancel', onEnd); // OS cancels pointer → clean up
        onCleanup(() => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointerleave', onEnd);
            window.removeEventListener('pointercancel', onEnd);
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

    // ── Report cell regions to Rust (for cursor polling) ─────────────────
    const FULL_SCREEN: CellRect = { x: 0, y: 0, width: 99999, height: 99999 };

    const reportRegions = () => {
        // During simulated drag or context menu: disable click-through
        if (dragState() || contextMenu()) {
            invoke('update_cell_regions', { regions: [FULL_SCREEN] }).catch(() => {});
            return;
        }
        const cfg = config();
        if (!cfg) return;
        const regions: CellRect[] = cfg.cells.map((c) => c.rect);
        invoke('update_cell_regions', { regions }).catch(() => {});
    };

    let initialReportDone = false;
    createEffect(() => {
        const cfg = config();
        // Force re-evaluation when drag or menu state changes
        void dragState();
        void contextMenu();
        if (!cfg) return;
        if (!initialReportDone) {
            initialReportDone = true;
            reportRegions();
        } else {
            const timer = setTimeout(reportRegions, 40);
            onCleanup(() => clearTimeout(timer));
        }
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
            name: filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'Unknown',
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
                            title: filePath.split(/[\\/]/).pop() ?? 'Cell',
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
            title: 'Cell',
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
            const selected = await open({ multiple: true, title: 'Select files to add' });
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
                                toast.error('Failed to open file');
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
                                iconId, cellId, icon,
                                x: e.clientX, y: e.clientY,
                                offsetX: e.clientX - rect.left,
                                offsetY: e.clientY - rect.top,
                            });
                            // Prevent Rust polling from enabling click-through during drag
                            invoke('set_dragging', { dragging: true }).catch(() => {});
                        }}
                        onNewCell={createNewCell}
                        onExit={() => invoke('quit_app').catch(() => {})}
                    />
                )}
            </For>

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
            {dragState() && (
                <div
                    class="fixed z-[10000] pointer-events-none flex flex-col items-center gap-0.5 p-1.5 rounded-lg bg-white/80 dark:bg-gray-800/80 shadow-lg"
                    style={{
                        left: `${dragState()!.x - dragState()!.offsetX}px`,
                        top: `${dragState()!.y - dragState()!.offsetY}px`,
                        width: '72px',
                    }}
                >
                    <div class="w-8 h-8 flex items-center justify-center">
                        <FiFile class="text-lg text-gray-400 dark:text-gray-500" />
                    </div>
                    <span class="text-xs text-gray-700 dark:text-gray-200 truncate max-w-full">
                        {dragState()!.icon.name.length > 10
                            ? dragState()!.icon.name.slice(0, 9) + '\u2026'
                            : dragState()!.icon.name}
                    </span>
                </div>
            )}
        </div>
    );
}
