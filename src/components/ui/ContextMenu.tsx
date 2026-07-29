/**
 * ContextMenu - right-click contextual menu in the Windows 11 menu language:
 * Mica surface, inset rounded hover items, a fixed icon gutter so labels
 * align whether or not an item has an icon, hairline group separators, and a
 * thin chevron for submenus (opened on hover).
 * Renders at the cursor position via Portal, closes on backdrop click or Escape.
 */
import { createEffect, createSignal, For, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { FiChevronRight } from 'solid-icons/fi';
import { getCurrentWindow, monitorFromPoint } from '@tauri-apps/api/window';
import { cn } from '~/lib/utils';

export type MenuItem =
    | { separator: true }
    | {
          separator?: false;
          label: string;
          icon?: JSX.Element;
          shortcut?: string;
          disabled?: boolean;
          destructive?: boolean;
          onClick?: () => void;
          /** Nested submenu items (opens on hover) */
          submenu?: MenuItem[];
      };

export interface ContextMenuProps {
    items: MenuItem[];
    position: { x: number; y: number };
    onClose: () => void;
    class?: string;
}

export default function ContextMenu(props: ContextMenuProps) {
    const [subMenus, setSubMenus] = createSignal<Array<{ items: MenuItem[]; x: number; y: number }>>([]);
    const [mainPosition, setMainPosition] = createSignal(props.position);
    const [bounds, setBounds] = createSignal({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
    let mainRef!: HTMLDivElement;

    const clampY = (y: number, height: number) =>
        Math.max(bounds().top + 8, Math.min(y, Math.max(bounds().top + 8, bounds().bottom - height - 8)));

    createEffect(() => {
        const anchor = props.position;
        void (async () => {
            try {
                const appWindow = getCurrentWindow();
                const [outer, scale] = await Promise.all([appWindow.outerPosition(), appWindow.scaleFactor()]);
                const monitor = await monitorFromPoint(
                    outer.x + anchor.x * scale,
                    outer.y + anchor.y * scale,
                );
                if (!monitor) return;
                // workArea excludes the taskbar (and any dock), unlike the
                // monitor's full physical bounds. Keep every menu level in
                // this single monitor's usable area.
                const workArea = monitor.workArea;
                const left = (workArea.position.x - outer.x) / scale;
                const top = (workArea.position.y - outer.y) / scale;
                setBounds({
                    left,
                    top,
                    right: left + workArea.size.width / scale,
                    bottom: top + workArea.size.height / scale,
                });
            } catch {
                // Use the virtual viewport fallback when monitor APIs fail.
            }
        })();
    });

    createEffect(() => {
        // Read reactively before queuing DOM measurement so a monitor-bound
        // update re-runs this effect and repositions the root menu.
        const currentBounds = bounds();
        // Recalculate after the panel has its true measured dimensions.
        queueMicrotask(() => {
            if (!mainRef) return;
            const rect = mainRef.getBoundingClientRect();
            setMainPosition({
                x: Math.max(currentBounds.left + 8, Math.min(props.position.x, Math.max(currentBounds.left + 8, currentBounds.right - rect.width - 8))),
                y: Math.max(currentBounds.top + 8, Math.min(props.position.y, Math.max(currentBounds.top + 8, currentBounds.bottom - rect.height - 8))),
            });
        });
    });

    const showSub = (items: MenuItem[], e: MouseEvent, level: number) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        // Menu panels have a 9rem minimum width; reserve a little extra for
        // long translated labels, then flip left if the right edge is tight.
        const estimatedWidth = 220;
        const opensRight = rect.right + estimatedWidth <= bounds().right - 8;
        setSubMenus((current) => [
            ...current.slice(0, level),
            {
                items,
                x: opensRight ? rect.right : Math.max(bounds().left + 8, rect.left - estimatedWidth),
                y: clampY(rect.top, 260),
            },
        ]);
    };

    const renderItem = (item: MenuItem, level: number) => {
        if ('separator' in item && item.separator) {
            return <div class="h-px mx-2 my-1 bg-black/8 dark:bg-white/10" />;
        }
        return (
            <button
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                    if (!item.disabled && item.onClick) {
                        item.onClick();
                        setSubMenus([]);
                        props.onClose();
                    }
                }}
                onMouseEnter={(e) => {
                    // A menu can contain another submenu (for example,
                    // Arrangement > Sort by > Name). Keep ancestor panels,
                    // and discard only panels below the hovered item.
                    // Do not collapse a chain when crossing a panel boundary:
                    // a short pointer transition between adjacent fixed panels
                    // otherwise made every submenu disappear.
                    if (item.submenu) showSub(item.submenu, e, level);
                }}
                class={cn(
                    'flex items-center gap-2.5 text-left fluent-menu-item',
                    level > 0 && 'whitespace-nowrap',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                    item.destructive && 'text-red-500 dark:text-red-400',
                    item.submenu && 'relative',
                )}
            >
                {/* Fixed icon gutter - labels align with or without an icon */}
                <span class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
                    {item.icon}
                </span>
                <span class="flex-1">{item.label}</span>
                {item.shortcut && (
                    <span class="text-xs text-gray-400 dark:text-gray-500 ml-4">{item.shortcut}</span>
                )}
                {item.submenu && (
                    <FiChevronRight class="w-3.5 h-3.5 ml-2 text-gray-400 dark:text-gray-500" />
                )}
            </button>
        );
    };

    return (
        <Portal>
            {/* Backdrop - catches all clicks outside to close */}
            <div
                class="fixed inset-0 z-[9998]"
                onPointerDown={() => { setSubMenus([]); props.onClose(); }}
                onContextMenu={(e) => { e.preventDefault(); setSubMenus([]); props.onClose(); }}
            />
            {/* Main menu */}
            <div
                ref={mainRef}
                class={cn(
                    'mica-panel context-menu-enter',
                    'fixed z-[9999] min-w-44 max-h-[calc(100vh-16px)] overflow-y-auto py-1 px-1',
                    'text-sm text-gray-800 dark:text-gray-100',
                    props.class,
                )}
                style={{
                    left: `${mainPosition().x}px`,
                    top: `${mainPosition().y}px`,
                    'max-height': `${Math.max(0, bounds().bottom - bounds().top - 16)}px`,
                }}
                role="menu"
            >
                {props.items.map((item) => renderItem(item, 0))}
            </div>
            {/* Submenus are rendered as a chain, permitting nested choices. */}
            <For each={subMenus()}>
                {(menu, index) => (
                    <div
                        class={cn('mica-panel context-menu-enter fixed z-[9999] min-w-36 max-h-[calc(100vh-16px)] overflow-y-auto py-1 px-1 text-sm text-gray-800 dark:text-gray-100')}
                        style={{
                            left: `${menu.x}px`,
                            top: `${menu.y}px`,
                            'max-height': `${Math.max(0, bounds().bottom - bounds().top - 16)}px`,
                        }}
                        role="menu"
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        {menu.items.map((item) => renderItem(item, index() + 1))}
                    </div>
                )}
            </For>
        </Portal>
    );
}
