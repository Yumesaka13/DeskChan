/**
 * Desktop — main application surface.
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
import { FiPlus, FiRefreshCw, FiSettings, FiPower } from 'solid-icons/fi';
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

    /** Move a file into managed storage and add its icon to the cell. */
    const moveIconToCell = async (cellId: string, filePath: string) => {
        try {
            const result = await invoke<DIcon>('move_icon_to_cell', { path: filePath, cellId });
            updateCell(cellId, (c) => ({ ...c, icons: [...c.icons, result] }));
        } catch (e) {
            toast.error(`Failed to move: ${e}`);
        }
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

    // ── DOM drag-and-drop (browser-level file drops) ─────────────────────
    const handleDomDrop = (e: DragEvent) => {
        e.preventDefault();
        const files = e.dataTransfer?.files;
        if (!files?.length) return;

        const targetCell = cellAtPoint(e.clientX, e.clientY);

        for (let i = 0; i < files.length; i++) {
            const file = files[i] as File & { path?: string };
            const filePath = file.path ?? file.name;
            if (targetCell) {
                moveIconToCell(targetCell, filePath);
            } else {
                // Drop outside any cell → create a new cell and move file into it
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
                moveIconToCell(cellId, filePath);
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
                        moveIconToCell(targetCell, filePath);
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
                        moveIconToCell(cellId, filePath);
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
                moveIconToCell(cellId, p);
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
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDomDrop}
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
                        onOpenIcon={async (ic) => {
                            try {
                                await invoke('open_file', { path: ic.path });
                            } catch {
                                toast.error('Failed to open file');
                            }
                        }}
                        onRemoveIcon={(cid, iid) => {
                            const cfg = config();
                            const icon = cfg?.cells.find(c => c.id === cid)?.icons.find(i => i.id === iid);
                            if (icon?.original_path) {
                                invoke('restore_icon', { path: icon.path, originalPath: icon.original_path }).catch(() => {});
                            }
                            updateCell(cid, (c) => ({ ...c, icons: c.icons.filter((i) => i.id !== iid) }));
                        }}
                        onDropIcons={(cid, paths) => paths.forEach(p => moveIconToCell(cid, p))}
                        onDelete={(id) =>
                            setConfig((p) =>
                                p ? { ...p, cells: p.cells.filter((c) => c.id !== id) } : p,
                            )
                        }
                        onAddIcons={addIconsViaDialog}
                        onNewCell={createNewCell}
                        onExit={() => invoke('restore_and_quit').catch(() => {})}
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
                            label: t('desktop.context.exit'),
                            icon: <FiPower />,
                            destructive: true,
                            onClick: () => {
                                invoke('restore_and_quit').catch(() => {});
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
