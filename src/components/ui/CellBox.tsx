/**
 * CellBox — a draggable, resizable desktop cell (fence/box) that holds icons.
 * Drag the cell by its title bar or empty area.
 * Drop external icons onto the cell to add them.
 */
import { createSignal, createMemo, onMount, onCleanup, For, type JSX } from 'solid-js';
import { cn } from '~/lib/utils';
import { useI18n } from '~/i18n';
import { type Cell } from '@bindings/Cell';
import { type DesktopIcon as DesktopIconData } from '@bindings/DesktopIcon';
import DesktopIconComponent from './DesktopIcon';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { FiPlus, FiTrash2, FiSettings, FiPower, FiChevronUp } from 'solid-icons/fi';

export interface CellBoxProps {
    /** The cell data */
    cell: Cell;
    /** Called when cell position changes after drag */
    onMove: (id: string, x: number, y: number) => void;
    /** Called when cell size changes after resize */
    onResize?: (id: string, w: number, h: number) => void;
    /** Called when an icon is clicked (should open file) */
    onOpenIcon: (icon: DesktopIconData) => void;
    /** Called to remove an icon from the cell */
    onRemoveIcon: (cellId: string, iconId: string) => void;
    /** Called when icons are dropped onto the cell */
    onDropIcons: (cellId: string, iconPaths: string[]) => void;
    /** Called when an existing icon is dragged from another cell into this one */
    onMoveIcon?: (iconId: string, targetCellId: string) => void;
    /** Called when an icon starts being dragged (pointer-event simulated) */
    onDragStart?: (iconId: string, cellId: string, icon: DesktopIconData, e: PointerEvent) => void;
    /** Called to delete the cell */
    onDelete: (id: string) => void;
    /** Called to request adding icons via file dialog */
    onAddIcons: (cellId: string) => void;
    /** Called to create a new empty cell */
    onNewCell?: () => void;
    /** Called to exit DeskChan (restore files and quit) */
    onExit?: () => void;
    /** Override class for the cell container */
    class?: string;
    /** Override class for the title bar */
    titleClass?: string;
    /** Override class for the icon area */
    contentClass?: string;
}

/**
 * A desktop cell box that contains icons. Supports drag-to-move,
 * drop-to-add-icons, right-click context menu, and a draggable resize handle.
 */
