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
import { FiPlus, FiRefreshCw, FiSettings, FiPower, FiTrash2 } from 'solid-icons/fi';
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

    // ── Load config ──────────────────────────────────────────────────────
    onMount(async () => {
        try {
            setConfig(await invoke<DeskConfig>('get_config'));
        } catch {
            toast.error('Failed to load configuration');
        }
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
    const reportRegions = () => {
        const cfg = config();
        if (!cfg) return;
        const regions: CellRect[] = cfg.cells.map((c) => c.rect);
        invoke('update_cell_regions', { regions }).catch(() => {});
    };

    let initialReportDone = false;
    createEffect(() => {
        const cfg = config();
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

    // ── DOM drag-and-drop (file drops + icon moves) ──────────────────────
    const handleDomDrop = (e: DragEvent) => {
        e.preventDefault();

        // Internal icon move — dropped on desktop background (outside any cell)
        const iconId = e.dataTransfer?.getData('application/deskchan-icon')
            || e.dataTransfer?.getData('text/plain');
        if (iconId) {
            const found = findIconCell(iconId);
            if (found) {
                // Move icon out of its cell into a new standalone cell
                const cellId = crypto.randomUUID();
                const newCell: Cell = {
                    id: cellId,
                    title: found.icon.name,
                    rect: { x: e.clientX - 80, y: e.clientY - 60, width: 160, height: 120 },
                    background_color: null,
                    opacity: 0.85,
                    layout: 'Grid',
                    icons: [],
                };
                setConfig((p) => (p ? { ...p, cells: [...p.cells, newCell] } : p));
                moveIconToCell(iconId, cellId);
            }
            return;
        }

        // External file drops
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
    return (
        <div
            class="fixed inset-0 w-screen h-screen"
            onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY });
            }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; }}
            onDrop={handleDomDrop}
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
        </div>
    );
}
