/**
 * CellBox — a draggable, resizable desktop cell (fence/box) that holds icons.
 * Drag the cell by its title bar or empty area.
 * Drop external icons onto the cell to add them.
 * Double-click the title bar to roll the cell up to its title (Coodesker
 * style) — the collapsed state is persisted in the config.
 * The title-bar corner button switches the collapse MODE (Coodesker style):
 * auto (roll up on leave, expand on hover; up+down chevron icon) vs manual
 * (pinned; single chevron icon).
 */
import { createSignal, createMemo, onMount, onCleanup, For, Show } from 'solid-js';
import { cn } from '~/lib/utils';
import { useI18n } from '~/i18n';
import { CELL_TITLEBAR_H } from '~/lib/grid';
import { type Cell } from '@bindings/Cell';
import { type DesktopIcon as DesktopIconData } from '@bindings/DesktopIcon';
import DesktopIconComponent from './DesktopIcon';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { FiPlus, FiTrash2, FiSettings, FiPower, FiChevronUp } from 'solid-icons/fi';
import { BsChevronDown, BsChevronExpand } from 'solid-icons/bs';

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
    /** Called to toggle the persisted collapsed state */
    onToggleCollapse: (id: string) => void;
    /** Called to toggle hover-expand mode (auto-unroll while hovered) */
    onToggleHoverExpand: (id: string) => void;
    /** Called on icon right-click — shows the native shell menu */
    onIconMenu?: (cellId: string, icon: DesktopIconData) => void;
    /** Whether cell title bars are shown (collapsed cells always keep theirs) */
    showTitles?: boolean;
    /** Live hover state — owned by Desktop so it survives cell re-creation */
    hovered?: boolean;
    /** Reports pointer enter/leave; Desktop debounces the leave */
    onHover?: (id: string, inside: boolean) => void;
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
    // Live-resize must bypass the height transition, or the cell lags the cursor
    const [isResizing, setIsResizing] = createSignal(false);
    const collapsed = () => props.cell.collapsed;

    // Hover-expand (Coodesker's second collapse mode): while the pointer is
    // over a collapsed cell, temporarily unroll it; roll back shortly after
    // the pointer leaves. The hover state itself lives in Desktop (keyed by
    // cell id) so it survives this component being re-created on data change.
    /** What is actually rendered right now (persisted state + hover). */
    const displayCollapsed = () =>
        collapsed() && !(props.cell.hover_expand && props.hovered === true);
    /** Title bar is always reachable on collapsed cells, else it follows the setting. */
    const showTitleBar = () => props.showTitles !== false || collapsed();

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
        // Keep bar-only actions reachable when titles are hidden
        {
            label: collapsed() ? t('cell.expand') : t('cell.collapse'),
            icon: <FiChevronUp />,
            onClick: () => props.onToggleCollapse(props.cell.id),
        },
        {
            label: t('cell.hover_expand'),
            icon: <BsChevronExpand />,
            onClick: () => props.onToggleHoverExpand(props.cell.id),
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
    const handleDragOver = (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
    };

    const handleDrop = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // External file drops only (internal icon moves use pointer events)
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            const paths: string[] = [];
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                // WebView2 exposes the absolute path on the File object
                const file = e.dataTransfer.files[i] as File & { path?: string };
                paths.push(file.path ?? file.name);
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
            // Solid style objects take kebab-case CSS property names —
            // camelCase keys are silently ignored by style.setProperty.
            return { 'background-color': bg, opacity };
        }
        return { opacity };
    });

    return (
        <>
            <div
                ref={cellRef}
                data-cell-id={props.cell.id}
                class={cn(
                    'glass-panel deskchan-no-select',
                    'absolute flex flex-col overflow-hidden',
                    'min-w-[120px]',
                    !displayCollapsed() && 'min-h-[80px]',
                    // Collapsed cells stay raised so neither hover roll-up nor
                    // the collapse animation lets covered content pop in front
                    collapsed() && 'z-30',
                    isDragging() && 'cursor-grabbing shadow-2xl',
                    // Smooth Coodesker-style roll-up/down (height) + shadow.
                    // Disabled during live resize so the cell tracks the cursor.
                    !isResizing() && 'cell-height-anim',
                    props.class,
                )}
                style={{
                    left: `${props.cell.rect.x}px`,
                    top: `${props.cell.rect.y}px`,
                    width: `${props.cell.rect.width}px`,
                    height: `${displayCollapsed() ? CELL_TITLEBAR_H : props.cell.rect.height}px`,
                    ...bgStyle(),
                }}
                onMouseDown={handleMouseDown}
                onContextMenu={handleContextMenu}
                onMouseEnter={() => props.onHover?.(props.cell.id, true)}
                onMouseLeave={() => props.onHover?.(props.cell.id, false)}
                onDblClick={(e) => {
                    // With the title bar hidden there is no other collapse
                    // affordance — double-click on the body toggles instead.
                    if (showTitleBar()) return;
                    const el = e.target as HTMLElement;
                    if (el.closest('[data-icon]') || el.closest('button')) return;
                    props.onToggleCollapse(props.cell.id);
                }}
            >
                {/* Title bar — double-click rolls the cell up/down */}
                <Show when={showTitleBar()}>
                    <div
                        class={cn(
                            'flex items-center gap-2 px-3',
                            'text-xs font-medium text-gray-500 dark:text-gray-400',
                            'cursor-grab flex-shrink-0',
                            !displayCollapsed() && 'border-b border-gray-200/50 dark:border-gray-600/30',
                            props.titleClass,
                        )}
                        style={{ height: `${CELL_TITLEBAR_H}px` }}
                        onMouseDown={handleMouseDown}
                        onDblClick={() => props.onToggleCollapse(props.cell.id)}
                    >
                        <span class="flex-1 truncate">{props.cell.title}</span>
                        {/* Icon count badge — visible when rolled up */}
                        {displayCollapsed() && (
                            <span class="text-[10px] text-gray-400 dark:text-gray-500 tabular-nums">
                                {props.cell.icons.length}
                            </span>
                        )}
                        {/* Mode switch (Coodesker style): CLICK TOGGLES THE
                            COLLAPSE MODE, and the icon shows the current one —
                            auto (roll up on leave / expand on hover) is the
                            up+down chevron, manual (pinned) a single chevron.
                            Collapse itself is a title-bar double-click. */}
                        <button
                            onClick={(e) => { e.stopPropagation(); props.onToggleHoverExpand(props.cell.id); }}
                            onDblClick={(e) => e.stopPropagation()}
                            class={cn(
                                'p-1 rounded-md transition-colors duration-150',
                                'text-gray-400 dark:text-gray-500',
                                'hover:text-gray-700 dark:hover:text-gray-200',
                                'hover:bg-gray-200/50 dark:hover:bg-gray-600/40',
                            )}
                            title={t('cell.hover_expand')}
                        >
                            {props.cell.hover_expand
                                ? <BsChevronExpand class="w-3 h-3" />
                                : <BsChevronDown class="w-3 h-3" />}
                        </button>
                    </div>
                </Show>

                {/* Icon area — stays mounted while collapsed (clipped by the
                    animated container height) so expanding is instant */}
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
                                        onNativeMenu={props.onIconMenu
                                            ? (ic) => props.onIconMenu!(props.cell.id, ic)
                                            : undefined}
                                    />
                                </div>
                            )}
                        </For>
                    )}
                </div>

                {/* Resize handle — hidden when rolled up */}
                {!displayCollapsed() && (
                    <div
                        class={cn(
                            'absolute bottom-0 right-0 w-4 h-4',
                            'cursor-se-resize',
                            'hover:bg-brand-primary/20 rounded-bl',
                        )}
                        onMouseDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setIsResizing(true);
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
                            setIsResizing(false);
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
