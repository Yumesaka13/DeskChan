/** Fluent fence with a title bar, tabs, desktop files and a live geometry preview. */
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import type { Cell } from '@bindings/Cell';
import type { CellRect } from '@bindings/CellRect';
import type { DesktopIcon } from '@bindings/DesktopIcon';
import { FiChevronDown, FiChevronsUp, FiFolder } from 'solid-icons/fi';
import { useI18n } from '~/i18n';
import { useTheme } from '~/lib/theme';
import { activeIcons, totalIconCount } from '~/lib/cell';
import { CELL_TITLEBAR_H } from '~/lib/grid';
import type { Point } from '~/lib/monitor';
import { cn } from '~/lib/utils';
import { hexToRgba, wallpaperPalette } from '~/lib/wallpaper';
import CellMenu, { type CellMenuCommands } from '~/features/cells/CellMenu';
import CellResizeHandles from '~/features/cells/CellResizeHandles';
import { createCellGeometry } from '~/features/cells/cell-geometry';
import { useNativeBackdrop } from '~/platform/NativeBackdrops';
import DesktopIconView from './DesktopIcon';
import RenameInput from './RenameInput';

interface CellCommands extends CellMenuCommands {
    setRect: (rect: CellRect) => void;
    toggleHover: () => void;
    hover: (hovered: boolean) => void;
    selectTab: (id: string | null) => void;
    renameTab: (id: string | null, title: string) => void;
}

interface IconCommands {
    open: (icon: DesktopIcon) => void;
    select: (icon: DesktopIcon, event: MouseEvent) => void;
    clear: () => void;
    drag: (icon: DesktopIcon, event: PointerEvent) => void;
    menu: (icon: DesktopIcon, event: MouseEvent) => void;
    rename: (icon: DesktopIcon, name: string) => void | Promise<void>;
    cancelRename: () => void;
    selected: (id: string) => boolean;
    editing: (id: string) => boolean;
}

interface CellBoxProps {
    cell: Cell;
    hovered: boolean;
    snapRects: CellRect[];
    wallpaperTint?: string | null;
    overlayOpacity: number;
    showFileExtensions: boolean;
    showShortcutExtensions: boolean;
    commands: CellCommands;
    icons: IconCommands;
    onSurface?: (fence: HTMLElement) => void;
    class?: string;
    titleClass?: string;
    contentClass?: string;
}

interface CellContext {
    position: Point;
    tabId?: string;
}

const OWN_TAB = '';

