/**
 * CellBox - a draggable, resizable desktop cell (fence/box) that holds icons.
 * Drag the cell by its title bar or empty area; resize from any edge/corner.
 * Drop external icons onto the cell to add them (to the active tab).
 * Sub-boxes: cells can contain tabbed sub-boxes, rendered as a WinUI-style
 * tab strip right under the title bar; the cell's own icons are the implicit
 * first tab. Double-click the title or a tab to rename it.
 * The title-bar corner button switches the collapse mode (Coodesker style):
 * auto (roll up on leave, expand on hover; up+down carets) vs manual
 * (pinned open; single caret).
 */
import { createEffect, createSignal, createMemo, onMount, onCleanup, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '~/lib/utils';
import { useI18n } from '~/i18n';
import { CELL_TITLEBAR_H } from '~/lib/grid';
import { activeIcons, totalIconCount } from '~/lib/cell';
import { snapPosition } from '~/lib/snap';
import { type Cell } from '@bindings/Cell';
import { type CellRect } from '@bindings/CellRect';
import { type CellLayout } from '@bindings/CellLayout';
import { type DesktopIcon as DesktopIconData } from '@bindings/DesktopIcon';
import { type SubStyle } from '@bindings/SubStyle';
import { type SortDirection, type SortField } from '~/lib/grid';
import DesktopIconComponent from './DesktopIcon';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { FiCheck, FiPlus, FiTrash2 } from 'solid-icons/fi';
import { BsCaretDownFill, BsCaretUpFill } from 'solid-icons/bs';

export interface CellBoxProps {
    /** The cell data */
    cell: Cell;
    /** Called when cell position changes after drag */
    onMove: (id: string, x: number, y: number) => void;
    /** Called with the full rect after an edge/corner resize commits */
    onResize?: (id: string, rect: CellRect) => void;
    /** Called when an icon is clicked (should open file) */
    onOpenIcon: (icon: DesktopIconData) => void;
    /** Called when icons are dropped onto the cell (lands in the active tab) */
    onDropIcons: (cellId: string, iconPaths: string[]) => void;
    /** Called when an icon starts being dragged (pointer-event simulated) */
    onDragStart?: (iconId: string, cellId: string, icon: DesktopIconData, e: PointerEvent) => void;
    /** Called to toggle hover-expand mode (auto-unroll while hovered) */
    onToggleHoverExpand: (id: string) => void;
    /** Called on icon right-click - shows the native shell menu */
    onIconMenu?: (cellId: string, icon: DesktopIconData, event: MouseEvent) => void;
    /** Shared desktop-wide icon selection (supports Ctrl selection across cells). */
    selectedIconIds?: ReadonlySet<string>;
    onSelectIcon?: (cellId: string, icon: DesktopIconData, event: MouseEvent) => void;
    onClearIconSelection?: () => void;
    showFileExtensions?: boolean;
    /** Extra white contrast layer applied only within this cell. */
    desktopOverlayOpacity?: number;
    /** Called to rename the cell (double-click on the title) */
    onRename: (id: string, title: string) => void;
    /** Called to create a new sub-box tab */
    onCreateSub: (id: string) => void;
    /** Called to switch the active tab (null = the cell's own icons) */
    onSelectSub: (id: string, subId: string | null) => void;
    /** Called to rename a sub-box (double-click on its tab) */
    onRenameSub: (id: string, subId: string, title: string) => void;
    /** Called to delete a sub-box (its icons move to the cell's own tab) */
    onDeleteSub: (id: string, subId: string) => void;
    /** Called to change how the sub-box tabs size themselves */
    onSetSubStyle: (id: string, style: SubStyle) => void;
    /** Change the active cell's icon arrangement. */
    onSetLayout: (id: string, layout: CellLayout) => void;
    onArrangeIcons: (id: string, field: SortField, direction: SortDirection) => void;
    /** Called to toggle this cell's title-bar visibility */
    onToggleShowTitle: (id: string) => void;
    /** Live hover state - owned by Desktop so it survives cell re-creation */
    hovered?: boolean;
    /** Reports pointer enter/leave; Desktop debounces the leave */
    onHover?: (id: string, inside: boolean) => void;
    /** Other cells' screen rects - drag-move magnetically snaps to them */
    snapRects?: CellRect[];
    /** Called to delete the cell */
    onDelete: (id: string) => void;
    /** Override class for the cell container */
    class?: string;
    /** Override class for the title bar */
    titleClass?: string;
    /** Override class for the icon area */
    contentClass?: string;
}

/** Inline rename editor - commits on Enter/blur, cancels on Escape. */
function RenameInput(props: {
    value: string;
    onCommit: (value: string) => void;
    onCancel: () => void;
    class?: string;
}) {
    let ref!: HTMLInputElement;
    onMount(() => {
        ref.focus();
        ref.select();
    });
    const commit = () => {
        const next = ref.value.trim();
        if (next && next !== props.value) props.onCommit(next);
        else props.onCancel();
    };
    return (
        <input
            ref={ref}
            value={props.value}
            onBlur={commit}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') props.onCancel();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            class={cn(
                'bg-transparent rounded px-1 -mx-1 min-w-0',
                'border border-brand-primary dark:border-brand-secondary outline-none',
                props.class,
            )}
        />
    );
}