export default function CellBox(props: CellBoxProps) {
    const { t } = useI18n();
    const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number } | null>(null);
    const [isDragging, setIsDragging] = createSignal(false);
    const [collapsed, setCollapsed] = createSignal(false);

    let cellRef!: HTMLDivElement;
    let dragOffset = { x: 0, y: 0 };
    let dragStartPos = { x: 0, y: 0 };

    // --- Drag to move ---
    const handleMouseDown = (e: MouseEvent) => {
        // Only start drag from title bar or empty area (not from icon clicks)
        const target = e.target as HTMLElement;
        if (target.closest('[data-icon]') || target.closest('button')) return;

        e.preventDefault();
        setIsDragging(true);

        dragStartPos = { x: e.clientX, y: e.clientY };
        dragOffset = {
            x: e.clientX - props.cell.rect.x,
            y: e.clientY - props.cell.rect.y,
        };

        const handleMouseMove = (ev: MouseEvent) => {
            const dx = ev.clientX - dragStartPos.x;
            const dy = ev.clientY - dragStartPos.y;
            // Only start moving after a 3px threshold (distinguish from click)
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;

            const newX = ev.clientX - dragOffset.x;
            const newY = ev.clientY - dragOffset.y;
            cellRef.style.left = `${newX}px`;
            cellRef.style.top = `${newY}px`;
        };

        const handleMouseUp = (ev: MouseEvent) => {
            setIsDragging(false);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);

            const newX = ev.clientX - dragOffset.x;
            const newY = ev.clientY - dragOffset.y;
            if (newX !== props.cell.rect.x || newY !== props.cell.rect.y) {
                props.onMove(props.cell.id, Math.max(0, newX), Math.max(0, newY));
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    // --- Context menu ---
    const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
    };

    const menuItems = (): MenuItem[] => [
        ...(props.onNewCell
            ? [{
                  label: t('desktop.context.new_cell'),
                  icon: <FiPlus />,
                  onClick: () => props.onNewCell?.(),
              }]
            : []),
        {
            label: t('cell.context.add_icon'),
            icon: <FiPlus />,
            onClick: () => props.onAddIcons(props.cell.id),
        },
        {
            label: t('cell.context.settings'),
            icon: <FiSettings />,
            onClick: () => {
                /* TODO: open cell settings */
            },
        },
        {
            label: t('cell.context.delete_cell'),
            icon: <FiTrash2 />,
            destructive: true,
            onClick: () => props.onDelete(props.cell.id),
        },
        ...(props.onExit
            ? [{
                  label: t('desktop.context.exit'),
                  icon: <FiPower />,
                  destructive: true,
                  onClick: () => props.onExit?.(),
              }]
            : []),
    ];

    // --- Drop icons onto cell (native DOM events for WebView2 compat) ---
    const handleDragOver = (e: Event) => {
        e.preventDefault();
        (e as DragEvent).dataTransfer!.dropEffect = 'move';
    };

    const handleDrop = (e: Event) => {
        const ev = e as DragEvent;
        ev.preventDefault();
        ev.stopPropagation();

        // External file drops only (internal icon moves use pointer events)
        if (ev.dataTransfer?.files && ev.dataTransfer.files.length > 0) {
            const paths: string[] = [];
            for (let i = 0; i < ev.dataTransfer.files.length; i++) {
                const file = ev.dataTransfer.files[i];
                paths.push((file as unknown as { path?: string }).path ?? file.name);
            }
            if (paths.length > 0) {
                props.onDropIcons(props.cell.id, paths);
            }
        }
    };

    // Register native listeners on mount (bypasses SolidJS event delegation)
    onMount(() => {
        cellRef.addEventListener('dragenter', handleDragOver);
        cellRef.addEventListener('dragover', handleDragOver);
        cellRef.addEventListener('drop', handleDrop);
    });

    onCleanup(() => {
        cellRef.removeEventListener('dragenter', handleDragOver);
        cellRef.removeEventListener('dragover', handleDragOver);
        cellRef.removeEventListener('drop', handleDrop);
    });

    // Background style with optional custom color
    const bgStyle = createMemo(() => {
        const bg = props.cell.background_color;
        const opacity = props.cell.opacity;
        if (bg) {
            return { backgroundColor: bg, opacity };
        }
        return { opacity };
    });

    return (
        <>
            <div
                ref={cellRef}
                class={cn(
                    'glass-panel deskchan-no-select',
                    'absolute flex flex-col overflow-hidden',
                    'min-w-[120px] min-h-[80px]',
                    isDragging() && 'cursor-grabbing shadow-2xl',
                    'transition-shadow duration-150',
                    props.class,
                )}
                style={{
                    left: `${props.cell.rect.x}px`,
                    top: `${props.cell.rect.y}px`,
                    width: `${props.cell.rect.width}px`,
                    ...(collapsed() ? {} : { height: `${props.cell.rect.height}px` }),
                    ...bgStyle(),
                }}
                onMouseDown={handleMouseDown}
                onContextMenu={handleContextMenu}
            >
                {/* Title bar */}
                <div
                    class={cn(
                        'flex items-center gap-2 px-3 py-1.5',
                        'text-xs font-medium text-gray-500 dark:text-gray-400',
                        'cursor-grab border-b border-gray-200/50 dark:border-gray-600/30',
                        'flex-shrink-0',
                        props.titleClass,
                    )}
                    onMouseDown={handleMouseDown}
                >
                    <span class="flex-1 truncate">{props.cell.title}</span>
                    <button
                        onClick={() => setCollapsed((v) => !v)}
                        class={cn(
                            'p-0.5 rounded hover:bg-gray-200/60 dark:hover:bg-gray-600/40',
                            'transition-transform duration-200',
                            collapsed() && 'rotate-180',
                        )}
                        title={collapsed() ? 'Expand' : 'Collapse'}
                    >
                        <FiChevronUp class="w-3.5 h-3.5" />
                    </button>
                </div>

                {/* Icon area — hidden when collapsed */}
                {!collapsed() && (
                    <div
                        class={cn(
                            'flex-1 overflow-y-auto p-2 cell-scrollbar',
                            props.cell.layout === 'Grid'
                                ? 'flex flex-wrap content-start gap-1'
                                : 'flex flex-col gap-0.5',
                            props.contentClass,
                        )}
                    >
                        {props.cell.icons.length === 0 ? (
                            <div class="flex items-center justify-center h-full text-xs text-gray-400 dark:text-gray-500 italic">
                                {t('cell.empty_hint')}
                            </div>
                        ) : (
                            <For each={props.cell.icons}>
                                {(icon) => (
                                    <div data-icon>
                                        <DesktopIconComponent
                                            icon={icon}
                                            onOpen={props.onOpenIcon}
                                            onRemove={(ic) => props.onRemoveIcon(props.cell.id, ic.id)}
                                            onDragStart={props.onDragStart
                                                ? (iconId, e) => props.onDragStart!(iconId, props.cell.id, icon, e)
                                                : undefined}
                                        />
                                    </div>
                                )}
                            </For>
                        )}
                    </div>
                )}

                {/* Resize handle — hidden when collapsed */}
                {!collapsed() && (
                    <div
                        class={cn(
                            'absolute bottom-0 right-0 w-4 h-4',
                            'cursor-se-resize',
                            'hover:bg-brand-primary/20 rounded-bl',
                        )}
                        onMouseDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const startX = e.clientX;
                        const startY = e.clientY;
                        const startW = props.cell.rect.width;
                        const startH = props.cell.rect.height;

                        const handleMouseMove = (ev: MouseEvent) => {
                            const newW = Math.max(120, startW + (ev.clientX - startX));
                            const newH = Math.max(80, startH + (ev.clientY - startY));
                            props.onResize?.(props.cell.id, newW, newH);
                        };

                        const handleMouseUp = () => {
                            document.removeEventListener('mousemove', handleMouseMove);
                            document.removeEventListener('mouseup', handleMouseUp);
                        };

                        document.addEventListener('mousemove', handleMouseMove);
                        document.addEventListener('mouseup', handleMouseUp);
                    }}
                />
                )}
            </div>

            {/* Context menu */}
            {contextMenu() && (
                <ContextMenu
                    items={menuItems()}
                    position={contextMenu()!}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </>
    );
}

export type { Cell, DesktopIconData };