export default function CellBox(props: CellBoxProps) {
    const { t } = useI18n();
    const backdrop = useNativeBackdrop('acrylic', () => props.cell.opacity > 0);
    const { resolvedTheme } = useTheme();
    const [menu, setMenu] = createSignal<CellContext>();
    const [editing, setEditing] = createSignal<string>();
    const [rolling, setRolling] = createSignal(false);
    let tabs!: HTMLDivElement;

    function isCollapsed(): boolean {
        const cell = props.cell;
        return cell.collapsed && !(cell.hover_expand && (props.hovered || geometry.mode() === 'resize'));
    }
    const geometry = createCellGeometry({
        rect: () => props.cell.rect,
        visibleHeight: () => (isCollapsed() ? CELL_TITLEBAR_H : props.cell.rect.height),
        neighbors: () => props.snapRects,
        commit: (rect) => props.commands.setRect(rect),
        suspendBackdrop: backdrop.suspend,
        resumeBackdrop: backdrop.resume,
    });
    createEffect(
        on(
            isCollapsed,
            () => {
                setRolling(true);
                const timer = setTimeout(() => setRolling(false), 220);
                onCleanup(() => clearTimeout(timer));
            },
            { defer: true },
        ),
    );

    const palette = createMemo(() =>
        props.wallpaperTint && !props.cell.background_color
            ? wallpaperPalette(props.wallpaperTint, resolvedTheme(), props.overlayOpacity)
            : undefined,
    );
    const cellStyle = () => {
        const rect = geometry.rect();
        const tint = palette();
        const opacity = props.cell.opacity;
        const color = tint?.surface ?? props.cell.background_color ?? 'var(--fluent-surface)';
        const tintStrength = Math.min(
            0.66,
            (tint || props.cell.background_color ? 0.48 : 0.18) * opacity + props.overlayOpacity * 0.2,
        );
        return {
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.width}px`,
            height: `${isCollapsed() ? CELL_TITLEBAR_H : rect.height}px`,
            opacity: opacity === 0 ? 0 : undefined,
            '--cell-fallback': `color-mix(in srgb, ${color} ${opacity * 100}%, var(--fluent-surface))`,
            '--cell-acrylic-tint': `color-mix(in srgb, ${color} ${tintStrength * 100}%, transparent)`,
            '--cell-foreground': tint?.foreground,
            '--cell-muted': tint?.muted,
            '--cell-header': tint ? hexToRgba(tint.header, opacity * 0.25) : undefined,
            '--cell-divider': tint ? hexToRgba(tint.border, opacity * 0.38) : undefined,
            '--cell-accent': tint?.accent,
        };
    };
    const hasTabs = () => props.cell.sub_cells.length > 0;
    const currentTab = () => props.cell.active_sub ?? OWN_TAB;
    const iconList = createMemo(() => activeIcons(props.cell));
    const iconById = createMemo(() => new Map(iconList().map((icon) => [icon.id, icon])));
    const tabById = createMemo(() => new Map(props.cell.sub_cells.map((tab) => [tab.id, tab])));

    function openMenu(event: MouseEvent, tabId?: string) {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ position: { x: event.clientX, y: event.clientY }, tabId });
    }

    function beginMove(event: PointerEvent) {
        if (event.button !== 0 || !(event.target instanceof Element)) return;
        if (event.target.closest('button, input, [data-icon], [data-resize]')) return;
        if (event.target.closest('[data-icon-area]')) props.icons.clear();
        geometry.start(event);
    }

    function rename(tab: string, title: string) {
        props.commands.renameTab(tab || null, title);
        setEditing(undefined);
    }

    function tabKey(event: KeyboardEvent) {
        const items = Array.from(tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const index = items.findIndex((item) => item === event.target);
        if (index === -1) return;
        const positions: Record<string, number> = {
            ArrowLeft: (index - 1 + items.length) % items.length,
            ArrowRight: (index + 1) % items.length,
            Home: 0,
            End: items.length - 1,
        };
        const next = items[positions[event.key]];
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        next.focus();
        next.click();
    }

    function tab(id: string) {
        const title = () => (id ? (tabById().get(id)?.title ?? '') : props.cell.title);
        return (
            <Show
                when={id && editing() === id}
                fallback={
                    <button
                        type="button"
                        class="cell-tab"
                        role="tab"
                        aria-selected={currentTab() === id}
                        tabIndex={currentTab() === id ? 0 : -1}
                        onClick={() => props.commands.selectTab(id || null)}
                        onDblClick={(event) => {
                            event.stopPropagation();
                            if (id || props.cell.show_title) setEditing(id);
                        }}
                        onContextMenu={(event) => {
                            if (id) openMenu(event, id);
                        }}
                    >
                        {title()}
                    </button>
                }
            >
                <RenameInput
                    label={t('icon.rename')}
                    value={title()}
                    onCommit={(value) => rename(id, value)}
                    onCancel={() => setEditing(undefined)}
                    class="cell-tab-input"
                />
            </Show>
        );
    }

    return (
        <>
            <section
                ref={(element) => {
                    backdrop.ref(element);
                    props.onSurface?.(element);
                }}
                data-cell-id={props.cell.id}
                class={cn(
                    'fence deskchan-no-select',
                    rolling() && !geometry.mode() && 'cell-height-anim',
                    isCollapsed() ? 'fence-rolled' : 'fence-expanded',
                    ((props.cell.collapsed && !isCollapsed()) || rolling()) && 'fence-raised',
                    geometry.mode() === 'move' && 'fence-moving',
                    geometry.mode() === 'resize' && 'fence-resizing',
                    props.class,
                )}
                aria-label={props.cell.title}
                style={cellStyle()}
                onPointerDown={beginMove}
                onPointerMove={geometry.move}
                onPointerUp={geometry.commit}
                onPointerCancel={geometry.cancel}
                onLostPointerCapture={geometry.cancel}
                onMouseEnter={() => props.commands.hover(true)}
                onMouseLeave={() => props.commands.hover(false)}
                onContextMenu={(event) => openMenu(event)}
            >
                <Show when={props.cell.show_title || isCollapsed()}>
                    <header class={cn('fence-titlebar', props.titleClass)}>
                        <FiFolder size={14} class="fence-mark" aria-hidden="true" />
                        <Show
                            when={editing() === OWN_TAB}
                            fallback={
                                <span
                                    class="fence-title"
                                    onDblClick={(event) => {
                                        event.stopPropagation();
                                        setEditing(OWN_TAB);
                                    }}
                                >
                                    {props.cell.title}
                                </span>
                            }
                        >
                            <RenameInput
                                label={t('icon.rename')}
                                value={props.cell.title}
                                onCommit={(value) => rename(OWN_TAB, value)}
                                onCancel={() => setEditing(undefined)}
                            />
                        </Show>
                        <Show when={isCollapsed()}>
                            <span class="fence-count">{totalIconCount(props.cell)}</span>
                        </Show>
                        <button
                            type="button"
                            class="fluent-icon-btn fence-roll"
                            aria-label={t('cell.hover_expand')}
                            aria-pressed={props.cell.hover_expand}
                            title={t('cell.hover_expand')}
                            onClick={() => props.commands.toggleHover()}
                        >
                            <Show when={props.cell.hover_expand} fallback={<FiChevronDown size={14} />}>
                                <FiChevronsUp size={15} />
                            </Show>
                        </button>
                    </header>
                </Show>
                <Show when={hasTabs()}>
                    <div
                        ref={tabs}
                        class="fence-tabs"
                        classList={{ 'fence-tabs-stretch': props.cell.sub_style === 'Stretch' }}
                        role="tablist"
                        aria-label={props.cell.title}
                        onKeyDown={tabKey}
                    >
                        {tab(OWN_TAB)}
                        <For each={props.cell.sub_cells.map((item) => item.id)}>{(id) => tab(id)}</For>
                    </div>
                </Show>
                <div
                    data-icon-area
                    role={hasTabs() ? 'tabpanel' : undefined}
                    aria-label={
                        hasTabs() ? (tabById().get(currentTab())?.title ?? props.cell.title) : undefined
                    }
                    class={cn(
                        'fence-content cell-scrollbar',
                        props.cell.layout === 'List' && 'fence-content-list',
                        props.contentClass,
                    )}
                >
                    <Show
                        when={iconList().length > 0}
                        fallback={<p class="fence-empty">{t('cell.empty_hint')}</p>}
                    >
                        <For each={iconList().map((icon) => icon.id)}>
                            {(id) => {
                                const icon = () => iconById().get(id);
                                return (
                                    <Show when={icon()}>
                                        {(entry) => (
                                            <div data-icon data-icon-id={id}>
                                                <DesktopIconView
                                                    icon={entry()}
                                                    selected={props.icons.selected(id)}
                                                    editing={props.icons.editing(id)}
                                                    listLayout={props.cell.layout === 'List'}
                                                    showFileExtensions={props.showFileExtensions}
                                                    showShortcutExtensions={props.showShortcutExtensions}
                                                    onSelect={props.icons.select}
                                                    onOpen={props.icons.open}
                                                    onNativeMenu={props.icons.menu}
                                                    onDragStart={(_id, event) =>
                                                        props.icons.drag(entry(), event)
                                                    }
                                                    onRename={props.icons.rename}
                                                    onRenameCancel={props.icons.cancelRename}
                                                />
                                            </div>
                                        )}
                                    </Show>
                                );
                            }}
                        </For>
                    </Show>
                </div>
                <CellResizeHandles collapsed={isCollapsed()} start={geometry.start} />
            </section>
            <Show when={menu()}>
                {(m) => (
                    <CellMenu
                        cell={props.cell}
                        position={m().position}
                        tabId={m().tabId}
                        commands={props.commands}
                        onClose={() => setMenu(undefined)}
                    />
                )}
            </Show>
        </>
    );
}