/**
 * A desktop cell box that contains icons and tabbed sub-boxes. Supports
 * drag-to-move, all-direction resize, drop-to-add-icons, rename-in-place,
 * and a right-click context menu.
 */
export default function CellBox(props: CellBoxProps) {
    const { t } = useI18n();
    const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number } | null>(null);
    const [subMenu, setSubMenu] = createSignal<{ x: number; y: number; subId: string } | null>(null);
    /** Which title is being renamed: the cell itself or a sub-box tab. */
    const [editing, setEditing] = createSignal<{ subId: string | null } | null>(null);
    const [isDragging, setIsDragging] = createSignal(false);
    // Live-resize must bypass the height transition, or the cell lags the cursor
    const [isResizing, setIsResizing] = createSignal(false);
    const sortField = () => props.cell.sort_field as SortField;
    const sortDirection = () => props.cell.sort_direction as SortDirection;
    const collapsed = () => props.cell.collapsed;

    // Hover-expand (Coodesker's second collapse mode): while the pointer is
    // over a collapsed cell, temporarily unroll it; roll back shortly after
    // the pointer leaves. The hover state itself lives in Desktop (keyed by
    // cell id) so it survives this component being re-created on data change.
    /** What is actually rendered right now (persisted state + hover).
     *  An active resize keeps a hover-expanded cell open even if the pointer
     *  strays outside mid-gesture - otherwise the roll-up would snap the
     *  geometry out from under the drag. */
    const displayCollapsed = () =>
        collapsed() && !(props.cell.hover_expand && (props.hovered === true || isResizing()));
    /** Title bar follows the per-cell setting while the cell is DISPLAYED
     *  expanded; a rolled-up cell always shows the bar (it is all there is).
     *  Keying off displayCollapsed - not the persisted flag - is what lets
     *  hover-expanded (auto) cells actually hide their title. */
    const showTitleBar = () => props.cell.show_title || displayCollapsed();

    // Roll-up animation window: the raised layer is held while the height
    // animates shut, or the still-tall box would pop under its neighbors.
    const [rolling, setRolling] = createSignal(false);
    let rollTimer: ReturnType<typeof setTimeout> | null = null;
    let wasOpen = !displayCollapsed();
    createEffect(() => {
        const open = !displayCollapsed();
        if (!open && wasOpen) {
            setRolling(true);
            if (rollTimer) clearTimeout(rollTimer);
            rollTimer = setTimeout(() => setRolling(false), 250); // > 200ms anim
        }
        wasOpen = open;
    });
    onCleanup(() => { if (rollTimer) clearTimeout(rollTimer); });

    let cellRef!: HTMLDivElement;
    let dragOffset = { x: 0, y: 0 };
    let dragStartPos = { x: 0, y: 0 };

    // --- Drag to move ---
    const handleMouseDown = (e: MouseEvent) => {
        // Only start drag from title bar or empty area (not icons/controls)
        const target = e.target as HTMLElement;
        if (target.closest('[data-icon]') || target.closest('button') || target.closest('input')) return;

        if (target.closest('[data-icon-area]')) {
            props.onClearIconSelection?.();
            return;
        }

        e.preventDefault();
        setIsDragging(true);

        dragStartPos = { x: e.clientX, y: e.clientY };
        dragOffset = {
            x: e.clientX - props.cell.rect.x,
            y: e.clientY - props.cell.rect.y,
        };
        // What the on-screen box currently measures - snapping must use the
        // DISPLAYED height so a rolled-up bar butts against neighbors cleanly
        const snapW = props.cell.rect.width;
        const snapH = displayCollapsed() ? CELL_TITLEBAR_H : props.cell.rect.height;
        const snapRects = props.snapRects ?? [];
        let lastPos: { x: number; y: number } | null = null;

        const handleMouseMove = (ev: MouseEvent) => {
            const dx = ev.clientX - dragStartPos.x;
            const dy = ev.clientY - dragStartPos.y;
            // Only start moving after a 3px threshold (distinguish from click)
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;

            // Magnetic alignment against the other cells' edges
            const snapped = snapPosition(
                ev.clientX - dragOffset.x,
                ev.clientY - dragOffset.y,
                snapW,
                snapH,
                snapRects,
            );
            lastPos = snapped;
            cellRef.style.left = `${snapped.x}px`;
            cellRef.style.top = `${snapped.y}px`;
        };

        const handleMouseUp = () => {
            setIsDragging(false);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);

            // Commit exactly what the live preview showed (already snapped)
            if (lastPos && (lastPos.x !== props.cell.rect.x || lastPos.y !== props.cell.rect.y)) {
                props.onMove(props.cell.id, Math.max(0, lastPos.x), Math.max(0, lastPos.y));
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    // --- Resize from any edge or corner (also while rolled up) ---
    // Live feedback writes styles directly (like drag-move) and the rect is
    // committed once on mouseup - going through the config every mousemove
    // would recreate this component per frame (keyed <For>).
    interface ResizeDir { n?: boolean; s?: boolean; e?: boolean; w?: boolean }
    const MIN_W = 120;
    const MIN_H = 80;
    // A watcher reconcile can recreate this component mid-gesture - the
    // document listeners must not outlive it.
    let cancelResize: (() => void) | null = null;
    onCleanup(() => cancelResize?.());
    // The curried handler triggers solid/reactivity, but every reactive read
    // happens at event time (rect snapshotted on mousedown, id on mouseup).
    // eslint-disable-next-line solid/reactivity
    const startResize = (dir: ResizeDir) => (e: MouseEvent) => {
        if (e.button !== 0) return; // right/middle click must never resize
        e.stopPropagation();
        e.preventDefault();
        setIsResizing(true);
        // Keep the Rust polling loop from re-ordering the window mid-gesture
        invoke('set_dragging', { dragging: true }).catch(() => {});
        const startX = e.clientX;
        const startY = e.clientY;
        const r0 = { ...props.cell.rect };
        let last = r0;

        const onMove = (ev: MouseEvent) => {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            let { x, y, width, height } = r0;
            if (dir.e) width = Math.max(MIN_W, r0.width + dx);
            if (dir.s) height = Math.max(MIN_H, r0.height + dy);
            // n/w growth is capped at the screen origin so the title bar can
            // never be dragged (and persisted) off-screen
            if (dir.w) {
                width = Math.max(MIN_W, Math.min(r0.width - dx, r0.x + r0.width));
                x = r0.x + (r0.width - width);
            }
            if (dir.n) {
                height = Math.max(MIN_H, Math.min(r0.height - dy, r0.y + r0.height));
                y = r0.y + (r0.height - height);
            }
            last = { x, y, width, height };
            cellRef.style.left = `${x}px`;
            cellRef.style.top = `${y}px`;
            cellRef.style.width = `${width}px`;
            if (!displayCollapsed()) cellRef.style.height = `${height}px`;
        };
        const onUp = () => {
            cancelResize?.();
            if (last !== r0) props.onResize?.(props.cell.id, last);
        };
        cancelResize = () => {
            cancelResize = null;
            setIsResizing(false);
            invoke('set_dragging', { dragging: false }).catch(() => {});
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };

    // --- Context menus ---
    const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
    };

    const menuItems = (): MenuItem[] => [
        {
            label: t('cell.context.new_sub'),
            icon: <FiPlus />,
            onClick: () => props.onCreateSub(props.cell.id),
        },
        // Tab sizing choice only matters once sub-boxes exist
        {
            label: t('cell.context.show_title'),
            icon: props.cell.show_title ? <FiCheck /> : undefined,
            onClick: () => props.onToggleShowTitle(props.cell.id),
        },
        {
            label: t('cell.context.arrangement'),
            submenu: [
                ...(['Grid', 'List'] as const).map((layout) => ({
                    label: t(layout === 'Grid' ? 'cell.layout.grid' : 'cell.layout.list'),
                    icon: props.cell.layout === layout ? <FiCheck /> : undefined,
                    onClick: () => props.onSetLayout(props.cell.id, layout),
                })),
                { separator: true },
                {
                    label: t('desktop.context.arrange_auto'),
                    onClick: () => props.onArrangeIcons(props.cell.id, sortField(), sortDirection()),
                },
                {
                    label: t('desktop.context.sort_by'),
                    submenu: (['name', 'type', 'modified'] as const).map((field) => ({
                        label: t(`desktop.context.sort_${field === 'modified' ? 'modified' : field}`),
                        icon: sortField() === field ? <FiCheck /> : undefined,
                        onClick: () => props.onArrangeIcons(props.cell.id, field, sortDirection()),
                    })),
                },
                {
                    label: t('desktop.context.sort_direction'),
                    submenu: (['asc', 'desc'] as const).map((direction) => ({
                        label: t(direction === 'asc' ? 'desktop.context.sort_ascending' : 'desktop.context.sort_descending'),
                        icon: sortDirection() === direction ? <FiCheck /> : undefined,
                        onClick: () => props.onArrangeIcons(props.cell.id, sortField(), direction),
                    })),
                },
            ],
        },
        ...(props.cell.sub_cells.length > 0
            ? [{
                  label: t('cell.context.sub_style'),
                  submenu: (['Compact', 'Stretch'] as const).map((style) => ({
                      label: t(
                          style === 'Compact' ? 'cell.sub_style.compact' : 'cell.sub_style.stretch',
                      ),
                      // Fluent checkmark in the icon gutter for the active choice
                      icon: props.cell.sub_style === style ? <FiCheck /> : undefined,
                      onClick: () => props.onSetSubStyle(props.cell.id, style),
                  })),
              }]
            : []),
        { separator: true },
        {
            label: t('cell.context.delete_cell'),
            icon: <FiTrash2 />,
            destructive: true,
            onClick: () => props.onDelete(props.cell.id),
        },
    ];

    const subMenuItems = (subId: string): MenuItem[] => [
        {
            label: t('cell.context.delete_sub'),
            icon: <FiTrash2 />,
            destructive: true,
            onClick: () => props.onDeleteSub(props.cell.id, subId),
        },
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
        const overlay = Math.max(0, Math.min(props.desktopOverlayOpacity ?? 0, 0.5));
        const overlayStyle = overlay > 0
            ? { 'background-image': `linear-gradient(rgba(255, 255, 255, ${overlay}), rgba(255, 255, 255, ${overlay}))` }
            : {};
        if (bg) {
            // Solid style objects take kebab-case CSS property names -
            // camelCase keys are silently ignored by style.setProperty.
            return { 'background-color': bg, opacity, ...overlayStyle };
        }
        return { opacity, ...overlayStyle };
    });

    /** One tab of the strip: the implicit own tab (subId null) or a sub-box.
     *  Cell rename always lives in the title bar; tabs rename only subs. */
    const tab = (label: string, subId: string | null) => {
        const active = () => (props.cell.active_sub ?? null) === subId;
        return (
            <Show
                when={!(subId !== null && editing()?.subId === subId)}
                fallback={
                    <RenameInput
                        value={label}
                        class="text-xs w-20"
                        onCommit={(v) => {
                            if (subId !== null) props.onRenameSub(props.cell.id, subId, v);
                            setEditing(null);
                        }}
                        onCancel={() => setEditing(null)}
                    />
                }
            >
                <button
                    onClick={() => props.onSelectSub(props.cell.id, subId)}
                    onDblClick={(e) => {
                        e.stopPropagation();
                        // The cell-rename editor lives in the title bar -
                        // don't arm it invisibly while the bar is hidden
                        if (subId === null && !showTitleBar()) return;
                        setEditing({ subId });
                    }}
                    onContextMenu={(e) => {
                        if (subId === null) return; // the own tab has no menu
                        e.preventDefault();
                        e.stopPropagation();
                        setSubMenu({ x: e.clientX, y: e.clientY, subId });
                    }}
                    class={cn(
                        'relative px-2 py-0.5 rounded text-xs whitespace-nowrap transition-colors',
                        'hover:bg-black/5 dark:hover:bg-white/8',
                        // Stretch style: tabs share the row equally
                        props.cell.sub_style === 'Stretch' && 'flex-1 min-w-0 truncate',
                        active()
                            ? 'text-gray-900 dark:text-gray-50 font-semibold'
                            : 'text-gray-400 dark:text-gray-500',
                    )}
                >
                    {label}
                    <Show when={active()}>
                        <span class="absolute -bottom-px left-1/2 -translate-x-1/2 w-3 h-[2px] rounded-full bg-brand-primary dark:bg-brand-secondary" />
                    </Show>
                </button>
            </Show>
        );
    };

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
                    // Layering (all above the free-icon layer): rolled-up
                    // bars lowest, pinned-open cells above them, and a
                    // hover-expanded cell on top of everything - held there
                    // through the roll-up animation to avoid pop-under.
                    (collapsed() && !displayCollapsed()) || rolling()
                        ? 'z-40'
                        : displayCollapsed() ? 'z-10' : 'z-20',
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
            >
                {/* Title bar - double-click the title text to rename */}
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
                    >
                        <Show
                            when={!(editing() && editing()!.subId === null)}
                            fallback={
                                <RenameInput
                                    value={props.cell.title}
                                    class="flex-1 text-xs"
                                    onCommit={(v) => {
                                        props.onRename(props.cell.id, v);
                                        setEditing(null);
                                    }}
                                    onCancel={() => setEditing(null)}
                                />
                            }
                        >
                            <span
                                class="flex-1 truncate"
                                onDblClick={(e) => {
                                    e.stopPropagation();
                                    setEditing({ subId: null });
                                }}
                            >
                                {props.cell.title}
                            </span>
                        </Show>
                        {/* Icon count badge - visible when rolled up */}
                        {displayCollapsed() && (
                            <span class="text-[10px] text-gray-400 dark:text-gray-500 tabular-nums">
                                {totalIconCount(props.cell)}
                            </span>
                        )}
                        {/* Mode switch (Coodesker style): click toggles auto
                            (roll up on leave / expand on hover; caret pair)
                            vs manual (pinned open; single caret). */}
                        <button
                            onClick={(e) => { e.stopPropagation(); props.onToggleHoverExpand(props.cell.id); }}
                            onDblClick={(e) => e.stopPropagation()}
                            class={cn(
                                'fluent-icon-btn flex-shrink-0',
                                'text-gray-500 dark:text-gray-300',
                            )}
                            title={t('cell.hover_expand')}
                        >
                            {props.cell.hover_expand ? (
                                <span class="flex flex-col -space-y-0.5">
                                    <BsCaretUpFill class="w-2.5 h-2.5" />
                                    <BsCaretDownFill class="w-2.5 h-2.5" />
                                </span>
                            ) : (
                                <BsCaretDownFill class="w-3 h-3" />
                            )}
                        </button>
                    </div>
                </Show>

                {/* Sub-box tab strip - the cell's own icons are the first tab */}
                <Show when={props.cell.sub_cells.length > 0}>
                    <div
                        class={cn(
                            'flex items-center gap-0.5 px-2 py-1 flex-shrink-0',
                            props.cell.sub_style === 'Compact' && 'flex-wrap',
                        )}
                    >
                        {tab(props.cell.title, null)}
                        <For each={props.cell.sub_cells}>{(s) => tab(s.title, s.id)}</For>
                    </div>
                </Show>

                {/* Icon area (active tab) - stays mounted while collapsed
                    (clipped by the animated container height) */}
                <div
                    data-icon-area
                    class={cn(
                        'flex-1 overflow-y-auto p-2 cell-scrollbar',
                        // Right margin keeps the scrollbar clear of the 6px
                        // east resize strip, which paints above this area
                        'mr-1.5',
                        props.cell.layout === 'Grid'
                            ? 'flex flex-wrap content-start gap-1'
                            : 'flex flex-col gap-0.5',
                        props.contentClass,
                    )}
                >
                    {activeIcons(props.cell).length === 0 ? (
                        <div class="flex items-center justify-center h-full text-xs text-gray-400 dark:text-gray-500 italic">
                            {t('cell.empty_hint')}
                        </div>
                    ) : (
                        <For each={activeIcons(props.cell)}>
                            {(icon) => (
                                <div data-icon data-icon-id={icon.id}>
                                    <DesktopIconComponent
                                        icon={icon}
                                        showFileExtensions={props.showFileExtensions}
                                        listLayout={props.cell.layout === 'List'}
                                        class={props.cell.layout === 'List'
                                            ? 'w-full flex-row justify-start gap-2 px-2 py-1'
                                            : undefined}
                                        labelClass={props.cell.layout === 'List'
                                            ? 'flex-1 max-w-none text-left line-clamp-1'
                                            : undefined}
                                        selected={props.selectedIconIds?.has(icon.id) ?? false}
                                        onSelect={(selected, event) => props.onSelectIcon?.(props.cell.id, selected, event)}
                                        onOpen={props.onOpenIcon}
                                        onDragStart={props.onDragStart
                                            ? (iconId, e) => props.onDragStart!(iconId, props.cell.id, icon, e)
                                            : undefined}
                                        onNativeMenu={props.onIconMenu
                                            ? (ic, event) => props.onIconMenu!(props.cell.id, ic, event)
                                            : undefined}
                                    />
                                </div>
                            )}
                        </For>
                    )}
                </div>

                {/* Resize handles - every edge and corner, invisible strips.
                    Rolled-up cells expose the horizontal handles full-height
                    (vertical resize has no visible effect on a 32px bar). */}
                <Show
                    when={!displayCollapsed()}
                    fallback={
                        <>
                            <div class="absolute inset-y-0 left-0 w-1.5 cursor-w-resize" onMouseDown={startResize({ w: true })} />
                            <div class="absolute inset-y-0 right-0 w-1.5 cursor-e-resize" onMouseDown={startResize({ e: true })} />
                        </>
                    }
                >
                    <div class="absolute inset-x-2.5 top-0 h-1.5 cursor-n-resize" onMouseDown={startResize({ n: true })} />
                    <div class="absolute inset-x-2.5 bottom-0 h-1.5 cursor-s-resize" onMouseDown={startResize({ s: true })} />
                    <div class="absolute inset-y-2.5 left-0 w-1.5 cursor-w-resize" onMouseDown={startResize({ w: true })} />
                    <div class="absolute inset-y-2.5 right-0 w-1.5 cursor-e-resize" onMouseDown={startResize({ e: true })} />
                    <div class="absolute left-0 top-0 w-2.5 h-2.5 cursor-nw-resize" onMouseDown={startResize({ n: true, w: true })} />
                    <div class="absolute right-0 top-0 w-2.5 h-2.5 cursor-ne-resize" onMouseDown={startResize({ n: true, e: true })} />
                    <div class="absolute left-0 bottom-0 w-2.5 h-2.5 cursor-sw-resize" onMouseDown={startResize({ s: true, w: true })} />
                    <div class="absolute right-0 bottom-0 w-2.5 h-2.5 cursor-se-resize" onMouseDown={startResize({ s: true, e: true })} />
                </Show>
            </div>

            {/* Cell context menu */}
            {contextMenu() && (
                <ContextMenu
                    items={menuItems()}
                    position={contextMenu()!}
                    onClose={() => setContextMenu(null)}
                />
            )}
            {/* Sub-box tab context menu */}
            {subMenu() && (
                <ContextMenu
                    items={subMenuItems(subMenu()!.subId)}
                    position={subMenu()!}
                    onClose={() => setSubMenu(null)}
                />
            )}
        </>
    );
}
