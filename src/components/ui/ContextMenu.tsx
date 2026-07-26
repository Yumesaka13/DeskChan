/**
 * ContextMenu — right-click contextual menu in the Windows 11 menu language:
 * Mica surface, inset rounded hover items, a fixed icon gutter so labels
 * align whether or not an item has an icon, hairline group separators, and a
 * thin chevron for submenus (opened on hover).
 * Renders at the cursor position via Portal, closes on backdrop click or Escape.
 */
import { createSignal, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { FiChevronRight } from 'solid-icons/fi';
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
    const [subMenu, setSubMenu] = createSignal<{ items: MenuItem[]; x: number; y: number } | null>(null);

    const showSub = (items: MenuItem[], e: MouseEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setSubMenu({ items, x: rect.right, y: rect.top });
    };

    const renderItem = (item: MenuItem, inSubmenu: boolean) => {
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
                        setSubMenu(null);
                        props.onClose();
                    }
                }}
                onPointerEnter={(e) => {
                    if (!inSubmenu && item.submenu) showSub(item.submenu, e);
                }}
                class={cn(
                    'flex items-center gap-2.5 text-left fluent-menu-item',
                    inSubmenu && 'whitespace-nowrap',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                    item.destructive && 'text-red-500 dark:text-red-400',
                    item.submenu && 'relative',
                )}
            >
                {/* Fixed icon gutter — labels align with or without an icon */}
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
            {/* Backdrop — catches all clicks outside to close */}
            <div
                class="fixed inset-0 z-[9998]"
                onPointerDown={() => { setSubMenu(null); props.onClose(); }}
                onContextMenu={(e) => { e.preventDefault(); setSubMenu(null); props.onClose(); }}
            />
            {/* Main menu */}
            <div
                class={cn(
                    'mica-panel context-menu-enter',
                    'fixed z-[9999] min-w-44 py-1 px-1',
                    'text-sm text-gray-800 dark:text-gray-100',
                    props.class,
                )}
                style={{ left: `${props.position.x}px`, top: `${props.position.y}px` }}
                role="menu"
            >
                {props.items.map((item) => renderItem(item, false))}
            </div>
            {/* Submenu */}
            {subMenu() && (
                <div
                    class={cn('mica-panel context-menu-enter fixed z-[9999] min-w-36 py-1 px-1 text-sm text-gray-800 dark:text-gray-100')}
                    style={{ left: `${subMenu()!.x}px`, top: `${subMenu()!.y}px` }}
                    role="menu"
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    {subMenu()!.items.map((item) => renderItem(item, true))}
                </div>
            )}
        </Portal>
    );
}
